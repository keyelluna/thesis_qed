const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const cookieParser=require('cookie-parser');
const jwt=require('jsonwebtoken');
const {randomBytes}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
// Actual routers, JWT middleware, ownership middleware and controllers.
// SQL executes in isolated SQLite, a MySQL adapter double, never a school DB.
let db,mutations=0;const calls=[];
async function execute(sql,params=[]){
 calls.push({sql,params});
 if(sql.includes('information_schema.TABLES'))return [params.map(tableName=>({tableName,engine:'InnoDB'}))];
 if(sql.includes('information_schema.STATISTICS'))return [[{indexName:'score_pair',columnName:'student_id'},{indexName:'score_pair',columnName:'item_id'}]];
 sql=sql.replace(/\s+FOR UPDATE\s*$/i,'');
 if(/^\s*SELECT/i.test(sql))return [db.prepare(sql).all(...params)];
 sql=sql.replace(/ON DUPLICATE KEY UPDATE score = VALUES\(score\)/,'ON CONFLICT(item_id,student_id) DO UPDATE SET score=excluded.score')
  .replace(/ON DUPLICATE KEY UPDATE rating = VALUES\(rating\)/,'ON CONFLICT(subject_section_id,student_id,week_start_date,term_number,axis) DO UPDATE SET rating=excluded.rating');
 const result=db.prepare(sql).run(...params);mutations+=Number(result.changes);return [{affectedRows:Number(result.changes),insertId:Number(result.lastInsertRowid)}];
}
for(const [path,exports] of [
 ['../config/db',{execute,query:execute,async getConnection(){return {execute,query:execute,beginTransaction:async()=>db.exec('BEGIN'),commit:async()=>db.exec('COMMIT'),rollback:async()=>db.exec('ROLLBACK'),release(){},destroy(){if(db.isTransaction)db.exec('ROLLBACK');}};}}],
 ['../src/modules/notification/notification.service',new Proxy({},{get:()=>async()=>{}})],
 ['../src/modules/shared/grades/gradeCache.service',{recalcStudentSubject:async()=>{},recalcAllStudentsForSubject:async()=>{}}],
]){const id=require.resolve(path);require.cache[id]={id,filename:id,loaded:true,exports};}
const grading=require('../src/modules/teacher/gradebook/subjectGrading.router');
const holistic=require('../src/modules/teacher/holistic/holistics.router');
const secret=randomBytes(32).toString('hex'),oldSecret=process.env.JWT_SECRET;let server,base;
test.before(async()=>{process.env.JWT_SECRET=secret;const app=express();app.use(express.json(),cookieParser());app.use('/grading',grading);app.use('/holistic',holistic);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
test.beforeEach(()=>{
 db=new DatabaseSync(':memory:');db.function('CONCAT',{varargs:true},(...v)=>v.join(''));
 db.exec(`CREATE TABLE school_year(id INTEGER,is_active INTEGER);INSERT INTO school_year VALUES(7,1),(6,0);
 CREATE TABLE teacher_table(id INTEGER,user_id INTEGER,first_name TEXT,last_name TEXT,is_deleted INTEGER);INSERT INTO teacher_table VALUES(41,701,'Synthetic','One',0),(42,702,'Synthetic','Two',0),(43,703,'Synthetic','Deleted',1);
 CREATE TABLE elem_subjects(id INTEGER,subject_name TEXT,grade_level_id INTEGER);INSERT INTO elem_subjects VALUES(21,'Math',1),(23,'Reading',3);
 CREATE TABLE grade_level(id INTEGER,grade_level TEXT);INSERT INTO grade_level VALUES(1,'Grade 1'),(3,'Grade 3');
 CREATE TABLE grade_level_sections(id INTEGER,section_name TEXT);INSERT INTO grade_level_sections VALUES(11,'A'),(12,'B');
 CREATE TABLE classes(id INTEGER,class_adviser_id INTEGER,section_id INTEGER,grade_level_id INTEGER,school_year_id INTEGER);
 CREATE TABLE [subject-section](id INTEGER,teacher_id INTEGER,subject_id INTEGER,section_id INTEGER,school_year_id INTEGER);INSERT INTO [subject-section] VALUES(61,41,21,11,7),(62,41,23,NULL,7),(63,42,21,12,7);
 CREATE TABLE elem_students(id INTEGER,grade_level_id INTEGER,section_id INTEGER,is_deleted INTEGER,status TEXT,current_school_year_id INTEGER);
 INSERT INTO elem_students VALUES(101,1,11,0,'active',7),(102,1,12,0,'active',7),(103,3,NULL,0,'active',7),(104,3,13,0,'active',7),(105,2,NULL,0,'active',7),(106,1,11,0,'active',6),(107,1,11,0,'graduated',7),(108,1,11,1,'active',7);
 CREATE TABLE grade_items(id INTEGER,subject_section_id INTEGER,grading_period_id INTEGER,topic_id INTEGER,max_items REAL);INSERT INTO grade_items VALUES(91,61,1,NULL,20),(92,62,1,NULL,20);
 CREATE TABLE grade_scores(item_id INTEGER,student_id INTEGER,score REAL,UNIQUE(item_id,student_id));
 CREATE TABLE holistic_ratings(subject_section_id INTEGER,student_id INTEGER,week_start_date TEXT,term_number INTEGER,axis TEXT,rating REAL,UNIQUE(subject_section_id,student_id,week_start_date,term_number,axis));
 CREATE TABLE learning_topics(id INTEGER,subject_section_id INTEGER);INSERT INTO learning_topics VALUES(81,61),(82,62);
 CREATE TABLE interventions(id INTEGER PRIMARY KEY,student_id INTEGER,topic_id INTEGER,subject_section_id INTEGER,activity_name TEXT,intervention_date TEXT,notes TEXT);`);
 calls.length=0;mutations=0;
});
test.afterEach(()=>db.close());test.after(async()=>{await new Promise(r=>server.close(r));if(oldSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=oldSecret;});
const endpoints=['score','grading-holistic','holistic','intervention'];
async function request(endpoint,studentId,section=61,claims={userId:701,role:'TEACHER'}){
 const route=endpoint==='score'?`/grading/${section}/scores`:endpoint==='grading-holistic'?`/grading/${section}/holistic`:endpoint==='holistic'?`/holistic/${section}`:`/grading/${section}/interventions`;
 const body=endpoint==='score'?{studentId,itemId:section===61?91:92,value:null}:endpoint==='intervention'?{studentId,topicId:section===61?81:82,activityName:'Synthetic only',date:'2090-09-09'}:{studentId,axis:'cognitive',value:4,termNumber:1,weekStartDate:'2090-09-09'};
 const headers={'Content-Type':'application/json'};if(claims)headers.Cookie=`token=${jwt.sign(claims,secret,{expiresIn:'5m'})}`;
 return fetch(base+route,{method:endpoint==='intervention'?'POST':'PUT',headers,body:JSON.stringify({...body,role:'TEACHER',userId:701,teacherId:41})});
}
for(const endpoint of endpoints){
 for(const [section,student,allowed] of [[61,101,true],[61,102,false],[61,103,false],[62,103,true],[62,104,true],[62,101,false],[62,105,false],[61,106,false],[61,107,false],[61,108,false],[62,999,false]])test(`${endpoint}: class ${section} student ${student} ${allowed?'allowed':'denied before writes'}`,async()=>{
  const res=await request(endpoint,student,section);assert.equal(res.status,allowed?(endpoint==='intervention'?201:200):403);assert.equal(mutations,allowed?1:0);
 });
 for(const role of ['ADMIN','PRINCIPAL','PARENT','UNKNOWN',null,{},['TEACHER']])test(`${endpoint}: role ${JSON.stringify(role)} cannot masquerade as Teacher`,async()=>{
  const res=await request(endpoint,101,61,{userId:701,role});assert.equal(res.status,['ADMIN','PRINCIPAL','PARENT'].includes(role)?403:401);assert.equal(mutations,0);assert.equal(calls.length,0);
 });
 test(`${endpoint}: other Teacher cannot write owned class`,async()=>{const res=await request(endpoint,101,61,{userId:702,role:'TEACHER'});assert.equal(res.status,403);assert.equal(mutations,0);});
 test(`${endpoint}: unauthenticated denied`,async()=>{const res=await request(endpoint,101,61,null);assert.equal(res.status,401);assert.equal(mutations,0);assert.equal(calls.length,0);});
}

for(const endpoint of endpoints)for(const [kind,claims,expected,queries] of [
 ['reset-purpose',{userId:701,role:'TEACHER',purpose:'password_reset'},401,0],
 ['missing-role',{userId:701},401,0],
 ['profile-ID-confusion',{userId:41,role:'TEACHER'},404,1],
 ['deleted-profile',{userId:703,role:'TEACHER'},404,1],
])test(`${endpoint}: ${kind} cannot reach a write`,async()=>{const res=await request(endpoint,101,61,claims);assert.equal(res.status,expected);assert.equal(mutations,0);assert.equal(calls.length,queries);});
