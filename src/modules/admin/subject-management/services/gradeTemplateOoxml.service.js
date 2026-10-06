const JSZip = require("jszip");
const XLSX = require("xlsx");
const { createGradeTemplateWorkbookMap } = require("./gradeTemplateWorkbookMap.service");


function decodeXml(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnIndex(cellAddress) {
  const letters = cellAddress.match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value;
}

function resolveWorksheetPaths(zip, workbookXml, relationshipsXml) {
  const relationshipTargets = new Map();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const id = match[1].match(/\bId="([^"]+)"/)?.[1];
    const target = match[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relationshipTargets.set(id, target.replace(/^\//, ""));
  }
  const sheets = new Map();
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const name = match[1].match(/\bname="([^"]+)"/)?.[1];
    const relationshipId = match[1].match(/\br:id="([^"]+)"/)?.[1];
    const target = relationshipTargets.get(relationshipId);
    if (!name || !target) continue;
    const path = target.startsWith("xl/") ? target : `xl/${target}`;
    if (!zip.file(path)) throw new Error(`Workbook worksheet part ${path} is missing.`);
    sheets.set(decodeXml(name), path);
  }
  return sheets;
}

function replaceCell(xml, cellAddress, value) {
  const escapedAddress = cellAddress.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cellPattern = new RegExp(`(<c\\b(?=[^>]*\\br="${escapedAddress}")[^>]*?)(?:\\s*/>|>([\\s\\S]*?)<\\/c>)`, "i");
  const existing = xml.match(cellPattern);
  const rowNumber = Number(cellAddress.match(/\d+/)?.[0]);
  if (!rowNumber) throw new Error(`Invalid cell address: ${cellAddress}`);
  let node;
  if (value === null || value === undefined || value === "") {
    node = existing ? `${existing[1]}></c>` : `<c r="${cellAddress}"/>`;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for ${cellAddress}.`);
    const opening = existing ? existing[1] : `<c r="${cellAddress}"`;
    const normalized = opening.replace(/\s+t="[^"]*"/i, "");
    node = `${normalized}><v>${String(value)}</v></c>`;
  } else {
    const opening = existing ? existing[1] : `<c r="${cellAddress}"`;
    const normalized = opening.replace(/\s+t="[^"]*"/i, "");
    const typedOpening = `${normalized} t="inlineStr"`;
    node = `${typedOpening}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }

  if (existing) return xml.replace(cellPattern, node);

  const sheetDataMatch = xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/i);
  if (!sheetDataMatch) throw new Error("Worksheet XML has no sheetData section.");
  const rowPattern = new RegExp(`<row\\b(?=[^>]*\\br="${rowNumber}")[^>]*>([\\s\\S]*?)<\\/row>`, "i");
  const rowMatch = sheetDataMatch[1].match(rowPattern);
  let updatedData;
  if (!rowMatch) {
    const newRow = `<row r="${rowNumber}">${node}</row>`;
    const rows = [...sheetDataMatch[1].matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/gi)];
    const after = rows.find((entry) => Number(entry[1]) > rowNumber);
    if (after) updatedData = sheetDataMatch[1].slice(0, after.index) + newRow + sheetDataMatch[1].slice(after.index);
    else updatedData = sheetDataMatch[1] + newRow;
  } else {
    const rowContent = rowMatch[1];
    const cells = [...rowContent.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/gi)];
    const targetColumn = columnIndex(cellAddress);
    const after = cells.find((entry) => columnIndex(entry[1]) > targetColumn);
    const insertedContent = after
      ? rowContent.slice(0, after.index) + node + rowContent.slice(after.index)
      : rowContent + node;
    const updatedRow = rowMatch[0].replace(rowContent, insertedContent);
    updatedData = sheetDataMatch[1].replace(rowMatch[0], updatedRow);
  }
  return xml.replace(sheetDataMatch[0], sheetDataMatch[0].replace(sheetDataMatch[1], updatedData));
}

function requestRecalculation(xml) {
  const calc = xml.match(/<calcPr\b([^>]*)\/?\s*>/i);
  if (calc) {
    // The optional slash in the source's self-closing tag may be captured by
    // the greedy attribute group above. Strip it before rebuilding the tag so
    // it cannot produce malformed XML such as `<calcPr ...//>`.
    let attrs = calc[1].replace(/\s*\/\s*$/, "").replace(/\s+(calcMode|fullCalcOnLoad|forceFullCalc)="[^"]*"/gi, "");
    attrs += ' calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"';
    return xml.replace(calc[0], `<calcPr${attrs}/>`);
  }
  return xml.replace(/<\/workbook>/i, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
}

function parseAttributes(tag) {
  const attributes = [];
  for (const match of tag.matchAll(/([^\s=<>/]+)="([^"]*)"/g)) {
    attributes.push([match[1], match[2]]);
  }
  return attributes;
}

