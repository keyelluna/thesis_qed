const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const schoolYear = require("./schoolYear.controller");

//get start and end month year
router.get("/", verifyToken, schoolYear.getStartEndTerm);

module.exports = router;

