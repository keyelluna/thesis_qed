const express = require("express");
const router = express.Router();
const multer = require("multer");
const gradeTemplate = require("./subjectGradeTemplate.controller");
const verifyToken = require("../../authentication/authentication.middleware");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith(".xlsx");
    cb(ok ? null : new Error("Only .xlsx files are accepted."), ok);
  },
});

router.post(
  '/uploadGradeTemplate/:subjectId',
  verifyToken,
  upload.single('template'),
  gradeTemplate.uploadGradeTemplate
);

// Admin-side lookup: caller already has the real subject_id.
router.get('/getActiveGradeTemplate/:subjectId', gradeTemplate.getActiveGradeTemplate);

// Teacher-side lookup: caller only has the subject-section id; this
// route resolves subject_id internally via the join in the controller.
router.get('/getActiveGradeTemplateBySection/:subjectSectionId', gradeTemplate.getActiveGradeTemplateBySection);
router.get('/downloadActiveGradeTemplateBySection/:subjectSectionId', verifyToken, gradeTemplate.downloadActiveGradeTemplateBySection);
// Combined lookup: resolves template-vs-manual precedence server-side so
// the frontend only ever needs one call and one source of truth.
router.get('/getEffectiveWeights/:subjectSectionId', gradeTemplate.getEffectiveWeights);

module.exports = router;
