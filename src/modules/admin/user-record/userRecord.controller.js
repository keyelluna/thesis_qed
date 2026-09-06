const Teacher = require("../../../models/teacher.model");
const Principal = require("../../../models/principal.model");
const Admin = require("../../../models/admin.model");
const Parent = require("../../../models/parent.model");
const TotalUsers = require("../../../models/totalUser.model");
const totalUser = require("../../../models/totalUser.model");
const { sendCredentialsEmail } = require("../../../services/mailer.service");
const connection = require("../../../../config/db");

const roleModelMap = {
  teacher: Teacher,
  principal: Principal,
  admin:Admin,
  parent: Parent,
};

// Checks if an email is already used by ANY role, not just the one being
// created. findByEmail() on each Model is scoped to that model's own table
// only, so a per-role check alone would miss e.g. the same email existing
// as both a teacher and a parent.
async function findEmailAcrossAllRoles(email) {
  for (const [roleName, Model] of Object.entries(roleModelMap)) {
    if (typeof Model.findByEmail !== "function") continue;
    const existing = await Model.findByEmail(email);
    if (existing) {
      return roleName;
    }
  }
  return null;
}

// createUser only ever runs for brand-new users — the frontend already
// created the qed_authentication row via /api/auth/register before calling
// this endpoint, and `userId` here IS that row's id. If anything below
// fails, that auth row is orphaned (valid login credentials, no profile
// record to go with them) unless we clean it up ourselves.
async function rollbackAuthAccount(userId) {
  if (!userId) return;
  try {
    await connection.query("DELETE FROM qed_authentication WHERE id = ?", [
      userId,
    ]);
  } catch (err) {
    console.error("Failed to roll back orphaned auth account:", err);
  }
}

exports.createUser = async (req, res) => {
  const {
    userId,
    lastName,
    firstName,
    middleName,
    role,
    email,
    contactNumber,
    status,
    userName,
    generatedPassword,
  } = req.body;

  try {
    const normalizedRole = role?.toLowerCase();
    const Model = roleModelMap[normalizedRole];

    if (!Model) {
      return res.status(400).json({
        success: false,
        message: "Invalid role selected.",
      });
    }

    const conflictingRole = await findEmailAcrossAllRoles(email);
    if (conflictingRole) {
      await rollbackAuthAccount(userId);
      return res.status(409).json({
        success: false,
        message:
          conflictingRole === normalizedRole
            ? "Email address is already in use."
            : `Email address is already in use by an existing ${conflictingRole} account.`,
      });
    }

    const newUser = await Model.create({
      userId,
      lastName,
      firstName,
      middleName,
      email,
      contactNumber,
      status,
    });

    // Send login credentials to the new user's email. Only fires for brand
    // new accounts (userName/generatedPassword are only sent by the frontend
    // on create, never on edit). Non-blocking on failure — kung ma-fail yung
    // email, hindi dapat mag-fail yung buong "add user" request.
    if (userName && generatedPassword) {
      sendCredentialsEmail({
        to: email,
        firstName,
        userName,
        password: generatedPassword,
        role: normalizedRole,
      }).catch((err) => {
        console.error("Failed to send credentials email:", err);
      });
    }

    res.status(201).json({
      success: true,
      message: `User successfully added to ${normalizedRole}_table!`,
      data: newUser,
    });
  } catch (error) {
    console.error("Database Error:", error);
    await rollbackAuthAccount(userId);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "Email address is already in use.",
      });
    }

    res
      .status(500)
      .json({ success: false, message: "Database error occurred." });
  }
};

