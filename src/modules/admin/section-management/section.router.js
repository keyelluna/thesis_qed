const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const sectionManagement = require("./section.controller");

router.get('/getGradeLevel', verifyToken, sectionManagement.getGrade);
router.post('/addSection', verifyToken, sectionManagement.createSection);
router.get('/getSections/:gradeLevel', verifyToken, sectionManagement.getSectionsByGradeLevel);
router.get('/getTeachers', verifyToken, sectionManagement.getTeachers); 
router.put('/updateSection/:id', verifyToken, sectionManagement.updateSection);
router.put('/deactivateSection/:id', verifyToken, sectionManagement.deactivateSection);
router.delete('/deleteSection/:id', verifyToken, sectionManagement.deleteSection);
router.get("/sectionIdsUsedByClasses", verifyToken, sectionManagement.getSectionIdsUsedByClasses);

module.exports = router;
