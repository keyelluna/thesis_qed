const express = require("express");
const router = express.Router();
const subjectsManagement = require("./subjectManagement.controller");
const verifyToken = require('../../authentication/authentication.middleware');
const requireAdmin = require('../../authentication/requireAdmin.middleware');

router.get('/getSubjectsByGrade/:gradeLevel', verifyToken, subjectsManagement.getSubjectsByGrade);
router.get('/getSubjectSectionsByGrade/:gradeLevel', verifyToken, subjectsManagement.getSubjectSectionsByGrade);
router.put('/updateSubjectSection/:id', verifyToken, requireAdmin, subjectsManagement.updateSubjectSection);
router.put('/assignTeacher/:id', verifyToken, requireAdmin, subjectsManagement.assignTeacherToSection);
router.post('/addSubject', verifyToken, requireAdmin, subjectsManagement.addSubject);
router.put('/toggleStatus/:id', verifyToken, requireAdmin, subjectsManagement.toggleSubjectStatus);
router.post('/', verifyToken, requireAdmin, subjectsManagement.createAssessmentType);
router.get("/", verifyToken, subjectsManagement.getAssessmentType);
router.put('/:id', verifyToken, requireAdmin, subjectsManagement.updateAssessmentType);
router.delete('/:id', verifyToken, requireAdmin, subjectsManagement.deleteAssessmentType);

module.exports = router;
