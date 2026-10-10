const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");
const storageModule = require("../src/services/templateStorage.service");
const { createTemplateStorage, sha256, createS3Adapter, adapterFromEnv } = storageModule;
const { migrateTemplates, readLegacyWorkbook } = require("../scripts/migrate-template-storage");
const { createGradeTemplateWorkbookMap } = require("../src/modules/admin/subject-management/services/gradeTemplateWorkbookMap.service");
const JSZip = require("jszip");
const XLSX = require("xlsx");
const legacyDir = path.resolve(__dirname, "../uploads/grade-templates");

function fakeStorage() {
  const objects = new Map();
  const reads = [];
  const adapter = {
    async get(key) { reads.push(key); return objects.has(key) ? Buffer.from(objects.get(key)) : null; },
    async exists(key) { return objects.has(key); },
    async putNew(key, bytes) { assert.equal(objects.has(key), false, "every creation must have a fresh key"); objects.set(key, Buffer.from(bytes)); },
  };
  return { storage: createTemplateStorage({ adapter }), objects, reads };
}
async function fixture() {
  const name = (await fs.readdir(legacyDir)).find((name) => name.startsWith("3-1791291903020-"));
  const bytes = await fs.readFile(path.join(legacyDir, name));
  return { bytes, name, checksum: sha256(bytes), map: createGradeTemplateWorkbookMap(Buffer.from(bytes)) };
}
async function temporaryFiles(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qed-storage-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function modulesWithDb(t, db, storage) {
  const names = ["../config/db", "../src/services/templateStorage.service", "../src/modules/shared/grades/gradeTemplateResolution.service", "../src/modules/admin/subject-management/subjectGradeTemplate.controller", "../src/modules/shared/grades/gradeCache.service"];
  const ids = names.map((name) => require.resolve(name));
  const saved = ids.map((id) => require.cache[id]);
  for (const id of ids) delete require.cache[id];
  const mock = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
  mock(ids[0], db);
  mock(ids[1], { ...storageModule, ...storage });
  mock(ids[4], { recalcAllStudentsForSubject: async () => {} });
  t.after(() => ids.forEach((id, i) => { if (saved[i]) require.cache[id] = saved[i]; else delete require.cache[id]; }));
  return { controller: require(ids[3]), resolver: require(ids[2]) };
}
function response() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; },
    attachment(name) { this.headers["Content-Disposition"] = `attachment; filename="${name}"`; },
    status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } };
}
function exportDb(pinned) {
  const calls = [];
  return { calls, async execute(sql) {
    calls.push(sql);
    if (sql.includes("INNER JOIN teacher_table")) return [[{ subjectSectionId: 22, subjectId: 3, schoolYearId: 2, sectionId: 9, termNumber: 1 }]];
    if (sql.includes("FROM elem_students")) return [[]];
    if (sql.includes("INNER JOIN grading_periods")) return [[{ subjectId: 3, schoolYearId: 2, termNumber: 1 }]];
    if (sql.includes("FROM subject_grade_template_periods p")) return [[pinned]];
    if (sql.includes("FROM grade_items")) return [[]];
    throw new Error("Unexpected query");
  } };
}
function pinnedRow(f, key) {
  return { templateId: 7, subjectId: 3, fileName: "historical-a.xlsx", filePath: "C:\\unavailable\\a.xlsx", storageKey: key,
    checksum: f.checksum, structureJson: JSON.stringify({ ww: { weightPercent: 20 }, pt: { weightPercent: 50 } }),
    exportMapJson: JSON.stringify(f.map), is_active: 0 };
}

