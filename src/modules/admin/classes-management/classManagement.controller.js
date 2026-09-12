const connection = require("../../../../config/db");

// Mapping ng short day codes (frontend) papuntang full day name (DB)
const DAY_MAP = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
};

// Hahanapin (case-insensitive, trimmed) ang section sa grade_level_sections;
// kung wala pa, at may currentSectionId (ibig sabihin nag-e-edit ng pangalan
// ng section na naka-link na sa class na ito), i-RENAME na lang ang existing
// row imbes na gumawa ng bago — para hindi mag-iwan ng orphaned duplicate.
// Kung wala talagang currentSectionId, saka lang gagawa ng bagong section.
// Returns null kung blangko/walang section name.
async function resolveSectionId(conn, sectionName, gradeLevelId, currentSectionId = null) {
  const cleaned = sectionName && String(sectionName).trim();
  if (!cleaned) return null;

  const [existing] = await conn.query(
    `SELECT id FROM grade_level_sections 
     WHERE grade_level_id = ? AND LOWER(TRIM(section_name)) = LOWER(?) 
     LIMIT 1`,
    [gradeLevelId, cleaned],
  );
  if (existing.length > 0) return existing[0].id;

  if (currentSectionId) {
    await conn.query(
      `UPDATE grade_level_sections SET section_name = ?, grade_level_id = ? WHERE id = ?`,
      [cleaned, gradeLevelId, currentSectionId],
    );
    return currentSectionId;
  }

  const [inserted] = await conn.query(
    `INSERT INTO grade_level_sections (section_name, grade_level_id) VALUES (?, ?)`,
    [cleaned, gradeLevelId],
  );
  return inserted.insertId;
}

