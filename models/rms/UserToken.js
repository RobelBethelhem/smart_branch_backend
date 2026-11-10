import mongoose from "mongoose";
const Schema = mongoose.Schema;

const userTokenSchema = new Schema({
    userId:{
        type: Schema.Types.ObjectId,
        required: true
    },
    token:{
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 30*86400
    }
});

// Looked up by token on every refresh and by userId on every login.
userTokenSchema.index({ token: 1 });
userTokenSchema.index({ userId: 1 });

const UserToken = mongoose.model("UserToken", userTokenSchema);
export default UserToken;