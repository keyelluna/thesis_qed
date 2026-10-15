// Opt-in real MySQL verification. Never imports production config/db.js.
const path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.test.local'), quiet: true });
const { localTestTarget } = require('./target.cjs');
const target = localTestTarget(process.env);
const net = require('node:net'), originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (!options || typeof options !== 'object' || options.host !== '127.0.0.1' || Number(options.port) !== 3307) throw new Error('Synthetic integration network guard rejected a non-fixture connection.');
  return originalConnect.apply(this, args);
};
const mysql = require('mysql2/promise');
const pool = mysql.createPool(target);
function inject(file, exports) { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; }
async function main() {
  const [[identity]] = await pool.query('SELECT DATABASE() AS db'); assert.equal(identity.db, 'qed_release_test');
  const [engines] = await pool.query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  for (const table of ['qed_authentication','admin_table','teacher_table','principal_table','parent_table']) assert.ok(engines.some(r => r.TABLE_NAME === table && r.ENGINE === 'InnoDB'));
  const a = await pool.getConnection(), b = await pool.getConnection();
  try {
    assert.equal(Number((await a.query("SELECT GET_LOCK('qed:synthetic-lock',0) AS ok"))[0][0].ok), 1);
    assert.equal(Number((await b.query("SELECT GET_LOCK('qed:synthetic-lock',0) AS ok"))[0][0].ok), 0);
    await a.query("SELECT RELEASE_LOCK('qed:synthetic-lock')");
    assert.equal(Number((await b.query("SELECT GET_LOCK('qed:synthetic-lock',0) AS ok"))[0][0].ok), 1);
    await b.query("SELECT RELEASE_LOCK('qed:synthetic-lock')");
  } finally { a.release(); b.release(); }
  inject('../../../config/db', pool);
  inject('../../../src/services/mailer.service', { sendCredentialsEmail: async () => ({ sent: true }) });
  const { provisionAccount } = require('../../../src/modules/admin/user-record/provisionAccount.controller');
  const unique = crypto.randomBytes(8).toString('hex');
  const body = { role: 'TEACHER', firstName: 'Synthetic' + unique, lastName: 'Release', middleName: '', email: unique + '@example.invalid', contactNumber: '00000000000', status: 'Active', gender: 'Female' };
  const response = () => ({ status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } });
  const responses = await Promise.all([0, 1].map(async () => { const res = response(); await provisionAccount({ body }, res); return res; }));
  assert.deepEqual(responses.map(r => r.code).sort(), [201, 409]);
  const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM qed_authentication WHERE user_name = ?', [(body.firstName + '.' + body.lastName).toLowerCase()]);
  assert.equal(Number(count.n), 1);
  // A dedicated connection keeps every grade fixture and write inside rollback.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const insert = async (table, data) => (await conn.query(`INSERT INTO ${mysql.escapeId(table)} SET ?`, data))[0].insertId;
    const year = await insert('school_year', { school_year: 'Synthetic ' + unique, is_active: 0 });
    const period = await insert('grading_periods', { school_year_id: year, term_number: 1, term_label: 'Synthetic', start_date: '2000-01-01', end_date: '2000-01-02' });
    const student = await insert('elem_students', { section_id: 987654, grade_level_id: 1, current_school_year_id: year });
    await insert('grade_visibility', { student_id: student, grading_period_id: period, is_visible: 1 });
    inject('../../../config/db', { execute: conn.execute.bind(conn), query: conn.query.bind(conn) });
    const { getSingleTermVisibility } = require('../../../src/modules/parents/Student-Record/ProgressReport/progressVisibility.controller');
    assert.equal((await getSingleTermVisibility(student, period)).available, false);
    await insert('grade_submissions', { section_id: 987654, grading_period_id: period, submitted_by: 1 });
    assert.equal((await getSingleTermVisibility(student, period)).available, true);
    await conn.query('UPDATE grade_visibility SET is_visible=0 WHERE student_id=? AND grading_period_id=?', [student, period]);
    assert.equal((await getSingleTermVisibility(student, period)).available, false);
    await conn.rollback();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  console.log(JSON.stringify({ syntheticTarget: true, engines: 'passed', namedLockIsolation: 'passed', atomicConcurrentProvisioning: 'passed', formalReleaseSql: 'passed', emailProviderUsed: false, retainedSyntheticAccounts: 1 }));
}
main().catch(() => { console.error('Synthetic MySQL integration failed; details withheld. Inspect the disposable fixture privately.'); process.exitCode = 1; }).finally(() => pool.end());
