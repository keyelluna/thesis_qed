const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const XLSX = require("xlsx");
const JSZip = require("jszip");
const { parseGradeTemplate } = require("../src/modules/admin/subject-management/services/gradeTemplateParser.service");
const { createGradeTemplateWorkbookMap } = require("../src/modules/admin/subject-management/services/gradeTemplateWorkbookMap.service");
const { patchOfficialWorkbook } = require("../src/modules/admin/subject-management/services/gradeTemplateOoxml.service");
const { assertMappedCapacity } = require("../src/modules/admin/subject-management/services/gradeTemplateCapacity.service");
const { calculateOfficialGrade, descriptorForGrade } = require("../src/modules/shared/grades/gradeComputation.service");
const { assessmentCategoryForName } = require("../src/modules/shared/grades/assessmentCategory.service");

const uploadDir = path.join(__dirname, "../uploads/grade-templates");

function setCell(sheet, row, column, value) {
  const address = XLSX.utils.encode_cell({ r: row - 1, c: column - 1 });
  if (value !== undefined) sheet[address] = typeof value === "object" && value?.f ? value : { t: typeof value === "number" ? "n" : "s", v: value };
  return address;
}

function createFixture({ wwCapacity = 4, ptCapacity = 3, withExam = true } = {}) {
  const wb = XLSX.utils.book_new();
  const input = XLSX.utils.aoa_to_sheet(Array.from({ length: 4 }, () => Array(8).fill(null)));
  setCell(input, 2, 3, "Student One");
  setCell(input, 3, 3, "Student Two");
  XLSX.utils.book_append_sheet(wb, input, "INPUT DATA");

  const layouts = [];
  for (let term = 1; term <= 3; term += 1) {
    const grid = Array.from({ length: 9 }, () => Array(40).fill(null));
    const wwStart = 6;
    const wwTotal = wwStart + wwCapacity;
    const wwPs = wwTotal + 1;
    const wwWs = wwTotal + 2;
    const ptStart = wwWs + 1;
    const ptTotal = ptStart + ptCapacity;
    const ptPs = ptTotal + 1;
    const ptWs = ptTotal + 2;
    const exStart = ptWs + 1;
    const initial = withExam ? exStart + 8 : exStart;
    const termGrade = initial + 1;
    const descriptor = initial + 2;

    grid[0][wwStart - 1] = "WRITTEN / ORAL WORKS (WWs)";
    grid[0][ptStart - 1] = "PRODUCT / PERFORMANCE TASKS (PTs)";
    if (withExam) grid[0][exStart - 1] = "EXAMINATIONS (EXs)";
    grid[0][initial - 1] = "Initial Grade";
    grid[0][termGrade - 1] = "Term Grade";
    grid[0][descriptor - 1] = "Descriptor";

    for (let i = 0; i < wwCapacity; i += 1) grid[2][wwStart + i - 1] = String(i + 1);
    grid[2][wwTotal - 1] = "Total"; grid[2][wwPs - 1] = "PS"; grid[2][wwWs - 1] = "WS";
    for (let i = 0; i < ptCapacity; i += 1) grid[2][ptStart + i - 1] = String(i + 1);
    grid[2][ptTotal - 1] = "Total"; grid[2][ptPs - 1] = "PS"; grid[2][ptWs - 1] = "WS";
    if (withExam) {
      ["ST1", "ST2", "TE", "WS ST1", "WS ST2", "WS TE", "PS", "WS"].forEach((label, i) => { grid[2][exStart + i - 1] = label; });
    }
    grid[2][initial - 1] = "Initial Grade"; grid[2][termGrade - 1] = "Term Grade"; grid[2][descriptor - 1] = "Descriptor";

    grid[3][1] = "HIGHEST POSSIBLE SCORE";
    for (let c = wwStart; c < wwTotal; c += 1) grid[3][c - 1] = 10;
    grid[3][wwTotal - 1] = ""; grid[3][wwPs - 1] = 100; grid[3][wwWs - 1] = 0.2;
    for (let c = ptStart; c < ptTotal; c += 1) grid[3][c - 1] = 10;
    grid[3][ptTotal - 1] = ""; grid[3][ptPs - 1] = 100; grid[3][ptWs - 1] = withExam ? 0.5 : 0.8;
    if (withExam) {
      [10, 10, 10, 30, 30, 40, 100, 0.3].forEach((value, i) => { grid[3][exStart + i - 1] = value; });
    }

    grid[5][1] = "MALE";
    grid[6][1] = 1;
    grid[6][2] = { t: "str", v: "Student One", f: "'INPUT DATA'!$C$2" };
    grid[7][1] = "FEMALE";
    grid[8][1] = 1;
    grid[8][2] = { t: "str", v: "Student Two", f: "'INPUT DATA'!$C$3" };
    const sheet = XLSX.utils.aoa_to_sheet(grid);
    sheet[XLSX.utils.encode_cell({ r: 6, c: 2 })] = grid[6][2];
    sheet[XLSX.utils.encode_cell({ r: 8, c: 2 })] = grid[8][2];
    sheet["!merges"] = [
      { s: { r: 6, c: 2 }, e: { r: 6, c: 4 } },
      { s: { r: 8, c: 2 }, e: { r: 8, c: 4 } },
    ];
    layouts.push({ sheet, term, wwStart, wwCapacity, exStart, withExam });
    XLSX.utils.book_append_sheet(wb, sheet, `TERM ${term}`);
  }

  const finalGrades = XLSX.utils.aoa_to_sheet([["Final grades are calculated here"]]);
  XLSX.utils.book_append_sheet(wb, finalGrades, "FINAL GRADES");
  const helper = XLSX.utils.aoa_to_sheet([
    [null, "IG (Min.)", "IG (Max.)", "Transmuted", null, "Numerical Grade", "Descriptor"],
    [null, 0, 100, 80, null, 80, "Satisfactory"],
  ]);
  XLSX.utils.book_append_sheet(wb, helper, "HELPER");
  return { buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), layouts };
}

