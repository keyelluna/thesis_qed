# Approved production release security fixes
15 October 2026, Asia/Manila. Local changes only; no staging, commits, main updates, pushes, deployments, production data access or secret rotation.

## Approved origin policy
The owner confirmed from Vercel Settings > Domains that https://qed-front-end-6upk.vercel.app is the only production frontend, with no custom domains or known non-browser HTTP/Socket.IO clients. Independent dashboard access redirected to sign-in; the confirmation is owner-supplied.
- Production, test and unset NODE_ENV: only that exact origin.
- Explicit NODE_ENV=development: also http://localhost:5173.
- No preview wildcard, suffix matching, arbitrary ports or additional domains.
- Origin must be a canonical exact origin; null, malformed and unapproved values fail.
- HTTP: protect POST/PUT/PATCH/DELETE and cookie-bearing GET/HEAD. Some existing GET handlers lazily create quiz records, template pins or metadata, so cookie reads also require admission. Missing Origin may use an approved Referer origin; a supplied bad Origin cannot be rescued by Referer. Missing both fails closed.
- Public GET/HEAD without cookies and preflight remain available; CORS retains credentials and approved headers/methods. This is request admission, not a replacement for authentication.
- Socket.IO allowRequest requires approved Origin for polling and WebSocket handshakes; no Referer fallback or missing-Origin exception. Existing signed-cookie authentication, role checks and user rooms remain.
- A future native client, webhook, custom domain or preview integration requires explicit review. Do not add a wildcard or silently exempt a route.
- Local developers must set NODE_ENV=development deliberately; no private environment file was edited.

## Sessions and login
Session verifiers now explicitly accept HS256 only and require:
- positive safe integer-compatible userId as a number or canonical decimal string;
- one of ADMIN/PRINCIPAL/TEACHER/PARENT, case-insensitive without changing the claim value;
- no purpose claim;
- valid integer issued-at and expiry, expiry after issued-at; JWT verification enforces expiration.
Legacy id-only Admin tokens, incomplete/non-expiring tokens and reset-purpose tokens are rejected. Valid existing one-hour session formats remain accepted. Session signing explicitly selects HS256. HTTP and Socket.IO share claim validation.

Login returns generic Invalid credentials messages for unknown users, wrong passwords, missing profiles, inactive/deleted profiles, and malformed credentials. Existing 401 credential-failure and 403 unavailable-profile statuses are preserved, as are valid login cookies, business rules and recovery. This is not constant-time authentication or complete indistinguishability across all failures.

Login throttling is intentionally NOT implemented. The owner explicitly instructed holding it because Render proxy topology, instance count and shared limiting infrastructure are unverified. Express trust proxy and forwarding behavior are untouched.

Before adding the proposed 10 failed attempts/account and 100/IP per 15 minutes, confirm:
1. Official service instance count/autoscaling and every other publicly reachable backend, including thesis_qed.
2. Exact proxy hops/CIDRs or documented trusted-proxy contract and whether incoming client forwarding headers are replaced.
3. Whether an existing gateway applies to all login paths/services; otherwise shared store availability, permissions, TLS/TTL, atomic counter behavior and failure policy.
4. Shared-school NAT traffic, account-key normalization matching MySQL collation, recovery availability, temporary delay/Retry-After behavior, success/expiry reset and memory/cardinality caps.
No permanent lockout or blind trust proxy=true is proposed.

## Policy A formal reports
Academic grade release continues to require advisory submission, term completion and explicit visibility.
Formal availability now uses the same three conditions through a shared projection used by both visibility list and single-term lookup. The SQL handles sectionless grade-level submission scope and requires the student's current school year to match the period; it performs no writes.
The frontend retains authoritative available as its report/PDF lock. The API type now exposes submitted; Overall availability requires every returned term to be available.
The existing single-term visibility helper also prevents a premature visibility notification when submission is absent.

Live Overview holistic feedback remains unchanged, including active-term evaluations.
The separate Progress holistic API is intentionally unchanged by owner decision. A valid linked Parent can still retrieve those evaluations without formal release gates; the formal UI/PDF is gated. Product approval is required before restricting this API.
All role, student-parent ownership, grading calculations, MATATAG weights, historical grade records and template pins remain preserved. Previously shown academic/formal reports may become unavailable if a gate is missing; no automatic backfill is authorized.

## Admin deployment coordination
Keep public registration closed and preserve the atomic server-owned account creation API. No compatibility shim.
- Pause creation across all Admin tabs/devices BEFORE backend deployment.
- Let old in-flight requests settle and reconcile ambiguous partial old attempts before retrying.
- The stale frontend sends password-bearing registration then profile creation; the new backend rejects that request before DB work.
- After frontend deployment require every Admin tab to reload/close and reopen; reauthenticate if session validation or separately approved rotation requires it.
- Resume only after acceptance. An operational pause requires all operators to comply; an enforced temporary server gate would need separate approval.

## XLSX recommendation and required risk decision
XLSX 0.18.5 is unchanged. Real Admin preview/backend template and workbook-map/OOXML readers remain affected by prototype pollution/ReDoS advisories. Authentication and the 10MB extension-filtered upload limit narrow but do not eliminate exposure.
Official vendor documentation identifies https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz; the npm registry remains out of date. No tarball was installed, no parser replaced, no package/lock version changed in this task.
Source: https://docs.sheetjs.com/docs/getting-started/installation/nodejs/