// UPDATE USER
exports.editUser = async (req, res) => {
  const { id } = req.params;
  const {
    userId,
    lastName,
    firstName,
    middleName,
    role,
    email,
    contactNumber,
    status,
  } = req.body;

  try {
    const normalizedRole = role?.toLowerCase();
    const Model = roleModelMap[normalizedRole];

    if (!Model) {
      return res.status(400).json({
        success: false,
        message: "Invalid role selected.",
      });
    }

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "id is required to update a user.",
      });
    }

    const updatedUser = await Model.update({
      id,
      userId,
      lastName,
      firstName,
      middleName,
      email,
      contactNumber,
      status,
    });

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: `User not found in ${normalizedRole}_table.`,
      });
    }

    res.status(200).json({
      success: true,
      message: `User successfully updated in ${normalizedRole}_table!`,
      data: updatedUser,
    });
  } catch (error) {
    console.error("Database Error:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "Email address is already in use.",
      });
    }

    res
      .status(500)
      .json({ success: false, message: "Database error occurred." });
  }
};
// GET USER BY ID
exports.getUserById = async (req, res) => {
  const { id, role } = req.params;

  try {
    const normalizedRole = role?.toLowerCase();
    const Model = roleModelMap[normalizedRole];

    if (!Model) {
      return res.status(400).json({
        success: false,
        message: "Invalid role selected.",
      });
    }

    const user = await Model.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        id: String(user.user_id ?? user.id),
        firstName: user.first_name,
        middleName: user.middle_name,
        lastName: user.last_name,
        role: normalizedRole.toUpperCase(),
        email: user.email_address,
        contactNumber: user.contact_number,
        status: user.status?.toLowerCase() === "active" ? "Active" : "Inactive",
        lastLogin: user.last_login ?? null,
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


exports.getAllUsers = async (req, res) => {
  try {
    const roles = Object.keys(roleModelMap);
    const allUsers = [];

    for (const role of roles) {
      try {
        const Model = roleModelMap[role];
        if (!Model || typeof Model.findAll !== 'function') {
          console.warn(`Skipping role ${role} – model or findAll missing`);
          continue;
        }
        const rows = await Model.findAll();
        const mapped = rows.map((user) => ({
          id: String(user.id),
          firstName: user.first_name,
          middleName: user.middle_name,
          lastName: user.last_name,
          role: role.toUpperCase(),
          email: user.email_address,
          contactNumber: user.contact_number,
          status: user.status?.toLowerCase() === 'active' ? 'Active' : 'Inactive',
          lastLogin: user.last_login ?? null,
        }));
        allUsers.push(...mapped);
      } catch (err) {
        console.error(`Error fetching ${role} data:`, err);
        // Continue to other roles
      }
    }

    res.status(200).json({
      success: true,
      data: allUsers,
    });
  } catch (error) {
    console.error('Unexpected error in getAllUsers:', error);
    res.status(500).json({
      success: false,
      message: 'Database error occurred.',
    });
  }
};

//SOFT DELETE USER
exports.softDeleteUser = async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  try {
    const normalizedRole = role?.toLowerCase();
    const Model = roleModelMap[normalizedRole];

    if (!Model) {
      return res.status(400).json({
        success: false,
        message: "Invalid role selected.",
      });
    }

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "id is required to delete a user.",
      });
    }

    const deletedUser = await Model.softDelete(id);

    if (!deletedUser) {
      return res.status(404).json({
        success: false,
        message: `User not found or already deleted in ${normalizedRole}_table.`,
      });
    }

    res.status(200).json({
      success: true,
      message: `User successfully soft-deleted from ${normalizedRole}_table!`,
      data: deletedUser,
    });
  } catch (error) {
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Database error occurred." });
  }
};

//GET TOTAL USER
exports.getTotalUser = async (req, res) => {
  try {
    const counts = await totalUser.getCountsByRole();

    res.status(200).json({
      success: true,
      totalUsers: counts.allUser,
      totalTeachers: counts.teacher,
      totalParents: counts.parent,
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({ success: false, message: "Database error occurred." });
  }
};

exports.getUserCounts = async (req, res) => {
  try {
    const [teacherResult] = await connection.query(
      'SELECT COUNT(*) AS total FROM teacher_table WHERE is_deleted = 0'
    );

    const [parentResult] = await connection.query(
      'SELECT COUNT(*) AS total FROM parent_table WHERE is_deleted = 0'
    );

    res.status(200).json({
      totalTeachers: teacherResult[0].total,
      totalParents: parentResult[0].total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.getTeacherCount = async (req, res) => {
  try {
    const [result] = await connection.query(
      'SELECT COUNT(*) AS total FROM teacher_table WHERE is_deleted = 0'
    );

    res.status(200).json({ totalTeachers: result[0].total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};


exports.getParentCount = async (req, res) => {
  try {
    const [result] = await connection.query(
      'SELECT COUNT(*) AS total FROM parent_table WHERE is_deleted = 0'
    );

    res.status(200).json({ totalParents: result[0].total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};