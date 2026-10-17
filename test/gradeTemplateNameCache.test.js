const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const { createGradeTemplateWorkbookMap } = require('../src/modules/admin/subject-management/services/gradeTemplateWorkbookMap.service');
const { patchOfficialWorkbook } = require('../src/modules/admin/subject-management/services/gradeTemplateOoxml.service');

const directory = path.join(__dirname, '../uploads/grade-templates');
const files = fs.readdirSync(directory).filter(name => name.endsWith('.xlsx')).sort();
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const nameAddress = row => XLSX.utils.encode_cell({ r: row.row - 1, c: row.nameColumn - 1 });
function cells(xml) {
  return new Map([...xml.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)]
    .map(match => [match[0].match(/\br="([A-Z]+\d+)"/)[1], match[0]]));
}
function worksheetPaths(zip, workbookXml, relationships) {
  const targets = new Map([...relationships.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => {
    let target = tag.match(/\bTarget="([^"]+)"/)[1];
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return [tag.match(/\bId="([^"]+)"/)[1], target];
  }));
  return new Map([...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) =>
    [tag.match(/\bname="([^"]+)"/)[1], targets.get(tag.match(/\br:id="([^"]+)"/)[1])]));
}

test('all seven uploaded template fixtures are covered', () => assert.equal(files.length, 7));

