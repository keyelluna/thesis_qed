const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const connection = require("../../../../config/db");
const { parseGradeTemplate } = require("./services/gradeTemplateParser.service");
const { createGradeTemplateWorkbookMap } = require("./services/gradeTemplateWorkbookMap.service");
const { patchOfficialWorkbook } = require("./services/gradeTemplateOoxml.service");
const gradeCache = require("../../shared/grades/gradeCache.service");
const { resolveGradeTemplateForPeriod } = require("../../shared/grades/gradeTemplateResolution.service");
const { assertMappedCapacity } = require("./services/gradeTemplateCapacity.service");
const { assessmentCategoryForName } = require("../../shared/grades/assessmentCategory.service");

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
  let exportMap;
  try {
    parsed = parseGradeTemplate(req.file.buffer);
    exportMap = createGradeTemplateWorkbookMap(req.file.buffer);
    parsed.structure.termConfigurations = Object.fromEntries(exportMap.terms.map((term) => [String(term.termNumber), {
      ...term.config,
      transmutationTable: parsed.structure.transmutationTable,
      descriptorTable: parsed.structure.descriptorTable,
    }]));
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  const conn = await connection.getConnection();
  let persistedFilePath = null;

  try {
    await conn.beginTransaction();

    const [subjectRows] = await conn.query(
      `SELECT id FROM elem_subjects WHERE id = ? LIMIT 1 FOR UPDATE`,
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
    const safeFileName = `${subjectId}-${Date.now()}-${crypto.randomUUID()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = path.join(UPLOAD_DIR, safeFileName);
    fs.writeFileSync(filePath, req.file.buffer);
    persistedFilePath = filePath;

    const [result] = await conn.query(
      `INSERT INTO subject_grade_templates
        (subject_id, file_name, file_path, checksum_sha256,
         ww_weight_percent, pt_weight_percent, exam_weight_percent,
         exam_st1_subweight_percent, exam_st2_subweight_percent, exam_te_subweight_percent,
         structure_json, export_map_json, uploaded_by, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        subjectId,
        req.file.originalname,
        filePath,
        crypto.createHash("sha256").update(req.file.buffer).digest("hex"),
        parsed.wwWeightPercent,
        parsed.ptWeightPercent,
        parsed.examWeightPercent,
        parsed.examSt1SubweightPercent,
        parsed.examSt2SubweightPercent,
        parsed.examTeSubweightPercent,
        JSON.stringify(parsed.structure),
        JSON.stringify(exportMap),
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
    try { await conn.rollback(); } catch { /* transaction may already be closed */ }
    conn.release();
    if (persistedFilePath) {
      try {
        const [storedRows] = await connection.query(
          `SELECT id FROM subject_grade_templates WHERE file_path = ? LIMIT 1`,
          [persistedFilePath],
        );
        if (!storedRows.length && fs.existsSync(persistedFilePath)) fs.unlinkSync(persistedFilePath);
      } catch (cleanupError) {
        console.error("Could not verify failed-upload workbook cleanup:", cleanupError.message);
      }
    }
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
  const { gradingPeriodId } = req.query;

  if (!subjectSectionId || isNaN(Number(subjectSectionId))) {
    return res.status(400).json({ success: false, message: "Valid subjectSectionId is required." });
  }

  try {
    let termNumber = null;
    let resolved;
    if (gradingPeriodId) {
      resolved = await resolveGradeTemplateForPeriod(subjectSectionId, gradingPeriodId, {
        pinIfEmpty: true,
        assignmentSource: "first_assessment",
      });
      termNumber = Number(resolved.termNumber);
    } else {
      const [sectionRows] = await connection.query(`SELECT subject_id AS subjectId FROM \`subject-section\` WHERE id = ? LIMIT 1`, [subjectSectionId]);
      if (!sectionRows.length) return res.status(404).json({ success: false, message: "Subject section not found." });
      const [templateRows] = await connection.query(
        `SELECT ww_weight_percent AS ww, pt_weight_percent AS pt, exam_weight_percent AS exam,
                exam_st1_subweight_percent AS st1, exam_st2_subweight_percent AS st2, exam_te_subweight_percent AS te,
                structure_json AS structureJson, file_path AS filePath, id AS templateId,
                checksum_sha256 AS checksum, export_map_json AS exportMapJson
           FROM subject_grade_templates WHERE subject_id = ? AND is_active = 1 LIMIT 1`,
        [sectionRows[0].subjectId],
      );
      resolved = { subjectId: sectionRows[0].subjectId, template: templateRows[0] ? {
        ...templateRows[0], structure: typeof templateRows[0].structureJson === "string" ? JSON.parse(templateRows[0].structureJson) : templateRows[0].structureJson,
      } : null };
    }

    const subjectId = resolved.subjectId;
    let templateRows = resolved.template ? [{
      ww: resolved.template.ww ?? resolved.template.structure.ww?.weightPercent,
      pt: resolved.template.pt ?? resolved.template.structure.pt?.weightPercent,
      exam: resolved.template.exam ?? resolved.template.structure.examWeightPercent ?? 0,
      st1: resolved.template.st1,
      st2: resolved.template.st2,
      te: resolved.template.te,
      structureJson: resolved.template.structure,
      filePath: resolved.template.filePath,
      templateId: resolved.template.templateId,
      checksum: resolved.template.checksum,
      exportMapJson: resolved.template.exportMapJson,
    }] : [];
    if (templateRows.length > 0) {
      const t = templateRows[0];
      let templateStructure = null;
      try {
        templateStructure = t.structureJson
          ? (typeof t.structureJson === "string" ? JSON.parse(t.structureJson) : t.structureJson)
          : null;
        const storedMap = t.exportMapJson
          ? (typeof t.exportMapJson === "string" ? JSON.parse(t.exportMapJson) : t.exportMapJson)
          : null;
        // Backfill older uploads from the stored workbook. Earlier parser
        // versions saved weights but omitted score-column positions/layout,
        // which made the teacher table shrink to the number of created
        // assessment items and its totals appear under the wrong columns.
        const hasColumnLayout = (group) =>
          Array.isArray(group?.domains) && group.domains.every((domain) => Array.isArray(domain.scoreColumns));
        const hasExamComponentOutputLayout = (examinations, examWeightPercent) => {
          if (!examinations) return !(Number(examWeightPercent) > 0);
          if (!examinations.enabled || !Array.isArray(examinations.components)) return true;
          return examinations.components.every((component) => {
            const hasMappedWeightedScore = component.weightedScoreColumn !== undefined
              && component.weightedScoreColumn !== null
              && Number.isFinite(Number(component.weightedScoreColumn));
            // A single TE component without a separate WS TE column is a
            // supported legacy template shape. All other mapped component
            // layouts need their own weighted-score output column.
            const isSingleTeWithoutOutput = examinations.components.length === 1
              && String(component.key).toUpperCase() === "TE"
              && templateStructure?.layout?.examWeightedScoreColumns?.TE === undefined;
            return hasMappedWeightedScore || isSingleTeWithoutOutput;
          });
        };
        const needsWorkbookRefresh = !templateStructure
          || !templateStructure.layout
          || !templateStructure.layout.examWeightedScoreColumn
          || !hasExamComponentOutputLayout(templateStructure.examinations, templateStructure.examWeightPercent)
          || Object.values(templateStructure.termConfigurations || {}).some((config) =>
            !hasExamComponentOutputLayout(config?.examinations, config?.examWeightPercent))
          || !hasColumnLayout(templateStructure.ww)
          || !hasColumnLayout(templateStructure.pt)
          || !templateStructure.termConfigurations
          || !storedMap
          || Number(storedMap.version) < 3;
        if (needsWorkbookRefresh && t.filePath && fs.existsSync(t.filePath)) {
          const masterBuffer = fs.readFileSync(t.filePath);
          const actualChecksum = crypto.createHash("sha256").update(masterBuffer).digest("hex");
          if (t.checksum && t.checksum !== actualChecksum) {
            throw new Error(`Stored grade template ${t.templateId} failed checksum verification.`);
          }
          const parsed = parseGradeTemplate(masterBuffer);
          const exportMap = createGradeTemplateWorkbookMap(masterBuffer);
          parsed.structure.termConfigurations = Object.fromEntries(exportMap.terms.map((term) => [String(term.termNumber), {
            ...term.config,
            transmutationTable: parsed.structure.transmutationTable,
            descriptorTable: parsed.structure.descriptorTable,
          }]));
          templateStructure = parsed.structure;
          await connection.query(
            `UPDATE subject_grade_templates
                SET structure_json = ?, export_map_json = ?, checksum_sha256 = COALESCE(checksum_sha256, ?)
              WHERE id = ?`,
            [JSON.stringify(templateStructure), JSON.stringify(exportMap), crypto.createHash("sha256").update(masterBuffer).digest("hex"), t.templateId],
          );
          await refreshSubjectGradeCache(Number(subjectId));
        }
      } catch (parseError) {
        console.error("Could not restore stored grade template structure:", parseError);
      }
      const termConfiguration = termNumber
        ? templateStructure?.termConfigurations?.[String(termNumber)]
        : null;
      const resolvedStructure = termConfiguration
        ? { ...templateStructure, ...termConfiguration }
        : templateStructure;
      return res.status(200).json({
        success: true,
        data: {
          source: "template",
          ww: Number(termConfiguration?.ww?.weightPercent ?? t.ww),
          pt: Number(termConfiguration?.pt?.weightPercent ?? t.pt),
          exam: Number(termConfiguration?.examWeightPercent ?? t.exam),
          examSubWeights: termConfiguration?.examSubWeights ?? templateStructure?.examSubWeights ?? (Number.isFinite(Number(t.st1)) ? { st1: Number(t.st1), st2: Number(t.st2), te: Number(t.te) } : undefined),
          examinations: termConfiguration?.examinations ?? templateStructure?.examinations,
          templateStructure: resolvedStructure,
          templateId: t.templateId,
          templateChecksum: t.checksum,
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
      weightRows.forEach((row) => {
        const category = assessmentCategoryForName(row.assessment_name);
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
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Database error occurred." });
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

exports.exportGradeTemplateBySection = async (req, res) => {
  const { subjectSectionId } = req.params;
  const { gradingPeriodId } = req.query;
  const authUserId = req.user?.userId;
  if (!subjectSectionId || !Number.isInteger(Number(subjectSectionId)) || !gradingPeriodId || !Number.isInteger(Number(gradingPeriodId))) {
    return res.status(400).json({ success: false, message: "A valid subject section and grading period are required." });
  }
  if (!authUserId) return res.status(401).json({ success: false, message: "Authentication is required." });

  try {
    const [scopeRows] = await connection.execute(
      `SELECT ss.id AS subjectSectionId, ss.subject_id AS subjectId, ss.section_id AS sectionId,
              ss.school_year_id AS schoolYearId, es.subject_name AS subjectName,
              es.grade_level_id AS gradeLevelId, gl.grade_level AS gradeLevel, gls.section_name AS sectionName,
              sy.school_year AS schoolYear, CONCAT(t.first_name, ' ', t.last_name) AS teacherName,
              gp.term_number AS termNumber
         FROM \`subject-section\` ss
         INNER JOIN elem_subjects es ON es.id = ss.subject_id
         INNER JOIN grade_level gl ON gl.id = es.grade_level_id
         LEFT JOIN grade_level_sections gls ON gls.id = ss.section_id
         INNER JOIN school_year sy ON sy.id = ss.school_year_id
         INNER JOIN grading_periods gp ON gp.id = ? AND gp.school_year_id = ss.school_year_id
         INNER JOIN teacher_table t ON t.id = ss.teacher_id AND t.user_id = ?
        WHERE ss.id = ? AND gp.term_number BETWEEN 1 AND 3
        LIMIT 1`,
      [gradingPeriodId, authUserId, subjectSectionId],
    );
    if (!scopeRows.length) return res.status(403).json({ success: false, message: "You do not have access to this class or grading period." });
    const scope = scopeRows[0];

    const [roster] = scope.sectionId
      ? await connection.execute(
        `SELECT s.id, s.gender, CONCAT(s.last_name, ', ', s.first_name, ' ', COALESCE(s.middle_name, '')) AS name
           FROM elem_students s
          WHERE s.is_deleted = 0 AND s.status <> 'graduated'
            AND s.current_school_year_id = ? AND s.section_id = ?
          ORDER BY s.last_name ASC, s.first_name ASC`,
        [scope.schoolYearId, scope.sectionId],
      )
      : await connection.execute(
        `SELECT s.id, s.gender, CONCAT(s.last_name, ', ', s.first_name, ' ', COALESCE(s.middle_name, '')) AS name
           FROM elem_students s
          WHERE s.is_deleted = 0 AND s.status <> 'graduated'
            AND s.current_school_year_id = ? AND s.grade_level_id = ? AND s.section_id IS NULL
          ORDER BY s.last_name ASC, s.first_name ASC`,
        [scope.schoolYearId, scope.gradeLevelId],
      );

    const resolved = await resolveGradeTemplateForPeriod(scope.subjectSectionId, gradingPeriodId, {
      pinIfEmpty: true,
      assignmentSource: "first_export",
      requireWorkbook: true,
    });
    if (!resolved.template) {
      return res.status(404).json({ success: false, message: "No official grade template is configured for this subject." });
    }
    const template = resolved.template;
    const masterBuffer = fs.readFileSync(template.filePath);
    const checksum = template.checksum;
    let exportMap = template.exportMap;
    let refreshExportMap = !exportMap || Number(exportMap.version) < 3;
    try {
      exportMap = refreshExportMap ? createGradeTemplateWorkbookMap(masterBuffer) : exportMap;
      if (exportMap?.workbookChecksumSha256 && exportMap.workbookChecksumSha256 !== checksum) {
        return res.status(409).json({ success: false, message: "The saved template map does not match the stored workbook version. Please contact the administrator." });
      }
    } catch (error) {
      console.error("Could not validate the pinned official template map:", error);
      return res.status(422).json({ success: false, message: "The configured DepEd template could not be mapped safely. Please contact the administrator." });
    }
    if (refreshExportMap) {
      await connection.execute(
        `UPDATE subject_grade_templates SET export_map_json = ? WHERE id = ?`,
        [JSON.stringify(exportMap), template.templateId],
      );
    }
    const term = exportMap.terms?.find((entry) => Number(entry.termNumber) === Number(scope.termNumber));
    if (!term) return res.status(422).json({ success: false, message: "The selected term is not mapped in the configured DepEd template. Please contact the administrator." });

    const [items] = await connection.execute(
      `SELECT id, tab, item_date AS itemDate, exam_type AS examType,
              template_domain_id AS templateDomainId, max_items AS maxItems
         FROM grade_items WHERE subject_section_id = ? AND grading_period_id = ?
        ORDER BY item_date ASC, id ASC`,
      [scope.subjectSectionId, gradingPeriodId],
    );
    const itemIds = items.map((item) => item.id);
    const scoreRows = itemIds.length
      ? (await connection.execute(
        `SELECT student_id AS studentId, item_id AS itemId, score
           FROM grade_scores WHERE item_id IN (${itemIds.map(() => "?").join(",")})`,
        itemIds,
      ))[0]
      : [];
    const scoreMap = new Map(scoreRows.map((row) => [`${row.studentId}:${row.itemId}`, row.score === null ? null : Number(row.score)]));
    const writes = { "INPUT DATA": {}, [term.sheetName]: {} };
    const boys = roster.filter((student) => String(student.gender).toLowerCase().startsWith("m"));
    const girls = roster.filter((student) => String(student.gender).toLowerCase().startsWith("f"));
    const rowsForGender = { M: term.studentRows.filter((row) => row.gender === "M"), F: term.studentRows.filter((row) => row.gender === "F") };
    if (roster.some((student) => !["m", "f"].includes(String(student.gender || "").trim().toLowerCase()[0]))) {
      return res.status(422).json({ success: false, message: "A learner's gender could not be matched to the DepEd template rows. No workbook was exported." });
    }
    if (roster.some((student) => !String(student.name || "").trim())) {
      return res.status(422).json({ success: false, message: "A learner name is missing from the class roster. No workbook was exported." });
    }
    if (boys.length > rowsForGender.M.length || girls.length > rowsForGender.F.length) {
      return res.status(422).json({ success: false, message: "This official template does not have enough learner rows for the current class roster." });
    }
    const rowByStudent = new Map();
    for (const gender of ["M", "F"]) {
      const students = gender === "M" ? boys : girls;
      const mappedRows = rowsForGender[gender];
      for (const mapped of mappedRows) writes["INPUT DATA"][mapped.nameInputCell] = null;
      students.forEach((student, index) => {
        const mapped = mappedRows[index];
        writes["INPUT DATA"][mapped.nameInputCell] = String(student.name || "").trim();
        rowByStudent.set(String(student.id), mapped.row);
      });
    }
    const metadataValues = {
      "SCHOOL YEAR": scope.schoolYear,
      "SUBJECT TEACHER": scope.teacherName,
      SUBJECT: scope.subjectName,
      "GRADE LEVEL": scope.gradeLevel,
      SECTION: scope.sectionName || "",
    };
    for (const field of exportMap.sheets?.["INPUT DATA"]?.metadataFields || []) {
      if (Object.hasOwn(metadataValues, field.label)) writes["INPUT DATA"][field.cell] = String(metadataValues[field.label] ?? "");
    }
    for (const cell of term.rawInputCells) writes[term.sheetName][cell] = null;

    const byTab = {
      writtenWorks: items.filter((item) => item.tab === "writtenWorks"),
      performanceTask: items.filter((item) => item.tab === "performanceTask"),
      exams: items.filter((item) => item.tab === "exams"),
    };
    for (const category of ["writtenWorks", "performanceTask"]) {
      const mappedDomains = term.groups[category] || [];
      for (const domain of mappedDomains) {
        const domainItems = mappedDomains.length > 1
          ? byTab[category].filter((item) => String(item.templateDomainId || "") === domain.id)
          : byTab[category];
        if (mappedDomains.length > 1 && byTab[category].some((item) => !mappedDomains.some((entry) => entry.id === item.templateDomainId))) {
          return res.status(422).json({ success: false, message: `${category === "writtenWorks" ? "Written Works" : "Performance Tasks"} contains an item whose domain is not in this template.` });
        }
        try {
          assertMappedCapacity(domainItems.length, domain.scoreColumns.length, domain.label || (category === "writtenWorks" ? "Written Works" : "Performance Tasks"));
        } catch (capacityError) {
          return res.status(422).json({ success: false, message: capacityError.message });
        }
        domainItems.forEach((item, index) => {
          const column = domain.scoreColumns[index];
          writes[term.sheetName][`${require("xlsx").utils.encode_col(column - 1)}${term.highestPossibleRow}`] = Number(item.maxItems);
          for (const student of roster) {
            const row = rowByStudent.get(String(student.id));
            if (!row) continue;
            const score = scoreMap.get(`${student.id}:${item.id}`);
            writes[term.sheetName][`${require("xlsx").utils.encode_col(column - 1)}${row}`] = score;
          }
        });
      }
    }
    const examComponents = term.examinations?.components || [];
    const claimedExamItemIds = new Set();
    if (byTab.exams.length && !term.examinations?.enabled) {
      return res.status(422).json({ success: false, message: "QED has Examination scores, but the pinned official template has no Examination section. No workbook was exported." });
    }
    for (const component of examComponents) {
      const typedItems = component.key.toUpperCase() === "ALL"
        ? byTab.exams
        : byTab.exams.filter((item) => String(item.examType || "").toUpperCase() === component.key.toUpperCase());
      typedItems.forEach((item) => claimedExamItemIds.add(item.id));
      const column = component.scoreColumn;
      if (!Number.isInteger(Number(column)) || Number(column) < 1) {
        return res.status(422).json({ success: false, message: `The pinned template is missing the raw input column for ${component.label}.` });
      }
      if (typedItems.length) {
        writes[term.sheetName][`${require("xlsx").utils.encode_col(column - 1)}${term.highestPossibleRow}`] = typedItems.reduce((sum, item) => sum + Number(item.maxItems), 0);
      }
      for (const student of roster) {
        const values = typedItems.map((item) => scoreMap.get(`${student.id}:${item.id}`));
        const row = rowByStudent.get(String(student.id));
        if (row) {
          // A component maps to one official raw-score cell. Do not export a
          // partial sum while any assessment record in that component is blank.
          const componentComplete = typedItems.length > 0 && values.every((value) => typeof value === "number");
          writes[term.sheetName][`${require("xlsx").utils.encode_col(column - 1)}${row}`] = componentComplete
            ? values.reduce((sum, value) => sum + value, 0)
            : null;
        }
      }
    }
    if (byTab.exams.some((item) => !claimedExamItemIds.has(item.id))) {
      return res.status(422).json({ success: false, message: "QED has Examination scores that do not match a component in the pinned template. No workbook was exported." });
    }

    let exportBuffer;
    try {
      exportBuffer = await patchOfficialWorkbook(masterBuffer, writes, exportMap);
    } catch (error) {
      console.error("Official template export was rejected:", error);
      return res.status(422).json({ success: false, message: "The official template could not be safely prepared for export. Please contact the administrator or upload a valid template." });
    }
    const baseName = path.parse(template.fileName).name.replace(/[^a-z0-9_-]+/gi, "-");
    const fileName = `${baseName}-QED-TERM-${scope.termNumber}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-QED-Template-Version", String(template.templateId));
    res.setHeader("X-QED-Template-SHA256", checksum);
    return res.status(200).send(exportBuffer);
  } catch (error) {
    console.error("Official grade template export error:", error);
    return res.status(500).json({ success: false, message: "Could not export the official grade template." });
  }
};
