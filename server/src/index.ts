import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Server as SocketServer } from 'socket.io';
import nodemailer from 'nodemailer';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { config } from './config.js';
import { authenticate, asyncRoute, requireAdmin } from './middleware.js';
import { Achievement, ActiveExchange, ExchangeRequest, LearningSession, Message, Notification, Report, Review, Skill, SkillCategory, SkillCircle, SkillCoinsTransaction, StudentAchievement, StudentSkill, User } from './models.js';

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: config.clientUrl, credentials: true } });
app.disable('x-powered-by');
app.set('trust proxy', config.isProduction ? 1 : false);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: config.clientUrl, credentials: true }));
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false }));

const levels = ['Beginner', 'Intermediate', 'Advanced', 'Expert'] as const;
const categories = ['Programming', 'Artificial Intelligence', 'Data Science', 'Web Development', 'App Development', 'UI/UX Design', 'Graphic Design', 'Video Editing', 'Photography', 'Communication', 'Languages', 'Business and Entrepreneurship', 'Finance', 'Music', 'Other skills'];
const id = (value: unknown) => String(value || '');
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const tokenFor = (userId: string) => jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
const cookieOptions = { httpOnly: true, secure: config.isProduction, sameSite: (config.isProduction ? 'none' : 'lax') as 'none' | 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };
const clientLink = (path: string, token: string, email: string) => `${config.clientUrl}${path}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
const cloudinaryReady = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryReady) cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });

async function sendEmail(to: string, subject: string, text: string) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  await transporter.sendMail({ from: process.env.SMTP_FROM || 'SKILLORA <no-reply@skillora.local>', to, subject, text });
  return true;
}

function publicUser(user: any) {
  const toSkill = (record: any) => ({ _id: id(record?._id), name: record?.skill?.name || '', category: record?.skill?.category || '', level: record?.level || 'Beginner', details: record?.details || '' });
  return {
    _id: id(user._id), name: user.name, email: user.email, college: user.college || '', department: user.department || '', year: user.year || '',
    bio: user.bio || '', avatarUrl: user.avatarUrl || '', role: user.role, availability: user.availability || [], coins: user.coins || 0, streak: user.streak || 0,
    badges: user.badges || [], emailVerified: !!user.emailVerified, teachSkills: (user.teachingSkills || []).map(toSkill).filter((s: any) => s.name), learnSkills: (user.learningSkills || []).map(toSkill).filter((s: any) => s.name),
  };
}
const skillPop = [{ path: 'teachingSkills', populate: { path: 'skill' } }, { path: 'learningSkills', populate: { path: 'skill' } }];
const populatedUser = (query: any) => query.populate(skillPop);
async function notify(userId: unknown, type: string, title: string, body: string, link?: string) {
  const item = await Notification.create({ user: userId, type, title, body, link });
  io.to(`user:${id(userId)}`).emit('notification', item);
  return item;
}
async function sendUpcomingSessionReminders() {
  while (true) {
    const now = new Date();
    const session: any = await LearningSession.findOneAndUpdate({
      status: 'scheduled', startAt: { $gte: now, $lte: new Date(now.getTime() + 15 * 60 * 1000) },
      $or: [{ reminderSentAt: { $exists: false } }, { reminderSentAt: null }],
    }, { $set: { reminderSentAt: now } }, { new: true });
    if (!session) break;
    const minutes = Math.max(1, Math.ceil((session.startAt.getTime() - now.getTime()) / 60_000));
    try {
      await Promise.all([session.host, session.guest].map((userId: unknown) => notify(userId, 'session_reminder', 'A learning session is coming up', `${session.title} starts in about ${minutes} minute${minutes === 1 ? '' : 's'}.`, `/sessions/${session._id}`)));
    } catch (error) {
      await LearningSession.updateOne({ _id: session._id, reminderSentAt: now }, { $unset: { reminderSentAt: 1 } });
      throw error;
    }
  }
}
function canAccess(exchange: any, userId: string) { return exchange && exchange.status === 'active' && exchange.participants.some((member: any) => id(member) === userId); }
async function refreshAchievements(userId: unknown) {
  const user: any = await User.findById(userId); if (!user) return;
  const [exchanges, sessions, reviews] = await Promise.all([
    ActiveExchange.countDocuments({ participants: userId, status: 'completed' }),
    LearningSession.countDocuments({ $or: [{ host: userId }, { guest: userId }], status: 'completed' }),
    Review.countDocuments({ recipient: userId }),
  ]);
  const rules: [string, number, number][] = [
    ['First Exchange', exchanges, 1], ['Knowledge Sharer', user.coins, 30], ['Fast Learner', sessions, 5],
    ['Top Mentor', reviews, 5], ['Consistent Learner', user.streak, 7], ['Community Champion', exchanges, 10],
  ];
  for (const [name, value, threshold] of rules) {
    if (value < threshold || user.badges.includes(name)) continue;
    const achievement = await Achievement.findOne({ name });
    user.badges.push(name); await user.save();
    if (achievement) await StudentAchievement.updateOne({ user: user._id, achievement: achievement._id }, { $setOnInsert: { user: user._id, achievement: achievement._id, awardedAt: new Date() } }, { upsert: true });
    await notify(user._id, 'achievement', `${name} unlocked`, `You earned the ${name} badge. Thanks for helping knowledge grow.`, '/passport');
  }
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'skillora-api', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));

app.get('/api/community/overview', asyncRoute(async (_req, res) => {
  const [students, completedExchanges, completedSessions, popularSkills, stories] = await Promise.all([
    User.countDocuments({ role: 'student', suspendedAt: null }),
    ActiveExchange.countDocuments({ status: 'completed' }),
    LearningSession.countDocuments({ status: 'completed' }),
    StudentSkill.aggregate([
      { $match: { kind: 'teach' } }, { $group: { _id: '$skill', teachers: { $sum: 1 } } },
      { $sort: { teachers: -1 } }, { $limit: 8 }, { $lookup: { from: 'skills', localField: '_id', foreignField: '_id', as: 'skill' } },
      { $unwind: '$skill' }, { $project: { _id: 0, name: '$skill.name', category: '$skill.category', teachers: 1 } },
    ]),
    Review.find({ comment: { $type: 'string', $ne: '' } }).sort({ rating: -1, createdAt: -1 }).limit(3).populate('author', 'name').populate('recipient', 'name'),
  ]);
  res.json({ stats: { students, completedExchanges, completedSessions }, popularSkills, stories });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(2).max(80), email: z.string().email().max(160), password: z.string().min(8).max(72), college: z.string().trim().max(120).optional(), department: z.string().trim().max(100).optional(), year: z.string().max(30).optional() }).parse(req.body);
  if (await User.exists({ email: data.email.toLowerCase() })) return res.status(409).json({ message: 'An account with this email already exists.' });
  const rawToken = crypto.randomBytes(32).toString('hex');
  const user = await User.create({ name: data.name, email: data.email, passwordHash: await bcrypt.hash(data.password, 12), college: data.college, department: data.department, year: data.year, verificationHash: hash(rawToken), verificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000) });
  const verifyUrl = clientLink('/verify-email', rawToken, user.email);
  const delivered = await sendEmail(user.email, 'Verify your SKILLORA account', `Welcome to SKILLORA. Verify your email: ${verifyUrl}`);
  if (!delivered) console.info(`[development email] Verify ${user.email}: ${verifyUrl}`);
  res.status(201).json({ message: 'Your account is ready. Verify your email to finish setup.', user: publicUser(user), ...(config.isProduction ? {} : { verificationUrl: verifyUrl }) });
}));

app.post('/api/auth/verify-email', asyncRoute(async (req, res) => {
  const data = z.object({ token: z.string().min(20), email: z.string().email() }).parse(req.body);
  const user = await User.findOne({ email: data.email.toLowerCase(), verificationHash: hash(data.token), verificationExpires: { $gt: new Date() } });
  if (!user) return res.status(400).json({ message: 'This verification link is invalid or expired.' });
  user.emailVerified = true; user.verificationHash = undefined; user.verificationExpires = undefined; await user.save();
  res.json({ message: 'Email verified. You can now sign in.' });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const data = z.object({ email: z.string().email(), password: z.string().min(1).max(72) }).parse(req.body);
  const user = await User.findOne({ email: data.email.toLowerCase() }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(data.password, user.passwordHash))) return res.status(401).json({ message: 'Email or password is incorrect.' });
  if (user.suspendedAt) return res.status(403).json({ message: 'This account has been suspended. Contact support for help.' });
  if (config.isProduction && !user.emailVerified) return res.status(403).json({ message: 'Please verify your email before signing in.' });
  res.cookie('skillora_session', tokenFor(id(user._id)), cookieOptions).json({ user: publicUser(user), message: 'Welcome back.' });
}));

app.post('/api/auth/logout', (_req, res) => res.clearCookie('skillora_session', { path: '/', secure: config.isProduction, sameSite: config.isProduction ? 'none' : 'lax' }).json({ message: 'You have been signed out.' }));
app.get('/api/auth/me', authenticate, asyncRoute(async (req, res) => {
  const user = await populatedUser(User.findById(req.userId));
  if (!user) return res.status(404).json({ message: 'Account not found.' });
  res.json({ user: publicUser(user) });
}));
app.post('/api/auth/forgot-password', asyncRoute(async (req, res) => {
  const data = z.object({ email: z.string().email() }).parse(req.body);
  const user = await User.findOne({ email: data.email.toLowerCase() });
  let resetUrl: string | undefined;
  if (user) {
    const raw = crypto.randomBytes(32).toString('hex'); user.resetHash = hash(raw); user.resetExpires = new Date(Date.now() + 60 * 60 * 1000); await user.save();
    resetUrl = clientLink('/reset-password', raw, user.email);
    const delivered = await sendEmail(user.email, 'Reset your SKILLORA password', `Reset your password: ${resetUrl}`);
    if (!delivered) console.info(`[development email] Reset ${user.email}: ${resetUrl}`);
  }
  res.json({ message: 'If an account exists for that email, we sent a reset link.', ...(!config.isProduction && resetUrl ? { resetUrl } : {}) });
}));
app.post('/api/auth/reset-password', asyncRoute(async (req, res) => {
  const data = z.object({ token: z.string().min(20), email: z.string().email(), password: z.string().min(8).max(72) }).parse(req.body);
  const user = await User.findOne({ email: data.email.toLowerCase(), resetHash: hash(data.token), resetExpires: { $gt: new Date() } });
  if (!user) return res.status(400).json({ message: 'This reset link is invalid or expired.' });
  user.passwordHash = await bcrypt.hash(data.password, 12); user.resetHash = undefined; user.resetExpires = undefined; await user.save();
  res.json({ message: 'Password updated. Sign in with your new password.' });
}));

app.use('/api', authenticate);

app.get('/api/profile', asyncRoute(async (req, res) => {
  const user = await populatedUser(User.findById(req.userId));
  res.json({ user: user ? publicUser(user) : null });
}));
app.patch('/api/profile', asyncRoute(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(2).max(80).optional(), college: z.string().trim().max(120).optional(), department: z.string().trim().max(100).optional(), year: z.string().max(30).optional(), bio: z.string().max(500).optional(), avatarUrl: z.union([z.string().url(), z.literal('')]).optional(), availability: z.array(z.string().max(30)).max(14).optional() }).strict().parse(req.body);
  const user = await User.findByIdAndUpdate(req.userId, { $set: data }, { new: true, runValidators: true });
  res.json({ user: user ? publicUser(user) : null, message: 'Your profile has been saved.' });
}));
app.post('/api/profile/avatar', asyncRoute(async (req, res) => {
  if (!cloudinaryReady) return res.status(503).json({ message: 'Image uploads are not configured yet. Add Cloudinary credentials or use an image URL.' });
  const { image } = z.object({ image: z.string().regex(/^data:image\/(png|jpeg|webp);base64,/).max(7_000_000) }).parse(req.body);
  const uploaded = await cloudinary.uploader.upload(image, { folder: 'skillora/avatars', public_id: req.userId, overwrite: true, resource_type: 'image', transformation: [{ width: 640, height: 640, crop: 'fill', gravity: 'face', quality: 'auto', fetch_format: 'auto' }] });
  const user = await User.findByIdAndUpdate(req.userId, { $set: { avatarUrl: uploaded.secure_url } }, { new: true });
  res.json({ user: user ? publicUser(user) : null, message: 'Profile photo uploaded.' });
}));
app.get('/api/skills/catalog', asyncRoute(async (_req, res) => res.json({ categories: [...new Set([...categories, ...await SkillCategory.distinct('name')])], skills: await Skill.find().sort({ category: 1, name: 1 }).lean() })));
app.get('/api/skills', asyncRoute(async (req, res) => {
  const records = await StudentSkill.find({ user: req.userId }).populate('skill').sort({ createdAt: -1 });
  res.json({ skills: records.map((record: any) => ({ _id: id(record._id), kind: record.kind, name: record.skill?.name, category: record.skill?.category, level: record.level, details: record.details, availability: record.availability })) });
}));
app.post('/api/skills', asyncRoute(async (req, res) => {
  const data = z.object({ kind: z.enum(['teach', 'learn']), name: z.string().trim().min(2).max(80), category: z.string().trim().min(2).max(80), level: z.enum(levels), details: z.string().max(500).optional(), availability: z.array(z.string()).max(14).optional() }).parse(req.body);
  if (!categories.includes(data.category) && !await SkillCategory.exists({ name: data.category })) return res.status(400).json({ message: 'Choose a skill category from the list.' });
  const skill = await Skill.findOneAndUpdate({ name: { $regex: `^${data.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }, category: data.category }, { $setOnInsert: { name: data.name, category: data.category } }, { new: true, upsert: true });
  if (await StudentSkill.exists({ user: req.userId, skill: skill._id, kind: data.kind })) return res.status(409).json({ message: `You already have ${data.name} in this list.` });
  const record = await StudentSkill.create({ user: req.userId, skill: skill._id, kind: data.kind, level: data.level, details: data.details || '', availability: data.availability || [] });
  res.status(201).json({ skill: { _id: id(record._id), name: skill.name, category: skill.category, level: record.level, details: record.details, kind: record.kind }, message: 'Skill added.' });
}));
app.patch('/api/skills/:id', asyncRoute(async (req, res) => {
  const data = z.object({ level: z.enum(levels).optional(), details: z.string().max(500).optional(), availability: z.array(z.string()).max(14).optional() }).strict().parse(req.body);
  const record = await StudentSkill.findOneAndUpdate({ _id: req.params.id, user: req.userId }, { $set: data }, { new: true, runValidators: true }).populate('skill');
  if (!record) return res.status(404).json({ message: 'Skill not found.' });
  const row: any = record;
  res.json({ skill: { _id: id(row._id), name: row.skill.name, category: row.skill.category, level: row.level, details: row.details, kind: row.kind }, message: 'Skill updated.' });
}));
app.delete('/api/skills/:id', asyncRoute(async (req, res) => {
  const result = await StudentSkill.deleteOne({ _id: req.params.id, user: req.userId });
  if (!result.deletedCount) return res.status(404).json({ message: 'Skill not found.' });
  res.json({ message: 'Skill removed.' });
}));

