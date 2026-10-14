const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const schoolYear = require("./schoolYear.controller");

//get start and end month year
const { requireParent } = require('../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get("/", schoolYear.getStartEndTerm);

module.exports = router;

