const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),cookieParser=require('cookie-parser'),jwt=require('jsonwebtoken');
const {DatabaseSync}=require('node:sqlite'),{randomBytes}=require('node:crypto');
// Actual profile router/JWT/controller and executed authorization SQL. SQLite
// adapts the compatible SQL subset; this is NOT real MySQL/live-school evidence.
let db,server,base;const calls=[];let writes=0;
const dbId=require.resolve('../config/db'),previousDb=require.cache[dbId],previousSecret=process.env.JWT_SECRET,secret=randomBytes(32).toString('hex');
async function query(sql,params=[]){calls.push({sql,params});const statement=db.prepare(sql);if(/^\s*SELECT/i.test(sql))return[statement.all(...params)];const result=statement.run(...params);writes+=Number(result.changes);return[{affectedRows:Number(result.changes)}];}
require.cache[dbId]={id:dbId,filename:dbId,loaded:true,exports:{query,execute:query}};
const router=require('../src/modules/parents/Student-Record/StudentProfile/studentProfile.Router');
test.before(async()=>{process.env.JWT_SECRET=secret;const app=express();app.use(cookieParser(),express.json(),router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
test.beforeEach(()=>{
 db=new DatabaseSync(':memory:');db.exec(`
 CREATE TABLE school_year(id INTEGER PRIMARY KEY,is_active INTEGER,school_year TEXT);INSERT INTO school_year VALUES(7,1,'2026-2027');
 CREATE TABLE grade_level(id INTEGER PRIMARY KEY,grade_level TEXT);INSERT INTO grade_level VALUES(1,'Grade 1');
 CREATE TABLE grade_level_sections(id INTEGER PRIMARY KEY,section_name TEXT);INSERT INTO grade_level_sections VALUES(11,'A'),(12,'B'),(13,'C');
 CREATE TABLE teacher_table(id INTEGER PRIMARY KEY,user_id INTEGER,is_deleted INTEGER,first_name TEXT,last_name TEXT);INSERT INTO teacher_table VALUES(41,701,0,'Synthetic','Teacher'),(42,702,0,'Other','Teacher');
 CREATE TABLE parent_table(id INTEGER PRIMARY KEY,user_id INTEGER,is_deleted INTEGER);INSERT INTO parent_table VALUES(51,801,0),(52,802,0),(53,803,1);
 CREATE TABLE parent_student(parent_id INTEGER,student_id INTEGER);INSERT INTO parent_student VALUES(51,101),(51,103),(51,106),(52,102),(53,104);
 CREATE TABLE elem_subjects(id INTEGER PRIMARY KEY,grade_level_id INTEGER);INSERT INTO elem_subjects VALUES(21,1);
 CREATE TABLE [subject-section](id INTEGER PRIMARY KEY,teacher_id INTEGER,subject_id INTEGER,section_id INTEGER,school_year_id INTEGER);INSERT INTO [subject-section] VALUES(61,41,21,11,7),(62,42,21,12,7);
 CREATE TABLE classes(id INTEGER PRIMARY KEY,class_adviser_id INTEGER,section_id INTEGER,grade_level_id INTEGER,school_year_id INTEGER,status TEXT);INSERT INTO classes VALUES(71,41,13,1,7,'Active');
 CREATE TABLE elem_students(id INTEGER PRIMARY KEY,student_number TEXT,learner_reference_number TEXT,last_name TEXT,first_name TEXT,middle_name TEXT,gender TEXT,date_of_birth TEXT,resdential_address TEXT,parent_guardian_name TEXT,is_deleted INTEGER,grade_level_id INTEGER,section_id INTEGER,current_school_year_id INTEGER);
 INSERT INTO elem_students VALUES(101,'S101','L101','One','Synthetic','','Female','2018-01-01','Synthetic 101','',0,1,11,7),(102,'S102','L102','Two','Synthetic','','Male','2018-01-01','Synthetic 102','',0,1,12,7),(103,'S103','L103','Three','Synthetic','','Female','2018-01-01','Synthetic 103','',0,1,13,7),(104,'S104','L104','Four','Synthetic','','Male','2018-01-01','Synthetic 104','',0,1,11,7),(105,'S105','L105','Deleted','Synthetic','','Female',NULL,NULL,'',1,1,11,7),(106,'S106','L106','Historical','Synthetic','','Female',NULL,NULL,'',0,1,11,6);
 `);calls.length=0;writes=0;
});
test.afterEach(()=>db.close());
test.after(async()=>{await new Promise(r=>server.close(r));if(previousDb)require.cache[dbId]=previousDb;else delete require.cache[dbId];if(previousSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previousSecret;});
async function request(id,claims,method='GET',kind){const token=claims?kind==='invalid'?'invalid':jwt.sign(claims,secret,{expiresIn:kind==='expired'?-1:'2m'}):undefined;const response=await fetch(`${base}/${id}?role=ADMIN&userId=901&parentId=51`,{method,headers:{'Content-Type':'application/json',...(token?{Cookie:`token=${token}`}:{})},...(method==='GET'?{}:{body:JSON.stringify({dateOfBirth:'2019-01-01',residentialAddress:'Synthetic updated',role:'ADMIN',userId:901})})});return{status:response.status,body:await response.json()};}
for(const [role,userId,allowed]of [
 ['ADMIN',901,[101,102,103,104,106]],['PRINCIPAL',902,[101,102,103,104,106]],['TEACHER',701,[101,103,104]],['TEACHER',702,[102]],['PARENT',801,[101,103,106]],['PARENT',802,[102]],['PARENT',51,[]],['PARENT',803,[]],
])for(const id of [101,102,103,104,105,106])test(`executed SQL ${role}/${userId} profile ${id}`,async()=>{
 const result=await request(id,{role,userId});assert.equal(result.status,allowed.includes(id)?200:404);assert.equal(writes,0);assert.equal(calls.length,1);
 if(result.status===200){assert.equal(result.body.id,String(id));assert.equal(result.body.studentId,'S'+id);}else assert.equal(result.body.personalInformation,undefined);
});
for(const role of ['PARENT','PRINCIPAL','TEACHER','UNKNOWN',null,[],{}])test(`executed SQL write guard ${JSON.stringify(role)} has zero SQL/mutations`,async()=>{
 assert.equal((await request(101,{userId:801,role},'PUT')).status,['PARENT','PRINCIPAL','TEACHER'].includes(role)?403:401);assert.equal(calls.length,0);assert.equal(writes,0);assert.equal(db.prepare('SELECT date_of_birth FROM elem_students WHERE id=101').get().date_of_birth,'2018-01-01');
});
test('Admin update changes only the requested profile and returns unchanged response contract',async()=>{
 const result=await request(101,{userId:901,role:'ADMIN'},'PUT');assert.equal(result.status,200);assert.equal(writes,1);assert.equal(result.body.personalInformation.dateOfBirth,'2019-01-01');assert.equal(db.prepare('SELECT date_of_birth FROM elem_students WHERE id=102').get().date_of_birth,'2018-01-01');
});
for(const kind of ['missing','invalid','expired'])test(`executed SQL ${kind} authentication is denied before SQL`,async()=>{assert.equal((await request(101,kind==='missing'?undefined:{userId:801,role:'PARENT'},'GET',kind)).status,401);assert.equal(calls.length,0);});
test('unlinking a child removes profile permission immediately',async()=>{db.exec('DELETE FROM parent_student WHERE parent_id=51 AND student_id=101');assert.equal((await request(101,{userId:801,role:'PARENT'})).status,404);assert.equal(writes,0);});