exports.createClass = async (req, res) => {
  const { gradeLevel, section, room, adviserId, schedule } = req.body;
  // "section" ay text input na ngayon (section name), hindi na section_id

  let conn;

  try {
    conn = await connection.getConnection(); // FIX: dating `connection.execute` (function reference, hindi connection)
    await conn.beginTransaction();

    const sectionId = await resolveSectionId(conn, section, gradeLevel);

    // 0. Isang class lang dapat kada section... pero kapag walang section
    // (single-section grade level), isang "walang-section" class lang din
    // dapat kada grade level.
    if (sectionId !== null) {
      const [existingClassForSection] = await conn.query(
        `SELECT id FROM classes WHERE section_id = ? LIMIT 1`,
        [sectionId],
      );
      if (existingClassForSection.length > 0) {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: "Ang section na ito ay may class na. I-edit na lang ang existing class.",
        });
      }
    } else {
      const [existingNoSectionClass] = await conn.query(
        `SELECT id FROM classes WHERE grade_level_id = ? AND section_id IS NULL LIMIT 1`,
        [gradeLevel],
      );
      if (existingNoSectionClass.length > 0) {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: "Mayroon nang class na walang section sa grade level na ito.",
        });
      }
    }

    // 0b. Kunin ang active school year — kailangan ito para sa subject-section rows
    const [activeSY] = await conn.query(
      `SELECT id FROM school_year WHERE is_active = 1 LIMIT 1`,
    );
    if (activeSY.length === 0) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Walang active school year na naka-set.",
      });
    }
    const schoolYearId = activeSY[0].id;

    // 1. Insert sa `classes` table
    const classesQuery = `
      INSERT INTO classes (grade_level_id, section_id, room , class_adviser_id) 
      VALUES (?, ?, ?, ?)
    `;
    const [classResult] = await conn.query(classesQuery, [
      gradeLevel,
      sectionId,
      room,
      adviserId,
    ]);

    const newClassId = classResult.insertId;

    // 2. I-loop ang schedule
    if (schedule && Array.isArray(schedule) && schedule.length > 0) {
      for (const period of schedule) {
        const { subject, teacherId, startTime, endTime, days } = period;

        let subjectId;

        const [existingSubject] = await conn.query(
          `SELECT id FROM elem_subjects WHERE subject_name = ? AND grade_level_id = ?`,
          [subject, gradeLevel],
        );

        if (existingSubject.length > 0) {
          subjectId = existingSubject[0].id;
        } else {
          const [newSubjectResult] = await conn.query(
            `INSERT INTO elem_subjects (subject_name, grade_level_id) VALUES (?, ?)`,
            [subject, gradeLevel],
          );
          subjectId = newSubjectResult.insertId;
        }

        const scheduleQuery = `
          INSERT INTO class_schedule (class_id, subject_name, subject_teacher_id, start_time, end_time)
          VALUES (?, ?, ?, ?, ?)
        `;
        const [scheduleResult] = await conn.query(scheduleQuery, [
          newClassId,
          subject,
          teacherId,
          startTime,
          endTime,
        ]);

        const newScheduleId = scheduleResult.insertId;

        if (days && Array.isArray(days) && days.length > 0) {
          const daysQuery = `
            INSERT INTO class_schedule_day (class_schedule_id, day_of_week)
            VALUES (?, ?)
          `;

          for (const day of days) {
            const fullDayName = DAY_MAP[day] || day;
            await conn.query(daysQuery, [newScheduleId, fullDayName]);
          }
        }

        // 2b. I-sync din sa subject-section — dito kumukuha ang "My Subjects"
        // ng teacher, kaya kailangan laging naka-align sa schedule.
        //
        // IMPORTANT: ang unique key ng `subject-section` ay
        // (subject_id, section_id, school_year_id) — WALANG teacher_id.
        // Kaya kahit "bagong" class ito, posibleng may existing row na
        // (halimbawa: nagawa na dati pero nabura yung class), kaya i-check
        // muna dito bago mag-INSERT para hindi mag-duplicate-key error.
        const [existingSubjectSection] = await conn.query(
          sectionId === null
            ? `SELECT id, status FROM \`subject-section\`
               WHERE subject_id = ? AND section_id IS NULL AND school_year_id = ?`
            : `SELECT id, status FROM \`subject-section\`
               WHERE subject_id = ? AND section_id = ? AND school_year_id = ?`,
          sectionId === null
            ? [subjectId, schoolYearId]
            : [subjectId, sectionId, schoolYearId],
        );

        if (existingSubjectSection.length === 0) {
          await conn.query(
            `INSERT INTO \`subject-section\` (subject_id, section_id, teacher_id, school_year_id, status)
             VALUES (?, ?, ?, ?, 'Active')`,
            [subjectId, sectionId, teacherId, schoolYearId],
          );
        } else {
          await conn.query(
            `UPDATE \`subject-section\` SET teacher_id = ?, status = 'Active' WHERE id = ?`,
            [teacherId, existingSubjectSection[0].id],
          );
        }
      }
    }

    await conn.commit();

    res.status(201).json({
      success: true,
      message: "Class, subjects, and schedule created successfully!",
      classId: newClassId,
    });
  } catch (error) {
    if (conn) await conn.rollback();

    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred while saving.",
    });
  } finally {
    if (conn) conn.release();
  }
};

