const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const http = require("node:http");
const { randomBytes } = require("node:crypto");

// Real local HTTP/router/JWT/controller. Install an inert double BEFORE loading
// the controller: never load config/db, .env, server.js or a remote database.
const dbId = require.resolve("../config/db");
const previousDb = require.cache[dbId];
const calls = [];
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: {
  async execute(sql, params) {
    calls.push({ sql, params });
    if (sql.includes("GROUP BY YEAR")) return [[
      { y: 2026, m: 1, cnt: "10" }, { y: 2026, m: 10, cnt: "30" },
      { y: 2025, m: 1, cnt: "20" },
    ]];
    if (!sql.includes("GROUP BY")) return [[{ cnt: "14" }]];
    const rows = [{ d: "2026-10-01", cnt: "11" }, { d: "2026-10-05", cnt: "7" }, { d: "2026-10-11", cnt: "14" }];
    return [rows.filter(row => row.d >= params[0].slice(0, 10) && row.d < params[1].slice(0, 10))];
  },
} };
const controller = require("../src/modules/authentication/loginfrequency.controller");
// Observe the actual controller without replacing its logic or response mapping.
const originalController = controller.getLoginFrequency;
let controllerCalls = 0;
controller.getLoginFrequency = (...args) => { controllerCalls++; return originalController(...args); };
const router = require("../src/modules/authentication/loginfrequency.router");
const previousSecret = process.env.JWT_SECRET;
const secret = randomBytes(32).toString("hex");
let server, baseUrl;

