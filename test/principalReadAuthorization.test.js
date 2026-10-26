const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

// Actual routers/JWT/authorization over loopback HTTP. Controllers are inert:
// no MySQL, school records, mail, or notification services are loaded.
const injected = new Map();
let controllerCalls = 0;
function inject(relative, names) {
  const id = require.resolve(relative);
  injected.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports: Object.fromEntries(names.map(name => [name, (_req, res) => {
    controllerCalls++;
    res.status(200).json({ controller: name });
  }])) };
}
inject('../src/modules/principal/dashboard/overviewCard.controller', ['getOverviewSummary', 'getOverviewAttendance', 'getSchoolWideAcademicPerformance']);
inject('../src/modules/principal/dashboard/attendance.controller', ['getTodaysAttendance', 'getAttendanceByGrade']);
inject('../src/modules/principal/dashboard/subjectPerformance.controller', ['getTopSubjectPerGrade', 'getSubjectRankingByTerm']);
inject('../src/modules/principal/dashboard/holistic.controller', ['getHolisticOverview']);
inject('../src/modules/principal/dashboard/academicPerformance.controller', ['getPerformanceByGrade', 'getPerformanceTrend', 'getActiveTerm']);
inject('../src/modules/principal/Reports/reports.controller', ['getTermOptions', 'getSubjectRanking', 'getGradeOptions', 'getHolisticRows', 'getViewOptions']);
inject('../src/modules/principal/students/students.controller', ['getGradeLevels', 'getTotalStudents', 'getClassList', 'getUnassignedClassList']);
inject('../src/modules/principal/teachers/teachers.controller', ['getTeachersDirectory', 'getTeacherProfile']);
inject('../src/modules/admin/student-record/studentRecord.controller', ['addNewStudent', 'updateStudent', 'getStudentById', 'getTotalStudents', 'getAllStudents', 'getAllGrade', 'softDeleteStudent']);

const endpoints = [
  ...['overview-summary', 'attendanceRate', 'getTodaysAttendance', 'getAttendanceByGrade', 'topSubjectPerGrade', 'subjectRankingByTerm', 'academicPerformance', 'holisticDomain', 'performanceByGrade', 'performanceTrend', 'active-term'].map(p => '/dashboard/' + p),
  ...['term-options', 'subject-ranking?term=Term%201', 'grade-options', 'holistic?term=Term%201', 'view-options'].map(p => '/reports/' + p),
  ...['grade-levels', 'total-student', 'class-list/902', 'grade/1/unassigned'].map(p => '/students/' + p),
  '/teachers/', '/teachers/51',
];
const secret = randomBytes(32).toString('hex');
const previousSecret = process.env.JWT_SECRET;
let server, base;
test.before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express(); app.use(cookieParser());
  // The real application mounts core scoped student routes before the Principal
  // router at the same prefix. Preserve that ordering and four-role handoff.
  app.use('/students', require('../src/modules/admin/student-record/studentRecord.router'));
  for (const [mount, file] of [
    ['/dashboard', '../src/modules/principal/dashboard/dashboard.router'],
    ['/reports', '../src/modules/principal/Reports/reports.router'],
    ['/students', '../src/modules/principal/students/students.router'],
    ['/teachers', '../src/modules/principal/teachers/teachers.router'],
  ]) app.use(mount, require(file));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  for (const [id, previous] of injected) { if (previous) require.cache[id] = previous; else delete require.cache[id]; }
});
function token(payload, options = {}) { return jwt.sign(payload, secret, { expiresIn: '5m', ...options }); }
async function request(endpoint, credential) {
  return fetch(base + endpoint, { headers: credential ? { Cookie: `token=${credential}` } : {} });
}
for (const role of ['admin', 'principal', 'teacher', 'parent']) {
  for (const endpoint of ['/students/allStudents', '/students/viewStudent/902', '/students/allGrade', '/students/totalStudents']) {
    test(`${role} retains the earlier scoped core student route ${endpoint}`, async () => {
      controllerCalls = 0;
      const response = await request(endpoint, token({ userId: 101, role }));
      assert.equal(response.status, 200); assert.equal(controllerCalls, 1);
      const body = await response.json();
      assert.ok(['getAllStudents', 'getStudentById', 'getAllGrade', 'getTotalStudents'].includes(body.controller));
    });
  }
}
for (const endpoint of endpoints) {
  test(`${endpoint}: missing credentials denied before controller`, async () => {
    controllerCalls = 0; const response = await request(endpoint);
    assert.equal(response.status, 401); assert.equal(controllerCalls, 0);
  });
  for (const role of ['teacher', 'parent', 'TEACHER', 'PARENT', 'OWNER', null, {}, ['admin'], ' admin ']) {
    test(`${endpoint}: ${JSON.stringify(role)} cannot read school-wide records or spoof role`, async () => {
      controllerCalls = 0;
      const separator = endpoint.includes('?') ? '&' : '?';
      const response = await request(endpoint + separator + 'role=admin&userId=999', token({ userId: 801, role }));
      assert.equal(response.status, ['teacher', 'parent', 'TEACHER', 'PARENT'].includes(role) ? 403 : 401); assert.equal(controllerCalls, 0);
    });
  }
  for (const role of ['admin', 'principal', 'ADMIN', 'PRINCIPAL']) {
    test(`${endpoint}: authorized ${role} retains controller response`, async () => {
      controllerCalls = 0; const response = await request(endpoint, token({ userId: 101, role }));
      assert.equal(response.status, 200); assert.equal(controllerCalls, 1);
      assert.equal(typeof (await response.json()).controller, 'string');
    });
  }
  for (const kind of ['invalid', 'expired', 'recovery', 'malformed-identity']) {
    test(`${endpoint}: ${kind} token denied before controller`, async () => {
      const credential = kind === 'invalid' ? 'invalid-token' : kind === 'expired' ? token({ userId: 101, role: 'principal' }, { expiresIn: -1 }) : kind === 'recovery' ? token({ userId: 101, role: 'principal', purpose: 'password-reset' }) : token({ userId: {}, role: 'principal' });
      controllerCalls = 0; const response = await request(endpoint, credential);
      assert.equal(response.status, 401); assert.equal(controllerCalls, 0);
    });
  }
}
