const express = require("express");
const router = express.Router();
const academicYear = require("./academicYear.controller");

router.get('/getAcademicYear', academicYear.getActiveAcademicYear);

router.put('/updateAcademicYear/:id', academicYear.updateAcademicYear);

router.get('/getTerms/:id', academicYear.getTermsForSchoolYear);

router.put('/saveTerms/:id', academicYear.saveTermsForSchoolYear);

module.exports = router;