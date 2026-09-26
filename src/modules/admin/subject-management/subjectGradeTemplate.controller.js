const fs = require("fs");
const path = require("path");
const connection = require("../../../../config/db");
const { parseGradeTemplate } = require("./services/gradeTemplateParser.service");
const gradeCache = require("../../shared/grades/gradeCache.service");

const UPLOAD_DIR = path.join(__dirname, "../../../../uploads/grade-templates");

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

async function refreshSubjectGradeCache(subjectId) {
  const [sections] = await connection.query(
    `SELECT id FROM \`subject-section\` WHERE subject_id = ?`,
    [subjectId],
  );
  for (const section of sections) {
    const [periods] = await connection.query(
      `SELECT DISTINCT grading_period_id AS gradingPeriodId FROM grade_items
        WHERE subject_section_id = ? AND grading_period_id IS NOT NULL`,
      [section.id],
    );
    for (const period of periods) {
      await gradeCache.recalcAllStudentsForSubject(section.id, period.gradingPeriodId);
    }
  }
}

exports.uploadGradeTemplate = async (req, res) => {
  const { subjectId } = req.params;
  const uploadedBy = req.user?.userId;

  if (!subjectId || isNaN(Number(subjectId))) {
    return res.status(400).json({ success: false, message: "Valid subjectId is required." });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded." });
  }
  if (!uploadedBy) {
    return res.status(401).json({ success: false, message: "Uploader could not be identified." });
  }

  let parsed;
  try {
    parsed = parseGradeTemplate(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const conn = await connection.getConnection();

  try {
    await conn.beginTransaction();

    const [subjectRows] = await conn.query(
      `SELECT id FROM elem_subjects WHERE id = ? LIMIT 1`,
      [subjectId]
    );
    if (subjectRows.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ success: false, message: "Subject not found." });
    }

    await conn.query(
      `UPDATE subject_grade_templates SET is_active = 0 WHERE subject_id = ? AND is_active = 1`,
      [subjectId]
    );

    ensureUploadDir();
    const safeFileName = `${subjectId}-${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = path.join(UPLOAD_DIR, safeFileName);
    fs.writeFileSync(filePath, req.file.buffer);

    const [result] = await conn.query(
      `INSERT INTO subject_grade_templates
        (subject_id, file_name, file_path,
         ww_weight_percent, pt_weight_percent, exam_weight_percent,
         exam_st1_subweight_percent, exam_st2_subweight_percent, exam_te_subweight_percent,
         structure_json, uploaded_by, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        subjectId,
        req.file.originalname,
        filePath,
        parsed.wwWeightPercent,
        parsed.ptWeightPercent,
        parsed.examWeightPercent,
        parsed.examSt1SubweightPercent,
        parsed.examSt2SubweightPercent,
        parsed.examTeSubweightPercent,
        JSON.stringify(parsed.structure),
        uploadedBy,
      ]
    );

    await conn.commit();
    conn.release();

    try {
      await refreshSubjectGradeCache(Number(subjectId));
    } catch (cacheError) {
      console.error("Grade template saved, but existing grade caches could not be refreshed:", cacheError);
    }

    return res.status(201).json({
      success: true,
      message: "Grade template uploaded and set as active.",
      data: {
        id: result.insertId,
        subjectId: Number(subjectId),
        fileName: req.file.originalname,
        ...parsed,
      },
    });
  } catch (error) {
    await conn.rollback();
    conn.release();
    console.error("Database Error:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "This subject already has an active template. Please retry.",
      });
    }
    return res.status(500).json({ success: false, message: "Database error occurred." });
  }
};

// Looked up by elem_subjects.id directly. Used by admin-side code
// (EditSubjectModal.tsx), which already has the real subject_id in hand.
exports.getActiveGradeTemplate = async (req, res) => {
  const { subjectId } = req.params;

  try {
    const [rows] = await connection.query(
      `SELECT id, subject_id, file_name,
              ww_weight_percent AS wwWeightPercent,
              pt_weight_percent AS ptWeightPercent,
              exam_weight_percent AS examWeightPercent,
              exam_st1_subweight_percent AS examSt1SubweightPercent,
              exam_st2_subweight_percent AS examSt2SubweightPercent,
              exam_te_subweight_percent AS examTeSubweightPercent,
              uploaded_at AS uploadedAt, structure_json AS structureJson
         FROM subject_grade_templates
        WHERE subject_id = ? AND is_active = 1
        LIMIT 1`,
      [subjectId]
    );

    const row = rows[0] ?? null;
    if (row?.structureJson) {
      try { row.structure = typeof row.structureJson === "string" ? JSON.parse(row.structureJson) : row.structureJson; }
      catch { row.structure = null; }
      delete row.structureJson;
    }
    return res.status(200).json({ success: true, data: row });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({ success: false, message: "Database error occurred." });
  }
};

