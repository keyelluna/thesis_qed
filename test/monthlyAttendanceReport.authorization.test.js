const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const express=require('express'),cookieParser=require('cookie-parser'),jwt=require('jsonwebtoken');
const secret=require('node:crypto').randomBytes(32).toString('hex');
let db,server,base,queries=[];
async function execute(sql,args=[]){queries.push(sql);assert.match(sql.trim(),/^SELECT/i,'Report must execute SELECTs only');return [db.prepare(sql.replaceAll('<=>','IS')).all(...args)];}
const conn={execute,beginTransaction:async()=>db.exec('BEGIN'),commit:async()=>db.exec('COMMIT'),rollback:async()=>db.exec('ROLLBACK'),release(){}};
const id=require.resolve('../config/db');require.cache[id]={id,filename:id,loaded:true,exports:{execute,query:execute,getConnection:async()=>conn}};
const notifications=require.resolve('../src/modules/notification/notification.service');require.cache[notifications]={id:notifications,filename:notifications,loaded:true,exports:{notifyAbsence:async()=>{},notifyAttendanceComplete:async()=>{}}};
const router=require('../src/modules/teacher/attendance/advisoryAttendance.router');
test.before(async()=>{
 process.env.JWT_SECRET=secret;const app=express();app.use(cookieParser(),express.json());app.use('/api/teacherAttendance',router);
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port+'/api/teacherAttendance';
});
test.after(()=>{server.close();db.close();});
test.beforeEach(()=>{
 db?.close();db=new DatabaseSync(':memory:');queries=[];
 db.function('DATE_FORMAT',(date,format)=>date);db.function('CONCAT_WS',{varargs:true},(sep,...parts)=>parts.filter(v=>v!==null).join(sep));
 db.exec(`CREATE TABLE school_year(id INTEGER,school_year TEXT,is_active INTEGER);INSERT INTO school_year VALUES(1,'2026-2027',1),(2,'2025-2026',0);
 CREATE TABLE teacher_table(id INTEGER,user_id INTEGER,first_name TEXT,middle_name TEXT,last_name TEXT,is_deleted INTEGER,status TEXT);INSERT INTO teacher_table VALUES(1,10,'Teacher','','One',0,'active'),(2,20,'Other','','Teacher',0,'active');
 CREATE TABLE grade_level(id INTEGER,grade_level TEXT);INSERT INTO grade_level VALUES(1,'Grade 1');
 CREATE TABLE grade_level_sections(id INTEGER,section_name TEXT);INSERT INTO grade_level_sections VALUES(1,'Maroon'),(2,'White');
 CREATE TABLE classes(id INTEGER,section_id INTEGER,grade_level_id INTEGER,school_year_id INTEGER,class_adviser_id INTEGER,status TEXT);INSERT INTO classes VALUES(1,1,1,1,1,'Active'),(2,2,1,1,2,'Active'),(3,1,1,2,1,'Inactive');
 CREATE TABLE grading_periods(id INTEGER,school_year_id INTEGER,start_date TEXT,end_date TEXT);INSERT INTO grading_periods VALUES(1,1,'2026-09-01','2026-10-15'),(2,1,'2026-10-16','2026-12-01'),(3,2,'2026-10-01','2026-10-31');
 CREATE TABLE elem_students(id INTEGER,first_name TEXT,middle_name TEXT,last_name TEXT,gender TEXT,current_school_year_id INTEGER,grade_level_id INTEGER,section_id INTEGER,is_deleted INTEGER,status TEXT);INSERT INTO elem_students VALUES(1,'Male','','One','Male',1,1,1,0,'active'),(2,'Female','','Two','Female',1,1,1,0,'active'),(3,'Old','','Student','Male',2,1,1,0,'active'),(4,'Other','','Section','Female',1,1,2,0,'active');
 CREATE TABLE advisory_attendance_records(student_id INTEGER,class_id INTEGER,grading_period_id INTEGER,attendance_date TEXT,status TEXT);
 INSERT INTO advisory_attendance_records VALUES(1,1,1,'2026-10-01','L'),(2,1,1,'2026-10-01','E'),(1,1,2,'2026-10-20','P'),(2,1,2,'2026-10-20','P'),(1,1,2,'2026-11-02','P'),(1,1,1,'2026-10-03','P'),(1,1,3,'2026-10-02','P'),(4,2,1,'2026-10-02','P');
 CREATE TABLE principal_table(id INTEGER,first_name TEXT,middle_name TEXT,last_name TEXT,role TEXT,status TEXT,is_deleted INTEGER);INSERT INTO principal_table VALUES(1,'Principal','','One','Elementary Principal','active',0);`);
});
function token(role='TEACHER',userId=10){return 'token='+jwt.sign({role,userId},secret,{expiresIn:'5m'});}
async function get(path='/1/monthly-report?schoolYearId=1&month=2026-10',cookie=token()){return fetch(base+path,{headers:cookie?{cookie}:{}});}
function snapshot(){return JSON.stringify(['elem_students','advisory_attendance_records','teacher_table','principal_table'].map(t=>db.prepare('SELECT * FROM '+t).all()));}
test('real route/SQL isolates year, month, class and reads across terms without source mutations',async()=>{
 const before=snapshot();const response=await get();assert.equal(response.status,200);const {data}=await response.json();
 assert.equal(data.numberOfDays,2);assert.deepEqual(data.enrollment,{male:1,female:1,total:2});assert.deepEqual(data.sums,{male:2,female:1});assert.deepEqual(data.ada,{male:1,female:1,total:2});assert.equal(data.adviserName,'Teacher One');assert.equal(data.principalName,'Principal One');assert.equal(data.principalSource,'system');assert.equal(snapshot(),before);assert.ok(queries.every(q=>/^SELECT/.test(q.trim())));
});
test('authentication, teacher role and adviser ownership are required; historical years denied',async()=>{
 assert.equal((await get(undefined,null)).status,401);assert.equal((await get(undefined,token('ADMIN'))).status,403);assert.equal((await get(undefined,token('TEACHER',20))).status,403);
 assert.equal((await get('/3/monthly-report?schoolYearId=2&month=2026-10')).status,403);assert.equal((await get('/1/monthly-report?schoolYearId=2&month=2026-10')).status,403);
});
test('invalid/outside-year months are rejected; no records returns blank ADA; ambiguous principal requires manual input',async()=>{
 assert.equal((await get('/1/monthly-report?schoolYearId=1&month=2026-13')).status,400);assert.equal((await get('/1/monthly-report?schoolYearId=1&month=2027-01')).status,400);
 db.exec("INSERT INTO principal_table VALUES(2,'Other','','Principal','Principal','active',0)");const response=await get('/1/monthly-report?schoolYearId=1&month=2026-12');const {data}=await response.json();assert.equal(data.ada,null);assert.equal(data.numberOfDays,0);assert.equal(data.principalSource,'manual');assert.equal(data.principalName,'');
});
