// modules/.../studentProfiles.controller.js
const connection = require('../../../../../config/db');

/**
 * GET /:studentId
 * Kunin yung full profile data ng isang student para sa StudentProfileData shape
 */
async function getStudentProfile(req, res) {
  const { studentId } = req.params;

  try {
    const [rows] = await connection.query(
      `SELECT 
         s.id,
         s.student_number,
         s.learner_reference_number,
         s.last_name,
         s.first_name,
         s.middle_name,
         s.gender,
         s.date_of_birth,
         s.resdential_address,
         s.parent_guardian_name,
         s.is_deleted,
         gl.grade_level   AS grade_level_name,
         gls.section_name AS section_name,
         t.first_name     AS adviser_first_name,
         t.last_name      AS adviser_last_name,
         sy.school_year   AS school_year_name
       FROM elem_students s
       LEFT JOIN grade_level gl ON s.grade_level_id = gl.id
       LEFT JOIN grade_level_sections gls ON s.section_id = gls.id
       LEFT JOIN classes c ON c.section_id = s.section_id
       LEFT JOIN teacher_table t ON c.class_adviser_id = t.id
       LEFT JOIN school_year sy ON sy.is_active = 1
       WHERE s.id = ? AND s.is_deleted = 0
       LIMIT 1`,
      [studentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Student not found" });
    }

    return res.status(200).json(mapRowToProfile(rows[0]));
  } catch (error) {
    console.error("getStudentProfile error:", error);
    return res.status(500).json({ message: "Failed to fetch student profile" });
  }
}

/**
 * PATCH /:studentId
 * Body: { dateOfBirth: string | null, residentialAddress: string | null }
 *
 * Only these two fields are editable from the Personal Information card —
 * name, LRN, gender, and class stay locked, so this intentionally does not
 * accept anything else. Returns the full updated profile (same shape as GET)
 * so the frontend can just drop the response straight into state.
 */
async function updateStudentProfile(req, res) {
  const { studentId } = req.params;
  let { dateOfBirth, residentialAddress } = req.body ?? {};

  // Normalize blank strings (e.g. an untouched <input type="date"> defaulting
  // to "") to null — "" is "not specified", not an invalid date, and should
  // never reach Date.parse.
  if (typeof dateOfBirth === "string" && dateOfBirth.trim() === "") {
    dateOfBirth = null;
  }
  if (typeof residentialAddress === "string" && residentialAddress.trim() === "") {
    residentialAddress = null;
  }

  // Basic shape validation — reject the request rather than silently writing
  // undefined/garbage into the row.
  if (dateOfBirth !== undefined && dateOfBirth !== null && typeof dateOfBirth !== "string") {
    return res.status(400).json({ message: "dateOfBirth must be a string (ISO date) or null" });
  }
  if (
    residentialAddress !== undefined &&
    residentialAddress !== null &&
    typeof residentialAddress !== "string"
  ) {
    return res.status(400).json({ message: "residentialAddress must be a string or null" });
  }
  if (dateOfBirth !== undefined && dateOfBirth !== null && Number.isNaN(Date.parse(dateOfBirth))) {
    return res.status(400).json({ message: "dateOfBirth is not a valid date" });
  }

  try {
    const [existing] = await connection.query(
      `SELECT id FROM elem_students WHERE id = ? AND is_deleted = 0 LIMIT 1`,
      [studentId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "Student not found" });
    }

    await connection.query(
      `UPDATE elem_students
       SET date_of_birth = ?, resdential_address = ?
       WHERE id = ? AND is_deleted = 0`,
      [dateOfBirth ?? null, residentialAddress ?? null, studentId]
    );

    const [rows] = await connection.query(
      `SELECT 
         s.id,
         s.student_number,
         s.learner_reference_number,
         s.last_name,
         s.first_name,
         s.middle_name,
         s.gender,
         s.date_of_birth,
         s.resdential_address,
         s.parent_guardian_name,
         s.is_deleted,
         gl.grade_level   AS grade_level_name,
         gls.section_name AS section_name,
         t.first_name     AS adviser_first_name,
         t.last_name      AS adviser_last_name,
         sy.school_year   AS school_year_name
       FROM elem_students s
       LEFT JOIN grade_level gl ON s.grade_level_id = gl.id
       LEFT JOIN grade_level_sections gls ON s.section_id = gls.id
       LEFT JOIN classes c ON c.section_id = s.section_id
       LEFT JOIN teacher_table t ON c.class_adviser_id = t.id
       LEFT JOIN school_year sy ON sy.is_active = 1
       WHERE s.id = ? AND s.is_deleted = 0
       LIMIT 1`,
      [studentId]
    );

    return res.status(200).json(mapRowToProfile(rows[0]));
  } catch (error) {
    console.error("updateStudentProfile error:", error);
    return res.status(500).json({ message: "Failed to update student profile" });
  }
}

/**
 * Shared row -> StudentProfileData mapper, dati ay nasa loob lang ng
 * getStudentProfile. Nilabas para magamit din ng updateStudentProfile
 * pagkatapos ng UPDATE, iisang shape lagi ang pauwi sa frontend.
 */
function mapRowToProfile(row) {
  const gradeLevel = row.grade_level_name || "Not specified";
  const section = row.section_name || "Not specified";
  const middleInitial = row.middle_name ? `${row.middle_name.charAt(0)}.` : undefined;

  const fullName = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" ");

  const adviser =
    row.adviser_first_name && row.adviser_last_name
      ? `${row.adviser_first_name} ${row.adviser_last_name}`
      : undefined;

  return {
    id: String(row.id),
    lastName: row.last_name,
    firstName: row.first_name,
    middleInitial,
    studentId: row.student_number || null,
    lrn: row.learner_reference_number || null,
    gradeLevel,
    section,
    gender: row.gender || null,
    status: row.is_deleted ? "Inactive" : "Active", // Transferred/Graduated wala pang column source
    adviser,
    schoolYear: row.school_year_name || undefined,
    personalInformation: {
      fullName,
      studentLrn: row.learner_reference_number || null,
      gender: row.gender || null,
      currentClass: `${gradeLevel} - ${section}`,
      dateOfBirth: row.date_of_birth || null,
      residentialAddress: row.resdential_address || null,
    },
  };
}

module.exports = { getStudentProfile, updateStudentProfile };