const XLSX = require("xlsx");
const crypto = require("crypto");

const REQUIRED_SHEETS = ["INPUT DATA", "TERM 1", "TERM 2", "TERM 3", "FINAL GRADES", "HELPER"];
const WRITABLE_METADATA_LABELS = new Set([
  "SCHOOL YEAR",
  "SUBJECT TEACHER",
  "SUBJECT",
  "GRADE LEVEL",
  "SECTION",
]);

function address(row, column) {
  return XLSX.utils.encode_cell({ r: row - 1, c: column - 1 });
}

function readGrid(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
}

function findCell(grid, regex) {
  for (let r = 0; r < grid.length; r += 1) {
    for (let c = 0; c < (grid[r] || []).length; c += 1) {
      const value = grid[r][c];
      if (typeof value === "string" && regex.test(value.trim())) return { row: r + 1, column: c + 1 };
    }
  }
  return null;
}

function exactColumn(grid, row, start, end, label) {
  for (let c = start; c <= end; c += 1) {
    if (String(grid[row - 1]?.[c - 1] ?? "").trim().toLowerCase() === label.toLowerCase()) return c;
  }
  return null;
}

function studentRows(grid, sheet) {
  let gender = null;
  const rows = [];
  for (let r = 0; r < grid.length; r += 1) {
    const marker = String(grid[r]?.[1] ?? "").trim().toUpperCase();
    if (["MALE", "BOYS"].includes(marker)) gender = "M";
    else if (["FEMALE", "GIRLS"].includes(marker)) gender = "F";
    else if (gender && Number.isInteger(Number(grid[r]?.[1])) && grid[r]?.[1] !== null && grid[r]?.[1] !== "") {
      rows.push({ row: r + 1, gender, studentNumber: Number(grid[r][1]) });
    }
  }
  const first = rows[0];
  if (!first) throw new Error(`${sheet.name} has no recognizable learner rows.`);
  const numbersByGender = new Map();
  for (const entry of rows) {
    const next = numbersByGender.get(entry.gender) || 1;
    if (entry.studentNumber !== next) {
      throw new Error(`${sheet.name} has a non-sequential learner row in the ${entry.gender === "M" ? "male" : "female"} group.`);
    }
    numbersByGender.set(entry.gender, next + 1);
  }
  const merge = (sheet["!merges"] || []).find((entry) => entry.s.r === first.row - 1 && entry.s.c >= 2 && entry.e.c >= entry.s.c);
  const nameColumn = merge ? merge.s.c + 1 : 3;
  return rows.map((entry) => ({ ...entry, nameColumn }));
}

function parseNameSource(formula) {
  if (typeof formula !== "string") return null;
  const match = formula.match(/(?:'INPUT DATA'|INPUT DATA)!\$?([A-Z]{1,3})\$?(\d+)/i);
  return match ? `${match[1].toUpperCase()}${Number(match[2])}` : null;
}

function parseDomainColumns(grid, start, end, domainRow, headerRow) {
  const labels = [];
  for (let column = start; column <= end; column += 1) {
    const label = String(grid[domainRow - 1]?.[column - 1] ?? "").trim();
    if (/domain\s*$/i.test(label)) labels.push({ column, label });
  }
  if (!labels.length) {
    const columns = [];
    for (let column = start; column <= end; column += 1) {
      const header = String(grid[headerRow - 1]?.[column - 1] ?? "").trim();
      if (/^(total|ps|ws)$/i.test(header)) break;
      if (/^\d+$/.test(header)) columns.push(column);
    }
    return [{ id: "default", label: "", scoreColumns: columns }];
  }
  return labels.map((entry, index) => {
    const blockEnd = (labels[index + 1]?.column ?? end + 1) - 1;
    const columns = [];
    for (let column = entry.column; column <= blockEnd; column += 1) {
      const header = String(grid[headerRow - 1]?.[column - 1] ?? "").trim();
      if (/^(total|ps|ws)$/i.test(header)) break;
      if (/^\d+$/.test(header)) columns.push(column);
    }
    return {
      id: entry.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
      label: entry.label,
      scoreColumns: columns,
    };
  });
}

