const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const connection = require("../../../config/db"); // mysql2 pool with .promise()
const ROLE_TABLES = require("../../../config/roleTables");
const crypto = require("crypto");
const { sendPasswordResetOtpEmail } = require("../../services/mailer.service");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = "1h";

exports.login = async (req, res) => {
  try {
    const { userName, password } = req.body;

    const [rows] = await connection.execute(
      "SELECT * FROM qed_authentication WHERE user_name = ? LIMIT 1",
      [userName],
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = rows[0];

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid Password" });
    }

    const table = ROLE_TABLES[user.role];
    if (!table) {
      return res
        .status(500)
        .json({ message: "Invalid user role configuration." });
    }

    const [profileRows] = await connection.execute(
      `SELECT is_deleted, status, CONCAT(first_name, ' ', last_name) AS name FROM ${table} WHERE user_id = ? LIMIT 1`,
      [user.id],
    );

    if (profileRows.length === 0) {
      return res.status(403).json({ message: "User profile not found." });
    }

    const profile = profileRows[0];

    if (profile.is_deleted === 1) {
      return res.status(403).json({ message: "Account has been deleted." });
    }

    if (profile.status && profile.status.toLowerCase() === "inactive") {
      return res.status(403).json({ message: "Account is inactive." });
    }

    // ✅ i-log ang successful login para sa Daily Login Frequency analytics
    await connection.execute(
      "INSERT INTO login_logs (user_id, role) VALUES (?, ?)",
      [user.id, user.role],
    );

    const token = jwt.sign(
      { userId: user.id, userName: user.user_name, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );

    return res
      .cookie("token", token, {
        httpOnly: true,
        secure: true, // required — "none" won't work without secure
        sameSite: "none",
        maxAge: 60 * 60 * 1000,
      })
      .status(200)
      .json({
        message: "Login successful",
        user: {
          id: user.id,
          user_name: user.user_name,
          name: profile.name,
          role: user.role,
          mustChangePassword: !!user.must_change_password,
          token,
        },
      });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.me = async (req, res) => {
  try {
    const { userId, userName, role } = req.user;
    const table = ROLE_TABLES[role];

    const [profileRows] = await connection.execute(
      `SELECT CONCAT(first_name, ' ', last_name) AS name, email_address, contact_number FROM ${table} WHERE user_id = ? LIMIT 1`,
      [userId],
    );

    const [authRows] = await connection.execute(
      "SELECT must_change_password FROM qed_authentication WHERE id = ? LIMIT 1",
      [userId],
    );

    const name = profileRows[0]?.name ?? userName;
    const mustChangePassword = !!authRows[0]?.must_change_password;

    res.status(200).json({
      user: { id: userId, user_name: userName, name, role, mustChangePassword },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.register = async (req, res) => {
  try {
    const { userName, password, role } = req.body;
    const normalizedRole = role?.toUpperCase();

    // if (!name || !email || !password) {
    //   return res.status(400).json({ message: 'Name, email and password are required.' });
    // }

    // 1. Kuhanin ang secret dito at maglagay ng fallback
    const jwtSecret =
      process.env.JWT_SECRET || "qed_default_fallback_secret_key_123";

    // hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // must_change_password defaults to 1 (TRUE) sa column definition,
    // kaya lahat ng bagong accounts ay kailangang magpalit ng password
    // sa unang login nila
    const [result] = await connection.query(
      "INSERT INTO qed_authentication (user_name, password, role) VALUES (?, ?, ?)",
      [userName, hashedPassword, role],
    );

    const token = jwt.sign(
      { id: result.insertId, userName, role },
      JWT_SECRET,
      {
        expiresIn: JWT_EXPIRES_IN,
      },
    );

    return res.status(201).json({
      message: "User registered successfully.",
      token,
      user: { id: result.insertId, userName, role },
    });
  } catch (err) {
    console.error(err);

    // Duplicate username — most likely two users whose generated username
    // collided (e.g. same first/last name pattern). Return a specific,
    // actionable message instead of a generic 500 so the frontend can
    // surface it properly (and, later, offer to regenerate/retry).
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: `Username "${req.body.userName}" is already taken. This may mean the user already has an account — please check before adding a new one.`,
      });
    }

    return res.status(500).json({ message: "Server error." });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { userId } = req.user;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ message: "New password is required." });
    }

    if (
      newPassword.length < 8 ||
      !/[a-z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword)
    ) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters, with at least 1 lowercase letter and 1 number.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await connection.execute(
      "UPDATE qed_authentication SET password = ?, must_change_password = 0 WHERE id = ?",
      [hashedPassword, userId],
    );

    return res.status(200).json({ message: "Password changed successfully." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
};
// authentication.controller.js

exports.logout = async (req, res) => {
  try {
    res
      .clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production" || true,
        sameSite: process.env.NODE_ENV === "production" ? "strict" : "none",
      })
      .status(200)
      .json({ message: "Logout successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// FORGOT PASSWORD
exports.forgotPassword = async (req, res) => {
  try {
    const { userName, email } = req.body;

    if (!userName || !email) {
      return res
        .status(400)
        .json({ message: "User ID and email are required." });
    }

    // 1. Hanapin ang account gamit ang user_name
    const [authRows] = await connection.execute(
      "SELECT id, role FROM qed_authentication WHERE user_name = ? LIMIT 1",
      [userName],
    );

    if (authRows.length === 0) {
      return res.status(400).json({ message: "Invalid email or user name." });
    }

    const { id: userId, role } = authRows[0];
    const table = ROLE_TABLES[role];

    // 2. I-verify na tumutugma ang email sa profile niya
    const [profileRows] = await connection.execute(
      `SELECT user_id FROM ${table} WHERE user_id = ? AND email_address = ? LIMIT 1`,
      [userId, email],
    );

    if (profileRows.length === 0) {
      return res.status(400).json({ message: "Invalid email or user name." });
    }

    // 3. Match — generate at i-send yung OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await connection.execute(
      "UPDATE qed_authentication SET password_reset_otp = ?, otp_expires_at = ? WHERE id = ?",
      [otp, expiresAt, userId],
    );

    await sendPasswordResetOtpEmail({ to: email, otp });

    return res
      .status(200)
      .json({ message: "OTP sent to your registered email." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
};

// VERIFY OTP
exports.verifyOtp = async (req, res) => {
  try {
    const { userName, otp } = req.body;

    if (!userName || !otp) {
      return res.status(400).json({ message: "User ID and OTP are required." });
    }

    const [authRows] = await connection.execute(
      "SELECT id, password_reset_otp, otp_expires_at FROM qed_authentication WHERE user_name = ? LIMIT 1",
      [userName],
    );

    const record = authRows[0];
    const isExpired =
      !record?.otp_expires_at || new Date(record.otp_expires_at) < new Date();

    if (!record || record.password_reset_otp !== otp || isExpired) {
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    await connection.execute(
      "UPDATE qed_authentication SET password_reset_otp = NULL, otp_expires_at = NULL WHERE id = ?",
      [record.id],
    );

    const resetToken = jwt.sign(
      { userId: record.id, purpose: "password_reset" },
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    return res.status(200).json({ resetToken });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
};

//RESET PASSWORD
exports.resetPassword = async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res
        .status(400)
        .json({ message: "Reset token and new password are required." });
    }

    if (
      newPassword.length < 8 ||
      !/[a-z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword)
    ) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters, with at least 1 lowercase letter and 1 number.",
      });
    }

    // 1. I-verify ang reset token
    let decoded;
    try {
      decoded = jwt.verify(resetToken, JWT_SECRET);
    } catch (err) {
      return res
        .status(401)
        .json({ message: "Reset link expired. Please request a new one." });
    }

    if (decoded.purpose !== "password_reset") {
      return res.status(401).json({ message: "Invalid reset token." });
    }

    // 2. Hash at i-update ang password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await connection.execute(
      "UPDATE qed_authentication SET password = ?, must_change_password = 0 WHERE id = ?",
      [hashedPassword, decoded.userId],
    );

    return res.status(200).json({ message: "Password reset successful." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
};
