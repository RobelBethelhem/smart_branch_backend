import mongoose from "mongoose";
const Schema = mongoose.Schema;

// A transaction that FlexCube ACCEPTED but whose result could not be saved in this system
// (the request ended in an error after the posting, e.g. the database was unreachable or the
// record failed validation). The transaction therefore still looks unposted ("assigned" /
// "pending_checker"). Posting it again would move the money a second time, so while a record
// exists here every further posting attempt for that transaction is refused.
//
// _id is "<kind>:<transaction id>", the same key as PostingLock. There is deliberately NO
// expiry: a person has to check FlexCube, correct the transaction, and delete the record.
// See deploy/README.md, "A posting was accepted by FlexCube but not saved".
const unrecordedPostingSchema = new Schema({
    _id: { type: String },
    kind: { type: String },
    transaction_id: { type: String },
    trn_ref_no: { type: String },
    posted_by: { type: String },
    response_status: { type: Number },
    createdAt: { type: Date, default: Date.now }
});

const UnrecordedPosting = mongoose.models.UnrecordedPosting
    || mongoose.model("UnrecordedPosting", unrecordedPostingSchema);
export default UnrecordedPosting;
