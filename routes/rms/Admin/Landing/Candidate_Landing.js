import { Router, request } from "express";
import auth from "../../../../middleware/rms/auth.js";
import roleCheck from "../../../../middleware/rms/roleCheck.js";

import Candidate from "../../../../models/rms/Candidate.js"
import User from "../../../../models/rms/User.js"

import Experinace from "../../../../models/rms/Experiance_Letter.js";
import Supportive from "../../../../models/rms/Supportive_Letter.js";
import Guaranty from "../../../../models/rms/Guaranty_Letter.js";
import Embassy from "../../../../models/rms/Letter_of_Embassy.js";

const router = Router();

router.get('/get_candidate', auth, roleCheck(["admin", "user"]), async(req,res,next)=>{
 
    const getUser = await req.user;
    const id = getUser._id;
    const specific_user = await User.findOne({ _id: id });
    const user = { ...specific_user._doc };
    delete user._id;
    delete user.__v;
    delete user.password;


    var template = {
        id: '',
        employee_first_name: '',
        employee_middle_name: '',
        employee_last_name: '',
        domain_user: '',
        employee_description: '',
        request_type: '',
        status: '',
        viewed_by: '',
        TimeStamp: '',
        viewed_date: '',
      
       
      }

      var dataa = await Candidate.find();

console.log("useruseruser",user.roles[0])
var experiance;
var supportive;
var guaranty;
var embassy;

        if(user.roles[0] === 'user'){
           experiance = await Experinace.find({domain_user: user.user});
           supportive = await Supportive.find({domain_user: user.user});
           guaranty = await Guaranty.find({domain_user: user.user});
           embassy = await Embassy.find({domain_user: user.user});
        }
        else if(user.roles[0] === 'admin'){
           experiance = await Experinace.find();
           supportive = await Supportive.find();
           guaranty = await Guaranty.find();
           embassy = await Embassy.find();
        }
      

      let mergedArray = experiance.concat(supportive, guaranty, embassy);

      var newObj = mergedArray.map(item => {
        var { _id, __v, ...rest } = item._doc;
        const hasScriptProperty = Object.values(rest).some(propValue => typeof propValue === 'string' && (propValue.includes('script') || propValue.includes('iframe') || propValue.includes('<') || propValue.includes('>') || propValue.includes('alert')));
        if (!hasScriptProperty) {
          return { ...template, id: _id.toString(), ...rest };
        }
        return null;
      }).filter(Boolean); 

     
      const sendUsers = {};
      const meta = {};
      sendUsers.data = newObj;
      meta.totalRowCount = dataa.length;
      sendUsers.meta = meta;

      res.json(sendUsers);

})

router.get('/get_candidate_by_department', auth, roleCheck(["user","admin"]), async(req,res,next) =>{

  console.log("I am in the get_candidate")
    
    const getUser = await req.user;
    const id = getUser._id;
    const specific_user = await User.findOne({ _id: id });
    const user = { ...specific_user._doc };
    delete user._id;
    delete user.__v;
    delete user.password;


    var template = {
        id: '',
        first_name: '',
        last_name: '',
        employee_id: '',
      }
      var newObj = [];
      if(!user.status){
        var dataa = await Candidate.find({department: user.department, });

         
       newObj = dataa.map(item => {
        var { _id, __v, ...rest } = item._doc;
        const hasScriptProperty = Object.values(rest).some(propValue => typeof propValue === 'string' && (propValue.includes('script') || propValue.includes('iframe') || propValue.includes('<') || propValue.includes('>') || propValue.includes('alert')));
        if (!hasScriptProperty) {
          return { ...template, id: _id.toString(), ...rest };
        }
        return null;
      }).filter(Boolean); 

     
      const sendUsers = {};
      const meta = {};
      sendUsers.data = newObj;
      meta.totalRowCount = dataa.length;
      sendUsers.meta = meta;
      }
     


      res.json(newObj);

})


export default router;
