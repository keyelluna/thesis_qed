const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { randomBytes } = require('node:crypto');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const tables = ['admin_table','principal_table','teacher_table','parent_table'];
let state, operations, mail, fail, schemaReady, roleColumnReady, emailResult, locks, activeTransactions;
function empty(){return {auth:[],profiles:Object.fromEntries(tables.map(t=>[t,[]]))};}
function inject(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
function makeConnection(){
 let working, locked=false;
 const current=()=>working || state;
 return {
  async beginTransaction(){operations.push('begin');activeTransactions++;working=structuredClone(state);},
  async commit(){operations.push('commit');if(fail==='commit')throw Error('fixture');state=working;working=null;activeTransactions--;},
  async rollback(){operations.push('rollback');working=null;activeTransactions--;},
  release(){operations.push('release');},destroy(){operations.push('destroy');},
  async execute(sql,args=[]){
   operations.push(sql);
   if(sql.includes('GET_LOCK')){while(locks)await new Promise(r=>setImmediate(r));locked=true;locks++;return [[{acquired:1}]];}
   if(sql.includes('RELEASE_LOCK')){if(locked){locks--;locked=false;}return [[{released:1}]];}
   if(sql.includes('information_schema.TABLES'))return [schemaReady?['qed_authentication',...tables].map(TABLE_NAME=>({TABLE_NAME,ENGINE:'InnoDB'})):[]];
   if(sql.includes('information_schema.COLUMNS') && !args.length)return [[{COLUMN_NAME:'gender'},{COLUMN_NAME:'avatar_key'}]];
   if(sql.includes('information_schema.COLUMNS'))return [args.flatMap(TABLE_NAME=>['id','user_id','user_name','password','role','must_change_password','first_name','last_name','middle_name','email_address','contact_number','status','gender','avatar_key'].map(COLUMN_NAME=>({TABLE_NAME,COLUMN_NAME}))).filter(row=>roleColumnReady || row.TABLE_NAME!=='teacher_table' || row.COLUMN_NAME!=='role')];
   if(sql.startsWith('INSERT INTO qed_authentication')){if(fail==='auth')throw Error('fixture');const id=current().auth.length+100;current().auth.push({id,user_name:args[0],password:args[1],role:args[2],must_change_password:1});return [{insertId:id}];}
   if(sql.startsWith('SELECT id FROM qed_authentication'))return [current().auth.filter(row=>row.user_name===args[0])];
   if(sql.startsWith('SELECT * FROM qed_authentication'))return [state.auth.filter(row=>row.user_name===args[0])];
   if(sql.startsWith('UPDATE qed_authentication') && sql.includes('is_deleted = 1')){const row=current().auth.find(row=>String(row.id)===String(args[0]));if(row)row.is_deleted=1;return [{affectedRows:row?1:0}];}
   if(sql.startsWith('INSERT INTO login_logs'))return [{insertId:1}];
   if(sql.includes('JOIN teacher_table ON qed_authentication.id = teacher_table.user_id'))return [state.profiles.teacher_table.filter(row=>row.user_id===args[0])];
   const table=tables.find(t=>sql.includes(t));
   if(table && sql.startsWith('UPDATE')){const deletion=sql.includes('is_deleted = 1');const row=current().profiles[table].find(row=>String(row.id)===String(deletion?args[0]:args[7]));if(row){if(deletion){row.is_deleted=1;row.status='Inactive';}else{[row.last_name,row.first_name,row.middle_name,row.email_address,row.contact_number,row.status,row.gender]=args;}}return [{affectedRows:row?1:0}];}
   if(table && sql.startsWith('SELECT user_id'))return [current().profiles[table].filter(row=>String(row.id)===String(args[0]))];
   if(table && sql.startsWith('SELECT *') && sql.includes('WHERE id = ?'))return [current().profiles[table].filter(row=>String(row.id)===String(args[0]))];
   if(table && sql.startsWith('SELECT *'))return [current().profiles[table].filter(row=>!row.is_deleted)];
   if(table && sql.startsWith('SELECT COUNT'))return [[{total:current().profiles[table].filter(row=>!row.is_deleted).length}]];
   if(table && sql.startsWith('INSERT INTO')){if(fail==='profile')throw Error('fixture');if(fail==='duplicate'){const e=Error('fixture');e.code='ER_DUP_ENTRY';throw e;}const columns=sql.match(/\(([^)]+)\)/)[1].split(',').map(c=>c.trim());const values=Object.fromEntries(columns.map((c,i)=>[c,args[i]]));if(table==='teacher_table' && values.role==null){const e=Error('Required Teacher role omitted');e.code='ER_NO_DEFAULT_FOR_FIELD';throw e;}const id=current().profiles[table].length+10;current().profiles[table].push({id,...values,is_deleted:0});return [{insertId:id}];}
   if(table && sql.includes('email_address = ?'))return [current().profiles[table].filter(row=>row.email_address===args[0])];
   if(table && sql.includes("status = 'Active'"))return [current().profiles[table].filter(row=>row.status==='Active')];
   if(table && sql.includes('WHERE user_id = ?'))return [state.profiles[table].filter(row=>row.user_id===args[0]).map(row=>({...row,name:row.first_name+' '+row.last_name}))];
   throw Error('Unexpected fixture SQL: '+sql);
  },
  async query(sql,args){return this.execute(sql,args);}
 };
}
const pool={getConnection:async()=>{operations.push('acquire');return makeConnection();},execute:async(sql,args)=>makeConnection().execute(sql,args),query:async(sql,args)=>makeConnection().query(sql,args)};
inject('../config/db',pool);
inject('../src/services/mailer.service',{sendCredentialsEmail:async data=>{mail.push(data);if(emailResult==='throw')throw Error('fixture');return emailResult;},sendPasswordResetOtpEmail:async()=>{}});
inject('../src/modules/shared/audit/auditLog.service',{recordAuditEvent:async()=>{}});
const authRouter=require('../src/modules/authentication/authentication.router');
const userRouter=require('../src/modules/admin/user-record/userRecord.router');
const analyticsRouter=require('../src/modules/authentication/loginfrequency.router');
const teacherRouter=require('../src/modules/teacher/dashboard/teacherDashboard.router');
let server,base;
test.before(async()=>{const app=express();app.use(cookieParser());app.use(express.json());app.use('/api/auth',authRouter);app.use('/api/user',userRouter);app.use('/api/analytics',analyticsRouter);app.use('/api/teacher-dashboard',teacherRouter);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{await new Promise(r=>server.close(r));});
test.beforeEach(()=>{state=empty();operations=[];mail=[];fail=null;schemaReady=true;roleColumnReady=true;emailResult={sent:true};locks=0;activeTransactions=0;});
const payload=(role='TEACHER')=>({role,firstName:'Fixture',lastName:'Only',middleName:'',email:'fixture@example.invalid',contactNumber:'00000000000',gender:'Male',status:'Active'});
async function request(url,method='POST',body=payload(),role='ADMIN'){
 const token=role===undefined?undefined:jwt.sign({userId:1,role},process.env.JWT_SECRET,{expiresIn:'5m'});
 const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Cookie:`token=${token}`}:{})},...(method==='GET'?{}:{body:JSON.stringify(body)})});
 return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
}
const routes=[['/api/auth/register','POST'],['/api/user/addUser','POST'],['/api/user/editUser/10','PUT'],['/api/user/deleteUser/10','PATCH'],['/api/user/getUser/teacher/10','GET'],['/api/user/totalUser','GET'],['/api/user/teacherCount','GET'],['/api/user/parentCount','GET'],['/api/user/usersList','GET']];
for(const [url,method] of routes){
 test(`${method} ${url}: unauthenticated denied before DB`,async()=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(payload('ADMIN'))})});assert.equal(r.status,401);assert.equal(operations.length,0);});
 for(const role of ['TEACHER','PRINCIPAL','PARENT','OWNER',null,{},['ADMIN'],' ADMIN '])test(`${method} ${url}: role ${JSON.stringify(role)} denied before DB`,async()=>{const r=await request(url,method,payload('ADMIN'),role);assert.equal(r.status,['TEACHER','PRINCIPAL','PARENT'].includes(role)?403:401);assert.equal(operations.length,0);assert.equal(mail.length,0);});
}
for(const endpoint of ['/api/auth/register','/api/user/addUser'])for(const role of ['ADMIN','TEACHER','PRINCIPAL','PARENT'])test(`${endpoint}: atomic authorized ${role} provisioning`,async()=>{
 const r=await request(endpoint,'POST',payload(role));assert.equal(r.status,201);assert.equal(r.body.success,true);assert.equal(r.body.credentialDelivery,'accepted');assert.equal(state.auth.length,1);assert.equal(state.auth[0].role,role);assert.equal(state.auth[0].must_change_password,1);assert.equal(state.profiles[role.toLowerCase()+'_table'].length,1);assert.equal(r.body.data.userId,state.auth[0].id);assert.equal(mail.length,1);assert.equal(mail[0].to,payload().email);assert(await bcrypt.compare(mail[0].password,state.auth[0].password));assert(!JSON.stringify(r.body).includes(mail[0].password));assert(!JSON.stringify(r.body).includes(state.auth[0].password));assert(!Object.hasOwn(r.body,'token'));assert.equal(r.cookie,null);assert.equal(operations.filter(o=>o==='begin').length,1);assert.equal(operations.filter(o=>o==='commit').length,1);assert.equal(activeTransactions,0);
});
for(const extra of [{userId:999},{password:'untrusted'},{generatedPassword:'untrusted'}])test(`reject client-owned identity/credentials ${Object.keys(extra)[0]}`,async()=>{const r=await request('/api/user/addUser','POST',{...payload(),...extra});assert.equal(r.status,400);assert.equal(operations.length,0);assert.deepEqual(state,empty());});
for(const bad of [{role:'OWNER'},{role:{}},{role:'__proto__'},{firstName:''},{lastName:''},{email:'invalid'},{contactNumber:''},{gender:'Other'},{status:'Unknown'}])test(`invalid input ${Object.keys(bad)[0]} ${JSON.stringify(bad)}`,async()=>{const r=await request('/api/auth/register','POST',{...payload(),...bad});assert.equal(r.status,400);assert.equal(operations.length,0);});
for(const phase of ['auth','profile','duplicate','commit'])test(`${phase} failure rolls back without deleting any existing account`,async()=>{state.auth.push({id:9,user_name:'existing',role:'ADMIN'});const before=structuredClone(state);fail=phase;const r=await request('/api/user/addUser');assert.equal(r.status,phase==='duplicate'?409:500);assert.deepEqual(state,before);assert(operations.includes('rollback'));assert(!operations.some(o=>o.includes('DELETE')));assert.equal(mail.length,0);assert.equal(locks,0);});
test('schema readiness fails closed with no account writes or DDL',async()=>{schemaReady=false;const r=await request('/api/user/addUser');assert.equal(r.status,503);assert.deepEqual(state,empty());assert(!operations.some(o=>/INSERT|ALTER|DELETE/.test(o)));assert.equal(mail.length,0);});
test('duplicate institutional username preserves records',async()=>{await request('/api/user/addUser');const before=structuredClone(state);const r=await request('/api/user/addUser','POST',{...payload(),email:'second@example.invalid'});assert.equal(r.status,409);assert.deepEqual(state,before);assert.equal(mail.length,1);});
test('cross-role duplicate email preserves records',async()=>{await request('/api/user/addUser');const before=structuredClone(state);const r=await request('/api/user/addUser','POST',payload('PARENT'));assert.equal(r.status,409);assert.deepEqual(state,before);assert.equal(mail.length,1);});
test('concurrent duplicate provisioning commits only once',async()=>{const results=await Promise.all([request('/api/user/addUser'),request('/api/auth/register')]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(state.auth.length,1);assert.equal(state.profiles.teacher_table.length,1);assert.equal(mail.length,1);assert.equal(locks,0);});
for(const result of [{sent:false},'throw',{sent:true,redirected:true}])test(`mail result ${JSON.stringify(result)} reports truthfully after commit`,async()=>{emailResult=result;const r=await request('/api/user/addUser');assert.equal(r.status,201);assert.equal(r.body.credentialDelivery,result?.redirected?'test-recipient':'failed');assert.equal(state.auth.length,1);assert(!operations.includes('rollback'));});
test('created Teacher can log in with emailed password and cannot access Admin APIs',async()=>{await request('/api/user/addUser');const m=mail[0];const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userName:m.userName,password:m.password})});const r=await response.json();assert.equal(response.status,200);assert.equal(r.user.role,'TEACHER');assert.equal(r.user.mustChangePassword,true);assert.equal(jwt.verify(r.user.token,process.env.JWT_SECRET).role,'TEACHER');const denied=await fetch(base+'/api/analytics/login-frequency',{headers:{Cookie:`token=${r.user.token}`}});assert.equal(denied.status,403);});

