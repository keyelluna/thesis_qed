const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const petStateController = require("./petstate.controller");
const petQuizController = require("./petquiz.controller");

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get("/petState/:studentId", petStateController.getPetState);
router.get(
  "/intervention/:studentId/:topicId",
  petQuizController.getInterventionState,
);
router.get("/quiz/:studentId/:topicId", petQuizController.getQuiz);
router.post(
  "/quiz/:studentId/:topicId/grade-single",
  petQuizController.gradeSingleAnswer,
);
router.post(
  "/quiz/:studentId/:topicId/submit",
  petQuizController.submitQuiz,
);
router.post(
  "/mastery/:studentId/:topicId",
  petQuizController.markTopicMastered,
);

router.get(
  "/bonus/:studentId/:topicId",
  petQuizController.getBonusGames,
);
router.post(
  "/bonus/:studentId/:topicId/complete",
  petQuizController.completeBonusGame,
);

module.exports = router;
