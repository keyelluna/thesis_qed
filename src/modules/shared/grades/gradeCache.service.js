// src/modules/shared/grades/gradeCache.service.js
const connection = require('../../../../config/db');

function computePS(totalScore, highestPossibleScore) {
  if (!highestPossibleScore) return null;
  return (totalScore / highestPossibleScore) * 100;
}

function computeWS(ps, weightPercent) {
  if (ps === null) return null;
  return (ps / 100) * weightPercent;
}

function computeInitialGrade(wsWW, wsPT, wsExam) {
  const parts = [wsWW, wsPT, wsExam].filter((v) => v !== null && v !== undefined);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0);
}

// ---- Per-category aggregation, ported from AssessmentRecordsSection.studentTotals ----

function categoryTotals(items, studentId, scoresByItemId) {
  const highestPossible = items.reduce((sum, item) => sum + item.maxItems, 0);

  let total = 0;
  let scoredCount = 0;
  for (const item of items) {
    const value = scoresByItemId.get(`${studentId}:${item.id}`);
    if (typeof value === "number") {
      total += value;
      scoredCount += 1;
    }
  }

  return {
    total,
    highestPossible,
    scoredCount,
    totalItems: items.length,
    isComplete: items.length > 0 && scoredCount === items.length,
  };
}

// ---- Core recalculation ----

async function recalcSubjectAverage(studentId, subjectSectionId, gradingPeriodId) {
  const [ssRows] = await connection.execute(
    `SELECT es.id AS subjectId, es.subject_name AS subjectName, gl.grade_level AS gradeLevel
     FROM \`subject-section\` ss
     INNER JOIN elem_subjects es ON ss.subject_id = es.id
     INNER JOIN grade_level gl ON es.grade_level_id = gl.id
     WHERE ss.id = ?`,
    [subjectSectionId]
  );
  if (ssRows.length === 0) return;
  const { subjectId } = ssRows[0];
  const [templateRows] = await connection.execute(
    `SELECT ww_weight_percent AS ww, pt_weight_percent AS pt, exam_weight_percent AS exam,
            exam_st1_subweight_percent AS st1, exam_st2_subweight_percent AS st2,
            exam_te_subweight_percent AS te, structure_json AS structureJson
       FROM subject_grade_templates WHERE subject_id = ? AND is_active = 1 LIMIT 1`,
    [subjectId],
  );
  let template = templateRows[0] || null;
  if (template?.structureJson && typeof template.structureJson === "string") {
    try { template.structure = JSON.parse(template.structureJson); } catch { template = null; }
  } else if (template?.structureJson) template.structure = template.structureJson;

  let weights = template
    ? { ww: Number(template.ww), pt: Number(template.pt), exam: Number(template.exam) }
    : null;
  if (!weights) {
    const [manualRows] = await connection.execute(
      `SELECT assessment_type_id AS typeId, weight_percent AS weight
         FROM subject_weight_distribution WHERE subject_id = ?`,
      [subjectId],
    );
    const byType = Object.fromEntries(manualRows.map((row) => [Number(row.typeId), Number(row.weight)]));
    if ([byType[1], byType[2], byType[3]].every(Number.isFinite)) {
      weights = { ww: byType[1], pt: byType[2], exam: byType[3] };
    }
  }

  const [items] = await connection.execute(
    `SELECT id, tab, max_items AS maxItems, exam_type AS examType, template_domain_id AS templateDomainId
     FROM grade_items
     WHERE subject_section_id = ? AND grading_period_id = ?`,
    [subjectSectionId, gradingPeriodId]
  );

  if (items.length === 0) {
    await connection.execute(
      `INSERT INTO subject_grade_cache (student_id, subject_section_id, grading_period_id, average, is_complete)
       VALUES (?, ?, ?, NULL, 0)
       ON DUPLICATE KEY UPDATE average = NULL, is_complete = 0`,
      [studentId, subjectSectionId, gradingPeriodId]
    );
    return;
  }

  if (!weights) {
    await connection.execute(
      `INSERT INTO subject_grade_cache (student_id, subject_section_id, grading_period_id, average, is_complete)
       VALUES (?, ?, ?, NULL, 0)
       ON DUPLICATE KEY UPDATE average = NULL, is_complete = 0`,
      [studentId, subjectSectionId, gradingPeriodId],
    );
    return;
  }

  const itemIds = items.map((i) => i.id);
  const placeholders = itemIds.map(() => "?").join(",");
  const [scoreRows] = await connection.execute(
    `SELECT item_id AS itemId, score FROM grade_scores
     WHERE student_id = ? AND item_id IN (${placeholders})`,
    [studentId, ...itemIds]
  );
  const scoresByItemId = new Map(
    scoreRows
      .filter((r) => r.score !== null)
      .map((r) => [`${studentId}:${r.itemId}`, Number(r.score)])
  );

  const wwItems = items.filter((i) => i.tab === "writtenWorks");
  const ptItems = items.filter((i) => i.tab === "performanceTask");
  const examItems = items.filter((i) => i.tab === "exams");

  const calcGroup = (groupItems, groupTemplate, weight) => {
    if (groupTemplate?.domains?.length > 1) {
      let ws = 0;
      const domainIds = new Set(groupTemplate.domains.map((domain) => domain.id));
      let complete = !groupItems.some((item) => item.templateDomainId && !domainIds.has(item.templateDomainId));
      let hasItems = false;
      for (const domain of groupTemplate.domains) {
        const domainItems = groupItems.filter((item) => item.templateDomainId === domain.id);
        const totals = categoryTotals(domainItems, studentId, scoresByItemId);
        hasItems ||= totals.totalItems > 0;
        if (!totals.isComplete) complete = false;
        if (!totals.totalItems) { complete = false; continue; }
        ws += (computePS(totals.total, totals.highestPossible) * Number(domain.weightPercent)) / 100;
      }
      return { ws: hasItems ? ws : null, complete: hasItems && complete };
    }
    const totals = categoryTotals(groupItems, studentId, scoresByItemId);
    if (!totals.totalItems) return { ws: null, complete: true };
    return { ws: computeWS(computePS(totals.total, totals.highestPossible), weight), complete: totals.isComplete };
  };

  const ww = calcGroup(wwItems, template?.structure?.ww, weights.ww);
  const pt = calcGroup(ptItems, template?.structure?.pt, weights.pt);
  let examWs = null;
  let examComplete = true;
  if (template?.structure?.examSubWeights) {
    let combinedPs = 0;
    let hasExamItems = false;
    for (const [examType, subWeight] of [["ST1", template.structure.examSubWeights.st1], ["ST2", template.structure.examSubWeights.st2], ["TE", template.structure.examSubWeights.te]]) {
      const totals = categoryTotals(examItems.filter((item) => item.examType === examType), studentId, scoresByItemId);
      hasExamItems ||= totals.totalItems > 0;
      if (!totals.totalItems || !totals.isComplete) examComplete = false;
      if (totals.highestPossible) combinedPs += (computePS(totals.total, totals.highestPossible) * Number(subWeight)) / 100;
    }
    examWs = hasExamItems ? computeWS(combinedPs, weights.exam) : null;
  } else {
    const totals = categoryTotals(examItems, studentId, scoresByItemId);
    examWs = totals.totalItems ? computeWS(computePS(totals.total, totals.highestPossible), weights.exam) : null;
    examComplete = totals.isComplete;
  }

  const initialGrade = computeInitialGrade(ww.ws, pt.ws, examWs);
  const table = template?.structure?.transmutationTable || [];
  const transmutationRow = table.find((row) => initialGrade !== null && initialGrade >= Number(row.igMin) && initialGrade <= Number(row.igMax));
  // `subject_grade_cache.average` is the published subject Term Grade. Never
  // substitute Initial Grade when an approved transmutation table is absent
  // or does not cover the calculated IG.
  const average = transmutationRow ? Number(transmutationRow.transmuted) : null;
  const isComplete = average !== null && ww.complete && pt.complete && examComplete;

  await connection.execute(
    `INSERT INTO subject_grade_cache (student_id, subject_section_id, grading_period_id, average, is_complete)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE average = VALUES(average), is_complete = VALUES(is_complete)`,
    [studentId, subjectSectionId, gradingPeriodId, average, isComplete]
  );
}

