const express = require("express");
const router = express.Router();

const { getAdvisoryRoster } = require("./advisory.controller");
const verifyToken = require("../../authentication/optionalAuth.middleware");

router.get("/roster", verifyToken, getAdvisoryRoster);

module.exports = router;
