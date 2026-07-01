import {Router} from "express";
import User from "../../models/rms/User.js";
import bcrypt from "bcrypt";
import {signUpBodyValidation , loginBodyValidation} from "../../utils/rms/validationSchema.js"
import generateTokens from "../../utils/rms/generateTokens.js";
import UsedToken from "../../models/rms/UsedToken.js";
import jwt from "jsonwebtoken";
import Site from "../../models/rms/Site.js";
import mongoose from 'mongoose';
import auth from "../../middleware/rms/auth.js";
import roleCheck from "../../middleware/rms/roleCheck.js";


const router = Router();

//signup

router.post("/verify-token", async(req,res)=>{
    try{
        const token = req.header("x-access-token");
        const accessToken = process.env.ACCESS_TOKEN_PRIVATE_KEY
        if(!token){
            res.status(401).json({error:true, message:"Error finding access token"})
        }
        const isUsedToken = await UsedToken.find({token:token});
        if(isUsedToken.length > 0)
            res.status(401).json({error:true, message:"Used Token"})
        
        jwt.verify(token,accessToken);
      

        res.status(200).json({error: false, message: "Correct"})
    }
    catch (err){
        console.error("Error: ", err);
        res.status(500).json({error:true, message: "Internal Server Error"});
    }
})

router.post("/signUp", auth, roleCheck(["Admin", "Super_Admin"]), async(req,res)=>{
    try{
        delete req.body.id;
        req.body.password = "@Test1234";
        req.body.roles = [req.body.roles]
        const {site_id} = req.body

        if (!mongoose.Types.ObjectId.isValid(site_id)) {
            return res.status(400).json({error: true, message: "Invalid site_id format"});
        }

        const site = await Site.findOne({_id: site_id})

        if(!site)
            return res.status(400).json({error: true, message: "Error finding Site with Given SiteID"})


       





        const {error} = signUpBodyValidation(req.body);
        if(error)
            return res.status(400).json({error:true, message:error.details[0].message});

        delete req.body.site_id;
        req.body.site_id = new mongoose.Types.ObjectId(site_id);
        
        const user = await User.findOne({email: req.body.email});
        if(user)
            return res.status(400).json({error:true, message:"User with given email already exist"});
          
        const salt = await bcrypt.genSalt(Number(process.env.SALT));
        const hashPassword = await bcrypt.hash(req.body.password, salt);

        // await new User(req.body).save();
        await new User({ ...req.body, password: hashPassword}).save();
        
        res.status(201).json({error: false, message:"Account created Sucessfully"});
    }
    catch (e) {
        console.log(e)
        if (e.code === 11000 && e.keyPattern && e.keyPattern.city) {
          return res.status(400).json({ error: true, message: "A Site with this User already exists" });
        }
        if (e.name === 'BSONError' && e.message.includes('input must be a 24 character hex string')) {
          
          return res.status(400).json({ error: true, message: 'Invalid site_id' });
        }
        if (e instanceof mongoose.CastError && e.name === 'CastError') {
          return res.status(400).json({ error: true, message: 'Invalid site_id' });
        } 
        res.status(500).json({ error: true, message: "Internal Server Error" });
      }
});

//login
router.post("/login", async(req,res)=>{
    try{
        const {error} = loginBodyValidation(req.body);
        if(error)
            return res.status(400).json({error: true, message: error.details[0].message})
        const user = await User.findOne({email: req.body.email});
        if(!user)
            return res.status(401).json({error: true, message: "Invalid Email"})

        const verifiedPassword = await bcrypt.compare(
            req.body.password, user.password
        )
        if(!verifiedPassword)
            return res.status(401).json({error: true, message: "Invalid Password"})

        // Soft-deleted users (active:false) cannot log in. Existing accounts have
        // no `active` field (undefined) and are treated as active.
        if(user.active === false)
            return res.status(403).json({error: true, message: "Your account has been deactivated. Please contact your branch management."})

        //generate access and refresh token
        const {accessToken, refreshToken} = await generateTokens(user);
        res.status(200).json({error: false, accessToken, refreshToken, message: "Logged in Successfully"});


    }
    catch(error){
        console.log("Error:", error);
        res.status(500).json({error:true, message: "Internal Server Error"});
    }
})

    


// Escape user-supplied text before using it inside a regex filter.
const escapeUserRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shape a user document into the row the back-office grid expects.
const mapUserRow = (user) => ({
    id: user._id.toString(), // Convert ObjectId to string
    first_name: user.first_name,
    last_name: user.last_name,
    employee_id: user.employee_id,
    user: user.user,
    email: user.email,
    position: user.position,
    department: user.department,
    branch: user.branch,
    roles: user.roles,
    // Undefined (legacy docs) is treated as active.
    active: user.active !== false,
});

