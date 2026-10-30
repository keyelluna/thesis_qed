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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qed-submission-transaction-'));
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
    CREATE TABLE elem_subjects(id INTEGER PRIMARY KEY,subject_name TEXT,grade_level_id INTEGER,is_graded INTEGER); INSERT INTO elem_subjects VALUES(21,'Math',1,1);
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
  writer.exec(`ALTER TABLE grade_items ADD topic_id INTEGER DEFAULT 44;
    ALTER TABLE elem_students ADD first_name TEXT DEFAULT 'Synthetic';
    ALTER TABLE elem_students ADD last_name TEXT DEFAULT 'Learner';
    CREATE TABLE learning_topics(id INTEGER PRIMARY KEY,topic_name TEXT,developing_threshold_percent REAL); INSERT INTO learning_topics VALUES(44,'Numbers',75);
    CREATE TABLE parent_table(id INTEGER PRIMARY KEY,user_id INTEGER,is_deleted INTEGER); INSERT INTO parent_table VALUES(1,900,0);
    CREATE TABLE parent_student(parent_id INTEGER,student_id INTEGER); INSERT INTO parent_student VALUES(1,201);
    CREATE TABLE notifications(id INTEGER PRIMARY KEY,user_id INTEGER,student_id INTEGER,grade_item_id INTEGER,ref_key TEXT,title TEXT,message TEXT,type TEXT,is_read INTEGER,created_at TEXT);
    INSERT INTO notifications VALUES(1,900,201,11,NULL,'Missed Activity','Synthetic','warning',0,'2026-10-21');`);
  reader.function('NOW', () => '2026-10-21 12:00:00');
  if (options.newScore) writer.exec('DELETE FROM grade_scores WHERE item_id=11 AND student_id=201');
  if (Object.hasOwn(options,'maxItems')) writer.prepare('UPDATE grade_items SET max_items=? WHERE id=11').run(options.maxItems);
  if (options.noPeriod) writer.exec('UPDATE grade_items SET grading_period_id=NULL WHERE id=11');
  if (options.emptyNotices) writer.exec('DELETE FROM notifications');
  writer.exec("ALTER TABLE elem_students ADD middle_name TEXT; ALTER TABLE elem_students ADD gender TEXT DEFAULT 'Female'; ALTER TABLE grading_periods ADD term_label TEXT DEFAULT 'Term 1'; CREATE TABLE principal_table(user_id INTEGER,is_deleted INTEGER,status TEXT); INSERT INTO principal_table VALUES(700,0,'active'),(701,1,'active'),(702,0,'inactive');");
  writer.function('DATE_FORMAT', (value, _format) => value); reader.function('DATE_FORMAT', (value, _format) => value);
  writer.exec(`ALTER TABLE classes ADD id INTEGER DEFAULT 11;
    UPDATE classes SET class_adviser_id=8;
    DROP TABLE subject_grade_submissions;
    CREATE TABLE subject_grade_submissions(subject_section_id INTEGER,grading_period_id INTEGER,submitted_by INTEGER,submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(subject_section_id,grading_period_id));
    CREATE TABLE grade_submissions(section_id INTEGER,grade_level_id INTEGER,grading_period_id INTEGER,submitted_by INTEGER,submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(section_id,grading_period_id),UNIQUE(grade_level_id,grading_period_id));
    CREATE TABLE grade_submission_history(id INTEGER PRIMARY KEY AUTOINCREMENT,submission_type TEXT,section_id INTEGER,grade_level_id INTEGER,subject_section_id INTEGER,grading_period_id INTEGER,submitted_by INTEGER,submitted_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE grade_visibility(student_id INTEGER,grading_period_id INTEGER,is_visible INTEGER);INSERT INTO grade_visibility VALUES(201,5,0);
    UPDATE advisory_overall_grades SET overall_average=NULL WHERE grading_period_id=5 AND student_id IN(201,202);`);
  if(options.foreignYear)writer.exec('UPDATE grading_periods SET school_year_id=2 WHERE id=5');
  if(options.badTerm)writer.exec('UPDATE grading_periods SET term_number=4 WHERE id=5');
  if(options.incomplete)writer.exec('UPDATE subject_grade_cache SET is_complete=0 WHERE student_id=201 AND grading_period_id=5');
  if(options.noTransmutation)writer.exec(`UPDATE subject_grade_templates SET structure_json='{}'`);
  if(options.missingHistory)writer.exec('DROP TABLE grade_submission_history');
  let active = false, fail = options.fail, releases = 0, destroys = 0, acquisitions = 0;
  let lease = Promise.resolve();
  const events = [], calls = [], errors = [], notifications = [], sockets = [];
  const state = () => Object.fromEntries(['subject_grade_submissions','grade_submissions','grade_submission_history','grade_items','grade_scores','subject_grade_cache','advisory_overall_grades','grade_visibility'].map(table => [table, reader.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all().map(row => ({ ...row }))]));
  async function execute(sql, parameters = [], source = 'connection') {
    const params = Array.from(parameters, value => typeof value === 'boolean' ? Number(value) : value);
    if(sql.includes('CREATE TABLE IF NOT EXISTS grade_submission_history'))return [{}];
    let query = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: query, params, source, active });
    if (source === 'connection') assert.equal(active, true, 'all checked-out statements share the transaction');
    if (query.includes('information_schema.TABLES')) return [params.filter(name => name !== options.missingTable).map(tableName => ({ tableName, engine: options.engine || 'InnoDB' }))];
    if (query.includes('information_schema.STATISTICS')) return [options.missingUnique?[]:[{indexName:'unique',columnName:options.kind==='advisory'?(options.sectionless?'grade_level_id':'section_id'):'subject_section_id'},{indexName:'unique',columnName:'grading_period_id'}]];
    const phase = query.startsWith('INSERT INTO subject_grade_submissions')||query.startsWith('INSERT INTO grade_submissions') ? 'submission' : query.startsWith('INSERT INTO grade_submission_history') ? 'history' : query.includes('FROM grade_submission_history') ? 'history-read' : query.startsWith('INSERT INTO grade_scores') ? 'score' : query.startsWith('DELETE FROM notifications') ? 'notification-cleanup' : query.includes('FROM subject_grade_template_periods p') ? 'template' : query.startsWith('INSERT INTO subject_grade_cache') ? 'cache' : query.startsWith('INSERT INTO advisory_overall_grades') ? 'overall' : '';
    if (fail === phase || (fail === 'second-cache' && phase === 'cache' && params[0] === 202)) throw new Error(`Injected ${fail}`);
    query = query.replace(/ FOR UPDATE$/, ''); // Lock syntax is asserted, not simulated as InnoDB locking.
    const database = source === 'connection' ? writer : reader;
    if (/^SELECT /i.test(query)) return [database.prepare(query).all(...params).map(row => ({ ...row }))];
    if (query.includes('ON DUPLICATE KEY UPDATE')) {
      const update = phase === 'submission' ? (query.includes('INTO subject_grade_submissions') ? 'ON CONFLICT(subject_section_id,grading_period_id) DO UPDATE SET submitted_by=excluded.submitted_by,submitted_at=CURRENT_TIMESTAMP' : 'ON CONFLICT('+ (options.sectionless?'grade_level_id':'section_id') +',grading_period_id) DO UPDATE SET submitted_by=excluded.submitted_by,submitted_at=CURRENT_TIMESTAMP') : phase === 'score' ? 'ON CONFLICT(item_id,student_id) DO UPDATE SET score=excluded.score' : phase === 'cache' ? 'ON CONFLICT(student_id,subject_section_id,grading_period_id) DO UPDATE SET average=excluded.average,is_complete=excluded.is_complete' : 'ON CONFLICT(student_id,grading_period_id) DO UPDATE SET overall_average=excluded.overall_average,section_id=excluded.section_id,grade_level_id=excluded.grade_level_id';
      query = query.replace(/ON DUPLICATE KEY UPDATE.*$/, update);
    }
    const result = database.prepare(query).run(...params);
    if (fail === `${phase}-after`) throw new Error(`Injected ${fail}`);
    return [{ affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }];
  }
  const conn = {
    execute, async beginTransaction() { events.push('begin'); if (fail === 'begin') throw Error('begin'); writer.exec('BEGIN'); active = true; if (fail === 'begin-ack') throw Error('begin acknowledgement'); },
    async commit() { events.push('commit'); await options.beforeCommit?.(); if (fail === 'commit-before') throw Error('commit rejected'); writer.exec('COMMIT'); active = false; if (fail === 'commit-ack') throw Error('commit acknowledgement lost'); },
    async rollback() { events.push('rollback'); if (options.rollbackFails) throw Error('rollback rejected'); writer.exec('ROLLBACK'); active = false; },
    release() { events.push('release'); releases++; assert.equal(active, false, 'no open transaction returned to pool'); if (options.releaseFails) throw Error('release rejected'); },
    destroy() { events.push('destroy'); destroys++; if (active) { writer.exec('ROLLBACK'); active = false; } },
  };
  // Deterministic checkout serialization supplies the isolated concurrency
  // barrier. It is not a substitute for a live InnoDB row-lock test.
  const poolExecute = (sql, params) => execute(sql, params, 'pool');
  const pool = { execute: poolExecute, query: poolExecute, async getConnection() {
    events.push('acquire'); acquisitions++; if (fail === 'acquire') throw Error('acquire');
    const previous=lease;let unlock;lease=new Promise(resolve=>{unlock=resolve;});await previous;
    return {...conn,release(){conn.release();unlock();},destroy(){conn.destroy();unlock();}};
  } };
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const nativeRequire = createRequire(filename);
    function isolatedRequire(id) {
      if (/config\/db(?:\.js)?$/.test(id)) return pool;
      if (id.endsWith('socket.js')) return {getIO:()=>({to:()=>({emit:(...args)=>sockets.push(args)})})};
      if (/notification\.service/.test(id) && !options.actualNotifications) return new Proxy({}, {get:(_target,name)=>async()=>{
        assert.equal(active,false,'notifications must follow confirmed commit and cleanup');assert.ok(events.includes('commit'));notifications.push(String(name));
        if(options.notificationFails)throw Error('notification rejected');return 0;
      }});
      if (/templateStorage\.service|mailer\.service/.test(id)) return new Proxy({}, { get: () => () => { throw Error(`External side effect forbidden: ${id}`); } });
      const resolved = nativeRequire.resolve(id);
      if (resolved.startsWith(path.resolve(__dirname, '../src') + path.sep)) return load(resolved);
      if (id === 'mysql2' || id === 'dotenv') throw Error(`External database configuration forbidden: ${id}`);
      return nativeRequire(id);
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: isolatedRequire, module, exports: module.exports, console: { error: (...args) => errors.push(args) }, Date, Set, Map, Buffer, URLSearchParams, process: {env:{}} }, { filename });
    return module.exports;
  }
  const controller = load(path.resolve(__dirname, options.kind==='advisory'?'../src/modules/teacher/averagegrade/advisoryGrade.controller.js':'../src/modules/teacher/gradebook/subjectGrading.controller.js'));
  const response = () => ({ code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } });
  t.after(() => { if (active) writer.exec('ROLLBACK'); reader.close(); writer.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('qed-submission-transaction-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const request=(extra={})=>({teacherId:options.kind==='advisory'?8:7,subjectSection:{id:301},advisorySection:{classId:11,section_id:options.sectionless?null:101,gradeLevelId:1},body:{gradingPeriodId:5,expectedSubmissionVersion:null,...extra}});
  return {controller,state,response,request,events,calls,errors,notifications,sockets,writer,reader,advisory:()=>load(path.resolve(__dirname,'../src/modules/teacher/averagegrade/advisoryGrade.controller.js')),setFailure:value=>{fail=value;},stats:()=>({active,releases,destroys,acquisitions}),async submit(req=request()){const res=response();await controller[options.kind==='advisory'?'submitAdvisoryGrades':'submitSubjectGrades'](req,res);return res;}};

}
function unchanged(f,before){assert.deepEqual(f.state(),before);assert.equal(f.stats().active,false);}
for(const kind of ['subject','advisory']) {
 for(const sectionless of [false,true])test(`${kind} submission succeeds atomically, sectionless=${sectionless}`,async t=>{
  const f=fixture(t,{kind,sectionless}),before=f.state();const res=await f.submit();assert.equal(res.code,200,f.errors.map(String).join('\n'));assert.equal(res.body.success,true);
  const state=f.state();assert.equal(state[kind==='subject'?'subject_grade_submissions':'grade_submissions'].length,1);assert.equal(state.grade_submission_history.length,1);assert.equal(state.grade_submission_history[0].submission_type,kind);assert.deepEqual(state.grade_visibility,before.grade_visibility);assert.deepEqual(state.grade_scores,before.grade_scores);assert.deepEqual(state.subject_grade_cache,before.subject_grade_cache);
  assert.deepEqual(state.advisory_overall_grades.filter(r=>r.student_id<999&&r.grading_period_id===5).map(r=>r.overall_average),kind==='subject'?[90,100]:[null,null]);
  assert.equal(f.notifications.length,1);assert.deepEqual(f.events,['acquire','begin','commit','release']);assert.equal(f.calls.filter(c=>c.source==='pool').length,0);assert.equal(f.calls.some(c=>c.sql.startsWith('CREATE')),false);
 });
 for(const fail of ['history-read','submission','submission-after','history','history-after','overall','overall-after']) {
  test(`${kind} submission atomic failure: ${fail}`,async t=>{const f=fixture(t,{kind,fail}),before=f.state();const res=await f.submit();assert.equal(res.code,500);assert.equal(res.body.outcome,'not_saved');unchanged(f,before);assert.deepEqual(f.notifications,[]);assert.deepEqual(f.events,['acquire','begin','rollback','release']);});
 }
 test(`${kind} submission rollback failure destroys connection`,async t=>{const f=fixture(t,{kind,fail:'history-after',rollbackFails:true}),before=f.state();assert.equal((await f.submit()).code,500);unchanged(f,before);assert.deepEqual(f.events,['acquire','begin','rollback','destroy']);assert.deepEqual(f.notifications,[]);});
 for(const fail of ['acquire','begin','begin-ack'])test(`${kind} submission ${fail} cleanup`,async t=>{const f=fixture(t,{kind,fail}),before=f.state();assert.equal((await f.submit()).code,500);unchanged(f,before);assert.equal(f.stats().releases,0);assert.equal(f.stats().destroys,fail==='acquire'?0:1);assert.deepEqual(f.notifications,[]);});
 for(const fail of ['commit-before','commit-ack'])test(`${kind} submission ${fail} has explicit uncertainty`,async t=>{const f=fixture(t,{kind,fail}),before=f.state();const res=await f.submit();assert.equal(res.code,503);assert.equal(res.body.outcome,'uncertain');assert.match(res.body.message,/status and history/);assert.deepEqual(f.events,['acquire','begin','commit','destroy']);assert.deepEqual(f.notifications,[]);if(fail==='commit-before')unchanged(f,before);else assert.equal(f.state().grade_submission_history.length,1);f.setFailure(undefined);const retry=await f.submit();assert.equal(retry.code,fail==='commit-before'?200:409);assert.equal(f.state().grade_submission_history.length,1);});
 test(`${kind} committed submission survives notification failure`,async t=>{const f=fixture(t,{kind,notificationFails:true});assert.equal((await f.submit()).code,200);assert.equal(f.state().grade_submission_history.length,1);const retry=await f.submit();assert.equal(retry.code,409);assert.equal(f.state().grade_submission_history.length,1);assert.equal(f.notifications.length,1);});
 test(`${kind} duplicate stale version rejected; deliberate resubmission records exactly one new event`,async t=>{const f=fixture(t,{kind});assert.equal((await f.submit()).code,200);const before=f.state();assert.equal((await f.submit()).code,409);unchanged(f,before);assert.equal(f.notifications.length,1);assert.equal((await f.submit(f.request({expectedSubmissionVersion:'1'}))).code,200);assert.equal(f.state().grade_submission_history.length,2);assert.equal(f.notifications.length,2);});
 test(`${kind} legacy repeated request is a no-op`,async t=>{const f=fixture(t,{kind}),req=f.request();delete req.body.expectedSubmissionVersion;assert.equal((await f.submit(req)).code,200);const before=f.state();const res=await f.submit(req);assert.equal(res.code,200);assert.equal(res.body.alreadySubmitted,true);unchanged(f,before);assert.equal(f.notifications.length,1);});
 test(`${kind} concurrent confirmations commit one history event`,async t=>{let reached,release,count=0;const ready=new Promise(r=>{reached=r;}),gate=new Promise(r=>{release=r;});const f=fixture(t,{kind,beforeCommit:async()=>{if(++count===1){reached();await gate;}}}),before=f.state();const a=f.submit();await ready;let completed=false;const b=f.submit().then(r=>{completed=true;return r;});try{await Promise.resolve();assert.equal(completed,false);assert.deepEqual(f.state(),before);}finally{release();}assert.equal((await a).code,200);assert.equal((await b).code,409);assert.equal(f.state().grade_submission_history.length,1);assert.equal(f.notifications.length,1);});
 for(const options of [{foreignYear:true},{badTerm:true},{missingUnique:true},{engine:'MyISAM'}])test(`${kind} submission refuses invalid context ${JSON.stringify(options)}`,async t=>{const f=fixture(t,{kind,...options}),before=f.state();assert.equal((await f.submit()).code,options.foreignYear||options.badTerm?400:500);unchanged(f,before);assert.deepEqual(f.notifications,[]);});
 test(`${kind} transaction revalidates teacher ownership`,async t=>{const f=fixture(t,{kind}),before=f.state(),req=f.request();req.teacherId=999;assert.equal((await f.submit(req)).code,403);unchanged(f,before);assert.deepEqual(f.notifications,[]);});
 for(const value of [undefined,0,-1,{},[],true,'5 OR 1=1'])test(`${kind} rejects period ${JSON.stringify(value)}`,async t=>{const f=fixture(t,{kind}),before=f.state();assert.equal((await f.submit(f.request({gradingPeriodId:value}))).code,400);unchanged(f,before);assert.equal(f.stats().acquisitions,0);});
 test(`${kind} release error does not undo confirmed success`,async t=>{const f=fixture(t,{kind,releaseFails:true});assert.equal((await f.submit()).code,200);assert.equal(f.state().grade_submission_history.length,1);assert.deepEqual(f.events,['acquire','begin','commit','release','destroy']);});
 test(`${kind} response delivery failure cannot rollback or replay a committed submission`,async t=>{const f=fixture(t,{kind}),res=f.response();res.json=()=>{throw Error('response socket failed');};await assert.rejects(()=>f.controller[kind==='subject'?'submitSubjectGrades':'submitAdvisoryGrades'](f.request(),res),/response socket failed/);assert.equal(f.state().grade_submission_history.length,1);assert.deepEqual(f.events,['acquire','begin','commit','release']);});
}
for(const options of [{incomplete:true},{noTransmutation:true}])test(`subject prerequisites preserved ${JSON.stringify(options)}`,async t=>{const f=fixture(t,options),before=f.state();assert.equal((await f.submit()).code,400);unchanged(f,before);assert.deepEqual(f.notifications,[]);});
for(const kind of ['subject','advisory'])for(const sectionless of [false,true])test(`${kind} actual notification recipient scope, sectionless=${sectionless}`,async t=>{
 const f=fixture(t,{kind,sectionless,actualNotifications:true});f.writer.exec('DELETE FROM notifications');
 // Historical and inactive advisers must not receive current submissions.
 f.writer.exec("INSERT INTO classes VALUES(101,1,0,7,'Active',99),(101,1,1,7,'Inactive',98)");
 const res=await f.submit();assert.equal(res.code,200);assert.equal(res.body.notificationDelivery,undefined,f.errors.map(String).join('\n'));
 const notices=f.reader.prepare('SELECT * FROM notifications').all();assert.equal(notices.length,1);assert.equal(notices[0].user_id,kind==='subject'?88:700);assert.equal(notices[0].title,kind==='subject'?'Grade Submission':'Grades Submitted');assert.equal(f.sockets.length,1);
 assert.equal((await f.submit()).code,409);assert.equal(f.reader.prepare('SELECT COUNT(*) AS total FROM notifications').get().total,1);
});
for(const fail of [undefined,'history','overall-after'])test(`actual adviser reader exposes other-teacher grades only after committed submission, fail=${fail}`,async t=>{
 const f=fixture(t,{fail});const read=async()=>{const res=f.response();await f.advisory().getAdvisoryGradebook({teacherId:8,advisorySection:f.request().advisorySection,query:{gradingPeriodId:5}},res);assert.equal(res.code,200,f.errors.map(String).join('\n'));return res.body.data.students.find(s=>s.studentId==='201').grades['301'];};
 const before=await read();assert.equal(before.status,'pending');assert.equal(before.average,null);
 assert.equal((await f.submit()).code,fail?500:200);const after=await read();assert.equal(after.status,fail?'pending':'submitted');assert.equal(after.average,fail?null:90);assert.equal(f.reader.prepare('SELECT is_visible FROM grade_visibility').get().is_visible,0);
});
for(const kind of ['subject','advisory'])test(`${kind} missing history table fails closed without DDL or status write`,async t=>{const f=fixture(t,{kind,missingHistory:true,missingTable:'grade_submission_history'});assert.equal((await f.submit()).code,500);assert.equal(f.reader.prepare('SELECT COUNT(*) AS n FROM '+(kind==='subject'?'subject_grade_submissions':'grade_submissions')).get().n,0);assert.equal(f.calls.some(c=>/CREATE|ALTER/.test(c.sql)),false);assert.deepEqual(f.notifications,[]);});
test('sectionless advisory submission version ignores sectioned history in the same grade',async t=>{const f=fixture(t,{kind:'advisory',sectionless:true});f.writer.exec("INSERT INTO grade_submission_history(submission_type,section_id,grade_level_id,grading_period_id,submitted_by) VALUES('advisory',102,1,5,8)");assert.equal((await f.submit()).code,200);assert.equal(f.state().grade_submission_history.length,2);});

for(const kind of ['subject','advisory'])test(`${kind} status returns authoritative history version and current-year ownership is revalidated`,async t=>{
 const f=fixture(t,{kind}),req=f.request();const read=async()=>{const res=f.response();await f.controller[kind==='subject'?'getGradeSubmissionStatus':'getSubmissionStatus']({...req,query:{gradingPeriodId:5}},res);assert.equal(res.code,200);return res.body.data;};
 assert.deepEqual(await read(),{submitted:false,submittedAt:null,submissionVersion:null});assert.equal((await f.submit()).code,200);assert.equal((await read()).submissionVersion,'1');assert.equal((await read()).submitted,true);
 f.writer.exec('UPDATE school_year SET is_active=0');const before=f.state();assert.equal((await f.submit(f.request({expectedSubmissionVersion:'1'}))).code,403);unchanged(f,before);
});
for(const kind of ['subject','advisory'])test(`${kind} completed inactive period remains deliberately resubmittable in the same year`,async t=>{const f=fixture(t,{kind});f.writer.exec('ALTER TABLE grading_periods ADD is_active INTEGER DEFAULT 0');assert.equal((await f.submit()).code,200);assert.equal((await f.submit(f.request({expectedSubmissionVersion:'1'}))).code,200);assert.equal(f.state().grade_submission_history.length,2);});
