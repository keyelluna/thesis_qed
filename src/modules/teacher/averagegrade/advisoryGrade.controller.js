const connection = require("../../../../config/db");


async function loadAdvisorySection(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: walang user ID na nakuha mula sa token.",
      });
    }

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ?`,
      [authId],
    );
    if (teacherRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const [classRows] = await connection.execute(
      `SELECT c.section_id, c.grade_level_id AS gradeLevelId,
              gls.section_name AS sectionName, gl.grade_level AS gradeLevel
       FROM classes c
       LEFT JOIN grade_level_sections gls ON c.section_id = gls.id
       INNER JOIN grade_level gl ON c.grade_level_id = gl.id
       WHERE c.class_adviser_id = ?`,
      [teacherId],
    );
    if (classRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "You are not the adviser of any section yet.",
      });
    }

    req.teacherId = teacherId;
    req.advisorySection = classRows[0];
    next();
  } catch (error) {
    console.error("Error verifying advisory section access:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
}


const getAdvisoryGradebook = async (req, res) => {
  try {
    const {
      section_id: sectionId,
      gradeLevelId,
      sectionName,
      gradeLevel,
    } = req.advisorySection;
    const { gradingPeriodId } = req.query;
    const adviserTeacherId = req.teacherId;

    if (!gradingPeriodId) {
      return res
        .status(400)
        .json({ success: false, message: "gradingPeriodId is required." });
    }

    const subjectSectionParams = sectionId
      ? [sectionId, gradeLevelId]
      : [gradeLevelId];

    const [subjectSections] = await connection.execute(
      sectionId
        ? `SELECT ss.id AS subjectSectionId, ss.subject_id AS subjectId, ss.teacher_id AS teacherId,
                  es.subject_name AS subjectName
           FROM \`subject-section\` ss
           INNER JOIN elem_subjects es ON ss.subject_id = es.id
           WHERE ss.status = 'Active'
             AND (
               ss.section_id = ?
               OR (ss.section_id IS NULL AND es.grade_level_id = ?)
             )
           ORDER BY es.subject_name ASC`
        : `SELECT ss.id AS subjectSectionId, ss.subject_id AS subjectId, ss.teacher_id AS teacherId,
                  es.subject_name AS subjectName
           FROM \`subject-section\` ss
           INNER JOIN elem_subjects es ON ss.subject_id = es.id
           WHERE ss.status = 'Active'
             AND ss.section_id IS NULL
             AND es.grade_level_id = ?
           ORDER BY es.subject_name ASC`,
      subjectSectionParams,
    );

    if (subjectSections.length === 0) {
      return res.status(200).json({
        success: true,
        data: { sectionName, gradeLevel, subjects: [], students: [] },
      });
    }

    const subjectSectionIds = subjectSections.map((s) => s.subjectSectionId);
    const ssPlaceholders = subjectSectionIds.map(() => "?").join(",");

    const [students] = await connection.execute(
      sectionId
        ? `SELECT id, gender, first_name AS firstName, middle_name AS middleName, last_name AS lastName
           FROM elem_students
           WHERE section_id = ? AND is_deleted = 0
           ORDER BY last_name ASC, first_name ASC`
        : `SELECT id, gender, first_name AS firstName, middle_name AS middleName, last_name AS lastName
           FROM elem_students
           WHERE grade_level_id = ? AND section_id IS NULL AND is_deleted = 0
           ORDER BY last_name ASC, first_name ASC`,
      [sectionId || gradeLevelId],
    );

    // Read directly from the cache instead of recomputing from raw scores
    const [cacheRows] = await connection.execute(
      `SELECT student_id AS studentId, subject_section_id AS subjectSectionId, average, is_complete AS isComplete
       FROM subject_grade_cache
       WHERE subject_section_id IN (${ssPlaceholders}) AND grading_period_id = ?`,
      [...subjectSectionIds, gradingPeriodId],
    );

    const cacheByKey = new Map(
      cacheRows.map((r) => [
        `${r.studentId}:${r.subjectSectionId}`,
        { average: r.average, isComplete: !!r.isComplete },
      ]),
    );

    const [submissionRows] = await connection.execute(
      `SELECT sgs.subject_section_id AS subjectSectionId,
              DATE_FORMAT(sgs.submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submittedAt,
              CONCAT(t.first_name, ' ', t.last_name) AS submittedByName
       FROM subject_grade_submissions sgs
       INNER JOIN teacher_table t ON sgs.submitted_by = t.id
       WHERE sgs.subject_section_id IN (${ssPlaceholders}) AND sgs.grading_period_id = ?`,
      [...subjectSectionIds, gradingPeriodId],
    );
    const submissionByKey = new Map(
      submissionRows.map((r) => [
        r.subjectSectionId,
        { submittedAt: r.submittedAt, submittedByName: r.submittedByName },
      ]),
    );


    const ownAdvisorySubjectIds = new Set(
      subjectSections
        .filter((s) => s.teacherId === adviserTeacherId)
        .map((s) => s.subjectSectionId),
    );


    const overallByStudent = new Map();
    if (sectionId) {
      const [overallRows] = await connection.execute(
        `SELECT student_id AS studentId, overall_average AS overallAverage
         FROM advisory_overall_grades
         WHERE section_id = ? AND grading_period_id = ?`,
        [sectionId, gradingPeriodId],
      );
      overallRows.forEach((r) =>
        overallByStudent.set(r.studentId, r.overallAverage),
      );
    }

    const studentsOut = students.map((student) => {
      const grades = {};
      for (const ss of subjectSections) {
        const cell = cacheByKey.get(`${student.id}:${ss.subjectSectionId}`) || {
          average: null,
          isComplete: false,
        };
        const isOwnAdvisorySubject = ownAdvisorySubjectIds.has(
          ss.subjectSectionId,
        );
        const submission = isOwnAdvisorySubject
          ? null
          : submissionByKey.get(ss.subjectSectionId) || null;

        let status;
        if (isOwnAdvisorySubject) {
          status = cell.isComplete ? "submitted" : "not_submitted";
        } else if (submission) {
          status = "submitted";
        } else if (cell.isComplete) {
          status = "pending";
        } else {
          status = "not_submitted";
        }

        grades[String(ss.subjectSectionId)] = {
          status,
          average:
            status === "submitted" && cell.average !== null
              ? Number(cell.average)
              : null,
          submittedByName: submission ? submission.submittedByName : null,
          submittedAt: submission ? submission.submittedAt : null,
          isOwnAdvisory: isOwnAdvisorySubject,
        };
      }
      return {
        studentId: String(student.id),
        firstName: student.firstName,
        lastName: student.lastName,
        middleName: student.middleName,
        gender: student.gender === "Female" ? "F" : "M",
        grades,
        overallAverage:
          overallByStudent.has(student.id) &&
          overallByStudent.get(student.id) !== null
            ? Number(overallByStudent.get(student.id))
            : null,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        sectionName,
        gradeLevel,
        subjects: subjectSections.map((s) => {
          const isOwnAdvisorySubject = ownAdvisorySubjectIds.has(
            s.subjectSectionId,
          );
          if (isOwnAdvisorySubject) {
            // No submission row to read for this one — "submitted"
            // (for the column header's purposes) just means every
            // enrolled student's cache entry is complete.
            const allComplete = students.every(
              (student) =>
                cacheByKey.get(`${student.id}:${s.subjectSectionId}`)
                  ?.isComplete,
            );
            return {
              subjectSectionId: String(s.subjectSectionId),
              subjectId: s.subjectId,
              subjectName: s.subjectName,
              submitted: allComplete,
              submittedByName: null,
              submittedAt: null,
              isOwnAdvisory: true,
            };
          }
          const submission = submissionByKey.get(s.subjectSectionId) || null;
          return {
            subjectSectionId: String(s.subjectSectionId),
            subjectId: s.subjectId,
            subjectName: s.subjectName,
            submitted: !!submission,
            submittedByName: submission ? submission.submittedByName : null,
            submittedAt: submission ? submission.submittedAt : null,
            isOwnAdvisory: false,
          };
        }),
        students: studentsOut,
      },
    });
  } catch (error) {
    console.error("Error building advisory gradebook:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};


const getSubmissionStatus = async (req, res) => {
  try {
    const { section_id: sectionId } = req.advisorySection;
    const { gradingPeriodId } = req.query;

    if (!gradingPeriodId) {
      return res
        .status(400)
        .json({ success: false, message: "gradingPeriodId is required." });
    }

    if (!sectionId) {
      return res
        .status(200)
        .json({ success: true, data: { submitted: false, submittedAt: null } });
    }

    const [rows] = await connection.execute(
      `SELECT DATE_FORMAT(submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submittedAt
       FROM grade_submissions
       WHERE section_id = ? AND grading_period_id = ?`,
      [sectionId, gradingPeriodId],
    );

    return res.status(200).json({
      success: true,
      data: {
        submitted: rows.length > 0,
        submittedAt: rows[0]?.submittedAt ?? null,
      },
    });
  } catch (error) {
    console.error("Error fetching submission status:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const submitAdvisoryGrades = async (req, res) => {
  try {
    const { section_id: sectionId } = req.advisorySection;
    const { teacherId } = req;
    const { gradingPeriodId } = req.body;

    if (!gradingPeriodId) {
      return res
        .status(400)
        .json({ success: false, message: "gradingPeriodId is required." });
    }

    if (!sectionId) {
      return res.status(409).json({
        success: false,
        message:
          "This advisory class has no section on record yet, so grades can't be submitted. Please contact an admin to assign a section.",
      });
    }

    await connection.execute(
      `INSERT INTO grade_submissions (section_id, grading_period_id, submitted_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE submitted_by = VALUES(submitted_by), submitted_at = CURRENT_TIMESTAMP`,
      [sectionId, gradingPeriodId, teacherId],
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error submitting advisory grades:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};


const getGradeVisibility = async (req, res) => {
  try {
    const { section_id: sectionId, gradeLevelId } = req.advisorySection;
    const { gradingPeriodId } = req.query;

    if (!gradingPeriodId) {
      return res
        .status(400)
        .json({ success: false, message: "gradingPeriodId is required." });
    }

    const [students] = await connection.execute(
      sectionId
        ? `SELECT es.id, es.gender, es.first_name AS firstName, es.middle_name AS middleName, es.last_name AS lastName,
                  pt.first_name AS parentFirstName, pt.last_name AS parentLastName, pt.middle_name AS parentMiddleName,
                  pt.contact_number AS parentContactNumber, pt.email_address AS parentEmail
           FROM elem_students es
           LEFT JOIN parent_student ps ON ps.student_id = es.id
           LEFT JOIN parent_table pt ON pt.id = ps.parent_id AND pt.is_deleted = 0
           WHERE es.section_id = ? AND es.is_deleted = 0
           ORDER BY es.last_name ASC, es.first_name ASC`
        : `SELECT es.id, es.gender, es.first_name AS firstName, es.middle_name AS middleName, es.last_name AS lastName,
                  pt.first_name AS parentFirstName, pt.last_name AS parentLastName, pt.middle_name AS parentMiddleName,
                  pt.contact_number AS parentContactNumber, pt.email_address AS parentEmail
           FROM elem_students es
           LEFT JOIN parent_student ps ON ps.student_id = es.id
           LEFT JOIN parent_table pt ON pt.id = ps.parent_id AND pt.is_deleted = 0
           WHERE es.grade_level_id = ? AND es.section_id IS NULL AND es.is_deleted = 0
           ORDER BY es.last_name ASC, es.first_name ASC`,
      [sectionId || gradeLevelId],
    );

    if (students.length === 0) {
      return res.status(200).json({ success: true, data: { students: [] } });
    }

    const studentIds = students.map((s) => s.id);
    const placeholders = studentIds.map(() => "?").join(",");

    const [visRows] = await connection.execute(
      `SELECT student_id AS studentId, is_visible AS isVisible,
              DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%sZ') AS updatedAt
       FROM grade_visibility
       WHERE student_id IN (${placeholders}) AND grading_period_id = ?`,
      [...studentIds, gradingPeriodId],
    );
    const visByStudent = new Map(
      visRows.map((r) => [
        r.studentId,
        { isVisible: !!r.isVisible, updatedAt: r.updatedAt },
      ]),
    );

    return res.status(200).json({
      success: true,
      data: {
        students: students.map((s) => ({
          studentId: String(s.id),
          firstName: s.firstName,
          lastName: s.lastName,
          middleName: s.middleName,
          gender: s.gender === "Female" ? "F" : "M",
          // No row in parent_student means the student has no linked
          // parent/guardian account yet — surfaced as null, not an error.
          parentName: s.parentFirstName
            ? `${s.parentLastName}, ${s.parentFirstName}${s.parentMiddleName ? ` ${s.parentMiddleName.charAt(0)}.` : ""}`
            : null,
          parentContactNumber: s.parentContactNumber ?? null,
          parentEmail: s.parentEmail ?? null,
          isVisible: visByStudent.get(s.id)?.isVisible ?? false,
          updatedAt: visByStudent.get(s.id)?.updatedAt ?? null,
        })),
      },
    });
  } catch (error) {
    console.error("Error fetching grade visibility:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const setGradeVisibility = async (req, res) => {
  try {
    const { section_id: sectionId, gradeLevelId } = req.advisorySection;
    const teacherId = req.teacherId;
    const { gradingPeriodId, studentIds, visible, applyToAll } = req.body;

    if (!gradingPeriodId) {
      return res
        .status(400)
        .json({ success: false, message: "gradingPeriodId is required." });
    }
    if (typeof visible !== "boolean") {
      return res
        .status(400)
        .json({ success: false, message: "visible (boolean) is required." });
    }

    let targetIds = Array.isArray(studentIds) ? studentIds.map(Number) : [];

    // "Select all" — re-derive the full roster server-side rather than
    // trusting a client-sent full list, so a stale list can't
    // accidentally miss (or wrongly include) a student.
    if (applyToAll) {
      const [rosterRows] = await connection.execute(
        sectionId
          ? `SELECT id FROM elem_students WHERE section_id = ? AND is_deleted = 0`
          : `SELECT id FROM elem_students WHERE grade_level_id = ? AND section_id IS NULL AND is_deleted = 0`,
        [sectionId || gradeLevelId],
      );
      targetIds = rosterRows.map((r) => r.id);
    }

    if (targetIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No students selected." });
    }

    // Verify every targeted student actually belongs to THIS advisory —
    // prevents a teacher from toggling visibility for students outside
    // their own advisory class via a crafted studentIds payload.
    const idPlaceholders = targetIds.map(() => "?").join(",");
    const [validRows] = await connection.execute(
      sectionId
        ? `SELECT id FROM elem_students WHERE id IN (${idPlaceholders}) AND section_id = ? AND is_deleted = 0`
        : `SELECT id FROM elem_students WHERE id IN (${idPlaceholders}) AND grade_level_id = ? AND section_id IS NULL AND is_deleted = 0`,
      [...targetIds, sectionId || gradeLevelId],
    );
    const validIds = validRows.map((r) => r.id);
    if (validIds.length === 0) {
      return res.status(403).json({
        success: false,
        message: "None of the selected students belong to your advisory class.",
      });
    }

    const values = validIds.map(() => `(?, ?, ?, ?)`).join(", ");
    const params = validIds.flatMap((id) => [
      id,
      gradingPeriodId,
      visible ? 1 : 0,
      teacherId,
    ]);

    await connection.execute(
      `INSERT INTO grade_visibility (student_id, grading_period_id, is_visible, updated_by)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE is_visible = VALUES(is_visible), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
      params,
    );

    return res
      .status(200)
      .json({ success: true, data: { updatedCount: validIds.length } });
  } catch (error) {
    console.error("Error updating grade visibility:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadAdvisorySection,
  getAdvisoryGradebook,
  getSubmissionStatus,
  submitAdvisoryGrades,
  getGradeVisibility,
  setGradeVisibility,
};