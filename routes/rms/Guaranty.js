import { Router } from "express";
import auth from "../../middleware/rms/auth.js";
import roleCheck from "../../middleware/rms/roleCheck.js";
import User from "../../models/rms/User.js";
import Guaranty from "../../models/rms/Guaranty_Letter.js";
import Experinace from "../../models/rms/Experiance_Letter.js";
import Embassy from "../../models/rms/Letter_of_Embassy.js";
import Supportive from "../../models/rms/Supportive_Letter.js";
import { guaranty_letter_BodyValidation } from "../../utils/rms/serveService.js";
import {test} from "../../utils/rms/test.js"
import etdate from 'ethiopic-date';
import mongoose from 'mongoose';


const router = Router();

router.post("/register_request_guaranty", auth, roleCheck(["user","admin"]), async (req, res, next) => {
  try {

    const getUser = await req.user;
    const user = await User.findOne({ _id: getUser._id });
    if (!user)
      return res.status(400).json({ error: true, message: "The requester Can not found" });

    const employee_organization_location = req.body.employee_organization_location;
    delete req.body.employee_organization_location;


    const { error } = guaranty_letter_BodyValidation(req.body);
    if (error)
      return res.status(400).json({ error: true, message: error.details[0].message });

    const ethiocal = etdate.now().toString();
    const parts = ethiocal.split(' ');
    const modifiedEthiocal = `${parts[1]} ${parts[2].replace('፣', '')} ቀን ${parts[3]} ዓ.ም`;
    req.body.request_day_amharic = modifiedEthiocal;


    req.body.domain_user = user.user;
    const hrInfo = await test(user.user);
    if (!hrInfo || hrInfo.length === 0) {
      return res.status(400).json({ error: true, message: "Cannot find the User in HRIS System. Please Contact HR Team" });
  }
    const nofExperience = hrInfo.length;
    req.body.salary = hrInfo[nofExperience-1].Salary;
 req.body.employee_organization_location = employee_organization_location;
    await new Guaranty({ ...req.body }).save();
    res.status(201).json({ error: false, message: "Guaranty Request Registered Successfully" });

  }
  catch (e) {
    console.log(e)
    res.status(500).json({ error: true, message: "Internal Server Error" });
  }
});



router.patch("/view_request", auth, roleCheck(["admin"]), async (req, res, next) => {
  try {
    console.log("view_request", req.body);

    const { id, request_type } = req.body;

    if (!id || !request_type) {
      return res.status(400).json({ error: true, message: "Missing id or request_type in the request body" });
    }

    const getUser = await req.user;
    const user = await User.findOne({ _id: getUser._id });
    if (!user) {
      return res.status(400).json({ error: true, message: "The requester cannot be found" });
    }

    console.log("useruseruser", user)

    const ethiocal = etdate.now().toString();
    const parts = ethiocal.split(' ');
    const modifiedEthiocal = `${parts[1]} ${parts[2].replace('፣', '')} ቀን ${parts[3]} ዓ.ም`;

    const updateData = {
      viewed_by: user.user,
      viewed_date: Date.now(),
      status: "Viewed",
      employee_count: 1,
      approved_day_amharic: modifiedEthiocal
    };

    let Model;
    switch (request_type) {
      case 'Supportive':
        Model = Supportive;
        break;
      case 'Experience':
        Model = Experinace;
        break;
      case 'Guranty':
        Model = Guaranty;
        break;
      case 'Embassy':
        Model = Embassy;
        break;
      default:
        return res.status(400).json({ error: true, message: "Invalid request type" });
    }

    const document = await Model.findOne({ _id: id });

    if (!document) {
      return res.status(404).json({ error: true, message: "Document not found" });
    }

    if (document.status === 'Pending') {
      Object.assign(document, updateData);
      await document.save();
      res.status(200).json({ error: false, message: `Viewed ${request_type} Request Successful` });
    } else if (document.status === 'Viewed') {
      res.status(400).json({ error: true, message: `Already Viewed the ${request_type} Request` });
    } else {
      res.status(400).json({ error: true, message: "Error for the request status" });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: true, message: "Internal Server Error" });
  }
});

export default router;