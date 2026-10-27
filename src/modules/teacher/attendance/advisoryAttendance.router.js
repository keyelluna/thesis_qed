const express = require("express");
const router = express.Router();

const controller = require("./advisoryAttendance.controller");
const verifyToken = require("../../authentication/authentication.middleware");

// Must come before "/:classId" or Express will match this path as a classId.
router.get(
  "/advisory-sections",
  verifyToken,
  controller.loadAdvisoryClasses,
  controller.getAdvisorySectionsList,
);

router.get(
  "/:classId",
  verifyToken,
  controller.loadAdvisoryClasses,
  controller.requireOwnedClass,
  controller.getAdvisoryAttendance,
);

router.post(
  "/:classId",
  verifyToken,
  controller.loadAdvisoryClasses,
  controller.requireOwnedClass,
  controller.upsertAdvisoryAttendance,
);

const monthlyReport = require('./monthlyAttendanceReport.controller');
router.get('/:classId/monthly-report', verifyToken, monthlyReport.requireTeacher, monthlyReport.getMonthlyReport);

module.exports = router;
const dropout = require('./dropout.controller');
router.get('/:classId/dropouts', verifyToken, monthlyReport.requireTeacher, dropout.getState);
router.post('/:classId/students/:studentId/dropout', verifyToken, monthlyReport.requireTeacher, dropout.declare);
router.post('/:classId/students/:studentId/dropout/reverse', verifyToken, monthlyReport.requireTeacher, dropout.reverse);

router.post('/:classId/mark-present', verifyToken, monthlyReport.requireTeacher, require('./bulkAttendance.controller').markPresent);
