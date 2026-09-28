const connection = require("../../../../config/db");
const jwt = require("jsonwebtoken");

let tableReady;

async function ensureAuditLogTable() {
  if (!tableReady) {
    tableReady = connection.execute(`
      CREATE TABLE IF NOT EXISTS system_audit_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        actor_user_id BIGINT NULL,
        actor_username VARCHAR(150) NULL,
        actor_role VARCHAR(40) NULL,
        action_type VARCHAR(40) NOT NULL,
        resource_name VARCHAR(190) NOT NULL,
        resource_id VARCHAR(100) NULL,
        http_method VARCHAR(10) NOT NULL,
        endpoint VARCHAR(500) NOT NULL,
        status_code SMALLINT UNSIGNED NOT NULL,
        changed_fields JSON NULL,
        ip_address VARCHAR(45) NULL,
        user_agent VARCHAR(500) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_created (created_at),
        INDEX idx_audit_actor (actor_user_id, actor_role),
        INDEX idx_audit_resource (resource_name, resource_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).then(() => true).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

function actionForMethod(method, endpoint) {
  const path = endpoint.toLowerCase();
  if (/submit|release|approve/.test(path)) return "SUBMIT";
  if (/upload/.test(path)) return "UPLOAD";
  if (method === "POST" && /create|add|register/.test(path)) return "CREATE";
  return ({ POST: "CREATE", PUT: "UPDATE", PATCH: "UPDATE", DELETE: "DELETE" })[method] || "CHANGE";
}

function resourceFromPath(path) {
  const segments = path.split("/").filter(Boolean);
  return (segments.at(-2) || segments.at(-1) || "system")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .slice(0, 190);
}

function changedFieldNames(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const ignored = /password|token|secret|otp|email|contact|phone|address|cookie|authorization/i;
  const names = Object.keys(body).filter((key) => !ignored.test(key)).slice(0, 30);
  return names.length ? JSON.stringify(names) : null;
}

function actorFromRequest(req) {
  if (req.user?.userId) return req.user;
  const token = req.cookies?.token;
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return {
      userId: decoded.userId ?? decoded.id ?? null,
      userName: decoded.userName ?? null,
      role: decoded.role ?? null,
    };
  } catch {
    return null;
  }
}

async function recordAuditEvent(event) {
  await ensureAuditLogTable();
  const { actor, action, resource, resourceId, method, endpoint, statusCode, fields, ip, userAgent } = event;
  await connection.execute(
    `INSERT INTO system_audit_logs
      (actor_user_id, actor_username, actor_role, action_type, resource_name, resource_id,
       http_method, endpoint, status_code, changed_fields, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actor?.userId ?? null,
      actor?.userName ?? null,
      actor?.role ? String(actor.role).toUpperCase() : null,
      action,
      resource,
      resourceId ? String(resourceId).slice(0, 100) : null,
      method,
      endpoint.slice(0, 500),
      statusCode,
      fields,
      ip || null,
      userAgent?.slice(0, 500) || null,
    ],
  );
}

function auditMutationRequests(req, res, next) {
  const method = req.method.toUpperCase();
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method)) return next();
  if (req.originalUrl.split("?")[0] === "/api/auth/login") return next(); // successful login is recorded with its verified identity below
  const requestActor = actorFromRequest(req);

  res.once("finish", () => {
    // Authentication middleware runs inside the route, so req.user is
    // available by the time the response finishes.
    const endpoint = req.originalUrl.split("?")[0];
    const path = endpoint.replace(/^\/api\/?/, "").split("/")[0];
    const resourceIdEntry = Object.entries(req.params || {}).find(([key]) => /id$/i.test(key));
    const finalPathSegment = endpoint.split("/").at(-1);
    const resourceId = resourceIdEntry?.[1] || (/^\d+$/.test(finalPathSegment || "") ? finalPathSegment : null);
    recordAuditEvent({
      actor: requestActor || { userName: null, role: "ANONYMOUS" },
      action: actionForMethod(method, endpoint),
      resource: resourceFromPath(path),
      resourceId,
      method,
      endpoint,
      statusCode: res.statusCode,
      fields: changedFieldNames(req.body),
      ip: req.ip,
      userAgent: req.get("user-agent"),
    }).catch((error) => console.error("Failed to write system audit log:", error.message));
  });
  next();
}

