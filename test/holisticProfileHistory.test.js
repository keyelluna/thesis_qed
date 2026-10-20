const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('student profile history preserves recorded domains, scores, and authorized subjects', async () => {
  const queries = [];
  const replies = [
    [{ id: 7 }],
    [{ id: 1, name: 'Ana Cruz', section_id: 10 }],
    [{ section_id: 10 }],
    [{ id: 20, subjectName: 'Mathematics' }],
    [{ axis: 'cognitive', avgRating: '4.5', cnt: 2, lastWeek: '2026-10-12' }],
    [{ subject_section_id: 20, axis: 'cognitive', avgRating: '4.5', cnt: 2, lastWeek: '2026-10-12' }],
    [{ subject_section_id: 20, week: '2026-10-12', axis: 'cognitive', rating: '5' }, { subject_section_id: 20, week: '2026-10-05', axis: 'cognitive', rating: '4' }],
  ];
  const connection = { execute: async (sql, params) => { queries.push({ sql, params }); assert.ok(replies.length, 'unexpected query'); return [replies.shift()]; } };
  const module = { exports: {} };
  const file = require.resolve('../src/modules/teacher/holistic/holistics.controller');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, console,
    require(id) {
      if (id.endsWith('config/db')) return connection;
      if (id.endsWith('studentRecord.authorization')) return { studentReadScope: () => ({ sql: 'st.id IN (?)', params: [1] }) };
      if (id.endsWith('subjectStudent.authorization')) return { studentBelongsToSubject: async () => true };
      if (id.endsWith('subjectGrading.controller')) return { loadSubjectSection() {} };
      if (id.endsWith('notification.service')) return { notifyWeeklyEvaluationIfComplete() {} };
      throw new Error(`Unexpected dependency ${id}`);
    },
  });
  let status, response;
  await module.exports.getStudentHolisticProfile({ user: { userId: 99 }, params: { studentId: '1' }, query: { termNumber: '1' } }, {
    status(value) { status = value; return this; }, json(value) { response = value; return this; },
  });
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(response.data.evaluationHistory)), [
    { date: '2026-10-12', subjectSectionId: '20', subjectName: 'Mathematics', domain: 'cognitive', score: 5 },
    { date: '2026-10-05', subjectSectionId: '20', subjectName: 'Mathematics', domain: 'cognitive', score: 4 },
  ]);
  assert.deepEqual(Array.from(queries.at(-1).params), [20, '1', '1']);
  assert.match(queries.at(-1).sql, /ORDER BY week_start_date DESC/);
  assert.equal(response.data.overall.evaluationCount, 2);
  assert.equal(response.data.subjects[0].trend, 'Improving');
});
