import { config } from 'dotenv';
  config();
  import mongoose from 'mongoose';

  const run = async () => {
    await mongoose.connect(process.env.DB);
    const U = mongoose.model('U', new mongoose.Schema({}, { strict: false }), 'users');

    const admins = await U.find({ roles: 'Admin' }).lean();
    console.log('ADMINS:', admins.map(u => ({ user: u.user, email: u.email, branch: u.branch, type: typeof u.branch })));

    const all = await U.find({}).lean();
    const by = {};
    all.forEach(u => { const k = JSON.stringify(u.branch); by[k] = (by[k] || 0) + 1; });
    console.log('PER BRANCH:', by);

    await mongoose.disconnect();
  };

  run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });