const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const classManagement = require("./classManagement.controller");

//add new class
router.post('/addClass', verifyToken, classManagement.createClass);

//get grade levels, sections, and teachers for dropdowns
router.get('/gradeLevels', verifyToken, classManagement.getGradeLevels);
router.get('/sections', verifyToken, classManagement.getSectionsByGrade);
router.get('/teacher', verifyToken, classManagement.getTeachers);
router.get('/teacher/all', verifyToken, classManagement.getAllTeachers);

//update class by id
router.put('/updateClass/:id', verifyToken, classManagement.updateClass);


//get subjects by grade level for dropdown
router.get('/getSubByGrade/:gradeLevel', verifyToken, classManagement.getSubjectsByGrade);

//get all classes
router.get('/', verifyToken, classManagement.getClasses);

//delete class by id (deactivates the class)
router.delete('/:id', verifyToken, classManagement.deleteClass);

module.exports = router;