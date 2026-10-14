const express = require("express");
const router = express.Router();
const loginFrequencyController = require("./loginfrequency.controller");
const verifyToken = require("./authentication.middleware");

router.get(
  "/login-frequency",
  verifyToken,
  (req, res, next) => {
    const role = typeof req.user?.role === "string" ? req.user.role.toUpperCase() : "";
    if (role !== "ADMIN") {
      return res.status(403).json({ success: false, message: "Administrator access is required." });
    }
    return next();
  },
  loginFrequencyController.getLoginFrequency,
);

module.exports = router;