for (const file of files) test(`learner caches, formulas, scores and untouched XML: ${file}`, async () => {
  const filename = path.join(directory, file);
  const original = fs.readFileSync(filename);
  const originalHash = hash(original);
  const map = createGradeTemplateWorkbookMap(original);
  const source = XLSX.read(original, { type: 'buffer', cellFormula: true });
  const term = map.terms[0];
  const boys = term.studentRows.filter(row => row.gender === 'M');
  const girls = term.studentRows.filter(row => row.gender === 'F');
  // IDs deliberately differ from row order; names and scores share the row assignment.
  const roster = [
    { id: 'student-900', row: boys[0], name: 'Dela Cruz & Sons, <José> "Peña" O\'Neil $&', score: 7 },
    { id: 'student-100', row: girls[0], name: '女, María > Ana & Co. $1', score: 9 },
  ];
  const rowByStudent = new Map(roster.map(student => [student.id, student.row]));
  const scoresByStudent = new Map(roster.map(student => [student.id, student.score]));
  const inputs = Object.fromEntries(term.studentRows.map(row => [row.nameInputCell, null]));
  const column = term.groups.writtenWorks[0].scoreColumns[0];
  const scoreWrites = {};
  for (const student of [...roster].reverse()) {
    const row = rowByStudent.get(student.id);
    inputs[row.nameInputCell] = student.name;
    scoreWrites[XLSX.utils.encode_cell({ r: row.row - 1, c: column - 1 })] = scoresByStudent.get(student.id);
  }
  const baseline = await patchOfficialWorkbook(original, { 'INPUT DATA': {}, [term.sheetName]: scoreWrites }, map);
  const output = await patchOfficialWorkbook(original, { 'INPUT DATA': inputs, [term.sheetName]: scoreWrites }, map);
  const reopened = XLSX.read(output, { type: 'buffer', cellFormula: true });
  for (const mappedTerm of map.terms) {
    for (const row of mappedTerm.studentRows) {
      const address = nameAddress(row);
      assert.equal(reopened.Sheets[mappedTerm.sheetName][address].f, source.Sheets[mappedTerm.sheetName][address].f);
      assert.equal(reopened.Sheets[mappedTerm.sheetName][address].v, inputs[row.nameInputCell] ?? '');
    }
  }
  for (const student of roster) {
    const address = XLSX.utils.encode_cell({ r: student.row.row - 1, c: column - 1 });
    assert.equal(reopened.Sheets[term.sheetName][address].v, student.score);
    assert.equal(reopened.Sheets['INPUT DATA'][student.row.nameInputCell].v, student.name);
  }
  const cleared = await patchOfficialWorkbook(output, {
    'INPUT DATA': Object.fromEntries(Object.keys(inputs).map(address => [address, null])),
  }, map);
  const clearedWorkbook = XLSX.read(cleared, { type: 'buffer', cellFormula: true });
  for (const t of map.terms) for (const row of t.studentRows) {
    assert.equal(clearedWorkbook.Sheets[t.sheetName][nameAddress(row)].v, '', 'removed learners leave no stale name');
  }
  for (const sheetName of source.SheetNames) {
    const formulas = sheet => Object.entries(sheet).filter(([, cell]) => cell?.f).map(([a, cell]) => [a, cell.f]);
    assert.deepEqual(formulas(reopened.Sheets[sheetName]), formulas(source.Sheets[sheetName]));
    assert.deepEqual(reopened.Sheets[sheetName]['!merges'], source.Sheets[sheetName]['!merges']);
  }
  const beforeZip = await JSZip.loadAsync(baseline), afterZip = await JSZip.loadAsync(output);
  const paths = worksheetPaths(beforeZip, await beforeZip.file('xl/workbook.xml').async('string'),
    await beforeZip.file('xl/_rels/workbook.xml.rels').async('string'));
  const allowed = new Map([[paths.get('INPUT DATA'), new Set(Object.keys(inputs))],
    ...map.terms.map(t => [paths.get(t.sheetName), new Set(t.studentRows.map(nameAddress))])]);
  assert.deepEqual(Object.keys(afterZip.files).sort(), Object.keys(beforeZip.files).sort());
  for (const [part, entry] of Object.entries(beforeZip.files)) {
    if (entry.dir) continue;
    const before = await entry.async('nodebuffer'), after = await afterZip.file(part).async('nodebuffer');
    if (!allowed.has(part)) { assert.deepEqual(after, before, `unchanged package part ${part}`); continue; }
    const beforeXml = before.toString(), afterXml = after.toString();
    const beforeCells = cells(beforeXml), afterCells = cells(afterXml);
    assert.deepEqual([...afterCells.keys()], [...beforeCells.keys()]);
    for (const [address, node] of beforeCells) {
      if (!allowed.get(part).has(address)) assert.equal(afterCells.get(address), node, `untouched ${part}!${address}`);
      else if (part !== paths.get('INPUT DATA')) {
        // Only the cached value and the cell's result type may change.
        const stripCache = xml => xml.replace(/\s+t="[^"]*"/, '').replace(/<v\b[^>]*(?:\/>|>[\s\S]*?<\/v>)/, '');
        assert.equal(stripCache(afterCells.get(address)), stripCache(node));
      }
    }
    const stripCells = xml => xml.replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, '');
    assert.equal(stripCells(afterXml), stripCells(beforeXml), `formatting/protection unchanged in ${part}`);
  }
  assert.equal(hash(fs.readFileSync(filename)), originalHash, 'uploaded template is unchanged');
});

test('rejects an unverified learner formula target', async () => {
  const original = fs.readFileSync(path.join(directory, files[0]));
  const map = createGradeTemplateWorkbookMap(original);
  const row = map.terms[0].studentRows[0];
  row.nameColumn += 1;
  await assert.rejects(patchOfficialWorkbook(original, { 'INPUT DATA': { [row.nameInputCell]: 'Test' } }, map),
    /unverified learner-name formula/);
});

test('rejects a mapped formula with unsupported semantics', async () => {
  const original = fs.readFileSync(path.join(directory, files[0]));
  const map = createGradeTemplateWorkbookMap(original);
  const row = map.terms[0].studentRows[0];
  const workbook = XLSX.read(original, { type: 'buffer', cellFormula: true });
  workbook.Sheets[map.terms[0].sheetName][nameAddress(row)].f = `UPPER('INPUT DATA'!${row.nameInputCell})`;
  const altered = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  await assert.rejects(patchOfficialWorkbook(altered, { 'INPUT DATA': { [row.nameInputCell]: 'Test' } }, map),
    /unverified learner-name formula/);
});
