const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const { getAuditLogs, deleteAuditLog } = require("./auditLogs.controller");

function requireAdmin(req, res, next) {
  if (String(req.user?.role || "").toLowerCase() !== "admin") {
    return res.status(403).json({ success: false, message: "Administrator access is required." });
  }
  return next();
}

router.get('/', verifyToken, requireAdmin, getAuditLogs);
router.delete('/:id', verifyToken, requireAdmin, deleteAuditLog);

module.exports = router;