app.get('/api/discover/matches', asyncRoute(async (req, res) => {
  const me: any = await populatedUser(User.findById(req.userId));
  if (!me) return res.status(404).json({ message: 'Account not found.' });
  const all: any[] = await populatedUser(User.find({ _id: { $ne: req.userId }, role: 'student', suspendedAt: null })).sort({ name: 1 });
  const myTeachRows: any[] = me.teachingSkills || [];
  const myLearnRows: any[] = me.learningSkills || [];
  const myTeach = myTeachRows.map((s) => s.skill?.name?.toLowerCase()).filter(Boolean);
  const myLearn = myLearnRows.map((s) => s.skill?.name?.toLowerCase()).filter(Boolean);
  const search = String(req.query.q || '').trim().toLowerCase();
  const college = String(req.query.college || '').trim().toLowerCase();
  const category = String(req.query.category || '').trim().toLowerCase();
  const proficiency = String(req.query.proficiency || '').trim().toLowerCase();
  const availability = String(req.query.availability || '').trim();
  const minScore = Math.max(0, Math.min(100, Number(req.query.minScore) || 0));
  const matches: any[] = all.map((person) => {
    const teach = (person.teachingSkills || []).map((s: any) => s.skill?.name?.toLowerCase()).filter(Boolean);
    const learn = (person.learningSkills || []).map((s: any) => s.skill?.name?.toLowerCase()).filter(Boolean);
    const ITeachThem = myTeach.filter((name: string) => learn.includes(name));
    const teachesMe = teach.filter((name: string) => myLearn.includes(name));
    const mutual = ITeachThem.length > 0 && teachesMe.length > 0;
    if (!mutual) return null;
    const shared = ITeachThem.length + teachesMe.length;
    let score = shared ? (mutual ? 52 : 20) + Math.min(20, shared * 8) : 0;
    const sameCollege = !!me.college && me.college.toLowerCase() === (person.college || '').toLowerCase();
    const overlap = (me.availability || []).filter((slot: string) => (person.availability || []).includes(slot)).length;
    if (sameCollege) score += 8;
    if (overlap) score += Math.min(10, overlap * 5);
    const avgLevel = [...(person.teachingSkills || [])].reduce((n: number, skill: any) => n + Math.max(0, levels.indexOf(skill.level)), 0) / Math.max(1, person.teachingSkills?.length || 0);
    score += Math.round(avgLevel * 2);
    score = Math.min(100, score);
    const reasons = [mutual ? 'You can teach each other' : (shared ? 'There is a useful skill overlap' : ''), sameCollege ? 'You share a campus community' : '', overlap ? 'Your availability overlaps' : ''].filter(Boolean);
    const displayMine = (key: string) => myTeachRows.find((s) => s.skill?.name?.toLowerCase() === key)?.skill?.name || key;
    const displayTheirs = (key: string) => (person.teachingSkills || []).find((s: any) => s.skill?.name?.toLowerCase() === key)?.skill?.name || key;
    return { ...publicUser(person), score, ITeachThem: ITeachThem.map(displayMine), teachesMe: teachesMe.map(displayTheirs), reasons };
  }).filter((person): person is any => person !== null).filter((person) => {
    const skillNames = [...person.teachSkills, ...person.learnSkills];
    return person.score >= minScore && person.score > 0 && (!search || person.name.toLowerCase().includes(search) || skillNames.some((s: any) => s.name.toLowerCase().includes(search))) && (!college || (person.college || '').toLowerCase().includes(college)) && (!category || skillNames.some((s: any) => s.category.toLowerCase() === category)) && (!proficiency || skillNames.some((s: any) => s.level.toLowerCase() === proficiency)) && (!availability || (person.availability || []).includes(availability));
  });
  const ratings = await Review.aggregate([{ $match: { recipient: { $in: all.map((person) => person._id) } } }, { $group: { _id: '$recipient', rating: { $avg: '$rating' } } }]);
  const ratingByUser = new Map(ratings.map((row: any) => [id(row._id), row.rating]));
  for (const person of matches) person.rating = Math.round((ratingByUser.get(person._id) || 0) * 10) / 10;
  matches.sort((a, b) => req.query.sort === 'rating' ? b.rating - a.rating || b.score - a.score : b.score - a.score || a.name.localeCompare(b.name));
  const pending = await ExchangeRequest.find({ $or: [{ sender: req.userId }, { recipient: req.userId }], status: { $in: ['pending', 'accepted'] } }).select('sender recipient status');
  for (const person of matches) {
    const relation = pending.find((r: any) => id(r.sender) === person._id || id(r.recipient) === person._id);
    if (relation) { person.existingRequest = id(relation._id); person.existingStatus = relation.status; }
  }
  res.json({ matches });
}));
app.get('/api/students/:id', asyncRoute(async (req, res) => {
  const user: any = await populatedUser(User.findById(req.params.id));
  if (!user || user.suspendedAt) return res.status(404).json({ message: 'Student not found.' });
  const [reviewRows, exchangeCount] = await Promise.all([Review.find({ recipient: user._id }).sort({ createdAt: -1 }).limit(12).populate('author', 'name avatarUrl'), ActiveExchange.countDocuments({ participants: user._id, status: 'completed' })]);
  const avg = await Review.aggregate([{ $match: { recipient: user._id } }, { $group: { _id: null, rating: { $avg: '$rating' } } }]);
  res.json({ student: { ...publicUser(user), rating: Math.round((avg[0]?.rating || 0) * 10) / 10, completedExchanges: exchangeCount }, reviews: reviewRows });
}));

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ message: 'Account not found.' });
  const [teachCount, learnCount, activeExchanges, completedExchanges, completedSessions, pendingRequests, upcomingSessions, recentNotifications, avgRating, earned] = await Promise.all([
    StudentSkill.countDocuments({ user: req.userId, kind: 'teach' }), StudentSkill.countDocuments({ user: req.userId, kind: 'learn' }),
    ActiveExchange.countDocuments({ participants: req.userId, status: 'active' }), ActiveExchange.countDocuments({ participants: req.userId, status: 'completed' }),
    LearningSession.countDocuments({ $or: [{ host: req.userId }, { guest: req.userId }], status: 'completed' }), ExchangeRequest.countDocuments({ recipient: req.userId, status: 'pending' }),
    LearningSession.find({ $or: [{ host: req.userId }, { guest: req.userId }], status: 'scheduled', startAt: { $gte: new Date() } }).sort({ startAt: 1 }).limit(4).populate('host guest', 'name avatarUrl'),
    Notification.find({ user: req.userId }).sort({ createdAt: -1 }).limit(5), Review.aggregate([{ $match: { recipient: user._id } }, { $group: { _id: null, avg: { $avg: '$rating' } } }]), SkillCoinsTransaction.find({ user: req.userId }).sort({ createdAt: -1 }).limit(4),
  ]);
  const [matches, requests, recentMessages] = await Promise.all([
    fetchMatchesFor(req.userId!, 3),
    ExchangeRequest.find({ recipient: req.userId, status: 'pending' }).sort({ createdAt: -1 }).limit(4).populate('sender', 'name college avatarUrl'),
    Message.find({ $or: [{ recipient: req.userId }, { sender: req.userId }] }).sort({ createdAt: -1 }).limit(4).populate('sender', 'name avatarUrl').populate('exchange', '_id'),
  ]);
  res.json({ stats: { teachCount, learnCount, activeExchanges, completedExchanges, completedSessions, pendingRequests, avgRating: Math.round((avgRating[0]?.avg || 0) * 10) / 10, coins: user.coins, streak: user.streak }, matches, requests, upcomingSessions, notifications: recentNotifications, recentMessages, earned });
}));