// Looked up by `subject-section`.id instead. subject_grade_templates is
// keyed on subject_id, NOT subject_section_id — those are different ID
// ranges in this schema (confirmed against the actual dump: e.g.
// subject-section.id=19 has subject_id=2, subject-section.id=21 has
// subject_id=4). Teacher-side pages only have the subject-section id
// (the route param they call subjectId is really a subjectSectionId), so
// this route does the join server-side instead of asking the frontend
// to know or guess the mapping.
exports.getActiveGradeTemplateBySection = async (req, res) => {
  const { subjectSectionId } = req.params;

  if (!subjectSectionId || isNaN(Number(subjectSectionId))) {
    return res.status(400).json({ success: false, message: "Valid subjectSectionId is required." });
  }

  try {
    const [rows] = await connection.query(
      `SELECT t.id, t.subject_id, t.file_name,
              t.ww_weight_percent AS wwWeightPercent,
              t.pt_weight_percent AS ptWeightPercent,
              t.exam_weight_percent AS examWeightPercent,
              t.exam_st1_subweight_percent AS examSt1SubweightPercent,
              t.exam_st2_subweight_percent AS examSt2SubweightPercent,
              t.exam_te_subweight_percent AS examTeSubweightPercent,
              t.uploaded_at AS uploadedAt, t.structure_json AS structureJson
         FROM \`subject-section\` ss
         JOIN subject_grade_templates t
           ON t.subject_id = ss.subject_id AND t.is_active = 1
        WHERE ss.id = ?
        LIMIT 1`,
      [subjectSectionId]
    );

    const row = rows[0] ?? null;
    if (row?.structureJson) {
      try { row.structure = typeof row.structureJson === "string" ? JSON.parse(row.structureJson) : row.structureJson; }
      catch { row.structure = null; }
      delete row.structureJson;
    }
    return res.status(200).json({ success: true, data: row });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({ success: false, message: "Database error occurred." });
  }
};

