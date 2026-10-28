const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { probeDatabaseNetwork } = require('../src/operations/databaseNetworkProbe');

async function runServer(handler, action) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await action(server.address().port); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('probe waits for a MySQL greeting and never sends credentials or queries', async () => {
  let received = 0;
  await runServer(socket => {
    socket.on('data', data => { received += data.length; });
    socket.write(Buffer.from([1, 0, 0, 0]));
    setImmediate(() => socket.write(Buffer.from([10])));
  }, async port => {
    const logs = [];
    await probeDatabaseNetwork({ host: 'localhost', port, log: line => logs.push(JSON.parse(line)) });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].result, 'connected');
    assert.equal(logs[0].address, '127.0.0.1');
    assert.equal(logs[0].stage, 'mysql_greeting');
    assert.ok(Number.isFinite(Date.parse(logs[0].timestamp)));
  });
  assert.equal(received, 0);
});

test('probe distinguishes an accepted TCP connection with no MySQL response', async () => {
  await runServer(() => {}, async port => {
    let result;
    await probeDatabaseNetwork({ host: '127.0.0.1', port, timeoutMs: 100, log: line => { result = JSON.parse(line); } });
    assert.equal(result.stage, 'mysql_greeting');
    assert.equal(result.code, 'PROBE_TIMEOUT');
  });
});

test('probe reports invalid DNS and missing configuration without raw errors', async () => {
  const logs = [];
  await probeDatabaseNetwork({ host: 'database.invalid', log: line => logs.push(JSON.parse(line)) });
  await probeDatabaseNetwork({ log: line => logs.push(JSON.parse(line)) });
  assert.equal(logs[0].stage, 'dns');
  assert.equal(logs[0].code, 'ENOTFOUND');
  assert.equal(logs[1].code, 'DB_HOST_MISSING');
  assert.equal(logs[0].stack, undefined);
});