// Only the fields the grid renders (keeps the password hash and unused fields off the wire).
const USER_LIST_PROJECTION = { first_name: 1, last_name: 1, employee_id: 1, user: 1, email: 1, position: 1, department: 1, branch: 1, roles: 1, active: 1 };

router.get("/getUsers", auth, roleCheck(["Admin", "Super_Admin", "Branch_Management"]), async(req,res)=>{
    try{
        const sendUsers = {};
        const meta = {};

        const { start, size } = req.query;
        const hasPagination =
            start !== undefined && size !== undefined &&
            !Number.isNaN(Number(start)) && !Number.isNaN(Number(size));

        // Backward-compatible: with no start/size, return the full list exactly
        // as before (the grid filters/sorts/paginates client-side). .lean() +
        // projection only reduce work — the mapped JSON is identical.
        if (!hasPagination) {
            const users = await User.find({}, USER_LIST_PROJECTION).lean();
            sendUsers.data = users.map(mapUserRow);
            meta.totalRowCount = users.length;
            sendUsers.meta = meta;
            return res.json(sendUsers);
        }

        // Opt-in server-side filtering + sorting + pagination (material-react-table
        // "manual" mode). filters/globalFilter/sorting are params the grid already sends.
        let columnFilters = [];
        let sorting = [];
        try { columnFilters = JSON.parse(req.query.filters || '[]'); } catch (_) { columnFilters = []; }
        try { sorting = JSON.parse(req.query.sorting || '[]'); } catch (_) { sorting = []; }
        const globalFilter = (req.query.globalFilter || '').trim();

        const and = [];
        if (Array.isArray(columnFilters)) {
            for (const f of columnFilters) {
                if (f && f.id && f.value !== undefined && f.value !== null && String(f.value).length) {
                    and.push({ [f.id]: { $regex: escapeUserRegex(f.value), $options: 'i' } });
                }
            }
        }
        if (globalFilter) {
            const rx = { $regex: escapeUserRegex(globalFilter), $options: 'i' };
            and.push({ $or: [
                { first_name: rx }, { last_name: rx }, { employee_id: rx },
                { user: rx }, { email: rx }, { position: rx }, { department: rx },
            ] });
        }
        const filter = and.length ? { $and: and } : {};

        const sort = {};
        if (Array.isArray(sorting)) {
            for (const s of sorting) { if (s && s.id) sort[s.id] = s.desc ? -1 : 1; }
        }

        let query = User.find(filter, USER_LIST_PROJECTION).lean();
        if (Object.keys(sort).length) query = query.sort(sort);
        query = query.skip(Number(start)).limit(Number(size));

        const [users, totalRowCount] = await Promise.all([
            query,
            User.countDocuments(filter),
        ]);

        sendUsers.data = users.map(mapUserRow);
        meta.totalRowCount = totalRowCount;
        sendUsers.meta = meta;
        res.json(sendUsers);
    }
    catch (err){
        console.error(err);
        res.status(500).json({error:true, message: "Internal Server Error"});
    }
});


// Create a branch Admin user. Used by Branch_Management (and Super_Admin) to
// onboard branch admins WITHOUT the RMS site_id coupling of /signUp. The role
// is FORCED to 'Admin', so Branch_Management can only ever create Admins.
router.post("/create_admin", auth, roleCheck(["Branch_Management", "Super_Admin"]), async (req, res) => {
    try {
        const { user, email, branch } = req.body;
        if (!user || !email || !branch) {
            return res.status(400).json({ error: true, message: "user, email and branch are required" });
        }
        const existing = await User.findOne({ email });
        if (existing) {
            return res.status(400).json({ error: true, message: "User with given email already exists" });
        }
        const salt = await bcrypt.genSalt(Number(process.env.SALT));
        const hashPassword = await bcrypt.hash("@Test1234", salt);
        const newUser = await new User({
            user,
            email,
            branch: String(branch),
            roles: ["Admin"],   // forced — Branch_Management can only create Admins
            password: hashPassword,
        }).save();
        res.status(201).json({
            error: false,
            message: "Admin user created successfully",
            data: {
                id: newUser._id.toString(),
                user: newUser.user,
                email: newUser.email,
                branch: newUser.branch,
                roles: newUser.roles,
            },
        });
    } catch (e) {
        console.error("[CREATE_ADMIN] Error:", e.message);
        if (e.code === 11000) {
            return res.status(400).json({ error: true, message: "A user with this email already exists" });
        }
        res.status(500).json({ error: true, message: "Internal Server Error" });
    }
});

