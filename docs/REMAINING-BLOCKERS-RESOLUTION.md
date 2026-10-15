# QED blocker resolution — 2026-10-15

Status: BLOCKED for production deployment. Local changes are ready for review, not staged or committed. This report supersedes earlier dependency snapshots only; it does not change approved Parent visibility policy.

## Implemented locally

- SheetJS CE 0.18.5 -> official 0.20.3 archive, same Apache-2.0 license, both repositories. Exact archive SHA-256 is recorded in vendor/README.md. Pinned local archive avoids the stale npm xlsx distribution. Clean sandbox installs tested the exact manifests/locks copied to the working trees. Existing node_modules were deliberately not replaced; use a clean npm ci when reviewing the new dependency. No grading source, MATATAG weights, source workbooks, checksums or historical pin records changed.
- Audit actor attribution now uses the same HS256 and complete-session claim checks as normal HTTP/Socket.IO authentication. Legacy id-only, reset-purpose and malformed tokens cannot become trusted audit actors. This is attribution hardening, not a new account authorization policy.
- A deployment-neutral login throttle core and synthetic atomic-store tests are prepared. It is NOT mounted; login is still unthrottled. No trust proxy/header policy changed. Proposed thresholds are 10/account and 100/IP per 15 minutes, subject to owner approval and real school-traffic sizing. Account denials do not additionally charge the shared IP; in-flight reservations prevent parallel bypass. Legitimate users sharing an IP can still be throttled after enough distinct failures; no guarantee of zero shared-IP disruption is claimed.
- Prepared aggregate-only historical account/schema review SQL and owner procedure. No account data was queried.
- Prepared loopback-only Docker/MySQL fixture and opt-in runner. No Docker installation, database connection, schema execution, container, or cloud resource was created.

## Verification completed

- Backend clean candidate sandbox: 2,222 tests passed, zero failed/skipped, including new audit/session, throttle-core and local-DB target guards; existing gradebook/template regressions remained green. Tests use doubles/synthetic data, not production MySQL, mail or AI.
- TypeScript, Vite production build and existing bundle guards passed with candidate SheetJS.
- Production browser: 26 targeted tests passed (account creation/recovery, student Excel import, template workflows), mocked API/services with external egress blocked.
- Source browser: three tests passed: both unique reviewed workbook preview contracts and malformed inputs.
- Offline differential comparator: all seven stored workbook files passed (two unique contents). Compared complete read semantics, frontend preview, backend parsing, template mappings and exported ZIP parts. Export included zero scores and Unicode text; untouched parts/source hashes were preserved. This establishes compatibility for reviewed templates, not every possible Excel workbook.
- Existing nine commits, both review HEADs and local main pointers unchanged; indexes empty. Render API configuration unchanged. Baseline file hashes show only intended tracked edits; excluded screenshots, nine raw logs, private environment files and existing workbooks retained unchanged.

## Dependency findings remaining

Fresh npm audit --omit=dev in clean candidate installs reports frontend 1 high + 3 moderate affected packages, backend 2 moderate, no critical. No automatic audit fix/downgrade was run. An absent npm advisory for a local archive alone is not proof of safety: SheetJS version is independently verified as 0.20.3, above the published 0.19.3 prototype-pollution and 0.20.2 ReDoS fixes.

- React Router family: propose a separately reviewed same-major update to patched 7.18.2 or later supported version, followed by redirects, all-role route/access, TypeScript/build and bundle regression checks. Current SPA uses BrowserRouter: SSR hydration and unstable RSC paths are not configured, so those server advisories are not demonstrated QED production exposure. npm nevertheless flags route matching high; hostile-path cost and backslash redirect reachability require explicit assessment before a waiver. This task did not silently expand the tested dependency change beyond SheetJS.
- exceljs/uuid: moderate transitive uuid buffer issue. Do not take npm's suggested ExcelJS major downgrade. Review caller-controlled buffer reachability and supported upstream fix separately; Excel template behavior must remain covered.
- moment: moderate crafted non-string locale traversal; review whether any locale input is user controlled and test a narrow 2.31.0 update.
- mysql2: moderate compressed-protocol decompression advisory. Current pool does not enable compression; no production exploit demonstrated. Plan a patched same-major upgrade with the disposable MySQL checks, rather than claiming mocked tests validate a driver upgrade.

