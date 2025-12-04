import mongoose from "mongoose";
const Schema = mongoose.Schema;

/**
 * XrefCounter Model
 * Generates auto-incrementing 16-digit XREF (external reference) for transactions
 * XREF starts from 1 and increments globally (not reset daily)
 * Format: 16-digit zero-padded number (e.g., 0000000000000001)
 */
const xrefCounterSchema = new Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        default: 'xref_counter'
    },
    count: {
        type: Number,
        default: 0
    },
    last_updated: {
        type: Date,
        default: Date.now
    }
});

// Static method for atomic increment
xrefCounterSchema.statics.getNextXref = async function() {
    const result = await this.findOneAndUpdate(
        { name: 'xref_counter' },
        {
            $inc: { count: 1 },
            $set: { last_updated: new Date() },
            $setOnInsert: { name: 'xref_counter' }
        },
        {
            new: true,
            upsert: true,
            runValidators: true
        }
    );

    // Return 16-digit zero-padded string
    return String(result.count).padStart(16, '0');
};

// Get current count without incrementing
xrefCounterSchema.statics.getCurrentCount = async function() {
    const counter = await this.findOne({ name: 'xref_counter' });
    return counter ? counter.count : 0;
};

const XrefCounter = mongoose.model('XrefCounter', xrefCounterSchema);
export default XrefCounter;
