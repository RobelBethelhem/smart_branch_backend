import mongoose from "mongoose";
const Schema = mongoose.Schema;

const dailyCounterSchema = new Schema({
    date: { 
        type: Date, 
        required: true,
        unique: true 
    },
    count: { 
        type: Number, 
        default: 0 
    }
});

// Add a static method for atomic increment
dailyCounterSchema.statics.getNextSequence = async function() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await this.findOneAndUpdate(
        { date: today },
        {
            $inc: { count: 1 },
            $setOnInsert: { date: today }
        },
        {
            new: true,            // Return the updated document
            upsert: true,         // Create if doesn't exist
            runValidators: true
        }
    );

    return result.count;
};

const DailyCounter = mongoose.model('DailyCounter', dailyCounterSchema);
export default DailyCounter;