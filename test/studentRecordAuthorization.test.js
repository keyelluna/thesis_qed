const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Real Express/JWT/controllers and executed SQL. Isolated SQLite is a SQL-backed
// MySQL adapter double, NOT a claim of real MySQL or live-school verification.
let database;
const calls = [];
let mutations = 0;
const dbId = require.resolve('../config/db');
const previousDb = require.cache[dbId];
async function query(sql, params = []) {
  calls.push({ sql, params });
  const statement = database.prepare(sql);
  if (/^\s*SELECT/i.test(sql)) return [statement.all(...params)];
  const result = statement.run(...params);
  mutations += Number(result.changes);
  return [{ affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }];
}
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { query, execute: query } };
const router = require('../src/modules/admin/student-record/studentRecord.router');
// These dependencies serve other endpoints, never the tested profile reader.
for (const [path, exports] of [
  ['../src/modules/teacher/gradebook/subjectGrading.controller', { loadSubjectSection: () => { throw new Error('Unused test dependency'); } }],
  ['../src/modules/notification/notification.service', {}],
]) { const id=require.resolve(path);require.cache[id]={id,filename:id,loaded:true,exports}; }
const holisticRouter = require('../src/modules/teacher/holistic/holistics.router');
const secret = randomBytes(32).toString('hex');
const previousSecret = process.env.JWT_SECRET;
let server, base;
test.before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express(); app.use(cookieParser()); app.use(express.json());
  app.use('/api/student', router);
  app.use('/api/teacherHolistic', holisticRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/student`;
});
test.beforeEach(() => {
  database = new DatabaseSync(':memory:');
  database.function('NOW', () => '2090-10-13 12:00:00');
  database.function('CONCAT', {varargs:true}, (...values) => values.join(''));
  database.function('DATE_FORMAT', (value, format) => { assert.equal(format,'%Y-%m-%d');return String(value).slice(0,10); });
  database.exec(`
    CREATE TABLE school_year(id INTEGER PRIMARY KEY, is_active INTEGER);
    INSERT INTO school_year VALUES(6,0),(7,1),(8,0);
    CREATE TABLE grade_level(id INTEGER PRIMARY KEY, grade_level TEXT);
    INSERT INTO grade_level VALUES(1,'Grade 1'),(2,'Grade 2'),(3,'Grade 3'),(4,'Grade 4'),(5,'Grade 5'),(6,'Grade 6');
    CREATE TABLE grade_level_sections(id INTEGER PRIMARY KEY, section_name TEXT);
    INSERT INTO grade_level_sections VALUES(11,'A'),(12,'B'),(13,'C'),(15,'E'),(16,'F'),(17,'Other');
    CREATE TABLE teacher_table(id INTEGER PRIMARY KEY, user_id INTEGER, is_deleted INTEGER);
    INSERT INTO teacher_table VALUES(41,701,0),(42,702,0),(43,703,1);
    CREATE TABLE parent_table(id INTEGER PRIMARY KEY, user_id INTEGER, is_deleted INTEGER);
    INSERT INTO parent_table VALUES(51,801,0),(52,802,0),(53,803,1);
    CREATE TABLE parent_student(parent_id INTEGER, student_id INTEGER);
    INSERT INTO parent_student VALUES(51,103),(52,105),(53,101);
    CREATE TABLE elem_subjects(id INTEGER PRIMARY KEY, grade_level_id INTEGER);
    INSERT INTO elem_subjects VALUES(21,1),(23,3),(25,5),(26,6);
    CREATE TABLE [subject-section](id INTEGER PRIMARY KEY, teacher_id INTEGER, subject_id INTEGER, section_id INTEGER, school_year_id INTEGER);
    INSERT INTO [subject-section] VALUES(61,41,21,11,7),(62,41,23,NULL,7),(63,41,25,15,6),(64,42,26,16,7),(65,43,25,15,7);
    CREATE TABLE classes(id INTEGER PRIMARY KEY, class_adviser_id INTEGER, section_id INTEGER, grade_level_id INTEGER, school_year_id INTEGER, status TEXT);
    INSERT INTO classes VALUES(71,41,12,2,7,'Active'),(72,41,NULL,4,7,'Active'),(73,41,15,5,7,'Inactive');
    CREATE TABLE elem_students(id INTEGER PRIMARY KEY, student_number TEXT UNIQUE, learner_reference_number TEXT UNIQUE,
      first_name TEXT, last_name TEXT, middle_name TEXT, gender TEXT, grade_level_id INTEGER, section_id INTEGER,
      parent_guardian_name TEXT, current_school_year_id INTEGER, status TEXT DEFAULT 'active', is_deleted INTEGER DEFAULT 0, deleted_at TEXT);
    INSERT INTO elem_students(id,student_number,learner_reference_number,first_name,last_name,middle_name,gender,grade_level_id,section_id,current_school_year_id,status,is_deleted) VALUES
      (101,'S101','L101','Synthetic','Subject','','Male',1,11,7,'active',0),
      (102,'S102','L102','Synthetic','Advisory','','Female',2,12,7,'active',0),
      (103,'S103','L103','Synthetic','WholeGrade','','Male',3,13,7,'active',0),
      (104,'S104','L104','Synthetic','UnsectionedAdvisory','','Female',4,NULL,7,'active',0),
      (105,'S105','L105','Synthetic','Unrelated','','Male',5,15,7,'active',0),
      (106,'S106','L106','Synthetic','OtherTeacher','','Female',6,16,7,'active',0),
      (107,'S107','L107','Synthetic','OldYear','','Male',1,11,6,'active',0),
      (108,'S108','L108','Synthetic','Graduated','','Female',1,11,7,'graduated',0),
      (109,'S109','L109','Synthetic','Deleted','','Male',1,11,7,'active',1),
      (110,'S110','L110','Synthetic','UnsectionedSubject','','Female',3,NULL,7,'active',0),
      (111,'S111','L111','Synthetic','OtherSectionSameGrade','','Male',1,17,7,'active',0),
      (112,'S112','L112','Synthetic','UnassignedGrade','','Female',5,NULL,7,'active',0),
      (113,'S113','L113','Synthetic','OtherSectionAdvisoryGrade','','Male',4,17,7,'active',0);
  `);
  database.exec(`ALTER TABLE elem_subjects ADD COLUMN subject_name TEXT DEFAULT 'Synthetic Subject';
    ALTER TABLE [subject-section] ADD COLUMN status TEXT DEFAULT 'Active';
    CREATE TABLE holistic_ratings(subject_section_id INTEGER,student_id INTEGER,week_start_date TEXT,term_number INTEGER,axis TEXT,rating REAL);`);
  calls.length = 0; mutations = 0;
});
test.afterEach(() => database.close());
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  if (previousDb) require.cache[dbId] = previousDb; else delete require.cache[dbId];
});
async function request(path, claims, method = 'GET', body, options = {}) {
  const token = claims === undefined ? undefined : options.invalid ? 'invalid-fixture-jwt' : jwt.sign(claims, secret, { expiresIn: options.expired ? -1 : '2m' });
  const result = await fetch((options.holistic ? base.replace('/api/student','/api/teacherHolistic') : base) + path, { method, headers: {
    'Content-Type': 'application/json', ...(token ? { Cookie: `token=${token}` } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: result.status, body: await result.json() };
}
const broad = [101,102,103,104,105,106,110,111,112,113];
const accounts = [
  ['ADMIN',901,broad], ['PRINCIPAL',902,broad], ['TEACHER',701,[101,102,103,104,110]],
  ['TEACHER',702,[106]], ['PARENT',801,[103]], ['PARENT',802,[105]],
  ['TEACHER',41,[]], ['PARENT',51,[]], ['TEACHER',703,[]], ['PARENT',803,[]],
];
for (const [role,userId,ids] of accounts) {
  for (const path of ['/allStudents','/allGrade','/totalStudents']) test(`${role}/${userId} scoped ${path}`, async () => {
    const result = await request(path + '?userId=901&role=ADMIN&teacherId=41&parentId=51', { role,userId });
    assert.equal(result.status,200);
    if (path === '/totalStudents') assert.equal(result.body.total,ids.length);
    else assert.deepEqual(result.body.data.map(row=>row.id).sort((a,b)=>a-b),ids);
    assert.equal(calls.length,1); assert.equal(mutations,0);
    if (!['ADMIN','PRINCIPAL'].includes(role)) {
      assert.ok(calls[0].params.every(value=>value===userId));
      assert.match(calls[0].sql,/EXISTS/);
    }
  });
  for (const studentId of [101,102,103,104,105,106,110,111,112,113]) test(`${role}/${userId} profile ${studentId}`, async () => {
    const result = await request(`/viewStudent/${studentId}?userId=901&role=ADMIN`, { role,userId });
    assert.equal(result.status,ids.includes(studentId)?200:404);
    if(result.status===200)assert.equal(result.body.data.id,studentId);
    else assert.equal(result.body.data,undefined);
    assert.equal(mutations,0);
  });
}
const writes = [['POST','/addNewStudent'],['PUT','/updateStudent/101'],['PUT','/deleteStudent/101']];
const payload = {studentId:'S900',lrn:'L900',firstName:'Synthetic',lastName:'New',middleName:'',gender:'Male',gradeLevel:1,section:11};
for (const [method,path] of writes) {
  for (const role of ['PRINCIPAL','TEACHER','PARENT','UNKNOWN',null,[],{},' ADMIN ']) test(`${role} cannot ${method} ${path} or spoof Admin`, async()=>{
    const result=await request(path+'?role=ADMIN&userId=901',{userId:701,role},method,{...payload,role:'ADMIN',userId:901});
    assert.equal(result.status,403);assert.equal(calls.length,0);assert.equal(mutations,0);
    assert.equal(database.prepare('SELECT is_deleted FROM elem_students WHERE id=101').get().is_deleted,0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM elem_students').get().n,13);
  });
  test(`Admin retains ${method} ${path}`,async()=>{
    const result=await request(path,{userId:901,role:'ADMIN'},method,payload);
    assert.equal(result.status,method==='POST'?201:200);assert.equal(mutations,1);
    if(path.includes('delete'))assert.equal(database.prepare('SELECT is_deleted FROM elem_students WHERE id=101').get().is_deleted,1);
    else assert.equal(database.prepare('SELECT first_name FROM elem_students WHERE student_number=?').get('S900').first_name,'Synthetic');
  });
}
for (const [method,path] of [...writes,['GET','/allStudents'],['GET','/allGrade'],['GET','/totalStudents'],['GET','/viewStudent/101']]) {
  for(const kind of ['missing','invalid','expired','malformedRole','missingRole','malformedId','missingId','resetPurpose'])test(`${kind} denied ${method} ${path} before SQL`,async()=>{
    const claims=kind==='missing'?undefined:{userId:kind==='malformedId'?{}:kind==='missingId'?undefined:901,role:kind==='malformedRole'?[]:kind==='missingRole'?undefined:'ADMIN',...(kind==='resetPurpose'?{purpose:'password_reset'}:{})};
    const result=await request(path,claims,method,method==='GET'?undefined:payload,{invalid:kind==='invalid',expired:kind==='expired'});
    assert.equal(result.status,kind==='missing'?401:403);assert.equal(calls.length,0);assert.equal(mutations,0);
  });
}
test('Teacher school-year rollover removes old assignments without broadening access',async()=>{
  database.exec('UPDATE school_year SET is_active=0 WHERE id=7; UPDATE school_year SET is_active=1 WHERE id=8; UPDATE elem_students SET current_school_year_id=8 WHERE id=101');
  const result=await request('/allStudents',{userId:701,role:'TEACHER'});
  assert.equal(result.status,200);assert.deepEqual(result.body.data,[]);assert.equal(mutations,0);
});
test('Parent detail retains linked historical non-graduated child, never unrelated student',async()=>{
  database.exec('INSERT INTO parent_student VALUES(51,107)');
  assert.equal((await request('/viewStudent/107',{userId:801,role:'PARENT'})).status,200);
  assert.equal((await request('/viewStudent/101',{userId:801,role:'PARENT'})).status,404);
});
for(const id of [108,109,999])for(const role of ['ADMIN','PRINCIPAL','TEACHER','PARENT'])test(`${role} preserves missing/deleted/graduated profile ${id}`,async()=>{
  assert.equal((await request(`/viewStudent/${id}`,{userId:role==='TEACHER'?701:role==='PARENT'?801:901,role})).status,404);
});
for(const [role,userId,ids] of accounts)for(const studentId of [101,102,103,104,105,106,110,111,113])test(`Holistic profile ${role}/${userId} owns ${studentId}`,async()=>{
  const result=await request(`/profile/${studentId}?termNumber=1&userId=701&role=TEACHER`,{role,userId},'GET',undefined,{holistic:true});
  const expected=role!=='TEACHER'?403:ids.includes(studentId)?200:404;
  assert.equal(result.status,expected);assert.equal(mutations,0);
  if(expected===200)assert.equal(result.body.data.studentId,String(studentId));
  else {assert.equal(result.body.data,undefined);assert.equal(calls.some(c=>c.sql.includes('FROM holistic_ratings')),false);}
  if(expected===403)assert.equal(calls.length,0);
});
test('Authorized holistic profile golden averages/trends/risk/nulls remain identical',async()=>{
  database.exec("INSERT INTO holistic_ratings VALUES(61,101,'2090-09-02',1,'cognitive',4),(61,101,'2090-09-02',1,'emotional',3),(61,101,'2090-09-09',1,'cognitive',5)");
  const result=await request('/profile/101?termNumber=1',{userId:701,role:'TEACHER'},'GET',undefined,{holistic:true});
  assert.equal(result.status,200);const profile=result.body.data;
  assert.deepEqual(profile.overall,{domainAverages:{cognitive:4.5,emotional:3,social:null,behavioral:null},evaluationCount:3,lastEvaluation:'2090-09-09'});
  assert.equal(profile.highestRiskLevel,'NONE');assert.equal(profile.subjects.length,1);
  assert.deepEqual(profile.subjects[0],{subjectSectionId:'61',subjectName:'Synthetic Subject',domainAverages:{cognitive:4.5,emotional:3,social:null,behavioral:null},evaluationCount:3,lastEvaluation:'2090-09-09',riskLevel:'NONE',risks:[],recommendations:[],weeksCount:2,weeklyScores:[{week:'2090-09-02',score:3.5},{week:'2090-09-09',score:5}],pastAverage:3.5,recentAverage:5,currentWeekAverage:5,trend:'Improving'});
});
