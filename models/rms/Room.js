import mongoose from "mongoose";
const Schema = mongoose.Schema;

const roomSchema =  new Schema({
    Room_name: { 
        type: String,
        required: true,
        trim: true,
    },
    sqrt: {
        type: Number,
        required: true,
        trim: true,
    },
    room_description: {
        type: String,
        trim: true,
        required: true,
    },
    room_status: {
        type: String,
        enum: ["Sold", "Available", "Completed"],
        default: "Available"
    },
    floor_id:{
        type: Schema.Types.ObjectId,
        required: true
    },
    site_id: {
        type: Schema.Types.ObjectId,
       
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

    const Room = mongoose.model("Room",roomSchema);
    export default Room;

    