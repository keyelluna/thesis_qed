// Disposable loopback MariaDB/MySQL verification. Never loads .env or config/db.
const mysql = require('mysql2/promise');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { assignStudents } = require('../../src/services/studentPlacement.service');
const database = 'qed_section_assignment_' + randomBytes(5).toString('hex');
const options = { host: '127.0.0.1', port: 3307, user: 'root', password: '', connectionLimit: 4 };
let pool, passed = 0;
async function main() {
  if (process.env.QED_SECTION_TEST_CONFIRM !== 'ISOLATED_LOOPBACK_3307') throw new Error('Explicit isolated fixture confirmation required.');
  const admin = await mysql.createConnection(options);
  try { await admin.query(`CREATE DATABASE \`${database}\``); } finally { await admin.end(); }
  pool = mysql.createPool({ ...options, database });
  const ddl = [
    'CREATE TABLE school_year(id INT AUTO_INCREMENT PRIMARY KEY, school_year VARCHAR(20), is_active INT) ENGINE=InnoDB',
    'CREATE TABLE grade_level(id INT PRIMARY KEY, grade_level VARCHAR(20)) ENGINE=InnoDB',
    'CREATE TABLE grade_level_sections(id INT AUTO_INCREMENT PRIMARY KEY, section_name VARCHAR(20), grade_level_id INT, school_year_id INT, is_active INT DEFAULT 1, FOREIGN KEY(school_year_id) REFERENCES school_year(id)) ENGINE=InnoDB',
    'CREATE TABLE classes(id INT AUTO_INCREMENT PRIMARY KEY, section_id INT UNIQUE, grade_level_id INT, school_year_id INT, status VARCHAR(20), room VARCHAR(20), class_adviser_id INT, FOREIGN KEY(section_id) REFERENCES grade_level_sections(id)) ENGINE=InnoDB',
    "CREATE TABLE elem_students(id INT PRIMARY KEY, student_number VARCHAR(20), learner_reference_number VARCHAR(20), first_name VARCHAR(20), last_name VARCHAR(20), middle_name VARCHAR(20), gender VARCHAR(20), grade_level_id INT, section_id INT NULL, current_school_year_id INT, is_deleted INT DEFAULT 0, status VARCHAR(20), FOREIGN KEY(section_id) REFERENCES grade_level_sections(id)) ENGINE=InnoDB",
    'CREATE TABLE student_year_records(student_id INT, school_year_id INT, grade_level_id INT, section_id INT, status VARCHAR(20), processed_by INT, processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(student_id,school_year_id)) ENGINE=InnoDB',
    'CREATE TABLE grade_scores(student_id INT, score INT) ENGINE=InnoDB',
    'CREATE TABLE advisory_attendance_records(student_id INT, class_id INT) ENGINE=InnoDB',
    'CREATE TABLE holistic_ratings(student_id INT, rating INT) ENGINE=InnoDB',
    'CREATE TABLE grading_periods(id INT AUTO_INCREMENT PRIMARY KEY, school_year_id INT, term_number INT, term_label VARCHAR(20), start_date DATE, end_date DATE, is_active INT DEFAULT 0) ENGINE=InnoDB',
    'CREATE TABLE advisory_overall_grades(student_id INT, grading_period_id INT, overall_average DECIMAL(5,2)) ENGINE=InnoDB',
    "CREATE TABLE `subject-section`(id INT PRIMARY KEY, school_year_id INT, status VARCHAR(20)) ENGINE=InnoDB",
  ];
  for (const sql of ddl) await pool.query(sql);
  await pool.query("INSERT INTO school_year VALUES(1,'Old',0),(2,'Current',1)");
  await pool.query("INSERT INTO grade_level VALUES(1,'Grade 1'),(2,'Grade 2'),(6,'Grade 6')");
  await pool.query("INSERT INTO grade_level_sections VALUES(10,'Maroon',1,1,1),(20,'Maroon',1,2,1),(21,'White',1,2,1)");
  await pool.query("INSERT INTO classes VALUES(1,10,1,1,'Inactive','A',1),(2,20,1,2,'Active','A',1),(3,21,1,2,'Active','B',1)");
  await pool.query("INSERT INTO elem_students(id,student_number,first_name,last_name,gender,grade_level_id,section_id,current_school_year_id,status) VALUES(101,'S101','One','Synthetic','Male',1,NULL,2,'active'),(102,'S102','Two','Synthetic','Female',1,NULL,2,'active')");
  await pool.query("INSERT INTO student_year_records(student_id,school_year_id,grade_level_id,section_id,status) VALUES(101,1,1,10,'promoted')");
  await pool.query('INSERT INTO grade_scores VALUES(101,90)');
  await pool.query('INSERT INTO advisory_attendance_records VALUES(101,1)');
  await pool.query('INSERT INTO holistic_ratings VALUES(101,4)');
  const input = { schoolYearId: 2, gradeLevelId: 1, sectionId: 20, studentIds: [101,102] };
  const tables = ['student_year_records','grade_scores','advisory_attendance_records','holistic_ratings'];
  const before = await Promise.all(tables.map(async t => (await pool.query(`SELECT * FROM ${t}`))[0]));
  async function run(body) {
    const conn = await pool.getConnection();
    try { await conn.beginTransaction(); const r = await assignStudents(conn, body); await conn.commit(); return r; }
    catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  }
  assert.equal((await run(input)).assignedCount,2); passed++;
  await assert.rejects(run(input), e => e.statusCode === 409); passed++;
  assert.deepEqual(await Promise.all(tables.map(async t => (await pool.query(`SELECT * FROM ${t}`))[0])),before); passed++;
  await pool.query('UPDATE elem_students SET section_id=NULL');
  const results = await Promise.allSettled([run(input),run({...input,sectionId:21})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
  const [students] = await pool.query('SELECT section_id FROM elem_students ORDER BY id');
  assert.equal(students[0].section_id,students[1].section_id); passed++;
  await pool.query('UPDATE elem_students SET section_id=NULL');
  await pool.query("CREATE TRIGGER inject_assignment_failure BEFORE UPDATE ON elem_students FOR EACH ROW BEGIN IF NEW.id=102 AND NEW.section_id IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic failure'; END IF; END");
  await assert.rejects(run(input));
  assert.ok((await pool.query('SELECT section_id FROM elem_students'))[0].every(s=>s.section_id===null)); passed++;
  await pool.query('DROP TRIGGER inject_assignment_failure');
  const dbId = require.resolve('../../config/db'); require.cache[dbId] = { id:dbId, filename:dbId, loaded:true, exports:pool };
  const response = () => ({ code:200, status(n){this.code=n;return this;},json(body){this.body=body;return this;} });
  const { read } = require('../../src/modules/admin/student-record/sectionAssignment.controller');
  const res=response(); await read({query:{}},res); assert.equal(res.code,200); assert.equal(res.body.data.counts.unassigned,2); passed++;
  const classController = require('../../src/modules/admin/classes-management/classManagement.controller');
  const created=response(); await classController.createClass({body:{gradeLevel:2,section:'Maroon',adviserId:1,room:'C',schedule:[]}},created);
  assert.equal(created.code,201); assert.equal((await pool.query('SELECT section_id FROM classes WHERE id=1'))[0][0].section_id,10);
  const [newClass] = await pool.query('SELECT section_id FROM classes WHERE id=?',[created.body.classId]); assert.notEqual(newClass[0].section_id,10); passed++;
  const edit=require('../../src/modules/admin/student-record/studentRecord.controller');
  const editRes=response(); await edit.updateStudent({params:{id:101},body:{studentId:'S101',lrn:'L101',firstName:'One',lastName:'Synthetic',middleName:'',gender:'Male',gradeLevel:1,section:20,expectedPlacement:{schoolYearId:2,gradeLevelId:1,sectionId:null}}},editRes);
  assert.equal(editRes.code,200); await assert.rejects(run(input),e=>e.statusCode===409); passed++;
  // Fresh four-role readers observe placement without copying academic records.
  await pool.query('CREATE TABLE teacher_table(id INT PRIMARY KEY,user_id INT,first_name VARCHAR(20),middle_name VARCHAR(20),last_name VARCHAR(20),is_deleted INT DEFAULT 0) ENGINE=InnoDB');
  await pool.query("INSERT INTO teacher_table VALUES(1,701,'Current','','Adviser',0)");
  await pool.query('CREATE TABLE parent_table(id INT PRIMARY KEY,user_id INT,is_deleted INT DEFAULT 0) ENGINE=InnoDB');
  await pool.query('CREATE TABLE parent_student(parent_id INT,student_id INT) ENGINE=InnoDB');
  await pool.query('INSERT INTO parent_table VALUES(1,801,0)'); await pool.query('INSERT INTO parent_student VALUES(1,101)');
  for(const column of ['date_of_birth DATE','resdential_address VARCHAR(100)','parent_guardian_name VARCHAR(50)']) await pool.query('ALTER TABLE elem_students ADD '+column);
  await pool.query('CREATE TABLE class_schedule(id INT PRIMARY KEY,class_id INT,subject_name VARCHAR(20),subject_teacher_id INT,start_time TIME,end_time TIME) ENGINE=InnoDB');
  await pool.query('CREATE TABLE class_schedule_day(class_schedule_id INT,day_of_week VARCHAR(20)) ENGINE=InnoDB');
  await pool.query("INSERT INTO classes VALUES(99,NULL,1,2,'Active','D',1)");
  await pool.query("INSERT INTO class_schedule VALUES(1,2,'Math',1,'08:00','09:00'),(2,99,'Unassigned class',1,'09:00','10:00')");
  await pool.query("INSERT INTO class_schedule_day VALUES(1,'Monday'),(2,'Monday')");
  const teacherRoster=require('../../src/modules/teacher/roster/advisory.controller');
  const roster=response(); await teacherRoster.getAdvisoryRoster({user:{userId:701}},roster);
  assert.equal(roster.code,200); assert.deepEqual(roster.body.students.map(s=>s.id),[101]); passed++;
  const principal=require('../../src/modules/principal/students/students.controller');
  const principalRoster=response(); await principal.getClassList({params:{classId:2}},principalRoster);
  assert.equal(principalRoster.code,200); assert.deepEqual(principalRoster.body.roster.map(s=>s.studentId),['S101']); passed++;
  const parent=require('../../src/modules/parents/Student-Record/StudentProfile/studentProfiles.controller');
  const profile=response(); await parent.getStudentProfile({params:{studentId:101},studentIdentity:{role:'PARENT',userId:801}},profile);
  assert.equal(profile.code,200); assert.equal(profile.body.adviser,'Current Adviser'); passed++;
  const schedule=require('../../src/modules/parents/Student-Record/Academic/classSchedule.controller');
  const scheduleRes=response(); await schedule.getClassSchedule({params:{studentId:101}},scheduleRes);
  assert.equal(scheduleRes.code,200); assert.deepEqual(scheduleRes.body.map(s=>s.subject),['Math']); passed++;
  const {studentBelongsToSubject}=require('../../src/modules/teacher/gradebook/subjectStudent.authorization');
  assert.equal(await studentBelongsToSubject(101,{section_id:20}),true);
  assert.equal(await studentBelongsToSubject(102,{section_id:20}),false); passed++;
  const notificationId=require.resolve('../../src/modules/notification/notification.service');
  require.cache[notificationId]={id:notificationId,filename:notificationId,loaded:true,exports:{}}; // No email/socket side effects in read verification.
  const attendance=require('../../src/modules/teacher/attendance/advisoryAttendance.controller');
  const attendanceRes=response(); await attendance.getAdvisorySectionsList({advisoryClasses:[{classId:2,section_id:20,sectionName:'Maroon',gradeLevel:'Grade 1'}]},attendanceRes);
  assert.equal(attendanceRes.code,200); assert.deepEqual(attendanceRes.body[0].roster.map(s=>s.id),['101']); passed++;
  // A concurrent transition-like year change wins the year lock. The waiting
  // assignment sees the new active year and must reject its old-year payload.
  await pool.query('UPDATE elem_students SET section_id=NULL');
  const yearConn=await pool.getConnection(); await yearConn.beginTransaction();
  await yearConn.query('SELECT id FROM school_year WHERE is_active=1 FOR UPDATE');
  const waiting=run(input).then(()=>null,error=>error);
  await yearConn.query('UPDATE school_year SET is_active=0 WHERE id=2');
  await yearConn.query("INSERT INTO school_year VALUES(3,'Next',1)"); await yearConn.commit(); yearConn.release();
  assert.equal((await waiting).statusCode,409); passed++;
  // Execute the unchanged real transition algorithm against synthetic records.
  await pool.query('UPDATE school_year SET is_active=CASE WHEN id=2 THEN 1 ELSE 0 END');
  await pool.query("INSERT INTO elem_students(id,grade_level_id,section_id,current_school_year_id,is_deleted,status) VALUES(103,1,20,2,0,'active'),(104,6,20,2,0,'active')");
  for(let term=1;term<=3;term++){
    const [period]=await pool.query("INSERT INTO grading_periods(school_year_id,term_number,term_label,start_date,end_date) VALUES(2,?,?,'2000-01-01','2000-01-02')",[term,`Term ${term}`]);
    await pool.query('INSERT INTO advisory_overall_grades VALUES(101,?,80),(102,?,70),(104,?,90)',[period.insertId,period.insertId,period.insertId]);
  }
  const transition=require('../../src/modules/admin/subject-management/academicYear.controller');
  const transitioned=response(); await transition.addAcademicYear({body:{label:'Synthetic next',status:'Active'}},transitioned);
  assert.equal(transitioned.code,201); assert.deepEqual(transitioned.body.transition,{promoted:1,retained:1,graduated:1,pending:1});
  const [current]=await pool.query('SELECT id,grade_level_id,section_id,status,current_school_year_id FROM elem_students ORDER BY id');
  assert.equal(current[0].grade_level_id,2); assert.equal(current[1].grade_level_id,1); assert.equal(current[3].status,'graduated'); assert.ok(current.every(s=>s.section_id===null)); passed++;
  assert.deepEqual((await pool.query('SELECT * FROM grade_scores'))[0],before[1]); passed++;
  console.log(JSON.stringify({ engine:'MariaDB 10.4 / InnoDB',host:'127.0.0.1',port:3307,database,passed,failed:0,productionConfigLoaded:false }));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(pool)await pool.end();});
