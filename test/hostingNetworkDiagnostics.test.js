const test = require('node:test');
const assert = require('node:assert/strict');
const { runHostingNetworkDiagnostics } = require('../src/operations/hostingNetworkDiagnostics');

test('support diagnostics count mixed outcomes, space attempts, and label public IP scope', async () => {
  const logs = [], targets = [], pauses = [];
  let active = 0, attempts = 0;
  await runHostingNetworkDiagnostics({ host: 'database.invalid', port: 3306, log: line => logs.push(JSON.parse(line)) }, {
    httpsCheck: async (url, options) => {
      targets.push(url);
      return options?.readIp ? { result: 'connected', publicIp: '192.0.2.1' } : { result: 'connected', status: 403 };
    },
    pause: async ms => pauses.push(ms),
    probe: async ({ host, port, log }) => {
      assert.equal(++active, 1);
      assert.equal(host, 'database.invalid');
      assert.equal(port, 3306);
      await Promise.resolve();
      attempts++;
      log(JSON.stringify({ event: 'db_network_probe', result: attempts % 2 ? 'failed' : 'connected' }));
      active--;
    },
  });
  assert.deepEqual(targets, ['https://api.ipify.org', 'https://cornflowerblue-sheep-255178.hostingersite.com']);
  assert.equal(logs[0].sourceIpScope, 'ipify_https_only');
  assert.equal(logs[1].status, 403);
  assert.deepEqual(pauses, Array(9).fill(2000));
  assert.deepEqual(logs.filter(row => row.event === 'db_network_probe').map(row => row.attempt), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(logs.at(-1).successes, 5);
  assert.equal(logs.at(-1).failures, 5);
});
