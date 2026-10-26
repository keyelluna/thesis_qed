const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const cookieParser=require('cookie-parser');
const jwt=require('jsonwebtoken');
const {randomBytes}=require('node:crypto');
// Actual local routers/JWT/controllers; never import the configured live DB.
const dbId=require.resolve('../config/db'),previousDb=require.cache[dbId];
const calls=[];let writes=0;
async function query(sql,params){
 calls.push({sql,params});
 if(/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)){writes++;return [{insertId:21,affectedRows:1}];}
 if(/FROM school_year WHERE is_active/.test(sql))return [[{id:7,school_year:'Synthetic'}]];
 if(/SELECT id FROM grade_level WHERE id/.test(sql))return [[{id:1}]];
 if(/SELECT id FROM school_year/.test(sql))return [[{id:7}]];
 if(/FROM assessment_type WHERE id/.test(sql))return [[{id:21,assessmentName:'Synthetic assessment'}]];
 if(/FROM grade_level_sections WHERE id/.test(sql))return [[{id:21,grade_level_id:1,section_name:'Synthetic section'}]];
 return [[]];
}
const db={query,execute:query,async getConnection(){calls.push({sql:'CONNECT'});return db;},async beginTransaction(){calls.push({sql:'BEGIN'});},async commit(){calls.push({sql:'COMMIT'});},async rollback(){calls.push({sql:'ROLLBACK'});},release(){calls.push({sql:'RELEASE'});}};
require.cache[dbId]={id:dbId,filename:dbId,loaded:true,exports:db};
const controllers=[
 require('../src/modules/admin/classes-management/classManagement.controller'),
 require('../src/modules/admin/section-management/section.controller'),
 require('../src/modules/admin/subject-management/subjectManagement.controller'),
 require('../src/modules/admin/subject-management/subjectGradeTemplate.controller'),
];
let entries=0;
for(const controller of controllers)for(const name of Object.keys(controller)){
 const original=controller[name];if(typeof original==='function')controller[name]=function(...args){entries++;return original.apply(this,args);};
}
const routers=[
 ['/api/classes',require('../src/modules/admin/classes-management/classManagement.router')],
 ['/api/section',require('../src/modules/admin/section-management/section.router')],
 ['/api/subject',require('../src/modules/admin/subject-management/subjectManagement.router')],
 ['/api/subject',require('../src/modules/admin/subject-management/subjectGradeTemplate.router')],
];
const secret=randomBytes(32).toString('hex'),previousSecret=process.env.JWT_SECRET;
let server,base;
test.before(async()=>{process.env.JWT_SECRET=secret;const app=express();app.use(cookieParser(),express.json());for(const [path,router]of routers)app.use(path,router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
test.beforeEach(()=>{calls.length=0;writes=0;entries=0;});
test.after(async()=>{await new Promise(r=>server.close(r));if(previousSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previousSecret;if(previousDb)require.cache[dbId]=previousDb;else delete require.cache[dbId];});
const operations=[
 ['POST','/api/classes/addClass',{gradeLevel:1,section:'',room:'Synthetic',adviserId:'',schedule:[]}],
 ['PUT','/api/classes/updateClass/21',{}],['DELETE','/api/classes/21'],
 ['POST','/api/section/addSection',{gradeLevel:1,sectionName:'Synthetic section'}],
 ['PUT','/api/section/updateSection/21',{sectionName:'Synthetic section'}],
 ['PUT','/api/section/deactivateSection/21'],['DELETE','/api/section/deleteSection/21'],
 ['PUT','/api/subject/updateSubjectSection/21',{}],['PUT','/api/subject/assignTeacher/21',{}],
 ['POST','/api/subject/addSubject',{}],['PUT','/api/subject/toggleStatus/21'],
 ['POST','/api/subject/',{assessmentName:'Synthetic assessment'}],
 ['PUT','/api/subject/21',{assessmentName:'Synthetic assessment'}],['DELETE','/api/subject/21'],
 ['POST','/api/subject/uploadGradeTemplate/21',{}],
];
function token(role,extra={}){return jwt.sign({userId:701,...(role===undefined?{}:{role}),...extra},secret,{expiresIn:'1m'});}
async function request(method,path,body,auth){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:`token=${auth}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};}
for(const [method,path,body]of operations){
 for(const role of ['PRINCIPAL','TEACHER','PARENT','UNKNOWN',undefined,null,[],{},123,' ADMIN '])test(`${method} ${path}: ${JSON.stringify(role)} cannot enter controller/SQL`,async()=>{
  const result=await request(method,path,body,token(role));assert.equal(result.status,['PRINCIPAL','TEACHER','PARENT'].includes(role)?403:401);assert.equal(entries,0);assert.equal(calls.length,0);assert.equal(writes,0);
 });
 for(const kind of ['missing','invalid','expired','reset-purpose'])test(`${method} ${path}: ${kind} cannot enter controller/SQL`,async()=>{
  const auth=kind==='missing'?undefined:kind==='invalid'?'invalid-test-jwt':kind==='expired'?jwt.sign({userId:701,role:'ADMIN'},secret,{expiresIn:-1}):token('ADMIN',{purpose:'password_reset'});
  const result=await request(method,path,body,auth);assert.equal(result.status,401);assert.equal(entries,0);assert.equal(calls.length,0);assert.equal(writes,0);
 });
 test(`${method} ${path}: authenticated role cannot be spoofed`,async()=>{const result=await request(method,path+'?role=ADMIN',{...body,role:'ADMIN',user:{role:'ADMIN'}},token('TEACHER'));assert.equal(result.status,403);assert.equal(entries,0);assert.equal(calls.length,0);assert.equal(writes,0);});
}
for(const role of ['ADMIN','admin'])for(const [path,body]of [
 ['/api/section/addSection',{gradeLevel:1,sectionName:'Synthetic section'}],
 ['/api/subject/',{assessmentName:'Synthetic assessment'}],
])test(`${path}: ${role} retains actual create controller and response`,async()=>{const result=await request('POST',path,body,token(role));assert.equal(result.status,201);assert.equal(entries,1);assert.equal(writes,1);assert.ok(result.body.data);});
for(const role of ['ADMIN','PRINCIPAL','TEACHER','PARENT'])for(const path of ['/api/classes/gradeLevels','/api/classes/teacher/all','/api/section/getGradeLevel','/api/subject/getSubjectsByGrade/1','/api/subject/getSubjectSectionsByGrade/1','/api/subject/','/api/subject/getActiveGradeTemplate/1'])test(`${path}: authenticated ${role} retains metadata reads`,async()=>{const result=await request('GET',path,undefined,token(role));assert.equal(result.status,200);assert.equal(entries,1);assert.equal(writes,0);});
for(const path of ['/api/subject/getSubjectsByGrade/1','/api/subject/getSubjectSectionsByGrade/1','/api/subject/','/api/subject/getActiveGradeTemplate/1','/api/subject/getActiveGradeTemplateBySection/1','/api/subject/getEffectiveWeights/1'])test(`${path}: unauthenticated metadata denied before controller/SQL`,async()=>{const result=await request('GET',path);assert.equal(result.status,401);assert.equal(entries,0);assert.equal(calls.length,0);});
test('template upload: authorized Admin retains existing no-file400 contract',async()=>{const result=await request('POST','/api/subject/uploadGradeTemplate/21',{},token('ADMIN'));assert.deepEqual(result,{status:400,body:{success:false,message:'No file uploaded.'}});assert.equal(entries,1);assert.equal(calls.length,0);});
