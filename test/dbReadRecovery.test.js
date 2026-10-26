const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../config/db.js'), 'utf8');
function fixture(failures) {
  const calls = [];
  const pool = Object.fromEntries(['query', 'execute'].map(method => [method, async (...args) => {
    calls.push({ method, args });
    if (failures.length) throw Object.assign(new Error('DB failure'), { code: failures.shift() });
    return [[{ count: 7 }]];
  }]));
  const context = { __dirname: path.join(__dirname, '../config'), module: { exports: {} }, global: {}, process: { env: {}, on() {} },
    console: { log() {}, warn() {}, error() {} },
    require(name) { if (name === '../src/operations/databaseTls') return require('../src/operations/databaseTls'); if (name === 'node:path') return path; if (name === '../src/operations/requestDiagnostics') return require('../src/operations/requestDiagnostics'); if (name === '../src/operations/databaseReliability') return require('../src/operations/databaseReliability'); if (name === 'dotenv') return { config() {} }; assert.equal(name, 'mysql2'); return { createPool: () => ({ on() {}, getConnection() {}, promise: () => pool }) }; } };
  vm.runInNewContext(source, context);
  return { db: context.module.exports, calls };
}
for (const method of ['query', 'execute']) {
  for (const code of ['ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'EPIPE']) {
    test(`${method} recovers a disconnected SELECT (${code}) with parameters intact`, async () => {
      const { db, calls } = fixture([code]);
      const args = ['SELECT COUNT(*) FROM teacher_table WHERE user_id = ?', [17]];
      assert.deepEqual(await db[method](...args), [[{ count: 7 }]]);
      assert.equal(calls.length, 2);
      calls.forEach(call => assert.deepEqual(call.args, args));
    });
  }
  test(`${method} retries at most once`, async () => {
    const { db, calls } = fixture(['ECONNRESET', 'EPIPE']);
    await assert.rejects(db[method]('SELECT 1'), { code: 'EPIPE' });
    assert.equal(calls.length, 2);
  });
  for (const [sql, code] of [['UPDATE teacher_table SET id = 1', 'ECONNRESET'], ['SELECT missing FROM teacher_table', 'ER_BAD_FIELD_ERROR']]) {
    test(`${method} does not retry writes or SQL errors: ${code}`, async () => {
      const { db, calls } = fixture([code]);
      await assert.rejects(db[method](sql), { code });
      assert.equal(calls.length, 1);
    });
  }
}
