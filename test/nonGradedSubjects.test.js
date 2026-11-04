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

for(const isGraded of [0,1]) for(const suffix of ['', '/holistic','/items','/scores/batch','/submission']) test(`subject access graded=${isGraded} path=${suffix}`,async()=>{
 const db=database(sql=>sql.includes('FROM elem_students')?[]:sql.includes('FROM teacher_table')?[{id:7}]:[{id:301,isGraded,gradeLevelId:1,subjectName:'Arts'}]);
 const c=load('teacher/gradebook/subjectGrading.controller.js',db);
 const req={user:{userId:77,role:'TEACHER'},params:{subjectSectionId:'301'},path:'/301'+suffix};const res=response();let next=false;
 await c.loadSubjectSection(req,res,()=>{next=true;});
 const allowed=isGraded===1||suffix===''||suffix==='/holistic';
 assert.equal(next,allowed);assert.equal(res.code,allowed?200:403);
 if(allowed&&suffix==='') {await c.getSubjectSectionInfo(req,res);assert.equal(res.body.data.isGraded,isGraded===1);}
});
for(const section_id of [101,null])test(`gradebook excludes non-graded subjects section=${section_id}`,async()=>{
 let checked=false;const db=database(sql=>{if(sql.includes('FROM `subject-section` ss')){checked=true;assert.match(sql,/es\.is_graded = 1/);return [];}throw Error(sql);});
 const res=response();await load('teacher/averagegrade/advisoryGrade.controller.js',db).getAdvisoryGradebook({query:{gradingPeriodId:1},teacherId:7,advisorySection:{section_id,gradeLevelId:1}},res);
 assert.equal(res.code,200);assert.equal(checked,true);assert.equal(res.body.data.subjects.length,0);
});
