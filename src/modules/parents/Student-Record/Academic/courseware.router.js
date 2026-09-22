const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const coursewareController = require("./courseware.controller");

router.get(
  "/:studentId/:topicId",
  verifyToken,
  coursewareController.getCourseware,
);

module.exports = router;
