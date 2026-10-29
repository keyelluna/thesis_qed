const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const express=require('express'),cookieParser=require('cookie-parser'),jwt=require('jsonwebtoken');
const secret=require('node:crypto').randomBytes(32).toString('hex');let db,server,base,leased=false,notificationLeases=[],notificationWait, rejectNestedPool=false, statements=[];
async function execute(sql,args=[]){statements.push(sql);sql=sql.replace(/\s+FOR UPDATE/g,'').replaceAll('<=>','IS').replace(/ON DUPLICATE KEY UPDATE status = VALUES\(status\), grading_period_id = VALUES\(grading_period_id\), recorded_by = VALUES\(recorded_by\)/,'ON CONFLICT(class_id,student_id,attendance_date) DO UPDATE SET status=excluded.status,grading_period_id=excluded.grading_period_id,recorded_by=excluded.recorded_by');sql=sql.replace('ON DUPLICATE KEY UPDATE status=VALUES(status),recorded_by=VALUES(recorded_by)','ON CONFLICT(class_id,student_id,attendance_date) DO UPDATE SET status=excluded.status,recorded_by=excluded.recorded_by');const stmt=db.prepare(sql);if(/^\s*SELECT/i.test(sql))return [stmt.all(...args)];const result=stmt.run(...args);return [{affectedRows:Number(result.changes),insertId:Number(result.lastInsertRowid)}];}
const conn={execute,query:execute,beginTransaction:async()=>db.exec('BEGIN'),commit:async()=>db.exec('COMMIT'),rollback:async()=>{if(db.isTransaction)db.exec('ROLLBACK');},release(){leased=false;}};
const id=require.resolve('../config/db');require.cache[id]={id,filename:id,loaded:true,exports:{execute:async(...args)=>{if(rejectNestedPool&&leased)throw new Error('Nested pool acquisition');return execute(...args);},query:execute,getConnection:async()=>{leased=true;return conn;}}};
const notification=require.resolve('../src/modules/notification/notification.service');require.cache[notification]={id:notification,filename:notification,loaded:true,exports:{notifyAbsence:async()=>{},notifyAttendanceComplete:async()=>{notificationLeases.push(leased);if(notificationWait)await notificationWait;}}};
const router=require('../src/modules/teacher/attendance/advisoryAttendance.router');
const {consecutiveAbsences}=require('../src/modules/teacher/attendance/dropout.service');
test.before(async()=>{process.env.JWT_SECRET=secret;const app=express();app.use(cookieParser(),express.json());app.use('/attendance',router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port+'/attendance';});
test.after(()=>{server.close();db.close();});
test.beforeEach(()=>{db?.close();leased=false;notificationLeases=[];notificationWait=undefined;db=new DatabaseSync(':memory:');db.function('CURDATE',()=> '2026-10-27');db.function('DATE_FORMAT',(date,format)=>date);db.function('CONCAT_WS',{varargs:true},(sep,...values)=>values.filter(v=>v!==null).join(sep));db.function('CONCAT',{varargs:true},(...v)=>v.join(''));db.function('IF',(c,y,n)=>c?y:n);
 db.exec(`CREATE TABLE school_year(id INTEGER,school_year TEXT,is_active INTEGER);INSERT INTO school_year VALUES(1,'2026-2027',1),(2,'Old',0);
 CREATE TABLE teacher_table(id INTEGER,user_id INTEGER,is_deleted INTEGER,status TEXT,first_name TEXT,middle_name TEXT,last_name TEXT);INSERT INTO teacher_table(id,user_id,is_deleted,status) VALUES(1,10,0,'active'),(2,20,0,'active');UPDATE teacher_table SET first_name='Marie',middle_name='',last_name='Cruz' WHERE id=1;
 CREATE TABLE classes(id INTEGER,school_year_id INTEGER,grade_level_id INTEGER,section_id INTEGER,class_adviser_id INTEGER,status TEXT);INSERT INTO classes VALUES(1,1,1,1,1,'Active'),(2,1,1,2,2,'Active'),(3,1,1,NULL,1,'Active'),(4,2,1,1,1,'Active');
 CREATE TABLE grade_level(id INTEGER,grade_level TEXT);INSERT INTO grade_level VALUES(1,'Grade 1');
 CREATE TABLE grade_level_sections(id INTEGER,section_name TEXT);INSERT INTO grade_level_sections VALUES(1,'Maroon'),(2,'White');
 CREATE TABLE elem_students(id INTEGER,current_school_year_id INTEGER,grade_level_id INTEGER,section_id INTEGER,is_deleted INTEGER,status TEXT,first_name TEXT,middle_name TEXT,last_name TEXT);INSERT INTO elem_students(id,current_school_year_id,grade_level_id,section_id,is_deleted,status) VALUES(1,1,1,1,0,'active'),(2,1,1,1,0,'active'),(3,1,1,2,0,'active'),(4,1,1,NULL,0,'active');UPDATE elem_students SET first_name='Renzo',middle_name='P.',last_name='Anas' WHERE id=1;
 CREATE TABLE grading_periods(id INTEGER,school_year_id INTEGER,start_date TEXT,end_date TEXT,is_active INTEGER);INSERT INTO grading_periods VALUES(1,1,'2026-10-01','2026-12-31',1);
 CREATE TABLE school_calendar(school_year_id INTEGER,type TEXT,date TEXT);INSERT INTO school_calendar VALUES(1,'holiday','2026-10-12');
 CREATE TABLE advisory_attendance_records(class_id INTEGER,student_id INTEGER,grading_period_id INTEGER,attendance_date TEXT,status TEXT,recorded_by INTEGER,section_id INTEGER,UNIQUE(class_id,student_id,attendance_date));
 INSERT INTO advisory_attendance_records VALUES(1,1,1,'2026-10-05','P',1,1),(1,1,1,'2026-10-06','A',1,1),(1,1,1,'2026-10-07','A',1,1),(1,1,1,'2026-10-08','A',1,1),(1,1,1,'2026-10-09','A',1,1),(1,1,1,'2026-10-13','A',1,1),(1,2,1,'2026-10-13','P',1,1);
 CREATE TABLE student_transfer_ins(student_id INTEGER,school_year_id INTEGER,joined_date TEXT,recorded_by INTEGER,created_at TEXT,PRIMARY KEY(student_id,school_year_id));
 CREATE TABLE student_dropout_events(id INTEGER PRIMARY KEY AUTOINCREMENT,student_id INTEGER,class_id INTEGER,school_year_id INTEGER,last_attended TEXT,effective_date TEXT,reason TEXT,remarks TEXT,declared_by INTEGER,declared_at TEXT DEFAULT CURRENT_TIMESTAMP,reversed_at TEXT,reversed_by INTEGER,reversal_reason TEXT);
 CREATE UNIQUE INDEX active_dropout ON student_dropout_events(student_id,school_year_id) WHERE reversed_at IS NULL;`);
});
async function request(path,body,role='TEACHER',userId=10){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(role?{cookie:'token='+jwt.sign({role,userId},secret,{expiresIn:'5m'})}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};}
const declaration={effectiveDate:'2026-10-14',reason:'Prolonged absence',remarks:'Contacted guardian'};
test('risk counts five absences across weekends and holidays; missing and E/P/L break a streak',()=>{
 const terms=[{startDate:'2026-10-01',endDate:'2026-12-31'}],marks={'2026-10-06':'A','2026-10-07':'A','2026-10-08':'A','2026-10-09':'A','2026-10-13':'A'};
 assert.deepEqual(consecutiveAbsences(marks,terms,'2026-10-13',['2026-10-12']),{count:5,since:'2026-10-06'});
 assert.equal(consecutiveAbsences({...marks,'2026-10-08':null},terms,'2026-10-13',['2026-10-12']).count,2);
 for(const status of ['E','P','L'])assert.equal(consecutiveAbsences({...marks,'2026-10-13':status},terms,'2026-10-13',['2026-10-12']).count,0);
});
test('only owned active-year class adviser can read or finalize; student and class IDs cannot bypass ownership',async()=>{
 for(const role of [null,'ADMIN','PARENT','PRINCIPAL'])assert.equal((await request('/1/dropouts',null,role)).status,role?403:401);
 assert.equal((await request('/2/dropouts')).status,403);assert.equal((await request('/4/dropouts')).status,403);
 assert.equal((await request('/1/students/3/dropout',declaration)).status,404);
 assert.equal((await request('/2/students/3/dropout',declaration)).status,403);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM student_dropout_events').get().n,0);
});
test('declaration locks later attendance while preserving marks, detects duplicates, reversal audits actor/reason and restores normal edits',async()=>{
 const source=JSON.stringify(db.prepare('SELECT * FROM advisory_attendance_records').all());
 const state=await request('/1/dropouts');assert.equal(state.body.data.students['1'].risk.count,5);assert.equal(state.body.data.students['1'].lastAttended,'2026-10-05');
 assert.equal((await request('/1/students/1/dropout',declaration)).status,201);
 const declared=(await request('/1/dropouts')).body.data.dropouts[0];assert.equal(declared.studentName,'Anas, Renzo P.');assert.equal(declared.declaredByName,'Marie Cruz');assert.ok(declared.declaredAt);
 assert.equal((await request('/1/students/1/dropout',declaration)).status,409);
 assert.equal((await request('/1',{studentId:1,date:'2026-10-27',status:'P',term:1})).status,409);
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM advisory_attendance_records').all()),source);
 assert.equal((await request('/1',{studentId:1,date:'2026-10-09',status:'L',term:1})).status,200);
 let event=db.prepare('SELECT * FROM student_dropout_events').get();assert.equal(event.declared_by,10);assert.equal(event.last_attended,'2026-10-05');
 assert.equal((await request('/1/students/1/dropout/reverse',{declarationId:event.id,reason:'Incorrect classification'})).status,200);
 event=db.prepare('SELECT * FROM student_dropout_events').get();assert.equal(event.reversed_by,10);assert.equal(event.reversal_reason,'Incorrect classification');assert.ok(event.reversed_at);
 assert.equal((await request('/1',{studentId:1,date:'2026-10-27',status:'P',term:1})).status,200);
 assert.equal((await request('/1/students/1/dropout/reverse',{declarationId:event.id,reason:'Stale'})).status,409);
 assert.equal((await request('/1/dropouts')).body.data.dropouts.length,0);
 assert.deepEqual(notificationLeases,[false], 'Attendance connection must be released before notification queries.');
});
test('effective date and reason are validated, Other needs remarks, unsectioned advisories work',async()=>{
 for(const data of [{...declaration,effectiveDate:'2026-10-05'},{...declaration,effectiveDate:'2026-11-01'},{...declaration,effectiveDate:'2026-02-30'},{...declaration,reason:'Other',remarks:''},{...declaration,reason:'Transferred out'}])assert.ok([400,409].includes((await request('/1/students/1/dropout',data)).status));
 assert.equal((await request('/3/students/4/dropout',declaration)).status,201);
 assert.equal((await request('/3/dropouts')).body.data.dropouts[0].studentId,'4');
});



test('bulk marking commits a selected roster in one request and retry does not duplicate attendance',async()=>{
 const payload={studentIds:['1','2','1'],date:'2026-10-27',termId:'1'};
 const first=await request('/1/mark-present',payload);assert.equal(first.status,200);assert.equal(first.body.count,2);
 assert.equal((await request('/1/mark-present',payload)).status,200);
 const rows=db.prepare("SELECT student_id,status FROM advisory_attendance_records WHERE attendance_date='2026-10-27' ORDER BY student_id").all();
 assert.deepEqual(rows.map(r=>[r.student_id,r.status]),[[1,'P'],[2,'P']]);assert.ok(notificationLeases.every(value=>value===false));
});
test('bulk marking rejects any ineligible or dropped student atomically and enforces role, class, date and term',async()=>{
 const payload={studentIds:['1','3'],date:'2026-10-27',termId:'1'};assert.equal((await request('/1/mark-present',payload)).status,409);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM advisory_attendance_records WHERE attendance_date='2026-10-27'").get().n,0);
 for(const role of [null,'ADMIN','PARENT','PRINCIPAL'])assert.equal((await request('/1/mark-present',{...payload,studentIds:['1']},role)).status,role?403:401);
 assert.equal((await request('/2/mark-present',{...payload,studentIds:['3']})).status,403);
 assert.equal((await request('/1/mark-present',{...payload,studentIds:['1'],date:'2026-10-26'})).status,400);
 assert.equal((await request('/1/mark-present',{...payload,studentIds:['1'],termId:'99'})).status,409);
 assert.equal((await request('/1/students/1/dropout',declaration)).status,201);
 assert.equal((await request('/1/mark-present',{...payload,studentIds:['1','2']})).status,409);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM advisory_attendance_records WHERE attendance_date='2026-10-27'").get().n,0);
});
test('bulk response is acknowledged after commit without waiting for notifications',{timeout:3000},async()=>{
 let finish;notificationWait=new Promise(resolve=>finish=resolve);
 try{const response=await request('/1/mark-present',{studentIds:['1','2'],date:'2026-10-27',termId:'1'});assert.equal(response.status,200);assert.deepEqual(notificationLeases,[false]);assert.equal(db.prepare("SELECT COUNT(*) n FROM advisory_attendance_records WHERE attendance_date='2026-10-27'").get().n,2);}finally{finish();}
});

test('transfer metadata is scoped to advisory; attendance starts on joining date and supports backfill',async()=>{
 db.exec("INSERT INTO student_transfer_ins(student_id,school_year_id,joined_date,recorded_by) VALUES(1,1,'2026-10-14',99),(3,1,'2026-10-15',99)");
 const state=await request('/1/dropouts');assert.equal(state.status,200);assert.deepEqual(state.body.data.transferIns.map(s=>s.studentId),['1']);assert.equal(state.body.data.students['1'],undefined);
 assert.equal((await request('/1',{studentId:1,date:'2026-10-13',status:'P',term:1})).status,409);
 assert.equal((await request('/1',{studentId:1,date:'2026-10-14',status:'P',term:1})).status,200);
 assert.equal((await request('/1/students/1/dropout',{...declaration,effectiveDate:'2026-10-13'})).status,400);
 const attendance=await request('/1');assert.equal(attendance.body.data['1']['2026-10-05'],undefined);assert.equal(attendance.body.data['1']['2026-10-14'],'P');
});

test('individual saves use one connection throughout their transaction',async()=>{
 rejectNestedPool=true;
 try {for(const status of ['P','A','L','E',null]) {
 const result=await request('/1',{studentId:1,date:'2026-10-27',status,term:1});
 assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(leased,false);
 }}finally{rejectNestedPool=false;}
});

test('attendance reads reuse ownership metadata instead of repeating year and teacher lookups',async()=>{
 statements=[];
 const result=await request('/1?term=1');
 assert.equal(result.status,200);
 assert.equal(statements.length,2,'One ownership query and one attendance query');
 statements=[];
 assert.equal((await request('/1?allPeriods=true')).status,200);
 assert.equal(statements.length,2);
});