// Update an existing class: updates classes row, then replaces its whole
// schedule AND its subject-section assignments (parehong gine-wipe at
// re-inserted mula sa payload, tulad ng class_schedule).
exports.updateClass = async (req, res) => {
  const { id } = req.params;
  const { gradeLevel, section, room, adviserId, schedule } = req.body;

  let conn;

  try {
    conn = await connection.getConnection();
    await conn.beginTransaction();

    // 1. Confirm the class exists, kunin ang kasalukuyang values (para
    // malaman kung ano talaga ang nagbago, at yun lang ang i-a-UPDATE)
    const [existingRows] = await conn.query(
      `SELECT id, grade_level_id, section_id, room, class_adviser_id FROM classes WHERE id = ? LIMIT 1`,
      [id],
    );
    if (existingRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        message: "Class not found.",
      });
    }
    const currentClass = existingRows[0];
    const currentSectionId = currentClass.section_id;

    const sectionId = await resolveSectionId(conn, section, gradeLevel, currentSectionId);

    // 1b. Isang class lang dapat kada section (o kada grade level kung walang section)
    if (sectionId !== null) {
      const [sectionTaken] = await conn.query(
        `SELECT id FROM classes WHERE section_id = ? AND id != ? LIMIT 1`,
        [sectionId, id],
      );
      if (sectionTaken.length > 0) {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: "Ang section na ito ay may class na. Pumili ng ibang section.",
        });
      }
    } else {
      const [noSectionTaken] = await conn.query(
        `SELECT id FROM classes WHERE grade_level_id = ? AND section_id IS NULL AND id != ? LIMIT 1`,
        [gradeLevel, id],
      );
      if (noSectionTaken.length > 0) {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: "Mayroon nang class na walang section sa grade level na ito.",
        });
      }
    }

    // 1c. Kunin ang active school year
    const [activeSY] = await conn.query(
      `SELECT id FROM school_year WHERE is_active = 1 LIMIT 1`,
    );
    if (activeSY.length === 0) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Walang active school year na naka-set.",
      });
    }
    const schoolYearId = activeSY[0].id;

    if (sectionId !== currentSectionId) {
      if (currentSectionId !== null && sectionId !== null) {
        await conn.query(
          `UPDATE \`subject-section\`
           SET section_id = ?
           WHERE section_id = ? AND school_year_id = ?`,
          [sectionId, currentSectionId, schoolYearId],
        );
      } else if (currentSectionId !== null && sectionId === null) {
        await conn.query(
          `UPDATE \`subject-section\`
           SET section_id = NULL
           WHERE section_id = ? AND school_year_id = ?`,
          [currentSectionId, schoolYearId],
        );
      } else if (currentSectionId === null && sectionId !== null) {
        await conn.query(
          `UPDATE \`subject-section\` ss
           JOIN elem_subjects es ON es.id = ss.subject_id
           SET ss.section_id = ?
           WHERE ss.section_id IS NULL
             AND ss.school_year_id = ?
             AND es.grade_level_id = ?`,
          [sectionId, schoolYearId, gradeLevel],
        );
      }
    }


    const classUpdates = {};
    if (Number(gradeLevel) !== currentClass.grade_level_id) classUpdates.grade_level_id = gradeLevel;
    if (sectionId !== currentClass.section_id) classUpdates.section_id = sectionId;
    if (Number(adviserId) !== currentClass.class_adviser_id) classUpdates.class_adviser_id = adviserId;
    // NEW: isama ang room sa diff — dating hindi na-uupdate kahit nagbago sa payload
    const cleanedRoom = room !== undefined && room !== null ? String(room).trim() : "";
    const currentRoom = currentClass.room !== null && currentClass.room !== undefined ? String(currentClass.room).trim() : "";
    if (cleanedRoom !== currentRoom) classUpdates.room = cleanedRoom;

    if (Object.keys(classUpdates).length > 0) {
      const setClause = Object.keys(classUpdates)
        .map((col) => `${col} = ?`)
        .join(", ");
      await conn.query(`UPDATE classes SET ${setClause} WHERE id = ?`, [
        ...Object.values(classUpdates),
        id,
      ]);
    }

    // 3. Kunin ang kasalukuyang schedule (kasama ang days) para ma-diff sa
    // bagong payload.
    const [currentScheduleRows] = await conn.query(
      `SELECT cs.id, cs.subject_name, cs.subject_teacher_id, cs.start_time, cs.end_time,
              GROUP_CONCAT(csd.day_of_week ORDER BY csd.day_of_week) AS days
       FROM class_schedule cs
       LEFT JOIN class_schedule_day csd ON csd.class_schedule_id = cs.id
       WHERE cs.class_id = ?
       GROUP BY cs.id`,
      [id],
    );

    const newSchedule = Array.isArray(schedule) ? schedule : [];

    // Natural key dahil walang schedule-row id na ipinapasa ang frontend
    const scheduleKey = (subject, teacherId, startTime, endTime) =>
      `${subject}|${teacherId}|${startTime}|${endTime}`;

    const currentByKey = new Map();
    for (const row of currentScheduleRows) {
      currentByKey.set(
        scheduleKey(row.subject_name, row.subject_teacher_id, row.start_time, row.end_time),
        row,
      );
    }

    const matchedCurrentIds = new Set();
    // IMPORTANT FIX: ang unique key ng `subject-section` table ay
    // (subject_id, section_id, school_year_id) LANG — WALANG teacher_id.
    // Kaya isa lang ang pwedeng row per subject kada section/school year,
    // kahit sino pa ang teacher. Dating "subjectId|teacherId" ang ginagamit
    // dito bilang key, kaya kapag pinalitan ang teacher ng isang subject,
    // hindi na-match yung dati nang row (dahil magkaiba na ang teacherId),
    // at sinusubukan mag-INSERT ng panibagong row — na bumabagsak sa
    // unique constraint dahil existing na ang subject_id+section_id+
    // school_year_id combo. Ang tamang paraan: i-key base sa subjectId
    // lang, at kung may existing row na, i-UPDATE ang teacher_id nito
    // imbes na mag-insert ng bago.
    const subjectSectionKeepKeys = new Set(); // subjectId (string) na dapat manatiling Active

    for (const period of newSchedule) {
      const { subject, teacherId, startTime, endTime, days } = period;

      let subjectId;
      const [existingSubject] = await conn.query(
        `SELECT id FROM elem_subjects WHERE subject_name = ? AND grade_level_id = ?`,
        [subject, gradeLevel],
      );
      if (existingSubject.length > 0) {
        subjectId = existingSubject[0].id;
      } else {
        const [newSubjectResult] = await conn.query(
          `INSERT INTO elem_subjects (subject_name, grade_level_id) VALUES (?, ?)`,
          [subject, gradeLevel],
        );
        subjectId = newSubjectResult.insertId;
      }

      const key = scheduleKey(subject, teacherId, startTime, endTime);
      const existingPeriod = currentByKey.get(key);
      const newDaysFull = (days || []).map((d) => DAY_MAP[d] || d);
      const newDaysSorted = [...newDaysFull].sort().join(",");

      let scheduleId;
      if (existingPeriod) {
        // walang nagbago sa subject/teacher/time — panatilihin ang row,
        // i-check lang kung nagbago ang days
        matchedCurrentIds.add(existingPeriod.id);
        scheduleId = existingPeriod.id;
        const currentDaysSorted = (existingPeriod.days || "")
          .split(",")
          .filter(Boolean)
          .sort()
          .join(",");
        if (currentDaysSorted !== newDaysSorted) {
          await conn.query(`DELETE FROM class_schedule_day WHERE class_schedule_id = ?`, [scheduleId]);
          for (const day of newDaysFull) {
            await conn.query(
              `INSERT INTO class_schedule_day (class_schedule_id, day_of_week) VALUES (?, ?)`,
              [scheduleId, day],
            );
          }
        }
      } else {
        // walang match sa existing rows — bagong period ito (kasama na
        // dito ang kaso ng "pinalitan lang ang teacher" — magkaiba na ang
        // scheduleKey dahil kasama ang teacherId, kaya lalabas na "bago")
        const [scheduleResult] = await conn.query(
          `INSERT INTO class_schedule (class_id, subject_name, subject_teacher_id, start_time, end_time)
           VALUES (?, ?, ?, ?, ?)`,
          [id, subject, teacherId, startTime, endTime],
        );
        scheduleId = scheduleResult.insertId;
        for (const day of newDaysFull) {
          await conn.query(
            `INSERT INTO class_schedule_day (class_schedule_id, day_of_week) VALUES (?, ?)`,
            [scheduleId, day],
          );
        }
      }

      subjectSectionKeepKeys.add(String(subjectId));

      // 3b. i-sync ang subject-section: i-match base sa
      // (subject_id, section_id, school_year_id) — tugma sa unique key ng
      // table, hindi kasama ang teacher_id. Kung may existing row na,
      // i-UPDATE ang teacher_id (at i-reactivate kung Inactive) imbes na
      // mag-insert ng bago — dito na-fix ang ER_DUP_ENTRY na error.
      const [existingSubjectSection] = await conn.query(
        sectionId === null
          ? `SELECT id, status, teacher_id FROM \`subject-section\`
             WHERE subject_id = ? AND section_id IS NULL AND school_year_id = ?`
          : `SELECT id, status, teacher_id FROM \`subject-section\`
             WHERE subject_id = ? AND section_id = ? AND school_year_id = ?`,
        sectionId === null
          ? [subjectId, schoolYearId]
          : [subjectId, sectionId, schoolYearId],
      );

      if (existingSubjectSection.length === 0) {
        await conn.query(
          `INSERT INTO \`subject-section\` (subject_id, section_id, teacher_id, school_year_id, status)
           VALUES (?, ?, ?, ?, 'Active')`,
          [subjectId, sectionId, teacherId, schoolYearId],
        );
      } else {
        const row = existingSubjectSection[0];
        // i-update kung nagbago ang teacher, o kung hindi pa Active
        if (Number(row.teacher_id) !== Number(teacherId) || row.status !== "Active") {
          await conn.query(
            `UPDATE \`subject-section\` SET teacher_id = ?, status = 'Active' WHERE id = ?`,
            [teacherId, row.id],
          );
        }
      }
    }

    // 4. Alisin ang mga schedule row na wala nang match sa bagong payload —
    // sila lang, hindi lahat.
    const toDeleteScheduleIds = currentScheduleRows
      .filter((row) => !matchedCurrentIds.has(row.id))
      .map((row) => row.id);

    if (toDeleteScheduleIds.length > 0) {
      await conn.query(`DELETE FROM class_schedule WHERE id IN (?)`, [toDeleteScheduleIds]);
    }

    // 4b. Alisin din ang mga subject-section row na wala nang katapat sa
    // bagong schedule (yung subject mismo ay tinanggal na sa form).
    // Base na lang sa subject_id ang pagkumpara dito — kasabay ng fix sa
    // itaas, hindi na kailangan (at hindi na dapat) isama ang teacher_id.
    const [currentSubjectSections] = await conn.query(
      sectionId === null
        ? `SELECT ss.id, ss.subject_id FROM \`subject-section\` ss
           WHERE ss.section_id IS NULL AND ss.school_year_id = ?
             AND ss.subject_id IN (SELECT id FROM elem_subjects WHERE grade_level_id = ?)`
        : `SELECT ss.id, ss.subject_id FROM \`subject-section\` ss
           WHERE ss.section_id = ? AND ss.school_year_id = ?`,
      sectionId === null ? [schoolYearId, gradeLevel] : [sectionId, schoolYearId],
    );

    const toDeleteSubjectSectionIds = currentSubjectSections
      .filter((row) => !subjectSectionKeepKeys.has(String(row.subject_id)))
      .map((row) => row.id);

    if (toDeleteSubjectSectionIds.length > 0) {
      await conn.query(`DELETE FROM \`subject-section\` WHERE id IN (?)`, [toDeleteSubjectSectionIds]);
    }

    await conn.commit();

    res.status(200).json({
      success: true,
      message: "Class updated successfully!",
      classId: Number(id),
    });
  } catch (error) {
    if (conn) await conn.rollback();

    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred while updating.",
    });
  } finally {
    if (conn) conn.release();
  }
};
exports.getGradeLevels = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT id, grade_level FROM grade_level ORDER BY id ASC`,
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch grade levels." });
  }
};

// Hindi na ginagamit ng form (naging free-text input na ang section), pero
// iniwan ang endpoint na ito in case may ibang consumer.
exports.getSectionsByGrade = async (req, res) => {
  const { gradeLevelId, excludeClassId } = req.query;

  if (!gradeLevelId) {
    return res
      .status(400)
      .json({ success: false, message: "gradeLevelId is required." });
  }

  try {
    let query = `
      SELECT id, section_name FROM grade_level_sections
      WHERE grade_level_id = ?
        AND id NOT IN (
          SELECT section_id FROM classes
          WHERE section_id IS NOT NULL
    `;
    const params = [gradeLevelId];

    if (excludeClassId) {
      query += ` AND id != ?`;
      params.push(excludeClassId);
    }

    query += `
        )
      ORDER BY section_name ASC
    `;

    const [rows] = await connection.query(query, params);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch sections." });
  }
};

// Get Teachers — EXCLUDING teachers na adviser na sa ibang class, dahil
// isang adviser lang dapat kada section. Pass ?excludeClassId=<id> pag
// nag-e-edit para hindi ma-exclude yung sariling adviser ng class.
exports.getTeachers = async (req, res) => {
  const { excludeClassId } = req.query;

  try {
    let query = `
      SELECT id, first_name, last_name, middle_name, email_address, contact_number
      FROM teacher_table
      WHERE is_deleted = 0 AND status = 'active'
        AND id NOT IN (
          SELECT class_adviser_id FROM classes
    `;
    const params = [];

    if (excludeClassId) {
      query += ` WHERE id != ?`;
      params.push(excludeClassId);
    }

    query += `
        )
      ORDER BY last_name ASC
    `;

    const [rows] = await connection.query(query, params);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch teachers." });
  }
};

exports.getAllTeachers = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT id, first_name, last_name, middle_name, email_address, contact_number
       FROM teacher_table
       WHERE is_deleted = 0 AND status = 'active'
       ORDER BY last_name ASC`,
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch teachers." });
  }
};

