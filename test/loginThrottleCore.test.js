const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginThrottle } = require('../src/modules/authentication/loginThrottle');

// Synthetic atomic store only; not a production shared-store implementation.
function fixture() {
  let now = 0, sequence = 0;
  const buckets = new Map(), reservations = new Map();
  const store = {
    async reserve(items, windowMs) {
      for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
      for (const [token, value] of reservations) if (value.until <= now) reservations.delete(token);
      const denied = items.filter(item => {
        const bucket = buckets.get(item.key);
        return bucket && bucket.failed + bucket.pending >= item.limit;
      }).map(item => buckets.get(item.key));
      if (denied.length) return { allowed: false, retryAfterMs: Math.max(...denied.map(b => b.until - now)) };
      const token = ++sequence;
      for (const item of items) { const b = buckets.get(item.key) || { failed: 0, pending: 0, until: now + windowMs }; b.pending++; buckets.set(item.key, b); }
      reservations.set(token, { items, until: now + windowMs });
      return { allowed: true, token };
    },
    async complete(token, { authenticated }) {
      const reservation = reservations.get(token); if (!reservation) return;
      reservations.delete(token);
      for (const item of reservation.items) {
        const b = buckets.get(item.key); if (!b || b.until <= now) continue;
        b.pending--;
        if (!authenticated) b.failed++;
        else if (item.key.startsWith('login:account:')) b.failed = 0;
      }
    },
  };
  const throttle = createLoginThrottle({ store, normalizeAccount: value => value.toLowerCase(), resolveClientIp: req => req.syntheticVerifiedIp });
  return { throttle, buckets, advance: ms => { now += ms; } };
}
test('account throttles after ten failed attempts and expires after fifteen minutes', async () => {
  const f = fixture(), req = { syntheticVerifiedIp: '192.0.2.1' };
  for (let i = 0; i < 10; i++) { const attempt = await f.throttle.begin(req, 'Synthetic'); assert.equal(attempt.allowed, true); await attempt.complete(false); }
  const denied = await f.throttle.begin(req, 'synthetic'); assert.equal(denied.allowed, false); assert.equal(denied.retryAfterSeconds, 900);
  f.advance(900001); assert.equal((await f.throttle.begin(req, 'synthetic')).allowed, true);
});
test('account-specific attacks do not exhaust a shared-school IP bucket on denied requests', async () => {
  const f = fixture(), req = { syntheticVerifiedIp: '192.0.2.1' };
  for (let i = 0; i < 10; i++) await (await f.throttle.begin(req, 'target')).complete(false);
  for (let i = 0; i < 200; i++) assert.equal((await f.throttle.begin(req, 'target')).allowed, false);
  assert.equal((await f.throttle.begin(req, 'another-account')).allowed, true);
});
test('one hundred failures across different accounts trigger IP throttling', async () => {
  const f = fixture(), req = { syntheticVerifiedIp: '192.0.2.1' };
  for (let i = 0; i < 100; i++) await (await f.throttle.begin(req, 'synthetic-' + i)).complete(false);
  assert.equal((await f.throttle.begin(req, 'other')).allowed, false);
  assert.equal((await f.throttle.begin({ syntheticVerifiedIp: '192.0.2.2' }, 'other')).allowed, true);
});
test('in-flight reservations prevent a concurrent burst bypass and settle only once', async () => {
  const f = fixture(), req = { syntheticVerifiedIp: '192.0.2.1' };
  const attempts = await Promise.all(Array.from({ length: 30 }, () => f.throttle.begin(req, 'same')));
  assert.equal(attempts.filter(a => a.allowed).length, 10);
  for (const a of attempts.filter(a => a.allowed)) { await a.complete(false); await a.complete(false); }
  assert.equal((await f.throttle.begin(req, 'same')).allowed, false);
});
test('successful authentication resets the account but preserves other IP failures', async () => {
  const f = fixture(), req = { syntheticVerifiedIp: '192.0.2.1' };
  for (let i = 0; i < 9; i++) await (await f.throttle.begin(req, 'same')).complete(false);
  await (await f.throttle.begin(req, 'same')).complete(true);
  for (let i = 0; i < 9; i++) await (await f.throttle.begin(req, 'same')).complete(false);
  assert.equal((await f.throttle.begin(req, 'same')).allowed, true);
  assert.equal([...f.buckets].find(([key]) => key.startsWith('login:ip:'))[1].failed, 18);
});
test('requires verified collaborators and never falls back to forwarding headers', async () => {
  assert.throws(() => createLoginThrottle({}), TypeError);
  const f = fixture();
  await assert.rejects(() => f.throttle.begin({ headers: { 'x-forwarded-for': '192.0.2.1' } }, 'same'), TypeError);
});