function setAttribute(attributes, name, value) {
  const existing = attributes.find(([key]) => key === name);
  if (existing) existing[1] = String(value);
  else attributes.push([name, String(value)]);
}

function serializeColumn(attributes) {
  return `<col ${attributes.map(([name, value]) => `${name}="${escapeXml(value)}"`).join(" ")}/>`;
}

function patchColumnWidths(xml, requiredWidths) {
  const colsMatch = xml.match(/<cols\b[^>]*>([\s\S]*?)<\/cols>/i);
  const sheetFormat = xml.match(/<sheetFormatPr\b([^>]*)\/?\s*>/i)?.[1] || "";
  const defaultWidth = Number(sheetFormat.match(/\bdefaultColWidth="([\d.]+)"/)?.[1] || 8.43);
  const coveredColumns = new Set();
  const colTag = /<col\b[^>]*\/>/gi;
  let colXml = colsMatch?.[1] || "";

  if (colsMatch) {
    colXml = colXml.replace(colTag, (tag) => {
      const attributes = parseAttributes(tag);
      const minAttribute = attributes.find(([name]) => name === "min");
      const maxAttribute = attributes.find(([name]) => name === "max");
      if (!minAttribute || !maxAttribute) return tag;
      const min = Number(minAttribute[1]);
      const max = Number(maxAttribute[1]);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return tag;

      const declaredWidth = Number(attributes.find(([name]) => name === "width")?.[1]);
      const width = Number.isFinite(declaredWidth) ? declaredWidth : defaultWidth;
      const widthAt = (column) => Math.max(width, requiredWidths.get(column) || 0);
      const segments = [];
      let segmentStart = min;
      let segmentWidth = widthAt(min);
      for (let column = min; column <= max; column += 1) {
        if (requiredWidths.has(column)) coveredColumns.add(column);
        if (column === min) continue;
        const nextWidth = widthAt(column);
        if (nextWidth !== segmentWidth) {
          segments.push([segmentStart, column - 1, segmentWidth]);
          segmentStart = column;
          segmentWidth = nextWidth;
        }
      }
      segments.push([segmentStart, max, segmentWidth]);
      if (segments.length === 1 && segments[0][2] === width) return tag;

      return segments.map(([start, end, segmentWidthValue]) => {
        const segmentAttributes = attributes.map(([name, value]) => [name, value]);
        setAttribute(segmentAttributes, "min", start);
        setAttribute(segmentAttributes, "max", end);
        if (segmentWidthValue > width) {
          setAttribute(segmentAttributes, "width", segmentWidthValue);
          setAttribute(segmentAttributes, "customWidth", 1);
        }
        return serializeColumn(segmentAttributes);
      }).join("");
    });
  }

  const missingColumns = [...requiredWidths.entries()]
    .filter(([column]) => !coveredColumns.has(column))
    .filter(([, required]) => required > defaultWidth)
    .map(([column, required]) => ({
      column,
      xml: serializeColumn([["min", column], ["max", column], ["width", required], ["customWidth", 1]]),
    }));

  if (missingColumns.length) {
    const tags = [...colXml.matchAll(colTag)].map((match) => ({
      index: match.index,
      min: Number(parseAttributes(match[0]).find(([name]) => name === "min")?.[1] || 1),
      xml: match[0],
    }));
    let result = colXml;
    for (const missing of missingColumns.sort((left, right) => right.column - left.column)) {
      const next = tags.find((entry) => entry.min > missing.column);
      const insertAt = next ? next.index : result.length;
      result = `${result.slice(0, insertAt)}${missing.xml}${result.slice(insertAt)}`;
    }
    colXml = result;
  }

  if (colsMatch) {
    if (colXml === colsMatch[1]) return xml;
    return xml.replace(colsMatch[0], colsMatch[0].replace(colsMatch[1], colXml));
  }
  if (!missingColumns.length) return xml;
  return xml.replace(/<sheetData\b/i, `<cols>${missingColumns.map((entry) => entry.xml).join("")}</cols><sheetData`);
}

function getPercentageScoreColumnWidths(originalBuffer, map) {
  const hasMappedColumns = map?.terms?.length
    && map.terms.every((term) => Array.isArray(term.percentageScoreColumns));
  const workbookMap = hasMappedColumns ? map : createGradeTemplateWorkbookMap(originalBuffer);
  const workbook = XLSX.read(originalBuffer, { type: "buffer", cellFormula: true, cellNF: true });
  const widthsBySheet = {};

  for (const term of workbookMap.terms || []) {
    const sheet = workbook.Sheets[term.sheetName];
    if (!sheet) throw new Error(`Mapped worksheet ${term.sheetName} is missing from the template.`);
    const columns = new Map();
    for (const column of term.percentageScoreColumns) {
      for (const student of term.studentRows || []) {
        const address = XLSX.utils.encode_cell({ r: student.row - 1, c: column - 1 });
        const cell = sheet[address];
        if (!cell?.f) continue;
        const formattedMaximum = XLSX.SSF.format(cell.z || "General", 100);
        const neededWidth = String(formattedMaximum).length;
        if (neededWidth === 0) continue;
        columns.set(column, Math.max(columns.get(column) || 0, neededWidth));
      }
    }
    if (columns.size) widthsBySheet[term.sheetName] = columns;
  }
  return widthsBySheet;
}