function workbookSnapshot(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellFormula: true, cellNF: true });
  const formulas = {};
  const sheets = {};
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    formulas[name] = Object.entries(sheet).filter(([key, cell]) => !key.startsWith("!") && cell?.f).map(([key, cell]) => [key, cell.f]).sort();
    sheets[name] = Object.fromEntries(["!merges", "!pageSetup", "!margins", "!printOptions", "!dataValidation", "!protect", "!rows", "!cols"].map((key) => [key, sheet[key]]));
  }
  return { names: wb.SheetNames, visibility: wb.Workbook?.Sheets?.map((s) => [s.name, s.Hidden ?? 0]), definedNames: wb.Workbook?.Names || [], formulas, sheets };
}

test("manual grading weights resolve assessment categories by name, not database ID", () => {
  assert.equal(assessmentCategoryForName("Written / Oral Works (WWs)"), "ww");
  assert.equal(assessmentCategoryForName("Product / Performance Tasks (PTs)"), "pt");
  assert.equal(assessmentCategoryForName("Examinations (EXs)"), "exam");
  assert.equal(assessmentCategoryForName("Other"), null);
});

test("current Math/Science and GMRC template families map their own structures", () => {
  const files = fs.readdirSync(uploadDir);
  const mathPath = path.join(uploadDir, files.find((f) => f.startsWith("3-1791291903020-")));
  const gmrcPath = path.join(uploadDir, files.find((f) => f.startsWith("5-1790420571865-")));
  const mathBytes = fs.readFileSync(mathPath);
  const gmrcBytes = fs.readFileSync(gmrcPath);
  const math = createGradeTemplateWorkbookMap(mathBytes);
  const gmrc = createGradeTemplateWorkbookMap(gmrcBytes);
  const mathParsed = parseGradeTemplate(mathBytes);
  const gmrcParsed = parseGradeTemplate(gmrcBytes);

  assert.deepEqual(math.terms[0].config.ww.domains.map((d) => d.scoreColumns.length), [5]);
  assert.deepEqual(math.terms[0].config.pt.domains.map((d) => d.scoreColumns.length), [3]);
  assert.deepEqual(math.terms[0].examinations.components.map((c) => [c.key, c.weightPercent]), [["ST1", 30], ["ST2", 30], ["TE", 40]]);
  assert.deepEqual(math.terms[0].examinations.components.map((c) => [c.key, c.scoreColumn, c.weightedScoreColumn, c.weightPercent]), [["ST1", 20, 23, 30], ["ST2", 21, 24, 30], ["TE", 22, 25, 40]]);
  assert.deepEqual(gmrc.terms[0].examinations.components.map((c) => [c.key, c.scoreColumn, c.weightedScoreColumn, c.weightPercent]), [["ST1", 40, 43, 30], ["ST2", 41, 44, 30], ["TE", 42, 45, 40]]);
  assert.equal(math.terms[0].config.examWeightPercent, 30);
  assert.deepEqual(gmrc.terms[0].config.ww.domains.map((d) => d.scoreColumns.length), [5, 5]);
  assert.deepEqual(gmrc.terms[0].config.pt.domains.map((d) => d.scoreColumns.length), [3, 3, 3]);
  assert.equal(gmrcParsed.structure.ww.domains.length, 2);
  assert.equal(mathParsed.structure.examinations.enabled, true);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(mathPath)).digest("hex"), crypto.createHash("sha256").update(mathBytes).digest("hex"));
});

