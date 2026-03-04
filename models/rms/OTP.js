import mongoose from 'mongoose';

const { Schema } = mongoose;

const otpSchema = new Schema({
    cif: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    account_number: {
        type: String,
        required: true,
        trim: true
    },
    phone_number: {
        type: String,
        required: true,
        trim: true
    },
    otp_code: {
        type: String,
        required: true,
        trim: true
    },
    created_at: {
        type: Date,
        default: Date.now,
        expires: 180  // Document will be automatically deleted after 180 seconds (3 minutes)
    },
    verified: {
        type: Boolean,
        default: false
    },
    attempts: {
        type: Number,
        default: 0
    },
    max_attempts: {
        type: Number,
        default: 3
    },
    ip_address: {
        type: String,
        trim: true
    }
}, {
    timestamps: true
});

// Index for automatic cleanup
otpSchema.index({ created_at: 1 }, { expireAfterSeconds: 180 });

const OTP = mongoose.model('OTP', otpSchema);

export default OTP;
