const express = require("express");
const router = express.Router();
const studentRecord = require("./studentRecord.controller");

//adding new student
router.post("/addNewStudent", studentRecord.addNewStudent);

//update student
router.put("/updateStudent/:id", studentRecord.updateStudent);

//display student by studentt by Id
router.get("/viewStudent/:id", studentRecord.getStudentById);

//get student's total number
router.get('/totalStudents', studentRecord.getTotalStudents);

//get all students
router.get('/allStudents', studentRecord.getAllStudents);

//get filter student
router.get('/allGrade', studentRecord.getAllGrade);

//soft delete student
router.put("/deleteStudent/:id", studentRecord.softDeleteStudent);

module.exports = router;
