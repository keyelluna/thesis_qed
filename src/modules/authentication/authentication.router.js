const express = require("express");
const router = express.Router();
const authentication = require("./authentication.controller");
const verifyToken = require("./authentication.middleware")

//saving authentication
router.post('/register', authentication.register)

//login user
router.post('/login', authentication.login);

//logout user
router.post('/logout', authentication.logout);
// router.get('/admin/dashboard', verifyToken, requireRole('admin'), adminController.dashboard);
// router.get('/teacher/class', verifyToken, requireRole('teacher', 'principal', 'admin'), teacherController.getClass);

//change password
router.put("/change-password", verifyToken, authentication.changePassword);

//forgot password
router.post("/forgot-password", authentication.forgotPassword);
//verify otp
router.post("/verify-otp", authentication.verifyOtp);
// reset passwod
router.post("/reset-password", authentication.resetPassword);


router.get('/me', verifyToken, authentication.me);
module.exports = router;