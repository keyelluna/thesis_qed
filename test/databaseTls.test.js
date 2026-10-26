const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tls = require('node:tls');
const { databaseTlsOptions, sanitizedDatabaseTlsError } = require('../src/operations/databaseTls');
const { diagnostic, operationalError } = require('../src/operations/requestDiagnostics');
const production = { NODE_ENV: 'production', DB_HOST: 'database.example.invalid' };
test('local development preserves existing non-TLS behavior', () => assert.equal(databaseTlsOptions({ NODE_ENV: 'development', DB_HOST: 'localhost' }), undefined));
test('unset environment preserves local test bootstrap', () => assert.equal(databaseTlsOptions({}), undefined));
for (const env of [production, { ...production, DB_TLS_MODE: 'verify-full' }, { ...production, NODE_ENV: 'development', RENDER: 'true' }]) {
  test('production/Render requires chain and hostname verification: '+JSON.stringify(env), () => assert.deepEqual(databaseTlsOptions(env), { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' }));
}
for (const env of [production, { ...production, NODE_ENV: 'development', RENDER: 'true' }]) test('production TLS cannot be disabled: '+env.NODE_ENV, () => assert.throws(() => databaseTlsOptions({ ...env, DB_TLS_MODE: 'disabled' }), { code: 'DB_TLS_CONFIG' }));
test('local development can explicitly verify TLS', () => assert.equal(databaseTlsOptions({ DB_HOST: 'localhost', DB_TLS_MODE: 'verify-full' }).verifyIdentity, true));
for (const mode of ['required','false','true','verify-ca','typo']) test('unknown/weaker TLS mode fails closed: '+mode, () => assert.throws(() => databaseTlsOptions({ ...production, DB_TLS_MODE: mode }), { code: 'DB_TLS_CONFIG' }));
for (const host of [undefined,'127.0.0.1','::1',' database.example.invalid','bad..example.invalid','https://database.example.invalid']) test('TLS requires a valid DNS hostname: '+String(host), () => assert.throws(() => databaseTlsOptions({ ...production, DB_HOST: host }), { code: 'DB_TLS_CONFIG' }));
test('trusted CA file supports runtime-supplied public CA without private material', () => {
  let requested;
  const options = databaseTlsOptions({ ...production, DB_TLS_CA_FILE: 'runtime-ca-file' }, file => { requested=file;return tls.rootCertificates[0]; });
  assert.equal(requested,'runtime-ca-file');assert.equal(options.ca,tls.rootCertificates[0]);assert.equal(options.rejectUnauthorized,true);assert.equal(options.verifyIdentity,true);
});
test('unreadable CA yields sanitized configuration failure', () => {
  assert.throws(() => databaseTlsOptions({ ...production, DB_TLS_CA_FILE: 'private-location' }, () => { throw Error('password and private-location'); }), e => e.code==='DB_TLS_CONFIG'&&!/private-location|password/.test(e.message));
});
for (const contents of ['not a certificate','-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----','-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----']) test('invalid/private CA material fails closed: '+contents.slice(0,20), () => assert.throws(() => databaseTlsOptions({ ...production, DB_TLS_CA_FILE:'runtime-ca-file' }, () => contents), {code:'DB_TLS_CONFIG'}));
test('installed mysql2 retains explicitly enabled chain and hostname verification', () => {
  const Config=require('../node_modules/mysql2/lib/connection_config');const c=new Config({host:production.DB_HOST,ssl:databaseTlsOptions(production)});assert.equal(c.ssl.rejectUnauthorized,true);assert.equal(c.ssl.verifyIdentity,true);assert.equal(c.ssl.minVersion,'TLSv1.2');
});
test('hostname verification accepts the intended DNS SAN', () => assert.equal(tls.checkServerIdentity('database.example.invalid',{subjectaltname:'DNS:database.example.invalid'}),undefined));
test('hostname verification rejects another DNS SAN', () => assert.equal(tls.checkServerIdentity('database.example.invalid',{subjectaltname:'DNS:other.example.invalid'}).code,'ERR_TLS_CERT_ALTNAME_INVALID'));
for (const code of ['HANDSHAKE_SSL_ERROR','HANDSHAKE_NO_SSL_SUPPORT','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) test('TLS diagnostic is safe and recognizable: '+code, () => {
  const original=Object.assign(Error('password secret certificate details'),{code,sql:'private SQL'}),safe=sanitizedDatabaseTlsError(original);assert.equal(safe.code,code);assert.equal(safe.fatal,true);assert.equal(safe.sql,undefined);const logs=[];diagnostic('db_tls_failed',safe,s=>logs.push(s));assert.ok(logs[0].includes(code));assert.ok(!JSON.stringify(safe).includes('secret'));assert.ok(!safe.message.includes('password'));
  const response={status(n){this.statusCode=n;return this;},json(body){this.body=body;}};const warn=console.warn;console.warn=()=>{};try{operationalError(safe,{},response,()=>assert.fail());}finally{console.warn=warn;}assert.equal(response.statusCode,503);assert.equal(response.body.code,'SERVICE_UNAVAILABLE');
});
test('non-TLS errors are left for existing transaction/recovery handling', () => assert.equal(sanitizedDatabaseTlsError(Object.assign(Error('fixture'),{code:'ECONNRESET'})),null));

function actualPool(env, failure) {
  let options, calls=0;const logs=[];
  const raw={on(){},getConnection(cb){calls++;cb(failure,{release(){}});},promise(){return {query:()=>new Promise((resolve,reject)=>raw.getConnection(e=>e?reject(e):resolve([[]]))),execute:()=>Promise.resolve([[]])};}};
  const context={__dirname:path.join(__dirname,'../config'),module:{exports:{}},global:{},process:{env,on(){}},console:{log(){},warn:s=>logs.push(s)},require(id){if(id==='dotenv')return{config(){}};if(id==='node:path')return path;if(id==='mysql2')return{createPool(value){options=value;return raw;}};if(id==='../src/operations/requestDiagnostics')return {...require(id),diagnostic:(event,error)=>require(id).diagnostic(event,error,s=>logs.push(s))};if(id.startsWith('../src/operations/'))return require(id);throw Error('Unexpected import');}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../config/db.js'),'utf8'),context);
  return {options,db:context.module.exports,logs,calls:()=>calls};
}
test('actual pool initialization uses verified TLS in production', () => {const f=actualPool(production);assert.equal(f.options.ssl.rejectUnauthorized,true);assert.equal(f.options.ssl.verifyIdentity,true);assert.equal(f.options.connectTimeout,10000);});
test('actual pool initialization leaves local development compatible', () => assert.equal(actualPool({NODE_ENV:'development'}).options.ssl,undefined));
test('actual pool rejects production plaintext before connection creation', () => assert.throws(()=>actualPool({...production,DB_TLS_MODE:'disabled'}),{code:'DB_TLS_CONFIG'}));
test('actual pool sanitizes TLS acquisition errors and never retries the SELECT', async () => {const f=actualPool(production,Object.assign(Error('private certificate and credentials'),{code:'HANDSHAKE_SSL_ERROR'}));await assert.rejects(f.db.query('SELECT 1'),e=>e.code==='HANDSHAKE_SSL_ERROR'&&!e.message.includes('private'));assert.equal(f.calls(),1);assert.ok(f.logs.some(s=>s.includes('db_tls_failed')));assert.ok(f.logs.every(s=>!s.includes('credentials')));});
