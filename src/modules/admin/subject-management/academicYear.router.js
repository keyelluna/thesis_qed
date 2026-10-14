const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const requireAdmin = require('../../authentication/requireAdmin.middleware');
const academicYear = require("./academicYear.controller");

router.get('/getAcademicYear', verifyToken, academicYear.getActiveAcademicYear);
router.post('/addAcademicYear', verifyToken, requireAdmin, academicYear.addAcademicYear);
router.get('/getAllSy', verifyToken, academicYear.getAllSchoolYears);
router.get('/getTerms/:id', verifyToken, academicYear.getTermsForSchoolYear);
router.put('/saveTerms/:id', verifyToken, requireAdmin, academicYear.saveTermsForSchoolYear);

module.exports = router;
