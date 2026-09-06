const express = require("express");
const router = express.Router();
const classManagement = require("./classManagement.controller");

//add new class
router.post('/addClass', classManagement.createClass);

//get grade levels, sections, and teachers for dropdowns
router.get('/gradeLevels', classManagement.getGradeLevels);
router.get('/sections', classManagement.getSectionsByGrade);
router.get('/teacher', classManagement.getTeachers);
router.get('/teacher/all', classManagement.getAllTeachers);

//update class by id
router.put('/updateClass/:id', classManagement.updateClass);


//get subjects by grade level for dropdown
router.get('/getSubByGrade/:gradeLevel', classManagement.getSubjectsByGrade);

//get all classes
router.get('/', classManagement.getClasses);

//delete class by id (deactivates the class)
router.delete('/:id', classManagement.deleteClass);

module.exports = router;