const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const studentProfilesController = require("./studentProfiles.controller");
const requireAdmin = require('../../../authentication/requireAdmin.middleware');
const { requireStudentIdentity } = require('../../../admin/student-record/studentRecord.authorization');

router.get(
  "/:studentId",
  verifyToken,
  requireStudentIdentity,
  studentProfilesController.getStudentProfile,
);
router.put(
  "/:studentId",
  verifyToken,
  requireStudentIdentity,
  requireAdmin,
  studentProfilesController.updateStudentProfile,
);

module.exports = router;
