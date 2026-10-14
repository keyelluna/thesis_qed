const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const cookieParser=require('cookie-parser');
const jwt=require('jsonwebtoken');
const bcrypt=require('bcrypt');
const {randomBytes}=require('node:crypto');
process.env.JWT_SECRET=randomBytes(32).toString('hex');
let account, profile, operations, emails, mailResult;
function inject(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
const db={async execute(sql,args=[]){
 operations.push(sql);
 if(sql.includes('FROM undefined'))throw Error('Unresolved role table');
 if(sql.startsWith('SELECT') && sql.includes('FROM qed_authentication')){
  const byId=sql.includes('WHERE id = ?');return [[account].filter(row=>row && (byId?String(row.id)===String(args[0]):row.user_name===args[0]) && (!sql.includes('is_deleted = 0') || !row.is_deleted)).map(row=>({...row}))];
 }
 if(sql.startsWith('SELECT') && /FROM (admin|teacher|parent|principal)_table/.test(sql))return [[profile].filter(row=>row && row.user_id===args[0] && (!sql.includes('email_address = ?') || row.email_address===args[1]) && (!sql.includes('is_deleted = 0') || !row.is_deleted) && (!sql.includes("LOWER(status) = 'active'") || row.status.toLowerCase()==='active'))];
 if(sql.startsWith('UPDATE qed_authentication SET password_reset_otp = ?')){account.password_reset_otp=args[0];account.otp_expires_at=args[1];return [{affectedRows:1}];}
 if(sql.startsWith('UPDATE qed_authentication SET password_reset_otp = NULL')){
  if(args.length>1 && (account.password_reset_otp!==args[1] || +new Date(account.otp_expires_at)<=Date.now() || (args.length>3 && account.password!==args[3])))return [{affectedRows:0}];
  account.password_reset_otp=null;account.otp_expires_at=null;return [{affectedRows:1}];
 }
 if(sql.startsWith('UPDATE qed_authentication SET password = ?')){
  if(String(account.id)!==String(args[1]) || (args.length>2 && account.password!==args[2]))return [{affectedRows:0}];
  account.password=args[0];account.must_change_password=0;if(sql.includes('password_reset_otp = NULL')){account.password_reset_otp=null;account.otp_expires_at=null;}return [{affectedRows:1}];
 }
 throw Error('Unsupported recovery fixture operation');
}};
inject('../config/db',db);
inject('../src/services/mailer.service',{sendPasswordResetOtpEmail:async data=>{emails.push(data);if(mailResult==='throw')throw Error('Private provider detail');return mailResult;},sendCredentialsEmail:async()=>({sent:true})});
inject('../src/modules/shared/audit/auditLog.service',{recordAuditEvent:async()=>{}});
const router=require('../src/modules/authentication/authentication.router');
let server,base,originalConsole;
test.before(async()=>{const app=express();app.use(cookieParser());app.use(express.json());app.use('/api/auth',router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/api/auth`;originalConsole=console.error;console.error=()=>{};});
test.after(async()=>{console.error=originalConsole;await new Promise(r=>server.close(r));});
test.beforeEach(async()=>{account={id:101,user_name:'fixture.only',role:'TEACHER',password:await bcrypt.hash('Original123!',10),must_change_password:1,is_deleted:0,password_reset_otp:'123456',otp_expires_at:new Date(Date.now()+600000)};profile={user_id:101,email_address:'fixture@example.invalid',status:'Active',is_deleted:0};operations=[];emails=[];mailResult={sent:true};require('../src/modules/authentication/recoveryRateLimit').recoveryLimits.clear();});
async function request(endpoint,body,cookie){const r=await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:`token=${cookie}`}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
async function verify(){return request('/verify-otp',{userName:account.user_name,otp:account.password_reset_otp});}
test('uppercase role resolves to supported profile table',async()=>{const r=await request('/forgot-password',{userName:account.user_name,email:profile.email_address});assert.equal(r.status,200);assert.equal(emails.length,1);assert(!operations.some(sql=>sql.includes('undefined')));});
test('reset token is rejected after its first successful use',async()=>{account.role='teacher';const result=await verify();assert.equal(result.status,200);const first=await request('/reset-password',{resetToken:result.body.resetToken,newPassword:'Changed123!'});assert.equal(first.status,200);const second=await request('/reset-password',{resetToken:result.body.resetToken,newPassword:'Another123!'});assert.equal(second.status,401);});
test('reset token cannot authenticate a session password-change request',async()=>{account.role='teacher';const result=await verify();const r=await fetch(base+'/change-password',{method:'PUT',headers:{'Content-Type':'application/json',Cookie:`token=${result.body.resetToken}`},body:JSON.stringify({newPassword:'Bypass123!'})});assert.equal(r.status,403);});
for(const role of ['ADMIN','PRINCIPAL','TEACHER','PARENT','AdMiN','teacher'])test(role+' complete recovery preserves role and securely updates password',async()=>{
 account.role=role;const r=await request('/forgot-password',{userName:account.user_name,email:profile.email_address});assert.equal(r.status,200);assert.equal(emails.length,1);assert.equal(emails[0].to,profile.email_address);const verified=await request('/verify-otp',{userName:account.user_name,otp:emails[0].otp});assert.equal(verified.status,200);assert.equal(account.password_reset_otp,null);const claims=jwt.verify(verified.body.resetToken,process.env.JWT_SECRET);assert.equal(claims.purpose,'password_reset');assert.equal(claims.exp-claims.iat,900);const reset=await request('/reset-password',{resetToken:verified.body.resetToken,newPassword:'Recovered123!',userId:999,role:'ADMIN'});assert.equal(reset.status,200);assert.equal(account.role,role);assert.equal(account.must_change_password,0);assert(await bcrypt.compare('Recovered123!',account.password));assert(!(await bcrypt.compare('Original123!',account.password)));assert(!Object.hasOwn(reset.body,'resetToken'));
});
for(const role of ['OWNER','__proto__','constructor',undefined,null,{},['TEACHER'],7,' TEACHER '])test('unknown/malformed stored role fails closed '+JSON.stringify(role),async()=>{
 account.role=role;const r=await request('/forgot-password',{userName:account.user_name,email:profile.email_address});assert.equal(r.status,200);assert.equal(emails.length,0);assert(!operations.some(sql=>/FROM undefined|FROM \[object/.test(sql)));const v=await verify();assert.equal(v.status,400);assert(!operations.some(sql=>sql.startsWith('UPDATE')));
});
for(const condition of ['unknown','wrong-email','deleted-auth','deleted-profile','inactive','provider-rejected','provider-throws'])test('non-enumerating recovery response '+condition,async()=>{
 const good=await request('/forgot-password',{userName:account.user_name,email:profile.email_address});require('../src/modules/authentication/recoveryRateLimit').recoveryLimits.clear();emails=[];if(condition==='deleted-auth')account.is_deleted=1;if(condition==='deleted-profile')profile.is_deleted=1;if(condition==='inactive')profile.status='Inactive';if(condition==='provider-rejected')mailResult={sent:false};if(condition==='provider-throws')mailResult='throw';const r=await request('/forgot-password',{userName:condition==='unknown'?'unknown':account.user_name,email:condition==='wrong-email'?'wrong@example.invalid':profile.email_address});assert.equal(r.status,good.status);assert.deepEqual(r.body,good.body);assert(!JSON.stringify(r.body).includes(profile.email_address));if(condition.startsWith('provider'))assert.equal(account.password_reset_otp,null);
});
for(const otp of ['000000','12345','abcdef',123456,null,{},['123456']])test('invalid OTP shape/value '+JSON.stringify(otp),async()=>{const r=await request('/verify-otp',{userName:account.user_name,otp});assert.equal(r.status,400);assert(!Object.hasOwn(r.body,'resetToken'));assert(!operations.some(sql=>sql.startsWith('UPDATE')));});
for(const expiry of [new Date(0),null,'invalid'])test('expired/missing/malformed OTP expiry '+String(expiry),async()=>{account.otp_expires_at=expiry;const r=await verify();assert.equal(r.status,400);assert(!operations.some(sql=>sql.startsWith('UPDATE')));});
test('OTP is single-use even under concurrent verification',async()=>{const body={userName:account.user_name,otp:'123456'};const rs=await Promise.all([request('/verify-otp',body),request('/verify-otp',body)]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,400]);const again=await request('/verify-otp',body);assert.equal(again.status,400);});
test('reset token consumption is atomic under concurrent password changes',async()=>{const v=await verify();const rs=await Promise.all([request('/reset-password',{resetToken:v.body.resetToken,newPassword:'First123!'}),request('/reset-password',{resetToken:v.body.resetToken,newPassword:'Second123!'})]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,401]);});
test('password changes invalidate already-issued reset tokens',async()=>{const v=await verify();account.password=await bcrypt.hash('External123!',10);const r=await request('/reset-password',{resetToken:v.body.resetToken,newPassword:'Attacker123!'});assert.equal(r.status,401);assert(await bcrypt.compare('External123!',account.password));});
for(const condition of ['invalid','expired','wrong-key','wrong-purpose','missing-binding','missing-expiry','malformed-owner','wrong-owner'])test('unauthorized reset denied '+condition,async()=>{
 const v=await verify();const decoded=jwt.decode(v.body.resetToken);delete decoded.iat;delete decoded.exp;let token=v.body.resetToken;if(condition==='invalid')token='invalid';if(condition==='wrong-purpose')decoded.purpose='session';if(condition==='missing-binding')delete decoded.credentialVersion;if(condition==='malformed-owner')decoded.userId={id:101};if(condition==='wrong-owner')decoded.userId=999;if(condition!=='invalid')token=jwt.sign(decoded,condition==='wrong-key'?randomBytes(32).toString('hex'):process.env.JWT_SECRET,condition==='missing-expiry'?{}:{expiresIn:condition==='expired'?-1:'15m'});operations=[];const before=account.password;const r=await request('/reset-password',{resetToken:token,newPassword:'Unauthorized123!'});assert.equal(r.status,401);assert.equal(account.password,before);assert(!operations.some(sql=>sql.startsWith('UPDATE')));
});
for(const newPassword of ['short1','ALLUPPER123','nonumberhere',12345678,{},'a1'+'x'.repeat(71)])test('password policy rejects '+typeof newPassword+' '+String(newPassword).length,async()=>{const v=await verify();const r=await request('/reset-password',{resetToken:v.body.resetToken,newPassword});assert.equal(r.status,400);assert.equal(account.must_change_password,1);});
test('OTP guesses are bounded per account',async()=>{for(let i=0;i<10;i++){const r=await request('/verify-otp',{userName:account.user_name,otp:'000000'});assert.equal(r.status,400);}operations=[];const r=await verify();assert.equal(r.status,400);assert.equal(operations.length,0);});
test('resend requests are bounded without account-existence disclosure',async()=>{let first;for(let i=0;i<6;i++){const r=await request('/forgot-password',{userName:account.user_name,email:profile.email_address});if(!first)first=r;assert.deepEqual(r,first);}assert.equal(emails.length,5);});
