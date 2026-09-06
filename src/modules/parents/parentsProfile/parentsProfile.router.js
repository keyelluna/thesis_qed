const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const parentsProfileController = require("./parentsProfile.controller");

//welcome banner
//get user name
router.get("/", verifyToken, parentsProfileController.getUser);




module.exports = router;

