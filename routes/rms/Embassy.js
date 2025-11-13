import { Router } from "express";
import auth from "../../middleware/rms/auth.js";
import roleCheck from "../../middleware/rms/roleCheck.js";
import User from "../../models/rms/User.js";
import Embassy from "../../models/rms/Letter_of_Embassy.js";
import { letter_of_embassy_BodyValidation } from "../../utils/rms/serveService.js";
import mongoose from 'mongoose';


const router = Router();

router.post("/register_request_embassy", auth, roleCheck(["user","admin"]), async (req, res, next) => {
  try {

    const getUser = await req.user;
    const user = await User.findOne({ _id: getUser._id });
    if (!user)
      return res.status(400).json({ error: true, message: "The requester Can not found" });

    const { error } = letter_of_embassy_BodyValidation(req.body);
    if (error)
      return res.status(400).json({ error: true, message: error.details[0].message });
    req.body.domain_user = user.user;
    await new Embassy({ ...req.body }).save();
    res.status(201).json({ error: false, message: "Embassy  Request Registered Successfully" });

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
  
      const { error } = letter_of_embassy_BodyValidation(req.body);
      if (error)
        return res.status(400).json({ error: true, message: error.details[0].message });


    delete req.body.employee_first_name;
    delete req.body.employee_middle_name;
    delete req.body.employee_last_name;
    delete req.body.employee_description;
    delete req.body.employee_embassy_name;

   
    req.body.viewed_by = user.user;
    req.body.viewed_date = Date.now();
    req.body.status = "Viewed";

    req.body.employee_count = 1;


    await Embassy.findOne({ _id: id })
    .then((embassy) => {
        embassy.viewed_by =  req.body.viewed_by;
        embassy.viewed_date = req.body.viewed_date;
        embassy.status = req.body.status;
        embassy.employee_count = req.body.employee_count;
      return embassy.save();
    })
    .then((updateResult) => {
      if (updateResult) {
        res.status(200).json({ error: false, message: "Viewed Embassy Request Successful" });
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