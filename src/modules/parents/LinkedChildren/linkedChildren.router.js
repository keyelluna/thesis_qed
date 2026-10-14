const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const linkedChildrenController = require("./linkedChildren.controller");

//search student
const { requireParent } = require('../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.post("/", linkedChildrenController.getChildren);

//verified
router.post("/confirm", linkedChildrenController.linkedChildren);

//get enrolled children
router.get("/", linkedChildrenController.getEnrolledChildren);

module.exports = router;
