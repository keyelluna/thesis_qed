const express = require("express");
const router = express.Router();
const subjectsManagement = require("./subjectManagement.controller");

//catalog ng subject names per grade level (for dropdown)
router.get('/getSubjectsByGrade/:gradeLevel', subjectsManagement.getSubjectsByGrade);

//naka-assign na subjects/sections per grade level (for display)
router.get('/getSubjectSectionsByGrade/:gradeLevel', subjectsManagement.getSubjectSectionsByGrade);

//add/assign subjects and teachers to section
// router.post('/addSubjectSection', subjectsManagement.addSubjectSection);

//update
router.put('/updateSubjectSection/:id', subjectsManagement.updateSubjectSection);

//pdate assign teacher to section
router.put('/assignTeacher/:id', subjectsManagement.assignTeacherToSection);

router.post("/addSubject", subjectsManagement.addSubject);

router.put("/toggleStatus/:id", subjectsManagement.toggleSubjectStatus);

module.exports = router;