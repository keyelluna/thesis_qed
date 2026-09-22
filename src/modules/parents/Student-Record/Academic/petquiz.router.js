const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const petStateController = require("./petstate.controller");
const petQuizController = require("./petquiz.controller");

router.get("/petState/:studentId", verifyToken, petStateController.getPetState);
router.get(
  "/intervention/:studentId/:topicId",
  verifyToken,
  petQuizController.getInterventionState,
);
router.get("/quiz/:studentId/:topicId", verifyToken, petQuizController.getQuiz);
router.post(
  "/quiz/:studentId/:topicId/grade-single",
  verifyToken,
  petQuizController.gradeSingleAnswer,
);
router.post(
  "/quiz/:studentId/:topicId/submit",
  verifyToken,
  petQuizController.submitQuiz,
);
router.post(
  "/mastery/:studentId/:topicId",
  verifyToken,
  petQuizController.markTopicMastered,
);

router.get(
  "/bonus/:studentId/:topicId",
  verifyToken,
  petQuizController.getBonusGames,
);
router.post(
  "/bonus/:studentId/:topicId/complete",
  verifyToken,
  petQuizController.completeBonusGame,
);

module.exports = router;
