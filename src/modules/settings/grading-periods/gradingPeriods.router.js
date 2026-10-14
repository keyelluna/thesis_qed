const express = require("express");
const router = express.Router();

const controller = require("./gradingPeriods.controller");
const verifyToken = require("../../authentication/authentication.middleware");
const requireAdmin = require("../../authentication/requireAdmin.middleware");

router.get("/", verifyToken, controller.getGradingPeriods);
router.post("/", verifyToken, requireAdmin, controller.createGradingPeriod);
router.put("/:id", verifyToken, requireAdmin, controller.updateGradingPeriod);
router.put("/:id/activate", verifyToken, requireAdmin, controller.activateGradingPeriod);
router.delete("/:id", verifyToken, requireAdmin, controller.deleteGradingPeriod);

module.exports = router;
