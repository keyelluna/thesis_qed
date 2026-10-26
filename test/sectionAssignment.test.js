const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');

// Executed SQL against an isolated in-memory database. FOR UPDATE is serialized
// by the adapter; real InnoDB lock behavior needs the separate local MySQL run.
let db, tail = Promise.resolve(), failUpdate = false;
async function query(sql, params = []) {
  sql = sql.replace(/\s+FOR UPDATE/g, '');
  if (failUpdate && /^UPDATE elem_students SET section_id/.test(sql)) throw new Error('Injected storage failure');
  const stmt = db.prepare(sql);
  if (/^\s*SELECT/.test(sql)) return [stmt.all(...params)];
  const result = stmt.run(...params);
  return [{ affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }];
}
async function getConnection() {
  const prior = tail; let release;
  tail = new Promise(resolve => { release = resolve; });
  await prior;
  return { query, execute: query, beginTransaction: async () => db.exec('BEGIN'), commit: async () => db.exec('COMMIT'), rollback: async () => db.exec('ROLLBACK'), release };
}
const dbId = require.resolve('../config/db');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { query, execute: query, getConnection } };
const router = require('../src/modules/admin/student-record/studentRecord.router');
const classController = require('../src/modules/admin/classes-management/classManagement.controller');
const sectionController = require('../src/modules/admin/section-management/section.controller');
const secret = randomBytes(32).toString('hex');
let server, base;
test.before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express(); app.use(cookieParser(), express.json()); app.use('/api/student', router);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/student`;
});
test.after(() => { server.close(); db.close(); });
test.beforeEach(() => {
  if (db) db.close(); db = new DatabaseSync(':memory:'); failUpdate = false;
  db.exec(`CREATE TABLE school_year(id INTEGER PRIMARY KEY, school_year TEXT, is_active INTEGER);
    INSERT INTO school_year VALUES(1,'Old',0),(2,'Current',1);
    CREATE TABLE grade_level(id INTEGER PRIMARY KEY, grade_level TEXT);
    INSERT INTO grade_level VALUES(1,'Grade 1'),(2,'Grade 2');
    CREATE TABLE grade_level_sections(id INTEGER PRIMARY KEY AUTOINCREMENT, section_name TEXT, grade_level_id INTEGER, school_year_id INTEGER, is_active INTEGER DEFAULT 1);
    INSERT INTO grade_level_sections VALUES(10,'Maroon',1,1,1),(20,'Maroon',1,2,1),(21,'White',1,2,1),(22,'Other grade',2,2,1),(23,'Inactive',1,2,0),(24,'No class',1,2,1),(25,'Old class',1,2,1);
    CREATE TABLE classes(id INTEGER PRIMARY KEY AUTOINCREMENT, section_id INTEGER UNIQUE, grade_level_id INTEGER, school_year_id INTEGER, status TEXT, room TEXT, class_adviser_id INTEGER);
    INSERT INTO classes VALUES(1,10,1,1,'Inactive','',1),(2,20,1,2,'Active','',1),(3,21,1,2,'Active','',1),(4,22,2,2,'Active','',1),(5,25,1,2,'Inactive','',1);
    CREATE TABLE elem_students(id INTEGER PRIMARY KEY AUTOINCREMENT, student_number TEXT UNIQUE, learner_reference_number TEXT UNIQUE, first_name TEXT, last_name TEXT, middle_name TEXT, gender TEXT, grade_level_id INTEGER, section_id INTEGER, current_school_year_id INTEGER, is_deleted INTEGER DEFAULT 0, status TEXT);
    INSERT INTO elem_students VALUES(101,'S101','L101','One','Student','','Female',1,NULL,2,0,'active'),(102,'S102','L102','Two','Student','','Male',1,NULL,2,0,'active'),(103,'S103','L103','Assigned','Student','','Male',1,20,2,0,'active'),(104,'S104','L104','Old','Student','','Male',1,NULL,1,0,'active'),(105,'S105','L105','Deleted','Student','','Male',1,NULL,2,1,'active'),(106,'S106','L106','Graduate','Student','','Male',1,NULL,2,0,'graduated'),(107,'S107','L107','Grade2','Student','','Male',2,NULL,2,0,'active'),(108,'S108','L108','Invalid','Student','','Male',1,10,2,0,'active');
    CREATE TABLE student_year_records(student_id INTEGER, school_year_id INTEGER, section_id INTEGER, status TEXT);
    INSERT INTO student_year_records VALUES(101,1,10,'promoted');
    CREATE TABLE grade_scores(student_id INTEGER, score INTEGER); INSERT INTO grade_scores VALUES(101,90);
    CREATE TABLE advisory_attendance_records(student_id INTEGER, class_id INTEGER); INSERT INTO advisory_attendance_records VALUES(101,1);
    CREATE TABLE holistic_ratings(student_id INTEGER, rating INTEGER); INSERT INTO holistic_ratings VALUES(101,4);`);
});
const payload = { schoolYearId: 2, gradeLevelId: 1, sectionId: 20, studentIds: [101,102] };
async function request(path = '/bulk-section-assignment', body = payload, role = 'ADMIN') {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Cookie = `token=${jwt.sign({ userId: 1, role, userName: 'Synthetic' }, secret, { expiresIn: '1h' })}`;
  const response = await fetch(base + path, { method: body === null ? 'GET' : 'POST', headers, ...(body === null ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
function placement(id) { return db.prepare('SELECT section_id FROM elem_students WHERE id = ?').get(id).section_id; }
for (const role of ['TEACHER','PRINCIPAL','PARENT',null]) test(`rejects ${role || 'unauthenticated'} reads and writes`, async () => {
  assert.ok([401,403].includes((await request(undefined, payload, role)).status));
  assert.ok([401,403].includes((await request('/section-assignments', null, role)).status));
  assert.equal(placement(101), null);
});
test('read returns explicit year, valid targets, global counts and invalid-reference status', async () => {
  const r = await request('/section-assignments?gradeLevelId=1', null);
  assert.equal(r.status,200); assert.equal(r.body.data.schoolYear.id,2);
  assert.deepEqual(r.body.data.sections.map(s=>s.id),[20,21]);
  assert.deepEqual(r.body.data.counts,{assigned:1,unassigned:3,needsReview:1});
  assert.equal(r.body.data.students.find(s=>s.id===108).assignment_status,'Needs review');
  assert.ok(r.body.data.students.every(s=>s.grade_level_id===1));
});
for (const grade of ['0','bogus','999']) test(`read rejects grade ${grade}`, async () => assert.equal((await request(`/section-assignments?gradeLevelId=${grade}`,null)).status,400));
test('read safely reports missing or ambiguous active year', async () => {
  db.exec('UPDATE school_year SET is_active=0'); assert.equal((await request('/section-assignments',null)).status,409);
  db.exec('UPDATE school_year SET is_active=1'); assert.equal((await request('/section-assignments',null)).status,409);
});
for (const [name,change,status] of [
  ['duplicate IDs',{studentIds:[101,101]},400],['empty',{studentIds:[]},400],['invalid ID',{studentIds:['101']},400],
  ['oversized',{studentIds:Array.from({length:201},(_,i)=>i+1)},400],['wrong year',{schoolYearId:1},409],
  ['invalid grade',{gradeLevelId:999},400],['old section',{sectionId:10},409],['wrong grade section',{sectionId:22},409],
  ['inactive section',{sectionId:23},409],['no class',{sectionId:24},409],['inactive class',{sectionId:25},409],
  ['missing student',{studentIds:[101,999]},404],['assigned student',{studentIds:[101,103]},409],
  ['old student',{studentIds:[101,104]},409],['deleted student',{studentIds:[101,105]},409],
  ['graduate',{studentIds:[101,106]},409],['wrong grade student',{studentIds:[101,107]},409]
]) test(`atomic rejection: ${name}`, async () => { assert.equal((await request(undefined,{...payload,...change})).status,status); assert.equal(placement(101),null); });
test('assigns only placement and preserves all history; replay conflicts', async () => {
  const tables=['student_year_records','grade_scores','advisory_attendance_records','holistic_ratings'];
  const before=tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all());
  const r=await request(); assert.equal(r.status,200); assert.equal(r.body.data.assignedCount,2);
  assert.equal(placement(101),20); assert.equal(placement(102),20);
  assert.deepEqual(tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all()),before);
  assert.equal((await request()).status,409);
});
test('storage failure rolls back and releases connection', async () => {
  failUpdate=true; assert.equal((await request()).status,500); assert.equal(placement(101),null);
  failUpdate=false; assert.equal((await request()).status,200);
});
test('overlapping requests cannot overwrite an assignment', async () => {
  const results=await Promise.all([request(),request(undefined,{...payload,sectionId:21})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]); assert.equal(placement(101),placement(102));
});
function response() { return { code:200, status(n){this.code=n;return this;}, json(body){this.body=body;return this;} }; }
test('new year class resolution does not reuse historical section names', async () => {
  db.exec('DELETE FROM classes WHERE id=2; DELETE FROM grade_level_sections WHERE id=20');
  const res=response(); await classController.createClass({body:{gradeLevel:1,section:'Maroon',room:'A',adviserId:1,schedule:[]}},res);
  assert.equal(res.code,201); const old=db.prepare('SELECT * FROM classes WHERE id=1').get(); assert.equal(old.section_id,10);
  const created=db.prepare('SELECT * FROM classes WHERE id=?').get(res.body.classId); assert.notEqual(created.section_id,10);
  assert.equal(db.prepare('SELECT school_year_id FROM grade_level_sections WHERE id=?').get(created.section_id).school_year_id,2);
});
test('section creation allows same name across years, rejects same-year duplicate', async () => {
  const res=response(); await sectionController.createSection({body:{gradeLevel:2,sectionName:'Maroon'}},res); assert.equal(res.code,201);
  const duplicate=response(); await sectionController.createSection({body:{gradeLevel:2,sectionName:'Maroon'}},duplicate); assert.equal(duplicate.code,409);
});
test('individual edit rejects stale placement and validates target', async () => {
  const controller=require('../src/modules/admin/student-record/studentRecord.controller');
  const body={studentId:'S101',lrn:'L101',firstName:'One',lastName:'Student',middleName:'',gender:'Female',gradeLevel:1,section:20,expectedPlacement:{schoolYearId:2,gradeLevelId:1,sectionId:null}};
  const first=response(); await controller.updateStudent({params:{id:101},body},first); assert.equal(first.code,200);
  const stale=response(); await controller.updateStudent({params:{id:101},body:{...body,section:null}},stale); assert.equal(stale.code,409); assert.equal(placement(101),20);
  const invalid=response(); await controller.updateStudent({params:{id:102},body:{...body,section:10}},invalid); assert.equal(invalid.code,409);
});
test('historical sections cannot be edited or removed', async () => {
  for (const operation of ['updateSection','deactivateSection','deleteSection']) {
    const res=response(); await sectionController[operation]({params:{id:10},body:{sectionName:'Changed'}},res);
    assert.equal(res.code,409);
  }
  assert.equal(db.prepare('SELECT section_name FROM grade_level_sections WHERE id=10').get().section_name,'Maroon');
});
test('assigned sections cannot be deactivated or deleted', async () => {
  for (const operation of ['deactivateSection','deleteSection']) {
    const res=response(); await sectionController[operation]({params:{id:20}},res); assert.equal(res.code,409);
  }
  assert.equal(placement(103),20);
});
test('historical classes cannot be deleted and occupied classes cannot be remapped', async () => {
  const old=response(); await classController.deleteClass({params:{id:1}},old); assert.equal(old.code,404);
  const remap=response(); await classController.updateClass({params:{id:2},body:{gradeLevel:1,section:'New section',room:'A',adviserId:1,schedule:[]}},remap);
  assert.equal(remap.code,409); assert.equal(db.prepare('SELECT section_id FROM classes WHERE id=2').get().section_id,20);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM grade_level_sections WHERE section_name='New section'").get().n,0);
});
