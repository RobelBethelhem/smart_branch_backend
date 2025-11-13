import Joi from "joi";
import passwordComplexity from "joi-password-complexity";


const signUpBodyValidation = (body) =>{
    const schema = Joi.object({
        domain_user: Joi.string().required().label("domain_user"),
        branch: Joi.string().required().label("branch"),
        email: Joi.string().email().required().label("email"),
        password: passwordComplexity().required().label("password"),
        roles: Joi.array().items(
            Joi.string().valid("Teller","CSR","Admin", "Authorizer", "Auditor", "Branch_Management")
          ),
    });
    return schema.validate(body); 
};

const loginBodyValidation = (body) =>{
    const schema = Joi.object({
        email: Joi.string().email().required().label("email"),
        password: Joi.string().required().label("password"),
    });
    return schema.validate(body);
}

const refreshTokenBodyValidation = (body) =>{
    const schema = Joi.object({
        refreshToken: Joi.string().required().label("Refresh Token")
    });
    return schema.validate(body);
}






export {signUpBodyValidation, loginBodyValidation, refreshTokenBodyValidation};
//export {signUpBodyValidation, loginBodyValidation, refreshTokenBodyValidation, newfxrequestValidation};