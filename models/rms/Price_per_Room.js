import mongoose from "mongoose";
const Schema = mongoose.Schema;

const price_per_room_Schema =  new Schema({
    room_id:{
        type: Schema.Types.ObjectId,
        required: true
    },
    price_per_cube: {
        type: Number,
        trim: true,
        required: true,
    },
    selling_price: {
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

    const Price_Per_Room = mongoose.model("Price_Per_Room",price_per_room_Schema);
    export default Price_Per_Room;

    