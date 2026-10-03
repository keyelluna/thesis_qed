const express = require("express");
const router = express.Router();
const profileController = require("./profile.controller");
const verifyToken = require("../../authentication/authentication.middleware");

router.get("/", verifyToken, profileController.getMyProfile);

module.exports = router;