import jwt from "jsonwebtoken";
import UsedToken from "../../models/rms/UsedToken.js";

const auth = async (req,res,next) =>{

    const token = req.header("x-access-token");
    const accessToken = process.env.ACCESS_TOKEN_PRIVATE_KEY;
    if(!token){
        return res.status(400).json({error: "true", message: "Access Denied: No token provided"});
    }

    // `.exists()` returns a match/null and stops at the first hit (no document
    // hydration); with the new index on `token` this is a point lookup instead
    // of a full-collection scan. Same blacklist semantics and check order.
    const isUsedToken = await UsedToken.exists({token: token});

    if(isUsedToken)
        // return res.redirect('/');
        return res.status(400).json({error: "true", message: "Access Denied: Used token"});
        
    
    try{
       
        const tokenDetails = jwt.verify(token,accessToken);
        req.user = tokenDetails;
        next();
    }
    catch (err){
       // return res.redirect('/');
        res.status(403).json({error:true, message:"Access Denied: Invalid token"});
    }

};

    export default auth;





   // return res.status(403).json({error:true, message:"Access Denied: No token provided"});

// import jwt from "jsonwebtoken";

// const auth = async (req,res,next) =>{
//     const token = req.header("x-access-token");
//     const accessToken = process.env.ACCESS_TOKEN_PRIVATE_KEY;
//     if(!token)
//         return res.status(403).json({error:true, message:"Access Denied: No token provided"});
    
//     try{
//         const tokenDetails = jwt.verify(token,accessToken);
//         req.user = tokenDetails;
//         next();
//     }
//     catch (err){
//         res.status(403).json({error:true, message:"Access Denied: Invalid token"});
//     }
// };

//     export default auth;