test("six-WW fixture maps six slots and rejects a seventh without changing the template", () => {
  const fixture = createFixture({ wwCapacity: 6, ptCapacity: 4, withExam: true });
  const map = createGradeTemplateWorkbookMap(fixture.buffer);
  assert.equal(map.terms[0].config.ww.domains[0].scoreColumns.length, 6);
  assert.equal(map.terms[0].config.pt.domains[0].scoreColumns.length, 4);
  assert.doesNotThrow(() => assertMappedCapacity(6, map.terms[0].config.ww.domains[0].scoreColumns.length, "Written Works"));
  assert.throws(() => assertMappedCapacity(7, map.terms[0].config.ww.domains[0].scoreColumns.length, "Written Works"), /7 items/);
});

test("no-exam fixture parses, maps, calculates and provides a template descriptor without exam scores", async () => {
  const fixture = createFixture({ wwCapacity: 4, ptCapacity: 3, withExam: false });
  const parsed = parseGradeTemplate(fixture.buffer);
  const map = createGradeTemplateWorkbookMap(fixture.buffer);
  assert.equal(parsed.structure.examinations.enabled, false);
  assert.equal(map.terms[0].examinations.enabled, false);
  assert.equal(map.terms[0].rawInputCells.some((cell) => cell.startsWith("U")), false);
  const grade = calculateOfficialGrade({
    ww: { ws: 20, isComplete: true },
    pt: { ws: 80, isComplete: true },
    exam: { ws: null, isComplete: false },
    weights: { ww: 20, pt: 80, exam: 0 },
    examinations: parsed.structure.examinations,
    transmutationTable: parsed.structure.transmutationTable,
  });
  assert.deepEqual(grade, { isComplete: true, initialGrade: 100, termGrade: 80 });
  assert.equal(descriptorForGrade(parsed.structure, grade.termGrade), "Satisfactory");
  const term = map.terms[0];
  const student = term.studentRows[0];
  const wwColumn = term.groups.writtenWorks[0].scoreColumns[0];
  const output = await patchOfficialWorkbook(fixture.buffer, {
    "INPUT DATA": { [student.nameInputCell]: "No Exam Learner" },
    [term.sheetName]: { [XLSX.utils.encode_cell({ r: student.row - 1, c: wwColumn - 1 })]: 8 },
  }, map);
  assert.deepEqual(workbookSnapshot(output).names, workbookSnapshot(fixture.buffer).names);
  assert.equal(map.terms[0].examinations.enabled, false);
});

