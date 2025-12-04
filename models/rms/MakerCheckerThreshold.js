import mongoose from "mongoose";
const Schema = mongoose.Schema;

/**
 * MakerCheckerThreshold Model
 * Stores the threshold amount for maker-checker approval
 * Transactions >= this amount require checker approval
 */
const makerCheckerThresholdSchema = new Schema({
    threshold_amount: {
        type: Number,
        required: true,
        min: 0,
    },
    currency: {
        type: String,
        default: 'ETB',
        enum: ['ETB', 'USD', 'EUR', 'GBP'],
    },
    is_active: {
        type: Boolean,
        default: true,
    },
    description: {
        type: String,
        default: 'Transactions greater than or equal to this amount require checker approval',
        trim: true,
    },
    created_by: {
        type: String,
        trim: true,
    },
    created_by_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    updated_by: {
        type: String,
        trim: true,
    },
    updated_by_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    created_at: {
        type: Date,
        default: Date.now,
    },
    updated_at: {
        type: Date,
        default: Date.now,
    },
});

// Update the updated_at field before saving
makerCheckerThresholdSchema.pre('save', function(next) {
    this.updated_at = new Date();
    next();
});

const MakerCheckerThreshold = mongoose.models.MakerCheckerThreshold ||
    mongoose.model('MakerCheckerThreshold', makerCheckerThresholdSchema);

export default MakerCheckerThreshold;
