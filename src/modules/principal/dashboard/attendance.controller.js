const connection = require("../../../../config/db");

exports.getTodaysAttendance = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT
         SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS present,
         SUM(CASE WHEN status = 'A' THEN 1 ELSE 0 END) AS absent,
         SUM(CASE WHEN status IN ('L', 'E') THEN 1 ELSE 0 END) AS concerning
       FROM advisory_attendance_records
       WHERE attendance_date = CURDATE()`,
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
    // 1) Master roster: bawat grade level + section combo, kasama total enrolled students.
    //    Ito ang source of truth para sa denominator (hindi yung attendance table),
    //    kaya lalabas pa rin yung section kahit wala pang naitatala today.
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
      LEFT JOIN elem_students es
        ON es.grade_level_id = gl.id
        AND (
          es.section_id = gls.id
          OR (gls.id IS NULL AND es.section_id IS NULL)
        )
        AND es.is_deleted = 0
      GROUP BY gl.id, gl.grade_level, gls.id, gls.section_name
      ORDER BY gl.id, gls.id
    `);

    // 2) Aktwal na attendance ngayong araw.
    //
    //    IMPORTANT: dinededupe muna dito gamit ROW_NUMBER() bago i-SUM.
    //    Dahil ang unique key sa advisory_attendance_records ay
    //    (class_id, student_id, attendance_date), at si class_id ay
    //    nullable, posibleng magkaroon ng 2+ records para sa parehong
    //    student sa parehong araw kapag class_id = NULL (hindi
    //    na-eenforce ng MySQL ang uniqueness pag NULL ang column).
    //    Kaya kunin lang natin yung pinaka-huling na-update na record
    //    per (student_id, attendance_date) - yun ang totoong/current
    //    status ng estudyante for the day.
    const [attendanceRows] = await connection.query(`
      WITH latest_attendance AS (
        SELECT
          aar.*,
          ROW_NUMBER() OVER (
            PARTITION BY aar.student_id, aar.attendance_date
            ORDER BY aar.updated_at DESC, aar.id DESC
          ) AS rn
        FROM advisory_attendance_records aar
        WHERE aar.attendance_date = CURDATE()
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

    // Index ng today's attendance by sectionId ("grade-{id}" key = grade na walang section)
    const attendanceBySection = new Map();
    attendanceRows.forEach((row) => {
      const key = row.sectionId ?? `grade-${row.gradeLevelId}`;
      attendanceBySection.set(key, {
        present: Number(row.present) || 0,
        absent: Number(row.absent) || 0,
        recordedTotal: Number(row.recordedTotal) || 0,
      });
    });

    // 3) I-build yung grade -> sections map, galing sa roster (hindi sa attendance)
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
        section: row.section, // null kapag grade na walang section
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

    // 4) I-shape yung final response per grade level
    const result = [];

    for (const gradeData of gradeMap.values()) {
      const sectionCount = gradeData.sections.length;

      if (sectionCount >= 2) {
        // Maraming section -> bar uses combined rate, tooltip breaks it down per section.
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
        // 1 o 0 section -> isang bar lang, wala nang kailangang i-breakdown.
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