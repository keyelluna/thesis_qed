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
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * scale * 100) / 100 : 0;
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
          weightPercent: numeric(grid[weightsRow]?.[wsCol], 100), scoreColumns };
      })
    : [{ id: "default", label: "", weightPercent: numeric(grid[weightsRow]?.[findExact(grid, "WS", headerRow, start, end)], 100), scoreColumns: (() => { const cols = []; for (let c = start; c <= end; c++) { if (String(grid[headerRow]?.[c] ?? "").trim().toLowerCase() === "total") break; if (/^\d+$/.test(String(grid[headerRow]?.[c] ?? "").trim())) cols.push(c + 1); } return cols; })() }];
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
  if (!wwPos || !ptPos || !exPos || !igPos || !hpPos) throw new Error("Could not locate the grading sections and score headers in 'TERM 1'.");

  const weightsRow = hpPos[0];
  const headerRow = weightsRow - 1;
  const domainRow = headerRow - 1;
  const ww = parseGroup(grid, "writtenWorks", wwPos[1], ptPos[1] - 1, domainRow, headerRow, weightsRow);
  const pt = parseGroup(grid, "performanceTask", ptPos[1], exPos[1] - 1, domainRow, headerRow, weightsRow);
  const examStart = exPos[1], examEnd = igPos[1] - 1;
  const st1Col = findExact(grid, "WS ST1", headerRow, examStart, examEnd);
  const st2Col = findExact(grid, "WS ST2", headerRow, examStart, examEnd);
  const teCol = findExact(grid, "WS TE", headerRow, examStart, examEnd);
  const examPsCol = findExact(grid, "PS", headerRow, examStart, examEnd);
  const st1ScoreCol = findExact(grid, "ST1", headerRow, examStart, examEnd);
  const st2ScoreCol = findExact(grid, "ST2", headerRow, examStart, examEnd);
  const teScoreCol = findExact(grid, "TE", headerRow, examStart, examEnd);
  const examCol = findExact(grid, "WS", headerRow, examStart, examEnd);
  if ([st1Col, st2Col, teCol, examCol].some((v) => v === null)) throw new Error("Could not locate Exam ST1/ST2/TE and WS columns.");

  const examSubWeights = { st1: numeric(grid[weightsRow]?.[st1Col]), st2: numeric(grid[weightsRow]?.[st2Col]), te: numeric(grid[weightsRow]?.[teCol]) };
  const examWeightPercent = numeric(grid[weightsRow]?.[examCol], 100);
  const weightSum = ww.weightPercent + pt.weightPercent + examWeightPercent;
  if (Math.abs(weightSum - 100) > 0.5) throw new Error(`WW + PT + Exam weights read ${weightSum}%, expected 100%.`);
  if (Math.abs(examSubWeights.st1 + examSubWeights.st2 + examSubWeights.te - 100) > 0.5) throw new Error("ST1 + ST2 + TE sub-weights must total 100%.");

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

  const structure = { ww, pt, examWeightPercent, examSubWeights, transmutationTable, descriptorTable };

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
    examScoreColumns: { ST1: st1ScoreCol + 1, ST2: st2ScoreCol + 1, TE: teScoreCol + 1 },
    examWeightedScoreColumns: { ST1: st1Col + 1, ST2: st2Col + 1, TE: teCol + 1 },
    examPsColumn: examPsCol === null ? undefined : examPsCol + 1,
    examWeightedScoreColumn: examCol + 1,
  };
  structure.layout = layout;
  return {
    structure,
    wwWeightPercent: ww.weightPercent,
    ptWeightPercent: pt.weightPercent,
    examWeightPercent,
    examSt1SubweightPercent: examSubWeights.st1,
    examSt2SubweightPercent: examSubWeights.st2,
    examTeSubweightPercent: examSubWeights.te,
  };
}

module.exports = { parseGradeTemplate };
