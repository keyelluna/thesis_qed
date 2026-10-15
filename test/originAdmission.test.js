const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const { createServer } = require('node:http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { approvedOrigins, httpOriginAllowed, socketOriginAllowed, requireMutationOrigin } = require('../src/security/originPolicy');
const { initSocket } = require('../socket');
const good = 'https://qed-front-end-6upk.vercel.app';
const bad = 'https://unapproved.example.invalid';

test('production, unset, and test modes allow only the confirmed production domain', () => {
  for (const mode of ['production', 'test', undefined]) {
    assert.deepEqual(approvedOrigins(mode), [good]);
    assert.equal(httpOriginAllowed({ origin: 'http://localhost:5173' }, mode), false);
  }
  assert.equal(httpOriginAllowed({ origin: 'http://localhost:5173' }, 'development'), true);
});
for (const origin of [bad, 'null', '', good + '/', good + '.evil.invalid', good + ':443', good + '/path', 'https://preview.vercel.app', 'not a URL', ['https://qed-front-end-6upk.vercel.app']]) {
  test(`reject malformed/unapproved Origin without Referer rescue: ${JSON.stringify(origin)}`, () => {
    assert.equal(httpOriginAllowed({ origin, referer: good + '/admin' }, 'production'), false);
    assert.equal(socketOriginAllowed({ origin }, 'production'), false);
  });
}
test('missing Origin uses a trusted Referer only for HTTP, and absence fails closed', () => {
  assert.equal(httpOriginAllowed({ referer: good + '/admin?tab=users' }, 'production'), true);
  for (const referer of [undefined, 'null', bad + '/', 'https://user:password@qed-front-end-6upk.vercel.app/']) {
    assert.equal(httpOriginAllowed({ referer }, 'production'), false);
  }
  assert.equal(socketOriginAllowed({ referer: good + '/' }, 'production'), false);
});

let server, base, effects = 0, io, oldSecret, oldEnvironment;
test.before(async () => {
  oldEnvironment = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  oldSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const app = express();
  app.use(cors({ origin: approvedOrigins(), credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.use('/api', requireMutationOrigin, express.urlencoded({ extended: true }), express.json());
  app.all('/api/synthetic', (req, res) => { effects++; res.json({ success: true }); });
  server = createServer(app); io = initSocket(server, approvedOrigins());
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => io.close(resolve));
  if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  if (oldEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnvironment;
});

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${method} approved browser allowed, unapproved/missing rejected before handler`, async () => {
  for (const origin of [good, bad, 'null', undefined]) {
    const before = effects;
    const r = await fetch(base + '/api/synthetic', { method, headers: { Cookie: 'token=synthetic', 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}) }, body: 'score=1' });
    assert.equal(r.status, origin === good ? 200 : 403);
    assert.equal(effects - before, origin === good ? 1 : 0);
  }
});
test('trusted Referer fallback and public GET preserve access; cookie GET requires admission', async () => {
  assert.equal((await fetch(base + '/api/synthetic', { method: 'POST', headers: { Referer: good + '/admin' } })).status, 200);
  assert.equal((await fetch(base + '/api/synthetic')).status, 200);
  assert.equal((await fetch(base + '/api/synthetic', { headers: { Cookie: 'token=synthetic' } })).status, 403);
  assert.equal((await fetch(base + '/api/synthetic', { headers: { Cookie: 'token=synthetic', Origin: good } })).status, 200);
});
test('credentialed preflight preserves CORS headers without invoking mutation handler', async () => {
  const before = effects;
  const r = await fetch(base + '/api/synthetic', { method: 'OPTIONS', headers: { Origin: good, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), good);
  assert.equal(r.headers.get('access-control-allow-credentials'), 'true'); assert.equal(effects, before);
});
for (const origin of [good, bad, 'null', undefined]) test(`real Socket.IO polling handshake origin: ${origin}`, async () => {
  const r = await fetch(base + '/socket.io/?EIO=4&transport=polling', { headers: origin ? { Origin: origin } : {} });
  assert.equal(r.status, origin === good ? 200 : 403);
  if (origin === good) assert.match(await r.text(), /^0\{/);
});

async function connect(origin, claims, algorithm = 'HS256') {
  const token = jwt.sign(claims, process.env.JWT_SECRET, { algorithm, expiresIn: '1m' });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket', { headers: { ...(origin === undefined ? {} : { Origin: origin }), Cookie: 'token=' + token } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Synthetic socket handshake timeout')); }, 4000);
    function done(result) { clearTimeout(timer); ws.close(); resolve(result); }
    ws.on('unexpected-response', (_req, response) => { response.resume(); done({ status: response.statusCode }); });
    ws.on('error', error => { clearTimeout(timer); reject(error); });
    ws.on('message', bytes => {
      const message = bytes.toString();
      if (message.startsWith('0')) ws.send('40');
      if (message.startsWith('40')) done({ connected: true, rooms: [...io.sockets.sockets.values()].map(s => [...s.rooms]) });
      if (message.startsWith('44')) done({ connected: false });
    });
  });
}
for (const origin of [bad, 'null', undefined]) test(`real WebSocket rejects ${origin} even with a signed session`, async () => {
  // Engine.IO serializes allowRequest rejection as 403 for polling, 400 for upgrades.
  assert.equal((await connect(origin, { userId: 101, role: 'PARENT' })).status, 400);
});
for (const role of ['ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT']) test(`approved WebSocket ${role} retains only its authenticated user room`, async () => {
  const r = await connect(good, { userId: 101, role });
  assert.equal(r.connected, true);
  assert.ok(r.rooms.some(rooms => rooms.includes('user:101')));
  assert.ok(r.rooms.every(rooms => !rooms.includes('user:202')));
});
for (const claims of [{ id: 101, role: 'ADMIN' }, { userId: 101, role: 'PARENT', purpose: 'password_reset' }]) test(`approved-origin WebSocket still rejects invalid claims: ${JSON.stringify(claims)}`, async () => {
  assert.equal((await connect(good, claims)).connected, false);
});
test('approved-origin WebSocket rejects HS384 sessions', async () => {
  assert.equal((await connect(good, { userId: 101, role: 'ADMIN' }, 'HS384')).connected, false);
});