test('provisioned Teacher identity reaches its actual dashboard reader and is denied Admin user records',async()=>{
 const created=await request('/api/user/addUser');assert.equal(created.status,201);
 const listed=await request('/api/user/usersList','GET');assert.equal(listed.body.data.length,1);assert.equal(listed.body.data[0].role,'TEACHER');
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userName:mail[0].userName,password:mail[0].password})});assert.equal(login.status,200);const identity=(await login.json()).user;
 const headers={Cookie:`token=${identity.token}`};const dashboard=await fetch(base+'/api/teacher-dashboard/summary',{headers});assert.equal(dashboard.status,200);assert.deepEqual(await dashboard.json(),{success:true,name:'Fixture Only'});
 operations=[];const denied=await fetch(base+'/api/user/usersList',{headers});assert.equal(denied.status,403);assert.equal(operations.length,0);
});

for(const endpoint of ['/api/auth/register','/api/user/addUser'])for(const kind of ['invalid','expired','unsigned'])test(endpoint+': '+kind+' JWT denied before DB',async()=>{
 const token=kind==='invalid'?'invalid':kind==='unsigned'?jwt.sign({role:'ADMIN'},'',{algorithm:'none'}):jwt.sign({role:'ADMIN'},process.env.JWT_SECRET,{expiresIn:-1});
 const r=await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Cookie:'token='+token},body:JSON.stringify(payload())});assert.equal(r.status,401);assert.equal(operations.length,0);
});
test('registration rejects incomplete old split contract before any writes',async()=>{const r=await request('/api/auth/register','POST',{userName:'legacy',password:'legacy',role:'ADMIN'});assert.equal(r.status,400);assert.equal(operations.length,0);});
test('Principal active conflict preserves existing Principal',async()=>{await request('/api/user/addUser','POST',payload('PRINCIPAL'));const before=structuredClone(state);const r=await request('/api/user/addUser','POST',{...payload('PRINCIPAL'),firstName:'Second',email:'second@example.invalid'});assert.equal(r.status,409);assert.deepEqual(state,before);});

