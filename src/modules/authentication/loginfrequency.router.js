const express = require("express");
const router = express.Router();
const loginFrequencyController = require("./loginfrequency.controller");
const verifyToken = require("./authentication.middleware");

router.get("/login-frequency", verifyToken, loginFrequencyController.getLoginFrequency);

module.exports = router;