test("incomplete required domains cannot publish initial or term grades", () => {
  const partial = calculateOfficialGrade({
    ww: { ws: 20, isComplete: true },
    pt: { ws: 50, isComplete: false },
    exam: { ws: 30, isComplete: false },
    weights: { ww: 20, pt: 50, exam: 30 },
    examinations: { enabled: true },
    transmutationTable: [{ igMin: 0, igMax: 100, transmuted: 80 }],
  });
  assert.deepEqual(partial, { isComplete: false, initialGrade: null, termGrade: null });
  const complete = calculateOfficialGrade({
    ww: { ws: 20, isComplete: true },
    pt: { ws: 50, isComplete: true },
    exam: { ws: 30, isComplete: true },
    weights: { ww: 20, pt: 50, exam: 30 },
    examinations: { enabled: true },
    transmutationTable: [{ igMin: 0, igMax: 100, transmuted: 80 }],
  });
  assert.deepEqual(complete, { isComplete: true, initialGrade: 100, termGrade: 80 });
});

test("a pinned period keeps its original template when a newer version becomes active", async () => {
  const databaseModulePath = require.resolve("../config/db");
  const resolverModulePath = require.resolve("../src/modules/shared/grades/gradeTemplateResolution.service");
  const originalDatabaseModule = require.cache[databaseModulePath];
  const originalResolverModule = require.cache[resolverModulePath];
  const calls = [];
  const pinnedVersionA = {
    templateId: 7,
    subjectId: 5,
    fileName: "version-a.xlsx",
    filePath: null,
    checksum: "a".repeat(64),
    structureJson: JSON.stringify({ ww: { weightPercent: 20 }, pt: { weightPercent: 80 } }),
    exportMapJson: null,
  };
  const mockConnection = {
    async execute(sql) {
      calls.push(sql);
      if (sql.includes("FROM `subject-section` ss") && sql.includes("INNER JOIN grading_periods")) {
        return [[{ subjectId: 5, schoolYearId: 2, termNumber: 1 }]];
      }
      if (sql.includes("FROM subject_grade_template_periods p")) return [[pinnedVersionA]];
      if (sql.includes("is_active = 1")) {
        return [[{ templateId: 8, subjectId: 5 }]]; // The newer active version must not be consulted.
      }
      throw new Error(`Unexpected template-resolution query: ${sql}`);
    },
  };
  require.cache[databaseModulePath] = {
    id: databaseModulePath,
    filename: databaseModulePath,
    loaded: true,
    exports: mockConnection,
  };
  delete require.cache[resolverModulePath];
  try {
    const { resolveGradeTemplateForPeriod } = require(resolverModulePath);
    const result = await resolveGradeTemplateForPeriod(22, 1, { pinIfEmpty: true });
    assert.equal(result.template.templateId, 7);
    assert.equal(result.template.structure.ww.weightPercent, 20);
    assert.equal(calls.some((sql) => sql.includes("is_active = 1")), false);
  } finally {
    delete require.cache[resolverModulePath];
    if (originalResolverModule) require.cache[resolverModulePath] = originalResolverModule;
    if (originalDatabaseModule) require.cache[databaseModulePath] = originalDatabaseModule;
    else delete require.cache[databaseModulePath];
  }
});

