const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

// Actual controller, template resolver, grade computation and cache service.
// Real isolated SQLite transactions + independent authoritative reader. Only
// MySQL syntax, checkout lifecycle and injected faults are adapted; no school
// DB, environment credentials, notification, workbook or network is accessed.
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qed-assessment-delete-'));
  const filename = path.join(directory, 'synthetic.sqlite');
  const writer = new DatabaseSync(filename);
  const reader = new DatabaseSync(filename);
  writer.function('CONCAT', { varargs: true }, (...values) => values.join(''));
  reader.function('CONCAT', { varargs: true }, (...values) => values.join(''));
  writer.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE school_year(id INTEGER PRIMARY KEY,is_active INTEGER); INSERT INTO school_year VALUES(1,1);
    CREATE TABLE grading_periods(id INTEGER PRIMARY KEY,school_year_id INTEGER,term_number INTEGER); INSERT INTO grading_periods VALUES(5,1,1),(6,1,2);
    CREATE TABLE grade_level(id INTEGER PRIMARY KEY,grade_level TEXT); INSERT INTO grade_level VALUES(1,'Grade 1');
    CREATE TABLE teacher_table(id INTEGER PRIMARY KEY,user_id INTEGER,first_name TEXT,last_name TEXT,is_deleted INTEGER); INSERT INTO teacher_table VALUES(7,77,'Synthetic','Teacher',0),(8,88,'Other','Teacher',0);
    CREATE TABLE elem_subjects(id INTEGER PRIMARY KEY,subject_name TEXT,grade_level_id INTEGER); INSERT INTO elem_subjects VALUES(21,'Math',1);
    CREATE TABLE "subject-section"(id INTEGER PRIMARY KEY,subject_id INTEGER,school_year_id INTEGER,section_id INTEGER,teacher_id INTEGER,status TEXT);
    INSERT INTO "subject-section" VALUES(301,21,1,101,7,'Active'),(302,21,1,102,8,'Active');
    CREATE TABLE grade_level_sections(id INTEGER PRIMARY KEY,section_name TEXT); INSERT INTO grade_level_sections VALUES(101,'A'),(102,'B');
    CREATE TABLE classes(section_id INTEGER,grade_level_id INTEGER,school_year_id INTEGER,class_adviser_id INTEGER,status TEXT); INSERT INTO classes VALUES(101,1,1,7,'Active');
    CREATE TABLE elem_students(id INTEGER PRIMARY KEY,section_id INTEGER,grade_level_id INTEGER,current_school_year_id INTEGER,status TEXT,is_deleted INTEGER);
    INSERT INTO elem_students VALUES(201,101,1,1,'Active',0),(202,101,1,1,'Active',0),(999,102,1,1,'Active',0);
    CREATE TABLE grade_items(id INTEGER PRIMARY KEY,subject_section_id INTEGER,grading_period_id INTEGER,tab TEXT,max_items REAL,exam_type TEXT,template_domain_id TEXT);
    INSERT INTO grade_items VALUES(11,301,5,'writtenWorks',10,NULL,NULL),(12,301,5,'writtenWorks',20,NULL,NULL),(13,301,5,'performanceTask',20,NULL,NULL),(14,301,5,'exams',10,NULL,NULL),(21,302,5,'writtenWorks',10,NULL,NULL),(22,301,6,'writtenWorks',10,NULL,NULL);
    CREATE TABLE grade_scores(item_id INTEGER ${options.cascade === false ? '' : 'REFERENCES grade_items(id) ON DELETE CASCADE'},student_id INTEGER,score REAL,PRIMARY KEY(item_id,student_id));
    INSERT INTO grade_scores VALUES(11,201,10),(12,201,14),(13,201,18),(14,201,8),(11,202,10),(12,202,20),(13,202,20),(14,202,10),(21,999,5),(22,201,7);
    CREATE TABLE subject_grade_templates(id INTEGER PRIMARY KEY,subject_id INTEGER,file_name TEXT,file_path TEXT,storage_key TEXT,checksum_sha256 TEXT,structure_json TEXT,export_map_json TEXT,is_active INTEGER);
    CREATE TABLE subject_grade_template_periods(subject_section_id INTEGER,grading_period_id INTEGER,template_id INTEGER);
    INSERT INTO subject_grade_template_periods VALUES(301,5,1);
    CREATE TABLE subject_grade_cache(student_id INTEGER,subject_section_id INTEGER,grading_period_id INTEGER,average REAL,is_complete INTEGER,PRIMARY KEY(student_id,subject_section_id,grading_period_id));
    INSERT INTO subject_grade_cache VALUES(201,301,5,90,1),(202,301,5,100,1),(999,302,5,77,1),(201,301,6,93,1);
    CREATE TABLE subject_grade_submissions(subject_section_id INTEGER,grading_period_id INTEGER);
    CREATE TABLE advisory_overall_grades(student_id INTEGER,section_id INTEGER,grade_level_id INTEGER,grading_period_id INTEGER,overall_average REAL,PRIMARY KEY(student_id,grading_period_id));
    INSERT INTO advisory_overall_grades VALUES(201,101,NULL,5,90),(202,101,NULL,5,100),(999,102,NULL,5,77),(201,101,NULL,6,93);`);
  const structure = { ww: { weightPercent: 30 }, pt: { weightPercent: 50 }, examWeightPercent: 20,
    transmutationTable: [{ igMin: 0, igMax: 81.99, transmuted: 80 }, { igMin: 82, igMax: 84.99, transmuted: 89 }, { igMin: 85, igMax: 99.99, transmuted: 90 }, { igMin: 100, igMax: 100, transmuted: 100 }] };
  writer.prepare('INSERT INTO subject_grade_templates VALUES(1,21,\'synthetic.xlsx\',\'\',NULL,?,?,NULL,1)').run('a'.repeat(64), JSON.stringify(structure));
  if (options.sectionless) writer.exec('UPDATE "subject-section" SET section_id=NULL WHERE id=301; UPDATE elem_students SET section_id=NULL WHERE id IN(201,202); UPDATE classes SET section_id=NULL; UPDATE advisory_overall_grades SET section_id=NULL,grade_level_id=1 WHERE student_id IN(201,202)');
  if (options.missingSubject) writer.exec('DELETE FROM elem_subjects WHERE id=21');
  if (options.missingPeriod) writer.exec('DELETE FROM grading_periods WHERE id=5');
  let active = false, fail = options.fail, releases = 0, destroys = 0, acquisitions = 0;
  const events = [], calls = [], errors = [];
  const state = () => Object.fromEntries(['grade_items', 'grade_scores', 'subject_grade_cache', 'advisory_overall_grades'].map(table => [table, reader.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).all().map(row => ({ ...row }))]));
  async function execute(sql, parameters = [], source = 'connection') {
    const params = Array.from(parameters, value => typeof value === 'boolean' ? Number(value) : value);
    let query = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: query, params, source });
    if (source === 'connection') assert.equal(active, true, 'all checked-out statements share the transaction');
    if (query.includes('information_schema.TABLES')) return [params.filter(name => name !== options.missingTable).map(tableName => ({ tableName, engine: options.engine || 'InnoDB' }))];
    const phase = query.startsWith('DELETE FROM grade_scores') ? 'scores' : query.startsWith('DELETE FROM grade_items') ? 'item' : query.includes('FROM subject_grade_template_periods p') ? 'template' : query.startsWith('INSERT INTO subject_grade_cache') ? 'cache' : query.startsWith('INSERT INTO advisory_overall_grades') ? 'overall' : '';
    if (fail === phase || (fail === 'second-cache' && phase === 'cache' && params[0] === 202)) throw new Error(`Injected ${fail}`);
    query = query.replace(/ FOR UPDATE$/, ''); // Lock syntax is asserted, not simulated as InnoDB locking.
    const database = source === 'connection' ? writer : reader;
    if (/^SELECT /i.test(query)) return [database.prepare(query).all(...params).map(row => ({ ...row }))];
    if (phase === 'item' && fail === 'item-zero') return [{ affectedRows: 0 }];
    if (query.includes('ON DUPLICATE KEY UPDATE')) {
      const update = phase === 'cache' ? 'ON CONFLICT(student_id,subject_section_id,grading_period_id) DO UPDATE SET average=excluded.average,is_complete=excluded.is_complete' : 'ON CONFLICT(student_id,grading_period_id) DO UPDATE SET overall_average=excluded.overall_average,section_id=excluded.section_id,grade_level_id=excluded.grade_level_id';
      query = query.replace(/ON DUPLICATE KEY UPDATE.*$/, update);
    }
    const result = database.prepare(query).run(...params);
    if (fail === `${phase}-after`) throw new Error(`Injected ${fail}`);
    return [{ affectedRows: Number(result.changes) }];
  }
  const conn = {
    execute, async beginTransaction() { events.push('begin'); if (fail === 'begin') throw Error('begin'); writer.exec('BEGIN'); active = true; if (fail === 'begin-ack') throw Error('begin acknowledgement'); },
    async commit() { events.push('commit'); await options.beforeCommit?.(); if (fail === 'commit-before') throw Error('commit rejected'); writer.exec('COMMIT'); active = false; if (fail === 'commit-ack') throw Error('commit acknowledgement lost'); },
    async rollback() { events.push('rollback'); if (options.rollbackFails) throw Error('rollback rejected'); writer.exec('ROLLBACK'); active = false; },
    release() { events.push('release'); releases++; assert.equal(active, false, 'no open transaction returned to pool'); if (options.releaseFails) throw Error('release rejected'); },
    destroy() { events.push('destroy'); destroys++; if (active) { writer.exec('ROLLBACK'); active = false; } },
  };
  const pool = { execute: (sql, params) => execute(sql, params, 'pool'), async getConnection() { events.push('acquire'); acquisitions++; if (fail === 'acquire') throw Error('acquire'); return conn; } };
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const nativeRequire = createRequire(filename);
    function isolatedRequire(id) {
      if (id.endsWith('config/db')) return pool;
      if (/notification\.service|gradeSubmissionHistory\.service|templateStorage\.service/.test(id)) return new Proxy({}, { get: () => () => { throw Error(`External side effect forbidden: ${id}`); } });
      const resolved = nativeRequire.resolve(id);
      if (resolved.startsWith(path.resolve(__dirname, '../src') + path.sep)) return load(resolved);
      if (id === 'mysql2' || id === 'dotenv') throw Error(`External database configuration forbidden: ${id}`);
      return nativeRequire(id);
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: isolatedRequire, module, exports: module.exports, console: { error: (...args) => errors.push(args) }, Date, Set, Map, Buffer }, { filename });
    return module.exports;
  }
  const controller = load(path.resolve(__dirname, '../src/modules/teacher/gradebook/subjectGrading.controller.js'));
  const response = () => ({ code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } });
  const request = (itemId = 11) => ({ subjectSection: { id: 301 }, params: { subjectSectionId: 301, itemId }, body: {} });
  t.after(() => { if (active) writer.exec('ROLLBACK'); reader.close(); writer.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('qed-assessment-delete-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { controller, state, response, request, events, calls, errors, setFailure: value => { fail = value; }, stats: () => ({ active, releases, destroys, acquisitions }), async remove(req = request()) { const res = response(); await controller.deleteItem(req, res); return res; } };
}

function unchanged(f, before) { assert.deepEqual(f.state(), before); assert.equal(f.stats().active, false); }
function deleted(f, before) {
  const actual = f.state();
  assert.deepEqual(actual.grade_items, before.grade_items.filter(row => row.id !== 11));
  assert.deepEqual(actual.grade_scores, before.grade_scores.filter(row => row.item_id !== 11));
  assert.deepEqual(actual.subject_grade_cache, before.subject_grade_cache.map(row => row.student_id === 201 && row.subject_section_id === 301 && row.grading_period_id === 5 ? { ...row, average: 89 } : row));
  assert.deepEqual(actual.advisory_overall_grades, before.advisory_overall_grades.map(row => row.student_id === 201 && row.grading_period_id === 5 ? { ...row, overall_average: 89 } : row));
}
for (const cascade of [true, false]) for (const sectionless of [true, false]) test(`atomic deletion: success, cascade=${cascade}, sectionless=${sectionless}`, async t => {
  const f = fixture(t, { cascade, sectionless }), before = f.state(); const res = await f.remove();
  assert.equal(res.code, 200, f.errors.map(args => args.map(String).join(' ')).join('\n')); assert.equal(res.body.success, true); deleted(f, before);
  assert.deepEqual(f.events, ['acquire', 'begin', 'commit', 'release']); assert.equal(f.calls.some(c => c.source === 'pool'), false);
  assert.match(f.calls[0].sql, /FROM `subject-section` WHERE id = \? FOR UPDATE$/);
  assert.ok(f.calls.find(c => c.sql.includes('FROM grade_items WHERE id')).sql.endsWith('FOR UPDATE'));
});
for (const fail of ['scores', 'scores-after', 'item', 'item-after', 'template', 'cache', 'cache-after', 'second-cache', 'overall', 'overall-after', 'item-zero']) test(`atomic deletion: ${fail} failure restores scores, assessment and all caches`, async t => {
  const f = fixture(t, { fail }), before = f.state(); const res = await f.remove();
  assert.equal(res.code, fail === 'item-zero' ? 404 : 500); assert.equal(res.body.success, false); unchanged(f, before);
  if (fail !== 'item-zero') assert.ok(f.errors.some(args => args.some(value => String(value).includes(`Injected ${fail}`))), 'the intended injected failure was reached');
  assert.deepEqual(f.events, ['acquire', 'begin', 'rollback', 'release']); assert.equal(f.calls.some(c => c.source === 'pool'), false);
});
test('atomic deletion: required recalculation failure plus rollback failure destroys connection', async t => {
  const f = fixture(t, { fail: 'overall-after', rollbackFails: true }), before = f.state(); const res = await f.remove();
  assert.equal(res.code, 500); unchanged(f, before); assert.deepEqual(f.events, ['acquire', 'begin', 'rollback', 'destroy']); assert.equal(f.stats().releases, 0);
});
for (const options of [{ missingSubject: true }, { missingPeriod: true }]) test(`atomic deletion: missing recalculation context ${JSON.stringify(options)} aborts instead of committing stale grades`, async t => {
  const f = fixture(t, options), before = f.state(); assert.equal((await f.remove()).code, 500); unchanged(f, before);
  assert.ok(f.calls.some(call => call.sql.startsWith('DELETE FROM grade_items')));
  assert.ok(f.errors.some(args => args.some(value => String(value).includes('Cannot recalculate deletion'))));
  assert.deepEqual(f.events, ['acquire', 'begin', 'rollback', 'release']);
});
for (const fail of ['acquire', 'begin', 'begin-ack']) test(`atomic deletion: ${fail} failure cleans up without writes`, async t => {
  const f = fixture(t, { fail }), before = f.state(); const res = await f.remove();
  assert.equal(res.code, 500); unchanged(f, before); assert.equal(f.calls.length, 0);
  assert.equal(f.stats().releases, 0); assert.equal(f.stats().destroys, fail === 'acquire' ? 0 : 1);
});
for (const fail of ['commit-before', 'commit-ack']) test(`atomic deletion: ${fail} reports uncertainty without replay or false rollback claim`, async t => {
  const f = fixture(t, { fail }), before = f.state(); const res = await f.remove();
  assert.equal(res.code, 503); assert.equal(res.body.success, false); assert.equal(res.body.outcome, 'uncertain'); assert.match(res.body.message, /Refresh this class/);
  assert.deepEqual(f.events, ['acquire', 'begin', 'commit', 'destroy']); assert.equal(f.stats().active, false);
  if (fail === 'commit-before') unchanged(f, before); else deleted(f, before);
  // Explicit later attempt sees authoritative state; it is never auto-replayed.
  f.setFailure(undefined); const second = await f.remove(); assert.equal(second.code, fail === 'commit-before' ? 200 : 404); deleted(f, before);
  assert.equal(f.stats().acquisitions, 2);
});
test('atomic deletion: no successful response or durable change before commit', async t => {
  let commitReached, allowCommit; const reached = new Promise(resolve => { commitReached = resolve; }); const gate = new Promise(resolve => { allowCommit = resolve; });
  const f = fixture(t, { beforeCommit: async () => { commitReached(); await gate; } }), before = f.state(), res = f.response();
  const pending = f.controller.deleteItem(f.request(), res);
  try { await Promise.race([reached, pending.then(() => { throw Error(`Controller returned before COMMIT: ${f.errors.map(String).join('\n')}`); })]); assert.equal(res.body, null); assert.deepEqual(f.state(), before); } finally { allowCommit(); }
  await pending; assert.equal(res.code, 200); deleted(f, before);
});
test('atomic deletion: missing or foreign-owned assessment never deletes its scores', async t => {
  const f = fixture(t), before = f.state();
  for (const id of [404, 21]) { const res = await f.remove(f.request(id)); assert.equal(res.code, 404); unchanged(f, before); }
  assert.equal(f.calls.some(c => c.sql.startsWith('DELETE')), false);
});
test('atomic deletion: repeated explicit delete returns 404 without changing other records', async t => {
  const f = fixture(t), before = f.state(); assert.equal((await f.remove()).code, 200); deleted(f, before);
  const once = f.state(); assert.equal((await f.remove()).code, 404); unchanged(f, once);
  assert.equal(f.events.filter(event => event === 'commit').length, 1); assert.equal(f.stats().releases, 2);
});
for (const user of [undefined, { userId: 77, role: 'PARENT' }, { userId: 88, role: 'TEACHER' }]) test(`atomic deletion: existing ownership middleware rejects ${JSON.stringify(user)}`, async t => {
  const f = fixture(t), before = f.state(), res = f.response(); const req = { ...f.request(), user }; let authorized = false;
  await f.controller.loadSubjectSection(req, res, () => { authorized = true; });
  assert.equal(authorized, false); assert.ok([401, 403].includes(res.code)); assert.equal(f.stats().acquisitions, 0); unchanged(f, before);
});
for (const options of [{ engine: 'MyISAM' }, { missingTable: 'grade_scores' }]) test(`atomic deletion: refuses nontransactional or missing tables ${JSON.stringify(options)}`, async t => {
  const f = fixture(t, options), before = f.state(); assert.equal((await f.remove()).code, 500); unchanged(f, before);
  assert.equal(f.calls.some(c => c.sql.startsWith('DELETE')), false); assert.deepEqual(f.events, ['acquire', 'begin', 'rollback', 'release']);
});
test('atomic deletion: release failure destroys connection without undoing committed success', async t => {
  const f = fixture(t, { releaseFails: true }), before = f.state(); assert.equal((await f.remove()).code, 200); deleted(f, before);
  assert.deepEqual(f.events, ['acquire', 'begin', 'commit', 'release', 'destroy']);
});
test('atomic deletion: response delivery failure cannot roll back or replay committed work', async t => {
  const f = fixture(t), before = f.state(), res = f.response(); res.json = () => { throw Error('client disconnected'); };
  await assert.rejects(f.controller.deleteItem(f.request(), res), /client disconnected/); deleted(f, before);
  assert.deepEqual(f.events, ['acquire', 'begin', 'commit', 'release']);
});
