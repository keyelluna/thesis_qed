const express = require("express");
const router = express.Router();
const subjectsManagement = require("./subjectManagement.controller");

router.get('/getSubjectsByGrade/:gradeLevel', subjectsManagement.getSubjectsByGrade);
router.get('/getSubjectSectionsByGrade/:gradeLevel', subjectsManagement.getSubjectSectionsByGrade);
router.put('/updateSubjectSection/:id', subjectsManagement.updateSubjectSection);
router.put('/assignTeacher/:id', subjectsManagement.assignTeacherToSection);
router.post('/addSubject', subjectsManagement.addSubject);
router.put('/toggleStatus/:id', subjectsManagement.toggleSubjectStatus);
router.post('/', subjectsManagement.createAssessmentType);
router.get("/", subjectsManagement.getAssessmentType);
router.put('/:id', subjectsManagement.updateAssessmentType);
router.delete('/:id', subjectsManagement.deleteAssessmentType);

module.exports = router;