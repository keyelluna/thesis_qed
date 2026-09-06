const express = require("express");
const router = express.Router();
const schoolYear = require("./schoolYear.controller");

//get start and end month year
router.get("/", schoolYear.getStartEndTerm);

module.exports = router;

