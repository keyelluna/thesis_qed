const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("node:crypto");

// Real HTTP routing, JWT verification and Calendar controllers; inert database.
// Never load config/db, .env, server.js or a remote database in this suite.
const dbId = require.resolve("../config/db");
const previousDb = require.cache[dbId];
const calls = [];
let affectedRows = 1;
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: {
  async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("FROM school_year")) return [[{ id: 7 }]];
    if (sql.startsWith("SELECT")) return [[{ id: 21, title: "Synthetic event", date: "2026-10-12", holiday_type: "regular holiday" }]];
    return [{ insertId: 21, affectedRows }];
  },
} };
const calendarRouter = require("../src/modules/shared/calendar/calendar.router");
const previousSecret = process.env.JWT_SECRET;
const secret = randomBytes(32).toString("hex");
let server, baseUrl, logCount = 0;
const originalLog = console.log;

test.before(async () => {
  process.env.JWT_SECRET = secret;
  // Count logging without emitting JWTs, even when checking the old middleware.
  console.log = () => { logCount++; };
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/calendar", calendarRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/calendar`;
});
test.after(async () => {
  console.log = originalLog;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
  if (previousDb) require.cache[dbId] = previousDb;
  else delete require.cache[dbId];
});
test.beforeEach(() => { calls.length = 0; affectedRows = 1; logCount = 0; });

function token(role, options = {}, signingSecret = secret) {
  return jwt.sign({ userId: 123, ...(role === undefined ? {} : { role }) }, signingSecret, { expiresIn: "5m", ...options });
}
const operations = [
  { method: "POST", path: "/activities", body: { entries: [{ title: "Synthetic event", date: "2026-10-12", createdBy: 123 }] }, status: 201, message: "Activities added successfully" },
  { method: "PUT", path: "/activities/21", body: { title: "Synthetic event", date: "2026-10-12" }, status: 200, message: "Activity updated successfully" },
  { method: "DELETE", path: "/activities/21", status: 200, message: "Activity deleted successfully" },
  { method: "POST", path: "/holidays", body: { entries: [{ title: "Synthetic event", date: "2026-10-12", holidayType: "regular", createdBy: 123 }] }, status: 201, message: "Holidays added successfully" },
  { method: "PUT", path: "/holidays/21", body: { title: "Synthetic event", date: "2026-10-12", holidayType: "regular" }, status: 200, message: "Holiday updated successfully" },
  { method: "DELETE", path: "/holidays/21", status: 200, message: "Holiday deleted successfully" },
];
async function request(operation, cookie, overrideBody) {
  const response = await fetch(baseUrl + operation.path, {
    method: operation.method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: `token=${cookie}` } : {}) },
    ...(operation.body || overrideBody ? { body: JSON.stringify(overrideBody ?? operation.body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

for (const operation of operations) {
  const name = `${operation.method} ${operation.path}`;
  test(`${name}: missing authentication is 401 before any database access`, async () => {
    const result = await request(operation);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { message: "No token provided." });
    assert.equal(calls.length, 0);
  });
  for (const role of ["TEACHER", "PARENT", "UNKNOWN", undefined]) {
    test(`${name}: signed ${role ?? "missing-role"} identity is forbidden before database access`, async () => {
      const result = await request(operation, token(role));
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { success: false, message: "Calendar management requires Admin or Principal access." });
      assert.equal(calls.length, 0);
    });
  }
  for (const invalid of ["malformed", "expired", "wrong-signature", "unsigned"]) {
    test(`${name}: ${invalid} cookie cannot authorize a writer`, async () => {
      const value = invalid === "malformed" ? "not-a-jwt"
        : invalid === "expired" ? token("ADMIN", { expiresIn: -1 })
        : invalid === "wrong-signature" ? token("ADMIN", {}, randomBytes(32).toString("hex"))
        : jwt.sign({ userId: 123, role: "ADMIN" }, "", { algorithm: "none" });
      const result = await request(operation, value);
      // Preserve the existing shared middleware's invalid/expired-token contract.
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { message: "Invalid or expired token." });
      assert.equal(calls.length, 0);
    });
  }
  for (const role of ["ADMIN", "PRINCIPAL", "admin", "principal"]) {
    test(`${name}: authenticated ${role} keeps the existing controller contract`, async () => {
      const result = await request(operation, token(role));
      assert.equal(result.status, operation.status);
      assert.equal(result.body.success, true);
      assert.equal(result.body.message, operation.message);
      assert.equal(calls.filter(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)).length, 1);
      assert.equal(logCount, 0, "authentication must not log token fragments");
      if (operation.method === "POST") {
        assert.deepEqual(result.body.data, [{ id: 21, title: "Synthetic event", date: "2026-10-12",
          ...(operation.path === "/holidays" ? { type: "regular holiday" } : {}), createdBy: 123, createdAt: null }]);
        assert.deepEqual(calls.at(-1).params, operation.path === "/holidays"
          ? ["Synthetic event", "2026-10-12", "regular holiday", 7]
          : ["Synthetic event", "2026-10-12", 7]);
      } else {
        assert.deepEqual(result.body, { success: true, message: operation.message });
        assert.deepEqual(calls.at(-1).params, operation.method === "DELETE" ? ["21"]
          : operation.path.startsWith("/holidays") ? ["Synthetic event", "2026-10-12", "regular holiday", "21"]
          : ["Synthetic event", "2026-10-12", "21"]);
      }
    });
  }
  if (operation.method !== "POST") test(`${name}: authorized missing record remains 404`, async () => {
    affectedRows = 0;
    const result = await request(operation, token("PRINCIPAL"));
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { success: false, message: operation.path.startsWith("/activities") ? "Activity not found" : "Holiday not found" });
  });
}
test("caller-provided role fields cannot elevate a signed Teacher", async () => {
  const result = await request(operations[0], token("TEACHER"), { ...operations[0].body, role: "ADMIN", user: { role: "PRINCIPAL" } });
  assert.equal(result.status, 403);
  assert.equal(calls.length, 0);
});
test("valid authorization preserves existing payload validation", async () => {
  const result = await request(operations[0], token("ADMIN"), { entries: [] });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { success: false, message: "entries must be a non-empty array" });
  assert.equal(calls.length, 0);
});
for (const path of ["/activities", "/all-activities", "/holidays", "/all-holidays"]) {
  test(`GET ${path}: public read contract remains unchanged`, async () => {
    const result = await request({ method: "GET", path });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.data[0].title, "Synthetic event");
  });
}
