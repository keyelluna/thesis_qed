const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const termPerformanceController = require("./termPerformance.controller");


router.get('/:studentId/term-performance', verifyToken, termPerformanceController.verifyStudentAccess);
router.get('/:studentId/term-performance', verifyToken, termPerformanceController.getTermPerformance);



module.exports = router;