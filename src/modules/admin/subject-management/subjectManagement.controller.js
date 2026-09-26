const connection = require("../../../../config/db");

exports.getSubjectSectionsByGrade = async (req, res) => {
  const { gradeLevel } = req.params;

  try {
    const query = `
      SELECT 
        ss.id             AS id,
        es.id             AS subject_id,
        es.subject_name   AS subject_name,
        es.grade_level_id AS grade_level_id,
        es.is_graded      AS is_graded,
        gls.section_name  AS section_name,
        ss.teacher_id     AS teacher_id,
        sy.school_year    AS school_year,
        ss.status         AS status
      FROM \`subject-section\` ss
      JOIN elem_subjects es        ON es.id = ss.subject_id
      LEFT JOIN grade_level_sections gls ON gls.id = ss.section_id
      JOIN school_year sy          ON sy.id = ss.school_year_id
      WHERE es.grade_level_id = ?
        AND sy.is_active = 1
      ORDER BY es.subject_name ASC
    `;

    const [rows] = await connection.query(query, [gradeLevel]);

    if (rows.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const subjectIds = [...new Set(rows.map((r) => r.subject_id))];

    const [weightRows] = await connection.query(
      `SELECT swd.id, swd.subject_id, swd.assessment_type_id,
              at.assessment_name AS assessmentName,
              swd.weight_percent, swd.order_index
         FROM subject_weight_distribution swd
         LEFT JOIN assessment_type at ON at.id = swd.assessment_type_id
        WHERE swd.subject_id IN (?)
        ORDER BY swd.order_index ASC`,
      [subjectIds]
    );

    const weightsBySubject = weightRows.reduce((acc, w) => {
      (acc[w.subject_id] ??= []).push({
        id: w.id,
        assessment_type_id: w.assessment_type_id,
        assessmentName: w.assessmentName,
        weight_percent: w.weight_percent,
        order_index: w.order_index,
      });
      return acc;
    }, {});

    const data = rows.map((r) => ({
      ...r,
      is_graded: Boolean(r.is_graded),
      weightDistribution: weightsBySubject[r.subject_id] ?? [],
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

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

// Bagong function: para lang sa "Add Subject" modal — grade level + subject name lang
// ang nase-save, diretso sa elem_subjects (catalog). Hiwalay ito sa addSubjectSection,
// na siyang nag-a-assign ng subject sa isang section+teacher+school year.
exports.addSubject = async (req, res) => {
  const { gradeLevelId, subjectName, isGraded, schoolYear, weightDistribution } = req.body;
  // weightDistribution example (array, isang row per assessment type):
  // [
  //   { assessment_type_id: 1, weight_percent: 30, order_index: 1 }, // Written Works
  //   { assessment_type_id: 2, weight_percent: 50, order_index: 2 }, // Performance Task
  //   { assessment_type_id: 3, weight_percent: 20, order_index: 3 }  // Quarterly Exam
  // ]

  if (!gradeLevelId || !subjectName) {
    return res.status(400).json({
      success: false,
      message: "gradeLevelId and subjectName are required.",
    });
  }

  // I-validate ang weightDistribution kapag may laman ito (regardless ng isGraded,
  // dahil structurally invalid ang duplicate assessment type kahit anong flag)
  if (weightDistribution && weightDistribution.length > 0) {
    // 1. Check for duplicate assessment_type_id
    const seen = new Set();
    const duplicates = new Set();

    for (const w of weightDistribution) {
      const typeId = Number(w.assessment_type_id);
      if (seen.has(typeId)) {
        duplicates.add(typeId);
      }
      seen.add(typeId);
    }

    if (duplicates.size > 0) {
      return res.status(400).json({
        success: false,
        message: `Duplicated assessment type`,
      });
    }

    // 2. Kung graded ang subject, i-validate na 100% ang total weight
    if (isGraded) {
      const totalWeight = weightDistribution.reduce(
        (sum, w) => sum + Number(w.weight_percent),
        0
      );
      if (Math.abs(totalWeight - 100) > 0.5) {
        return res.status(400).json({
          success: false,
          message: `Weight distribution must total 100%. Current total: ${totalWeight}%.`,
        });
      }
    }
  }

  const conn = await connection.getConnection();

  try {
    await conn.beginTransaction();

    // Guard: baka meron nang ganitong subject sa parehong grade level
    const [existing] = await conn.query(
      `SELECT id FROM elem_subjects WHERE subject_name = ? AND grade_level_id = ? LIMIT 1`,
      [subjectName, gradeLevelId]
    );
    if (existing.length > 0) {
      await conn.rollback();
      conn.release();
      return res.status(409).json({
        success: false,
        message: `"${subjectName}" already exists for this grade level.`,
      });
    }

    // 1. Insert sa elem_subjects
    const [result] = await conn.query(
      `INSERT INTO elem_subjects (subject_name, grade_level_id, is_graded) VALUES (?, ?, ?)`,
      [subjectName, gradeLevelId, isGraded]
    );

    const newSubjectId = result.insertId;

    // 2. Insert sa subject_weight_distribution — isang row per assessment type
    if (weightDistribution && weightDistribution.length > 0) {
      const values = weightDistribution.map((w, index) => [
        newSubjectId,
        w.assessment_type_id,
        w.weight_percent,
        w.order_index ?? index,
      ]);

      await conn.query(
        `INSERT INTO subject_weight_distribution
          (subject_id, assessment_type_id, weight_percent, order_index)
         VALUES ?`,
        [values]
      );
    }

    await conn.commit();
    conn.release();

    return res.status(201).json({
      success: true,
      message: "Subject added successfully.",
      data: {
        id: newSubjectId,
        subject_name: subjectName,
        grade_level_id: gradeLevelId,
        is_graded: isGraded,
        schoolYear: schoolYear ?? null,
        weight_distribution: weightDistribution ?? null,
        status: "Active",
      },
    });
  } catch (error) {
    await conn.rollback();
    conn.release();
    console.error("Database Error:", error);

    // Foreign key violation — invalid assessment_type_id
    if (error.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({
        success: false,
        message:
          "Invalid assessment_type_id in weightDistribution. Make sure it exists in the assessment_type table.",
      });
    }

    // Duplicate entry sa DB level (safety net kung meron kang UNIQUE KEY
    // (subject_id, assessment_type_id) sa subject_weight_distribution table)
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(400).json({
        success: false,
        message: "Duplicate assessment type detected in weight distribution.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};


exports.updateSubjectSection = async (req, res) => {
  const { id } = req.params;
  const {
    isGraded,
    weightDistribution,
    subjectName,
    gradeLevelId,
    sectionName,
    teacherId,
    schoolYear,
  } = req.body;
  // weightDistribution (optional): array na katulad ng sa addSubject
  // [
  //   { assessment_type_id: 1, weight_percent: 30, order_index: 1 }, // Written Works
  //   { assessment_type_id: 2, weight_percent: 50, order_index: 2 }, // Performance Task
  //   { assessment_type_id: 3, weight_percent: 20, order_index: 3 }  // Quarterly Exam
  // ]

  if (!id || isNaN(Number(id))) {
    return res.status(400).json({
      success: false,
      message: "Valid subject assignment id is required.",
    });
  }

  if (typeof isGraded !== "boolean") {
    return res.status(400).json({
      success: false,
      message: "isGraded is required.",
    });
  }

  if (subjectName !== undefined && !String(subjectName).trim()) {
    return res.status(400).json({ success: false, message: "Subject name is required." });
  }
  if (gradeLevelId !== undefined && (!Number.isInteger(Number(gradeLevelId)) || Number(gradeLevelId) < 1)) {
    return res.status(400).json({ success: false, message: "Select a valid grade level." });
  }
  if (schoolYear !== undefined && !String(schoolYear).trim()) {
    return res.status(400).json({ success: false, message: "Select a valid school year." });
  }
  if (sectionName !== undefined && !String(sectionName ?? "").trim()) {
    return res.status(400).json({ success: false, message: "Select a section." });
  }

  const hasWeights =
    Array.isArray(weightDistribution) && weightDistribution.length > 0;

  // Validate ang payload bago pa mag-open ng connection
  if (hasWeights) {
    // 1. Duplicate assessment_type_id — structurally invalid kahit anong flag
    const seen = new Set();
    const duplicates = new Set();

    for (const w of weightDistribution) {
      const typeId = Number(w.assessment_type_id);
      if (!typeId || isNaN(typeId)) {
        return res.status(400).json({
          success: false,
          message: "Each weight entry requires a valid assessment_type_id.",
        });
      }
      if (seen.has(typeId)) duplicates.add(typeId);
      seen.add(typeId);
    }

    if (duplicates.size > 0) {
      return res.status(400).json({
        success: false,
        message: `Duplicated assessment type: ${[...duplicates].join(", ")}`,
      });
    }

    // 2. Kung graded, dapat 100% ang total
    if (isGraded) {
      const totalWeight = weightDistribution.reduce(
        (sum, w) => sum + Number(w.weight_percent),
        0
      );
      if (totalWeight !== 100) {
        return res.status(400).json({
          success: false,
          message: `Weight distribution must total 100%. Current total: ${totalWeight}%.`,
        });
      }
    }
  }

  const conn = await connection.getConnection();

  try {
    await conn.beginTransaction();

    const [existingRows] = await conn.query(
      `SELECT ss.subject_id, ss.section_id, ss.teacher_id, ss.school_year_id,
              es.subject_name, es.grade_level_id, gls.section_name
         FROM \`subject-section\` ss
         JOIN elem_subjects es ON es.id = ss.subject_id
         LEFT JOIN grade_level_sections gls ON gls.id = ss.section_id
        WHERE ss.id = ? LIMIT 1 FOR UPDATE`,
      [id]
    );
    if (existingRows.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({
        success: false,
        message: "Subject assignment not found.",
      });
    }
    const subjectId = existingRows[0].subject_id;
    const existing = existingRows[0];
    const nextName = String(subjectName ?? existing.subject_name).trim();
    const nextGradeLevelId = Number(gradeLevelId ?? existing.grade_level_id);
    const gradeChanged = nextGradeLevelId !== Number(existing.grade_level_id);

    if (nextName.toLowerCase() !== String(existing.subject_name).trim().toLowerCase() || gradeChanged) {
      const [duplicateSubjects] = await conn.query(
        `SELECT id FROM elem_subjects
          WHERE LOWER(TRIM(subject_name)) = LOWER(TRIM(?))
            AND grade_level_id = ? AND id <> ? LIMIT 1`,
        [nextName, nextGradeLevelId, subjectId]
      );
      if (duplicateSubjects.length > 0) {
        await conn.rollback();
        conn.release();
        return res.status(409).json({ success: false, message: `A subject named "${nextName}" already exists for this grade level.` });
      }
    }

    const nextSectionName = sectionName === undefined ? existing.section_name : String(sectionName ?? "").trim();
    let nextSectionId = existing.section_id;
    if (gradeChanged || sectionName !== undefined) {
      nextSectionId = null;
      if (nextSectionName) {
        const [sectionRows] = await conn.query(
          `SELECT id FROM grade_level_sections
            WHERE section_name = ? AND grade_level_id = ? AND is_active = 1 LIMIT 1`,
          [nextSectionName, nextGradeLevelId]
        );
        if (sectionRows.length === 0) {
          await conn.rollback();
          conn.release();
          return res.status(400).json({ success: false, message: `Section "${nextSectionName}" is not available for the selected grade level.` });
        }
        nextSectionId = sectionRows[0].id;
      }
    }

    let nextSchoolYearId = existing.school_year_id;
    if (schoolYear !== undefined) {
      const [schoolYearRows] = await conn.query(
        `SELECT id FROM school_year WHERE school_year = ? LIMIT 1`,
        [String(schoolYear).trim()]
      );
      if (schoolYearRows.length === 0) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ success: false, message: "The selected school year does not exist." });
      }
      nextSchoolYearId = schoolYearRows[0].id;
    }

    if (gradeChanged) {
      const [assignments] = await conn.query(
        `SELECT ss.id, gls.section_name
           FROM \`subject-section\` ss
           LEFT JOIN grade_level_sections gls ON gls.id = ss.section_id
          WHERE ss.subject_id = ? FOR UPDATE`,
        [subjectId]
      );
      for (const assignment of assignments) {
        const assignmentSectionName = Number(assignment.id) === Number(id)
          ? nextSectionName
          : assignment.section_name;
        if (!assignmentSectionName) {
          if (Number(assignment.id) === Number(id)) {
            await conn.query(`UPDATE \`subject-section\` SET section_id = NULL WHERE id = ?`, [assignment.id]);
          }
          continue;
        }
        const [mappedSections] = await conn.query(
          `SELECT id FROM grade_level_sections
            WHERE section_name = ? AND grade_level_id = ? AND is_active = 1 LIMIT 1`,
          [assignmentSectionName, nextGradeLevelId]
        );
        if (mappedSections.length === 0) {
          await conn.rollback();
          conn.release();
          return res.status(400).json({
            success: false,
            message: `Cannot move this subject to ${nextGradeLevelId}: create section "${assignmentSectionName}" for that grade first.`,
          });
        }
        await conn.query(
          `UPDATE \`subject-section\` SET section_id = ? WHERE id = ?`,
          [mappedSections[0].id, assignment.id]
        );
      }
    } else if (sectionName !== undefined) {
      await conn.query(`UPDATE \`subject-section\` SET section_id = ? WHERE id = ?`, [nextSectionId, id]);
    }

    if (teacherId !== undefined || schoolYear !== undefined) {
      await conn.query(
        `UPDATE \`subject-section\`
            SET teacher_id = ?, school_year_id = ?
          WHERE id = ?`,
        [teacherId === undefined ? existing.teacher_id : (teacherId || 0), nextSchoolYearId, id]
      );
    }

    const [duplicateAssignments] = await conn.query(
      `SELECT id FROM \`subject-section\`
        WHERE subject_id = ? AND section_id <=> ? AND school_year_id = ? AND id <> ? LIMIT 1`,
      [subjectId, nextSectionId, nextSchoolYearId, id]
    );
    if (duplicateAssignments.length > 0) {
      await conn.rollback();
      conn.release();
      return res.status(409).json({ success: false, message: "This subject is already assigned to that section and school year." });
    }

    if (isGraded && !hasWeights) {
      const [currentWeights] = await conn.query(
        `SELECT weight_percent FROM subject_weight_distribution WHERE subject_id = ?`,
        [subjectId]
      );

      const currentTotal = currentWeights.reduce(
        (sum, w) => sum + Number(w.weight_percent),
        0
      );

      if (currentWeights.length === 0 || currentTotal !== 100) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({
          success: false,
          message:
            "Graded subject requires a weight distribution totaling 100%. Please provide weightDistribution.",
        });
      }
    }

    await conn.query(`UPDATE elem_subjects SET subject_name = ?, grade_level_id = ?, is_graded = ? WHERE id = ?`, [
      nextName,
      nextGradeLevelId,
      isGraded,
      subjectId,
    ]);

    if (isGraded && hasWeights) {
      await conn.query(
        `DELETE FROM subject_weight_distribution WHERE subject_id = ?`,
        [subjectId]
      );

      const values = weightDistribution.map((w, index) => [
        subjectId,
        Number(w.assessment_type_id),
        Number(w.weight_percent),
        w.order_index ?? index,
      ]);

      await conn.query(
        `INSERT INTO subject_weight_distribution
          (subject_id, assessment_type_id, weight_percent, order_index)
         VALUES ?`,
        [values]
      );
    }

    const [finalWeights] = await conn.query(
      `SELECT swd.assessment_type_id,
              at.assessment_name AS assessmentName,
              swd.weight_percent,
              swd.order_index
         FROM subject_weight_distribution swd
         LEFT JOIN assessment_type at ON at.id = swd.assessment_type_id
        WHERE swd.subject_id = ?
        ORDER BY swd.order_index ASC`,
      [subjectId]
    );

    await conn.commit();
    conn.release();

    return res.status(200).json({
      success: true,
      message: "Subject updated successfully.",
      data: {
        id: Number(id),
        subject_id: subjectId,
        is_graded: isGraded,
        weight_distribution: finalWeights,
      },
    });
  } catch (error) {
    await conn.rollback();
    conn.release();
    console.error("Database Error:", error);

    if (error.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({
        success: false,
        message:
          "Invalid assessment_type_id in weightDistribution. Make sure it exists in the assessment_type table.",
      });
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(400).json({
        success: false,
        message: "Duplicate assessment type detected in weight distribution.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

exports.assignTeacherToSection = async (req, res) => {
  const { id } = req.params;
  const { gradeLevelId, sectionName, teacherId } = req.body;

  if (!gradeLevelId || !sectionName) {
    return res.status(400).json({
      success: false,
      message: "gradeLevelId and sectionName are required.",
    });
  }

  try {
    const [existingRows] = await connection.query(
      `SELECT id FROM \`subject-section\` WHERE id = ? LIMIT 1`,
      [id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Subject assignment not found.",
      });
    }

    const [sectionRows] = await connection.query(
      `SELECT id FROM grade_level_sections WHERE section_name = ? AND grade_level_id = ? AND is_active = 1 LIMIT 1`,
      [sectionName, gradeLevelId]
    );
    if (sectionRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Section "${sectionName}" not found for this grade level.`,
      });
    }
    const sectionId = sectionRows[0].id;

    await connection.query(
      `UPDATE \`subject-section\` SET section_id = ?, teacher_id = ? WHERE id = ?`,
      [sectionId, teacherId ?? 0, id]
    );

    return res.status(200).json({
      success: true,
      message: "Teacher assigned successfully.",
      data: {
        id: Number(id),
        section_id: sectionId,
        teacher_id: teacherId,
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

exports.toggleSubjectStatus = async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Subject assignment id is required.",
    });
  }

  try {
    const [existingRows] = await connection.query(
      `SELECT id, status FROM \`subject-section\` WHERE id = ? LIMIT 1`,
      [id]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Subject assignment not found.",
      });
    }

    const currentStatus = existingRows[0].status;
    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";

    await connection.query(
      `UPDATE \`subject-section\` SET status = ? WHERE id = ?`,
      [newStatus, id]
    );

    return res.status(200).json({
      success: true,
      message: `Subject ${newStatus === "Active" ? "activated" : "deactivated"} successfully.`,
      data: {
        id: Number(id),
        status: newStatus,
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

exports.createAssessmentType = async (req, res) => {
  const { assessmentName } = req.body;

  try {
    if (!assessmentName || !assessmentName.trim()) {
      return res.status(400).json({ message: 'assessmentType is required' });
    }

    const trimmedName = assessmentName.trim(); // gamitin ito sa check at insert

    const checkQuery = 'SELECT id FROM assessment_type WHERE assessment_name = ?';
    const [existingAssessment] = await connection.query(checkQuery, [trimmedName]);

    if (existingAssessment.length > 0) {
      return res.status(409).json({
        message: `${trimmedName} is already registered`
      });
    }

    const [result] = await connection.query(
      'INSERT INTO assessment_type (assessment_name) VALUES (?)',
      [trimmedName]
    );

    return res.status(201).json({
      success: true,
      message: 'Assessment type added successfully',
      data: {
        id: result.insertId,
        assessmentName: trimmedName
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong'
    });
  }
};

exports.getAssessmentType = async (req, res) => {
  try {
    const query = 'SELECT id, assessment_name AS assessmentName FROM assessment_type ORDER BY id DESC';
    const [assessmentTypes] = await connection.query(query);

    return res.status(200).json({
      success: true,
      message: 'Assessment types fetched successfully',
      data: assessmentTypes
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong'
    });
  }
};

exports.updateAssessmentType = async (req, res) => {
  const { id } = req.params;
  const { assessmentName } = req.body;

  try {
    if (!assessmentName || !assessmentName.trim()) {
      return res.status(400).json({ message: 'assessmentType is required' });
    }

    const trimmedName = assessmentName.trim();

    // check kung existing yung id
    const checkExistQuery = 'SELECT id FROM assessment_type WHERE id = ?';
    const [existingRecord] = await connection.query(checkExistQuery, [id]);

    if (existingRecord.length === 0) {
      return res.status(404).json({ message: 'Assessment type not found' });
    }

    // check kung yung bagong pangalan ay ginagamit na ng ibang record
    const checkDuplicateQuery = 'SELECT id FROM assessment_type WHERE assessment_name = ? AND id != ?';
    const [duplicateAssessment] = await connection.query(checkDuplicateQuery, [trimmedName, id]);

    if (duplicateAssessment.length > 0) {
      return res.status(409).json({
        message: `${trimmedName} is already registered`
      });
    }

    await connection.query(
      'UPDATE assessment_type SET assessment_name = ? WHERE id = ?',
      [trimmedName, id]
    );

    return res.status(200).json({
      success: true,
      message: 'Assessment type updated successfully',
      data: {
        id: Number(id),
        assessmentName: trimmedName
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong'
    });
  }
};

exports.deleteAssessmentType = async (req, res) => {
  const { id } = req.params;

  try {
    const checkExistQuery = 'SELECT id FROM assessment_type WHERE id = ?';
    const [existingRecord] = await connection.query(checkExistQuery, [id]);

    if (existingRecord.length === 0) {
      return res.status(404).json({ message: 'Assessment type not found' });
    }

    await connection.query('DELETE FROM assessment_type WHERE id = ?', [id]);

    return res.status(200).json({
      success: true,
      message: 'Assessment type deleted successfully'
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong'
    });
  }
};
