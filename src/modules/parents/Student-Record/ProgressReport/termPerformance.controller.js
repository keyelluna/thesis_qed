const connection = require('../../../../../config/db');

const ADVISORY_EXAM_TYPES = ["ST1", "ST2", "TE"];

/**
 * Access-control middleware: verifies the logged-in parent actually has
 * this student as a linked child (via `parent_student`) before returning
 * any grade data.
 */
async function loadParentStudent(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized: walang user ID na nakuha mula sa token." });
    }

    const [parentRows] = await connection.execute(
      `SELECT id FROM parent_table WHERE user_id = ?`,
      [authId]
    );
    if (parentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Parent record not found." });
    }
    const parentId = parentRows[0].id;

    const { studentId } = req.params;

    const [linkRows] = await connection.execute(
      `SELECT es.id, es.section_id
       FROM elem_students es
       INNER JOIN parent_student ps ON ps.student_id = es.id
       WHERE es.id = ? AND ps.parent_id = ? AND es.is_deleted = 0`,
      [studentId, parentId]
    );
    if (linkRows.length === 0) {
      return res.status(403).json({ success: false, message: "You don't have access to this student's records." });
    }

    req.parentId = parentId;
    req.studentSectionId = linkRows[0].section_id;
    next();
  } catch (error) {
    console.error("Error verifying parent-student access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/**
 * Computes a single subject's ST1/ST2/TE average for one student, exactly
 * mirroring the formula used in getAdvisoryGradebook (advisoryGrading
 * controller) — each exam type is converted to a percentage of its max,
 * then averaged across all three. Only complete (all 3 present) subjects
 * produce a non-null average.
 */
function computeSubjectAverage(items, scoreByItemId) {
  const byType = {};
  for (const type of ADVISORY_EXAM_TYPES) {
    const item = items.find((i) => i.examType === type);
    if (!item) {
      byType[type] = null;
      continue;
    }
    const score = scoreByItemId.get(item.id);
    byType[type] = score === undefined || score === null ? null : { score, max: item.maxItems };
  }
  const present = ADVISORY_EXAM_TYPES.filter((t) => byType[t] !== null);
  const isComplete = present.length === ADVISORY_EXAM_TYPES.length;
  const average = isComplete
    ? Math.round(
        (present.reduce((sum, t) => sum + (byType[t].score / byType[t].max) * 100, 0) /
          ADVISORY_EXAM_TYPES.length) *
          10
      ) / 10
    : null;
  return { average, isComplete };
}

/**
 * Returns per-term, per-subject grade history for one student, shaped to
 * match the parent-side `Term[]` type:
 *   { key, label, released, average, subjects: SubjectGrade[] }
 *
 * IMPORTANT: unlike a "return everything with released=false" approach,
 * this ONLY includes terms in the `data` array where the advisory teacher
 * has actually submitted grades (grade_submissions). A term that hasn't
 * been submitted yet is dropped from the array entirely — the parent UI
 * never even receives a placeholder row for it, so there's nothing to
 * accidentally render.
 */
async function getStudentTermPerformance(req, res) {
  try {
    const { studentId } = req.params;
    const sectionId = req.studentSectionId;

    const [periods] = await connection.execute(
      `SELECT gp.id, gp.term_number AS termNumber, gp.term_label AS termLabel
       FROM grading_periods gp
       INNER JOIN school_year sy ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       ORDER BY gp.term_number ASC`
    );

    if (periods.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const periodIds = periods.map((p) => p.id);
    const periodPlaceholders = periodIds.map(() => "?").join(",");

    // Which terms has the advisory teacher submitted for this section?
    // Check this FIRST so we can bail early if nothing is released yet —
    // no need to touch subjects/items/scores at all in that case.
    const [submissions] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId
       FROM grade_submissions
       WHERE section_id = ? AND grading_period_id IN (${periodPlaceholders})`,
      [sectionId, ...periodIds]
    );
    const submittedPeriodIds = new Set(submissions.map((s) => s.gradingPeriodId));

    if (submittedPeriodIds.size === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const submittedPeriods = periods.filter((p) => submittedPeriodIds.has(p.id));
    const submittedPeriodIdList = submittedPeriods.map((p) => p.id);
    const submittedPeriodPlaceholders = submittedPeriods.map(() => "?").join(",");

    const [subjectSections] = await connection.execute(
      `SELECT ss.id AS subjectSectionId, es.subject_name AS subjectName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       WHERE ss.section_id = ? AND ss.status = 'Active'
       ORDER BY es.subject_name ASC`,
      [sectionId]
    );

    if (subjectSections.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const subjectSectionIds = subjectSections.map((s) => s.subjectSectionId);
    const ssPlaceholders = subjectSectionIds.map(() => "?").join(",");

    // Only pull items for terms that are actually submitted
    const [items] = await connection.execute(
      `SELECT id, subject_section_id AS subjectSectionId, grading_period_id AS gradingPeriodId,
              exam_type AS examType, max_items AS maxItems
       FROM grade_items
       WHERE subject_section_id IN (${ssPlaceholders}) AND tab = 'exams'
         AND exam_type IN ('ST1','ST2','TE') AND grading_period_id IN (${submittedPeriodPlaceholders})`,
      [...subjectSectionIds, ...submittedPeriodIdList]
    );

    // This student's scores for those items
    let scores = [];
    if (items.length > 0) {
      const itemIds = items.map((i) => i.id);
      const itemPlaceholders = itemIds.map(() => "?").join(",");
      const [scoreRows] = await connection.execute(
        `SELECT item_id AS itemId, score
         FROM grade_scores
         WHERE student_id = ? AND item_id IN (${itemPlaceholders})`,
        [studentId, ...itemIds]
      );
      scores = scoreRows;
    }
    const scoreByItemId = new Map(
      scores.map((s) => [s.itemId, s.score === null ? null : Number(s.score)])
    );

    // Build the response using ONLY the submitted/released terms
    const terms = submittedPeriods.map((period) => {
      const subjects = subjectSections.map((ss) => {
        const subjItems = items.filter(
          (i) => i.subjectSectionId === ss.subjectSectionId && i.gradingPeriodId === period.id
        );
        const { average } = computeSubjectAverage(subjItems, scoreByItemId);
        return {
          subject: ss.subjectName,
          grade: average ?? 0,
        };
      });

      const validAverages = subjects.map((s) => s.grade).filter((g) => g > 0);
      const overallAverage =
        validAverages.length > 0
          ? Math.round((validAverages.reduce((a, b) => a + b, 0) / validAverages.length) * 100) / 100
          : null;

      return {
        key: String(period.id),
        label: period.termLabel,
        termNumber: period.termNumber, // exposed so the frontend can map T1/T2/T3 correctly even when terms are filtered out
        released: true, // guaranteed true — this term wouldn't be in the array otherwise
        average: overallAverage ?? undefined,
        subjects,
      };
    });

    return res.status(200).json({ success: true, data: terms });
  } catch (error) {
    console.error("Error fetching student term performance:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

module.exports = {
  loadParentStudent,
  getStudentTermPerformance,
};