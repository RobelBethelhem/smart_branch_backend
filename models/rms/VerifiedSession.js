import mongoose from "mongoose";

const verifiedSessionSchema = new mongoose.Schema({
    session_token: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    cif: {
        type: String,
        required: true,
        index: true
    },
    verified_account_number: {
        type: String,
        required: true // The specific account that was OTP-verified
    },
    ip_address: {
        type: String
    },
    created_at: {
        type: Date,
        default: Date.now,
        expires: 1800 // Auto-delete after 30 minutes (MongoDB TTL)
    }
});

const VerifiedSession = mongoose.models.VerifiedSession || mongoose.model('VerifiedSession', verifiedSessionSchema);
export default VerifiedSession;
