const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const connection = require("../../../config/db");
const ROLE_TABLES = require("../../../config/roleTables");
const { sendPasswordResetOtpEmail } = require("../../services/mailer.service");
const { recoveryLimits } = require("./recoveryRateLimit");
const { readMockPasswordResetConfig, allowsMockPasswordReset } = require("../../services/mockPasswordReset.config");

const genericRequest = { message: "If the account information matches, a recovery code will be emailed." };
const invalidOtp = { message: "Invalid or expired OTP." };
const invalidToken = { message: "Invalid or expired reset token. Please request a new one." };
const text = value => typeof value === "string" ? value.trim() : "";
const validId = id => (typeof id === "number" && Number.isSafeInteger(id) && id > 0) || (typeof id === "string" && /^[1-9]\d{0,19}$/.test(id));
function roleTable(role) {
  const key = typeof role === "string" ? role.toLowerCase() : "";
  return Object.hasOwn(ROLE_TABLES, key) ? ROLE_TABLES[key] : undefined;
}
function binding(record) {
  return crypto.createHmac("sha256", process.env.JWT_SECRET)
    .update(`qed-password-reset:v1:${record.id}:${record.password}`).digest("hex");
}
async function profileEligible(record, email) {
  const table = roleTable(record.role);
  if (!table || !validId(record.id)) return false;
  const [rows] = await connection.execute(
    `SELECT user_id FROM ${table} WHERE user_id = ?${email === undefined ? "" : " AND email_address = ?"} AND is_deleted = 0 AND LOWER(status) = 'active' LIMIT 1`,
    email === undefined ? [record.id] : [record.id, email],
  );
  return rows.length > 0;
}

exports.forgotPassword = async (req, res) => {
  const userName = text(req.body?.userName), email = text(req.body?.email);
  if (!userName || userName.length > 191 || !email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ message: "Valid User ID and email are required." });
  }
  // Same public response for valid/unknown accounts, wrong email, blocked roles,
  // rate limits and provider failures; no account-existence disclosure in bodies.
  if (!recoveryLimits.allow("request", req, userName)) return res.status(200).json(genericRequest);
  const mock = readMockPasswordResetConfig();
  if (mock.mode === "invalid") return res.status(200).json(genericRequest);
  try {
    const [rows] = await connection.execute("SELECT id, role FROM qed_authentication WHERE user_name = ? AND is_deleted = 0 LIMIT 1", [userName]);
    const record = rows[0];
    // Check server-selected account IDs before generating or persisting a code.
    if (mock.mode === "on" && !allowsMockPasswordReset(mock, record?.id)) return res.status(200).json(genericRequest);
    if (!record || !(await profileEligible(record, email))) return res.status(200).json(genericRequest);
    const otp = crypto.randomInt(100000, 1000000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await connection.execute("UPDATE qed_authentication SET password_reset_otp = ?, otp_expires_at = ? WHERE id = ?", [otp, expires, record.id]);
    let delivery;
    try { delivery = await sendPasswordResetOtpEmail({ to: email, otp, accountId: record.id }); } catch { delivery = { sent: false }; }
    if (!delivery?.sent) {
      // Do not clear a newer code issued while the provider was pending.
      await connection.execute("UPDATE qed_authentication SET password_reset_otp = NULL, otp_expires_at = NULL WHERE id = ? AND password_reset_otp = ?", [record.id, otp]);
    }
  } catch { /* Do not log credentials, OTPs, tokens, SQL parameters or existence. */ }
  return res.status(200).json(genericRequest);
};

exports.verifyOtp = async (req, res) => {
  const userName = text(req.body?.userName), otp = req.body?.otp;
  if (!userName || userName.length > 191 || typeof otp !== "string" || !/^\d{6}$/.test(otp)) return res.status(400).json(invalidOtp);
  if (!recoveryLimits.allow("otp", req, userName)) return res.status(400).json(invalidOtp);
  try {
    const [rows] = await connection.execute("SELECT id, role, password, password_reset_otp, otp_expires_at FROM qed_authentication WHERE user_name = ? AND is_deleted = 0 LIMIT 1", [userName]);
    const record = rows[0];
    const expires = +new Date(record?.otp_expires_at);
    if (!record || typeof record.password !== "string" || String(record.password_reset_otp) !== otp || !Number.isFinite(expires) || expires <= Date.now() || !(await profileEligible(record))) return res.status(400).json(invalidOtp);
    const [consumed] = await connection.execute(
      "UPDATE qed_authentication SET password_reset_otp = NULL, otp_expires_at = NULL WHERE id = ? AND password_reset_otp = ? AND otp_expires_at > ? AND BINARY password = ?",
      [record.id, otp, new Date(), record.password],
    );
    if (consumed.affectedRows !== 1) return res.status(400).json(invalidOtp);
    const resetToken = jwt.sign({ userId: record.id, purpose: "password_reset", credentialVersion: binding(record) }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "15m" });
    return res.status(200).json({ resetToken });
  } catch { return res.status(400).json(invalidOtp); }
};

exports.resetPassword = async (req, res) => {
  const { resetToken, newPassword } = req.body || {};
  if (typeof resetToken !== "string" || !resetToken || typeof newPassword !== "string") return res.status(400).json({ message: "Reset token and new password are required." });
  if (newPassword.length < 8 || Buffer.byteLength(newPassword, "utf8") > 72 || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ message: "Password must be 8–72 bytes, with at least 1 lowercase letter and 1 number." });
  }
  let decoded;
  try { decoded = jwt.verify(resetToken, process.env.JWT_SECRET, { algorithms: ["HS256"] }); }
  catch { return res.status(401).json(invalidToken); }
  if (decoded?.purpose !== "password_reset" || !validId(decoded.userId) || typeof decoded.credentialVersion !== "string" || !/^[a-f0-9]{64}$/.test(decoded.credentialVersion) || typeof decoded.exp !== "number") return res.status(401).json(invalidToken);
  try {
    const [rows] = await connection.execute("SELECT id, role, password FROM qed_authentication WHERE id = ? AND is_deleted = 0 LIMIT 1", [decoded.userId]);
    const record = rows[0];
    if (!record || typeof record.password !== "string" || !crypto.timingSafeEqual(Buffer.from(decoded.credentialVersion, "hex"), Buffer.from(binding(record), "hex")) || !(await profileEligible(record))) return res.status(401).json(invalidToken);
    const hash = await bcrypt.hash(newPassword, 10);
    const [updated] = await connection.execute(
      "UPDATE qed_authentication SET password = ?, must_change_password = 0, password_reset_otp = NULL, otp_expires_at = NULL WHERE id = ? AND BINARY password = ?",
      [hash, record.id, record.password],
    );
    if (updated.affectedRows !== 1) return res.status(401).json(invalidToken);
    return res.status(200).json({ message: "Password reset successful." });
  } catch { return res.status(500).json({ message: "Password recovery is temporarily unavailable." }); }
};