async function fetchMatchesFor(userId: string, limit: number) {
  const me: any = await populatedUser(User.findById(userId)); if (!me) return [];
  const all: any[] = await populatedUser(User.find({ _id: { $ne: userId }, role: 'student', suspendedAt: null }));
  const myTeachRows: any[] = me.teachingSkills || [];
  const myLearnRows: any[] = me.learningSkills || [];
  const myTeach = myTeachRows.map((s) => s.skill?.name?.toLowerCase()).filter(Boolean);
  const myLearn = myLearnRows.map((s) => s.skill?.name?.toLowerCase()).filter(Boolean);
  return all.map((p) => {
    const teach = (p.teachingSkills || []).map((s: any) => s.skill?.name?.toLowerCase()).filter(Boolean), learn = (p.learningSkills || []).map((s: any) => s.skill?.name?.toLowerCase()).filter(Boolean);
    const ITeachThem = myTeach.filter((n: string) => learn.includes(n)), teachesMe = teach.filter((n: string) => myLearn.includes(n)); const shared = ITeachThem.length + teachesMe.length;
    if (!shared) return null;
    const overlap = (me.availability || []).filter((s: string) => (p.availability || []).includes(s)).length, same = !!me.college && me.college === p.college;
    const mutual = ITeachThem.length && teachesMe.length;
    if (!mutual) return null;
    const score = Math.min(100, 52 + Math.min(20, shared * 8) + (same ? 8 : 0) + Math.min(10, overlap * 5));
    const displayMine = (key: string) => myTeachRows.find((s: any) => s.skill?.name?.toLowerCase() === key)?.skill?.name || key;
    const displayTheirs = (key: string) => (p.teachingSkills || []).find((s: any) => s.skill?.name?.toLowerCase() === key)?.skill?.name || key;
    return { ...publicUser(p), score, ITeachThem: ITeachThem.map(displayMine), teachesMe: teachesMe.map(displayTheirs), reasons: [mutual ? 'You can teach each other' : 'There is a useful skill overlap', same ? 'You share a campus community' : '', overlap ? 'Your availability overlaps' : ''].filter(Boolean) };
  }).filter(Boolean).sort((a: any, b: any) => b.score - a.score).slice(0, limit);
}