async function listAuditLogs({ page = 1, limit = 25, search = "", role = "", action = "", from = "", to = "" }) {
  await ensureAuditLogTable();
  const actorFullNameSql = `COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ', admin_actor.first_name, admin_actor.middle_name, admin_actor.last_name)), ''),
    NULLIF(TRIM(CONCAT_WS(' ', principal_actor.first_name, principal_actor.middle_name, principal_actor.last_name)), ''),
    NULLIF(TRIM(CONCAT_WS(' ', teacher_actor.first_name, teacher_actor.middle_name, teacher_actor.last_name)), ''),
    NULLIF(TRIM(CONCAT_WS(' ', parent_actor.first_name, parent_actor.middle_name, parent_actor.last_name)), ''),
    al.actor_username
  )`;
  const filters = [];
  const values = [];
  if (search) {
    filters.push(`(${actorFullNameSql} LIKE ? OR al.actor_username LIKE ? OR al.resource_name LIKE ? OR al.endpoint LIKE ? OR al.resource_id LIKE ?)`);
    const pattern = `%${search}%`;
    values.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (role) { filters.push("al.actor_role = ?"); values.push(role); }
  if (action) { filters.push("al.action_type = ?"); values.push(action); }
  if (from) { filters.push("al.created_at >= ?"); values.push(`${from} 00:00:00`); }
  if (to) { filters.push("al.created_at < DATE_ADD(?, INTERVAL 1 DAY)"); values.push(to); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 25)));
  const offset = (safePage - 1) * safeLimit;
  const eventRowsSql = `
    SELECT id, actor_user_id,
           CONVERT(actor_username USING utf8mb4) COLLATE utf8mb4_unicode_ci AS actor_username,
           CONVERT(actor_role USING utf8mb4) COLLATE utf8mb4_unicode_ci AS actor_role,
           CONVERT(action_type USING utf8mb4) COLLATE utf8mb4_unicode_ci AS action_type,
           CONVERT(resource_name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS resource_name,
           CONVERT(resource_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS resource_id,
           CONVERT(http_method USING utf8mb4) COLLATE utf8mb4_unicode_ci AS http_method,
           CONVERT(endpoint USING utf8mb4) COLLATE utf8mb4_unicode_ci AS endpoint,
           status_code,
           CONVERT(changed_fields USING utf8mb4) COLLATE utf8mb4_unicode_ci AS changed_fields,
           CONVERT(ip_address USING utf8mb4) COLLATE utf8mb4_unicode_ci AS ip_address,
           CONVERT(user_agent USING utf8mb4) COLLATE utf8mb4_unicode_ci AS user_agent,
           created_at
    FROM system_audit_logs
    UNION ALL
    SELECT -ll.id AS id, ll.user_id AS actor_user_id,
           CONVERT(auth.user_name USING utf8mb4) COLLATE utf8mb4_unicode_ci AS actor_username,
           CONVERT(UPPER(ll.role) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS actor_role,
           _utf8mb4'LOGIN' COLLATE utf8mb4_unicode_ci AS action_type,
           _utf8mb4'Authentication' COLLATE utf8mb4_unicode_ci AS resource_name,
           NULL AS resource_id,
           _utf8mb4'POST' COLLATE utf8mb4_unicode_ci AS http_method,
           _utf8mb4'/api/auth/login' COLLATE utf8mb4_unicode_ci AS endpoint,
           200 AS status_code, NULL AS changed_fields, NULL AS ip_address, NULL AS user_agent,
           ll.login_time AS created_at
    FROM login_logs ll
    LEFT JOIN qed_authentication auth ON auth.id = ll.user_id
    WHERE NOT EXISTS (
      SELECT 1 FROM system_audit_logs saved_login
      WHERE saved_login.action_type = 'LOGIN'
        AND saved_login.actor_user_id = ll.user_id
        AND saved_login.created_at BETWEEN DATE_SUB(ll.login_time, INTERVAL 2 MINUTE)
                                       AND DATE_ADD(ll.login_time, INTERVAL 2 MINUTE)
    )`;
  const joins = `
    LEFT JOIN admin_table admin_actor ON al.actor_role = 'ADMIN' AND admin_actor.user_id = al.actor_user_id
    LEFT JOIN principal_table principal_actor ON al.actor_role = 'PRINCIPAL' AND principal_actor.user_id = al.actor_user_id
    LEFT JOIN teacher_table teacher_actor ON al.actor_role = 'TEACHER' AND teacher_actor.user_id = al.actor_user_id
    LEFT JOIN parent_table parent_actor ON al.actor_role = 'PARENT' AND parent_actor.user_id = al.actor_user_id`;
  // This query builds a derived table from a UNION and joins the profile
  // tables. Use the driver's parameterized query path here: some supported
  // MySQL/MariaDB versions reject this shape when it is sent as a prepared
  // statement (ER_WRONG_ARGUMENTS), even though the same SQL is valid.
  const [countRows] = await connection.query(
    `SELECT COUNT(*) AS total FROM (${eventRowsSql}) al
     ${joins}
     ${where}`,
    values,
  );
  // MySQL/MariaDB deployments differ in whether prepared LIMIT/OFFSET
  // placeholders are accepted. These values are numeric, floored, and
  // bounded above, so embedding them avoids driver-level bind errors safely.
  const [rows] = await connection.query(
    `SELECT al.id, al.actor_user_id AS actorUserId,
            ${actorFullNameSql} AS actorFullName, al.actor_username AS actorUsername,
            al.actor_role AS actorRole, al.action_type AS action, al.resource_name AS resource, al.resource_id AS resourceId,
            al.http_method AS httpMethod, al.endpoint, al.status_code AS statusCode,
            al.changed_fields AS changedFields, al.ip_address AS ipAddress,
            al.user_agent AS userAgent, al.created_at AS createdAt
     FROM (${eventRowsSql}) al
     ${joins}
     ${where}
     ORDER BY al.created_at DESC, al.id DESC LIMIT ${safeLimit} OFFSET ${offset}`,
    values,
  );
  return { entries: rows, page: safePage, limit: safeLimit, total: Number(countRows[0]?.total || 0) };
}

module.exports = { ensureAuditLogTable, recordAuditEvent, auditMutationRequests, listAuditLogs };
