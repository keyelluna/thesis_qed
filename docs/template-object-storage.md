# QED template storage implementation and manual rollout

**Current design:** Backblaze B2 is the selected provider. Use [backblaze-local-setup.md](backblaze-local-setup.md) and `.env.storage.example` for current configuration and immutability behavior. Fresh UUID keys are generated for every creation attempt; conditional PutObject and deterministic migration keys described in this ORIGINAL report have been superseded. The R2 setup/variable sections below are historical and must not be used for current configuration. No R2-named credentials are consumed. Pinning/checksum/metadata preservation remains unchanged.

Implemented locally on 7 October 2026. No production database connection, schema migration, object upload, deployment, push, or commit was performed. Existing local XLSX files were not modified or deleted.

## Implementation

MySQL retains template IDs, filenames, checksum, weights, structure JSON, mapping JSON, active state, and grading-period pins. The new nullable `storage_key` associates each template version with its exact original XLSX in a private S3-compatible bucket. No BLOBs are introduced. Cloudflare R2 is the default provider.

`src/services/templateStorage.service.js` provides `storeTemplate`, `getTemplate`, and `templateExists`. Provider operations are isolated in an S3 adapter; tests inject an in-memory adapter. Credentials are read lazily from backend environment variables. Existing local-file reads do not require cloud credentials. New uploads require durable storage, including in local development; use a separate private development bucket and credentials for manual upload testing.

New keys are `grade-templates/<version-uuid>/<sha256>.xlsx`. A UUID is assigned once per upload attempt, avoiding reuse of a database ID after a failed transaction. The resulting key is deterministic for that version identifier and checksum. Migration keys are `grade-templates/legacy-<existing-template-id>/<sha256>.xlsx`. Original filenames remain database metadata.

Uploads validate and parse the unchanged buffer, calculate SHA-256, put exact bytes with `If-None-Match: *`, read back and verify the object, then insert the key and existing metadata in the original transaction. Existing active-version replacement logic stays in that transaction; failures roll it back. Object creation is immutable at the application level. No delete method is provided. An object can remain unreferenced if a DB insert/commit fails; retain it for manual review instead of deleting on an ambiguous commit.

Export keeps the original pinned-template resolver. With `requireWorkbook: true`, it retrieves and verifies the workbook into memory. The existing controller passes that buffer to the unchanged OOXML patcher. No exported workbook is written back to object storage. The active-template download and existing structure-refresh path also use the abstraction.

Resolution order is strict:

1. A nonempty storage key always uses durable storage. A missing or corrupt object fails; there is no local-file or active-template fallback.
2. Without a key, an accessible legacy `file_path` is read and checksum-verified.
3. Otherwise, retrieval fails. A historical pin never changes because storage failed.

Missing workbook and checksum mismatch return HTTP 409 with safe teacher messages. Storage configuration/provider/network problems return 503 with safe messages. Unexpected controller failures remain 500. Existing authentication and mapping validation statuses remain. Provider details and stack traces are not sent to the browser. The frontend already displays returned JSON errors; it additionally rejects a successful response with a non-XLSX content type.

No grading calculation, parser, workbook mapping, OOXML patcher, authentication, CORS, or production API architecture was redesigned. Existing first-assessment/first-export pin creation and old-map refresh behavior are retained. Migration itself does not change pins or configuration.

## Files in this change

- Added `src/services/templateStorage.service.js`.
- Updated `src/modules/shared/grades/gradeTemplateResolution.service.js`.
- Updated `src/modules/admin/subject-management/subjectGradeTemplate.controller.js`.
- Added `scripts/2026-10-07-template-object-storage.sql`.
- Added `scripts/migrate-template-storage.js`.
- Added `test/templateStorage.test.js`.
- Updated `package.json` and `package-lock.json` for the AWS S3 client and offline Node test command.
- Updated frontend `src/features/profiles/teacher/pages/subjects/services/subjectGradeTemplate.service.ts` for content-type validation.
- Added this guide and validation log.