test("OOXML export changes mapped cells while retaining official formulas and workbook structure", async (t) => {
  const file = fs.readdirSync(uploadDir).find((f) => f.startsWith("3-1791291903020-"));
  const original = fs.readFileSync(path.join(uploadDir, file));
  const beforeHash = crypto.createHash("sha256").update(original).digest("hex");
  const map = createGradeTemplateWorkbookMap(original);
  const term = map.terms[0];
  const firstStudent = term.studentRows.find((r) => r.gender === "M") || term.studentRows[0];
  const column = term.groups.writtenWorks[0].scoreColumns[0];
  const scoreCell = XLSX.utils.encode_cell({ r: firstStudent.row - 1, c: column - 1 });
  const inputCell = firstStudent.nameInputCell;
  const output = await patchOfficialWorkbook(original, {
    "INPUT DATA": { [inputCell]: "Regression Learner" },
    [term.sheetName]: { [scoreCell]: 8 },
  }, map);
  const before = workbookSnapshot(original);
  const after = workbookSnapshot(output);
  assert.equal(Object.values(before.formulas).reduce((total, cells) => total + cells.length, 0), 5142);
  assert.equal(Object.values(before.sheets).reduce((total, sheet) => total + (sheet["!merges"] || []).length, 0), 530);
  assert.deepEqual(after.names, before.names);
  assert.deepEqual(after.visibility, before.visibility);
  assert.deepEqual(after.definedNames, before.definedNames);
  assert.deepEqual(after.formulas, before.formulas);
  for (const name of before.names) {
    assert.deepEqual(after.sheets[name]["!merges"], before.sheets[name]["!merges"]);
    assert.deepEqual(after.sheets[name]["!pageSetup"], before.sheets[name]["!pageSetup"]);
    assert.deepEqual(after.sheets[name]["!margins"], before.sheets[name]["!margins"]);
    assert.deepEqual(after.sheets[name]["!printOptions"], before.sheets[name]["!printOptions"]);
    assert.deepEqual(after.sheets[name]["!dataValidation"], before.sheets[name]["!dataValidation"]);
    assert.deepEqual(after.sheets[name]["!protect"], before.sheets[name]["!protect"]);
    assert.deepEqual(after.sheets[name]["!rows"], before.sheets[name]["!rows"]);
    assert.deepEqual(after.sheets[name]["!cols"], before.sheets[name]["!cols"]);
  }
  const [originalZip, outputZip] = await Promise.all([JSZip.loadAsync(original), JSZip.loadAsync(output)]);
  assert.deepEqual(Object.keys(outputZip.files).sort(), Object.keys(originalZip.files).sort());
  const entries = Object.keys(originalZip.files).filter((name) => /^(xl\/media\/|xl\/drawings\/|xl\/worksheets\/_rels\/)/.test(name));
  for (const entry of entries) {
    assert.ok(outputZip.file(entry), `retains ${entry}`);
    assert.deepEqual(
      await outputZip.file(entry).async("nodebuffer"),
      await originalZip.file(entry).async("nodebuffer"),
      `preserves package part ${entry}`,
    );
  }
  assert.equal(crypto.createHash("sha256").update(original).digest("hex"), beforeHash, "source workbook remains unchanged");

  const gmrcName = fs.readdirSync(uploadDir).find((name) => name.startsWith("5-1790420571865-"));
  const gmrcOriginal = fs.readFileSync(path.join(uploadDir, gmrcName));
  const gmrcMap = createGradeTemplateWorkbookMap(gmrcOriginal);
  const gmrcTerm = gmrcMap.terms[0];
  const gmrcStudent = gmrcTerm.studentRows[0];
  const gmrcColumn = gmrcTerm.groups.writtenWorks[0].scoreColumns[0];
  const gmrcScoreCell = XLSX.utils.encode_cell({ r: gmrcStudent.row - 1, c: gmrcColumn - 1 });
  const gmrcOutput = await patchOfficialWorkbook(gmrcOriginal, {
    "INPUT DATA": { [gmrcStudent.nameInputCell]: "Regression Learner" },
    [gmrcTerm.sheetName]: { [gmrcScoreCell]: 8 },
  }, gmrcMap);
  const gmrcBefore = workbookSnapshot(gmrcOriginal);
  const gmrcAfter = workbookSnapshot(gmrcOutput);
  assert.equal(Object.values(gmrcBefore.formulas).reduce((total, cells) => total + cells.length, 0), 7851);
  assert.equal(Object.values(gmrcBefore.sheets).reduce((total, sheet) => total + (sheet["!merges"] || []).length, 0), 545);
  assert.deepEqual(gmrcAfter.formulas, gmrcBefore.formulas);
  for (const name of gmrcBefore.names) {
    assert.deepEqual(gmrcAfter.sheets[name]["!merges"], gmrcBefore.sheets[name]["!merges"]);
    assert.deepEqual(gmrcAfter.sheets[name]["!pageSetup"], gmrcBefore.sheets[name]["!pageSetup"]);
    assert.deepEqual(gmrcAfter.sheets[name]["!margins"], gmrcBefore.sheets[name]["!margins"]);
    assert.deepEqual(gmrcAfter.sheets[name]["!protect"], gmrcBefore.sheets[name]["!protect"]);
    assert.deepEqual(gmrcAfter.sheets[name]["!rows"], gmrcBefore.sheets[name]["!rows"]);
    assert.deepEqual(gmrcAfter.sheets[name]["!cols"], gmrcBefore.sheets[name]["!cols"]);
  }
});
