const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const gradesheetController = require("./gradesheet.controller");
function requirePrincipal(req, res, next) {
  if (!["principal", "admin"].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: "Role not permitted." });
  }
  return next();
}

router.get("/section-grade", verifyToken, requirePrincipal, gradesheetController.getSectionGrade);
router.get("/", verifyToken, requirePrincipal, gradesheetController.getPrincipalSectionGradebook);
router.get("/grading-period", verifyToken, requirePrincipal, gradesheetController.getGradingPeriods);

const { handleApproval } = require('./gradeApproval.controller');
function principalOnly(req, res, next) {
  if (String(req.user?.role).toLowerCase() !== 'principal' || !req.user?.userId) {
    return res.status(403).json({ message: 'Principal access is required.' });
  }
  next();
}
router.get('/approvals', verifyToken, principalOnly, handleApproval);
router.post('/approvals', verifyToken, principalOnly, handleApproval);

module.exports = router;