function parseWeightedDomains(grid, start, end, domainRow, headerRow, weightsRow) {
  const groups = parseDomainColumns(grid, start, end, domainRow, headerRow);
  const labels = [];
  for (let column = start; column <= end; column += 1) {
    const label = String(grid[domainRow - 1]?.[column - 1] ?? "").trim();
    if (/domain\s*$/i.test(label)) labels.push({ column, label });
  }
  for (let index = 0; index < groups.length; index += 1) {
    const left = labels[index]?.column ?? start;
    const right = labels[index + 1] ? labels[index + 1].column - 1 : end;
    let wsColumn = null;
    for (let column = left; column <= right; column += 1) {
      if (String(grid[headerRow - 1]?.[column - 1] ?? "").trim().toLowerCase() === "ws") {
        wsColumn = column;
        break;
      }
    }
    if (!wsColumn) throw new Error("A WW/PT grading domain is missing its WS weight column.");
    const raw = grid[weightsRow - 1]?.[wsColumn - 1];
    const rawWeight = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(rawWeight) || rawWeight < 0 || rawWeight > 1) {
      throw new Error(`The ${groups[index].label || "WW/PT"} weight is missing or invalid; expected a numeric fraction from 0 to 1.`);
    }
    groups[index].weightPercent = Math.round(rawWeight * 10000) / 100;
    if (!groups[index].scoreColumns.length) throw new Error(`The ${groups[index].label || "WW/PT"} domain has no numbered raw score columns.`);
  }
  return groups;
}

function numericWeight(value, label) {
  const weight = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw new Error(`${label} weight is missing or invalid.`);
  return Math.round(weight * 100) / 100;
}

function categoryWeight(value, label) {
  const weight = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error(`${label} weight is missing or invalid; expected a numeric fraction from 0 to 1.`);
  return Math.round(weight * 10000) / 100;
}

function parseExaminations(grid, headerRow, hpsRow, start, end) {
  const exact = (label) => exactColumn(grid, headerRow, start, end, label);
  const overallWsColumn = exact("WS");
  const psColumn = exact("PS");
  const keys = ["ST1", "ST2", "TE"].filter((key) => exact(key));
  if (!keys.length || !overallWsColumn || !psColumn) {
    throw new Error("The Examination section is ambiguous or missing its PS/WS outputs.");
  }
  const categoryWeightPercent = categoryWeight(grid[hpsRow - 1]?.[overallWsColumn - 1], "Examination");
  let components;
  if (keys.length === 3 && ["ST1", "ST2", "TE"].every((key) => keys.includes(key))) {
    components = keys.map((key) => {
      const scoreColumn = exact(key);
      const weightedScoreColumn = exact(`WS ${key}`);
      if (!weightedScoreColumn) throw new Error(`Examination component ${key} is missing its WS output.`);
      return {
        key,
        label: key,
        scoreColumn,
        weightedScoreColumn,
        weightPercent: numericWeight(grid[hpsRow - 1]?.[weightedScoreColumn - 1], `${key} examination component`),
      };
    });
  } else if (keys.length === 1 && keys[0] === "TE" && !exact("WS TE")) {
    components = [{ key: "TE", label: "TE", scoreColumn: exact("TE"), weightPercent: 100 }];
  } else {
    throw new Error("Unsupported Examination layout. Supported layouts are ST1/ST2/TE with matching WS outputs, or a single TE input with PS and WS.");
  }
  const componentTotal = components.reduce((sum, entry) => sum + entry.weightPercent, 0);
  if (Math.abs(componentTotal - 100) > 0.5) throw new Error("Examination component weights must total 100%.");
  return {
    enabled: true,
    categoryWeightPercent,
    components,
    outputs: { percentageScoreColumn: psColumn, weightedScoreColumn: overallWsColumn },
  };
}

