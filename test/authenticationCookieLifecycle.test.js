const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');

// Execute the actual logout implementation with real Express serialization,
// without importing account models, credentials, mail, or the database module.
const source = fs.readFileSync(require.resolve('../src/modules/authentication/authentication.controller'), 'utf8');
const logoutCode = source.match(/exports\.logout\s*=\s*async\s*\(req, res\)\s*=>\s*\{[\s\S]*?^\};/m)?.[0];
assert.ok(logoutCode, 'Actual logout implementation must be available');
for (const environment of [undefined, 'development', 'production']) {
  test(`logout clears the common session cookie using the login policy: ${environment ?? 'unset NODE_ENV'}`, async () => {
    const exported = {};
    vm.runInNewContext(logoutCode, { exports: exported, process: { env: { NODE_ENV: environment } }, console });
    const app = express();
    app.post('/logout', (req, res) => Promise.resolve(exported.logout(req, res)));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/logout`, { method: 'POST' });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).message, 'Logout successful');
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie, /^token=;/);
      assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
      assert.match(cookie, /Path=\//);
      if (environment === 'production') {
        assert.match(cookie, /; Secure(?:;|$)/);
        assert.match(cookie, /SameSite=None/);
      } else {
        assert.doesNotMatch(cookie, /; Secure(?:;|$)/);
        assert.match(cookie, /SameSite=Lax/);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

const jwt = require('jsonwebtoken');
const secret = require('node:crypto').randomBytes(32).toString('hex');
const loginCode = source.match(/exports\.login\s*=\s*async\s*\(req, res\)\s*=>\s*\{[\s\S]*?^\};/m)?.[0];
assert.ok(loginCode);
for(const environment of ['development','production']) for(const rememberMe of [false,true]) test(`login serializes ${rememberMe?'persistent':'session'} cookie: ${environment}`,async()=>{
 const exported={};
 const connection={execute:async sql=>[sql.includes('FROM qed_authentication')?[{id:101,user_name:'synthetic',role:'PARENT',password:'synthetic-hash'}]:sql.includes('FROM parent_table')?[{name:'Synthetic',is_deleted:0,status:'Active'}]:{}]};
 vm.runInNewContext(loginCode,{exports:exported,connection,bcrypt:{compare:async()=>true},jwt,JWT_SECRET:secret,JWT_EXPIRES_IN:'1h',ROLE_TABLES:{parent:'parent_table'},genderColumnForRole:async()=> 'NULL',avatarKeyColumnForRole:async()=> 'NULL',recordAuditEvent:async()=>{},process:{env:{NODE_ENV:environment}},console});
 const app=express();app.use(express.json());app.post('/login',exported.login);app.post('/logout',(req,res)=>res.clearCookie('token',{httpOnly:true,secure:environment==='production',sameSite:environment==='production'?'none':'lax'}).end());
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userName:'synthetic',password:'Synthetic',rememberMe})});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Path=\//);
  if(rememberMe){assert.match(cookie,/Max-Age=604800(?:;|$)/);assert.match(cookie,/Expires=/);}else{assert.doesNotMatch(cookie,/Max-Age=|Expires=/);}
  assert.match(cookie,environment==='production'?/; Secure; SameSite=None/:/SameSite=Lax/);
  const body=await response.json(),claims=jwt.verify(body.user.token,secret);assert.equal(claims.exp-claims.iat,rememberMe?604800:3600);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
