const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const verify = require('../src/modules/authentication/authentication.middleware');
const { validSessionClaims } = require('../src/modules/authentication/sessionClaims');
const secret = randomBytes(32).toString('hex');
const previous = process.env.JWT_SECRET;
let server, base, reached = 0;
test.before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express(); app.use(cookieParser());
  app.all('/protected/:role', verify, (req, res) => {
    if (req.user.role.toUpperCase() !== req.params.role) return res.status(403).json({ message: 'Forbidden role.' });
    reached++; res.json({ role: req.user.role });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { reached = 0; process.env.JWT_SECRET = secret; });
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
});
async function request(role, token, method = 'GET') {
  const response = await fetch(`${base}/protected/${role}`, { method, headers: token ? { Cookie: `token=${token}` } : {} });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
}
for (const role of ['ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT']) {
  for (const kind of ['missing', 'expired', 'invalid', 'wrong-signature', 'not-active', 'wrong-algorithm', 'invalid-claims']) {
    test(`F07 ${role}: ${kind} is 401 before protected reads or writes without deleting cookies`, async () => {
      const token = kind === 'missing' ? undefined : kind === 'invalid' ? 'invalid'
        : jwt.sign({ userId: 101, role, ...(kind === 'expired' ? { iat: Math.floor(Date.now() / 1000) - 120 } : {}), ...(kind === 'invalid-claims' ? { purpose: 'password_reset' } : {}) }, kind === 'wrong-signature' ? randomBytes(32).toString('hex') : secret,
          { expiresIn: kind === 'expired' ? 60 : '1h', ...(kind === 'not-active' ? { notBefore: '1h' } : {}), ...(kind === 'wrong-algorithm' ? { algorithm: 'HS384' } : {}) });
      if (kind === 'expired') {
        assert.equal(validSessionClaims(jwt.decode(token)), true, 'Expired fixture must otherwise have valid session claims');
        assert.throws(() => jwt.verify(token, secret), { name: 'TokenExpiredError' });
      }
      for (const method of ['GET', 'POST']) {
        const r = await request(role, token, method);
        assert.equal(r.status, 401);
        assert.deepEqual(r.body, { message: kind === 'missing' ? 'No token provided.' : 'Invalid or expired token.' });
        assert.equal(r.cookie, null); assert.equal(reached, 0);
      }
    });
  }
  test(`F07 ${role}: valid identity succeeds and other roles receive 403 without cookie deletion`, async () => {
    const token = jwt.sign({ userId: 101, role }, secret, { expiresIn: '1h' });
    const allowed = await request(role, token); assert.equal(allowed.status, 200); assert.equal(reached, 1);
    for (const other of ['ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT'].filter(r => r !== role)) {
      const denied = await request(other, token); assert.equal(denied.status, 403);
      assert.deepEqual(denied.body, { message: 'Forbidden role.' }); assert.equal(denied.cookie, null);
    }
    assert.equal(reached, 1);
  });
}
test('F07 missing verifier key is a recoverable server failure, not invalid credentials', async () => {
  const token = jwt.sign({ userId: 101, role: 'ADMIN' }, secret, { expiresIn: '1h' });
  delete process.env.JWT_SECRET;
  const result = await request('ADMIN', token);
  assert.equal(result.status, 500); assert.equal(result.cookie, null); assert.equal(reached, 0);
});
