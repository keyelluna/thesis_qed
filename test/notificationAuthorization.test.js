const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const dbId = require.resolve('../config/db');
const calls = [];
const rows = [{id: 501, user_id: 101, title:'Synthetic', message:'Fixture', is_read:0}];
require.cache[dbId] = {id:dbId,filename:dbId,loaded:true,exports:{async query(sql,params){
  calls.push({sql,params});
  if (sql.startsWith('SELECT')) return [rows.filter(row=>String(row.user_id)===String(params[0]))];
  if (sql.includes('WHERE id = ? AND user_id = ?')) {
    const row=rows.find(row=>String(row.id)===String(params[0])&&String(row.user_id)===String(params[1]));
    if(row)row.is_read=1;
    return [{affectedRows:row?1:0}];
  }
  rows.filter(row=>String(row.user_id)===String(params[0])).forEach(row=>row.is_read=1);
  return [{affectedRows:1}];
}}};
// No email, socket server, environment files or real database are loaded.
const serviceId=require.resolve('../src/modules/notification/notification.service');
require.cache[serviceId]={id:serviceId,filename:serviceId,loaded:true,exports:{getAdvisoryGradeSheetPath:()=>null}};
const router=require('../src/modules/notification/notification.router');
const {notificationOwner}=require('../src/modules/notification/notification.identity');
const secret=randomBytes(32).toString('hex');
const previous=process.env.JWT_SECRET;
let server,base;
test.before(async()=>{process.env.JWT_SECRET=secret; const app=express();app.use(cookieParser());app.use(express.json());app.use('/api/notification',router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port+'/api/notification';});
test.after(async()=>{await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;});
test.beforeEach(()=>{calls.length=0;rows[0].is_read=0;});
async function request(path,method='GET',claims,options={}) {
 const token=claims===undefined?undefined:jwt.sign(claims,secret,{expiresIn:'5m',...options});
 const res=await fetch(base+path,{method,headers:token?{Cookie:'token='+token}: {}});
 return {status:res.status,body:await res.json()};
}
for(const role of ['ADMIN','PRINCIPAL','TEACHER','PARENT','principal']) {
 for(const [path,method] of [['/101','GET'],['/user/101/read-all','PATCH'],['/501/read','PATCH']]) {
  test(role+' owns authentication ID '+method+' '+path,async()=>{const result=await request(path,method,{userId:101,role});assert.equal(result.status,200);assert.equal(calls.length,1);assert.ok(calls[0].params.includes('101'));});
 }
 for(const [path,method] of [['/101','GET'],['/user/101/read-all','PATCH']]) {
  test(role+' cross-account/profile-ID denied '+method+' '+path,async()=>{const result=await request(path+'?userId=202&role=ADMIN',method,{userId:202,role});assert.equal(result.status,403);assert.equal(calls.length,0);assert.equal(rows[0].is_read,0);});
 }
 test(role+' cannot mark another owner notification',async()=>{const result=await request('/501/read','PATCH',{userId:202,role});assert.equal(result.status,200);assert.equal(rows[0].is_read,0);assert.deepEqual(calls[0].params,['501','202']);assert.match(calls[0].sql,/WHERE id = \? AND user_id = \?/);});
}
for(const [path,method] of [['/101','GET'],['/user/101/read-all','PATCH'],['/501/read','PATCH']]) {
 test('missing authentication '+path,async()=>{assert.equal((await request(path,method)).status,401);assert.equal(calls.length,0);});
 test('expired JWT '+path,async()=>{assert.equal((await request(path,method,{userId:101,role:'PRINCIPAL'},{expiresIn:-1})).status,403);assert.equal(calls.length,0);});
 for(const claims of [{userId:101}, {userId:101,role:['ADMIN']},{userId:101,role:'UNKNOWN'},{userId:0,role:'ADMIN'},{userId:{id:101},role:'ADMIN'},{userId:101,role:'ADMIN',purpose:'password_reset'}])
 test('malformed identity '+JSON.stringify(claims)+' '+path,async()=>{assert.equal((await request(path,method,claims)).status,403);assert.equal(calls.length,0);});
}
test('socket identity excludes reset-purpose and role-profile fallbacks',()=>{
 assert.equal(notificationOwner({userId:101,role:'PRINCIPAL'}),'101');
 assert.equal(notificationOwner({id:101,role:'PRINCIPAL'}),null);
 assert.equal(notificationOwner({userId:101,role:'PRINCIPAL',purpose:'password_reset'}),null);
});
