import { Router } from "express";
import auth from "../../middleware/rms/auth.js";
import roleCheck from "../../middleware/rms/roleCheck.js";
import User from "../../models/rms/User.js";
import Experinace from "../../models/rms/Experiance_Letter.js";
import { experiance_letter_BodyValidation } from "../../utils/rms/serveService.js";

import {test} from "../../utils/rms/test.js"
import mongoose from 'mongoose';


const router = Router();

function formatDate(date) {
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return new Date(date).toLocaleDateString('en-US', options);
}

function formatExperience(hrInfo) {
  return hrInfo.map(job => {
    const fromDate = formatDate(job.From);
    const toDate = job.To ? formatDate(job.To) : 'date';
    const position = job.Postion;

    return {
      period: `From ${fromDate} to ${toDate}`,
      position: position,
      isCurrent: job.To === null
    };
  });
}

router.post("/register_request_experiance", auth, roleCheck(["user","admin"]), async (req, res, next) => {
  try {
    console.log("register_request_experiance", req.body);
    const getUser = await req.user;
    const user = await User.findOne({ _id: getUser._id });
    if (!user)
      return res.status(400).json({ error: true, message: "The requester cannot be found" });

    const { error } = experiance_letter_BodyValidation(req.body);
    if (error)
      return res.status(400).json({ error: true, message: error.details[0].message });

    req.body.domain_user = user.user;

    const hrInfo = await test(user.user);
    if (!hrInfo || hrInfo.length === 0) {
      return res.status(400).json({ error: true, message: "Cannot find the User in HRIS System. Please Contact HR Team" });
    }

    const formattedExperience = formatExperience(hrInfo);
    console.log(JSON.stringify(formattedExperience, null, 2));

    const nofExperience = hrInfo.length;
    req.body.salary = hrInfo[nofExperience - 1].Salary;
    req.body.job_grade = hrInfo[nofExperience - 1].Job_Grade;
    await new Experinace({ ...req.body, experiences: formattedExperience }).save();
    
    res.status(201).json({ error: false, message: "Experience Request Registered Successfully" });

  } catch (e) {
    console.log(e);
    res.status(500).json({ error: true, message: "Internal Server Error" });
  }
});



router.patch("/view_request_experiance", auth, roleCheck(["admin"]), async (req, res, next) => {
    try {

      console.log("view_request_experianceview_request_experianceview_request_experiance", req.body)
        const id = req.body.id;
      const getUser = await req.user;
      const user = await User.findOne({ _id: getUser._id });
      if (!user)
        return res.status(400).json({ error: true, message: "The requester Can not found" });

      delete req.body.id;
  
      const { error } = experiance_letter_BodyValidation(req.body);
      if (error)
        return res.status(400).json({ error: true, message: error.details[0].message });


    delete req.body.employee_first_name;
    delete req.body.employee_middle_name;
    delete req.body.employee_last_name;
    delete req.body.employee_description;

   
    req.body.viewed_by = user.user;
    req.body.viewed_date = Date.now();
    req.body.status = "Viewed";

    req.body.employee_count = 1;


    await Experinace.findOne({ _id: id })
    .then((experiance) => {
        experiance.viewed_by =  req.body.viewed_by;
        experiance.viewed_date = req.body.viewed_date;
        experiance.status = req.body.status;
        experiance.employee_count = req.body.employee_count;
      return experiance.save();
    })
    .then((updateResult) => {
      if (updateResult) {
        res.status(200).json({ error: false, message: "Viewed Experinace Request Successful" });
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
