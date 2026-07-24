import mongoose from 'mongoose';

const { Schema } = mongoose;

// Audit trail of every tablet interaction streamed from the ZSmart Branch app.
// Keyed by `serial` (the tablet serial number) so, with many tablets, each
// action is attributable to a specific device. Only interaction type + a short
// label are stored — never a value typed into an input (account numbers, OTPs,
// PINs are never recorded).
const interactionLogSchema = new Schema(
  {
    serial: { type: String, trim: true, index: true }, // tablet serial — audit key
    branch: { type: String, trim: true, index: true }, // branch code
    session_id: { type: String, trim: true }, // per-visit id
    event_type: { type: String, trim: true, index: true }, // login_success, otp_fail, open, click, ...
    label: { type: String, trim: true }, // event detail (masked account / element label)
    path: { type: String, trim: true },
    ip_address: { type: String, trim: true }, // captured server-side
    event_ts: { type: String, trim: true }, // client timestamp (ISO 8601)
  },
  { timestamps: true } // createdAt = server receive time
);

// Fast per-tablet, time-ordered audit queries.
interactionLogSchema.index({ serial: 1, createdAt: -1 });

const InteractionLog = mongoose.model('InteractionLog', interactionLogSchema);

export default InteractionLog;
