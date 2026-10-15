const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
let scenario, calls;
const dbId = require.resolve('../config/db'), previousDb = require.cache[dbId];
const db = { async execute(sql, params = []) {
  calls.push({ sql, params });
  assert.match(sql.trim(), /^SELECT/i, 'release readers must not write');
  if (sql.includes('FROM grading_periods gp')) {
    if (sql.includes('AS submitted')) {
      assert.match(sql, /EXISTS\s*\([\s\S]*FROM grade_submissions gs/);
      assert.match(sql, /gs\.grading_period_id = gp\.id/);
      assert.match(sql, /gs\.section_id = s\.section_id/);
      assert.match(sql, /gs\.section_id IS NULL AND gs\.grade_level_id = s\.grade_level_id/);
      assert.match(sql, /s\.current_school_year_id = gp\.school_year_id/);
    }
    return [scenario.empty ? [] : [{ id: 5, gradingPeriodId: 5, termNumber: 1, termLabel: 'Term 1', submitted: scenario.submitted, isVisible: scenario.visible, termEnded: scenario.ended }]];
  }
  if (sql.includes('FROM school_year')) return [[{ id: 7 }]];
  if (sql.includes('FROM elem_students es')) return [[{}]];
  if (sql.includes('FROM elem_students')) return [[{ id: 101, sectionId: scenario.section, gradeLevelId: 1, schoolYearId: 7 }]];
  if (sql.includes('FROM parent_table')) return [[{ id: 51 }]];
  if (sql.includes('FROM parent_student')) return [scenario.unlinked ? [] : [{}]];
  if (sql.includes('FROM grade_submissions')) return [Number(scenario.submitted) ? [{ gradingPeriodId: 5 }] : []];
  if (sql.includes('FROM `subject-section`')) return [[]];
  throw new Error('Unexpected synthetic SQL: ' + sql);
} };
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: db };
const router = require('../src/modules/parents/Student-Record/ProgressReport/termPerformance.router');
const { getSingleTermVisibility } = require('../src/modules/parents/Student-Record/ProgressReport/progressVisibility.controller');
const secret = randomBytes(32).toString('hex'), priorSecret = process.env.JWT_SECRET;
let server, base;
test.before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express(); app.use(cookieParser(), router);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousDb) require.cache[dbId] = previousDb; else delete require.cache[dbId];
  if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret;
});
test.beforeEach(() => { calls = []; scenario = { submitted: 1, visible: 1, ended: 1, section: 11 }; });
async function request(path, role = 'PARENT') {
  const token = jwt.sign({ userId: 801, role }, secret, { expiresIn: '1h' });
  const r = await fetch(base + '/101/' + path, { headers: { Cookie: 'token=' + token } });
  return { status: r.status, body: await r.json() };
}
for (const role of ['PARENT', 'parent']) for (const section of [11, null]) {
  for (const submitted of [0, 1]) for (const visible of [0, 1]) for (const ended of [0, 1]) {
    test(`formal/academic gates agree: ${role} section=${section} submitted=${submitted} visible=${visible} ended=${ended}`, async () => {
      scenario = { submitted, visible, ended, section };
      const expected = Boolean(submitted && visible && ended);
      const visibility = await request('visibility', role);
      assert.equal(visibility.status, 200);
      assert.equal(visibility.body.data[0].submitted, Boolean(submitted));
      assert.equal(visibility.body.data[0].available, expected);
      const academic = await request('term-performance', role);
      assert.equal(academic.status, 200);
      assert.equal(academic.body.data[0].released, expected);
      assert.equal((await getSingleTermVisibility(101, 5)).available, expected);
    });
  }
}
test('driver string zero flags fail closed and an absent period is unavailable', async () => {
  scenario = { section: 11, submitted: '0', visible: '1', ended: '1' };
  assert.equal((await getSingleTermVisibility(101, 5)).available, false);
  scenario.empty = true;
  assert.equal(await getSingleTermVisibility(101, 5), null);
  assert.deepEqual((await request('visibility')).body.data, []);
});
test('unlinked Parent cannot access formal availability or academic report', async () => {
  scenario.unlinked = true;
  for (const path of ['visibility', 'term-performance']) {
    calls = [];
    assert.equal((await request(path)).status, 403);
    assert.ok(!calls.some(c => c.sql.includes('FROM grading_periods gp')));
  }
});

test('live Overview holistic feedback remains released for an unfinished active term', async () => {
  const module = { exports: {} };
  const file = require.resolve('../src/modules/parents/Student-Record/Overview/holisticPerformance.controller');
  const liveDb = { async execute(sql) {
    assert.match(sql.trim(), /^SELECT/i);
    assert.doesNotMatch(sql, /grade_visibility|grade_submissions/);
    if (sql.includes('FROM grading_periods gp')) return [[{ grading_period_id: 5, term_number: 1, term_label: 'Term 1', is_active: 1, term_ended: 0 }]];
    if (sql.includes('FROM `subject-section`')) return [[{ id: 10 }]];
    if (sql.includes('FROM holistic_ratings')) return [[{ term_number: 1, axis: 'cognitive', avgRating: 4, cnt: 1 }]];
    throw new Error('Unexpected live holistic fixture query');
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, console, require(id) { assert.ok(id.endsWith('config/db')); return liveDb; } });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await module.exports.getStudentTermAverages({ params: { studentId: '101' }, studentSectionId: 11, query: {} }, res);
  assert.equal(res.code, 200); assert.equal(res.body.data[0].released, true);
  assert.equal(res.body.data[0].domainAverages.cognitive, 4);
});
