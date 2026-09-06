const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const linkedChildrenController = require("./linkedChildren.controller");

//search student
router.post("/", linkedChildrenController.getChildren);

//verified
router.post("/confirm",verifyToken, linkedChildrenController.linkedChildren);

//get enrolled children
router.get("/", verifyToken, linkedChildrenController.getEnrolledChildren);



module.exports = router;

