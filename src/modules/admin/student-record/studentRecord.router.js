const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const studentRecord = require("./studentRecord.controller");
const requireAdmin = require('../../authentication/requireAdmin.middleware');
const { requireStudentIdentity } = require('./studentRecord.authorization');
const sectionAssignment = require('./sectionAssignment.controller');

router.use(verifyToken, requireStudentIdentity);
router.get('/section-assignments', requireAdmin, sectionAssignment.read);
router.post('/bulk-section-assignment', requireAdmin, sectionAssignment.assign);

router.post("/addNewStudent", requireAdmin, studentRecord.addNewStudent);
router.put("/updateStudent/:id", requireAdmin, studentRecord.updateStudent);
router.get("/viewStudent/:id", studentRecord.getStudentById);
router.get('/totalStudents', studentRecord.getTotalStudents);
router.get('/allStudents', studentRecord.getAllStudents);
router.get('/allGrade', studentRecord.getAllGrade);
router.put("/deleteStudent/:id", requireAdmin, studentRecord.softDeleteStudent);

module.exports = router;
