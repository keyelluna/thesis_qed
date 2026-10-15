const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { actorFromRequest } = require('../src/modules/shared/audit/auditActor');
const secret = randomBytes(32).toString('hex'), previous = process.env.JWT_SECRET;
process.env.JWT_SECRET = secret;
test.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
function request(claims, options = { expiresIn: '1h' }) {
  return { cookies: { token: jwt.sign(claims, secret, options) } };
}
for (const role of ['ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT', 'teacher']) test(`audit preserves normal ${role} actor`, () => {
  assert.deepEqual(actorFromRequest(request({ userId: '101', userName: 'synthetic', role })), { userId: '101', userName: 'synthetic', role });
});
for (const claims of [{ id: 101, role: 'ADMIN' }, { userId: 101, role: 'ADMIN', purpose: 'password_reset' }, { userId: 101 }, { userId: 0, role: 'ADMIN' }]) test(`invalid claims cannot impersonate an audit actor: ${JSON.stringify(claims)}`, () => {
  assert.equal(actorFromRequest(request(claims)), null);
});
for (const options of [{}, { expiresIn: -1 }, { expiresIn: '1h', algorithm: 'HS384' }, { expiresIn: '1h', algorithm: 'HS512' }]) test(`audit rejects incomplete/expired/unexpected algorithm: ${JSON.stringify(options)}`, () => {
  assert.equal(actorFromRequest(request({ userId: 101, role: 'ADMIN' }, options)), null);
});
test('incomplete req.user and missing/malformed cookie remain anonymous', () => {
  assert.equal(actorFromRequest({ user: { userId: 101, role: 'ADMIN' } }), null);
  assert.equal(actorFromRequest({ cookies: { token: 'invalid' } }), null);
});