// Resolves the advisory class a student belongs to, whether it has a real
// section or is a single-section-per-grade-level class, plus the class's
// adviser teacher id. Mirrors the `advisoryScope` helper in
// advisoryGrading.controller.js so the "own advisory subject" rule used
// here always matches the one used to render the gradebook.
//
// NOTE: this no longer returns scopeColumn/scopeValue. advisory_overall_grades
// has both `section_id` and `grade_level_id` columns (each nullable), so we
// always pass both explicitly instead of building the column list dynamically.
async function getStudentAdvisoryContext(studentId) {
  const [studentRows] = await connection.execute(
    `SELECT section_id AS sectionId, grade_level_id AS gradeLevelId
     FROM elem_students WHERE id = ? AND is_deleted = 0`,
    [studentId]
  );
  if (studentRows.length === 0) return null;
  const { sectionId, gradeLevelId } = studentRows[0];

  const [classRows] = await connection.execute(
    sectionId
      ? `SELECT class_adviser_id AS adviserTeacherId FROM classes WHERE section_id = ?`
      : `SELECT class_adviser_id AS adviserTeacherId FROM classes WHERE section_id IS NULL AND grade_level_id = ?`,
    [sectionId || gradeLevelId]
  );
  const adviserTeacherId = classRows.length ? classRows[0].adviserTeacherId : null;

  return {
    sectionId,     // null for sectionless classes
    gradeLevelId,  // always present
    adviserTeacherId,
  };
}