app.get('/api/exchanges/requests', asyncRoute(async (req, res) => {
  const folder = req.query.folder === 'sent' ? 'sent' : 'received';
  const query = folder === 'sent' ? { sender: req.userId } : { recipient: req.userId };
  const requests = await ExchangeRequest.find(query).sort({ createdAt: -1 }).populate('sender', 'name college department avatarUrl').populate('recipient', 'name college department avatarUrl');
  res.json({ requests, folder });
}));
app.post('/api/exchanges/requests', asyncRoute(async (req, res) => {
  const data = z.object({ recipient: z.string().min(1), message: z.string().max(1000).optional(), offeredSkills: z.array(z.string().max(80)).max(10).default([]), requestedSkills: z.array(z.string().max(80)).max(10).default([]) }).parse(req.body);
  if (data.recipient === req.userId) return res.status(400).json({ message: 'You cannot send an exchange request to yourself.' });
  const recipient = await User.findById(data.recipient); if (!recipient || recipient.role !== 'student' || recipient.suspendedAt) return res.status(404).json({ message: 'Student not found.' });
  const prior = await ExchangeRequest.findOne({ $or: [{ sender: req.userId, recipient: data.recipient }, { sender: data.recipient, recipient: req.userId }], status: { $in: ['pending', 'accepted'] } });
  if (prior) return res.status(409).json({ message: 'You already have an open exchange with this student.' });
  const [mineTeach, mineLearn, theirsTeach, theirsLearn] = await Promise.all([
    StudentSkill.find({ user: req.userId, kind: 'teach' }).populate('skill', 'name'), StudentSkill.find({ user: req.userId, kind: 'learn' }).populate('skill', 'name'),
    StudentSkill.find({ user: data.recipient, kind: 'teach' }).populate('skill', 'name'), StudentSkill.find({ user: data.recipient, kind: 'learn' }).populate('skill', 'name'),
  ]);
  const names = (rows: any[]) => rows.map((row) => row.skill?.name).filter(Boolean);
  const compatibleOffer = names(mineTeach).filter((name) => names(theirsLearn).includes(name));
  const compatibleRequest = names(theirsTeach).filter((name) => names(mineLearn).includes(name));
  const findCanonical = (compatible: string[], selected: string[]) => selected.map((skill) => compatible.find((name) => name.toLowerCase() === skill.toLowerCase())).filter((name): name is string => !!name);
  const offered = data.offeredSkills.length ? findCanonical(compatibleOffer, data.offeredSkills) : compatibleOffer;
  const requested = data.requestedSkills.length ? findCanonical(compatibleRequest, data.requestedSkills) : compatibleRequest;
  if ((data.offeredSkills.length > 0 && offered.length !== data.offeredSkills.length) || (data.requestedSkills.length > 0 && requested.length !== data.requestedSkills.length)) return res.status(400).json({ message: 'Requests can only include skills that are listed on both profiles.' });
  if (!offered.length || !requested.length) return res.status(400).json({ message: 'A skill exchange needs a teaching and learning skill that complement each other.' });
  const request = await ExchangeRequest.create({ sender: req.userId, recipient: data.recipient, message: data.message, offeredSkills: offered, requestedSkills: requested });
  await notify(data.recipient, 'exchange_request', 'New skill exchange request', 'A student would like to exchange skills with you.', '/requests');
  const output = await ExchangeRequest.findById(request._id).populate('sender', 'name college avatarUrl').populate('recipient', 'name college avatarUrl');
  res.status(201).json({ request: output, message: 'Exchange request sent.' });
}));
app.patch('/api/exchanges/requests/:id', asyncRoute(async (req, res) => {
  const data = z.object({ action: z.enum(['accept', 'reject', 'cancel']) }).parse(req.body);
  const request: any = await ExchangeRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ message: 'Request not found.' });
  if (request.status !== 'pending') return res.status(409).json({ message: 'This request has already been handled.' });
  if (data.action === 'cancel' && id(request.sender) !== req.userId) return res.status(403).json({ message: 'Only the sender can cancel this request.' });
  if (data.action !== 'cancel' && id(request.recipient) !== req.userId) return res.status(403).json({ message: 'Only the recipient can respond to this request.' });
  request.status = data.action === 'accept' ? 'accepted' : data.action === 'reject' ? 'rejected' : 'cancelled';
  if (data.action === 'accept') {
    const exchange = await ActiveExchange.create({ request: request._id, participants: [request.sender, request.recipient] }); request.activeExchange = exchange._id;
  }
  await request.save();
  const other = data.action === 'cancel' ? request.recipient : request.sender;
  await notify(other, `exchange_${data.action}`, `Exchange ${data.action}ed`, `Your skill exchange request was ${data.action}ed.`, '/exchanges');
  res.json({ request, message: `Request ${data.action}ed.` });
}));
app.get('/api/exchanges', asyncRoute(async (req, res) => {
  const exchanges = await ActiveExchange.find({ participants: req.userId }).sort({ updatedAt: -1 }).populate('participants', 'name college department avatarUrl availability').populate('request');
  const unread = await Message.aggregate([
    { $match: { recipient: new mongoose.Types.ObjectId(req.userId), readAt: { $exists: false }, exchange: { $in: exchanges.map((exchange) => exchange._id) } } },
    { $group: { _id: '$exchange', count: { $sum: 1 } } },
  ]);
  const unreadByExchange = new Map(unread.map((row: any) => [id(row._id), row.count]));
  res.json({ exchanges: exchanges.map((exchange: any) => ({ ...exchange.toObject(), unreadCount: unreadByExchange.get(id(exchange._id)) || 0 })) });
}));
app.get('/api/exchanges/:id', asyncRoute(async (req, res) => {
  const exchange: any = await ActiveExchange.findOne({ _id: req.params.id, participants: req.userId }).populate('participants', 'name college department year bio avatarUrl availability').populate('request');
  if (!exchange) return res.status(404).json({ message: 'Exchange not found.' });
  const sessions = await LearningSession.find({ exchange: exchange._id }).sort({ startAt: 1 }).populate('host guest', 'name avatarUrl');
  res.json({ exchange, sessions });
}));
app.post('/api/exchanges/:id/complete', asyncRoute(async (req, res) => {
  const exchange: any = await ActiveExchange.findById(req.params.id);
  if (!canAccess(exchange, req.userId!)) return res.status(404).json({ message: 'Active exchange not found.' });
  const scheduled = await LearningSession.countDocuments({ exchange: exchange._id, status: 'scheduled' });
  const completed = await LearningSession.countDocuments({ exchange: exchange._id, status: 'completed' });
  if (scheduled || !completed) return res.status(400).json({ message: 'Complete at least one session and resolve scheduled sessions before closing the exchange.' });
  exchange.status = 'completed'; await exchange.save(); await ExchangeRequest.findByIdAndUpdate(exchange.request, { status: 'completed' });
  for (const userId of exchange.participants) { await notify(userId, 'exchange_completed', 'Exchange completed', 'Your learning partnership is now part of your Learning Passport.', '/passport'); await refreshAchievements(userId); }
  res.json({ exchange, message: 'Exchange completed.' });
}));