// Single source of truth for "what weights apply to this subject-section
// right now". Resolves subject-section.id -> subject_id, then checks an
// active uploaded template first (subject_grade_templates), and falls
// back to the admin's manually-entered subject_weight_distribution rows
// if no template is active. Returns null if neither exists, so the
// caller can fall back to its own default/pooled behavior.
exports.getEffectiveWeights = async (req, res) => {
  const { subjectSectionId } = req.params;

  if (!subjectSectionId || isNaN(Number(subjectSectionId))) {
    return res.status(400).json({ success: false, message: "Valid subjectSectionId is required." });
  }

  try {
    const [sectionRows] = await connection.query(
      `SELECT subject_id FROM \`subject-section\` WHERE id = ? LIMIT 1`,
      [subjectSectionId]
    );
    if (sectionRows.length === 0) {
      return res.status(404).json({ success: false, message: "Subject section not found." });
    }
    const subjectId = sectionRows[0].subject_id;

    // 1) Active uploaded template takes precedence.
    const [templateRows] = await connection.query(
      `SELECT ww_weight_percent AS ww, pt_weight_percent AS pt, exam_weight_percent AS exam,
              exam_st1_subweight_percent AS st1, exam_st2_subweight_percent AS st2,
              exam_te_subweight_percent AS te, structure_json AS structureJson, file_path AS filePath
         FROM subject_grade_templates
        WHERE subject_id = ? AND is_active = 1
        LIMIT 1`,
      [subjectId]
    );
    if (templateRows.length > 0) {
      const t = templateRows[0];
      let templateStructure = null;
      try {
        templateStructure = t.structureJson
          ? (typeof t.structureJson === "string" ? JSON.parse(t.structureJson) : t.structureJson)
          : null;
        // Backfill older uploads from the stored workbook. Earlier parser
        // versions saved weights but omitted score-column positions/layout,
        // which made the teacher table shrink to the number of created
        // assessment items and its totals appear under the wrong columns.
        const hasColumnLayout = (group) =>
          Array.isArray(group?.domains) && group.domains.every((domain) => Array.isArray(domain.scoreColumns));
        const needsWorkbookRefresh = !templateStructure
          || !templateStructure.layout
          || !templateStructure.layout.examWeightedScoreColumn
          || !hasColumnLayout(templateStructure.ww)
          || !hasColumnLayout(templateStructure.pt);
        if (needsWorkbookRefresh && t.filePath && fs.existsSync(t.filePath)) {
          templateStructure = parseGradeTemplate(fs.readFileSync(t.filePath)).structure;
          await connection.query(
            `UPDATE subject_grade_templates SET structure_json = ? WHERE subject_id = ? AND is_active = 1`,
            [JSON.stringify(templateStructure), subjectId],
          );
          await refreshSubjectGradeCache(Number(subjectId));
        }
      } catch (parseError) {
        console.error("Could not restore stored grade template structure:", parseError);
      }
      return res.status(200).json({
        success: true,
        data: {
          source: "template",
          ww: Number(t.ww),
          pt: Number(t.pt),
          exam: Number(t.exam),
          examSubWeights: { st1: Number(t.st1), st2: Number(t.st2), te: Number(t.te) },
          templateStructure,
        },
      });
    }

    // 2) Fall back to admin's manually-entered weights. Assessment type IDs
    // are database-generated, so identify the standard categories by their
    // labels rather than assuming they will always be IDs 1, 2, and 3.
    const [weightRows] = await connection.query(
      `SELECT swd.assessment_type_id, swd.weight_percent, at.assessment_name
         FROM subject_weight_distribution swd
         JOIN assessment_type at ON at.id = swd.assessment_type_id
        WHERE swd.subject_id = ?`,
      [subjectId]
    );
    if (weightRows.length > 0) {
      const byType = {};
      const categoryForName = (name) => {
        const key = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (["writtenoralworkswws", "writtenoralworksww", "writtenworks", "writtenoralworks"].includes(key)) return "ww";
        if (["productperformancetaskspts", "productperformancetaskspt", "performancetasks", "performancetask"].includes(key)) return "pt";
        if (["examinationsexs", "examinationsex", "examinations", "exams", "quarterlyexam"].includes(key)) return "exam";
        return null;
      };
      weightRows.forEach((row) => {
        const category = categoryForName(row.assessment_name);
        if (category) byType[category] = Number(row.weight_percent);
      });
      if ([byType.ww, byType.pt, byType.exam].some((value) => !Number.isFinite(value))) {
        return res.status(200).json({ success: true, data: null });
      }
      return res.status(200).json({
        success: true,
        data: {
          source: "manual",
          ww: byType.ww,
          pt: byType.pt,
          exam: byType.exam,
          // No sub-weight breakdown exists for manually-entered weights —
          // only an uploaded template carries ST1/ST2/TE splits. Absence
          // here is exactly what triggers the pooled-exam fallback.
          examSubWeights: undefined,
        },
      });
    }

    // 3) Nothing configured at all for this subject.
    return res.status(200).json({ success: true, data: null });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({ success: false, message: "Database error occurred." });
  }
};

exports.downloadActiveGradeTemplateBySection = async (req, res) => {
  const { subjectSectionId } = req.params;
  if (!subjectSectionId || isNaN(Number(subjectSectionId))) {
    return res.status(400).json({ success: false, message: "Valid subjectSectionId is required." });
  }
  try {
    const [rows] = await connection.query(
      `SELECT t.file_path AS filePath, t.file_name AS fileName
         FROM \`subject-section\` ss
         JOIN subject_grade_templates t ON t.subject_id = ss.subject_id AND t.is_active = 1
        WHERE ss.id = ? LIMIT 1`,
      [subjectSectionId],
    );
    if (!rows.length || !fs.existsSync(rows[0].filePath)) {
      return res.status(404).json({ success: false, message: "The active grade template file is unavailable." });
    }
    return res.download(rows[0].filePath, rows[0].fileName);
  } catch (error) {
    console.error("Grade template download error:", error);
    return res.status(500).json({ success: false, message: "Could not download the active grade template." });
  }
};
