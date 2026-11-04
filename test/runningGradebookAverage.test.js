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
    if (id.includes('gradeSubmissionTransaction.service')) return load('shared/grades/gradeSubmissionTransaction.service.js', db, overrides);
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
  const execute = async (sql, params = []) => {
    calls.push({ sql, params });
    const q=sql.replace(/\s+/g, ' ').trim();
    if(q.includes('information_schema.TABLES'))return [params.map(tableName=>({tableName,engine:'InnoDB'}))];
    if(q.includes('information_schema.STATISTICS'))return [[{indexName:'subject',columnName:'subject_section_id'},{indexName:'subject',columnName:'grading_period_id'},{indexName:'section',columnName:'section_id'},{indexName:'section',columnName:'grading_period_id'}]];
    if(q.startsWith('SELECT ss.id, ss.section_id AS sectionId')&&q.endsWith('FOR UPDATE'))return [[{id:301,sectionId:101,gradeLevelId:1,schoolYearId:1}]];
    if(q.startsWith('SELECT c.id, c.section_id AS sectionId')&&q.endsWith('FOR UPDATE'))return [[{id:params[0],sectionId:102,gradeLevelId:1,schoolYearId:1}]];
    if(q.startsWith('SELECT id FROM school_year WHERE is_active')&&q.endsWith('FOR UPDATE'))return [[{id:1}]];
    if(q.startsWith('SELECT id FROM grading_periods WHERE id'))return [[{id:params[0]}]];
    if(q.endsWith('FOR UPDATE')||q.startsWith('SELECT id FROM grade_submission_history'))return [[]];
    return [await handler(q, params)];
  };
  return { execute, query: execute, calls, getConnection:async()=>({execute,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){},destroy(){}}) };
}

const pathToController = 'teacher/averagegrade/advisoryGrade.controller.js';
for (const [values,expected] of [[[90,null,null],90],[[90,81,null],85.5],[[0,80,null],40],[[90,80,85],85],[[null,null,null],null]]) {
 test(`running gradebook average excludes missing grades: ${values}`, async()=>{
  const db=database(sql=>{
   if(sql.includes('FROM `subject-section`'))return [1,2,3].map(id=>({subjectSectionId:id,subjectId:id,teacherId:7,subjectName:'Subject '+id}));
   if(sql.includes('FROM elem_students'))return [{id:1,firstName:'Sample',lastName:'Learner',gender:'Male'}];
   if(sql.includes('FROM subject_grade_cache'))return values.map((average,i)=>({studentId:1,subjectSectionId:i+1,average,isComplete:average===null?0:1}));
   if(sql.includes('FROM subject_grade_submissions'))return [];
   if(sql.includes('FROM advisory_overall_grades'))throw Error('A stale stored average must not be used');
   throw Error(sql);
  });
  const res=response();await load(pathToController,db).getAdvisoryGradebook({query:{gradingPeriodId:1},teacherId:7,advisorySection:{section_id:1,gradeLevelId:1}},res);
  assert.equal(res.code,200);const student=res.body.data.students[0];assert.equal(student.overallAverage,expected);
  assert.equal(student.averageSubjectCount,values.filter(v=>v!==null).length);assert.equal(student.overallAverageComplete,values.every(v=>v!==null));
 });
}
test('running average updates on refresh and excludes another teacher\'s unsubmitted grade',async()=>{
 let ownGrade=90;
 const db=database(sql=>{
  if(sql.includes('FROM `subject-section`'))return [{subjectSectionId:1,subjectId:1,teacherId:7},{subjectSectionId:2,subjectId:2,teacherId:8}];
  if(sql.includes('FROM elem_students'))return [{id:1,firstName:'Sample',lastName:'Learner',gender:'Male'}];
  if(sql.includes('FROM subject_grade_cache'))return [{studentId:1,subjectSectionId:1,average:ownGrade,isComplete:1},{studentId:1,subjectSectionId:2,average:99,isComplete:1}];
  if(sql.includes('FROM subject_grade_submissions'))return [];
  throw Error(sql);
 });
 const controller=load(pathToController,db),req={query:{gradingPeriodId:1},teacherId:7,advisorySection:{section_id:1,gradeLevelId:1}};
 for(const value of [90,80]){ownGrade=value;const res=response();await controller.getAdvisoryGradebook(req,res);assert.equal(res.body.data.students[0].overallAverage,value);assert.equal(res.body.data.students[0].grades['2'].termGrade,null);}
});