app.get('/api/sessions', asyncRoute(async (req, res) => {
  const status = req.query.status;
  const query: any = { $or: [{ host: req.userId }, { guest: req.userId }] };
  if (['scheduled', 'completed', 'cancelled'].includes(String(status))) query.status = status;
  const sessions = await LearningSession.find(query).sort({ startAt: 1 }).populate('host guest', 'name college avatarUrl').populate('exchange');
  res.json({ sessions });
}));
app.get('/api/sessions/:id', asyncRoute(async (req, res) => {
  const session = await LearningSession.findOne({ _id: req.params.id, $or: [{ host: req.userId }, { guest: req.userId }] }).populate('host guest', 'name college avatarUrl').populate('exchange');
  if (!session) return res.status(404).json({ message: 'Session not found.' });
  res.json({ session, hasReviewed: session.reviewedBy.some((member: any) => id(member) === req.userId) });
}));
app.post('/api/sessions', asyncRoute(async (req, res) => {
  const data = z.object({ exchange: z.string().min(1), title: z.string().trim().min(3).max(120), skill: z.string().trim().min(2).max(80), description: z.string().max(1000).optional(), startAt: z.string().datetime(), endAt: z.string().datetime(), meetingLink: z.union([z.string().url(), z.literal('')]).optional() }).parse(req.body);
  const exchange: any = await ActiveExchange.findById(data.exchange).populate('participants', 'name');
  if (!canAccess(exchange, req.userId!)) return res.status(404).json({ message: 'Active exchange not found.' });
  const startAt = new Date(data.startAt), endAt = new Date(data.endAt);
  if (startAt <= new Date() || endAt <= startAt || endAt.getTime() - startAt.getTime() > 8 * 60 * 60 * 1000) return res.status(400).json({ message: 'Choose a future time and a session duration of up to 8 hours.' });
  const guest = exchange.participants.find((p: any) => id(p._id) !== req.userId);
  const session = await LearningSession.create({ ...data, startAt, endAt, host: req.userId, guest: guest._id });
  await notify(guest._id, 'session_scheduled', 'A learning session was scheduled', `${data.title} is on your calendar.`, '/sessions');
  res.status(201).json({ session, message: 'Session scheduled.' });
}));
app.patch('/api/sessions/:id', asyncRoute(async (req, res) => {
  const data = z.object({ action: z.enum(['complete', 'cancel']) }).parse(req.body);
  const session: any = await LearningSession.findById(req.params.id);
  if (!session || (id(session.host) !== req.userId && id(session.guest) !== req.userId)) return res.status(404).json({ message: 'Session not found.' });
  if (session.status !== 'scheduled') return res.status(409).json({ message: 'This session has already been updated.' });
  if (data.action === 'complete' && session.endAt > new Date()) return res.status(400).json({ message: 'A session can be completed after its scheduled end time.' });
  const updatedSession = await LearningSession.findOneAndUpdate({ _id: session._id, status: 'scheduled' }, { $set: { status: data.action === 'complete' ? 'completed' : 'cancelled' } }, { new: true });
  if (!updatedSession) return res.status(409).json({ message: 'This session has already been updated.' });
  const participants = [session.host, session.guest];
  if (data.action === 'complete') {
    for (const userId of participants) {
      const user: any = await User.findById(userId); if (!user) continue;
      user.coins += 10; const today = new Date().toISOString().slice(0, 10); const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      user.streak = user.lastActivityDate === today ? user.streak : user.lastActivityDate === yesterday ? user.streak + 1 : 1; user.lastActivityDate = today;
      await user.save(); await SkillCoinsTransaction.create({ user: userId, amount: 10, reason: 'Completed learning session', session: session._id });
      await notify(userId, 'session_completed', 'Session completed · +10 SkillCoins', 'Share a quick review to help the community grow.', `/sessions/${session._id}`);
      await refreshAchievements(userId);
    }
  } else for (const userId of participants) await notify(userId, 'session_cancelled', 'Learning session cancelled', `${session.title} has been cancelled.`, '/sessions');
  res.json({ session: updatedSession, message: `Session ${data.action}d.` });
}));
app.post('/api/sessions/:id/reviews', asyncRoute(async (req, res) => {
  const data = z.object({ rating: z.number().int().min(1).max(5), teachingQuality: z.number().int().min(1).max(5), communication: z.number().int().min(1).max(5), knowledgeSharing: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }).parse(req.body);
  const session: any = await LearningSession.findById(req.params.id);
  if (!session || session.status !== 'completed' || (![id(session.host), id(session.guest)].includes(req.userId!))) return res.status(400).json({ message: 'Reviews are available only to participants after a completed session.' });
  if ((session.reviewedBy || []).some((member: any) => id(member) === req.userId)) return res.status(409).json({ message: 'You have already reviewed this session.' });
  const recipient = id(session.host) === req.userId ? session.guest : session.host;
  const review = await Review.create({ session: session._id, author: req.userId, recipient, ...data });
  session.reviewedBy.push(req.userId); await session.save();
  await notify(recipient, 'new_review', 'You received a new review', 'A student shared feedback about your learning session.', '/reviews');
  await refreshAchievements(recipient);
  res.status(201).json({ review, message: 'Thanks for sharing thoughtful feedback.' });
}));
app.get('/api/reviews', asyncRoute(async (req, res) => {
  const [received, given] = await Promise.all([Review.find({ recipient: req.userId }).sort({ createdAt: -1 }).populate('author', 'name avatarUrl'), Review.find({ author: req.userId }).sort({ createdAt: -1 }).populate('recipient', 'name avatarUrl')]);
  res.json({ received, given });
}));

