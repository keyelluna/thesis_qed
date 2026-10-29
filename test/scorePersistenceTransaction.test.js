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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qed-score-transaction-'));
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
  let active = false, fail = options.fail, releases = 0, destroys = 0, acquisitions = 0;
  let lease = Promise.resolve();
  const events = [], calls = [], errors = [], notifications = [], sockets = [];
  const state = () => Object.fromEntries(['grade_items', 'grade_scores', 'subject_grade_cache', 'advisory_overall_grades'].map(table => [table, reader.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).all().map(row => ({ ...row }))]));
  async function execute(sql, parameters = [], source = 'connection') {
    const params = Array.from(parameters, value => typeof value === 'boolean' ? Number(value) : value);
    let query = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: query, params, source, active });
    if (source === 'connection') assert.equal(active, true, 'all checked-out statements share the transaction');
    if (query.includes('information_schema.TABLES')) return [params.filter(name => name !== options.missingTable).map(tableName => ({ tableName, engine: options.engine || 'InnoDB' }))];
    if (query.includes('information_schema.STATISTICS')) return [options.missingUnique?[]:[{indexName:'PRIMARY',columnName:'item_id'},{indexName:'PRIMARY',columnName:'student_id'}]];
    const phase = query.startsWith('INSERT INTO grade_scores') ? 'score' : query.startsWith('DELETE FROM notifications') ? 'notification-cleanup' : query.includes('FROM subject_grade_template_periods p') ? 'template' : query.startsWith('INSERT INTO subject_grade_cache') ? 'cache' : query.startsWith('INSERT INTO advisory_overall_grades') ? 'overall' : '';
    if (fail === phase || (fail === 'second-cache' && phase === 'cache' && params[0] === 202)) throw new Error(`Injected ${fail}`);
    query = query.replace(/ FOR UPDATE$/, ''); // Lock syntax is asserted, not simulated as InnoDB locking.
    const database = source === 'connection' ? writer : reader;
    if (/^SELECT /i.test(query)) return [database.prepare(query).all(...params).map(row => ({ ...row }))];
    if (query.includes('ON DUPLICATE KEY UPDATE')) {
      const update = phase === 'score' ? 'ON CONFLICT(item_id,student_id) DO UPDATE SET score=excluded.score' : phase === 'cache' ? 'ON CONFLICT(student_id,subject_section_id,grading_period_id) DO UPDATE SET average=excluded.average,is_complete=excluded.is_complete' : 'ON CONFLICT(student_id,grading_period_id) DO UPDATE SET overall_average=excluded.overall_average,section_id=excluded.section_id,grade_level_id=excluded.grade_level_id';
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
        if(options.notificationGate)await options.notificationGate;if(options.notificationFails)throw Error('notification rejected');return 0;
      }});
      if (/gradeSubmissionHistory\.service|templateStorage\.service|mailer\.service/.test(id)) return new Proxy({}, { get: () => () => { throw Error(`External side effect forbidden: ${id}`); } });
      const resolved = nativeRequire.resolve(id);
      if (resolved.startsWith(path.resolve(__dirname, '../src') + path.sep)) return load(resolved);
      if (id === 'mysql2' || id === 'dotenv') throw Error(`External database configuration forbidden: ${id}`);
      return nativeRequire(id);
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: isolatedRequire, module, exports: module.exports, console: { error: (...args) => errors.push(args) }, Date, Set, Map, Buffer, process }, { filename });
    return module.exports;
  }
  const controller = load(path.resolve(__dirname, '../src/modules/teacher/gradebook/subjectGrading.controller.js'));
  const response = () => ({ code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } });
  const request = (value = 5, extra = {}) => ({ subjectSection: { id: 301, section_id: options.sectionless ? null : 101, gradeLevelId: 1 }, params: { subjectSectionId: 301 }, body: {studentId:201,itemId:11,value,...extra} });
  t.after(() => { if (active) writer.exec('ROLLBACK'); reader.close(); writer.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('qed-score-transaction-')); fs.rmSync(directory, { recursive: true, force: true }); });
  return { controller, state, response, request, events, calls, errors, notifications, sockets, notices:()=>reader.prepare('SELECT * FROM notifications ORDER BY id').all().map(row=>({...row})), setFailure: value => { fail = value; }, stats: () => ({ active, releases, destroys, acquisitions }), async save(req = request()) { const res = response(); await controller.upsertScore(req, res); return res; } };
}

