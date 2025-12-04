import express from "express";
import { config } from "dotenv";
config(); // Load env variables first

import dbConnect from "./dbConnect.js";
import { initializeOracle } from "./lib/db.js";
import authRoutes from "./routes/rms/auth.js";
import refreshTokenRoutes from "./routes/rms/refreshToken.js";
import userRoutes from "./routes/rms/users.js";
import { fileURLToPath } from 'url';
import { HfInference } from "@huggingface/inference";
import { dirname } from 'path';
import ollama from 'ollama'

import rmsAdminPlace from "./routes/rms/Admin/Place.js";
import rmsAdminSite from "./routes/rms/Admin/Site.js";
import rmsAdminBuilding from "./routes/rms/Admin/Building.js";
import rmsAdminFloor from "./routes/rms/Admin/Floor.js";
import rmsAdminRoom from "./routes/rms/Admin/Room.js";
import rmsAdminSet_Price_Per_Place from "./routes/rms/Admin/Price_Per_Place.js";
import rmsAdminSet_Price_Per_Site from "./routes/rms/Admin/Price_Per_Site.js";
import rmsAdminSet_Price_Per_Building from "./routes/rms/Admin/Price_Per_Building.js";
import rmsAdminSet_Price_Per_Floor from "./routes/rms/Admin/Price_Per_Floor.js";
import rmsAdminSet_Price_Per_Room from "./routes/rms/Admin/Price_Per_Room.js";
import rmsAdminCustomer from "./routes/rms/Admin/Customer.js";
import rmsAdminAggrement from "./routes/rms/Admin/Aggrement.js";
import rmsAdminSite_Manager_KPI from "./routes/rms/Admin/Site_Manager_KPI.js"

import Candidate from "./routes/rms/Candidate.js";

import Vote from "./routes/rms/Vote.js"
import Experinace from "./routes/rms/Experiance.js";
import Embassy from "./routes/rms/Embassy.js";
import Supportive from "./routes/rms/Supportive.js";
import Guaranty from "./routes/rms/Guaranty.js";
import ZSmartBrannchRequests from "./routes/rms/ZSmartBrannchRequests.js";
import LimitManagement from "./routes/rms/LimitManagement.js";




import rmsAdminLandingPlace from "./routes/rms/Admin/Landing/place_landing.js";
import rmsAdminLandingSite from "./routes/rms/Admin/Landing/site_landing.js";
import rmsAdminLandingBuilding from "./routes/rms/Admin/Landing/building_landing.js";
import rmsAdminLandingFloor from "./routes/rms/Admin/Landing/floor_landing.js";
import rmsAdminLandingRoom from "./routes/rms/Admin/Landing/room_landing.js";
import rmsAdminLandingPrice_Per_Place from "./routes/rms/Admin/Landing/price_per_place_landing.js";
import rmsAdminLandingPrice_Per_Site from "./routes/rms/Admin/Landing/price_per_site_landing.js";
import rmsAdminLandingPrice_Per_Building from "./routes/rms/Admin/Landing/price_per_building_landing.js";
import rmsAdminLandingPrice_Per_Floor from "./routes/rms/Admin/Landing/price_per_floor_landing.js";
import rmsAdminLandingPrice_Per_Room from "./routes/rms/Admin/Landing/price_per_room_landing.js";
import rmsAdminLandingCustomer from "./routes/rms/Admin/Landing/customer_landing.js";
import rmsAdminLandingAggerement from "./routes/rms/Admin/Landing/aggerement_landing.js";
import rmsAdminLandingAggerementDetail from "./routes/rms/Admin/Landing/aggerement_detail_landing.js";
import rmsAdminLandingSite_Manager_KPI from "./routes/rms/Admin/Landing/site_manager_kip_landing.js"
import rmsAdminLandingSite_Manager_KPI_Installement from "./routes/rms/Admin/Landing/detail_site_manager_kpi_installement.js";


import vote_stastics from "./routes/rms/Admin/Landing/vote_statistics.js";
import Candidate_Landing from "./routes/rms/Admin/Landing/Candidate_Landing.js"
import bodyParser from 'body-parser';
import crypto from 'crypto'


// import branchManagementRoutes from "./routes/newRequest/branchManagement.js";
// import fundManagementRoutes from "./routes/newRequest/fundManagement.js";
// import cardProductionRoutes from "./routes/newRequest/cardProduction.js";

import cors from "cors"



const app = express();
app.use(cors())


// const corsOptions = {
//   origin: 'https://l9vrnplr-3000.uks1.devtunnels.ms',
//   optionsSuccessStatus: 200
// };

// app.use(cors(corsOptions));



app.use(express.urlencoded({ extended: true }));

app.use(express.json({
  verify: (req, res, buf) => {
    if (buf && buf.length) {
      try {
        JSON.parse(buf);
      } catch (error) {
        res.status(400).json({ message: 'Invalid JSON format' });
      }
    }
  },
}));

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = dirname(currentFilePath);
const publicDirectory = `${currentDirectory}\\uploads`;
app.use(express.static(publicDirectory));




dbConnect();
initializeOracle(); // Initialize Oracle client and connection pool

app.use(express.json()); // Parse incoming requests data

// Configure body-parser limits


// app.use(express.json({limit: '200mb'}));
// app.use(express.urlencoded({limit: '200mb', extended: true}));



app.use("/api/", authRoutes);
app.use("/api/refreshToken", refreshTokenRoutes);
app.use("/api/users", userRoutes);


app.use("/api/rms/admin/place", rmsAdminPlace);
app.use("/api/rms/admin/site", rmsAdminSite);
app.use("/api/rms/admin/building", rmsAdminBuilding);
app.use("/api/rms/admin/floor", rmsAdminFloor);
app.use("/api/rms/admin/room", rmsAdminRoom);
app.use("/api/rms/admin", [
   rmsAdminSet_Price_Per_Place,
   rmsAdminSet_Price_Per_Site,
   rmsAdminSet_Price_Per_Building,
   rmsAdminSet_Price_Per_Floor,
   rmsAdminSet_Price_Per_Room,
   rmsAdminCustomer,
   rmsAdminAggrement,
   rmsAdminSite_Manager_KPI
  ]);


  app.use("/api/zemen_vote_candidate",Vote);
  app.use("/api/candidates",Candidate);


  app.use("/api/experiance", Experinace);
  app.use("/api/guaranty", Guaranty);
  app.use("/api/supportive", Supportive);
  app.use("/api/embassy", Embassy);
  app.use("/api/zsmart_branch_requests", ZSmartBrannchRequests);
  app.use("/api/limit-management", LimitManagement);






app.use("/api/rms/admin/landing", 
  [
    rmsAdminLandingPlace,
    rmsAdminLandingSite,
    rmsAdminLandingBuilding,
    rmsAdminLandingFloor,
    rmsAdminLandingRoom, 
    rmsAdminLandingPrice_Per_Place,
    rmsAdminLandingPrice_Per_Site,
    rmsAdminLandingPrice_Per_Building,
    rmsAdminLandingPrice_Per_Floor,
    rmsAdminLandingPrice_Per_Room,
    rmsAdminLandingCustomer,
    rmsAdminLandingAggerement,
    rmsAdminLandingAggerementDetail,
    rmsAdminLandingSite_Manager_KPI,
    rmsAdminLandingSite_Manager_KPI_Installement,
    vote_stastics,
    Candidate_Landing
  ]);
//app.use("/api/rms/admin/landing", );







const port = process.env.PORT || 8081;

app.listen(port, () => console.log(`Listening on Port ${port}...`));