Unrelated working-tree edits were present before implementation. In particular, frontend `src/config/api.config.ts` has an existing localhost override. Do not include that override in a production commit/build. The committed version points to `https://thesis-qed-1.onrender.com`; the validation build uses the current local override and is not a deployment artifact. Review and stage only the files above when preparing this change.

## Cloudflare setup

1. Sign in to the Cloudflare dashboard. Select your account, then **Storage & databases > R2 > Overview**. Complete R2 activation if prompted.
2. Create a bucket named **qed-grade-templates**. A bucket is the private container holding workbook files. Use the normal/default jurisdiction for the automatically derived endpoint; a jurisdiction-specific bucket needs the optional endpoint override below.
3. Keep the bucket **private**. Leave public `r2.dev` access disabled and do not attach a public custom domain. Do not configure an expiration rule for template objects; inactive versions are still needed historically.
4. From R2 Overview, select **Manage** in API Tokens, then create an account or user API token named **qed-template-backend**.
5. Choose **Object Read & Write** and apply it only to **qed-grade-templates**. The backend needs to upload new original files and read existing originals.
6. Save the generated **Access Key ID** and **Secret Access Key** securely. The secret cannot be viewed again. These are the credentials for the S3-compatible file API, not the general Cloudflare API token string.
7. Copy your Cloudflare **Account ID**. The backend derives `https://<account-id>.r2.cloudflarestorage.com`.
8. Put these values only in backend/migration private environment configuration. Never put them in React, Vite variables, screenshots, Git, API responses, or public bucket settings.

