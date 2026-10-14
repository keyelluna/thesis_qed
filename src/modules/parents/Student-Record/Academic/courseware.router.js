const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const coursewareController = require("./courseware.controller");

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/:studentId/:topicId",
  coursewareController.getCourseware,
);

module.exports = router;
