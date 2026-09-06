const express = require("express");
const router = express.Router();
const userAccount = require("./../user-record/userRecord.controller");

//adding new user
router.post('/addUser', userAccount.createUser);

//edit user
router.put('/editUser/:id', userAccount.editUser);

//display user by student by Id
router.get("/getUser/:role/:id", userAccount.getUserById);

//soft deleting user
router.patch("/deleteUser/:id", userAccount.softDeleteUser);


//display number of user
router.get('/totalUser', userAccount.getTotalUser);

//display number of teachers
router.get('/teacherCount', userAccount.getTeacherCount);
//display number of parents
router.get('/parentCount', userAccount.getParentCount);





//display al user
router.get('/usersList', userAccount.getAllUsers)

module.exports = router;