## Production actions/decisions still required

1. Login throttling: verify every serving process/service, trusted proxy hops and whether Render overwrites forwarding headers; verify account normalization against MySQL collation. Select an atomic shared store or verified gateway, TTL/cardinality limits, outage policy (fail-open versus temporary 503), and approved thresholds. Do not mount the core or trust X-Forwarded-For before this is resolved. Official Compute page shows Free (no scaling), but that does not establish complete topology or a trustworthy client-IP chain.
2. Historical registration: the recorded live official commit 6e2ae01800e384029f83eb2819030e59a522980e contains the old caller-selected-role registration exposure. Exposure is established, exploitation is unknown. Owner must review privileged-account provenance privately; aggregates alone cannot clear accounts. Recommend approved coordinated JWT rotation only after closing the vulnerable route on all serving backends and resolving suspect accounts. Rotation forces sign-in and invalidates outstanding reset tokens, but cannot remove persistent unauthorized accounts. No rotation/account remediation performed.
3. Duplicate Render: both thesis_qed-1 and thesis_qed track backend main with Auto-Deploy On Commit. Thus a main push targets both. Official starts node server.js; duplicate starts node index.js, absent in the reviewed repository, and its recorded latest deployment failed. Dashboard evidence does not establish why the duplicate exists or whether it is needed. DB key names match; masked values were not revealed/compared, so shared database credentials remain UNKNOWN. Owner must establish ownership/integrations and approve disconnecting duplicate Auto-Deploy if unused. Do not blindly fix its start command and accidentally bring another writer online.
4. Existing config/db.js kills sleeping connections older than 60 seconds for the same database user, potentially including another service or idle transaction if credentials are shared. It predates this task and is unchanged. Confirm sharing/privileges; recommend a separately reviewed removal of cross-session KILL in favor of pool lifecycle/timeouts, with transaction/reconnect tests. Do not treat duplicate service failure as proof it cannot later disrupt the database.
5. MySQL: no verified disposable DB exists. Follow docs/LOCAL-MYSQL-RELEASE-TESTS.md after approving local Docker setup. Schema syntax and real transaction/named-lock/concurrent-provisioning/formal-release SQL remain unexecuted. Full Teacher persistence, sectionless/date/collation edge cases, recovery concurrency and template-pin/storage failure tests need the fixture extended against approved schema metadata. Existing live harness loads .env: do not run it against production.
6. Production schema: owner confirms tables/columns/indexes via reviewed metadata SQL, InnoDB on auth/profile tables, UNIQUE identity/user_id constraints, connection-scoped GET_LOCK/RELEASE_LOCK, compatible MySQL JSON/date/collation/SQL modes, storage schema script and historical pins/checksums. Existing model initialization ALTERs gender/avatar fields; audit/history tables are created lazily. These are existing schema writes, so verify DDL permissions, startup behavior and backup/restore before deploying; do not assume a code-only rollout. No destructive startup operation added here.
7. Template storage: official service has all five TEMPLATE_STORAGE_* key names, but masked values/permissions were not exercised. Confirm endpoint/region/bucket and least-privilege read/write, object retention, recoverability and restore access for existing pinned historical templates. Never repin old terms or rely on ephemeral Render filesystem. Verify encrypted DB backup and object backup/restore with the owner.
8. Mail: official configured key list lacks QED_CREDENTIAL_EMAIL_FROM. Production credential mailer deliberately returns sent:false without a verified sender. Confirm/add an approved verified sender and provider permission through a separately approved dashboard change; no test emails sent. Password recovery settings/provider behavior must also be checked privately.
9. Hosting: Render health-check path is blank; confirm an appropriate non-writing health endpoint and its response before approving a dashboard change. Actual Render Node version remains unverified (no explicit NODE_VERSION key); absence of NODE_ENV is not itself a defect because Render defaults it to production at runtime. Confirm actual runtime production mode and Node version match the tested build/runtime. Official exact frontend origin was confirmed by the owner; localhost:5173 remains development-only. Verify Secure/HttpOnly/SameSite=None cross-site cookies with credentialed requests, browser third-party-cookie constraints and Socket.IO after deployment; do not change these policies blindly.
10. Vercel authenticated settings unavailable: owner confirms production branch main, Git trigger, sole domain qed-front-end-6upk.vercel.app, build command/output, Node version, production env scope and successful rollback deployment ID. Current successful Vercel deployment ID UNKNOWN. Recorded Render live rollback reference is dep-db51pegu01pc73fqqglg; re-confirm availability/current status before release. The older backend includes the exposed registration route, so rollback to it is not a security-neutral remedy.

