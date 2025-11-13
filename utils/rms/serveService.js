import Joi from "joi";

const experiance_letter_BodyValidation = (body) => {
  const schema = Joi.object({
    employee_first_name: Joi.string().required().label("employee_first_name"),
    employee_middle_name: Joi.string().required().label("employee_middle_name"),
    employee_last_name: Joi.string().required().label("employee_last_name"),
    employee_description:Joi.string().label("employee_description"),
    status: Joi.array().items(
      Joi.string().valid("Pending", "Viewed")
    ),
  });
  return schema.validate(body);
};

const letter_of_embassy_BodyValidation = (body) => {
  const schema = Joi.object({
    employee_first_name: Joi.string().required().label("employee_first_name"),
    employee_middle_name: Joi.string().required().label("employee_middle_name"),
    employee_last_name: Joi.string().required().label("employee_last_name"),
    employee_embassy_name: Joi.string().required().label("employee_embassy_name"),
    employee_description:Joi.string().label("employee_description"),
    status: Joi.array().items(
      Joi.string().valid("Pending", "Viewed")
    ),
  });
  return schema.validate(body);
};

const guaranty_letter_BodyValidation = (body) => {
  const schema = Joi.object({
    employee_first_name: Joi.string().required().label("employee_first_name"),
    employee_middle_name: Joi.string().required().label("employee_middle_name"),
    employee_last_name: Joi.string().required().label("employee_last_name"),
    employee_description:Joi.string().label("employee_description"),

    guaranty_first_name: Joi.string().required().label("guaranty_first_name"),
    guaranty_middle_name: Joi.string().required().label("guaranty_middle_name"),
    guaranty_last_name: Joi.string().required().label("guaranty_last_name"),
    guaranty_organazation: Joi.string().required().label("guaranty_organazation"),
    status: Joi.array().items(
      Joi.string().valid("Pending", "Viewed")
    ),
  });
  return schema.validate(body);
};

const supportive_letter_BodyValidation = (body) => {
  const schema = Joi.object({
    employee_first_name: Joi.string().required().label("employee_first_name"),
    employee_middle_name: Joi.string().required().label("employee_middle_name"),
    employee_last_name: Joi.string().required().label("employee_last_name"),
    employee_organazation: Joi.string().required().label("employee_organazation"),
    employee_description:Joi.string().label("employee_description"),
    status: Joi.array().items(
      Joi.string().valid("Pending", "Viewed")
    ),
  });
  return schema.validate(body);
};

export { experiance_letter_BodyValidation, letter_of_embassy_BodyValidation, guaranty_letter_BodyValidation,supportive_letter_BodyValidation};







