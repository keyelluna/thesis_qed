// Offline comparison: emits only hashes, counts and pass/fail, never cell values.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const nativeRequire = createRequire(path.join(root, 'package.json'));
const baseline = process.argv[3] ? require(path.resolve(process.argv[3])) : nativeRequire('xlsx');
const JSZip = nativeRequire('jszip');
if (baseline.version !== '0.18.5') throw new Error('Supply a separate historical 0.18.5 baseline directory as the third argument.');
const frontend = path.resolve(root, '../QED_front_end');
const ts = createRequire(path.join(frontend, 'package.json'))('typescript');
const candidatePath = process.argv[2];
if (!candidatePath || !path.isAbsolute(candidatePath)) throw new Error('Supply an absolute, reviewed vendor package directory.');
const candidateInfo = JSON.parse(fs.readFileSync(path.join(candidatePath, 'package.json')));
if (candidateInfo.version !== '0.20.3' || candidateInfo.license !== 'Apache-2.0') throw new Error('Unexpected candidate version/license; stop for review.');
const candidate = require(candidatePath);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const hash = value => digest(JSON.stringify(stable(value)));
function services(runtime) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }, req = createRequire(file);
    const requireMock = id => id === 'xlsx' ? runtime : id === './gradeTemplateWorkbookMap.service'
      ? load(path.resolve(path.dirname(file), id + '.js')) : req(id);
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.ts')) source = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(source, { module, exports: module.exports, require: requireMock, Buffer, console, TextEncoder, TextDecoder }, { filename: file });
    cache.set(file, module.exports); return module.exports;
  }
  const folder = path.join(root, 'src/modules/admin/subject-management/services');
  return {
    parse: load(path.join(folder, 'gradeTemplateParser.service.js')).parseGradeTemplate,
    map: load(path.join(folder, 'gradeTemplateWorkbookMap.service.js')).createGradeTemplateWorkbookMap,
    patch: load(path.join(folder, 'gradeTemplateOoxml.service.js')).patchOfficialWorkbook,
    preview: load(path.join(frontend, 'src/features/profiles/admin/pages/subjects/services/gradeTemplateParser.service.ts')).parseGradeTemplate,
  };
}
function snapshot(runtime, buffer) {
  const wb = runtime.read(buffer, { type: 'buffer', cellFormula: true, cellNF: true, cellStyles: true, sheetStubs: true });
  return { names: wb.SheetNames, workbook: wb.Workbook, sheets: wb.Sheets };
}
async function outcome(fn) { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, errorType: error.name }; } }
function equivalent(a, b) { return a.ok === b.ok && (a.ok ? hash(a.value) === hash(b.value) : a.errorType === b.errorType); }
async function main() {
  const old = services(baseline), next = services(candidate), results = [];
  const folder = path.join(root, 'uploads/grade-templates');
  const files = fs.readdirSync(folder).filter(file => file.endsWith('.xlsx')).sort();
  for (const file of files) {
    const buffer = fs.readFileSync(path.join(folder, file)), sourceHash = digest(buffer);
    const fileLike = { arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
    const [pa, pb, ma, mb, fa, fb] = await Promise.all([
      outcome(() => old.parse(buffer)), outcome(() => next.parse(buffer)),
      outcome(() => old.map(buffer)), outcome(() => next.map(buffer)),
      outcome(() => old.preview(fileLike)), outcome(() => next.preview(fileLike)),
    ]);
    const semanticEqual = hash(snapshot(baseline, buffer)) === hash(snapshot(candidate, buffer));
    let exportsEqual = null, packagePartsPreserved = null;
    if (ma.ok && mb.ok) {
      const writes = {};
      for (const term of ma.value.terms) {
        const student = term.studentRows[0]; if (!student) continue;
        writes['INPUT DATA'] ||= {}; writes['INPUT DATA'][student.nameInputCell] = 'Synthetic José 学生 & Learner';
        writes[term.sheetName] ||= {};
        for (const group of [...term.groups.writtenWorks, ...term.groups.performanceTask]) {
          const column = group.scoreColumns[0];
          if (column) writes[term.sheetName][baseline.utils.encode_cell({ r: student.row - 1, c: column - 1 })] = 0;
        }
      }
      const [a, b] = await Promise.all([old.patch(buffer, writes, ma.value), next.patch(buffer, writes, mb.value)]);
      const [za, zb, original] = await Promise.all([JSZip.loadAsync(a), JSZip.loadAsync(b), JSZip.loadAsync(buffer)]);
      const parts = Object.keys(original.files).filter(name => !original.files[name].dir).sort();
      exportsEqual = hash(Object.keys(za.files).sort()) === hash(Object.keys(zb.files).sort());
      packagePartsPreserved = parts.every(name => !!za.file(name) && !!zb.file(name));
      for (const part of parts) {
        const [aa, bb] = await Promise.all([za.file(part).async('nodebuffer'), zb.file(part).async('nodebuffer')]);
        exportsEqual &&= aa.equals(bb);
        if (!/^xl\/(workbook\.xml|worksheets\/sheet\d+\.xml)$/.test(part)) packagePartsPreserved &&= aa.equals(await original.file(part).async('nodebuffer'));
      }
    }
    results.push({ sourceSha256: sourceHash, sourceBytes: buffer.length,
      backendParserEquivalent: equivalent(pa, pb), backendAccepted: pa.ok,
      frontendPreviewEquivalent: equivalent(fa, fb), frontendAccepted: fa.ok,
      frontendStructureSha256: fa.ok ? hash(fa.value) : null,
      mappingsEquivalent: equivalent(ma, mb), mappingAccepted: ma.ok,
      completeReadSemanticsEquivalent: semanticEqual, exportedPackagePartsEquivalent: exportsEqual,
      untouchedPackagePartsPreserved: packagePartsPreserved,
      sourceUnchanged: sourceHash === digest(fs.readFileSync(path.join(folder, file))) });
  }
  const report = { baseline: baseline.version, candidate: candidate.version, candidateLicense: candidateInfo.license,
    workbooks: results.length, results,
    fullyEquivalent: results.length > 0 && results.every(r => r.backendParserEquivalent && r.frontendPreviewEquivalent && r.mappingsEquivalent && r.completeReadSemanticsEquivalent && r.exportedPackagePartsEquivalent !== false && r.untouchedPackagePartsPreserved !== false && r.sourceUnchanged) };
  console.log(JSON.stringify(report, null, 2));
  if (!report.fullyEquivalent) process.exitCode = 1;
}
main().catch(error => { console.log(JSON.stringify({ comparisonAborted: true, errorType: error.name })); process.exitCode = 1; });