function assertNoFormulaWrites(originalBuffer, writes) {
  const workbook = XLSX.read(originalBuffer, { type: "buffer", cellFormula: true });
  for (const [sheetName, cells] of Object.entries(writes)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Mapped worksheet ${sheetName} is missing from the template.`);
    for (const [cellAddress, value] of Object.entries(cells)) {
      if (sheet[cellAddress]?.f) throw new Error(`Export refused: ${sheetName}!${cellAddress} contains an official formula.`);
      if (value !== null && value !== undefined && typeof value !== "string" && typeof value !== "number") {
        throw new Error(`Export refused: unsupported raw input value at ${sheetName}!${cellAddress}.`);
      }
    }
  }
}

function assertWorkbookFormulaStructurePreserved(originalBuffer, outputBuffer) {
  const original = XLSX.read(originalBuffer, { type: "buffer", cellFormula: true });
  const output = XLSX.read(outputBuffer, { type: "buffer", cellFormula: true });
  if (JSON.stringify(original.SheetNames) !== JSON.stringify(output.SheetNames)) {
    throw new Error("Export verification failed: the original worksheet list changed.");
  }
  const originalVisibility = original.Workbook?.Sheets?.map((sheet) => [sheet.name, sheet.Hidden ?? 0]) || [];
  const outputVisibility = output.Workbook?.Sheets?.map((sheet) => [sheet.name, sheet.Hidden ?? 0]) || [];
  if (JSON.stringify(originalVisibility) !== JSON.stringify(outputVisibility)) {
    throw new Error("Export verification failed: worksheet visibility changed.");
  }
  for (const sheetName of original.SheetNames) {
    const sourceSheet = original.Sheets[sheetName];
    const outputSheet = output.Sheets[sheetName];
    const formulas = (sheet) => Object.entries(sheet)
      .filter(([key, cell]) => !key.startsWith("!") && cell?.f)
      .map(([key, cell]) => [key, cell.f])
      .sort(([left], [right]) => left.localeCompare(right));
    if (JSON.stringify(formulas(sourceSheet)) !== JSON.stringify(formulas(outputSheet))) {
      throw new Error(`Export verification failed: official formulas changed in ${sheetName}.`);
    }
    if (JSON.stringify(sourceSheet["!merges"] || []) !== JSON.stringify(outputSheet["!merges"] || [])) {
      throw new Error(`Export verification failed: merged cells changed in ${sheetName}.`);
    }
  }
}

async function patchOfficialWorkbook(originalBuffer, writes, map) {
  assertNoFormulaWrites(originalBuffer, writes);
  for (const [sheetName, cells] of Object.entries(writes)) {
    const approved = new Set(map.sheets?.[sheetName]?.rawInputCells || []);
    for (const cellAddress of Object.keys(cells)) {
      if (!approved.has(cellAddress)) throw new Error(`Export refused: ${sheetName}!${cellAddress} is outside the validated raw-input map.`);
    }
  }

  const zip = await JSZip.loadAsync(originalBuffer);
  const workbookFile = zip.file("xl/workbook.xml");
  const relationshipsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !relationshipsFile) throw new Error("The uploaded workbook is missing its OOXML workbook manifest.");
  const workbookXml = await workbookFile.async("string");
  const relationshipsXml = await relationshipsFile.async("string");
  const paths = resolveWorksheetPaths(zip, workbookXml, relationshipsXml);
  const percentageScoreWidths = getPercentageScoreColumnWidths(originalBuffer, map);

  for (const [sheetName, cells] of Object.entries(writes)) {
    const path = paths.get(sheetName);
    if (!path) throw new Error(`Could not resolve the worksheet part for ${sheetName}.`);
    const file = zip.file(path);
    let xml = await file.async("string");
    for (const [cellAddress, value] of Object.entries(cells)) xml = replaceCell(xml, cellAddress, value);
    zip.file(path, xml, { createFolders: false });
  }
  for (const [sheetName, widths] of Object.entries(percentageScoreWidths)) {
    const path = paths.get(sheetName);
    if (!path) throw new Error(`Could not resolve the worksheet part for ${sheetName}.`);
    const file = zip.file(path);
    let xml = await file.async("string");
    xml = patchColumnWidths(xml, widths);
    zip.file(path, xml, { createFolders: false });
  }
  zip.file("xl/workbook.xml", requestRecalculation(workbookXml), { createFolders: false });
  const outputBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  assertWorkbookFormulaStructurePreserved(originalBuffer, outputBuffer);
  return outputBuffer;
}

module.exports = { patchOfficialWorkbook };