app.get('/api/notifications', asyncRoute(async (req, res) => {
  const notifications = await Notification.find({ user: req.userId }).sort({ createdAt: -1 }).limit(100);
  res.json({ notifications, unread: notifications.filter((item: any) => !item.readAt).length });
}));
app.patch('/api/notifications/:id/read', asyncRoute(async (req, res) => {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.userId }, { $set: { readAt: new Date() } }, { new: true });
  if (!notification) return res.status(404).json({ message: 'Notification not found.' });
  res.json({ notification });
}));
app.post('/api/notifications/read-all', asyncRoute(async (req, res) => {
  await Notification.updateMany({ user: req.userId, readAt: { $exists: false } }, { $set: { readAt: new Date() } }); res.json({ message: 'Notifications marked as read.' });
}));

app.get('/api/leaderboard', asyncRoute(async (req, res) => {
  const sort: any = req.query.sort === 'rating' ? { rating: -1 } : req.query.sort === 'teachers' ? { teachingRating: -1, teacherReviewCount: -1 } : req.query.sort === 'exchanges' ? { completedExchanges: -1 } : req.query.sort === 'sessions' ? { completedSessions: -1 } : { coins: -1 };
  const rows = await User.aggregate([
    { $match: { role: 'student', suspendedAt: null } },
    { $lookup: { from: 'skillcoinstransactions', localField: '_id', foreignField: 'user', as: 'tx' } },
    { $lookup: {
      from: 'learningsessions', let: { uid: '$_id' },
      pipeline: [{ $match: { status: 'completed', $expr: { $or: [{ $eq: ['$host', '$$uid'] }, { $eq: ['$guest', '$$uid'] }] } } }],
      as: 'sessions',
    } },
    { $lookup: { from: 'activeexchanges', let: { uid: '$_id' }, pipeline: [{ $match: { status: 'completed', $expr: { $in: ['$$uid', '$participants'] } } }], as: 'exchanges' } },
    { $lookup: { from: 'studentskills', let: { uid: '$_id' }, pipeline: [{ $match: { kind: 'teach', $expr: { $eq: ['$user', '$$uid'] } } }], as: 'teaching' } },
    { $lookup: { from: 'reviews', localField: '_id', foreignField: 'recipient', as: 'reviews' } },
    { $addFields: { coins: { $sum: '$tx.amount' }, completedSessions: { $size: '$sessions' }, completedExchanges: { $size: '$exchanges' }, rating: { $ifNull: [{ $avg: '$reviews.rating' }, 0] }, teachingRating: { $ifNull: [{ $avg: '$reviews.teachingQuality' }, 0] }, teacherReviewCount: { $size: '$reviews' }, taughtSkills: { $size: '$teaching' } } },
    { $sort: sort }, { $limit: 25 },
    { $project: { name: 1, college: 1, avatarUrl: 1, coins: 1, completedSessions: 1, completedExchanges: 1, rating: 1, teachingRating: 1, teacherReviewCount: 1, taughtSkills: 1, badges: 1 } },
  ]);
  res.json({ students: rows, sort: String(req.query.sort || 'coins') });
}));
app.get('/api/passport', asyncRoute(async (req, res) => {
  const [sessions, exchanges, reviews, transactions, user] = await Promise.all([LearningSession.find({ $or: [{ host: req.userId }, { guest: req.userId }], status: 'completed' }).sort({ endAt: -1 }).populate('host guest', 'name'), ActiveExchange.find({ participants: req.userId, status: 'completed' }).countDocuments(), Review.find({ author: req.userId }).countDocuments(), SkillCoinsTransaction.find({ user: req.userId }).sort({ createdAt: -1 }), User.findById(req.userId)]);
  res.json({ sessions, exchanges, reviews, hoursContributed: sessions.reduce((n, session: any) => n + Math.max(0, (session.endAt.getTime() - session.startAt.getTime()) / 3_600_000), 0), transactions, badges: user?.badges || [], streak: user?.streak || 0 });
}));
app.get('/api/achievements', asyncRoute(async (req, res) => {
  const [all, earned] = await Promise.all([Achievement.find().sort({ threshold: 1, name: 1 }), StudentAchievement.find({ user: req.userId }).populate('achievement')]);
  const earnedAt = new Map(earned.map((item: any) => [id(item.achievement?._id), item.awardedAt]));
  res.json({ achievements: all.map((achievement: any) => ({ ...achievement.toObject(), earnedAt: earnedAt.get(id(achievement._id)) || null })) });
}));
app.get('/api/skill-gaps', asyncRoute(async (req, res) => {
  const learning = await StudentSkill.find({ user: req.userId, kind: 'learn' }).populate('skill', 'name category');
  const others = await StudentSkill.find({ user: { $ne: req.userId }, kind: 'teach' }).populate('skill', 'name');
  const taught = new Set(others.map((row: any) => row.skill?.name?.toLowerCase()).filter(Boolean));
  res.json({ gaps: learning.map((row: any) => ({ name: row.skill?.name, category: row.skill?.category, level: row.level, providers: others.filter((other: any) => other.skill?.name?.toLowerCase() === row.skill?.name?.toLowerCase()).length })).filter((row: any) => !taught.has(row.name?.toLowerCase())) });
}));

