const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const { getAuditLogs } = require("./auditLogs.controller");

router.get("/", verifyToken, (req, res, next) => {
  if (String(req.user?.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({ success: false, message: "Administrator access is required." });
  }
  return next();
}, getAuditLogs);

module.exports = router;
