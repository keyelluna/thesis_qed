const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');

// Actual routers, JWT verification and controllers. Never load the real DB.
const dbId = require.resolve('../config/db');
const previousDb = require.cache[dbId];
const calls = [];
let writes = 0;
async function query(sql, params) {
  calls.push({ sql, params });
  if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) {
    writes++;
    return [{ insertId: 21, affectedRows: 1 }];
  }
  if (/FOR UPDATE/.test(sql)) return [[]]; // No prior year: no school records.
  if (/SELECT school_year_id AS schoolYearId/.test(sql)) return [[{ schoolYearId: 7 }]];
  if (/FROM school_year sy/.test(sql)) return [[{
    id: 21, school_year: '2090-2091', is_active: 1,
    start_date: '2090-08-01', end_date: '2091-05-31',
  }]];
  return [[{ id: 31, term_number: 1, term_label: 'Term 1', termNumber: 1,
    termLabel: 'Term 1', schoolYearId: 21, isActive: 1,
    start_date: '2090-08-01', end_date: '2090-10-31',
    startDate: '2090-08-01', endDate: '2090-10-31' }]];
}
const connection = {
  query, execute: query,
  async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
  async commit() { calls.push({ sql: 'COMMIT' }); },
  async rollback() { calls.push({ sql: 'ROLLBACK' }); },
  release() { calls.push({ sql: 'RELEASE' }); },
  async getConnection() { calls.push({ sql: 'CONNECT' }); return connection; },
};
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: connection };
const periods = require('../src/modules/settings/grading-periods/gradingPeriods.router');
const years = require('../src/modules/admin/subject-management/academicYear.router');
const secret = randomBytes(32).toString('hex');
const previousSecret = process.env.JWT_SECRET;
let server, base;
test.before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express();
  app.use(cookieParser()); app.use(express.json());
  app.use('/api/gradingPeriods', periods); app.use('/api/academic-year', years);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { calls.length = 0; writes = 0; });
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
  if (previousDb) require.cache[dbId] = previousDb; else delete require.cache[dbId];
});
const operations = [
  ['POST', '/api/gradingPeriods/', { schoolYearId: 21, termNumber: 1, termLabel: 'Term 1', startDate: '2090-08-01', endDate: '2090-10-31' }, 201, 1],
  ['PUT', '/api/gradingPeriods/31', { termLabel: 'Term 1' }, 200, 1],
  ['PUT', '/api/gradingPeriods/31/activate', {}, 200, 2],
  ['DELETE', '/api/gradingPeriods/31', undefined, 200, 1],
  ['POST', '/api/academic-year/addAcademicYear', { label: '2090-2091', status: 'Active' }, 201, 4],
  ['PUT', '/api/academic-year/saveTerms/21', { terms: [{ termNumber: 1, startDate: '2090-08-01', endDate: '2090-10-31' }] }, 200, 1],
];
function token(role, options = {}) {
  return jwt.sign({ userId: 123, ...(role === undefined ? {} : { role }) }, secret, { expiresIn: '1m', ...options });
}
async function request(method, path, body, auth) {
  const response = await fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: `token=${auth}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
for (const [method, path, body, status, mutations] of operations) {
  for (const role of ['PRINCIPAL', 'TEACHER', 'PARENT', 'UNKNOWN', undefined, null, [], {}, 123, ' ADMIN ']) {
    test(`${method} ${path}: ${JSON.stringify(role)} denied before connection or SQL`, async () => {
      const result = await request(method, path, body, token(role));
      // Valid non-Admin sessions reach role authorization; malformed roles now
      // fail earlier at the common session boundary. Both must prevent all SQL.
      const validRole = ['PRINCIPAL', 'TEACHER', 'PARENT'].includes(role);
      assert.deepEqual(result, { status: validRole ? 403 : 401, body: validRole
        ? { success: false, message: 'Administrator access is required.' }
        : { message: 'Invalid or expired token.' } });
      assert.equal(calls.length, 0); assert.equal(writes, 0);
    });
  }
  for (const kind of ['missing', 'invalid', 'expired']) {
    test(`${method} ${path}: ${kind} authentication cannot write`, async () => {
      const auth = kind === 'missing' ? undefined : kind === 'invalid' ? 'invalid-test-jwt' : token('ADMIN', { expiresIn: -1 });
      const result = await request(method, path, body, auth);
      assert.equal(result.status, 401);
      assert.equal(calls.length, 0); assert.equal(writes, 0);
    });
  }
  for (const role of ['ADMIN', 'admin']) {
    test(`${method} ${path}: authenticated ${role} retains controller success`, async () => {
      const result = await request(method, path, body, token(role));
      assert.equal(result.status, status); assert.equal(writes, mutations);
      if (path.startsWith('/api/gradingPeriods')) {
        assert.deepEqual(result.body, method === 'POST' ? { success: true, id: '21' } : { success: true });
      } else {
        assert.equal(result.body.status, 'success'); assert.ok(result.body.data);
        assert.ok(calls.some(call => call.sql === 'COMMIT'));
      }
    });
  }
  test(`${method} ${path}: body and query role spoofing cannot elevate Teacher`, async () => {
    const result = await request(method, path + '?role=ADMIN', { ...body, role: 'ADMIN', user: { role: 'ADMIN' } }, token('TEACHER'));
    assert.equal(result.status, 403); assert.equal(calls.length, 0); assert.equal(writes, 0);
  });
}
for (const role of ['ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT']) {
  for (const path of ['/api/gradingPeriods', '/api/academic-year/getAcademicYear', '/api/academic-year/getAllSy', '/api/academic-year/getTerms/21']) {
    test(`GET ${path}: ${role} retains authenticated read access`, async () => {
      const result = await request('GET', path, undefined, token(role));
      assert.equal(result.status, 200); assert.ok(result.body.data);
      assert.equal(writes, 0); assert.ok(calls.length > 0);
    });
  }
}