A supported upgrade requires separately approved provenance/integrity/license review and before/after equivalence tests covering DepEd/GMRC/flat templates; Written Works/Performance Tasks/Summative Tests; all supported terms/exam configurations; unchanged MATATAG weights/transmutation/rounding; formulas/cached results/merged cells/styles; mappings/coordinates/IDs; historical pins/checksums; malformed inputs and object/DB failure consistency.
Existing tests do not establish that equivalence for the candidate because the candidate was not installed or tested.

If upgrading is deferred, the exact temporary controlled-import proposal is:
- Pause all new grade-template file selection/preview/import/upload/replacement, including client-side XLSX preview, rather than relying only on a backend upload ban.
- Permit only previously approved, checksum-verified immutable masters for existing read/export workflows after the owner verifies their provenance. No emailed/downloaded/unreviewed workbook substitutions.
- ExcelJS-only student workflows are not automatically the same XLSX parser exposure; confirm their call path before applying restrictions.
- Record an explicit time-limited owner risk acceptance, remediation owner and deadline. Operational instructions are not an implemented technical block. Enforced UI/server restriction requires separate approval.
- Do not treat these controls as fixing all existing parser risk.

## Historical accounts/JWT operations
No production key or account changed. Rejecting old-shaped tokens closes that validation path but does not revoke otherwise valid issued tokens or remove malicious persistent accounts.
An authorized operator must determine whether public registration was deployed/exposed, review privileged/orphan/unexplained auth records and logs, and approve any remediation. Coordinate any JWT rotation across all live services only after insecure registration is closed; rotation forces sign-in and invalidates outstanding reset tokens. Do not reinstate a potentially compromised old secret during rollback.

## Verification
- Full isolated backend: 2193/2193 pass, zero failures/skips/cancellations.
- Frontend TypeScript + fresh production build + existing bundle/registry guards: pass.
- Production browser: 145 pass plus 3 new Overall/empty-visibility checks pass (148 distinct).
- Selected source browser: 62 pass plus the same 3 extra gate checks pass (65 distinct).
- New gate browser checks include all eight three-gate combinations, authoritative availability, Overall and empty status.
- Coverage includes four-role authorization, HTTP request admission/preflight, real polling/WebSocket handshakes and user rooms, malformed/legacy/reset JWTs, login cookie/failure behavior, existing provisioning/recovery, academic/formal alignment/ownership, and active-term holistic preservation.
- Scoped recommended JavaScript lint: zero errors/warnings.
- Initial backend run had 82 stale response-body expectations because malformed session roles now fail before role-specific guards; exact expectations were updated while retaining denial/no-DB assertions. Three WebSocket rejection assertions expected polling's 403; the transport actually returns 400 for rejected upgrades. Corrected assertions; final full suite passes.
- Tests ran in external source copies with unchanged current lockfiles and previously isolated clean dependency installations. Private .env files excluded; network guards blocked production DB/backend/mail/AI/storage. No application server startup against a real DB occurred.
- Historical complete frontend suites were not rerun; this is targeted release verification, not a restarted migration.

## Remaining release conditions
### Exact local implementation files
Frontend: src/features/profiles/parent/pages/Student/ProgressReport/service/GradeVisibility.service.ts; src/features/profiles/parent/query/drivers/ProgressReportQueries.tsx; tests/parent-formal-release-acceptance.spec.ts.

Backend: server.js; socket.js; src/security/originPolicy.js; src/modules/authentication/sessionClaims.js; src/modules/authentication/authentication.middleware.js; src/modules/authentication/authentication.controller.js; src/modules/parents/Student-Record/ProgressReport/progressVisibility.controller.js; test/sessionValidation.test.js; test/originAdmission.test.js; test/loginFailureSecurity.test.js; test/parentFormalRelease.test.js; test/academicManagementAuthorization.test.js; test/calendarAuthorization.test.js; test/loginFrequencyAuthorization.test.js; docs/PRODUCTION-RELEASE-FIXES.md.

The four previous release inputs remain byte-unchanged by this task: frontend src/config/api.config.ts and package-lock.json; backend package-lock.json and test/dependencySecurity.test.js. They still require selective inclusion alongside approved fixes, not blanket staging. No other existing files changed and no existing file was removed. All five commits, main branches and empty indexes are preserved.

Code can be reviewed for selective local commits once the final file manifest is approved; no staging or commits have occurred. Production release remains BLOCKED pending:
- approved/effective login throttling infrastructure or an explicit temporary risk decision;
- supported XLSX remediation or approved controlled-import risk acceptance;
- production schema/InnoDB/transaction/locking/storage evidence and verified disposable real-MySQL integration;
- historical account/JWT invalidation disposition;
- actual Render NODE_ENV, cookie/JWT/mail/storage settings and duplicate-service topology;
- existing cross-service idle-connection KILL safety decision.
This patch does not alter startup DDL, connection cleanup, deployment settings or production data.

## Conditional backend-first rollout
After resolving the remaining conditions, separately approve selective commits and main preparation, recheck remote divergence, and record exact compatible hosted rollback artifacts/backups. Pause Admin creation. The owner pushes backend main and observes official Render deployment/acceptance before pushing frontend. Confirm Vercel completion and Render target, refresh Admin tabs, then resume creation. Do not write-test production.
Rollback uses compatible hosted artifacts under operator control; keep additive schema, template objects and records. Old backend rollback may restore public registration risk; code rollback does not undo data writes or emails. No rollback action is authorized by this document.
