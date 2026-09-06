const express = require("express");
const router = express.Router();

const controller = require("./subjectGrading.controller");
const topicController = require("./topicTagging.controller");
const verifyToken = require("../../authentication/authentication.middleware");

router.get("/:subjectSectionId", verifyToken, controller.loadSubjectSection, controller.getSubjectSectionInfo);

router.get("/:subjectSectionId/attendance", verifyToken, controller.loadSubjectSection, controller.getAttendance);
router.put("/:subjectSectionId/attendance", verifyToken, controller.loadSubjectSection, controller.upsertAttendance);

router.get("/:subjectSectionId/items", verifyToken, controller.loadSubjectSection, controller.getItems);
router.post("/:subjectSectionId/items", verifyToken, controller.loadSubjectSection, controller.addItem);
router.put("/:subjectSectionId/items/:itemId", verifyToken, controller.loadSubjectSection, controller.updateItem);
router.delete("/:subjectSectionId/items/:itemId", verifyToken, controller.loadSubjectSection, controller.deleteItem);

router.get("/:subjectSectionId/scores", verifyToken, controller.loadSubjectSection, controller.getScores);
router.put("/:subjectSectionId/scores", verifyToken, controller.loadSubjectSection, controller.upsertScore);

router.get("/:subjectSectionId/holistic", verifyToken, controller.loadSubjectSection, controller.getHolistic);
router.put("/:subjectSectionId/holistic", verifyToken, controller.loadSubjectSection, controller.upsertHolistic);


router.get("/:subjectSectionId/topics", verifyToken, controller.loadSubjectSection, topicController.getTopics);
router.post("/:subjectSectionId/topics", verifyToken, controller.loadSubjectSection, topicController.createTopic);

router.get(
  "/:subjectSectionId/topics/:topicId/mastery",
  verifyToken,
  controller.loadSubjectSection,
  topicController.getTopicMastery
);

router.get(
  "/:subjectSectionId/topics/:topicId/students/:studentId/progress",
  verifyToken,
  controller.loadSubjectSection,
  topicController.getStudentTopicProgress
);

router.get("/:subjectSectionId/interventions", verifyToken, controller.loadSubjectSection, topicController.getInterventions);
router.post("/:subjectSectionId/interventions", verifyToken, controller.loadSubjectSection, topicController.createIntervention);
router.put(
  "/:subjectSectionId/interventions/:interventionId",
  verifyToken,
  controller.loadSubjectSection,
  topicController.updateInterventionStatus
);

module.exports = router;