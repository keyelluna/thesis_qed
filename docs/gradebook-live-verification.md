# Gradebook live verification — 2026-10-10

This supplements `gradebook-workflow-fixes.md` with browser-to-database testing. The frontend ran locally against a separate local API using the configured Clever Cloud database. Authentication, controllers, SQL and grade calculations were real; API responses were not mocked.

## Coverage

- Real login for subject teacher, adviser, principal and linked parent.
- One adviser with two distinct advisory classes. Switching classes displays the correct roster; graduated, deleted and previous-year students and historical subjects are excluded.
- Incomplete subject grades are rejected. Complete scores are submitted through the subject teacher's browser and verified in `subject_grade_submissions`.
- The adviser sees submitted subject grades, submits Class B through the browser, and Class A stays unsubmitted. The Class B row is verified in `grade_submissions`.
- The principal's browser displays the submitted Class B student's grades; the actual gradebook response contains only the current student.
- Authenticated teacher and parent requests receive 403 on all three principal gradebook routes.
- The adviser changes parent visibility through the browser. ProgressReport and Overview API responses withhold grades before term end, release them when visible after term end, and withhold them again when hidden. Class A visibility remains unchanged.
- Parent browser checks cover the locked screen before term end, the released grade after term end, and the locked screen after hiding.

## Isolation and repeatability

All database writes target temporary synthetic accounts, students, classes, subjects and assessments. Existing school records and grading-period dates are not modified. The test API controls only its own MySQL session clock to exercise the term-end condition. Outbound notification functions are suppressed, so email/notification delivery is outside this test's coverage. The existing API on port 7400 is left running.

Live tests are opt-in and excluded from the normal Playwright configuration. From the backend, set `QED_LIVE_FIXTURE` to a private temporary JSON path, then run `node scripts/testing/live-gradebook.js setup` and `node scripts/testing/live-gradebook.js assessments`. From the frontend, with that same environment variable, run `npx playwright test --config playwright.live.config.ts`. Always finish from the backend with `node scripts/testing/live-gradebook.js cleanup`. The fixture file contains a random test password and must not be committed or shared.

The frontend API configuration now honors `VITE_API_BASE_URL`, with `http://localhost:7400` as its local fallback. The live configuration uses port 7411 for its dedicated API process.

## Results

The final live Playwright journey passed **1/1**, including all five multi-role steps (2.6 minutes for the test, 3.1 minutes including startup). Full live output: `gradebook-live-test-results.txt`. Backend regression output: `gradebook-latest-backend-results.txt`.

Cleanup committed successfully. Follow-up SQL checks found **0** remaining run-owned authentication, subject and school-year records; the private credential fixture was deleted. Cleanup output: `gradebook-live-cleanup-results.txt`.

An unused local initialization directory, `C:\Users\Mavys\AppData\Local\Temp\qed-gradebook-integration-20261010`, remains because the tool policy rejected its recursive deletion. No database process was started from it. This is separate from the successfully removed Clever Cloud test records.

The backend regression suite passed **77/77**. Frontend TypeScript compilation passed. A fresh focused browser regression run passed **59/59** in 2.3 minutes; output is in `gradebook-latest-browser-results.txt`. These mocked regressions cover query scoping and UI behavior, while the live test above provides real database confirmation. Generated tracked screenshots were restored after testing. Sectionless reports and the full release-state matrix are covered by backend tests; the live fixture uses two named sections.

## Ancillary observation

Successful logins emitted an audit logging warning because `recordAuditEvent` passes an undefined `fields` value to mysql2 for login events. Authentication and the gradebook checks succeeded. This separate audit logging issue was not changed in the gradebook fixes.
