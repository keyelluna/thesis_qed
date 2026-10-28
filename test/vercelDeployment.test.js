const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.join(__dirname, '../server.js'));
const express = require('express');
const { databaseTlsOptions } = require('../src/operations/databaseTls');

test('Vercel exports a working HTTP app without listeners, sockets, or startup DDL', async () => {
  const appModule = { exports: {} };
  const forbidden = () => { throw new Error('Unexpected startup side effect'); };
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  function load(id) {
    if (id === './config/db.js') return {};
    if (id === 'dotenv') return { config() {} };
    if (id === 'http') return { createServer: forbidden };
    if (id === './socket.js') return { initSocket: forbidden };
    if (id === './src/routes/index.js') return express.Router();
    if (id === './src/modules/shared/audit/auditLog.service.js') return {
      auditMutationRequests: (_req, _res, next) => next(), ensureAuditLogTable: forbidden,
    };
    return serverRequire(id);
  }
  load.main = appModule;
  vm.runInNewContext(source, {
    require: load, module: appModule, __dirname: path.join(__dirname, '..'),
    process: { env: { VERCEL: '1', NODE_ENV: 'production' } }, console,
  });
  assert.equal(typeof appModule.exports, 'function');
  const listener = appModule.exports.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'healthy');
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

test('Vercel requires verified database TLS even if NODE_ENV is absent', () => {
  const env = { VERCEL: '1', DB_HOST: 'database.example.com' };
  assert.equal(databaseTlsOptions(env).verifyIdentity, true);
  assert.throws(() => databaseTlsOptions({ ...env, DB_TLS_MODE: 'disabled' }), { code: 'DB_TLS_CONFIG' });
});

test('deployment includes runtime SQL/assets and excludes local environment files', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json')));
  assert.equal(config.functions['server.js'].maxDuration, 60);
  assert.match(config.functions['server.js'].includeFiles, /scripts\/\*\*/);
  assert.match(config.functions['server.js'].includeFiles, /src\/assets\/\*\*/);
  const ignore = fs.readFileSync(path.join(__dirname, '../.vercelignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('.env'));
  assert.ok(ignore.includes('.env.*'));
});