test("storage stores exact bytes and generates a fresh UUID key even for identical uploads", async () => {
  const f = await fixture(); const fake = fakeStorage();
  const key = await fake.storage.storeTemplate({ versionId: "version-a", bytes: f.bytes, checksum: f.checksum });
  assert.match(key, new RegExp(`^grade-templates/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/${f.checksum}\\.xlsx$`));
  assert.deepEqual(fake.objects.get(key), f.bytes);
  assert.equal(await fake.storage.templateExists({ storageKey: key }), true);
  assert.deepEqual(await fake.storage.getTemplate({ storageKey: key, checksum: f.checksum }), f.bytes);
  const repeat = await fake.storage.storeTemplate({ versionId: "version-a", bytes: f.bytes, checksum: f.checksum });
  assert.notEqual(repeat, key); assert.deepEqual(fake.objects.get(repeat), f.bytes);
  const changed = Buffer.from("different");
  const other = await fake.storage.storeTemplate({ versionId: "version-b", bytes: changed, checksum: sha256(changed) });
  assert.notEqual(other, key); assert.deepEqual(fake.objects.get(key), f.bytes);
});
test("checksum mismatch and missing object fail closed, even if a legacy file exists", async (t) => {
  const dir = await temporaryFiles(t); const filePath = path.join(dir, "old.xlsx");
  const bytes = Buffer.from("old master"); await fs.writeFile(filePath, bytes);
  const fake = fakeStorage(); fake.objects.set("wrong", Buffer.from("tampered"));
  await assert.rejects(fake.storage.getTemplate({ storageKey: "wrong", filePath, checksum: sha256(bytes) }), { code: "TEMPLATE_INTEGRITY", statusCode: 409 });
  await assert.rejects(fake.storage.getTemplate({ storageKey: "missing", filePath, checksum: sha256(bytes) }), { code: "TEMPLATE_UNAVAILABLE", statusCode: 409 });
  assert.equal(await fake.storage.templateExists({ storageKey: "missing", filePath }), false);
});
test("legacy existing workbook is verified; missing file and invalid checksum refuse retrieval", async (t) => {
  const dir = await temporaryFiles(t); const filePath = path.join(dir, "legacy.xlsx"); const bytes = Buffer.from("master");
  await fs.writeFile(filePath, bytes); const fake = fakeStorage();
  assert.deepEqual(await fake.storage.getTemplate({ filePath, checksum: sha256(bytes) }), bytes);
  await assert.rejects(fake.storage.getTemplate({ filePath, checksum: "a".repeat(64) }), { code: "TEMPLATE_INTEGRITY" });
  await assert.rejects(fake.storage.getTemplate({ filePath: path.join(dir, "missing.xlsx"), checksum: sha256(bytes) }), { code: "TEMPLATE_UNAVAILABLE" });
  assert.deepEqual(fake.reads, []);
});
test("S3 adapter uses ordinary private writes and stream retrieval without condition or public ACL", async () => {
  const calls = []; const bytes = Buffer.from("master");
  const adapter = createS3Adapter({ bucket: "private-test", client: { async send(command) {
    calls.push(command);
    if (command.constructor.name === "GetObjectCommand") return { Body: Readable.from([bytes]) };
    return {};
  } } });
  await adapter.putNew("key", bytes); await adapter.exists("key");
  assert.deepEqual(await adapter.get("key"), bytes);
  assert.equal(calls[0].input.IfNoneMatch, undefined); assert.equal(calls[0].input.ACL, undefined);
  assert.deepEqual(calls[0].input.Body, bytes);
});
test("S3 adapter propagates upload failures and distinguishes missing objects from access failures", async () => {
  const adapter = createS3Adapter({ bucket: "test", client: { async send(command) {
    throw Object.assign(new Error("test"), { $metadata: { httpStatusCode: command.constructor.name === "PutObjectCommand" ? 412 : 404 } });
  } } });
  await assert.rejects(adapter.putNew("key", Buffer.from("a"))); assert.equal(await adapter.get("key"), null); assert.equal(await adapter.exists("key"), false);
  const blocked = createTemplateStorage({ adapter: { get: async () => { throw new Error("SECRET credentials /internal/path"); } } });
  await assert.rejects(blocked.getTemplate({ storageKey: "key", checksum: "a".repeat(64) }), (error) => error.statusCode === 503 && !error.message.includes("SECRET"));
});
test("configuration is lazy for legacy retrieval and requires backend credentials for new uploads", async () => {
  assert.throws(() => adapterFromEnv({}), { code: "TEMPLATE_STORAGE_CONFIG", statusCode: 503 });
  const bytes = Buffer.from("master");
  const storage = createTemplateStorage({ getAdapter: () => adapterFromEnv({}) });
  await assert.rejects(storage.storeTemplate({ versionId: "a", bytes, checksum: sha256(bytes) }), { code: "TEMPLATE_STORAGE_CONFIG" });
});
test("provider-neutral B2 config infers the exact signing region and maps application credentials", () => {
  let captured;
  const env = { TEMPLATE_STORAGE_ENDPOINT: "https://s3.us-west-004.backblazeb2.com", TEMPLATE_STORAGE_BUCKET: "qed-grade-templates",
    TEMPLATE_STORAGE_ACCESS_KEY_ID: "fake-key-id", TEMPLATE_STORAGE_SECRET_ACCESS_KEY: "fake-application-key" };
  adapterFromEnv(env, (config) => { captured = config; return { send() {} }; });
  assert.equal(captured.region, "us-west-004"); assert.equal(captured.endpoint, env.TEMPLATE_STORAGE_ENDPOINT);
  assert.equal(captured.forcePathStyle, true);
  assert.equal(captured.credentials.accessKeyId, env.TEMPLATE_STORAGE_ACCESS_KEY_ID);
  assert.equal(captured.credentials.secretAccessKey, env.TEMPLATE_STORAGE_SECRET_ACCESS_KEY);
  assert.equal(captured.requestChecksumCalculation, "WHEN_REQUIRED");
  assert.equal(captured.responseChecksumValidation, "WHEN_REQUIRED");
  assert.equal(captured.maxAttempts, 1);
  adapterFromEnv({ ...env, TEMPLATE_STORAGE_REGION: "us-west-004" }, () => ({ send() {} }));
  for (const region of ["auto", "us-east-005"]) assert.throws(() => adapterFromEnv({ ...env, TEMPLATE_STORAGE_REGION: region }), { code: "TEMPLATE_STORAGE_CONFIG" });
});
test("neutral config rejects insecure/malformed/bucket endpoints without exposing input", () => {
  const env = { TEMPLATE_STORAGE_BUCKET: "qed-grade-templates", TEMPLATE_STORAGE_ACCESS_KEY_ID: "fake", TEMPLATE_STORAGE_SECRET_ACCESS_KEY: "fake", TEMPLATE_STORAGE_REGION: "us-west-004" };
  for (const endpoint of ["not-an-endpoint", "http://s3.us-west-004.backblazeb2.com", "https://user:private@s3.us-west-004.backblazeb2.com", "https://s3.us-west-004.backblazeb2.com/qed-grade-templates", "https://s3.us-west-004.backblazeb2.com?secret=private"]) {
    assert.throws(() => adapterFromEnv({ ...env, TEMPLATE_STORAGE_ENDPOINT: endpoint }), (error) => error.code === "TEMPLATE_STORAGE_CONFIG" && !error.message.includes("private"));
  }
  assert.throws(() => adapterFromEnv({ R2_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "fake", R2_SECRET_ACCESS_KEY: "fake", R2_BUCKET_NAME: "bucket" }), { code: "TEMPLATE_STORAGE_CONFIG" });
});
test("other S3 providers use an explicit neutral endpoint and region", () => {
  const env = { TEMPLATE_STORAGE_ENDPOINT: "https://example.r2.cloudflarestorage.com", TEMPLATE_STORAGE_REGION: "auto", TEMPLATE_STORAGE_BUCKET: "bucket", TEMPLATE_STORAGE_ACCESS_KEY_ID: "fake", TEMPLATE_STORAGE_SECRET_ACCESS_KEY: "fake" };
  let captured; adapterFromEnv(env, (config) => { captured = config; return {}; });
  assert.equal(captured.region, "auto");
  assert.throws(() => adapterFromEnv({ ...env, TEMPLATE_STORAGE_REGION: "" }), { code: "TEMPLATE_STORAGE_CONFIG" });
});
test("upload controller associates original bytes and storage key with the newly inserted version", async (t) => {
  const f = await fixture(); const fake = fakeStorage(); const inserts = []; const events = [];
  const conn = { async beginTransaction() { events.push("begin"); }, async commit() { events.push("commit"); }, async rollback() { events.push("rollback"); }, release() {},
    async query(sql, values) {
      if (sql.includes("SELECT id FROM elem_subjects")) return [[{ id: 3 }]];
      if (sql.includes("INSERT INTO subject_grade_templates")) { inserts.push({ sql, values }); return [{ insertId: 101 }]; }
      if (sql.includes("UPDATE subject_grade_templates")) return [{ affectedRows: 1 }];
      throw new Error("Unexpected query");
    } };
  const db = { getConnection: async () => conn, query: async () => [[]] };
  const { controller } = modulesWithDb(t, db, fake.storage); const res = response();
  await controller.uploadGradeTemplate({ params: { subjectId: "3" }, user: { userId: 1 }, file: { buffer: f.bytes, originalname: "official.xlsx" } }, res);
  assert.equal(res.statusCode, 201); assert.equal(res.body.data.id, 101);
  assert.match(inserts[0].sql, /storage_key/); const values = inserts[0].values;
  assert.equal((inserts[0].sql.match(/\?/g) || []).length, values.length);
  assert.equal(values[2], ""); assert.equal(values[4], f.checksum);
  assert.ok(fake.objects.get(values[3]).equals(f.bytes)); assert.match(values[3], /^grade-templates\/[a-f0-9-]+\//);
  assert.deepEqual(events, ["begin", "commit"]);
});
test("failed durable upload rolls back version activation instead of writing locally", async (t) => {
  const f = await fixture(); let rolledBack = false; let committed = false; let inserted = false;
  const db = { getConnection: async () => ({ beginTransaction: async () => {}, rollback: async () => { rolledBack = true; }, commit: async () => { committed = true; }, release() {},
    query: async (sql) => { if (sql.includes("INSERT")) inserted = true; return sql.includes("SELECT") ? [[{ id: 3 }]] : [{}]; } }) };
  const broken = createTemplateStorage({ getAdapter: () => adapterFromEnv({}) });
  const { controller } = modulesWithDb(t, db, broken); const res = response();
  await controller.uploadGradeTemplate({ params: { subjectId: "3" }, user: { userId: 1 }, file: { buffer: f.bytes, originalname: "a.xlsx" } }, res);
  assert.equal(res.statusCode, 503); assert.equal(rolledBack, true); assert.equal(committed, false); assert.equal(inserted, false);
});
test("export retrieves inactive pinned A even after B becomes active; OOXML and master are preserved", async (t) => {
  const f = await fixture(); const fake = fakeStorage();
  const a = await fake.storage.storeTemplate({ versionId: "a", bytes: f.bytes, checksum: f.checksum });
  await fake.storage.storeTemplate({ versionId: "b", bytes: Buffer.from("new version"), checksum: sha256(Buffer.from("new version")) });
  fake.reads.length = 0;
  const db = exportDb(pinnedRow(f, a)); const { controller } = modulesWithDb(t, db, fake.storage); const res = response();
  await controller.exportGradeTemplateBySection({ params: { subjectSectionId: "22" }, query: { gradingPeriodId: "1" }, user: { userId: 1 } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.headers["X-QED-Template-Version"], "7");
  assert.deepEqual(fake.reads, [a]); assert.equal(db.calls.some((sql) => sql.includes("is_active = 1")), false);
  assert.deepEqual(fake.objects.get(a), f.bytes);
  const original = await JSZip.loadAsync(f.bytes); const exported = await JSZip.loadAsync(res.body);
  assert.deepEqual(Object.keys(exported.files).sort(), Object.keys(original.files).sort());
  // Only the existing patcher's INPUT DATA/TERM worksheets and workbook recalculation XML can change.
  for (const name of Object.keys(original.files).filter((name) => !original.files[name].dir)) {
    if (name === "xl/workbook.xml" || /^xl\/worksheets\/sheet[1-4]\.xml$/.test(name)) continue;
    assert.deepEqual(await exported.file(name).async("nodebuffer"), await original.file(name).async("nodebuffer"), `unchanged package part ${name}`);
  }
  const before = XLSX.read(f.bytes, { type: "buffer", cellFormula: true }); const after = XLSX.read(res.body, { type: "buffer", cellFormula: true });
  assert.deepEqual(before.Workbook.Names, after.Workbook.Names);
  for (const name of before.SheetNames) {
    for (const [address, cell] of Object.entries(before.Sheets[name])) if (cell?.f) assert.equal(after.Sheets[name][address].f, cell.f);
    assert.deepEqual(after.Sheets[name]["!merges"], before.Sheets[name]["!merges"]);
  }
  for (const name of Object.keys(original.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) {
    const beforeXml = await original.file(name).async("string");
    const afterXml = await exported.file(name).async("string");
    const metadata = (xml) => xml.match(/<(sheetProtection|sheetPr|sheetViews|sheetFormatPr|pageMargins|pageSetup|printOptions|headerFooter|drawing|legacyDrawing|mergeCells|rowBreaks|colBreaks)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g) || [];
    assert.deepEqual(metadata(afterXml), metadata(beforeXml), `worksheet metadata preserved: ${name}`);
    const rows = (xml) => xml.match(/<row\b[^>]*>/g) || [];
    assert.deepEqual(rows(afterXml), rows(beforeXml), `row attributes preserved: ${name}`);
  }
});
for (const mode of ["missing-object", "wrong-checksum", "missing-legacy"]) {
  test(`export ${mode} preserves 409 and never consults a newer active template`, async (t) => {
    const f = await fixture(); const fake = fakeStorage(); const row = pinnedRow(f, mode === "missing-legacy" ? null : "pinned-a");
    if (mode === "wrong-checksum") fake.objects.set("pinned-a", Buffer.from("tampered"));
    const db = exportDb(row); const { controller } = modulesWithDb(t, db, fake.storage); const res = response();
    await controller.exportGradeTemplateBySection({ params: { subjectSectionId: "22" }, query: { gradingPeriodId: "1" }, user: { userId: 1 } }, res);
    assert.equal(res.statusCode, 409); assert.match(res.body.message, mode === "wrong-checksum" ? /integrity/ : /unavailable/);
    assert.equal(db.calls.some((sql) => sql.includes("is_active = 1")), false);
    assert.equal(res.body.message.includes("C:"), false); assert.equal(res.body.message.includes("pinned-a"), false);
  });
}
test("active template download uses the same verified durable storage", async (t) => {
  const f = await fixture(); const fake = fakeStorage(); fake.objects.set("active", f.bytes);
  const { controller } = modulesWithDb(t, { query: async () => [[{ storageKey: "active", checksum: f.checksum, fileName: "official.xlsx" }]] }, fake.storage);
  const res = response(); await controller.downloadActiveGradeTemplateBySection({ params: { subjectSectionId: "22" } }, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, f.bytes); assert.match(res.headers["Content-Type"], /spreadsheetml/);
});
test("migration recovers Windows basename with checksum and preserves inactive ID/pins/configuration", async (t) => {
  const dir = await temporaryFiles(t); const bytes = Buffer.from("exact historical master");
  await fs.writeFile(path.join(dir, "7-old-original.xlsx"), bytes);
  const row = { templateId: 7, filePath: "Z:\\old-machine\\7-old-original.xlsx", fileName: "original.xlsx", checksum: sha256(bytes), storageKey: null, is_active: 0 };
  const originalRow = { ...row }; const writes = []; const fake = fakeStorage();
  const db = { async execute(sql, values) { if (sql.startsWith("SELECT")) return [[row]]; writes.push({ sql, values }); return [{ affectedRows: 1 }]; } };
  const result = await migrateTemplates({ db, templateStorage: fake.storage, apply: true, legacyDir: dir, report() {} });
  assert.equal(result.migrated, 1); assert.equal(result.failed, 0); assert.deepEqual(row, originalRow);
  assert.equal(writes[0].values[1], 7); assert.match(writes[0].sql, /SET storage_key = \?/);
  assert.equal(writes[0].sql.includes("is_active"), false); assert.equal(writes[0].sql.includes("template_periods"), false);
  assert.deepEqual(fake.objects.get(writes[0].values[0]), bytes);
  assert.deepEqual(await fs.readFile(path.join(dir, "7-old-original.xlsx")), bytes);
});
test("migration dry run performs no uploads or writes; rejects mismatched and missing checksums", async (t) => {
  const dir = await temporaryFiles(t); const bytes = Buffer.from("master"); const filePath = path.join(dir, "master.xlsx"); await fs.writeFile(filePath, bytes);
  const rows = [{ templateId: 7, filePath, checksum: sha256(bytes) }, { templateId: 8, filePath, checksum: "a".repeat(64) }, { templateId: 9, filePath, checksum: null }];
  const fake = fakeStorage(); let writes = 0;
  const db = { async execute(sql) { if (sql.startsWith("SELECT")) return [rows]; writes++; return [{}]; } };
  const result = await migrateTemplates({ db, templateStorage: fake.storage, legacyDir: dir, report() {} });
  assert.equal(result.eligible, 1); assert.equal(result.failed, 2); assert.equal(writes, 0); assert.equal(fake.objects.size, 0);
  await assert.rejects(readLegacyWorkbook(rows[1], dir), { code: "TEMPLATE_INTEGRITY" });
});
test("migration apply refuses mismatched bytes and concurrent DB changes", async (t) => {
  const dir = await temporaryFiles(t); const filePath = path.join(dir, "master.xlsx"); const bytes = Buffer.from("master"); await fs.writeFile(filePath, bytes);
  const rows = [{ templateId: 7, filePath, checksum: "a".repeat(64) }, { templateId: 8, filePath, checksum: sha256(bytes) }];
  const fake = fakeStorage(); let writes = 0;
  const result = await migrateTemplates({ db: { async execute(sql) { if (sql.startsWith("SELECT")) return [rows]; writes++; return [{ affectedRows: 0 }]; } }, templateStorage: fake.storage, apply: true, legacyDir: dir, report() {} });
  assert.equal(result.failed, 2); assert.equal(result.migrated, 0); assert.equal(writes, 1); assert.equal(fake.objects.size, 1);
});
test("migration rerun verifies durable rows and performs no replacement uploads or DB changes", async () => {
  const fake = fakeStorage(); const bytes = Buffer.from("master"); fake.objects.set("existing", bytes);
  let writes = 0; const rows = [{ templateId: 7, storageKey: "existing", checksum: sha256(bytes) }];
  const result = await migrateTemplates({ db: { async execute(sql) { if (sql.startsWith("SELECT")) return [rows]; writes++; } }, templateStorage: fake.storage, apply: true, report() {} });
  assert.equal(result.verified, 1); assert.equal(writes, 0); assert.equal(fake.objects.size, 1);
});
test("caller-supplied identities cannot cause reuse or overwrite of an existing object", async () => {
  const fake = fakeStorage(); const bytes = Buffer.from("master"); const checksum = sha256(bytes);
  const key = `grade-templates/a/${checksum}.xlsx`; fake.objects.set(key, Buffer.from("tampered"));
  const created = await fake.storage.storeTemplate({ versionId: "a", storageKey: key, bytes, checksum });
  assert.notEqual(created, key); assert.deepEqual(fake.objects.get(created), bytes);
  assert.equal(fake.objects.get(key).toString(), "tampered");
});
test("migration original filename lookup requires checksum and cannot trust another version", async (t) => {
  const dir = await temporaryFiles(t); const bytes = Buffer.from("historical");
  await fs.writeFile(path.join(dir, "8-new-original.xlsx"), Buffer.from("new"));
  await fs.writeFile(path.join(dir, "7-old-original.xlsx"), bytes);
  const row = { filePath: "Z:\\lost\\unknown.xlsx", fileName: "original.xlsx", checksum: sha256(bytes) };
  assert.ok((await readLegacyWorkbook(row, dir)).equals(bytes));
  await assert.rejects(readLegacyWorkbook({ ...row, checksum: "a".repeat(64) }, dir), { migrationCode: "CHECKSUM_MISMATCH" });
});
for (const failure of ["read-back", "commit"]) {
  test(`upload ${failure} failure creates no DB association and preserves existing version`, async (t) => {
    const f = await fixture(); const objects = new Map();
    const storage = createTemplateStorage({ adapter: {
      async putNew(key, bytes) { assert.equal(objects.has(key), false); objects.set(key, Buffer.from(bytes)); },
      async get(key) { return failure === "read-back" ? Buffer.from("corrupted read-back") : Buffer.from(objects.get(key)); },
      async exists() { throw new Error("creation must not check existence"); },
    } });
    const existing = { id: 7, storage_key: "historical-a", checksum_sha256: f.checksum, is_active: 1 };
    const before = { ...existing }; let staged = null; let inserted = false; let rolledBack = false;
    const conn = {
      async beginTransaction() { staged = { ...existing }; },
      async query(sql, values) {
        if (sql.includes("SELECT id FROM elem_subjects")) return [[{ id: 3 }]];
        if (sql.startsWith("UPDATE")) { staged.is_active = 0; return [{}]; }
        if (sql.startsWith("INSERT")) { inserted = true; return [{ insertId: 8 }]; }
        throw new Error("Unexpected mock query");
      },
      async commit() { throw new Error("simulated DB commit failure"); },
      async rollback() { staged = null; rolledBack = true; }, release() {},
    };
    const { controller } = modulesWithDb(t, { getConnection: async () => conn }, storage);
    const res = response(); await controller.uploadGradeTemplate({ params: { subjectId: "3" }, user: { userId: 1 }, file: { buffer: f.bytes, originalname: "b.xlsx" } }, res);
    assert.equal(res.statusCode, failure === "read-back" ? 409 : 500);
    assert.equal(inserted, failure === "commit"); assert.equal(rolledBack, true); assert.equal(staged, null);
    assert.deepEqual(existing, before); assert.equal(objects.size, 1, "owned orphan is retained; no unsafe deletion");
    assert.ok([...objects.values()][0].equals(f.bytes));
  });
}
test("migration retry after failed association creates another fresh object; associated rerun only verifies", async (t) => {
  const dir = await temporaryFiles(t); const bytes = Buffer.from("exact immutable migration master"); const filePath = path.join(dir, "legacy.xlsx"); await fs.writeFile(filePath, bytes);
  const row = { templateId: 7, filePath, checksum: sha256(bytes), storageKey: null }; const fake = fakeStorage();
  let associations = 0; const keys = [];
  const db = { async execute(sql, values) {
    if (sql.startsWith("SELECT")) return [[{ ...row }]];
    keys.push(values[0]); associations++;
    if (associations === 1) return [{ affectedRows: 0 }];
    row.storageKey = values[0]; return [{ affectedRows: 1 }];
  } };
  const run = () => migrateTemplates({ db, templateStorage: fake.storage, apply: true, legacyDir: dir, report() {} });
  assert.equal((await run()).failed, 1); assert.equal(row.storageKey, null);
  const firstKey = keys[0]; const firstBytes = Buffer.from(fake.objects.get(firstKey));
  assert.equal((await run()).migrated, 1); assert.notEqual(keys[1], firstKey);
  assert.ok(fake.objects.get(firstKey).equals(firstBytes)); assert.ok(fake.objects.get(keys[1]).equals(bytes));
  assert.equal((await run()).verified, 1); assert.equal(keys.length, 2); assert.equal(fake.objects.size, 2); assert.equal(row.templateId, 7);
});
test("checksum failure before creation performs no put or existence check", async () => {
  let puts = 0;
  const storage = createTemplateStorage({ adapter: { putNew: async () => { puts++; }, exists: async () => { throw new Error("not allowed"); } } });
  await assert.rejects(storage.storeTemplate({ bytes: Buffer.from("master"), checksum: "a".repeat(64) }), { code: "TEMPLATE_INTEGRITY" });
  assert.equal(puts, 0);
});
