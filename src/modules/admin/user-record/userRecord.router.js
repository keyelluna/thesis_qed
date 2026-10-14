const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const requireAdmin = require("../../authentication/requireAdmin.middleware");
const { provisionAccount } = require("./provisionAccount.controller");
const userAccount = require("./../user-record/userRecord.controller");

router.post('/addUser', verifyToken, requireAdmin, provisionAccount);
router.put('/editUser/:id', verifyToken, requireAdmin, userAccount.editUser);
router.get("/getUser/:role/:id", verifyToken, requireAdmin, userAccount.getUserById);
router.patch("/deleteUser/:id", verifyToken, requireAdmin, userAccount.softDeleteUser);
router.get('/totalUser', verifyToken, requireAdmin, userAccount.getTotalUser);
router.get('/teacherCount', verifyToken, requireAdmin, userAccount.getTeacherCount);
router.get('/parentCount', verifyToken, requireAdmin, userAccount.getParentCount);
router.get('/usersList', verifyToken, requireAdmin, userAccount.getAllUsers)

module.exports = router;