test.before(async () => {
  test.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-11T04:00:00Z").getTime() });
  process.env.JWT_SECRET = secret;
  const app = express();
  app.use(cookieParser()); app.use(express.json());
  app.use("/api/analytics", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/analytics/login-frequency`;
});
test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  test.mock.timers.reset();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
  controller.getLoginFrequency = originalController;
  if (previousDb) require.cache[dbId] = previousDb;
  else delete require.cache[dbId];
});
test.beforeEach(() => { calls.length = 0; controllerCalls = 0; });

function token(role, options = {}, signingSecret = secret) {
  return jwt.sign({ userId: 123, ...(role === undefined ? {} : { role }) }, signingSecret, { expiresIn: "5m", ...options });
}
// http.request permits a GET body for adversarial spoof tests. No token/cookie
// values are attached to assertions, reports or console output.
async function request(query, cookie, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(baseUrl + query, { method: "GET", headers: {
      ...extraHeaders, ...(cookie ? { Cookie: `token=${cookie}` } : {}),
      ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
    } }, res => {
      let data = "";
      res.setEncoding("utf8"); res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject); req.end(payload);
  });
}
function denied(result, status, body) {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
  assert.equal(controllerCalls, 0, "denial must precede controller execution");
  assert.equal(calls.length, 0, "denial must precede database execution");
}
const forbidden = { success: false, message: "Administrator access is required." };
const invalidToken = { message: "Invalid or expired token." };
const summaries = {
  weekly: { peakLabel: "Sun", peakCount: 14, peakType: "Peak Day", averageDaily: 3, averageLabel: "Avg. Daily Logins", growthPercent: 50, growthLabel: "Weekly Growth" },
  monthly: { peakLabel: "11", peakCount: 14, peakType: "Peak Day", averageDaily: 2.9, averageLabel: "Avg. Daily Logins", growthPercent: 128.6, growthLabel: "Monthly Growth" },
  yearly: { peakLabel: "Oct", peakCount: 30, peakType: "Peak Month", averageDaily: 4, averageLabel: "Avg. Monthly Logins", growthPercent: 100, growthLabel: "Yearly Growth" },
};
const charts = {
  weekly: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, i) => ({ label, count: i === 0 ? 7 : i === 6 ? 14 : 0 })),
  monthly: Array.from({ length: 31 }, (_, i) => ({ label: String(i + 1), count: ({ 1: 11, 5: 7, 11: 14 })[i + 1] ?? 0 })),
  yearly: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((label, i) => ({ label, count: i === 0 ? 10 : i === 9 ? 30 : 0 })),
};
const parameters = {
  weekly: [["2026-10-05 00:00:00", "2026-10-12 00:00:00"], ["2026-09-28 00:00:00", "2026-10-05 00:00:00"]],
  monthly: [["2026-10-01 00:00:00", "2026-11-01 00:00:00"], ["2026-09-01 00:00:00", "2026-09-12 00:00:00"]],
  yearly: [["2025-01-01 00:00:00", "2025-10-12 00:00:00", "2026-01-01 00:00:00", "2026-10-12 00:00:00"]],
};

for (const period of ["weekly", "monthly", "yearly"]) {
  test(`${period}: missing authentication is 401 before controller/database`, async () => {
    denied(await request(`?period=${period}`), 401, { message: "No token provided." });
  });
  const roles = [
    ["Principal", "PRINCIPAL"], ["Teacher", "TEACHER"], ["Parent", "PARENT"],
    ["unknown", "OWNER"], ["missing", undefined], ["null", null], ["empty", ""],
    ["number", 1], ["boolean", true], ["array", ["ADMIN"]],
    ["object", { role: "ADMIN" }], ["whitespace", " ADMIN "],
  ];
  for (const [name, role] of roles) test(`${period}: signed ${name} role denied before controller/database`, async () => {
    denied(await request(`?period=${period}`, token(role)), ["PRINCIPAL", "TEACHER", "PARENT"].includes(role) ? 403 : 401,
      ["PRINCIPAL", "TEACHER", "PARENT"].includes(role) ? forbidden : invalidToken);
  });
  for (const invalid of ["malformed", "expired", "wrong-signature", "unsigned", "not-active"]) {
    test(`${period}: ${invalid} JWT retains authentication denial contract`, async () => {
      const value = invalid === "malformed" ? "not-a-jwt"
        : invalid === "expired" ? token("ADMIN", { expiresIn: -1 })
        : invalid === "wrong-signature" ? token("ADMIN", {}, randomBytes(32).toString("hex"))
        : invalid === "unsigned" ? jwt.sign({ userId: 123, role: "ADMIN" }, "", { algorithm: "none" })
        : token("ADMIN", { notBefore: "1h" });
      denied(await request(`?period=${period}`, value), 401, invalidToken);
    });
  }
  for (const role of ["ADMIN", "admin", "AdMiN"]) test(`${period}: ${role} exact response and date-range golden`, async () => {
    const result = await request(`?period=${period}`, token(role));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { period, chart: charts[period], summary: summaries[period] });
    assert.equal(controllerCalls, 1);
    assert.deepEqual(calls.map(call => call.params), parameters[period]);
    assert.ok(calls.every(call => /^SELECT/.test(call.sql)), "authorized reader must remain read-only");
  });
  test(`${period}: query/body/header role spoof cannot elevate signed Teacher`, async () => {
    denied(await request(`?period=${period}&role=ADMIN&user[role]=ADMIN`, token("TEACHER"),
      { role: "ADMIN", user: { role: "ADMIN" } }, { "X-Role": "ADMIN" }), 403, forbidden);
  });
}
test("spoofed role without authentication cannot bypass JWT verification", async () => {
  denied(await request("?role=ADMIN", undefined, { role: "ADMIN" }, { "X-Role": "ADMIN" }), 401, { message: "No token provided." });
});
test("signed string payload without a role cannot authorize analytics", async () => {
  denied(await request("?period=weekly", jwt.sign("ADMIN", secret)), 401, invalidToken);
});
test("default period and case-insensitive period keep authorized response contract", async () => {
  for (const query of ["", "?period=WEEKLY"]) {
    const result = await request(query, token("ADMIN"));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { period: "weekly", chart: charts.weekly, summary: summaries.weekly });
  }
  assert.equal(controllerCalls, 2); assert.equal(calls.length, 4);
});
test("authorized invalid period keeps existing 400 contract without database work", async () => {
  const result = await request("?period=invalid", token("ADMIN"));
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { message: "Invalid period. Must be one of: weekly, monthly, yearly" });
  assert.equal(controllerCalls, 1); assert.equal(calls.length, 0);
});
test("unauthorized invalid period is denied before controller validation", async () => {
  denied(await request("?period=invalid", token("PARENT")), 403, forbidden);
});
