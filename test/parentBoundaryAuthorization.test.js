const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');

// Actual routers/JWT/controllers; deterministic database double, never live data.
const calls = [];
let writes = 0;
async function query(sql, params = []) {
  calls.push({ sql, params });
  if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) { writes++; return [{ affectedRows: 1 }]; }
  if (sql.includes('FROM elem_students s')) return [sql.includes('pt.user_id') && !((Number(params[1])===801&&[101,103].includes(Number(params[0])))||(Number(params[1])===802&&Number(params[0])===102)) ? [] : [{ id: Number(params[0]), first_name: 'Synthetic', last_name: 'Child', student_number: 'S101', grade_level_name: 'Grade 1' }]];
  if (sql.includes('FROM parent_table')) return [Number(params[0])===801?[{id:51}]:Number(params[0])===802?[{id:52}]:[]];
  if (sql.includes('FROM parent_student')) return [([51,801].includes(Number(params[0]))&&[101,103].includes(Number(params[1])))||([52,802].includes(Number(params[0]))&&Number(params[1])===102)?[{}]:[]];
  if (sql.includes('FROM school_year')) return [[{ id: 7 }]];
  if (sql.includes('section_id AS sectionId')) return [[{ id: Number(params[0]), sectionId: 11, gradeLevelId: 1, schoolYearId: 7 }]];
  if (sql.includes('SELECT id FROM elem_students')) return [[{ id: Number(params[0]) }]];
  if (sql.includes('grading_periods gp')) return [[{ id: 1, gradingPeriodId: 1, termNumber: 1, termLabel: 'Term 1', isVisible: 0, termEnded: 0 }]];
  return [[]];
}
const dbId = require.resolve('../config/db');
const priorDb = require.cache[dbId];
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { query, execute: query } };
const secret = randomBytes(32).toString('hex');
const priorSecret = process.env.JWT_SECRET;
let server, base;
const parentRoutes = [
  ['/dashboard', '../src/modules/parents/Dashboard/dashboard.router', '/parent', 'GET'],
  ['/year', '../src/modules/parents/getSchoolYear/schoolYear.router', '/', 'GET'],
  ['/linked', '../src/modules/parents/LinkedChildren/linkedChildren.router', '/', 'POST'],
  ['/linked-confirm', '../src/modules/parents/LinkedChildren/linkedChildren.router', '/confirm', 'POST'],
  ['/linked-list', '../src/modules/parents/LinkedChildren/linkedChildren.router', '/', 'GET'],
  ['/account', '../src/modules/parents/parentsProfile/parentsProfile.router', '/', 'GET'],
  ['/monthly', '../src/modules/parents/Student-Record/Overview/attendance.router', '/?student_id=102&month=10&year=2026', 'GET'],
  ['/overview-academic', '../src/modules/parents/Student-Record/Overview/studentTermPerformance.router', '/students/102/term-performance', 'GET'],
  ['/overview-holistic', '../src/modules/parents/Student-Record/Overview/holisticPerformance.router', '/102', 'GET'],
  ['/holistic', '../src/modules/parents/Student-Record/ProgressReport/termHolistic.router', '/102', 'GET'],
  ['/attendance', '../src/modules/parents/Student-Record/ProgressReport/attendance.router', '/summary/102', 'GET'],
  ['/weekly', '../src/modules/parents/Student-Record/holistic/weeklyHolistic.router', '/students/102?termNumber=1', 'GET'],
  ['/flags', '../src/modules/parents/Student-Record/Academic/interventionNotif.router', '/102', 'GET'],
  ['/courseware', '../src/modules/parents/Student-Record/Academic/courseware.router', '/102/1', 'GET'],
  ...['/petState/102','/intervention/102/1','/quiz/102/1','/bonus/102/1'].map(path=>['/pet', '../src/modules/parents/Student-Record/Academic/petquiz.router', path, 'GET']),
  ...['/quiz/102/1/grade-single','/quiz/102/1/submit','/bonus/102/1/complete','/mastery/102/1'].map(path=>['/pet', '../src/modules/parents/Student-Record/Academic/petquiz.router', path, 'POST']),
];
test.before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express(); app.use(cookieParser()); app.use(express.json());
  for (const [mount, module] of [
    ['/profile', 'StudentProfile/studentProfile.Router'],
    ['/schedule', 'Academic/classSchedule.router'],
    ['/missed', 'Academic/missedActivities.router'],
    ['/progress', 'ProgressReport/termPerformance.router'],
  ]) app.use(mount, require('../src/modules/parents/Student-Record/' + module));
  const mounted = new Set();
  for (const [mount,module] of parentRoutes) { if (!mounted.has(mount)) { app.use(mount, require(module)); mounted.add(mount); } }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { calls.length = 0; writes = 0; });
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret;
  if (priorDb) require.cache[dbId] = priorDb; else delete require.cache[dbId];
});
async function request(path, claims, method = 'GET', kind, payload) {
  const token = claims ? kind === 'invalid' ? 'invalid' : jwt.sign(claims, secret, { expiresIn: kind === 'expired' ? -1 : '2m' }) : undefined;
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(payload ?? { dateOfBirth: '2018-01-01', residentialAddress: 'Synthetic', role: 'ADMIN', userId: 901 }) }) });
  return { status: response.status, body: await response.json() };
}
const reads = ['/profile/102', '/schedule/102', '/missed/102', '/progress/102/visibility', '/progress/102/term-performance'];
for (const path of reads) {
  for (const role of ['PARENT', 'parent']) test(`${role} cannot read unrelated child ${path}`, async () => {
    const result = await request(path + '?role=ADMIN&userId=901&parentId=52', { userId: 801, role });
    assert.equal(result.status, path.startsWith('/profile') ? 404 : 403); assert.equal(result.body.data, undefined); assert.equal(writes, 0);
    assert.ok(!calls.some(c => /FROM (?:grade_visibility|grade_items|class_schedule|subject_grade_cache)/i.test(c.sql)));
  });
  for (const kind of ['missing', 'invalid', 'expired']) test(`${kind} denied ${path}`, async () => {
    assert.equal((await request(path, kind === 'missing' ? undefined : { userId: 801, role: 'PARENT' }, 'GET', kind)).status, kind === 'missing' ? 401 : 403);
    assert.equal(calls.length, 0); assert.equal(writes, 0);
  });
}
for (const role of ['PARENT', 'PRINCIPAL', 'TEACHER', 'UNKNOWN', null, [], {}]) test(`non-Admin profile write denied: ${JSON.stringify(role)}`, async () => {
  assert.equal((await request('/profile/101?role=ADMIN', { userId: 801, role }, 'PUT')).status, 403);
  assert.equal(calls.length, 0); assert.equal(writes, 0);
});
for (const role of ['PARENT', 'parent']) {
  for (const path of ['/profile/101', '/schedule/101', '/missed/101', '/progress/101/visibility', '/progress/101/term-performance']) test(`${role} linked child allowed ${path}`, async () => {
    const result = await request(path, { userId: 801, role }); assert.equal(result.status, 200); assert.equal(writes, 0);
    if (path.endsWith('/term-performance')) assert.equal(result.body.data[0].released, false);
  });
}
test('Admin profile write retained', async () => {
  assert.equal((await request('/profile/101', { userId: 901, role: 'ADMIN' }, 'PUT')).status, 200); assert.equal(writes, 1);
});
for (const [mount,,path,method] of parentRoutes) {
  for (const role of ['ADMIN','PRINCIPAL','TEACHER','UNKNOWN',null,[],{}]) test(`${JSON.stringify(role)} denied Parent boundary ${method} ${mount}${path} before SQL`,async()=>{
    const result=await request(mount+path+(path.includes('?')?'&':'?')+'role=PARENT&userId=801&parentId=51',{userId:801,role},method);
    assert.equal(result.status,403);assert.equal(calls.length,0);assert.equal(writes,0);
  });
  for (const kind of ['missing','invalid','expired']) test(`${kind} denied Parent boundary ${method} ${mount}${path} before SQL`,async()=>{
    assert.equal((await request(mount+path,kind==='missing'?undefined:{userId:801,role:'PARENT'},method,kind)).status,kind==='missing'?401:403);
    assert.equal(calls.length,0);assert.equal(writes,0);
  });
}
for (const path of ['/profile/101','/profile/103','/schedule/101','/missed/101','/progress/101/term-performance']) test(`Parent B cannot read Parent A ${path}`,async()=>{
  const result=await request(path,{userId:802,role:'PARENT'});assert.equal(result.status,path.startsWith('/profile')?404:403);assert.equal(writes,0);
});
for(const [userId,studentId]of [[801,101],[801,103],[802,102]])test(`verified authentication ID ${userId} reads linked profile ${studentId}`,async()=>{
  const result=await request('/profile/'+studentId,{userId,role:'PARENT'});assert.equal(result.status,200);assert.equal(result.body.id,String(studentId));assert.deepEqual(calls[0].params,[String(studentId),userId]);assert.match(calls[0].sql,/pt\.is_deleted = 0/);
});
for(const path of ['/schedule/101','/missed/101','/progress/101/term-performance'])test(`role-table ID cannot substitute for authentication ID ${path}`,async()=>{
  const result=await request(path,{userId:51,role:'PARENT'});assert.equal(result.status,path.includes('progress')?404:403);assert.equal(writes,0);
});
for(const [mount,,path,method] of parentRoutes.filter(([mount])=>['/monthly','/overview-academic','/overview-holistic','/holistic','/attendance','/weekly','/flags','/courseware','/pet'].includes(mount)))test(`Parent A cannot read or mutate unrelated child ${method} ${mount}${path}`,async()=>{
  const result=await request(mount+path,{userId:801,role:'PARENT'},method,undefined,{practiceSetId:17,questionId:19,selected:'A',difficulty:'Easy',answers:[{questionId:19,selected:'A'}],mode:'full',game:'match',role:'ADMIN',userId:802,parentId:52});
  assert.ok([403,404].includes(result.status),`Expected ownership denial, got ${result.status}`);assert.equal(writes,0);
  assert.ok(!calls.some(c=>/FROM (?:pet_level_progress|pet_answers|ai_practice_sets|ai_practice_questions|ai_courseware|attendance_records|subject_grade_cache)/i.test(c.sql)));
});
