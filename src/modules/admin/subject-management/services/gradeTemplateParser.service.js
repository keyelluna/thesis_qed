const XLSX = require("xlsx");

function readGrid(sheet, maxRows = 200, maxCols = 80) {
  const values = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true, range: 0 });
  return values.slice(0, maxRows).map((row) => row.slice(0, maxCols));
}

function findCell(grid, pattern) {
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r] || []).length; c++) {
      const value = grid[r][c];
      if (typeof value === "string" && pattern.test(value.trim())) return [r, c];
    }
  }
  return null;
}

function findExact(grid, text, row, start, end) {
  const target = text.trim().toLowerCase();
  for (let c = start; c <= end; c++) {
    if (String(grid[row]?.[c] ?? "").trim().toLowerCase() === target) return c;
  }
  return null;
}

function numeric(value, scale = 1) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    throw new Error("A required grading value is missing or invalid in the uploaded template.");
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("A required grading value is missing or invalid in the uploaded template.");
  return Math.round(n * scale * 100) / 100;
}

function categoryWeight(value, label) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    throw new Error(`${label} weight is missing or invalid; expected a numeric fraction from 0 to 1.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${label} weight is missing or invalid; expected a numeric fraction from 0 to 1.`);
  return Math.round(n * 10000) / 100;
}

function parseGroup(grid, key, start, end, domainRow, headerRow, weightsRow) {
  const labels = [];
  for (let c = start; c <= end; c++) {
    const value = grid[domainRow]?.[c];
      if (typeof value === "string" && /domain\s*$/i.test(value.trim())) labels.push({ col: c, label: value.trim() });
  }
  const domains = labels.length
    ? labels.map((entry, i) => {
        const blockEnd = (labels[i + 1]?.col ?? end + 1) - 1;
        let wsCol = null;
        const scoreColumns = [];
        for (let c = entry.col; c <= blockEnd; c++) {
          if (String(grid[headerRow]?.[c] ?? "").trim().toLowerCase() === "ws") { wsCol = c; break; }
          if (/^\d+$/.test(String(grid[headerRow]?.[c] ?? "").trim())) scoreColumns.push(c + 1);
        }
        return { id: entry.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label: entry.label,
          weightPercent: categoryWeight(grid[weightsRow]?.[wsCol], entry.label), scoreColumns };
      })
    : [{ id: "default", label: "", weightPercent: categoryWeight(grid[weightsRow]?.[findExact(grid, "WS", headerRow, start, end)], key), scoreColumns: (() => { const cols = []; for (let c = start; c <= end; c++) { if (/^(total|ps|ws)$/i.test(String(grid[headerRow]?.[c] ?? "").trim())) break; if (/^\d+$/.test(String(grid[headerRow]?.[c] ?? "").trim())) cols.push(c + 1); } return cols; })() }];
  if (domains.some((domain) => !domain.scoreColumns.length)) throw new Error(`${key} has a domain with no numbered raw score columns.`);
  return { key, weightPercent: Math.round(domains.reduce((sum, d) => sum + d.weightPercent, 0) * 100) / 100, domains };
}