function parseTerm(sheet, termNumber) {
  const grid = readGrid(sheet);
  const wwHeader = findCell(grid, /WRITTEN.*ORAL WORKS/i);
  const ptHeader = findCell(grid, /PRODUCT.*PERFORMANCE/i);
  const examHeader = findCell(grid, /EXAMINATIONS/i);
  const initialHeader = findCell(grid, /^Initial Grade$/i);
  const hpsHeader = findCell(grid, /HIGHEST POSSIBLE SCORE/i);
  if (!wwHeader || !ptHeader || !initialHeader || !hpsHeader || (examHeader && examHeader.column <= ptHeader.column)) {
    throw new Error(`Could not map raw input columns in ${sheet.name}.`);
  }
  const headerRow = hpsHeader.row - 1;
  const domainRow = headerRow - 1;
  const studentMap = studentRows(grid, sheet).map((entry) => {
    const cell = sheet[address(entry.row, entry.nameColumn)];
    const nameInputCell = parseNameSource(cell?.f);
    if (!nameInputCell) throw new Error(`Could not verify the INPUT DATA name source for ${sheet.name} row ${entry.row}.`);
    return { row: entry.row, gender: entry.gender, nameColumn: entry.nameColumn, nameInputCell };
  });
  if (new Set(studentMap.map((entry) => entry.row)).size !== studentMap.length
      || new Set(studentMap.map((entry) => entry.nameInputCell)).size !== studentMap.length) {
    throw new Error(`${sheet.name} maps multiple learner rows to the same name input.`);
  }
  const examinations = examHeader
    ? parseExaminations(grid, headerRow, hpsHeader.row, examHeader.column, initialHeader.column - 1)
    : { enabled: false, categoryWeightPercent: 0, components: [], outputs: {} };

  const percentageScoreColumns = [];
  for (let column = wwHeader.column; column < initialHeader.column; column += 1) {
    if (String(grid[headerRow - 1]?.[column - 1] ?? "").trim().toUpperCase() !== "PS") continue;
    if (studentMap.some((student) => sheet[address(student.row, column)]?.f)) {
      percentageScoreColumns.push(column);
    }
  }

  const groups = {
    writtenWorks: parseWeightedDomains(grid, wwHeader.column, ptHeader.column - 1, domainRow, headerRow, hpsHeader.row),
    performanceTask: parseWeightedDomains(grid, ptHeader.column, (examHeader?.column ?? initialHeader.column) - 1, domainRow, headerRow, hpsHeader.row),
  };
  const config = {
    ww: { key: "writtenWorks", weightPercent: groups.writtenWorks.reduce((sum, entry) => sum + entry.weightPercent, 0), domains: groups.writtenWorks },
    pt: { key: "performanceTask", weightPercent: groups.performanceTask.reduce((sum, entry) => sum + entry.weightPercent, 0), domains: groups.performanceTask },
    examWeightPercent: examinations.categoryWeightPercent,
    examinations,
    examSubWeights: examinations.enabled ? Object.fromEntries(examinations.components.map((component) => [component.key.toLowerCase(), component.weightPercent])) : undefined,
  };
  const totalWeight = config.ww.weightPercent + config.pt.weightPercent + config.examWeightPercent;
  if (Math.abs(totalWeight - 100) > 0.5) throw new Error(`WW + PT${examinations.enabled ? " + Exam" : ""} weights must total 100% in ${sheet.name}.`);
  const rawInputs = [];
  for (const domains of Object.values(groups)) {
    for (const domain of domains) {
      for (const column of domain.scoreColumns) {
        rawInputs.push(address(hpsHeader.row, column));
        for (const student of studentMap) rawInputs.push(address(student.row, column));
      }
    }
  }
  for (const component of examinations.components) {
    rawInputs.push(address(hpsHeader.row, component.scoreColumn));
    for (const student of studentMap) rawInputs.push(address(student.row, component.scoreColumn));
  }
  for (const cellAddress of new Set(rawInputs)) {
    if (sheet[cellAddress]?.f) {
      throw new Error(`${sheet.name} maps ${cellAddress} as a raw input, but it contains an official formula.`);
    }
  }

  return {
    termNumber,
    sheetName: `TERM ${termNumber}`,
    headerRow,
    highestPossibleRow: hpsHeader.row,
    studentRows: studentMap,
    groups,
    examinations,
    exams: Object.fromEntries(examinations.components.map((component) => [component.key, component.scoreColumn])),
    percentageScoreColumns,
    config,
    rawInputCells: [...new Set(rawInputs)],
  };
}

