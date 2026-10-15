const test = require('node:test');
const assert = require('node:assert/strict');
const { localTestTarget } = require('../scripts/testing/mysql/target.cjs');
const valid = { QED_TEST_MYSQL_CONFIRM: 'SYNTHETIC_LOCAL_ONLY', QED_TEST_MYSQL_HOST: '127.0.0.1', QED_TEST_MYSQL_PORT: '3307', QED_TEST_MYSQL_DATABASE: 'qed_release_test', QED_TEST_MYSQL_USER: 'qed_test', QED_TEST_MYSQL_PASSWORD: 'synthetic-fixture-only' };
test('allows only the explicitly named disposable loopback target', () => {
  const result = localTestTarget(valid); assert.equal(result.host, '127.0.0.1'); assert.equal(result.database, 'qed_release_test');
});
for (const [key, value] of [['QED_TEST_MYSQL_HOST', 'production.example.invalid'], ['QED_TEST_MYSQL_HOST', 'localhost'], ['QED_TEST_MYSQL_PORT', '3306'], ['QED_TEST_MYSQL_DATABASE', 'qed'], ['QED_TEST_MYSQL_USER', 'root'], ['QED_TEST_MYSQL_CONFIRM', ''], ['QED_TEST_MYSQL_PASSWORD', '']]) test(`rejects unsafe local-test target field ${key}`, () => {
  assert.throws(() => localTestTarget({ ...valid, [key]: value }), /Refusing unapproved target/);
});
test('production DB variables cannot substitute for explicit test configuration', () => {
  assert.throws(() => localTestTarget({ DB_HOST: '127.0.0.1', DB_NAME: 'qed_release_test', DB_PASSWORD: 'synthetic-only' }), /Refusing/);
});
