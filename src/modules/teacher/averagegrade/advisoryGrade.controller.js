const connection = require('../../../../config/db');

const ADVISORY_EXAM_TYPES = ["ST1", "ST2", "TE"];

async function loadAdvisorySection(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized: walang user ID na nakuha mula sa token." });
    }

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ?`,
      [authId]
    );
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const [classRows] = await connection.execute(
      `SELECT c.section_id, gls.section_name AS sectionName, gl.grade_level AS gradeLevel
       FROM classes c
       INNER JOIN grade_level_sections gls ON c.section_id = gls.id
       INNER JOIN grade_level gl ON c.grade_level_id = gl.id
       WHERE c.class_adviser_id = ?`,
      [teacherId]
    );
    if (classRows.length === 0) {
      return res.status(404).json({ success: false, message: "You are not the adviser of any section yet." });
    }

    req.teacherId = teacherId;
    req.advisorySection = classRows[0];
    next();
  } catch (error) {
    console.error("Error verifying advisory section access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

const getAdvisoryGradebook = async (req, res) => {
  try {
    const { section_id: sectionId, sectionName, gradeLevel } = req.advisorySection;
    const { gradingPeriodId } = req.query;

    if (!gradingPeriodId) {
      return res.status(400).json({ success: false, message: "gradingPeriodId is required." });
    }

    const [subjectSections] = await connection.execute(
      `SELECT ss.id AS subjectSectionId, ss.subject_id AS subjectId, es.subject_name AS subjectName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       WHERE ss.section_id = ? AND ss.status = 'Active'
       ORDER BY es.subject_name ASC`,
      [sectionId]
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
      `SELECT id, gender, first_name AS firstName, middle_name AS middleName, last_name AS lastName
       FROM elem_students
       WHERE section_id = ? AND is_deleted = 0
       ORDER BY last_name ASC, first_name ASC`,
      [sectionId]
    );

    const [items] = await connection.execute(
      `SELECT id, subject_section_id AS subjectSectionId, exam_type AS examType, max_items AS maxItems
       FROM grade_items
       WHERE subject_section_id IN (${ssPlaceholders}) AND tab = 'exams'
         AND exam_type IN ('ST1','ST2','TE') AND grading_period_id = ?`,
      [...subjectSectionIds, gradingPeriodId]
    );

    let scores = [];
    if (items.length > 0) {
      const itemIds = items.map((i) => i.id);
      const itemPlaceholders = itemIds.map(() => "?").join(",");
      const [scoreRows] = await connection.execute(
        `SELECT item_id AS itemId, student_id AS studentId, score
         FROM grade_scores
         WHERE item_id IN (${itemPlaceholders})`,
        itemIds
      );
      scores = scoreRows;
    }

    const scoreByKey = new Map(
      scores.map((s) => [`${s.studentId}:${s.itemId}`, s.score === null ? null : Number(s.score)])
    );

    const studentsOut = students.map((student) => {
      const grades = {};
      for (const ss of subjectSections) {
        const subjItems = items.filter((i) => i.subjectSectionId === ss.subjectSectionId);
        const byType = {};
        for (const type of ADVISORY_EXAM_TYPES) {
          const item = subjItems.find((i) => i.examType === type);
          if (!item) {
            byType[type] = null;
            continue;
          }
          const score = scoreByKey.get(`${student.id}:${item.id}`);
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

        grades[String(ss.subjectSectionId)] = {
          st1: byType.ST1,
          st2: byType.ST2,
          te: byType.TE,
          isComplete,
          average,
        };
      }
      return {
        studentId: String(student.id),
        firstName: student.firstName,
        lastName: student.lastName,
        middleName: student.middleName,
        gender: student.gender === "Female" ? "F" : "M",
        grades,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        sectionName,
        gradeLevel,
        subjects: subjectSections.map((s) => ({
          subjectSectionId: String(s.subjectSectionId),
          subjectId: s.subjectId,
          subjectName: s.subjectName,
        })),
        students: studentsOut,
      },
    });
  } catch (error) {
    console.error("Error building advisory gradebook:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getSubmissionStatus = async (req, res) => {
  try {
    const { section_id: sectionId } = req.advisorySection;
    const { gradingPeriodId } = req.query;

    if (!gradingPeriodId) {
      return res.status(400).json({ success: false, message: "gradingPeriodId is required." });
    }

    const [rows] = await connection.execute(
      `SELECT DATE_FORMAT(submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submittedAt
       FROM grade_submissions
       WHERE section_id = ? AND grading_period_id = ?`,
      [sectionId, gradingPeriodId]
    );

    return res.status(200).json({
      success: true,
      data: { submitted: rows.length > 0, submittedAt: rows[0]?.submittedAt ?? null },
    });
  } catch (error) {
    console.error("Error fetching submission status:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};


const submitAdvisoryGrades = async (req, res) => {
  try {
    const { section_id: sectionId } = req.advisorySection;
    const { teacherId } = req;
    const { gradingPeriodId } = req.body;

    if (!gradingPeriodId) {
      return res.status(400).json({ success: false, message: "gradingPeriodId is required." });
    }

    await connection.execute(
      `INSERT INTO grade_submissions (section_id, grading_period_id, submitted_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE submitted_by = VALUES(submitted_by), submitted_at = CURRENT_TIMESTAMP`,
      [sectionId, gradingPeriodId, teacherId]
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error submitting advisory grades:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadAdvisorySection,
  getAdvisoryGradebook,
  getSubmissionStatus,
  submitAdvisoryGrades,
};