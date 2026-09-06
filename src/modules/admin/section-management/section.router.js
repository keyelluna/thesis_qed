const express = require("express");
const router = express.Router();
const sectionManagement = require("./section.controller");


//get grade
router.get('/getGradeLevel', sectionManagement.getGrade);

// //Add section
router.post('/addSection', sectionManagement.createSection);

//get sections
router.get('/getSections/:gradeLevel', sectionManagement.getSectionsByGradeLevel);

//get teachers
router.get('/getTeachers', sectionManagement.getTeachers); 

//update section
router.put('/updateSection/:id', sectionManagement.updateSection);

//deactivate section
router.put('/deactivateSection/:id', sectionManagement.deactivateSection);

router.delete('/deleteSection/:id', sectionManagement.deleteSection);

router.get("/sectionIdsUsedByClasses", sectionManagement.getSectionIdsUsedByClasses);


module.exports = router;