//get subjects per grade level
exports.getSubjectsByGrade = async (req, res) => {
  const { gradeLevel } = req.params;

  try {
    const subjectsQuery = `
      SELECT 
        id,
        subject_name,
        grade_level_id
      FROM elem_subjects
      WHERE grade_level_id = ?
    `;

    const [rows] = await connection.query(subjectsQuery, [gradeLevel]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No subjects found for this grade level.",
      });
    }

    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

const ADVISER_NAME_EXPR = "CONCAT(t.first_name, ' ', t.last_name)";
// Get all classes with grade, section, room, adviser, schedule, and student count
exports.getClasses = async (req, res) => {
  try {
    const [classes] = await connection.query(`
      SELECT 
  c.id,
  gl.id   AS grade_level_id,
  gl.grade_level,
  gs.id   AS section_id,
  gs.section_name,
  c.room  AS room,
  c.class_adviser_id AS adviser_id,
  ${ADVISER_NAME_EXPR} AS adviser_name,
  t.email_address AS adviser_email,
  t.contact_number AS adviser_contact,
  (
    SELECT COUNT(*) FROM elem_students es
    WHERE es.grade_level_id = c.grade_level_id
      AND (c.section_id IS NULL OR es.section_id = c.section_id)
      AND es.is_deleted = 0
  ) AS student_count
FROM classes c
JOIN grade_level gl ON gl.id = c.grade_level_id
LEFT JOIN grade_level_sections gs ON gs.id = c.section_id
LEFT JOIN teacher_table t ON t.id = c.class_adviser_id
ORDER BY gl.id ASC, gs.section_name ASC
    `);

    if (classes.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const classIds = classes.map((c) => c.id);
    const [scheduleRows] = await connection.query(
      `
        SELECT 
  cs.id,
  cs.class_id,
  cs.subject_name,
  cs.subject_teacher_id,
  CONCAT(t2.first_name, ' ', t2.last_name) AS subject_teacher_name,
  cs.start_time,
  cs.end_time,
  GROUP_CONCAT(csd.day_of_week ORDER BY FIELD(csd.day_of_week,
    'Monday','Tuesday','Wednesday','Thursday','Friday')) AS days
FROM class_schedule cs
LEFT JOIN teacher_table t2 ON t2.id = cs.subject_teacher_id
LEFT JOIN class_schedule_day csd ON csd.class_schedule_id = cs.id
WHERE cs.class_id IN (?)
GROUP BY cs.id
ORDER BY cs.start_time ASC
      `,
      [classIds],
    );

    const scheduleByClass = {};
    for (const row of scheduleRows) {
      if (!scheduleByClass[row.class_id]) scheduleByClass[row.class_id] = [];
      scheduleByClass[row.class_id].push({
        id: row.id,
        subject: row.subject_name,
        teacherId: row.subject_teacher_id,
        teacherName: row.subject_teacher_name || "Unassigned",
        startTime: row.start_time,
        endTime: row.end_time,
        days: row.days ? row.days.split(",") : [],
      });
    }

    const data = classes.map((c) => ({
      id: c.id,
      gradeLevelId: c.grade_level_id,
      gradeLevel: c.grade_level,
      sectionId: c.section_id ?? null,
      section: c.section_name ?? null,
      room: c.room ?? null,
      adviserId: c.adviser_id,
      adviserName: c.adviser_name || "Unassigned",
      adviserEmail: c.adviser_email || null,
      adviserContact: c.adviser_contact || null,
      studentCount: c.student_count,
      schedule: scheduleByClass[c.id] || [],
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch classes." });
  }
};

// Delete class
// Delete class — kasama na ang pag-delete ng mga subject-section
// (kasama na dito ang schedule via ON DELETE CASCADE sa class_schedule).
// Ang subject-section ay hindi naka-FK sa classes, kaya kailangan
// tanggalin ito ng manu-mano base sa section_id (o grade_level_id kung
// walang section) + school_year_id, bago tanggalin ang class mismo.
exports.deleteClass = async (req, res) => {
  const { id } = req.params;
  let conn;

  try {
    conn = await connection.getConnection();
    await conn.beginTransaction();

    // 1. Kunin ang grade_level_id at section_id ng class bago ito tanggalin
    const [classRows] = await conn.query(
      `SELECT grade_level_id, section_id FROM classes WHERE id = ? LIMIT 1`,
      [id],
    );
    if (classRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        message: "Class not found.",
      });
    }
    const { grade_level_id: gradeLevelId, section_id: sectionId } = classRows[0];

    // 2. Kunin ang active school year (para matukoy kung aling subject-section
    // rows ang sa kasalukuyang school year lang dapat matanggal)
    const [activeSY] = await conn.query(
      `SELECT id FROM school_year WHERE is_active = 1 LIMIT 1`,
    );

    if (activeSY.length > 0) {
      const schoolYearId = activeSY[0].id;

      if (sectionId !== null) {
        // May section ang class — tanggalin ang lahat ng subject-section
        // na naka-link doon sa section na yun para sa active school year.
        // Mag-cacascade ito papunta sa grade_items, grade_scores,
        // learning_topics, interventions, intervention_alerts,
        // attendance_records, holistic_ratings, subject_grade_cache.
        await conn.query(
          `DELETE FROM \`subject-section\` WHERE section_id = ? AND school_year_id = ?`,
          [sectionId, schoolYearId],
        );
      } else {
        // Walang section ang class (single-section grade level) — hanapin
        // ang mga subject-section na section_id IS NULL pero ang subject
        // ay kabilang sa parehong grade level ng class na ito.
        await conn.query(
          `DELETE ss FROM \`subject-section\` ss
           JOIN elem_subjects es ON es.id = ss.subject_id
           WHERE ss.section_id IS NULL
             AND ss.school_year_id = ?
             AND es.grade_level_id = ?`,
          [schoolYearId, gradeLevelId],
        );
      }
    }

    // 3. Tanggalin ang class mismo — mag-cacascade na ito papunta sa
    // class_schedule at class_schedule_day
    await conn.query(`DELETE FROM classes WHERE id = ?`, [id]);

    await conn.commit();

    res.status(200).json({ success: true, message: "Class deleted." });
  } catch (error) {
    if (conn) await conn.rollback();
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to delete class." });
  } finally {
    if (conn) conn.release();
  }
};