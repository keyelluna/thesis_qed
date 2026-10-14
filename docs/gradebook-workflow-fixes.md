# Gradebook fixes and verification

Date: 10 October 2026 (Asia/Manila)

For the subsequent real browser-to-Clever-Cloud checks and their scope, see [gradebook-live-verification.md](gradebook-live-verification.md). The earlier mocked-test results below are retained as the original verification record.

## Follow-up: Overview and advisory roster consistency

Both additional observations are addressed. Overview already enforces advisory submission, student visibility and term end; its tests now cover all 16 combinations of named/sectionless class, visibility, term end and advisory submission. Grades and averages remain absent unless all three release conditions hold.

Advisory gradebook roster reads, parent visibility roster reads, apply-to-all selection and explicitly selected-student validation now require the active school year and exclude graduated and deleted students. Advisory subject queries are restricted to active subjects in the active school year for named and sectionless scopes.

The shared overall-grade calculator now uses the same current-year subject and adviser scope, and its roster queries exclude graduated and deleted students from other years. This prevents a historical subject or adviser from affecting newly calculated overall grades. Existing stored averages will pick up these rules on the next normal grade recalculation; no bulk database rewrite was performed.

Latest verification: `node --test test/*.test.js` — **77 passed, 0 failed** (44 workflow checks plus 33 existing regressions). Added query-contract checks cover both named and sectionless advisory scopes across gradebook, visibility and overall-grade calculation. They assert the actual SQL emitted by the controllers and service; the database doubles do not execute MySQL predicates. Full output: `gradebook-roster-fixed-test-results.txt`.

JavaScript syntax and diff whitespace checks passed. The earlier 59 browser passes below remain the last browser run; this follow-up changes backend queries only and does not claim a fresh browser or live-database run.

## Outcome

All six confirmed audit failures are fixed in the local source. All executed tests passed: **65 backend tests and 59 browser tests**.

## Changes

- Parent ProgressReport grades and averages are returned only when the advisory gradesheet has been submitted, the term has ended, and visibility is enabled for that student and period. Hidden or early reports contain no subject grades or overall average.
- Applied the same release rules to parent Overview to close the alternate grade endpoint bypass.
- Both parent grade endpoints support sectionless classes using a null section plus the student's grade level. Student access middleware now carries the grade level needed for that scope. Report metadata also resolves a sectionless class adviser.
- Parent subject lookups include matching grade-level subjects and are restricted to the active school year.
- Teacher advisory selection now includes only active classes in the active school year. Explicit class selection remains supported for both advisory classes.
- All three principal gradebook routes require a principal or admin role after token verification. Authenticated parents and teachers receive 403 before the route handler.

The existing explicit incomplete-advisory-submission behavior remains as it was; that was not one of the six confirmed failures requested for repair.

## Verification

### Backend: 65 passed, 0 failed

Command, run from `thesis_qed`:

```powershell
node --test test/*.test.js
```

This includes 32 gradebook workflow checks and all 33 existing template/storage regression checks. The original six failure assertions pass. Added coverage checks all three principal routes for parent, teacher, principal and admin roles; parent reports without advisory submission; and all eight combinations of named/sectionless class, visibility and term-ended state for parent Overview. The original two-advisory-class selection, submission separation and visibility isolation checks remain passing.

Full backend output: `gradebook-fixed-test-results.txt`. Targeted workflow output: `gradebook-workflow-test-results.txt`.

### Browser: 59 passed, 0 failed

Commands, run from `QED_front_end`:

```powershell
npx playwright test tests/principal-gradebooks.spec.ts tests/teacher-grades-loading.spec.ts tests/principal-grade-sheet-loading.spec.ts
npx playwright test tests/gradebook-two-advisories.spec.ts
```

The first run passed 58 existing browser tests in 2.4 minutes. The second passed the new two-advisory-class browser test. It verifies switching from Class A to Class B, distinct displayed students, the Class B submission request, its submission history, its parent visibility request, and returning to Class A with its submission still pending.

JavaScript syntax checks for all four changed application files and `git diff --check` also passed. Generated screenshot changes from the existing browser suites were restored; the new browser test remains in the frontend repository.

## Limits

Backend workflow tests use database and notification doubles. Browser tests use mocked API responses. These results verify application logic, route authorization and browser request scoping, but do not certify live SQL constraints, real account data or a browser-to-live-database journey. No school records were changed and no notifications were sent. The fixes have not been deployed.