Official instructions: [create a bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/), [S3 credentials](https://developers.cloudflare.com/r2/get-started/s3/), [AWS JavaScript SDK](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/), [conditional operations](https://developers.cloudflare.com/r2/api/s3/api/).

## Exact Render environment variable names

| Name | Value to supply privately |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_ACCESS_KEY_ID` | Generated Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Generated Secret Access Key |
| `R2_BUCKET_NAME` | `qed-grade-templates` |

These four variables suffice for standard R2. Keep existing DB, JWT, PORT, and production environment settings.

Optional variables, normally leave unset:

- `TEMPLATE_STORAGE_ENDPOINT`: HTTPS S3-compatible endpoint override for another provider or a jurisdiction-specific R2 endpoint. No embedded credentials.
- `TEMPLATE_STORAGE_REGION`: signing region override; defaults to `auto` for R2. For another S3 provider, the same R2-named credential/bucket variables are used by this small adapter.

In Render, open backend **thesis_qed-1 > Environment**, add the four variables, and save. If saving offers **Save only**, use that during preparation so you do not deploy early. The updated backend must subsequently be rebuilt/deployed to install the new SDK and load these variables. Changing environment settings requires a deploy/restart for the running process to receive them. See [Render environment variables](https://render.com/docs/configure-environment-variables).

## Additive SQL migration

Run this once manually against the intended database, after a backup and before the updated backend or migration script is used:

```sql
ALTER TABLE subject_grade_templates
  ADD COLUMN storage_key VARCHAR(512) NULL AFTER file_path;
```

It adds only the object reference. `file_path`, IDs, metadata, active flags, and period pins remain. New object-backed uploads use an empty `file_path`, compatible with legacy NOT NULL definitions. The script intentionally does not run SQL automatically. If the column already exists, do not rerun the ALTER.

## Manual workbook migration

Run from the local backend checkout that still possesses the original workbooks. A dedicated private environment file outside Git should contain the target DB variables and the four R2 variables. Required DB names are `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`; optional `DB_PORT` or `MYSQL_ADDON_PORT` selects the port. Confirm the intended database privately before running.

The migration creates its own connection pool. It deliberately does not load `config/db.js`, avoiding that module's stale-connection cleanup side effect.

Example commands in PowerShell:

```powershell
Set-Location -LiteralPath 'C:\Users\Mavys\Downloads\QED_System\thesis_qed'
node scripts/migrate-template-storage.js --help
node scripts/migrate-template-storage.js --dry-run --env-file 'C:\Users\Mavys\qed-storage-migration.env'
```

After reviewing the dry run and resolving failures, explicitly apply:

```powershell
node scripts/migrate-template-storage.js --apply --env-file 'C:\Users\Mavys\qed-storage-migration.env'
```

Then verify again:

```powershell
node scripts/migrate-template-storage.js --dry-run --env-file 'C:\Users\Mavys\qed-storage-migration.env'
```

Without an action flag, the script defaults to dry run. `--dry-run` does not upload or update any record; it reads legacy files and reads/verifies already-migrated objects. `--apply` is the explicit upload/update opt-in. An optional `--legacy-dir '<directory>'` supplies a different controlled source directory.

All rows are considered, including inactive versions. For an unavailable absolute Windows path, recovery checks the portable basename and sanitized original-filename candidates only inside the known legacy directory, rejects symlink escapes, and accepts only the recorded SHA-256. An accessible original path with a wrong checksum is rejected immediately. Missing or invalid checksums are never guessed or silently backfilled by this migration.

Each upload is read back and verified before `storage_key` is set on the **same ID**. The update also checks that the checksum/path/key did not change concurrently. Other fields and period pins are untouched. A rerun verifies existing keys rather than replacing them. Failed templates are reported by ID and safe error category; processing continues for other rows, but any failure gives exit code 1. Stop rollout until every required historical version is recovered. A missing exact original cannot be reconstructed from structure/mapping JSON.

## Safe rollout order

1. Review this implementation; do not push yet. Exclude the preexisting frontend localhost override and unrelated edits from any eventual production commit.
2. Back up the target database, including all template rows and period pins. Preserve separate exact copies of the local XLSX directory.
3. Create the private bucket and narrowly scoped credentials. Do not delete inactive objects or enable object expiration.
4. Configure the migration machine's private environment file and prepare the Render variables without deploying yet.
5. Pause admin template uploads for the migration window. Review which database the migration will connect to.
6. Apply the additive SQL manually once.
7. Run dry run. Resolve missing files/checksums before apply. Do not replace historical templates with new uploads.
8. Run `--apply` manually from the machine holding the original files.
9. Run dry run again: durable rows should be verified, `failed` should be zero, and no recoverable legacy rows should remain. Review the SQL checks below and compare IDs/pins/configuration to the backup.
10. After migration and review, deploy the updated backend with the new dependency and environment configuration. A frontend deployment is optional for the MIME guard; the existing frontend already displays the new safe backend errors. If deploying frontend changes, build with the deployed API URL.
11. Run production acceptance tests below, including a backend restart/redeploy test to prove exports no longer depend on runtime local files.
12. Keep legacy workbooks, database backup, and private migration configuration until acceptance and recovery planning are complete. No automated deletion is supplied.

Verification SQL (read-only; not executed here):

```sql
SELECT id, is_active, storage_key, checksum_sha256
FROM subject_grade_templates ORDER BY id;

SELECT p.subject_section_id, p.grading_period_id, p.template_id,
       t.storage_key, t.checksum_sha256
FROM subject_grade_template_periods p
LEFT JOIN subject_grade_templates t ON t.id = p.template_id
ORDER BY p.subject_section_id, p.grading_period_id;

SELECT p.subject_section_id, p.grading_period_id, p.template_id
FROM subject_grade_template_periods p
LEFT JOIN subject_grade_templates t ON t.id = p.template_id
WHERE t.id IS NULL OR t.storage_key IS NULL OR t.storage_key = '';
```

The last query should return no unresolved historical references before acceptance. Verify all active uploads also have keys. Do not manually reassign pins to make that query empty.

## Validation performed locally

- `npm test`: **26 passed, 0 failed**, seven existing adaptive/export regressions plus nineteen new storage/controller/migration tests. No real database, cloud credentials, or internet is needed by the test command.
- Existing regressions passed: Math/Science and GMRC structures; six-WW capacity and seventh-item refusal; no-exam parsing/mapping/calculation/descriptor; incomplete-grade refusal and complete initial/term grade; original-template pinning; OOXML structural/formula preservation.
- New tests cover exact upload bytes, inserted-version/key association, failed-upload rollback, pinned inactive template A despite B, checksum success/failure, missing object and missing legacy file with no newer-template fallback, active workbook download, legacy read, immutable conditional S3 writes, sanitized provider failures, lazy credentials, Windows-path and original-filename recovery, migration dry run, same-ID updates, checksum mismatch/missing checksum refusal, concurrent-update refusal, and repeat verification.
- Workbook structural tests retain 5,142 Math/Science formulas and 530 merges, and verify GMRC formulas/merges and original package parts. Existing snapshot tests cover defined names, rows/columns, print-related properties, protection, sheet list/visibility, drawing/media/worksheet relationships. New controller export tests additionally compare raw worksheet metadata and row attributes and all untouched ZIP parts (including HELPER, FINAL GRADES, drawings, media, styles, relationships, printer settings). The existing percentage-column sizing and recalculation behavior remain in the unchanged patcher.
- Frontend `npm run build`: passed TypeScript and Vite; Vite completed in 20.90 seconds. Only an informational plugin timing notice was emitted. Current local API override remains; do not deploy this local dist.
- `node --check`: passed storage service, migration CLI, template resolver, template controller, and new tests.
- `git diff --check`: passed in both repositories. Git emitted line-ending conversion notices, not whitespace errors.
- Migration `--help`: passed; no database or object storage was contacted.
- No changes to tracked upload files, grading computation, parser, mapping, or OOXML patcher.

Existing backend dependency audit reports 10 affected packages (3 moderate, 6 high, 1 critical), including XLSX, mysql2, nodemon, and other existing dependencies. No AWS SDK package appears in the audit findings. Broad dependency upgrades were not applied as part of this storage fix.

Limits of validation: automated tests use a fake storage adapter and DB mocks; no real R2 smoke test, live MySQL ALTER/update, deployed browser test, or Microsoft Excel recalculation/repair check was performed. Grading code was unchanged and relevant regressions passed, but these tests do not independently evaluate every Excel formula's PS/WS/component WS against QED. The acceptance procedure is still required.

## Production acceptance

1. On Computer A, log into the deployed QED teacher account, select the known class and grading period, and export. Confirm HTTP 200 with XLSX MIME type and a workbook download.
2. On Computer B, use the same deployed system/class/period and export. Verify the same template ID and SHA-256 response headers in Network details (or the read-only pin SQL); exported files need not have identical ZIP hashes.
3. Open both exports in Microsoft Excel. Confirm no repair/recovery warning, retained formulas, merged cells, print settings, protection, HELPER, and FINAL GRADES. Let Excel recalculate and compare QED's WW/PT/Examination PS, component WS, WS, Initial Grade, transmuted Term Grade, Descriptor, and completeness against the same class data.
4. Repeat for Math/Science, GMRC, six-WW, and no-exam template families where available. Verify incomplete required records remain incomplete and capacities are respected.
5. Upload a newer template B. Export a historical period pinned to A and confirm it still uses A's ID/checksum. Verify a new period follows the existing pinning rules for B.
6. Restart/redeploy the backend and repeat A's export from both computers. Confirm durable retrieval still works.
7. Use a separate staging bucket/database to simulate missing or corrupt objects. Confirm safe 409 errors and no substitution. Do not remove a production historical object to test failure.

Verdict: **READY FOR STORAGE MIGRATION / DEPLOYMENT**, subject to the manual setup, verified migration, and production acceptance above. No production action has been performed.
