# Current QED storage configuration: Backblaze B2

This guide supersedes the R2-specific configuration instructions in the original implementation guide. Storage keys now use a fresh UUID for every creation attempt, including migration retries. Checksum verification, historical pins, and manual migration approval checkpoints are unchanged. No production migration has been performed.

## Enter settings locally

Open `thesis_qed/.env.storage.local` in a local editor. It is ignored by Git. `.env.storage.example` is the safe blank example that can be versioned.

| Variable | Enter privately |
| --- | --- |
| `TEMPLATE_STORAGE_BUCKET` | Already set to `qed-grade-templates` |
| `TEMPLATE_STORAGE_ENDPOINT` | `https://` followed by the Endpoint shown in Backblaze > B2 Cloud Storage > Buckets > qed-grade-templates |
| `TEMPLATE_STORAGE_REGION` | Leave blank for automatic B2 inference, or set the matching region |
| `TEMPLATE_STORAGE_ACCESS_KEY_ID` | Your bucket-scoped Backblaze `keyID` |
| `TEMPLATE_STORAGE_SECRET_ACCESS_KEY` | Your Backblaze `applicationKey` |

The S3 client endpoint must be `https://s3.<bucket-region>.backblazeb2.com`, without a bucket path, credentials, or query string. Its signing region is exactly the part between `s3.` and `.backblazeb2.com`. For example, an endpoint of `https://s3.us-west-004.backblazeb2.com` requires `us-west-004`; this is only an example, not a determination of your bucket's region. B2 must not use R2's `auto` region.

The client uses the existing private server-side credentials and path-style S3 addressing. R2 account IDs and R2-named credential variables are no longer used. Other S3-compatible providers can use the same neutral variables with an explicit signing region.

References: [Backblaze AWS JavaScript SDK v3 configuration](https://www.backblaze.com/docs/cloud-storage-use-the-aws-sdk-for-javascript-v3-with-backblaze-b2), [S3-compatible endpoint format](https://www.backblaze.com/docs/en/cloud-storage-call-the-s3-compatible-api).

## Local loading and secrecy

The backend loads the existing `.env`, then optional `.env.storage.local`. Existing process and `.env` values take precedence. The migration CLI does the same by default. With an explicit `--env-file`, it uses that specified file instead of the two default files. Do not run migration yet.

No DB credentials were copied, changed, or printed. Keep the existing database configuration untouched at this checkpoint. Never put storage credentials in React/Vite, tracked files, Git commands, screenshots, logs, or chat. Enter them directly into `.env.storage.local`. An existing local file is never overwritten by preparation.

In a later approved deployment, set the same five neutral variable names in Render. No Render configuration or deployment is authorized at this checkpoint.

## Compatibility checks still needed later

All automated tests are offline and use fake adapters/credentials. A real temporary-object test previously confirmed B2 rejects `If-None-Match: *` writes with HTTP 501. The approved strategy uses ordinary PutObject and fresh cryptographically strong UUID keys generated inside the storage service for EVERY creation attempt: `grade-templates/<uuid>/<sha256>.xlsx`. Callers cannot supply/reuse a creation key. No existence-check/overwrite sequence is used, and automatic SDK retries are disabled to avoid retrying a potentially successful write to the same key.

Exact bytes are immediately read back and checksum-verified before the key can be returned for database association. DB failure leaves an unassociated orphan, which is retained rather than deleted after an ambiguous commit. Migration association failures also leave the orphan; retries generate a fresh key. A record already containing a key is only verified, never uploaded again or repinned. Strict export retrieval/checksum verification remains unchanged.

This is effective application immutability through non-reuse of keys, not a provider-enforced object lock. A credential holder could still manually overwrite objects; keep credentials scoped/private and avoid lifecycle rules that remove historical masters. No automated orphan deletion is provided.

Stop here: enter endpoint and credentials locally, save, then return with `BACKBLAZE LOCAL CONFIG READY`. Do not paste any credential values.

## Approved unique-key implementation verification

The saved configuration was validated and the new service was exercised against real B2 using harmless text bytes only, isolated under a fresh `qed-storage-tests/<test-uuid>/` prefix. Two service-generated UUID keys received identical test bytes. Both upload/read-back/SHA-256 checks passed; keys differed and the first object's bytes remained unchanged. Only the two owned test keys and their object versions were deleted. The isolated prefix was then verified empty, including versions/delete markers. No production workbook, database, or migration CLI was used.

After this design change, all **33 backend tests passed** (including adaptive grading/export regressions, failed read-back/commit consistency, unique-key behavior, and fresh-key migration retries). Frontend production build passed. The localhost override remains local and must be excluded from eventual deployment. Real production migration still requires the backup/schema/dry-run/approval checkpoints; this successful smoke test is not authorization to migrate.
