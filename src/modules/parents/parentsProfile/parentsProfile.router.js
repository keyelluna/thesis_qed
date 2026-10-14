const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const parentsProfileController = require("./parentsProfile.controller");

//welcome banner
//get user name
const { requireParent } = require('../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get("/", parentsProfileController.getUser);

module.exports = router;
