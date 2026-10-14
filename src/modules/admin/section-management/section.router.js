const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const requireAdmin = require('../../authentication/requireAdmin.middleware');
const sectionManagement = require("./section.controller");

router.get('/getGradeLevel', verifyToken, sectionManagement.getGrade);
router.post('/addSection', verifyToken, requireAdmin, sectionManagement.createSection);
router.get('/getSections/:gradeLevel', verifyToken, sectionManagement.getSectionsByGradeLevel);
router.get('/getTeachers', verifyToken, sectionManagement.getTeachers); 
router.put('/updateSection/:id', verifyToken, requireAdmin, sectionManagement.updateSection);
router.put('/deactivateSection/:id', verifyToken, requireAdmin, sectionManagement.deactivateSection);
router.delete('/deleteSection/:id', verifyToken, requireAdmin, sectionManagement.deleteSection);
router.get("/sectionIdsUsedByClasses", verifyToken, sectionManagement.getSectionIdsUsedByClasses);

module.exports = router;