for(const url of ['/api/user/usersList','/api/user/getUser/teacher/10','/api/user/totalUser','/api/user/teacherCount','/api/user/parentCount'])test('authorized Admin GET contract '+url,async()=>{await request('/api/user/addUser');const r=await request(url,'GET');assert.equal(r.status,200);if(url.endsWith('usersList')){assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].role,'TEACHER');}else if(url.includes('getUser')){assert.equal(r.body.success,true);assert.equal(r.body.data.role,'TEACHER');}else if(url.endsWith('totalUser'))assert.deepEqual(r.body,{success:true,totalUsers:1,totalTeachers:1,totalParents:0});});
for(const [url,method]of routes)test(method+' '+url+': missing signed role denied before DB',async()=>{const token=jwt.sign({userId:1},process.env.JWT_SECRET);const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',Cookie:'token='+token},...(method==='GET'?{}:{body:JSON.stringify(payload('ADMIN'))})});assert.equal(r.status,401);assert.equal(operations.length,0);});
for(const role of ['teacher','AdMiN'])test('canonical role normalization '+role,async()=>{const r=await request('/api/user/addUser','POST',payload(role));assert.equal(r.status,201);assert.equal(state.auth[0].role,role.toUpperCase());});

test('client-supplied unrelated ID is rejected without deleting or changing existing records',async()=>{state.auth.push({id:123456,user_name:'protected-existing',role:'ADMIN'});const before=structuredClone(state);const r=await request('/api/user/addUser','POST',{...payload(),userId:123456});assert.equal(r.status,400);assert.deepEqual(state,before);assert.equal(operations.length,0);});
test('concurrent distinct accounts have separate server-owned IDs and profiles',async()=>{const rs=await Promise.all([request('/api/user/addUser'),request('/api/user/addUser','POST',{...payload('PARENT'),firstName:'Second',email:'second@example.invalid'})]);assert.deepEqual(rs.map(r=>r.status),[201,201]);assert.equal(new Set(state.auth.map(r=>r.id)).size,2);assert.equal(state.profiles.teacher_table.length,1);assert.equal(state.profiles.parent_table.length,1);assert.equal(locks,0);});

for(const role of ['ADMIN','PRINCIPAL','PARENT'])test('new '+role+' authenticates through unchanged login contract',async()=>{await request('/api/user/addUser','POST',payload(role));const m=mail[0];const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userName:m.userName,password:m.password})});const data=await response.json();assert.equal(response.status,200);assert.equal(data.user.role,role);assert.equal(data.user.mustChangePassword,true);assert.equal(jwt.verify(data.user.token,process.env.JWT_SECRET).role,role);});
for(const condition of ['unknown','wrong-password','inactive','deleted'])test('existing login denial contract '+condition,async()=>{await request('/api/user/addUser');const m=mail[0];if(condition==='inactive')state.profiles.teacher_table[0].status='Inactive';if(condition==='deleted')state.profiles.teacher_table[0].is_deleted=1;const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userName:condition==='unknown'?'unknown':m.userName,password:condition==='wrong-password'?'wrong':m.password})});const data=await r.json();assert.equal(r.status,['inactive','deleted'].includes(condition)?403:401);assert(!data.user);});

