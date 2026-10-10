const templateStorage = require("../../../services/templateStorage.service");
const connection = require("../../../../config/db");

function parseJson(value, label) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") throw new Error("empty configuration");
    return parsed;
  } catch {
    const error = new Error(`The pinned grade template has invalid ${label}.`);
    error.statusCode = 409;
    throw error;
  }
}

function assertTemplateIntegrity(template, subjectId) {
  if (!template || Number(template.subjectId) !== Number(subjectId)) {
    const error = new Error("The pinned grade template does not match this subject."); error.statusCode = 409; throw error;
  }
  if (!/^[a-f0-9]{64}$/i.test(String(template.checksum || ""))) {
    const error = new Error("The pinned grade template is missing its SHA-256 checksum."); error.statusCode = 409; throw error;
  }
  const structure = parseJson(template.structureJson, "grading configuration");
  let exportMap = null;
  if (template.exportMapJson) exportMap = parseJson(template.exportMapJson, "export map");
  return { ...template, structure, exportMap };
}

async function readScope(subjectSectionId, gradingPeriodId) {
  const [rows] = await connection.execute(
    `SELECT ss.subject_id AS subjectId, ss.school_year_id AS schoolYearId,
            gp.term_number AS termNumber
       FROM \`subject-section\` ss
       INNER JOIN grading_periods gp ON gp.id = ? AND gp.school_year_id = ss.school_year_id
      WHERE ss.id = ? AND gp.term_number BETWEEN 1 AND 3 LIMIT 1`,
    [gradingPeriodId, subjectSectionId],
  );
  if (!rows.length) { const error = new Error("The subject section and grading period do not belong to the same school year."); error.statusCode = 400; throw error; }
  return rows[0];
}

async function readPinned(subjectSectionId, gradingPeriodId) {
  const [rows] = await connection.execute(
    `SELECT t.id AS templateId, t.subject_id AS subjectId, t.file_name AS fileName, t.file_path AS filePath, t.storage_key AS storageKey,
            t.checksum_sha256 AS checksum, t.structure_json AS structureJson,
            t.export_map_json AS exportMapJson
       FROM subject_grade_template_periods p
       LEFT JOIN subject_grade_templates t ON t.id = p.template_id
      WHERE p.subject_section_id = ? AND p.grading_period_id = ? LIMIT 1`,
    [subjectSectionId, gradingPeriodId],
  );
  return rows[0] || null;
}

/**
 * Resolves one immutable template per subject-section and grading period.
 * A missing pin can only be created for a period with no existing grade items;
 * legacy periods with assessment data fail closed rather than adopting today's
 * active template and silently changing their historical interpretation.
 */
async function resolveGradeTemplateForPeriod(subjectSectionId, gradingPeriodId, {
  pinIfEmpty = true,
  assignmentSource = "first_assessment",
  requireWorkbook = false,
} = {}) {
  const scope = await readScope(subjectSectionId, gradingPeriodId);
  let pinned = await readPinned(subjectSectionId, gradingPeriodId);

  if (!pinned) {
    const [activeRows] = await connection.execute(
      `SELECT id AS templateId, subject_id AS subjectId, file_name AS fileName, file_path AS filePath, storage_key AS storageKey,
              checksum_sha256 AS checksum, structure_json AS structureJson,
              export_map_json AS exportMapJson
         FROM subject_grade_templates WHERE subject_id = ? AND is_active = 1 LIMIT 1`,
      [scope.subjectId],
    );
    if (!activeRows.length) return { ...scope, template: null };
    const [existingItems] = await connection.execute(
      `SELECT id FROM grade_items WHERE subject_section_id = ? AND grading_period_id = ? LIMIT 1`,
      [subjectSectionId, gradingPeriodId],
    );
    if (existingItems.length) {
      const error = new Error("This historical grading period has assessments but no pinned template. Resolve its template assignment before using grades or exporting."); error.statusCode = 409; throw error;
    }
    if (!pinIfEmpty) return { ...scope, template: null };

    const conn = await connection.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(`SELECT id FROM elem_subjects WHERE id = ? FOR UPDATE`, [scope.subjectId]);
      const [currentPins] = await conn.execute(
        `SELECT template_id AS templateId FROM subject_grade_template_periods
          WHERE subject_section_id = ? AND grading_period_id = ? LIMIT 1`,
        [subjectSectionId, gradingPeriodId],
      );
      if (!currentPins.length) {
        const [currentActive] = await conn.execute(
          `SELECT id AS templateId, subject_id AS subjectId, file_name AS fileName, file_path AS filePath, storage_key AS storageKey,
                  checksum_sha256 AS checksum, structure_json AS structureJson,
                  export_map_json AS exportMapJson
             FROM subject_grade_templates WHERE subject_id = ? AND is_active = 1 LIMIT 1`,
          [scope.subjectId],
        );
        if (!currentActive.length) { const error = new Error("No active grade template is configured for this subject."); error.statusCode = 409; throw error; }
        assertTemplateIntegrity(currentActive[0], scope.subjectId);
        await conn.execute(
          `INSERT IGNORE INTO subject_grade_template_periods
             (subject_section_id, grading_period_id, template_id, assignment_source)
           VALUES (?, ?, ?, ?)`,
          [subjectSectionId, gradingPeriodId, currentActive[0].templateId, assignmentSource],
        );
      }
      await conn.commit();
    } catch (error) {
      try { await conn.rollback(); } catch { /* connection may already be closed */ }
      throw error;
    } finally {
      conn.release();
    }
    pinned = await readPinned(subjectSectionId, gradingPeriodId);
  }

  if (!pinned?.templateId) { const error = new Error("The grading period has a template assignment whose template version no longer exists."); error.statusCode = 409; throw error; }
  const template = assertTemplateIntegrity(pinned, scope.subjectId);
  if (requireWorkbook) template.workbookBuffer = await templateStorage.getTemplate(template);
  return { ...scope, template };
}

module.exports = { resolveGradeTemplateForPeriod, assertTemplateIntegrity };
