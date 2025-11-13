import mongoose from "mongoose";
const Schema = mongoose.Schema;

const price_per_building_Schema =  new Schema({
    building_id:{
        type: Schema.Types.ObjectId,
        required: true
    },
    min_selling_price_per_cube_for_building: {
        type: Number,
        trim: true,
        required: true,
    },
    max_selling_price_per_cube_for_building: {
        type: Number,
        trim: true,
        required: true,
    },
    registered_By: {
        type: String,
        required: true
    },
    Created_At:{
        type: Date,
        default: Date.now(),
    },
    Updated_At:{
        type: Date,
    },

    Updated_By:{
        type: String,
        trim: true
    }

    });

    const Price_Per_Building = mongoose.model("Price_Per_Building",price_per_building_Schema);
    export default Price_Per_Building;

    