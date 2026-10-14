const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute the real controllers with isolated database and notification doubles.
// No application database is contacted and no notifications are sent.
function load(relative, db, overrides = {}) {
  const filename = path.resolve(__dirname, '../src/modules', relative);
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const noop = async () => {};
  const requireMock = id => {
    if (id.endsWith('config/db')) return db;
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id.includes('notification.service')) return new Proxy({}, { get: () => noop });
    if (id.includes('gradeSubmissionHistory.service')) return { recordAdvisoryGradeSubmission: noop, recordSubjectGradeSubmission: noop, getAdvisorySubmissionHistory: async () => [] };
    if (id.includes('subjectStudent.authorization')) return load('teacher/gradebook/subjectStudent.authorization.js', db);
    if (id.includes('gradeCache.service')) return {};
    if (id.includes('progressVisibility.controller')) return { getSingleTermVisibility: async () => ({ available: false }) };
    if (id.includes('gradeTemplateResolution.service')) return { resolveGradeTemplateForPeriod: async () => ({ termNumber: 1, template: { structure: { transmutationTable: [{}] } } }) };
    if (id.includes('gradeTemplateConfig.service')) return {};
    return nativeRequire(id);
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: requireMock, module, exports: module.exports, console, Date, Set, Map }, { filename });
  return module.exports;
}
function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function database(handler) {
  const calls = [];
  const execute = async (sql, params = []) => { calls.push({ sql, params }); return [await handler(sql.replace(/\s+/g, ' ').trim(), params)]; };
  return { execute, query: execute, calls };
}
const classes = [
  { classId: 11, section_id: 101, gradeLevelId: 1, sectionName: 'A', gradeLevel: 'Grade 1' },
  { classId: 12, section_id: 102, gradeLevelId: 1, sectionName: 'B', gradeLevel: 'Grade 1' },
];
const advisoryPath = 'teacher/averagegrade/advisoryGrade.controller.js';
function selectionDb() {
  return database(sql => {
    if (sql.includes('FROM teacher_table')) return [{ id: 7 }];
    if (sql.includes('FROM classes c')) return classes;
    throw Error('Unexpected SQL: ' + sql);
  });
}
for (const classId of [11, 12]) test(`two advisory classes: explicitly selects class ${classId}`, async () => {
  const controller = load(advisoryPath, selectionDb());
  const req = { user: { userId: 77, role: 'teacher' }, query: { classId: String(classId) }, body: {} };
  let next = false;
  await controller.loadAdvisorySections(req, response(), () => { next = true; });
  assert.equal(next, true);
  assert.equal(req.advisorySection.classId, classId);
  assert.equal(req.advisorySections.length, 2);
});
test('teacher cannot select another adviser\'s class', async () => {
  const res = response();
  await load(advisoryPath, selectionDb()).loadAdvisorySections({ user: { userId: 77 }, query: { classId: '999' }, body: {} }, res, () => assert.fail('Access should be denied'));
  assert.equal(res.code, 403);
});
test('second advisory submission does not mark first class submitted', async () => {
  const submitted = new Set();
  const db = database((sql, p) => {
    if (sql.startsWith('INSERT INTO grade_submissions')) { submitted.add(`${p[0]}:${p[1]}`); return {}; }
    if (sql.includes('FROM grade_submissions')) return submitted.has(`${p[0]}:${p[1]}`) ? [{ submittedAt: '2026-10-10' }] : [];
    throw Error('Unexpected SQL: ' + sql);
  });
  const c = load(advisoryPath, db);
  const submittedRes = response();
  await c.submitAdvisoryGrades({ body: { gradingPeriodId: 5 }, teacherId: 7, advisorySection: classes[1] }, submittedRes);
  assert.equal(submittedRes.code, 200);
  for (const [index, expected] of [[0, false], [1, true]]) {
    const res = response();
    await c.getSubmissionStatus({ query: { gradingPeriodId: 5 }, advisorySection: classes[index] }, res);
    assert.equal(res.body.data.submitted, expected);
  }
});
test('visibility apply-to-all remains inside the second advisory class', async () => {
  const db = database((sql, p) => {
    if (sql.startsWith('SELECT id FROM elem_students WHERE section_id')) { assert.equal(p[0], 102); return [{ id: 202 }]; }
    if (sql.startsWith('SELECT id FROM elem_students WHERE id IN')) { assert.deepEqual(Array.from(p), [202, 102]); return [{ id: 202 }]; }
    if (sql.startsWith('INSERT INTO grade_visibility')) { assert.deepEqual(Array.from(p), [202, 5, 1, 7]); return {}; }
    throw Error('Unexpected SQL: ' + sql);
  });
  const res = response();
  await load(advisoryPath, db).setGradeVisibility({ advisorySection: classes[1], teacherId: 7, body: { gradingPeriodId: 5, visible: true, applyToAll: true } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.updatedCount, 1);
});
test('visibility refuses a student belonging only to the other advisory class', async () => {
  const db = database(sql => { assert.ok(sql.startsWith('SELECT')); return []; });
  const res = response();
  await load(advisoryPath, db).setGradeVisibility({ advisorySection: classes[1], teacherId: 7, body: { gradingPeriodId: 5, visible: true, studentIds: [201] } }, res);
  assert.equal(res.code, 403);
  assert.equal(db.calls.some(c => c.sql.includes('INSERT')), false);
});
for (const incompleteCount of [0, 1]) test(`subject submission ${incompleteCount ? 'rejects incomplete scores' : 'accepts complete official grades'}`, async () => {
  const db = database(sql => {
    if (sql.startsWith('SELECT COUNT')) return [{ incompleteCount }];
    if (sql.startsWith('INSERT INTO subject_grade_submissions')) return {};
    throw Error('Unexpected SQL: ' + sql);
  });
  const res = response();
  await load('teacher/gradebook/subjectGrading.controller.js', db).submitSubjectGrades({ subjectSection: { id: 301 }, teacherId: 7, body: { gradingPeriodId: 5 } }, res);
  assert.equal(res.code, incompleteCount ? 400 : 200);
  assert.equal(db.calls.some(c => c.sql.startsWith('INSERT')), incompleteCount === 0);
});
for (const submitted of [false, true]) test(`principal gradebook ${submitted ? 'opens after' : 'hides before'} advisory submission`, async () => {
  const db = database(sql => {
    if (sql.includes('FROM school_year')) return [{ id: 1 }];
    if (sql.includes('FROM grading_periods gp')) return [{ id: 5, school_year_id: 1 }];
    if (sql.includes('FROM classes c')) return [{ ...classes[1], sectionId: 102, adviserTeacherId: 7 }];
    if (sql.includes('FROM grade_submissions gs')) return submitted ? [{ id: 1, submittedBy: 7 }] : [];
    if (sql.includes('FROM `subject-section`')) return [];
    throw Error('Unexpected SQL: ' + sql);
  });
  const res = response();
  await load('principal/Gradesheets/gradesheet.controller.js', db).getPrincipalSectionGradebook({ user: { role: 'principal' }, query: { sectionId: '102', gradeLevelId: '1', gradingPeriodId: '5' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.advisorySubmitted, submitted);
  if (!submitted) assert.equal(db.calls.some(c => c.sql.includes('subject_grade_cache')), false);
});

// These assertions express the required access rules. Failures are audit findings.
for (const scenario of ['hidden', 'term-not-ended', 'visible-and-ended', 'sectionless', 'not-submitted']) test(`parent report access: ${scenario}`, async () => {
  const visible = scenario !== 'hidden';
  const ended = scenario !== 'term-not-ended';
  const db = database(sql => {
    if (sql.includes('FROM elem_students es')) return [{ firstName: 'Fixture', lastName: 'Student' }];
    if (sql.includes('FROM grading_periods')) return [{ id: 5, gradingPeriodId: 5, termNumber: 1, termLabel: 'Term 1', isVisible: Number(visible), termEnded: Number(ended) }];
    if (sql.includes('FROM grade_submissions')) {
      if (scenario === 'sectionless') assert.match(sql, /section_id IS NULL AND grade_level_id = \?/);
      return scenario === 'not-submitted' ? [] : [{ gradingPeriodId: 5 }];
    }
    if (sql.includes('FROM `subject-section`')) return [{ id: 301, subjectName: 'Math' }];
    if (sql.includes('FROM subject_grade_cache')) return [{ subjectSectionId: 301, gradingPeriodId: 5, average: 88 }];
    if (sql.includes('FROM advisory_overall_grades')) return [{ gradingPeriodId: 5, overallAverage: 88 }];
    throw Error('Unexpected SQL: ' + sql);
  });
  const res = response();
  await load('parents/Student-Record/ProgressReport/termPerformance.controller.js', db).getTermPerformance({ user: { role: 'parent', userId: 90 }, student: { id: 202, sectionId: scenario === 'sectionless' ? null : 102, schoolYearId: 1, gradeLevelId: 1 }, activeSchoolYearId: 1 }, res);
  assert.equal(res.code, 200);
  const expected = visible && ended && scenario !== 'not-submitted';
  assert.equal(res.body.data[0].released, expected);
  assert.equal(res.body.data[0].subjects.length, expected ? 1 : 0);
  assert.equal(res.body.data[0].average, expected ? 88 : undefined);
});
test('advisory selection must exclude previous-year/inactive classes', async () => {
  const db = selectionDb();
  await load(advisoryPath, db).loadAdvisorySections({ user: { userId: 77 }, query: {}, body: {} }, response(), () => {});
  const sql = db.calls.find(c => c.sql.includes('FROM classes c')).sql;
  assert.match(sql, /school_year_id/);
  assert.match(sql, /c\.status\s*=\s*'Active'/);
});
for (const role of ['parent', 'teacher', 'principal', 'admin']) test(`principal routes authorize ${role}`, async () => {
  const registered = [];
  const router = { get: (...args) => registered.push(args) };
  const token = (_req, _res, next) => next();
  load('principal/Gradesheets/gradesheet.router.js', {}, {
    express: { Router: () => router },
    '../../authentication/authentication.middleware': token,
    './gradesheet.controller': Object.fromEntries(['getSectionGrade', 'getPrincipalSectionGradebook', 'getGradingPeriods'].map(name => [name, (_req, res) => res.status(200).json({ reached: true })])),
  });
  for (const route of registered) {
    const handlers = route.slice(1);
    const res = response();
    const req = { user: { userId: 90, role } };
    let index = 0;
    const next = async () => { const handler = handlers[index++]; if (handler) await handler(req, res, next); };
    await next();
    const permitted = role === 'principal' || role === 'admin';
    assert.equal(res.code, permitted ? 200 : 403, `${role} on ${route[0]}`);
    assert.equal(Boolean(res.body.reached), permitted);
  }
});

for (const sectionId of [102, null]) for (const visible of [false, true]) for (const ended of [false, true]) for (const submitted of [false, true]) test(`parent Overview: section=${sectionId}, visible=${visible}, ended=${ended}, submitted=${submitted}`, async () => {
  const db = database((sql, params) => {
    if (sql.includes('FROM grading_periods')) {
      assert.match(sql, /LEFT JOIN grade_visibility/);
      assert.match(sql, /CURDATE\(\) >= gp.end_date/);
      assert.equal(params[0], '202');
      return [{ id: 5, schoolYearId: 1, termLabel: 'Term 1', isVisible: Number(visible), termEnded: Number(ended) }];
    }
    if (sql.includes('FROM `subject-section`')) {
      assert.match(sql, /ss.school_year_id = \?/);
      if (sectionId === null) { assert.match(sql, /ss.section_id IS NULL AND es.grade_level_id = \?/); assert.deepEqual(Array.from(params), [1, 1]); }
      return [{ subjectSectionId: 301, subjectName: 'Math' }];
    }
    if (sql.includes('FROM subject_grade_cache')) return [{ subjectSectionId: 301, gradingPeriodId: 5, average: 88, isComplete: 1 }];
    if (sql.includes('FROM grade_submissions')) {
      if (sectionId === null) { assert.match(sql, /section_id IS NULL AND grade_level_id = \?/); assert.equal(params[0], 1); }
      return submitted ? [{ gradingPeriodId: 5 }] : [];
    }
    throw Error('Unexpected SQL: ' + sql);
  });
  const res = response();
  await load('parents/Student-Record/Overview/studentTermPerformance.controller.js', db).getStudentTermPerformance({ params: { studentId: '202' }, studentSectionId: sectionId, studentGradeLevelId: 1 }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data[0].released, visible && ended && submitted);
  assert.equal(res.body.data[0].subjects.length, visible && ended && submitted ? 1 : 0);
  assert.equal(res.body.data[0].average, visible && ended && submitted ? 88 : undefined);
});

function assertCurrentRoster(sql) {
  assert.match(sql, /current_school_year_id = \(SELECT id FROM school_year WHERE is_active = 1/);
  assert.match(sql, /status <> 'graduated'/);
  assert.match(sql, /is_deleted = 0/);
}
// Query-contract tests: verify every read/write scope, rather than pretending
// a database double executes MySQL's WHERE predicates.
for (const sectionId of [102, null]) test(`advisory roster and visibility query filters: section=${sectionId}`, async () => {
  const db = database(sql => {
    if (sql.includes('FROM `subject-section`')) {
      assert.match(sql, /ss.school_year_id = \(SELECT id FROM school_year WHERE is_active = 1/);
      assert.match(sql, /ss.status = 'Active'/);
      return [{ subjectSectionId: 301, subjectId: 401, teacherId: 7, subjectName: 'Math' }];
    }
    if (sql.includes('FROM elem_students')) {
      assertCurrentRoster(sql);
      if (sectionId === null) assert.match(sql, /section_id IS NULL/);
      return [{ id: 202, firstName: 'Current', lastName: 'Learner', gender: 'Female' }];
    }
    if (sql.startsWith('INSERT INTO grade_visibility')) return {};
    if (sql.includes('FROM subject_grade_cache') || sql.includes('FROM subject_grade_submissions') || sql.includes('FROM advisory_overall_grades') || sql.includes('FROM grade_visibility')) return [];
    throw Error('Unexpected SQL: ' + sql);
  });
  const c = load(advisoryPath, db);
  const advisorySection = { ...classes[1], section_id: sectionId };
  for (const method of ['getAdvisoryGradebook', 'getGradeVisibility']) {
    const res = response();
    await c[method]({ advisorySection, teacherId: 7, query: { gradingPeriodId: 5 } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.data.students.length, 1);
  }
  for (const applyToAll of [true, false]) {
    const res = response();
    await c.setGradeVisibility({ advisorySection, teacherId: 7, body: { gradingPeriodId: 5, visible: false, studentIds: [202], applyToAll } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.data.updatedCount, 1);
  }
  assert.equal(db.calls.filter(c => c.sql.includes('FROM elem_students')).length, 5);
});

for (const sectionId of [102, null]) test(`overall grade calculation excludes historical subjects and advisers: section=${sectionId}`, async () => {
  const db = database((sql, params) => {
    if (sql.includes('FROM elem_students')) {
      assertCurrentRoster(sql);
      return [{ sectionId, gradeLevelId: 1 }];
    }
    if (sql.includes('FROM classes')) {
      assert.match(sql, /school_year_id = \(SELECT id FROM school_year WHERE is_active = 1/);
      assert.match(sql, /status = 'Active'/);
      return [{ adviserTeacherId: 7 }];
    }
    if (sql.includes('FROM `subject-section`')) {
      assert.match(sql, /ss.school_year_id = \(SELECT id FROM school_year WHERE is_active = 1/);
      return [{ id: 301, teacherId: 7 }];
    }
    if (sql.includes('FROM subject_grade_cache')) return [{ subjectSectionId: 301, average: 88, isComplete: 1 }];
    if (sql.includes('FROM subject_grade_submissions')) return [];
    if (sql.startsWith('INSERT INTO advisory_overall_grades')) { assert.equal(params[4], 88); return {}; }
    throw Error('Unexpected SQL: ' + sql);
  });
  await load('shared/grades/gradeCache.service.js', db).recalcOverallAverage(202, 5);
  assert.equal(db.calls.filter(c => c.sql.startsWith('INSERT')).length, 1);
});

for (const submitted of [false, true]) test(`subject to advisory gradebook: external subject ${submitted ? 'submitted grade appears' : 'complete but unsubmitted stays pending'}`, async () => {
  const db = database(sql => {
    if (sql.includes('FROM `subject-section`')) return [{ subjectSectionId: 301, subjectId: 401, teacherId: 8, subjectName: 'Math' }];
    if (sql.includes('FROM elem_students')) return [{ id: 202, firstName: 'Fixture', lastName: 'Student', gender: 'Female' }];
    if (sql.includes('FROM subject_grade_cache')) return [{ studentId: 202, subjectSectionId: 301, average: 88, isComplete: 1 }];
    if (sql.includes('FROM subject_grade_submissions')) return submitted ? [{ subjectSectionId: 301, submittedByName: 'Subject Teacher' }] : [];
    if (sql.includes('FROM advisory_overall_grades')) return [];
    throw Error('Unexpected SQL: ' + sql);
  });
  const res = response();
  await load(advisoryPath, db).getAdvisoryGradebook({ advisorySection: classes[1], teacherId: 7, query: { gradingPeriodId: 5 } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.data.students[0].grades['301'].status, submitted ? 'submitted' : 'pending');
  assert.equal(res.body.data.students[0].grades['301'].termGrade, submitted ? 88 : null);
});
for (const linked of [false, true]) test(`parent student authorization: ${linked ? 'linked child allowed' : 'unlinked child rejected'}`, async () => {
  const db = database(sql => {
    if (sql.includes('FROM school_year')) return [{ id: 1 }];
    if (sql.includes('FROM elem_students')) return [{ id: 202, sectionId: 102, schoolYearId: 1 }];
    if (sql.includes('FROM parent_table')) return [{ id: 9 }];
    if (sql.includes('FROM parent_student')) return linked ? [{}] : [];
    throw Error('Unexpected SQL: ' + sql);
  });
  const res = response();
  let allowed = false;
  await load('parents/Student-Record/ProgressReport/termPerformance.controller.js', db).verifyStudentAccess({ user: { role: 'parent', userId: 90 }, params: { studentId: '202' } }, res, () => { allowed = true; });
  assert.equal(allowed, linked);
  assert.equal(res.code, linked ? 200 : 403);
});
