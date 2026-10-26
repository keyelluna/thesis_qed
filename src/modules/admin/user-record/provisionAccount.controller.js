const bcrypt = require("bcrypt");
const { randomInt } = require("node:crypto");
const pool = require("../../../../config/db");
const { sendCredentialsEmail } = require("../../../services/mailer.service");

const tables = Object.freeze({ ADMIN: "admin_table", PRINCIPAL: "principal_table", TEACHER: "teacher_table", PARENT: "parent_table" });
const lockName = "qed:account-provisioning:v1";
const text = value => typeof value === "string" ? value.trim() : "";
function failure(status, message) { return Object.assign(new Error(message), { status }); }

function input(body) {
  const role = text(body.role).toUpperCase();
  if (!Object.hasOwn(tables, role)) throw failure(400, "Invalid role selected.");
  // Old split clients must not create or attach a second authentication record.
  if (body.userId !== undefined || body.password !== undefined || body.generatedPassword !== undefined) {
    throw failure(400, "Submit complete profile information without account IDs or credentials.");
  }
  const firstName = text(body.firstName), lastName = text(body.lastName);
  const middleName = text(body.middleName), email = text(body.email);
  const contactNumber = text(body.contactNumber), status = text(body.status);
  if (!firstName || !lastName || !email || !contactNumber) throw failure(400, "Name, email and contact number are required.");
  if (![firstName, lastName, middleName].every(value => value.length <= 100) || email.length > 254 || contactNumber.length > 32 || !/^\S+@\S+\.\S+$/.test(email)) {
    throw failure(400, "Invalid account information.");
  }
  if (!["Active", "Inactive"].includes(status)) throw failure(400, "Invalid account status.");
  if (role !== "ADMIN" && !["Male", "Female"].includes(body.gender)) throw failure(400, "Select this user's gender.");
  const first = firstName.toLowerCase().replace(/\s+/g, ""), last = lastName.toLowerCase().replace(/\s+/g, "");
  const prefix = { TEACHER: "TC_", PRINCIPAL: "PRN.", PARENT: "PRT_", ADMIN: "" }[role];
  // Keep the existing institutional username convention; conflicts are explicit.
  const userName = `${prefix}${first}.${last}`;
  if (userName.length > 191) throw failure(400, "Account name is too long.");
  return { role, firstName, lastName, middleName, email, contactNumber, status, gender: body.gender, userName };
}

async function verifySchema(conn, table, role) {
  const names = ["qed_authentication", ...Object.values(tables)];
  const [engines] = await conn.execute(
    "SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?, ?)", names,
  );
  if (names.some(name => !engines.some(row => row.TABLE_NAME === name && row.ENGINE === "InnoDB"))) {
    throw failure(503, "Account provisioning requires verified transactional tables. Contact the administrator.");
  }
  const [columns] = await conn.execute(
    "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)", ["qed_authentication", table],
  );
  const required = {
    qed_authentication: ["id", "user_name", "password", "role", "must_change_password"],
    [table]: ["id", "user_id", "first_name", "last_name", "middle_name", "email_address", "contact_number", "status", ...(role === "ADMIN" ? [] : ["gender"]), ...(role === "TEACHER" ? ["role"] : [])],
  };
  if (Object.entries(required).some(([name, fields]) => fields.some(field => !columns.some(row => row.TABLE_NAME === name && row.COLUMN_NAME === field)))) {
    throw failure(503, "Account provisioning schema is not ready. Contact the administrator.");
  }
}

exports.provisionAccount = async (req, res) => {
  let conn, locked = false, transaction = false, committed = false, profile, account, password;
  try {
    account = input(req.body || {});
    conn = await pool.getConnection();
    // Serializes both aliases across application workers, including cross-role email checks.
    const [lock] = await conn.execute("SELECT GET_LOCK(?, 5) AS acquired", [lockName]);
    if (Number(lock[0]?.acquired) !== 1) throw failure(503, "Account provisioning is busy. Please try again.");
    locked = true;
    await verifySchema(conn, tables[account.role], account.role);
    transaction = true;
    await conn.beginTransaction();
    const [existing] = await conn.execute("SELECT id FROM qed_authentication WHERE user_name = ? LIMIT 1", [account.userName]);
    if (existing.length) throw failure(409, "Username is already taken. Please check existing accounts.");
    for (const table of Object.values(tables)) {
      const [rows] = await conn.execute(`SELECT id FROM ${table} WHERE email_address = ? LIMIT 1`, [account.email]);
      if (rows.length) throw failure(409, "Email address is already in use.");
    }
    if (account.role === "PRINCIPAL" && account.status === "Active") {
      const [active] = await conn.execute("SELECT id FROM principal_table WHERE status = 'Active' AND is_deleted = 0 LIMIT 1", []);
      if (active.length) throw failure(409, "An active Principal already exists.");
    }
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
    password = "";
    // Preserve first-login password change and guarantee the existing password policy.
    do { password = Array.from({ length: 16 }, () => chars[randomInt(chars.length)]).join(""); }
    while (!/[a-z]/.test(password) || !/[0-9]/.test(password));
    const hash = await bcrypt.hash(password, 10);
    const [auth] = await conn.execute("INSERT INTO qed_authentication (user_name, password, role, must_change_password) VALUES (?, ?, ?, 1)", [account.userName, hash, account.role]);
    const fields = ["user_id", "last_name", "first_name", "middle_name", "email_address", "contact_number", "status"];
    const values = [auth.insertId, account.lastName, account.firstName, account.middleName, account.email, account.contactNumber, account.status];
    if (account.role !== "ADMIN") { fields.push("gender"); values.push(account.gender); }
    // Profile classification mirrors the canonical role; authentication controls authorization.
    if (account.role === "TEACHER") { fields.push("role"); values.push(account.role); }
    const [result] = await conn.execute(`INSERT INTO ${tables[account.role]} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`, values);
    profile = { id: result.insertId, userId: auth.insertId, lastName: account.lastName, firstName: account.firstName, middleName: account.middleName, email: account.email, contactNumber: account.contactNumber, status: account.status, gender: account.role === "ADMIN" ? null : account.gender };
    await conn.commit(); committed = true; transaction = false;
  } catch (error) {
    if (transaction && !committed) {
      try { await conn.rollback(); } catch { /* Do not disclose SQL/credentials. Connection is destroyed below. */ }
    }
    const status = error.status || (error.code === "ER_DUP_ENTRY" ? 409 : 500);
    return res.status(status).json({ success: false, message: error.status ? error.message : status === 409 ? "Account identifier or email address is already in use." : "Account provisioning failed." });
  } finally {
    if (conn) {
      let releaseFailed = false;
      try {
        if (locked) {
          const [result] = await conn.execute("SELECT RELEASE_LOCK(?) AS released", [lockName]);
          releaseFailed = Number(result[0]?.released) !== 1;
        }
      }
      catch { releaseFailed = true; }
      finally { if (releaseFailed || (transaction && !committed)) conn.destroy(); else conn.release(); }
    }
  }
  // Email is external to the transaction: a delivery failure must not undo a valid account.
  let delivery;
  try { delivery = await sendCredentialsEmail({ to: account.email, firstName: account.firstName, userName: account.userName, password, role: account.role }); }
  catch { delivery = { sent: false }; }
  const credentialDelivery = delivery?.sent ? (delivery.redirected ? "test-recipient" : "accepted") : "failed";
  return res.status(201).json({ success: true, message: `User successfully added to ${tables[account.role]}!`, data: profile, credentialDelivery });
};
