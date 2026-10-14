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