// Distinct branch codes — feeds the Branch_Management "Branches Record" dropdown.
router.get("/branches", auth, roleCheck(["Branch_Management", "Admin", "Super_Admin"]), async (req, res) => {
    try {
        const branches = (await User.distinct("branch"))
            .filter((b) => b !== null && b !== undefined && String(b).trim() !== "")
            .map((b) => String(b))
            .sort();
        res.status(200).json({ error: false, data: branches });
    } catch (e) {
        console.error("[BRANCHES] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not load branches" });
    }
});

// editing the user. Only the fields actually sent are updated (partial update),
// so existing callers that send {id, email, roles} keep working, while
// Branch_Management can also update {user, branch}.
router.patch("/editUser", auth, roleCheck(["Admin", "Super_Admin", "Branch_Management"]), async(req,res)=>{
    try{
        const {id, name, user, email, branch, roles, active} = req.body;

        const updatedData = {};
        if (user !== undefined) updatedData.user = user;
        if (name !== undefined) updatedData.name = name;       // legacy field (not in schema) — harmless
        if (email !== undefined) updatedData.email = email;
        if (branch !== undefined) updatedData.branch = String(branch);
        if (roles !== undefined) updatedData.roles = Array.isArray(roles) ? roles : [roles];
        if (active !== undefined) updatedData.active = active;

        const updatedUser = await User.findByIdAndUpdate(id, updatedData, {
            new: true
        })

        res.status(200).json({error: false, message: "User Edited Successfully", data:updatedUser });
        //res.json(updatedUser);
    }
    catch (error){
        console.error("Error: ", error);
        res.status(500).json({error: true, message: "Internal Server Error"});
    }
})

// Soft-delete: Branch_Management (and admins) deactivate a user instead of
// hard-deleting. A deactivated user (active:false) is blocked at /login and can
// be reactivated the same way.
router.patch("/set_user_active", auth, roleCheck(["Admin", "Super_Admin", "Branch_Management"]), async(req,res)=>{
    try{
        const {id, active} = req.body;
        if (!id || typeof active !== "boolean") {
            return res.status(400).json({error: true, message: "id and a boolean `active` are required"});
        }
        const updated = await User.findByIdAndUpdate(id, { active }, { new: true });
        if (!updated) return res.status(404).json({error: true, message: "User not found"});
        res.status(200).json({
            error: false,
            message: active ? "User activated" : "User deactivated",
            data: { id: updated._id.toString(), active: updated.active },
        });
    }
    catch (error){
        console.error("[SET_USER_ACTIVE] Error: ", error.message);
        res.status(500).json({error: true, message: "Internal Server Error"});
    }
})



router.delete("/deleteUser", auth, roleCheck(["Admin", "Super_Admin"]), async(req,res)=>{
    try{
        const userId = req.body.id;
        const deletedUser = await User.findByIdAndDelete(userId)
        res.json({message: "User Deleted Successfuly", user: deletedUser})

    }
    catch (error){
        console.error("Error: ", error);
        res.status(500)
    }
})












router.get("/:id", async(req,res)=>{
    try{
        const userId = req.params.id;
        const user = await User.findById(userId);
        res.json(user)

    }
    catch (err){
        console.error(err);
        res.status(500).json({error: true, message: "Internal Server Error"});
    }
})



// router.delete("/:id", async(req,res)=>{
//     try{
//         console.log("In delete routekkkk")
//         const userId = req.params.id;
//         const deletedUser = await User.findByIdAndDelete(userId)
//         res.json({message: "User Deleted Successfuly", user: deletedUser})

//     }
//     catch (error){
//         console.error("Error: ", error);
//         res.status(500)
//     }
// })





// router.post("/login", async(req,res)=>{
//     try{
//         console.log("qqqqqqqqqqqqqqqqqqqqqqqq")
//         const {error} = loginBodyValidation(req.body);
//         console.log("error",error)
//         if(error)
//             return res.status(400).json({error:true, message:error.details[0].message});
        
//         const user = await User.findOne({email: req.body.email});
//         if(!user)
//             return res.status(401).json({error:true, message: "Invalid email"});

//         const verifiedPassword = await bcrypt.compare(
//             req.body.password,
//             user.password
//         );

//         if(!verifiedPassword)
//             return res.status(401).json({error:true, message: "Inavlid password"});
          
//         //generate access and refresh token  
//         const {accessToken, refreshToken} = await generateTokens(user);

//         res.status(200).json({  error: false, accessToken, refreshToken, message: "Logged in Successfully" });


//     }
//     catch (err){
//         console.log(err);
//         res.status(500).json({error:true, message: "Internal Server Error"});
//     }
// });




export default router;