function unchanged(f,before){assert.deepEqual(f.state(),before);assert.equal(f.stats().active,false);}
function saved(f,before,value,grade){
 const actual=f.state();assert.deepEqual(actual.grade_items,before.grade_items);
 const expected=before.grade_scores.filter(row=>!(row.item_id===11&&row.student_id===201));expected.push({item_id:11,student_id:201,score:value});expected.sort((a,b)=>a.item_id-b.item_id||a.student_id-b.student_id);
 assert.deepEqual(actual.grade_scores,expected);
 assert.deepEqual(actual.subject_grade_cache,before.subject_grade_cache.map(row=>row.student_id===201&&row.subject_section_id===301&&row.grading_period_id===5?{...row,average:grade,is_complete:grade===null?0:1}:row));
 assert.deepEqual(actual.advisory_overall_grades,before.advisory_overall_grades.map(row=>row.student_id===201&&row.grading_period_id===5?{...row,overall_average:grade}:row));
}
for(const newScore of [false,true])for(const sectionless of [false,true])test(`score success: insert=${newScore}, sectionless=${sectionless}, actual caches`,async t=>{
 const f=fixture(t,{newScore,sectionless}),before=f.state();const res=await f.save(f.request(5,{expectedValue:newScore?null:10}));
 assert.equal(res.code,200,f.errors.map(String).join('\n'));saved(f,before,5,80);assert.deepEqual(f.events,['acquire','begin','commit','release']);
 assert.match(f.calls[0].sql,/subject-section.*FOR UPDATE$/);assert.match(f.calls[1].sql,/elem_students.*FOR UPDATE$/);
 assert.equal(f.calls.some(c=>c.source==='pool'&&c.active),false);assert.equal(f.stats().acquisitions,1);
});
for(const fail of ['score','score-after','template','cache','cache-after','overall','overall-after'])test(`score failure atomic: ${fail}`,async t=>{
 const f=fixture(t,{fail}),before=f.state(),notices=f.notices();const res=await f.save();
 assert.equal(res.code,500);assert.equal(res.body.outcome,'not_saved');unchanged(f,before);assert.deepEqual(f.notices(),notices);assert.deepEqual(f.notifications,[]);
 assert.deepEqual(f.events,['acquire','begin','rollback','release']);assert.ok(f.errors.some(args=>args.some(value=>String(value).includes(`Injected ${fail}`))));
});
test('score rollback failure destroys connection and retains authoritative state',async t=>{
 const f=fixture(t,{fail:'overall-after',rollbackFails:true}),before=f.state();assert.equal((await f.save()).code,500);unchanged(f,before);
 assert.deepEqual(f.events,['acquire','begin','rollback','destroy']);assert.deepEqual(f.notifications,[]);
});
for(const fail of ['acquire','begin','begin-ack'])test(`score ${fail} failure has no persisted changes`,async t=>{
 const f=fixture(t,{fail}),before=f.state();assert.equal((await f.save()).code,500);unchanged(f,before);
 assert.equal(f.stats().releases,0);assert.equal(f.stats().destroys,fail==='acquire'?0:1);assert.deepEqual(f.notifications,[]);
});
for(const fail of ['commit-before','commit-ack'])test(`score ${fail}: truthful uncertainty and authoritative state`,async t=>{
 const f=fixture(t,{fail}),before=f.state(),res=await f.save(f.request(5,{expectedValue:10}));
 assert.equal(res.code,503);assert.equal(res.body.outcome,'uncertain');assert.match(res.body.message,/check the stored score/);
 assert.deepEqual(f.events,['acquire','begin','commit','destroy']);assert.deepEqual(f.notifications,[]);
 if(fail==='commit-before')unchanged(f,before);else saved(f,before,5,80);
 f.setFailure(undefined);const retry=await f.save(f.request(5,{expectedValue:10}));assert.equal(retry.code,fail==='commit-before'?200:409);saved(f,before,5,80);
});
test('score stale retry cannot overwrite a newer committed edit',async t=>{
 const f=fixture(t,{fail:'cache'}),before=f.state();assert.equal((await f.save(f.request(5,{expectedValue:10}))).code,500);
 f.setFailure(undefined);assert.equal((await f.save(f.request(8,{expectedValue:10}))).code,200);saved(f,before,8,89);
 const newer=f.state();const stale=await f.save(f.request(5,{expectedValue:10}));assert.equal(stale.code,409);assert.equal(stale.body.outcome,'conflict');unchanged(f,newer);
});
test('score concurrent conditional edits serialize; stale editor conflicts, deliberate reconciled edit succeeds',async t=>{
 let reached,release,count=0;const ready=new Promise(resolve=>{reached=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{beforeCommit:async()=>{if(++count===1){reached();await gate;}}}),before=f.state();
 const a=f.save(f.request(5,{expectedValue:10}));await ready;let completed=false;const b=f.save(f.request(8,{expectedValue:10})).then(res=>{completed=true;return res;});
 try{await Promise.resolve();assert.equal(completed,false);assert.deepEqual(f.state(),before);}finally{release();}
 assert.equal((await a).code,200);assert.equal((await b).code,409);saved(f,before,5,80);
 assert.equal((await f.save(f.request(8,{expectedValue:5}))).code,200);saved(f,before,8,89);
});
test('score repeated equal request recalculates but does not duplicate secondary notifications',async t=>{
 const f=fixture(t),before=f.state();assert.equal((await f.save()).code,200);const notices=f.notifications.length;
 assert.equal((await f.save(f.request(5,{expectedValue:5}))).code,200);saved(f,before,5,80);assert.equal(f.notifications.length,notices);
});
for(const value of [-1,11,'NaN',Infinity,true,{},[]])test(`score invalid value ${JSON.stringify(value)} never persists`,async t=>{
 const f=fixture(t),before=f.state();assert.equal((await f.save(f.request(value))).code,400);unchanged(f,before);assert.deepEqual(f.notifications,[]);
});
test('score blank clears score and makes required grade caches incomplete',async t=>{
 const f=fixture(t),before=f.state();assert.equal((await f.save(f.request('',{expectedValue:10}))).code,200);saved(f,before,null,null);
});
test('score zero remains a valid score',async t=>{const f=fixture(t),before=f.state();assert.equal((await f.save(f.request(0))).code,200);saved(f,before,0,80);});
for(const options of [{maxItems:0},{maxItems:-1},{maxItems:null},{noPeriod:true}])test(`score invalid HPS/period ${JSON.stringify(options)} is rejected without persistence`,async t=>{
 const f=fixture(t,options),before=f.state();assert.equal((await f.save()).code,400);unchanged(f,before);assert.deepEqual(f.notifications,[]);
});
for(const extra of [{studentId:999},{itemId:21}])test(`score wrong-student/subject ${JSON.stringify(extra)} denied before persistence`,async t=>{
 const f=fixture(t),before=f.state();assert.equal((await f.save(f.request(5,extra))).code,403);unchanged(f,before);assert.equal(f.calls.some(c=>c.sql.startsWith('INSERT INTO grade_scores')),false);
});
for(const options of [{missingPeriod:true},{missingSubject:true},{engine:'MyISAM'},{missingUnique:true}])test(`score required context/engine failure ${JSON.stringify(options)} rolls back`,async t=>{
 const f=fixture(t,options),before=f.state();assert.equal((await f.save()).code,500);unchanged(f,before);assert.deepEqual(f.notifications,[]);
});
for(const options of [{notificationFails:true},{fail:'notification-cleanup'}])test(`score committed success survives notification failure ${JSON.stringify(options)}`,async t=>{
 const f=fixture(t,options),before=f.state(),res=await f.save();assert.equal(res.code,200);assert.equal(res.body.success,true);assert.equal(res.body.notificationDelivery,undefined);assert.ok(f.errors.length);saved(f,before,5,80);
 assert.deepEqual(f.events,['acquire','begin','commit','release']);
});
test('score actual notification service preserves parent ownership and deduplicates low-score alerts',async t=>{
 const f=fixture(t,{actualNotifications:true}),before=f.state(),res=await f.save();assert.equal(res.code,200);assert.equal(res.body.notificationDelivery,undefined,f.errors.map(String).join('\n'));saved(f,before,5,80);
 const notices=f.notices();assert.equal(notices.filter(n=>n.title==='Missed Activity').length,0);assert.equal(notices.length,1);assert.equal(notices[0].user_id,900);assert.equal(notices[0].student_id,201);assert.equal(notices[0].ref_key,'lowgrade:11:201');
 assert.equal((await f.save(f.request(5,{expectedValue:5}))).code,200);assert.deepEqual(f.notices(),notices);assert.equal(f.sockets.length,1);
});
test('score actual missing-activity notification remains parent-scoped and deduplicated',async t=>{
 const f=fixture(t,{actualNotifications:true,emptyNotices:true});assert.equal((await f.save(f.request(null))).code,200);assert.equal((await f.save(f.request(null,{expectedValue:null}))).code,200);
 const notices=f.notices();assert.equal(notices.length,1);assert.equal(notices[0].title,'Missed Activity');assert.equal(notices[0].user_id,900);
});
test('score response failure cannot roll back a confirmed commit',async t=>{
 const f=fixture(t),before=f.state(),res=f.response();res.json=()=>{throw Error('response lost');};await assert.rejects(f.controller.upsertScore(f.request(),res),/response lost/);saved(f,before,5,80);assert.deepEqual(f.events,['acquire','begin','commit','release']);
});
test('score does not acknowledge success or send notifications before required commit',async t=>{
 let reached,release;const ready=new Promise(resolve=>{reached=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{beforeCommit:async()=>{reached();await gate;}}),before=f.state(),res=f.response();const pending=f.controller.upsertScore(f.request(),res);
 try{await Promise.race([ready,pending.then(()=>{throw Error('Score returned before COMMIT');})]);assert.equal(res.body,null);assert.deepEqual(f.state(),before);assert.deepEqual(f.notifications,[]);}finally{release();}
 await pending;assert.equal(res.code,200);saved(f,before,5,80);
});
test('score release failure destroys connection without falsifying committed success',async t=>{
 const f=fixture(t,{releaseFails:true}),before=f.state();assert.equal((await f.save()).code,200);saved(f,before,5,80);assert.deepEqual(f.events,['acquire','begin','commit','release','destroy']);
});


test('score commit response is delivered without waiting for optional notifications',async t=>{
 let release;const gate=new Promise(r=>{release=r;});const f=fixture(t,{notificationGate:gate}),res=f.response();
 let acknowledge;const acknowledged=new Promise(r=>{acknowledge=r;});const json=res.json.bind(res);res.json=body=>{json(body);acknowledge();return res;};
 const saving=f.controller.upsertScore(f.request(),res);
 try{await acknowledged;assert.equal(res.code,200);assert.equal(res.body.success,true);assert.equal(f.stats().active,false);assert.ok(f.events.includes('commit'));}
 finally{release();await saving;}
});

test('batch scores commit together using one checkout and rollback the whole batch on conflict',async t=>{
 const f=fixture(t),res=f.response();await f.controller.upsertScores({...f.request(),body:{edits:[{studentId:201,itemId:11,value:5,expectedValue:10},{studentId:202,itemId:11,value:6,expectedValue:10}]}},res);
 assert.equal(res.code,200);assert.equal(f.stats().acquisitions,1);assert.equal(f.events.filter(e=>e==='commit').length,1);
 const before=f.state(),conflict=f.response();await f.controller.upsertScores({...f.request(),body:{edits:[{studentId:201,itemId:11,value:7,expectedValue:5},{studentId:202,itemId:11,value:8,expectedValue:999}]}},conflict);
 assert.equal(conflict.code,409);assert.deepEqual(f.state(),before);
});
