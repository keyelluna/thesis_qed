const { createHash } = require('node:crypto');

// Deployment-neutral core. NOT mounted on /login until a shared atomic store,
// account normalization and trusted client-IP resolver are verified/approved.
function createLoginThrottle({ store, normalizeAccount, resolveClientIp }) {
  if (!store || typeof store.reserve !== 'function' || typeof store.complete !== 'function' ||
      typeof normalizeAccount !== 'function' || typeof resolveClientIp !== 'function') {
    throw new TypeError('Verified store, account normalizer and client-IP resolver are required.');
  }
  const windowMs = 15 * 60 * 1000;
  const digest = value => createHash('sha256').update(value).digest('hex');
  return {
    async begin(req, userName) {
      const account = normalizeAccount(userName);
      const ip = resolveClientIp(req);
      if (typeof account !== 'string' || !account || account.length > 512 || typeof ip !== 'string' || !ip || ip.length > 64) {
        throw new TypeError('Cannot throttle an unverified account or client identity.');
      }
      // Store contract: reserve both buckets atomically, counting in-flight
      // attempts; no partial IP increment when the account is already denied.
      const reservation = await store.reserve([
        { key: 'login:account:' + digest(account), limit: 10 },
        { key: 'login:ip:' + digest(ip), limit: 100 },
      ], windowMs);
      if (!reservation || typeof reservation.allowed !== 'boolean') throw new TypeError('Invalid throttle-store response.');
      if (!reservation.allowed) {
        if (!Number.isFinite(reservation.retryAfterMs) || reservation.retryAfterMs <= 0 || reservation.retryAfterMs > windowMs) throw new TypeError('Invalid throttle-store expiry.');
        return { allowed: false, retryAfterSeconds: Math.ceil(reservation.retryAfterMs / 1000) };
      }
      if (reservation.token === undefined || reservation.token === null) throw new TypeError('Missing throttle reservation.');
      let completion;
      return {
        allowed: true,
        async complete(authenticated) {
          if (typeof authenticated !== 'boolean') throw new TypeError('Explicit authentication outcome required.');
          // Success resets that account's failed count, never the shared IP's
          // other failures. Store tokens must be single-use across processes.
          if (!completion) completion = Promise.resolve().then(() => store.complete(reservation.token, { authenticated }))
            .catch(error => { completion = undefined; throw error; });
          await completion;
        },
      };
    },
  };
}

module.exports = { createLoginThrottle };
