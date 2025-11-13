
import mongoose from "mongoose";


const installment_KPISchema = new mongoose.Schema({
    target_amount: { 
        type: Number,
        required: true,
    },
    achieved_amount: {
        type: Number,
       
    },
    KPI_start_date: {
        type: Date,
        required: true,
    },
    KPI_end_date: {
        type: Date,
        required: true,
    },
    KPI_percentage: {
        type: Number,
    },
    registered_By: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    updated_By: { type: String, trim: true }
});


const site_manager_KPISchema = new mongoose.Schema({
    site_manager_id: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true 
    },
    over_all_target_amount: { 
        type: Number,
      
    },
    over_all_achieved_amount: {
        type: Number,
       
    },
    over_all_KPI_percentage: {
        type: Number,
    },
    KPI_installments: [installment_KPISchema],
    registered_By: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    updated_By: { type: String, trim: true }
});

const Site_Manager_KPI = mongoose.model("Site_Manager_KPI", site_manager_KPISchema);

export { Site_Manager_KPI };