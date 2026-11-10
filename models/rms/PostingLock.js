import mongoose from "mongoose";
const Schema = mongoose.Schema;

// One document per transaction that is being posted to FlexCube right now.
//
// _id is "<kind>:<transaction id>" (e.g. "Withdraw:665f..."), so MongoDB's unique _id index is
// the lock: only one request can insert it, every other one gets a duplicate-key error. The
// request that inserted it deletes it when it has finished. See utils/rms/postingLock.js.
//
// createdAt has a TTL index as a safety net only: if the server dies in the middle of a
// posting, nobody deletes the lock, and MongoDB removes it after LOCK_SECONDS so the
// transaction can be worked on again. It is deliberately long: it must never expire while a
// slow posting is still running, or a second posting could start alongside it.
export const LOCK_SECONDS = 10 * 60;

const postingLockSchema = new Schema({
    _id: { type: String },
    locked_by: { type: String },
    createdAt: { type: Date, default: Date.now, expires: LOCK_SECONDS }
});

const PostingLock = mongoose.models.PostingLock || mongoose.model("PostingLock", postingLockSchema);
export default PostingLock;
