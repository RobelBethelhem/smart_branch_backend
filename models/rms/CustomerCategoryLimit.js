import mongoose from "mongoose";
const Schema = mongoose.Schema;

/**
 * CustomerCategoryLimit Model
 * Stores daily transaction limits per customer category
 * Customer categories are fetched from Flexcube STTM_CUSTOMER table
 */
const customerCategoryLimitSchema = new Schema({
    customer_category: {
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    daily_limit: {
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

// Index on customer_category already created by unique: true in schema definition
customerCategoryLimitSchema.index({ is_active: 1 });

// Update the updated_at field before saving
customerCategoryLimitSchema.pre('save', function(next) {
    this.updated_at = new Date();
    next();
});

const CustomerCategoryLimit = mongoose.models.CustomerCategoryLimit ||
    mongoose.model('CustomerCategoryLimit', customerCategoryLimitSchema);

export default CustomerCategoryLimit;
