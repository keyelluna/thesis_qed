const express = require("express");
const router = express.Router();

const controller = require("./gradingPeriods.controller");
const verifyToken = require("../../authentication/authentication.middleware");

router.get("/", verifyToken, controller.getGradingPeriods);
router.post("/", verifyToken, controller.createGradingPeriod);
router.put("/:id", verifyToken, controller.updateGradingPeriod);
router.put("/:id/activate", verifyToken, controller.activateGradingPeriod);
router.delete("/:id", verifyToken, controller.deleteGradingPeriod);

module.exports = router;