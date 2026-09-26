const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const academicYear = require("./academicYear.controller");

router.get('/getAcademicYear', verifyToken, academicYear.getActiveAcademicYear);
router.put('/updateAcademicYear/:id', verifyToken, academicYear.updateAcademicYear);
router.get('/getTerms/:id', verifyToken, academicYear.getTermsForSchoolYear);
router.put('/saveTerms/:id', verifyToken, academicYear.saveTermsForSchoolYear);

module.exports = router;