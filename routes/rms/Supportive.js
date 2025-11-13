import { Router } from "express";
import auth from "../../middleware/rms/auth.js";
import roleCheck from "../../middleware/rms/roleCheck.js";
import User from "../../models/rms/User.js";
import Supportive from "../../models/rms/Supportive_Letter.js";
import { supportive_letter_BodyValidation } from "../../utils/rms/serveService.js";
import {test} from "../../utils/rms/test.js"
import etdate from 'ethiopic-date';
import mongoose from 'mongoose';


const router = Router();

router.post("/register_request_supportive", auth, roleCheck(["user","admin"]), async (req, res, next) => {
  try {

    console.log("req.body", req.body)

    const getUser = await req.user;
    const user = await User.findOne({ _id: getUser._id });
    if (!user)
      return res.status(400).json({ error: true, message: "The requester Can not found" });

    const employee_organization_location = req.body.employee_organization_location;
    delete req.body.employee_organization_location;

    const { error } = supportive_letter_BodyValidation(req.body);
    if (error)
      return res.status(400).json({ error: true, message: error.details[0].message });

    const ethiocal = etdate.now().toString();
    const parts = ethiocal.split(' ');
    const modifiedEthiocal = `${parts[1]} ${parts[2].replace('፣', '')} ቀን ${parts[3]} ዓ.ም`;
    req.body.request_day_amharic = modifiedEthiocal;



    req.body.domain_user = user.user;
    const hrInfo = await test(user.user);
    console.log("hrInfohrInfohrInfohrInfohrInfohrInfohrInfo", hrInfo)
    if (!hrInfo || hrInfo.length === 0) {
      return res.status(400).json({ error: true, message: "Cannot find the User in HRIS System. Please Contact HR Team" });
  }
    const nofExperience = hrInfo.length;
    req.body.salary = hrInfo[nofExperience-1].Salary;
    req.body.employee_organization_location = employee_organization_location;
    await new Supportive({ ...req.body }).save();
    res.status(201).json({ error: false, message: "Supportive  Request Registered Successfully" });

  }
  catch (e) {
    console.log(e)
    res.status(500).json({ error: true, message: "Internal Server Error" });
  }
});



router.patch("/view_request_experiance", auth, roleCheck(["admin"]), async (req, res, next) => {
    try {
        const id = req.body.id;
      const getUser = await req.user;
      const user = await User.findOne({ _id: getUser._id });
      if (!user)
        return res.status(400).json({ error: true, message: "The requester Can not found" });

      delete req.body.id;
  
      const { error } = supportive_letter_BodyValidation(req.body);
      if (error)
        return res.status(400).json({ error: true, message: error.details[0].message });


    delete req.body.employee_first_name;
    delete req.body.employee_middle_name;
    delete req.body.employee_last_name;
    delete req.body.employee_description;
    delete req.body.employee_organazation;

   
    req.body.viewed_by = user.user;
    req.body.viewed_date = Date.now();
    req.body.status = "Viewed";

    req.body.employee_count = 1;


    await Supportive.findOne({ _id: id })
    .then((supportive) => {
        supportive.viewed_by =  req.body.viewed_by;
        supportive.viewed_date = req.body.viewed_date;
        supportive.status = req.body.status;
        supportive.employee_count = req.body.employee_count;
      return supportive.save();
    })
    .then((updateResult) => {
      if (updateResult) {
        res.status(200).json({ error: false, message: "Viewed Supportive Request Successful" });
      } else {
        res.status(404).json({ error: true, message: "Document not found" });
      }
    })
    .catch((error) => {
      console.error("Error finding/updating document:", error);
      res.status(500).json({ error: true, message: "An error occurred" });
    });



    
  
    }
    catch (e) {
      console.log(e)
      res.status(500).json({ error: true, message: "Internal Server Error" });
    }
  });

export default router;