function parseGradeTemplate(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  const sheet = workbook.Sheets["TERM 1"];
  const helper = workbook.Sheets.HELPER;
  if (!sheet || !helper) throw new Error("The workbook must contain 'TERM 1' and 'HELPER' sheets.");
  const grid = readGrid(sheet);
  const wwPos = findCell(grid, /WRITTEN.*ORAL WORKS/i);
  const ptPos = findCell(grid, /PRODUCT.*PERFORMANCE/i);
  const exPos = findCell(grid, /EXAMINATIONS/i);
  const igPos = findCell(grid, /^Initial Grade$/i);
  const hpPos = findCell(grid, /HIGHEST POSSIBLE SCORE/i);
  if (!wwPos || !ptPos || !igPos || !hpPos || (exPos && exPos[1] <= ptPos[1])) throw new Error("Could not locate the grading sections and score headers in 'TERM 1'.");

  const weightsRow = hpPos[0];
  const headerRow = weightsRow - 1;
  const domainRow = headerRow - 1;
  const ww = parseGroup(grid, "writtenWorks", wwPos[1], ptPos[1] - 1, domainRow, headerRow, weightsRow);
  const pt = parseGroup(grid, "performanceTask", ptPos[1], (exPos?.[1] ?? igPos[1]) - 1, domainRow, headerRow, weightsRow);
  const examinations = exPos ? parseExaminations(grid, headerRow, weightsRow, exPos[1], igPos[1] - 1) : { enabled: false, categoryWeightPercent: 0, components: [], outputs: {} };
  const examWeightPercent = examinations.categoryWeightPercent;
  const weightSum = ww.weightPercent + pt.weightPercent + examWeightPercent;
  if (Math.abs(weightSum - 100) > 0.5) throw new Error(`WW + PT${examinations.enabled ? " + Exam" : ""} weights read ${weightSum}%, expected 100%.`);
  const examKeys = new Set(examinations.components.map((component) => component.key.toUpperCase()));
  const examSubWeights = examKeys.has("ST1") && examKeys.has("ST2") && examKeys.has("TE")
    ? Object.fromEntries(examinations.components.map((component) => [component.key.toLowerCase(), component.weightPercent]))
    : undefined;

  const helperGrid = readGrid(helper, 120, 20);
  const igMin = findCell(helperGrid, /^IG \(Min\.?\)$/i);
  const numGrade = findCell(helperGrid, /^Numerical Grade$/i);
  if (!igMin || !numGrade) throw new Error("Could not locate transmutation and descriptor tables in 'HELPER'.");
  const transmutationTable = [];
  for (let r = igMin[0] + 1; helperGrid[r]?.[igMin[1]] !== null && helperGrid[r]?.[igMin[1]] !== undefined; r++) {
    transmutationTable.push({ igMin: numeric(helperGrid[r][igMin[1]]), igMax: numeric(helperGrid[r][igMin[1] + 1]), transmuted: numeric(helperGrid[r][igMin[1] + 2]) });
  }
  const descriptorTable = [];
  for (let r = numGrade[0] + 1; helperGrid[r]?.[numGrade[1]] !== null && helperGrid[r]?.[numGrade[1]] !== undefined; r++) {
    descriptorTable.push({ numericalGrade: numeric(helperGrid[r][numGrade[1]]), descriptor: String(helperGrid[r][numGrade[1] + 1] ?? "") });
  }
  if (!transmutationTable.length || !descriptorTable.length) throw new Error("The HELPER transmutation or descriptor table is empty.");

  const structure = { ww, pt, examWeightPercent, examinations, examSubWeights, transmutationTable, descriptorTable };

  let activeGender = null;
  const studentRows = [];
  for (let r = weightsRow + 2; r < grid.length; r++) {
    const label = String(grid[r]?.[1] ?? "").trim().toUpperCase();
    if (label === "MALE" || label === "BOYS") activeGender = "M";
    else if (label === "FEMALE" || label === "GIRLS") activeGender = "F";
    else if (activeGender && Number.isInteger(Number(grid[r]?.[1])) && grid[r]?.[1] !== null) {
      studentRows.push({ row: r + 1, gender: activeGender });
    }
  }
  const firstStudent = studentRows[0];
  const nameMerge = firstStudent && (sheet["!merges"] || []).find((merge) => merge.s.r === firstStudent.row - 1 && merge.s.c >= 2 && merge.e.c >= merge.s.c);
  const nameColumn = nameMerge ? nameMerge.s.c + 1 : 3;
  const finalColumns = {
    initialGrade: findCell(grid, /^Initial Grade$/i)?.[1] + 1,
    termGrade: findCell(grid, /^Term Grade$/i)?.[1] + 1,
    descriptor: findCell(grid, /^Descriptor$/i)?.[1] + 1,
  };
  const layout = {
    scoreHeaderRow: headerRow + 1,
    highestPossibleRow: weightsRow + 1,
    nameColumn,
    studentRows,
    finalColumns,
    examScoreColumns: Object.fromEntries(examinations.components.map((component) => [component.key, component.scoreColumn + 1])),
    examWeightedScoreColumns: Object.fromEntries(examinations.components.filter((component) => component.weightedScoreColumn !== undefined).map((component) => [component.key, component.weightedScoreColumn + 1])),
    examPsColumn: examinations.outputs.percentageScoreColumn === undefined ? undefined : examinations.outputs.percentageScoreColumn + 1,
    examWeightedScoreColumn: examinations.outputs.weightedScoreColumn === undefined ? undefined : examinations.outputs.weightedScoreColumn + 1,
  };
  structure.layout = layout;
  return {
    structure,
    wwWeightPercent: ww.weightPercent,
    ptWeightPercent: pt.weightPercent,
    examWeightPercent,
    examSt1SubweightPercent: examSubWeights?.st1 ?? 0,
    examSt2SubweightPercent: examSubWeights?.st2 ?? 0,
    examTeSubweightPercent: examSubWeights?.te ?? 0,
  };
}

function parseExaminations(grid, headerRow, weightsRow, start, end) {
  const exact = (label) => findExact(grid, label, headerRow, start, end);
  const keys = ["ST1", "ST2", "TE"].filter((key) => exact(key) !== null);
  const overallWs = exact("WS");
  const ps = exact("PS");
  if (!keys.length || overallWs === null || ps === null) throw new Error("The Examination section is ambiguous or missing its PS/WS outputs.");
  const categoryValue = grid[weightsRow]?.[overallWs];
  const categoryRaw = categoryValue === null || categoryValue === undefined || (typeof categoryValue === "string" && !categoryValue.trim()) ? NaN : Number(categoryValue);
  if (!Number.isFinite(categoryRaw) || categoryRaw < 0 || categoryRaw > 1) throw new Error("Examination weight is missing or invalid.");
  const components = keys.length === 3
    ? keys.map((key) => {
      const weighted = exact(`WS ${key}`);
      if (weighted === null) throw new Error(`Examination component ${key} is missing its WS output.`);
      const weightPercent = numeric(grid[weightsRow]?.[weighted]);
      if (weightPercent < 0 || weightPercent > 100) throw new Error(`${key} examination component weight is invalid.`);
      return { key, label: key, scoreColumn: exact(key), weightedScoreColumn: weighted, weightPercent };
    })
    : keys.length === 1 && keys[0] === "TE" && exact("WS TE") === null
      ? [{ key: "TE", label: "TE", scoreColumn: exact("TE"), weightPercent: 100 }]
      : null;
  if (!components) throw new Error("Unsupported Examination layout. Supported layouts are ST1/ST2/TE with matching WS outputs, or a single TE input with PS and WS.");
  if (Math.abs(components.reduce((sum, component) => sum + component.weightPercent, 0) - 100) > 0.5) throw new Error("Examination component weights must total 100%.");
  return {
    enabled: true,
    categoryWeightPercent: Math.round(categoryRaw * 10000) / 100,
    components,
    outputs: { percentageScoreColumn: ps, weightedScoreColumn: overallWs },
  };
}

module.exports = { parseGradeTemplate };
