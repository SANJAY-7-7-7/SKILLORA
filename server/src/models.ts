import mongoose, { Schema, model } from 'mongoose';

const skillSchema = new Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true, index: true },
}, { timestamps: true });
skillSchema.index({ name: 1, category: 1 }, { unique: true });
export const Skill = mongoose.models.Skill || model('Skill', skillSchema);
const categorySchema = new Schema({ name: { type: String, required: true, unique: true, trim: true } }, { timestamps: true });
export const SkillCategory = mongoose.models.SkillCategory || model('SkillCategory', categorySchema);

const studentSkillSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  skill: { type: Schema.Types.ObjectId, ref: 'Skill', required: true },
  kind: { type: String, enum: ['teach', 'learn'], required: true },
  level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'], default: 'Beginner' },
  details: { type: String, maxlength: 500, default: '' },
  availability: { type: [String], default: [] },
}, { timestamps: true });
studentSkillSchema.index({ user: 1, skill: 1, kind: 1 }, { unique: true });
export const StudentSkill = mongoose.models.StudentSkill || model('StudentSkill', studentSkillSchema);

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  passwordHash: { type: String, required: true, select: false },
  college: { type: String, trim: true, maxlength: 120, default: '' },
  department: { type: String, trim: true, maxlength: 100, default: '' },
  year: { type: String, default: '' },
  bio: { type: String, maxlength: 500, default: '' },
  avatarUrl: { type: String, default: '' },
  availability: { type: [String], default: [] },
  role: { type: String, enum: ['student', 'admin'], default: 'student', index: true },
  emailVerified: { type: Boolean, default: false },
  verificationHash: String,
  verificationExpires: Date,
  resetHash: String,
  resetExpires: Date,
  coins: { type: Number, default: 0 },
  streak: { type: Number, default: 0 },
  lastActivityDate: String,
  badges: { type: [String], default: [] },
  suspendedAt: Date,
}, { timestamps: true });
userSchema.index({ college: 1, department: 1 });
export const User = mongoose.models.User || model('User', userSchema);

const requestSchema = new Schema({
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  message: { type: String, maxlength: 1000, default: '' },
  offeredSkills: { type: [String], default: [] },
  requestedSkills: { type: [String], default: [] },
  status: { type: String, enum: ['pending', 'accepted', 'rejected', 'cancelled', 'completed'], default: 'pending', index: true },
  activeExchange: { type: Schema.Types.ObjectId, ref: 'ActiveExchange' },
}, { timestamps: true });
requestSchema.index({ sender: 1, recipient: 1, status: 1 });
export const ExchangeRequest = mongoose.models.ExchangeRequest || model('ExchangeRequest', requestSchema);

const exchangeSchema = new Schema({
  request: { type: Schema.Types.ObjectId, ref: 'ExchangeRequest', required: true, unique: true },
  participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
  status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active', index: true },
}, { timestamps: true });
export const ActiveExchange = mongoose.models.ActiveExchange || model('ActiveExchange', exchangeSchema);

const sessionSchema = new Schema({
  exchange: { type: Schema.Types.ObjectId, ref: 'ActiveExchange', required: true, index: true },
  host: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  guest: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 120 },
  skill: { type: String, required: true, maxlength: 80 },
  description: { type: String, maxlength: 1000, default: '' },
  startAt: { type: Date, required: true, index: true },
  endAt: { type: Date, required: true },
  meetingLink: { type: String, default: '' },
  status: { type: String, enum: ['scheduled', 'completed', 'cancelled'], default: 'scheduled', index: true },
  reviewedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  reminderSentAt: Date,
}, { timestamps: true });
sessionSchema.index({ exchange: 1, startAt: 1 });
export const LearningSession = mongoose.models.LearningSession || model('LearningSession', sessionSchema);

const reviewSchema = new Schema({
  session: { type: Schema.Types.ObjectId, ref: 'LearningSession', required: true },
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  teachingQuality: { type: Number, min: 1, max: 5 },
  communication: { type: Number, min: 1, max: 5 },
  knowledgeSharing: { type: Number, min: 1, max: 5 },
  comment: { type: String, maxlength: 1000, default: '' },
}, { timestamps: true });
reviewSchema.index({ session: 1, author: 1 }, { unique: true });
export const Review = mongoose.models.Review || model('Review', reviewSchema);

const notificationSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  link: String,
  readAt: Date,
}, { timestamps: true });
export const Notification = mongoose.models.Notification || model('Notification', notificationSchema);

const messageSchema = new Schema({
  exchange: { type: Schema.Types.ObjectId, ref: 'ActiveExchange', required: true, index: true },
  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, required: true, maxlength: 5000 },
  readAt: Date,
}, { timestamps: true });
export const Message = mongoose.models.Message || model('Message', messageSchema);

const reportSchema = new Schema({
  reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  reportedUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  reason: { type: String, required: true, maxlength: 100 },
  details: { type: String, maxlength: 1000, default: '' },
  status: { type: String, enum: ['open', 'reviewed', 'resolved'], default: 'open', index: true },
}, { timestamps: true });
export const Report = mongoose.models.Report || model('Report', reportSchema);

const coinSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true },
  reason: { type: String, required: true },
  session: { type: Schema.Types.ObjectId, ref: 'LearningSession' },
  circle: { type: Schema.Types.ObjectId, ref: 'SkillCircle' },
}, { timestamps: true });
coinSchema.index({ user: 1, circle: 1 }, { unique: true, partialFilterExpression: { circle: { $exists: true } } });
export const SkillCoinsTransaction = mongoose.models.SkillCoinsTransaction || model('SkillCoinsTransaction', coinSchema);

const achievementSchema = new Schema({ name: { type: String, unique: true }, description: String, icon: String, threshold: Number });
export const Achievement = mongoose.models.Achievement || model('Achievement', achievementSchema);
const studentAchievementSchema = new Schema({ user: { type: Schema.Types.ObjectId, ref: 'User', index: true }, achievement: { type: Schema.Types.ObjectId, ref: 'Achievement' }, awardedAt: { type: Date, default: Date.now } });
studentAchievementSchema.index({ user: 1, achievement: 1 }, { unique: true });
export const StudentAchievement = mongoose.models.StudentAchievement || model('StudentAchievement', studentAchievementSchema);

const circleSchema = new Schema({
  name: { type: String, required: true, maxlength: 100 },
  skill: { type: String, required: true },
  description: { type: String, maxlength: 500, default: '' },
  host: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  capacity: { type: Number, min: 3, max: 6, default: 6 },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
}, { timestamps: true });
export const SkillCircle = mongoose.models.SkillCircle || model('SkillCircle', circleSchema);
