const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const verifyToken = require('../src/modules/authentication/authentication.middleware');
const requireAdmin = require('../src/modules/authentication/requireAdmin.middleware');
const secret = randomBytes(32).toString('hex');
const previous = process.env.JWT_SECRET;
process.env.JWT_SECRET = secret;
test.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });

function check(payload, options = {}, key = secret) {
  const token = jwt.sign(payload, key, options);
  const req = { cookies: { token } };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  let accepted = false;
  verifyToken(req, res, () => { accepted = true; });
  return { accepted, req, res };
}

for (const role of ['ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT', 'admin', 'AdMiN', 'teacher']) {
  for (const userId of [101, '101']) test(`valid expiring HS256 session preserves ${role}/${typeof userId}`, () => {
    const r = check({ userId, role }, { expiresIn: '1h' });
    assert.equal(r.accepted, true);
    assert.equal(r.req.user.userId, userId);
    assert.equal(r.req.user.role, role);
  });
}

const invalid = [
  { id: 101, role: 'ADMIN' }, { userId: 101 }, { userId: 101, role: 'OWNER' },
  { userId: 101, role: ['ADMIN'] }, { userId: 101, role: ' ADMIN ' },
  { userId: 101, role: 'ADMIN', purpose: 'password_reset' },
  ...[0, -1, 1.5, '01', '', {}, [], true, Number.MAX_SAFE_INTEGER + 1].map(userId => ({ userId, role: 'ADMIN' })),
];
for (const claims of invalid) test(`malformed session denied before Admin handler: ${JSON.stringify(claims)}`, () => {
  const r = check(claims, { expiresIn: '1h' });
  let reached = false;
  if (r.accepted) requireAdmin(r.req, r.res, () => { reached = true; });
  assert.equal(reached, false);
  assert.equal(r.accepted, false);
  assert.equal(r.res.code, 403);
  assert.deepEqual(r.res.body, { message: 'Invalid or expired token.' });
});
for (const options of [{}, { noTimestamp: true, expiresIn: '1h' }, { expiresIn: -1 }, { expiresIn: '1h', algorithm: 'HS384' }, { expiresIn: '1h', algorithm: 'HS512' }]) {
  test(`incomplete/expired/unexpected algorithm session rejected: ${JSON.stringify(options)}`, () => {
    assert.equal(check({ userId: 101, role: 'ADMIN' }, options).accepted, false);
  });
}
test('wrong signature and signed string payload are rejected', () => {
  assert.equal(check({ userId: 101, role: 'ADMIN' }, { expiresIn: '1h' }, randomBytes(32).toString('hex')).accepted, false);
  assert.equal(check('ADMIN').accepted, false);
});