function formulaCells(sheet) {
  return Object.entries(sheet).filter(([key, cell]) => !key.startsWith("!") && cell?.f).map(([key]) => key);
}

function createGradeTemplateWorkbookMap(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: true });
  const missing = REQUIRED_SHEETS.filter((name) => !workbook.Sheets[name]);
  if (missing.length) throw new Error(`Workbook is missing required sheet(s): ${missing.join(", ")}.`);
  const terms = [1, 2, 3].map((termNumber) => parseTerm(workbook.Sheets[`TERM ${termNumber}`], termNumber));
  const inputDataCells = [...new Set(terms.flatMap((term) => term.studentRows.map((row) => row.nameInputCell)))];
  const termHeaderInputs = new Set();
  for (const term of terms) {
    const sheet = workbook.Sheets[term.sheetName];
    for (const [cellAddress, cell] of Object.entries(sheet)) {
      if (cell?.f && /INPUT DATA/i.test(cell.f)) {
        for (const match of cell.f.matchAll(/(?:'INPUT DATA'|INPUT DATA)!\$?([A-Z]{1,3})\$?(\d+)/gi)) {
          const ref = `${match[1].toUpperCase()}${Number(match[2])}`;
          if (!inputDataCells.includes(ref)) termHeaderInputs.add(ref);
        }
      }
    }
  }
  const inputDataGrid = readGrid(workbook.Sheets["INPUT DATA"]);
  const candidateMetadataCells = [...termHeaderInputs].map((ref) => {
    const decoded = XLSX.utils.decode_cell(ref);
    const label = String(inputDataGrid[decoded.r]?.[Math.max(0, decoded.c - 2)] ?? "")
      .trim().replace(/:$/, "").toUpperCase();
    return { cell: ref, label };
  });
  const metadataFields = candidateMetadataCells.filter((entry) => WRITABLE_METADATA_LABELS.has(entry.label));
  const classifiedMetadataCells = new Set(metadataFields.map((entry) => entry.cell));
  const unclassifiedReferencedCells = candidateMetadataCells
    .filter((entry) => !classifiedMetadataCells.has(entry.cell))
    .map((entry) => entry.cell);
  const safeInputDataCells = [...new Set([...inputDataCells, ...metadataFields.map((entry) => entry.cell)])];
  const dataSheet = workbook.Sheets["INPUT DATA"];
  for (const ref of safeInputDataCells) {
    if (dataSheet[ref]?.f) throw new Error(`INPUT DATA ${ref} is formula-driven and cannot be treated as a raw input.`);
  }
  const sheets = {};
  for (const name of REQUIRED_SHEETS) {
    const sheet = workbook.Sheets[name];
    sheets[name] = {
      formulaCells: formulaCells(sheet),
      rawInputCells: name === "INPUT DATA" ? safeInputDataCells : name.startsWith("TERM ")
        ? terms.find((term) => term.sheetName === name).rawInputCells
        : [],
      protectedCells: name === "INPUT DATA"
        ? [...new Set([...formulaCells(sheet), ...unclassifiedReferencedCells])]
        : formulaCells(sheet),
      metadataFields: name === "INPUT DATA" ? metadataFields : [],
      reference: name === "HELPER" || name === "FINAL GRADES",
    };
  }
  return {
    version: 3,
    workbookChecksumSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    sheets,
    terms,
  };
}

module.exports = { createGradeTemplateWorkbookMap };
