const connection = require("../../../../config/db");
const ROLE_TABLES = require("../../../../config/roleTables"); 

const normalizeGender = (g) => (g ? String(g).toLowerCase() : undefined);

const buildName = (row) =>
  [row.first_name, row.middle_name, row.last_name]
    .filter((p) => p && String(p).trim())
    .join(" ");

const getTeacherExtras = async (teacherId) => {
  const [subjectRows] = await connection.execute(
    `SELECT DISTINCT es.subject_name
       FROM \`subject-section\` ss
       JOIN elem_subjects es ON es.id = ss.subject_id
      WHERE ss.teacher_id = ? AND ss.status = 'Active'`,
    [teacherId],
  );

  const [classRows] = await connection.execute(
    `SELECT gl.grade_level, gls.section_name
       FROM classes c
       JOIN grade_level gl ON gl.id = c.grade_level_id
       LEFT JOIN grade_level_sections gls ON gls.id = c.section_id
      WHERE c.class_adviser_id = ? AND c.status = 'Active'
      LIMIT 1`,
    [teacherId],
  );

  return {
    subject: subjectRows.length
      ? subjectRows.map((s) => s.subject_name).join(", ")
      : undefined,
    gradeLevel: classRows[0]?.grade_level,
    section: classRows[0]?.section_name || undefined,
  };
};

const getMyProfile = async (req, res) => {
  try {
    const authUserId = req.user?.userId;
    if (!authUserId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const [authRows] = await connection.execute(
      `SELECT id, user_name, role
         FROM qed_authentication
        WHERE id = ? AND is_deleted = 0`,
      [authUserId],
    );

    if (authRows.length === 0) {
      return res.status(404).json({ message: "User account not found" });
    }

    const auth = authRows[0];

    const table = ROLE_TABLES[auth.role];
    if (!table) {
      return res.status(400).json({ message: "Invalid user role" });
    }

    const [rows] = await connection.execute(
      `SELECT * FROM \`${table}\` WHERE user_id = ? AND is_deleted = 0`,
      [auth.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const row = rows[0];

    const profile = {
      // Match login and /auth/me: notifications are keyed by authentication user ID.
      id: String(auth.id),
      userName: auth.user_name,
      role: auth.role.toUpperCase(), 
      name: buildName(row),
      email: row.email_address,
    };

    switch (auth.role) {
      case "principal":
        profile.phone = row.contact_number || undefined;
        profile.gender = normalizeGender(row.gender);
        break;

      case "teacher": {
        profile.phone = row.contact_number || undefined;
        profile.gender = normalizeGender(row.gender);
        Object.assign(profile, await getTeacherExtras(row.id));
        break;
      }

      case "parent":
        profile.phone = row.contact_number || "";
        profile.address = row.address || "";
        profile.gender = normalizeGender(row.gender);
        break;

      case "admin":
      default:
        break;
    }

    return res.status(200).json(profile);
  } catch (error) {
    console.error("getMyProfile error:", error);
    return res.status(500).json({ message: "Failed to fetch profile" });
  }
};

module.exports = { getMyProfile };