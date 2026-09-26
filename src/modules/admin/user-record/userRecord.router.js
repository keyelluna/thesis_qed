const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const userAccount = require("./../user-record/userRecord.controller");

router.post('/addUser', verifyToken, userAccount.createUser);
router.put('/editUser/:id', verifyToken, userAccount.editUser);
router.get("/getUser/:role/:id", verifyToken, userAccount.getUserById);
router.patch("/deleteUser/:id", verifyToken, userAccount.softDeleteUser);
router.get('/totalUser', verifyToken, userAccount.getTotalUser);
router.get('/teacherCount', verifyToken, userAccount.getTeacherCount);
router.get('/parentCount', verifyToken, userAccount.getParentCount);
router.get('/usersList', verifyToken, userAccount.getAllUsers)

module.exports = router;