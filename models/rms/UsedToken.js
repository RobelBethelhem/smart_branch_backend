import mongoose from "mongoose";
const Schema = mongoose.Schema;

const usedTokenSchema = new Schema({
    token:{
        type: String,
        required: true
    },
});

// The token blacklist is checked on EVERY authenticated request. Without this
// index that check was a full-collection scan over an ever-growing collection.
usedTokenSchema.index({ token: 1 });

const UsedToken = mongoose.model("UsedToken", usedTokenSchema);
export default UsedToken;