app.get('/api/knowledge-graph', asyncRoute(async (_req, res) => {
  const records: any[] = await StudentSkill.find().sort({ updatedAt: -1 }).limit(1500)
    .populate('user', 'name college avatarUrl role suspendedAt').populate('skill', 'name category').lean();
  const eligible = records.filter((row) => row.user && row.skill && row.user.role === 'student' && !row.user.suspendedAt);
  const skillCounts = new Map<string, { name: string; category: string; count: number }>();
  for (const row of eligible) {
    const key = id(row.skill._id);
    const skill = skillCounts.get(key) || { name: row.skill.name, category: row.skill.category, count: 0 };
    skill.count += 1; skillCounts.set(key, skill);
  }
  const selectedSkills = [...skillCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20);
  const skillIds = new Set(selectedSkills.map(([key]) => key));
  const selectedRows = eligible.filter((row) => skillIds.has(id(row.skill._id)));
  const userCounts = new Map<string, { user: any; count: number }>();
  for (const row of selectedRows) {
    const key = id(row.user._id); const item = userCounts.get(key) || { user: row.user, count: 0 };
    item.count += 1; userCounts.set(key, item);
  }
  const selectedUsers = [...userCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 40);
  const userIds = new Set(selectedUsers.map(([key]) => key));
  const visibleRows = selectedRows.filter((row) => userIds.has(id(row.user._id)));
  res.json({
    nodes: [
      ...selectedUsers.map(([key, item]) => ({ id: `student:${key}`, type: 'student', label: item.user.name, college: item.user.college || '', avatarUrl: item.user.avatarUrl || '', connections: item.count })),
      ...selectedSkills.map(([key, item]) => ({ id: `skill:${key}`, type: 'skill', label: item.name, category: item.category, connections: item.count })),
    ],
    edges: visibleRows.map((row) => ({ source: `student:${id(row.user._id)}`, target: `skill:${id(row.skill._id)}`, kind: row.kind })),
    totals: { students: userCounts.size, skills: skillCounts.size, connections: eligible.length },
  });
}));

app.get('/api/messages/unread-count', asyncRoute(async (req, res) => {
  const unread = await Message.countDocuments({ recipient: req.userId, readAt: { $exists: false } });
  res.json({ unread });
}));

