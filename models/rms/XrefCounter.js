import mongoose from "mongoose";
import crypto from "crypto";
const Schema = mongoose.Schema;

/**
 * XrefCounter Model
 * Generates auto-incrementing 16-digit XREF (external reference) for transactions
 * Format: 8-digit sequential + 8-digit random hex (e.g., 00000001A7F9C2B3)
 * The random component prevents enumeration/prediction of reference numbers
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

// Static method for atomic increment with random component
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

    // 8-digit sequential + 8-digit random hex = 16 chars total
    const seq = String(result.count).padStart(8, '0');
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return seq + random;
};

// Get current count without incrementing
xrefCounterSchema.statics.getCurrentCount = async function() {
    const counter = await this.findOne({ name: 'xref_counter' });
    return counter ? counter.count : 0;
};

const XrefCounter = mongoose.model('XrefCounter', xrefCounterSchema);
export default XrefCounter;
