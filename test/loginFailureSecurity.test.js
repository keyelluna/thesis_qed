const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { validSessionClaims } = require('../src/modules/authentication/sessionClaims');
// Execute the actual login function only; model/mail/DDL imports never run.
const source = fs.readFileSync(require.resolve('../src/modules/authentication/authentication.controller'), 'utf8');
const code = source.match(/exports\.login\s*=\s*async\s*\(req, res\)\s*=>\s*\{[\s\S]*?^\};/m)?.[0];
assert.ok(code);
const secret = randomBytes(32).toString('hex');
let hash;
test.before(async () => { hash = await bcrypt.hash('Synthetic123!', 4); });
async function login(condition, ...inputs) {
  const body = inputs.length ? inputs[0] : { userName: 'synthetic', password: 'Synthetic123!' };
  const writes = [], exported = {};
  const connection = { async execute(sql) {
    if (sql.includes('FROM qed_authentication')) return [condition === 'unknown' ? [] : [{ id: 101, user_name: 'synthetic', role: 'PARENT', password: hash }]];
    if (sql.includes('FROM parent_table')) return [condition === 'no-profile' ? [] : [{ name: 'Synthetic', status: condition === 'inactive' ? 'Inactive' : 'Active', is_deleted: condition === 'deleted' ? 1 : 0 }]];
    writes.push(sql); return [{}];
  } };
  vm.runInNewContext(code, { exports: exported, connection, bcrypt, jwt, JWT_SECRET: secret, JWT_EXPIRES_IN: '1h', ROLE_TABLES: { parent: 'parent_table' }, genderColumnForRole: async () => 'NULL', avatarKeyColumnForRole: async () => 'NULL', recordAuditEvent: async () => {}, process: { env: { NODE_ENV: 'production' } }, console });
  const res = { status(n) { this.code = n; return this; }, json(value) { this.body = value; return this; }, cookie(name, value, options) { this.session = { name, value, options }; return this; } };
  await exported.login({ body, get: () => 'synthetic' }, res);
  return { res, writes };
}
for (const condition of ['unknown', 'wrong-password', 'no-profile', 'inactive', 'deleted']) test(`generic denial preserves status and issues no cookie: ${condition}`, async () => {
  const { res, writes } = await login(condition, { userName: 'synthetic', password: condition === 'wrong-password' ? 'wrong' : 'Synthetic123!' });
  assert.equal(res.code, ['no-profile', 'inactive', 'deleted'].includes(condition) ? 403 : 401);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { message: 'Invalid credentials' });
  assert.equal(res.session, undefined); assert.equal(writes.length, 0);
});
for (const body of [undefined, {}, { userName: [], password: {} }, { userName: 'synthetic', password: '' }]) test(`malformed login fails without database writes: ${JSON.stringify(body)}`, async () => {
  const { res, writes } = await login('valid', body);
  assert.equal(res.code, 401); assert.equal(writes.length, 0); assert.equal(res.session, undefined);
});
test('valid login preserves secure cookie, HS256 session and normal user response', async () => {
  const { res } = await login('valid');
  assert.equal(res.code, 200); assert.equal(res.session.name, 'token');
  assert.equal(res.session.options.httpOnly, true); assert.equal(res.session.options.secure, true);
  assert.equal(res.session.options.sameSite, 'none'); assert.equal(res.session.options.maxAge, 3600000);
  const claims = jwt.verify(res.session.value, secret, { algorithms: ['HS256'] });
  assert.equal(validSessionClaims(claims), true); assert.equal(claims.userId, 101);
  assert.equal(res.body.user.role, 'PARENT');
});