## Exact additional release-file manifest

Frontend:
- package.json
- package-lock.json
- playwright.acceptance.config.ts
- tests/fixtures/sheetjs-template-contracts.json
- tests/sheetjs-preview-compatibility.spec.ts
- vendor/README.md
- vendor/SHEETJS-LICENSE.txt
- vendor/xlsx-0.20.3.tgz

Backend:
- package.json
- package-lock.json
- vendor/README.md
- vendor/SHEETJS-LICENSE.txt
- vendor/xlsx-0.20.3.tgz
- src/modules/shared/audit/auditLog.service.js
- src/modules/shared/audit/auditActor.js
- src/modules/authentication/loginThrottle.js
- test/auditActorSecurity.test.js
- test/loginThrottleCore.test.js
- test/localMySqlTarget.test.js
- scripts/testing/compare-sheetjs.cjs
- scripts/testing/mysql/compose.yaml
- scripts/testing/mysql/schema.sql
- scripts/testing/mysql/target.cjs
- scripts/testing/mysql/run.cjs
- scripts/audit/production-readonly-checks.sql
- docs/HISTORICAL-ACCOUNT-REVIEW.md
- docs/LOCAL-MYSQL-RELEASE-TESTS.md
- docs/REMAINING-BLOCKERS-RESOLUTION.md (this report)

Keep existing loading-screenshots/** and nine docs/*results.txt raw logs excluded. No private .env file belongs in a commit. The hash-only contract fixture contains no workbook cell data. The vendor archive is an intentional dependency artifact, not generated test output. Retain its upstream license with it.

## Proposed additional commits — approval still required

- Frontend: security: pin tested SheetJS CE and preserve preview contracts (all eight frontend paths).
- Backend: security: pin SheetJS CE with workbook equivalence harness (package/lock/vendor and comparator).
- Backend: security: validate audit actors and prepare explicit throttle core (audit files, throttle and their tests).
- Backend: test/docs: prepare guarded synthetic MySQL verification and release owner checklist (remaining fixture/target guard/audit SQL/docs).

No commits were created. Do not stage this list until reviewed, and never blanket-stage the excluded artifacts.

## Coordinated deployment after blockers are approved/resolved

Record current successful deployment IDs and encrypted backup/restore evidence first. Pause Admin account creation and notify Admins to close stale tabs; other sessions can continue unless separately approved JWT rotation requires reauthentication. With local main preparation separately authorized, owner pushes backend first (Auto-Deploy main); explicitly account for BOTH services. Verify official build, health, origin/cookie/socket/login/recovery and safe synthetic authorized flows. Old Admin tabs cannot use the new atomic creation contract: keep pause until frontend deploys and mandatory refresh completes. Owner then pushes frontend, verifies official API URL/role access/template/Parent behavior, and resumes account creation. Never reopen public registration for compatibility.

Rollback: use recorded hosting deployments only with operator approval, retain newer schema/object versions, and do not reverse production data or template pins. Keep Admin creation paused across contract mismatches. Do not restore compromised keys; mitigate historical registration exposure if an older backend must be restored. A successful old deployment is not sufficient reason to bypass current security controls.

External references: https://docs.sheetjs.com/docs/getting-started/installation/nodejs/ ; https://render.com/docs/environment-variables ; https://render.com/docs/node-version ; https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2 . Fresh npm audit advisory URLs are retained in external test evidence.