app.get('/api/messages/:exchangeId', asyncRoute(async (req, res) => {
  const exchange = await ActiveExchange.findById(req.params.exchangeId);
  if (!canAccess(exchange, req.userId!)) return res.status(403).json({ message: 'Only active exchange partners can open this conversation.' });
  const messages = await Message.find({ exchange: exchange!._id }).sort({ createdAt: 1 }).limit(200).populate('sender', 'name avatarUrl');
  await Message.updateMany({ exchange: exchange!._id, recipient: req.userId, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  res.json({ messages });
}));
app.post('/api/messages/:exchangeId', asyncRoute(async (req, res) => {
  const data = z.object({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
  const exchange: any = await ActiveExchange.findById(req.params.exchangeId);
  if (!canAccess(exchange, req.userId!)) return res.status(403).json({ message: 'Only active exchange partners can send messages.' });
  const recipient = exchange.participants.find((member: any) => id(member) !== req.userId);
  const message = await Message.create({ exchange: exchange._id, sender: req.userId, recipient, body: data.body });
  const output = await message.populate('sender', 'name avatarUrl');
  io.to(`exchange:${id(exchange._id)}`).emit('message', output);
  await notify(recipient, 'message', 'New message', 'Your exchange partner sent you a message.', `/messages/${id(exchange._id)}`);
  res.status(201).json({ message: output });
}));

app.get('/api/circles', asyncRoute(async (_req, res) => res.json({ circles: await SkillCircle.find({ status: 'open' }).sort({ createdAt: -1 }).populate('host members', 'name college avatarUrl') })));
app.post('/api/circles', asyncRoute(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(3).max(100), skill: z.string().trim().min(2).max(80), description: z.string().max(500).optional(), capacity: z.number().int().min(3).max(6).default(6) }).parse(req.body);
  const circle = await SkillCircle.create({ ...data, host: req.userId, members: [req.userId] }); res.status(201).json({ circle, message: 'Skill circle created.' });
}));
app.post('/api/circles/:id/join', asyncRoute(async (req, res) => {
  const circle: any = await SkillCircle.findOneAndUpdate({ _id: req.params.id, status: 'open', members: { $ne: req.userId }, $expr: { $lt: [{ $size: '$members' }, '$capacity'] } }, { $addToSet: { members: req.userId } }, { new: true });
  if (!circle) {
    const existing: any = await SkillCircle.findById(req.params.id);
    if (!existing || existing.status !== 'open') return res.status(404).json({ message: 'This circle is closed.' });
    if (existing.members.some((member: any) => id(member) === req.userId)) return res.status(409).json({ message: 'You are already in this circle.' });
    return res.status(409).json({ message: 'This circle has reached capacity.' });
  }
  if (circle.members.length >= circle.capacity) { circle.status = 'closed'; await circle.save(); }
  try {
    await SkillCoinsTransaction.create({ user: req.userId, circle: circle._id, amount: 5, reason: 'Joined a skill circle' });
    await User.updateOne({ _id: req.userId }, { $inc: { coins: 5 } });
    await notify(circle.host, 'circle_member', 'A student joined your skill circle', 'Your shared learning group is growing.', '/circles');
    await refreshAchievements(req.userId);
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
  }
  res.json({ circle, message: 'You joined the skill circle and earned 5 SkillCoins.' });
}));
app.post('/api/reports', asyncRoute(async (req, res) => {
  const data = z.object({ reportedUser: z.string(), reason: z.string().min(3).max(100), details: z.string().max(1000).optional() }).parse(req.body);
  if (data.reportedUser === req.userId) return res.status(400).json({ message: 'You cannot report your own account.' });
  await Report.create({ reporter: req.userId, ...data }); res.status(201).json({ message: 'Report submitted for review.' });
}));

app.get('/api/admin/overview', requireAdmin, asyncRoute(async (_req, res) => {
  const [students, exchanges, sessions, openReports, recentUsers, monthly] = await Promise.all([
    User.countDocuments({ role: 'student' }), ActiveExchange.countDocuments(), LearningSession.countDocuments(), Report.countDocuments({ status: 'open' }),
    User.find({ role: 'student' }).sort({ createdAt: -1 }).limit(8).select('name email college createdAt suspendedAt'),
    User.aggregate([
      { $match: { role: 'student' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: -1 } }, { $limit: 6 },
    ]),
  ]);
  res.json({ students, exchanges, sessions, openReports, recentUsers, monthly });
}));
app.get('/api/admin/students', requireAdmin, asyncRoute(async (req, res) => {
  const q = String(req.query.q || ''); const students = await User.find({ role: 'student', ...(q ? { $or: [{ name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { email: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }] } : {}) }).sort({ createdAt: -1 }).limit(100).select('name email college createdAt suspendedAt'); res.json({ students });
}));
app.patch('/api/admin/students/:id', requireAdmin, asyncRoute(async (req, res) => {
  const data = z.object({ action: z.enum(['suspend', 'reactivate']) }).parse(req.body);
  const student = await User.findOneAndUpdate({ _id: req.params.id, role: 'student' }, data.action === 'suspend' ? { $set: { suspendedAt: new Date() } } : { $unset: { suspendedAt: 1 } }, { new: true }).select('name email suspendedAt');
  if (!student) return res.status(404).json({ message: 'Student not found.' }); res.json({ student, message: `Account ${data.action === 'suspend' ? 'suspended' : 'reactivated'}.` });
}));
app.get('/api/admin/reports', requireAdmin, asyncRoute(async (_req, res) => res.json({ reports: await Report.find().sort({ createdAt: -1 }).populate('reporter reportedUser', 'name email') })));
app.patch('/api/admin/reports/:id', requireAdmin, asyncRoute(async (req, res) => {
  const data = z.object({ status: z.enum(['reviewed', 'resolved']) }).parse(req.body); const report = await Report.findByIdAndUpdate(req.params.id, { $set: { status: data.status } }, { new: true }); if (!report) return res.status(404).json({ message: 'Report not found.' }); res.json({ report });
}));
app.get('/api/admin/categories', requireAdmin, asyncRoute(async (_req, res) => res.json({ categories: [...new Set([...categories, ...await Skill.distinct('category'), ...await SkillCategory.distinct('name')])] })));
app.post('/api/admin/categories', requireAdmin, asyncRoute(async (req, res) => { const { category } = z.object({ category: z.string().trim().min(2).max(80) }).parse(req.body); await SkillCategory.findOneAndUpdate({ name: category }, { $setOnInsert: { name: category } }, { upsert: true }); res.status(201).json({ categories: [...new Set([...categories, ...await SkillCategory.distinct('name')])] }); }));

io.use(async (socket, next) => {
  try {
    const cookie = socket.handshake.headers.cookie || ''; const token = cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith('skillora_session='))?.split('=').slice(1).join('=');
    if (!token) return next(new Error('Authentication required'));
    const payload = jwt.verify(decodeURIComponent(token), config.jwtSecret) as { sub: string }; const user = await User.findById(payload.sub).select('suspendedAt');
    if (!user || user.suspendedAt) return next(new Error('Account unavailable'));
    socket.data.userId = payload.sub; next();
  } catch { next(new Error('Authentication required')); }
});
io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  socket.on('join-exchange', async (exchangeId: string) => {
    const exchange = await ActiveExchange.findById(exchangeId);
    if (canAccess(exchange, socket.data.userId)) socket.join(`exchange:${exchangeId}`);
  });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ message: 'Please check the highlighted fields.', errors: err.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) });
  if (err?.code === 11000) return res.status(409).json({ message: 'That record already exists.' });
  if (err?.name === 'CastError') return res.status(400).json({ message: 'The requested record is invalid.' });
  if (err?.name === 'ValidationError') return res.status(400).json({ message: err.message });
  console.error(err); return res.status(500).json({ message: 'Something went wrong on our side. Please try again.' });
});

mongoose.connect(config.mongoUri).then(() => {
  const defaults = [
    ['First Exchange', 'Complete your first learning partnership.', 'sparkles', 1],
    ['Knowledge Sharer', 'Earn 30 SkillCoins by sharing what you know.', 'book-open', 30],
    ['Fast Learner', 'Complete five learning sessions.', 'zap', 5],
    ['Top Mentor', 'Receive five verified reviews.', 'award', 5],
    ['Consistent Learner', 'Build a seven-day learning streak.', 'flame', 7],
    ['Community Champion', 'Complete ten skill exchanges.', 'users', 10],
  ];
  return Promise.all(defaults.map(([name, description, icon, threshold]) => Achievement.findOneAndUpdate({ name }, { $setOnInsert: { name, description, icon, threshold } }, { upsert: true })));
}).then(() => {
  const reminderTimer = setInterval(() => { void sendUpcomingSessionReminders().catch((error) => console.error('Could not send session reminders:', error)); }, 60_000);
  reminderTimer.unref();
  void sendUpcomingSessionReminders().catch((error) => console.error('Could not send session reminders:', error));
  server.listen(config.port, () => console.log(`SKILLORA API listening on http://localhost:${config.port}`));
}).catch((error) => { console.error('Could not connect to MongoDB:', error); process.exit(1); });
