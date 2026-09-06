const express = require("express");
const router = express.Router();
const gradeLevels = require("../../modules/utils/gradeLevels.controller");

//adding new student
router.get("/getGradeLevels", gradeLevels.getGradeLevels);

router.get("/getSectionByGrade", gradeLevels.getSectionByGrade);

module.exports = router;
