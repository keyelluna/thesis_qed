const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const XLSX = require('xlsx');
const {createGradeTemplateWorkbookMap} = require('../src/modules/admin/subject-management/services/gradeTemplateWorkbookMap.service');

const standardDir = path.join(__dirname, '../uploads/grade-templates');
const fixtures = {
  standard: fs.readFileSync(path.join(standardDir, fs.readdirSync(standardDir).find(n => n.startsWith('3-1791291903020-')))),
  mapeh: fs.readFileSync(path.join(__dirname, 'fixtures/mapeh-3term.xlsx')),
};
function fixture(bytes, {emptyThird = false, mismatched = false} = {}) {
  const map = createGradeTemplateWorkbookMap(bytes);
  const items = [], scores = [], resolutions = [];
  for (const [index, term] of map.terms.entries()) {
    if (emptyThird && term.termNumber === 3) continue;
    for (const tab of ['writtenWorks', 'performanceTask', 'exams']) {
      const id = items.length + 1;
      const value = tab === 'writtenWorks' && term.termNumber === 2 ? 0 : 10 + index;
      items.push({id, tab, itemDate:'2026-10-01', gradingPeriodId:term.termNumber, termNumber:term.termNumber,
        maxItems:50, templateDomainId:tab === 'exams' ? term.componentId : term.groups[tab][0].id, examType:tab === 'exams' ? 'ST1' : null});
      scores.push({itemId:id, studentId:1, score:value});
    }
  }
  const db = {async execute(sql, params) {
    if (sql.includes('SELECT ss.id AS subjectSectionId')) return [[{subjectSectionId:1, subjectId:1, sectionId:1, schoolYearId:2026, termNumber:Number(params[0])}]];
    if (sql.includes('FROM elem_students')) return [[{id:1, name:'Export Learner', gender:'Male'}]];
    if (sql.includes('FROM grade_items gi')) {
      assert.match(sql, /gp.school_year_id = \?/); assert.match(sql, /gp.term_number BETWEEN 1 AND 3/);
      assert.deepEqual(Array.from(params), [1,2026]); return [items];
    }
    if (sql.includes('FROM grade_scores')) return [scores];
    throw Error(sql);
  }};
  const filename = path.resolve(__dirname, '../src/modules/admin/subject-management/subjectGradeTemplate.controller.js');
  const native = createRequire(filename), module = {exports:{}};
  const requireMock = id => {
    if (id.endsWith('config/db')) return db;
    if (id.includes('gradeCache.service')) return {};
    if (id.includes('gradeTemplateResolution.service')) return {async resolveGradeTemplateForPeriod(subject, period, options) {
      resolutions.push({period,options});
      return {template:{templateId:1,fileName:'Official.xlsx',workbookBuffer:bytes,exportMap:map,
        checksum:mismatched && Number(period) === 2 ? 'b'.repeat(64) : map.workbookChecksumSha256}};
    }};
    return native(id);
  };
  vm.runInNewContext(fs.readFileSync(filename,'utf8'), {require:requireMock,module,exports:module.exports,console,Date,Set,Map,Buffer});
  return {map, items, scores, resolutions, async export(selected) {
    const res = {code:200,headers:{},status(c){this.code=c;return this},json(x){this.body=x;return this},setHeader(k,v){this.headers[k]=v},send(x){this.bytes=x;return this}};
    await module.exports.exportGradeTemplateBySection({params:{subjectSectionId:'1'},query:{gradingPeriodId:String(selected)},user:{userId:1}},res);
    return res;
  }};
}
for (const kind of ['standard','mapeh']) for (const selected of [1,3]) test(`${kind}: selected term ${selected} exports all terms and preserves workbook formulas`, async () => {
  const f = fixture(fixtures[kind]); const res = await f.export(selected);
  assert.equal(res.code,200,JSON.stringify(res.body));
  assert.match(res.headers['Content-Disposition'], /QED-CLASS-RECORD.xlsx/);
  assert.deepEqual(f.resolutions.map(r => Number(r.period)), [1,2,3]);
  assert.ok(f.resolutions.every(r => r.options.pinIfEmpty === false));
  const original = XLSX.read(fixtures[kind],{type:'buffer',cellFormula:true});
  const output = XLSX.read(res.bytes,{type:'buffer',cellFormula:true});
  for (const [index,term] of f.map.terms.entries()) {
    const sheet = output.Sheets[term.sheetName], row = term.studentRows.find(r => r.gender === 'M').row;
    const wwCol = term.groups.writtenWorks[0].scoreColumns[0];
    const examCol = term.examinations.components.find(c => c.key === 'ST1').scoreColumn;
    const cell = c => XLSX.utils.encode_cell({r:row-1,c:c-1});
    assert.equal(sheet[cell(wwCol)].v, term.termNumber === 2 ? 0 : 10+index);
    assert.equal(sheet[cell(examCol)].v,10+index);
  }
  for(const name of original.SheetNames) for(const [address,cell] of Object.entries(original.Sheets[name])) {
    if(cell?.f) assert.equal(output.Sheets[name][address]?.f,cell.f,`${name}!${address}`);
  }
});
test('unrecorded third term is blank while other terms are exported', async () => {
  const f=fixture(fixtures.mapeh,{emptyThird:true}),res=await f.export(3);assert.equal(res.code,200);
  const output=XLSX.read(res.bytes,{type:'buffer'});
  for(const term of f.map.terms.filter(t=>t.termNumber===3)) for(const cell of term.rawInputCells) assert.equal(output.Sheets[term.sheetName][cell]?.v??null,null);
  assert.equal(output.Sheets['TERM 2 M and A'].F18.v,0);
});
test('different pinned template versions cannot silently reinterpret another term',async()=>{
  const f=fixture(fixtures.standard,{mismatched:true}),res=await f.export(1);assert.equal(res.code,409);assert.match(res.body.message,/different official template versions/);assert.equal(res.bytes,undefined);
});
