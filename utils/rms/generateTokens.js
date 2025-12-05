import jwt from "jsonwebtoken";
import UserToken from "../../models/rms/UserToken.js";

const generateTokens = async (user) =>{
    try{
        // Include till_id, branch, flex_id, and user name in JWT for till operations
        const payload = {
            _id: user._id,
            roles: user.roles,
            till_id: user.till_id,
            branch: user.branch,
            flex_id: user.flex_id,
            user: user.user  // user name
        };
        const accessToken = jwt.sign(
            payload,
            process.env.ACCESS_TOKEN_PRIVATE_KEY,
            {expiresIn: '15m'}
        );

        const refreshToken = jwt.sign(
            payload,
            process.env.REFRESH_TOKEN_PRIVATE_KEY,
            {expiresIn: '30d'}
        );

        const userToken = await UserToken.findOne({userId: user._id});
        if(userToken) await UserToken.deleteOne({userId: user._id});

        await new UserToken({userId: user.id, token: refreshToken}).save();
        return Promise.resolve({accessToken, refreshToken});

    }
    catch (error){
        return Promise.reject(err);
    }
}

export default generateTokens;