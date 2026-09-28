const connection = require("../../../../config/db");

// Active school year id (subquery na ginagamit sa lahat ng queries)
const ACTIVE_SY = `(SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)`;

exports.getTodaysAttendance = async (req, res) => {
  try {

    const [rows] = await connection.query(
      `WITH latest_attendance AS (
         SELECT
           aar.status,
           ROW_NUMBER() OVER (
             PARTITION BY aar.student_id, aar.attendance_date
             ORDER BY aar.updated_at DESC, aar.id DESC
           ) AS rn
         FROM advisory_attendance_records aar
         JOIN elem_students es
           ON es.id = aar.student_id
           AND es.is_deleted = 0
           AND es.status <> 'graduated'
           AND es.current_school_year_id = ${ACTIVE_SY}
         LEFT JOIN grading_periods gp
           ON gp.id = aar.grading_period_id
         WHERE aar.attendance_date = CURDATE()
           AND (aar.grading_period_id IS NULL OR gp.school_year_id = ${ACTIVE_SY})
       )
       SELECT
         SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS present,
         SUM(CASE WHEN status = 'A' THEN 1 ELSE 0 END) AS absent,
         SUM(CASE WHEN status IN ('L', 'E') THEN 1 ELSE 0 END) AS concerning
       FROM latest_attendance
       WHERE rn = 1`,
    );

    const row = rows[0] || {};

    return res.status(200).json({
      present: Number(row.present) || 0,
      absent: Number(row.absent) || 0,
      concerning: Number(row.concerning) || 0,
    });
  } catch (error) {
    console.error("getTodaysAttendance error:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch today's attendance." });
  }
};

exports.getAttendanceByGrade = async (req, res) => {
  try {

    const [rosterRows] = await connection.query(`
      SELECT
        gl.id AS gradeLevelId,
        gl.grade_level AS grade,
        gls.id AS sectionId,
        gls.section_name AS section,
        COUNT(es.id) AS totalEnrolled
      FROM grade_level gl
      LEFT JOIN grade_level_sections gls
        ON gls.grade_level_id = gl.id
        AND (gls.school_year_id IS NULL OR gls.school_year_id = ${ACTIVE_SY})
      LEFT JOIN elem_students es
        ON es.grade_level_id = gl.id
        AND (
          es.section_id = gls.id
          OR (gls.id IS NULL AND es.section_id IS NULL)
        )
        AND es.is_deleted = 0
        AND es.status <> 'graduated'
        AND es.current_school_year_id = ${ACTIVE_SY}
      GROUP BY gl.id, gl.grade_level, gls.id, gls.section_name
      ORDER BY gl.id, gls.id
    `);

    const [attendanceRows] = await connection.query(`
      WITH latest_attendance AS (
        SELECT
          aar.*,
          ROW_NUMBER() OVER (
            PARTITION BY aar.student_id, aar.attendance_date
            ORDER BY aar.updated_at DESC, aar.id DESC
          ) AS rn
        FROM advisory_attendance_records aar
        JOIN elem_students es
          ON es.id = aar.student_id
          AND es.is_deleted = 0
          AND es.status <> 'graduated'
          AND es.current_school_year_id = ${ACTIVE_SY}
        LEFT JOIN grading_periods gp
          ON gp.id = aar.grading_period_id
        WHERE aar.attendance_date = CURDATE()
          AND (aar.grading_period_id IS NULL OR gp.school_year_id = ${ACTIVE_SY})
      )
      SELECT
        COALESCE(c.section_id, la.section_id) AS sectionId,
        gl.id AS gradeLevelId,
        SUM(CASE WHEN la.status = 'P' THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN la.status = 'A' THEN 1 ELSE 0 END) AS absent,
        COUNT(*) AS recordedTotal
      FROM latest_attendance la
      LEFT JOIN classes c ON la.class_id = c.id
      LEFT JOIN grade_level_sections gls
        ON la.section_id = gls.id OR c.section_id = gls.id
      JOIN grade_level gl
        ON gl.id = COALESCE(c.grade_level_id, gls.grade_level_id)
      WHERE la.rn = 1
      GROUP BY sectionId, gl.id
    `);

    const attendanceBySection = new Map();
    attendanceRows.forEach((row) => {
      const key = row.sectionId ?? `grade-${row.gradeLevelId}`;
      attendanceBySection.set(key, {
        present: Number(row.present) || 0,
        absent: Number(row.absent) || 0,
        recordedTotal: Number(row.recordedTotal) || 0,
      });
    });

    const gradeMap = new Map();

    rosterRows.forEach((row) => {
      const gradeId = row.gradeLevelId;

      if (!gradeMap.has(gradeId)) {
        gradeMap.set(gradeId, {
          gradeLevelId: gradeId,
          grade: row.grade,
          sections: [],
        });
      }

      const gradeData = gradeMap.get(gradeId);
      const totalEnrolled = Number(row.totalEnrolled) || 0;

      const key = row.sectionId ?? `grade-${gradeId}`;
      const attendance = attendanceBySection.get(key) || {
        present: 0,
        absent: 0,
        recordedTotal: 0,
      };

      const hasRecorded = attendance.recordedTotal > 0;

      gradeData.sections.push({
        sectionId: row.sectionId,
        section: row.section, 
        present: attendance.present,
        absent: attendance.absent,
        total: totalEnrolled,
        attendance:
          totalEnrolled > 0
            ? Number(((attendance.present / totalEnrolled) * 100).toFixed(1))
            : 0,
        hasRecorded,
      });
    });

    const result = [];

    for (const gradeData of gradeMap.values()) {
      const sectionCount = gradeData.sections.length;

      if (sectionCount >= 2) {
        const gradePresent = gradeData.sections.reduce((sum, s) => sum + s.present, 0);
        const gradeAbsent = gradeData.sections.reduce((sum, s) => sum + s.absent, 0);
        const gradeTotal = gradeData.sections.reduce((sum, s) => sum + s.total, 0);

        const attendance =
          gradeTotal > 0
            ? Number(((gradePresent / gradeTotal) * 100).toFixed(1))
            : 0;

        result.push({
          gradeLevelId: gradeData.gradeLevelId,
          grade: gradeData.grade,
          type: "section",
          present: gradePresent,
          absent: gradeAbsent,
          total: gradeTotal,
          attendance,
          sections: gradeData.sections,
        });
      } else {

        const single = gradeData.sections[0] || {
          present: 0,
          absent: 0,
          total: 0,
          attendance: 0,
          hasRecorded: false,
        };

        result.push({
          gradeLevelId: gradeData.gradeLevelId,
          grade: gradeData.grade,
          type: "grade",
          present: single.present,
          absent: single.absent,
          total: single.total,
          attendance: single.attendance,
          hasRecorded: single.hasRecorded,
        });
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("getAttendanceByGrade error:", error);

    return res.status(500).json({
      message: "Failed to fetch attendance by grade.",
    });
  }
};