// Same subject-section resolution logic as getAdvisoryGradebook: for a
// real section this includes both section-specific and grade-level-wide
// subject-sections; for a section-less class it's grade-level-wide only.
async function getActiveSubjectSectionsForScope(context) {
  const { sectionId, gradeLevelId } = context;
  const [rows] = sectionId
    ? await connection.execute(
        `SELECT ss.id, ss.teacher_id AS teacherId
         FROM \`subject-section\` ss
         INNER JOIN elem_subjects es ON ss.subject_id = es.id
         WHERE ss.status = 'Active'
           AND (
             ss.section_id = ?
             OR (ss.section_id IS NULL AND es.grade_level_id = ?)
           )`,
        [sectionId, gradeLevelId]
      )
    : await connection.execute(
        `SELECT ss.id, ss.teacher_id AS teacherId
         FROM \`subject-section\` ss
         INNER JOIN elem_subjects es ON ss.subject_id = es.id
         WHERE ss.status = 'Active' AND ss.section_id IS NULL AND es.grade_level_id = ?`,
        [gradeLevelId]
      );
  return rows;
}

async function recalcOverallAverage(studentId, gradingPeriodId) {
  const context = await getStudentAdvisoryContext(studentId);
  if (!context) return;

  const subjectSections = await getActiveSubjectSectionsForScope(context);
  if (subjectSections.length === 0) return;

  const ssIds = subjectSections.map((s) => s.id);
  const placeholders = ssIds.map(() => "?").join(",");

  const [cacheRows] = await connection.execute(
    `SELECT subject_section_id AS subjectSectionId, average, is_complete AS isComplete
     FROM subject_grade_cache
     WHERE student_id = ? AND grading_period_id = ? AND subject_section_id IN (${placeholders})`,
    [studentId, gradingPeriodId, ...ssIds]
  );
  const cacheBySs = new Map(cacheRows.map((r) => [r.subjectSectionId, r]));

  const [submissionRows] = await connection.execute(
    `SELECT subject_section_id AS subjectSectionId
     FROM subject_grade_submissions
     WHERE subject_section_id IN (${placeholders}) AND grading_period_id = ?`,
    [...ssIds, gradingPeriodId]
  );
  const submittedSsIds = new Set(submissionRows.map((r) => r.subjectSectionId));

  const countedAverages = [];
  for (const ss of subjectSections) {
    const cell = cacheBySs.get(ss.id);
    if (!cell || cell.average === null) continue;

    const isOwnAdvisorySubject =
      context.adviserTeacherId !== null && ss.teacherId === context.adviserTeacherId;
    const isSubmitted = isOwnAdvisorySubject ? !!cell.isComplete : submittedSsIds.has(ss.id);
    if (isSubmitted) countedAverages.push(Number(cell.average));
  }

  const overallAverage = countedAverages.length
    ? Math.round((countedAverages.reduce((a, b) => a + b, 0) / countedAverages.length) * 100) / 100
    : null;

  // FIX: no dynamic column name. Always insert both section_id and
  // grade_level_id explicitly — whichever doesn't apply is passed as null.
  // This removes the "Unknown column 'grade_level_id'" failure that was
  // silently killing this insert for every sectionless (grade 3-6) student.
  await connection.execute(
    `INSERT INTO advisory_overall_grades
       (student_id, section_id, grade_level_id, grading_period_id, overall_average)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       overall_average = VALUES(overall_average),
       section_id = VALUES(section_id),
       grade_level_id = VALUES(grade_level_id)`,
    [
      studentId,
      context.sectionId || null,
      context.sectionId ? null : context.gradeLevelId,
      gradingPeriodId,
      overallAverage,
    ]
  );
}

async function recalcStudentSubject(studentId, subjectSectionId, gradingPeriodId) {
  await recalcSubjectAverage(studentId, subjectSectionId, gradingPeriodId);
  await recalcOverallAverage(studentId, gradingPeriodId);
}

// Recalculates every enrolled student for one subject-section, whether
// that subject-section belongs to a real section or is grade-level-wide.
async function recalcAllStudentsForSubject(subjectSectionId, gradingPeriodId) {
  const [ssRows] = await connection.execute(
    `SELECT ss.section_id AS sectionId, es.grade_level_id AS gradeLevelId
     FROM \`subject-section\` ss
     INNER JOIN elem_subjects es ON ss.subject_id = es.id
     WHERE ss.id = ?`,
    [subjectSectionId]
  );
  if (ssRows.length === 0) return;
  const { sectionId, gradeLevelId } = ssRows[0];

  const [students] = sectionId
    ? await connection.execute(
        `SELECT id FROM elem_students WHERE section_id = ? AND is_deleted = 0`,
        [sectionId]
      )
    : await connection.execute(
        `SELECT id FROM elem_students WHERE grade_level_id = ? AND section_id IS NULL AND is_deleted = 0`,
        [gradeLevelId]
      );

  for (const s of students) {
    await recalcSubjectAverage(s.id, subjectSectionId, gradingPeriodId);
    await recalcOverallAverage(s.id, gradingPeriodId);
  }
}

module.exports = {
  recalcStudentSubject,
  recalcAllStudentsForSubject,
  recalcOverallAverage,
};
