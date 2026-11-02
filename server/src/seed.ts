import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { config } from './config.js';
import { Achievement, Skill, StudentSkill, User } from './models.js';

const demoPeople = [
  { name: 'Maya Chen', email: 'maya@skillora.demo', college: 'Northstar University', department: 'Computer Science', year: '3rd year', bio: 'Frontend builder who loves turning complex ideas into calm, useful interfaces.', teach: [['React', 'Web Development', 'Advanced'], ['JavaScript', 'Programming', 'Advanced']], learn: [['Figma', 'UI/UX Design', 'Beginner']] },
  { name: 'Aarav Mehta', email: 'aarav@skillora.demo', college: 'Northstar University', department: 'Design', year: '2nd year', bio: 'Designing thoughtful digital products, one wireframe at a time.', teach: [['Figma', 'UI/UX Design', 'Advanced'], ['Graphic Design', 'Graphic Design', 'Intermediate']], learn: [['React', 'Web Development', 'Beginner']] },
  { name: 'Priya Nair', email: 'priya@skillora.demo', college: 'Riverdale College', department: 'Data Science', year: '3rd year', bio: 'I make data less intimidating with Python, stories and good questions.', teach: [['Python', 'Programming', 'Advanced'], ['Data Visualization', 'Data Science', 'Intermediate']], learn: [['Public Speaking', 'Communication', 'Beginner']] },
  { name: 'Jordan Lee', email: 'jordan@skillora.demo', college: 'Riverdale College', department: 'Media Studies', year: '2nd year', bio: 'Video editor and curious learner looking for a data-minded study buddy.', teach: [['Video Editing', 'Video Editing', 'Advanced'], ['Public Speaking', 'Communication', 'Intermediate']], learn: [['Python', 'Programming', 'Beginner']] },
  { name: 'Samira Khan', email: 'samira@skillora.demo', college: 'Easton Institute', department: 'Computer Science', year: '4th year', bio: 'Building accessible apps and sharing what I learn along the way.', teach: [['Flutter', 'App Development', 'Advanced']], learn: [['Photography', 'Photography', 'Beginner']] },
  { name: 'Theo Martin', email: 'theo@skillora.demo', college: 'Easton Institute', department: 'Arts', year: '3rd year', bio: 'Film photographer who is ready to learn how to ship an app.', teach: [['Photography', 'Photography', 'Advanced']], learn: [['Flutter', 'App Development', 'Beginner']] },
];

async function seed() {
  await mongoose.connect(config.mongoUri);
  const passwordHash = await bcrypt.hash('SkilloraDemo!2026', 12);
  const catalog = new Map<string, any>();
  for (const person of demoPeople) {
    const user = await User.findOneAndUpdate({ email: person.email }, { $set: { name: person.name, college: person.college, department: person.department, year: person.year, bio: person.bio, emailVerified: true, role: 'student', passwordHash, availability: ['weekday-evening', 'weekend-morning'] }, $setOnInsert: { coins: 0 } }, { new: true, upsert: true });
    await StudentSkill.deleteMany({ user: user._id });
    for (const [kind, rows] of [['teach', person.teach], ['learn', person.learn]] as const) {
      for (const [name, category, level] of rows) {
        const key = `${name.toLowerCase()}|${category}`;
        if (!catalog.has(key)) catalog.set(key, await Skill.findOneAndUpdate({ name, category }, { $setOnInsert: { name, category } }, { new: true, upsert: true }));
        await StudentSkill.create({ user: user._id, skill: catalog.get(key)._id, kind, level, details: kind === 'teach' ? `Happy to help you get started with ${name}.` : `Looking for a supportive learning partner.` });
      }
    }
  }
  const adminHash = await bcrypt.hash('SkilloraAdmin!2026', 12);
  await User.findOneAndUpdate({ email: 'admin@skillora.demo' }, { $set: { name: 'Skillora Admin', email: 'admin@skillora.demo', passwordHash: adminHash, role: 'admin', emailVerified: true, college: 'SKILLORA' } }, { upsert: true, new: true });
  const achievements = [
    ['First Exchange', 'Complete your first learning partnership.', 'sparkles', 1],
    ['Knowledge Sharer', 'Earn 30 SkillCoins by sharing what you know.', 'book-open', 30],
    ['Fast Learner', 'Complete five learning sessions.', 'zap', 5],
    ['Top Mentor', 'Receive five verified reviews.', 'award', 5],
    ['Consistent Learner', 'Build a seven-day learning streak.', 'flame', 7],
    ['Community Champion', 'Complete ten skill exchanges.', 'users', 10],
  ];
  for (const [name, description, icon, threshold] of achievements) await Achievement.findOneAndUpdate({ name }, { $set: { description, icon, threshold } }, { upsert: true });
  console.log('Seed complete. Sample login: maya@skillora.demo / SkilloraDemo!2026');
  console.log('Sample admin: admin@skillora.demo / SkilloraAdmin!2026');
  await mongoose.disconnect();
}
seed().catch(async (error) => { console.error(error); await mongoose.disconnect(); process.exit(1); });
