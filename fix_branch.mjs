 import { config } from 'dotenv';
  config();
  import mongoose from 'mongoose';

  const run = async () => {
    await mongoose.connect(process.env.DB);
    const U = mongoose.model('U', new mongoose.Schema({}, { strict: false }), 'users');

    const numeric = await U.find({ branch: { $type: 'number' } }).lean();
    console.log('Users with numeric branch:', numeric.length);

    for (const u of numeric) {
      await U.updateOne({ _id: u._id }, { $set: { branch: String(u.branch) } });
    }
    console.log('Converted', numeric.length, 'users -> branch is now text');

    const after = await U.find({}).lean();
    const by = {};
    after.forEach(u => { const k = `${JSON.stringify(u.branch)} (${typeof u.branch})`; by[k] = (by[k] || 0) + 1; });
    console.log('PER BRANCH NOW:', by);

    await mongoose.disconnect();
  };
  run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });