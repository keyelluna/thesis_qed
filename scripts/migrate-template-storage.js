const fs = require("node:fs/promises");
const path = require("node:path");
const storage = require("../src/services/templateStorage.service");

const LEGACY_DIR = path.resolve(__dirname, "../uploads/grade-templates");
const portableBasename = (value) => path.win32.basename(path.posix.basename(String(value || "")));

async function readLegacyWorkbook(row, legacyDir = LEGACY_DIR) {
  if (!/^[a-f0-9]{64}$/i.test(String(row.checksum || ""))) throw Object.assign(new Error("Missing or invalid checksum; recover it separately before migration."), { migrationCode: "CHECKSUM_MISSING" });
  if (row.filePath) {
    try {
      const bytes = await fs.readFile(row.filePath);
      return storage.verifyChecksum(bytes, row.checksum); // Existing path with wrong bytes fails closed.
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  const root = await fs.realpath(legacyDir);
  const base = portableBasename(row.filePath);
  const original = portableBasename(row.fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const names = (await fs.readdir(root)).filter((name) =>
    name === base || (original && (name === original || name.endsWith(`-${original}`))));
  // Search only the known legacy directory, reject symlinks escaping it, and match exact bytes.
  for (const name of names.sort()) {
    const candidate = await fs.realpath(path.join(root, name));
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!(await fs.stat(candidate)).isFile()) continue;
    const bytes = await fs.readFile(candidate);
    if (storage.sha256(bytes) === row.checksum.toLowerCase()) return bytes;
  }
  throw Object.assign(new Error(names.length ? "No candidate matches the recorded checksum." : "Exact legacy workbook not found."), { migrationCode: names.length ? "CHECKSUM_MISMATCH" : "WORKBOOK_MISSING" });
}

async function migrateTemplates({ db, templateStorage = storage, apply = false, legacyDir = LEGACY_DIR, report = console.log }) {
  // Every version, including inactive historical templates. No pin/configuration writes.
  const [rows] = await db.execute(
    `SELECT id AS templateId, file_path AS filePath, file_name AS fileName,
            storage_key AS storageKey, checksum_sha256 AS checksum
       FROM subject_grade_templates ORDER BY id`,
  );
  const result = { verified: 0, eligible: 0, migrated: 0, failed: 0 };
  for (const row of rows) {
    try {
      if (row.storageKey) {
        await templateStorage.getTemplate(row);
        result.verified++;
        report(`Template ${row.templateId}: durable workbook verified.`);
        continue;
      }
      const bytes = await readLegacyWorkbook(row, legacyDir);
      result.eligible++;
      if (!apply) { report(`Template ${row.templateId}: checksum verified; eligible (dry run).`); continue; }
      const key = await templateStorage.storeTemplate({ bytes, checksum: row.checksum });
      // Read-back validation is mandatory before the DB association.
      await templateStorage.getTemplate({ storageKey: key, checksum: row.checksum });
      const [update] = await db.execute(
        `UPDATE subject_grade_templates SET storage_key = ?
          WHERE id = ? AND (storage_key IS NULL OR storage_key = '') AND checksum_sha256 = ? AND file_path <=> ?`,
        [key, row.templateId, row.checksum, row.filePath],
      );
      if (update.affectedRows !== 1) throw Object.assign(new Error("Record changed concurrently; association refused. Rerun after review."), { migrationCode: "CONCURRENT_CHANGE" });
      result.migrated++;
      report(`Template ${row.templateId}: durable copy verified; original ID preserved.`);
    } catch (error) {
      result.failed++;
      // Do not print SDK errors, secrets, or absolute filesystem paths.
      report(`Template ${row.templateId}: FAILED (${error.safeTemplateError ? error.code : error.migrationCode || "legacy recovery or database association failed"}).`);
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/migrate-template-storage.js [--dry-run | --apply] [--env-file <private file>] [--legacy-dir <directory>]");
    console.log("Default is read-only dry run. --apply uploads verified bytes and associates storage_key; no files or pins are deleted/changed.");
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (["--apply", "--dry-run"].includes(args[i])) options[args[i]] = true;
    else if (["--env-file", "--legacy-dir"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) options[args[i]] = args[++i];
    else throw new Error("Invalid migration arguments. Use --help.");
  }
  if (options["--apply"] && options["--dry-run"]) throw new Error("Choose --apply or --dry-run.");
  require("dotenv").config({ path: options["--env-file"] || path.resolve(__dirname, "../.env"), quiet: true });
  if (!options["--env-file"]) require("dotenv").config({ path: path.resolve(__dirname, "../.env.storage.local"), quiet: true });
  for (const name of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"]) if (!process.env[name]) throw new Error(`Required variable missing: ${name}`);
  // Intentionally do not import config/db: it has connection-cleanup side effects.
  const db = require("mysql2/promise").createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, port: Number(process.env.DB_PORT || process.env.MYSQL_ADDON_PORT || 3306),
    connectionLimit: 1, connectTimeout: 10000,
  });
  try {
    console.log(options["--apply"] ? "APPLY: explicit manual migration enabled." : "DRY RUN: no object uploads or database writes.");
    const result = await migrateTemplates({ db, apply: !!options["--apply"], legacyDir: options["--legacy-dir"] || LEGACY_DIR });
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } finally { await db.end(); }
}
if (require.main === module) main().catch(() => { console.error("Migration failed. Check arguments, schema, database connection, and private environment configuration."); process.exitCode = 1; });
module.exports = { migrateTemplates, readLegacyWorkbook, portableBasename };
