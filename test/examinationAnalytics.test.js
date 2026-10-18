const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { summarize, statistics } = require('../src/modules/principal/Reports/examinationStatistics');
const row = (studentId, score, hps = 100, extra = {}) => ({ studentId, score, hps, itemId: 1, subjectSectionId: 1, subjectId: 1, subject: 'Math', examination: 'ST1', ...extra });
test('mean and population SD retain full precision', () => {
 const result = statistics([2,4,4,4,5,5,7,9]);
 assert.equal(result.mean,5); assert.equal(result.sd,2);
});
test('zero, missing, blank, invalid, empty and singleton', () => {
 const r = summarize([row(1,0),row(2,null),row(3,''),row(4,undefined),row(5,10,0),row(6,-1),row(7,101)]);
 assert.deepEqual(r.summary,{count:1,mean:0,sd:0,students:1,scale:'Percentage (0–100)'});
 assert.equal(summarize([]).summary.mean,null); assert.equal(summarize([]).summary.sd,null);
});
test('different HPS normalize before population calculations', () => {
 const r = summarize([row(1,40,50),row(2,90,100)]);
 assert.equal(r.summary.mean,85); assert.equal(r.summary.sd,5);
});
test('duplicate scores count once and conflicts are excluded', () => {
 assert.equal(summarize([row(1,50),row(1,50)]).summary.count,1);
 assert.equal(summarize([row(1,50),row(1,60)]).summary.count,0);
});
test('multiple items and partial recording use recorded HPS only', () => {
 const r = summarize([row(1,10,20),row(1,60,80,{itemId:2}),row(2,null,20),row(2,40,80,{itemId:2})]);
 assert.equal(r.summary.count,2); assert.equal(r.summary.mean,60); assert.equal(r.summary.sd,10);
});
test('unequal subject populations use observations, and all views agree', () => {
 const r = summarize([row(1,100),row(2,100),row(1,0,100,{subjectId:2,subjectSectionId:2,itemId:2})]);
 assert.equal(r.summary.students,2); assert.equal(r.summary.count,3);
 assert.ok(Math.abs(r.summary.mean-200/3)<1e-10);
 assert.equal(r.distribution.reduce((sum,b)=>sum+b.count,0),r.summary.count);
 assert.equal(r.rows.reduce((sum,b)=>sum+b.count,0),r.summary.count);
 assert.equal(r.distribution[9].count,2); assert.equal(r.distribution[0].count,1);
});
function controller(db) {
 const filename = path.resolve(__dirname,'../src/modules/principal/Reports/examinationAnalytics.controller.js');
 const module = {exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,console,require:id=>id.includes('config/db') ? db : {summarize}});
 return module.exports.getExaminationAnalytics;
}
function response() { return { code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;} }; }
test('all filters use parameters and both year boundaries are enforced', async () => {
 const calls=[];
 const db={query:async(sql,params)=>{calls.push({sql,params});return [calls.length===1 ? [{id:2,label:'2026',active:1}] : []];}};
 const res=response();
 await controller(db)({query:{schoolYear:'2',term:'Term 2',grade:'Grade 1',section:'3',subject:'4',examination:'TE'}},res);
 assert.equal(res.code,200);
 const last=calls.at(-1);
 assert.deepEqual(Array.from(last.params),['2','2','Term 2','TE','Grade 1','3','4']);
 for(const text of ['ss.school_year_id = ?','gp.school_year_id = ?','gi.tab = \'exams\'','gl.grade_level = ?','ss.section_id = ?','es.id = ?','st.is_deleted = 0']) assert.ok(last.sql.includes(text));
});
test('invalid IDs, array filters and unsupported exams reject before database read',async()=>{
 for(const query of [{schoolYear:'1 OR 1=1'},{section:['1']},{examination:'ALL'},{term:['Term 1']}]) {
  const res=response(); await controller({query:()=>{throw Error('unexpected SQL');}})({query},res); assert.equal(res.code,400);
 }
});
test('existing school reader rejects teachers, parents, anonymous and missing identity',()=>{
 const guard=require('../src/modules/principal/requireSchoolRead.middleware');
 for(const user of [undefined,{role:'TEACHER',userId:1},{role:'PARENT',userId:1},{role:'PRINCIPAL'}]) {
  const res=response(); guard({user},res,()=>assert.fail('access granted'));assert.equal(res.code,403);
 }
 for(const role of ['PRINCIPAL','ADMIN']) {let passed=false;guard({user:{role,userId:1}},response(),()=>{passed=true;});assert.equal(passed,true);}
 const router=fs.readFileSync(path.resolve(__dirname,'../src/modules/principal/Reports/reports.router.js'),'utf8');
 assert.ok(router.indexOf('router.use(verifyToken, requireSchoolRead)')<router.indexOf("router.get('/examination-performance'"));
});


test('comparison cohorts match exact student-section memberships without exposing identities', () => {
 const values=[row(1,60,100,{sectionId:3}),row(2,80,100,{sectionId:3}),row(2,90,100,{itemId:2,subjectId:2,subjectSectionId:2,sectionId:3}),row(1,100,100,{itemId:2,subjectId:2,subjectSectionId:2,sectionId:3})];
 const r=summarize(values);
 assert.equal(r.rows[0].comparisonCohort,r.rows[1].comparisonCohort);
 assert.equal(r.summary.students,2);assert.equal(r.summary.count,4);
 assert.ok(!JSON.stringify(r.rows).includes('members'));
 assert.ok(!JSON.stringify(r.rows).includes('studentId'));
 const changed=values.map((v,i)=>i===3?{...v,studentId:9}:v);
 assert.notEqual(summarize(changed).rows[0].comparisonCohort,summarize(changed).rows[1].comparisonCohort);
 const sections=values.map((v,i)=>i===3?{...v,sectionId:4}:v);
 assert.notEqual(summarize(sections).rows[0].comparisonCohort,summarize(sections).rows[1].comparisonCohort);
 assert.equal(summarize([row(1,80),row(2,90)]).rows[0].comparisonCohort,null);
});