test('authorized Admin editing/status change preserves auth identity and profile contract',async()=>{await request('/api/user/addUser');const originalAuth=structuredClone(state.auth);const r=await request('/api/user/editUser/10','PUT',{...payload(),userId:999,status:'Inactive',firstName:'Updated'});assert.equal(r.status,200);assert.equal(r.body.success,true);assert.deepEqual(state.auth,originalAuth);assert.equal(state.profiles.teacher_table[0].first_name,'Updated');assert.equal(state.profiles.teacher_table[0].status,'Inactive');assert.equal(state.profiles.teacher_table[0].user_id,100);});
test('authorized Admin deletion uses the existing server-linked authentication ID',async()=>{await request('/api/user/addUser');state.auth.push({id:999,user_name:'unrelated',role:'ADMIN'});const r=await request('/api/user/deleteUser/10','PATCH',{role:'TEACHER',userId:999});assert.equal(r.status,200);assert.equal(state.profiles.teacher_table[0].is_deleted,1);assert.equal(state.auth.find(row=>row.id===100).is_deleted,1);assert(!state.auth.find(row=>row.id===999).is_deleted);});

for(const endpoint of ['/api/auth/register','/api/user/addUser']){
 test(endpoint+': required Teacher profile role is canonical and independent of client designations',async()=>{const r=await request(endpoint,'POST',{...payload('teacher'),teacherRole:'ADMIN',profileRole:'ADMIN'});assert.equal(r.status,201);assert.equal(state.profiles.teacher_table[0].role,'TEACHER');assert.equal(state.auth[0].role,'TEACHER');});
 test(endpoint+': missing required Teacher role column fails before transaction or writes',async()=>{roleColumnReady=false;const r=await request(endpoint);assert.equal(r.status,503);assert.deepEqual(state,empty());assert(!operations.some(o=>/INSERT|ALTER|DELETE|UPDATE/.test(o)||o==='begin'));assert.equal(mail.length,0);assert.equal(locks,0);});
}
