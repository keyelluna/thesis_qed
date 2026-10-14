# Gradebook workflow audit

> Historical baseline. The six confirmed failures below have since been fixed.
> See `gradebook-workflow-fixes.md` for current implementation and verification results.

Date: 10 October 2026 (Asia/Manila)

## Result

The workflow cannot be confirmed fully functional. The new targeted audit has **21 tests: 15 passed and 6 failed**. Existing backend regression tests have **33 passed and 0 failed**.

No production code, database records, credentials, or notifications were changed. Added only an isolated test suite and audit artifacts. Pre-existing untracked docs and SQL files were preserved.

## Scope and method

The tests execute the actual backend controllers in an isolated JavaScript context with database and notification doubles. Fixture classes 11 and 12 share adviser 7 and grade level 1, with distinct sections 101 and 102. This checks selected-class handling even when the same teacher advises two sections of the same grade level. Tests also cover subject submission, advisory display, principal submission gating, parent access, and visibility changes.

These tests validate controller behavior and expected query scoping. They do not validate real SQL execution, constraints, transactions, live account configuration, or a complete browser-to-database journey. In particular, the principal post-submission test verifies the submission gate with an empty subject list; it does not certify rendered grade values.

## Confirmed passing behavior

- Either of the two advisory classes can be explicitly selected.
- Selecting a class outside the adviser's assignments returns 403.
- Submitting advisory class 12 marks section 102 submitted without marking section 101 submitted.
- Apply-to-all visibility for class 12 targets its own student fixture only.
- Attempting to change visibility for a student only in the other class returns 403.
- Subject submission rejects incomplete scores and accepts complete official grades when a valid template is supplied.
- Complete external-subject grades stay pending and hidden in the advisory gradebook until the subject teacher submits. Submitted grades appear.
- The principal gradebook hides grade data before advisory submission and opens after submission.
- Parent student authorization allows a linked child and rejects an unlinked child.
- A submitted, visible, ended-term parent report returns the fixture grade.

## Confirmed failures

1. **Parent report exposes hidden grades.** `src/modules/parents/Student-Record/ProgressReport/termPerformance.controller.js:242` bases release on advisory submission alone. A linked parent's request returns grades even if the teacher has turned visibility off. The separate visibility endpoint checks `is_visible`, but that check does not protect this grade response.
2. **Parent report exposes grades before term end.** The same response does not enforce the term-end rule implemented by `progressVisibility.controller.js`. Tests return a released report for a submitted term that has not ended.
3. **Sectionless classes cannot receive this parent report.** `termPerformance.controller.js:165` returns unreleased empty terms whenever `sectionId` is null, although the advisory workflow supports grade-level scopes without named sections.
4. **Advisory assignments are not filtered to the active school year or active class status.** `teacher/averagegrade/advisoryGrade.controller.js:38` filters only by adviser ID. The query can include historical/inactive assignments. This is a query-contract test; no live historical database rows were used.
5. **Authenticated parent can reach a principal route handler.** `principal/Gradesheets/gradesheet.router.js:6` checks token validity but does not check the role. A test with an authenticated parent reaches the `/section-grade` handler.
6. **Authenticated teacher can reach the same principal route handler.** Reproduced independently for the teacher role. The other principal gradebook routes also register token checks without role authorization. The shared token middleware verifies JWT validity and does not restrict roles.

## Additional code observations

- The teacher UI intentionally supports **Submit incomplete grades? / Submit anyway**. Advisory submission itself writes the submission marker without checking subject completion. This is existing product behavior, not counted as a failed test because the UI explicitly offers it. Confirm whether partial official submission is desired before changing it.
- The parent Overview endpoint (`parents/Student-Record/Overview/studentTermPerformance.controller.js`) also uses advisory submission as its release gate and does not consult visibility or term end. This is a code-review observation; the targeted parent tests above exercise the ProgressReport endpoint.
- Advisory gradebook roster queries do not use the same active-year and graduated-student exclusions as subject submission and principal gradebooks. Advisory subject queries also lack the principal's school-year filter. This creates potential mismatches; no live-data reproduction was performed.

## Browser verification limitation

The attempted Playwright run for the principal gradebooks timed out waiting 60 seconds for the configured Vite readiness URL. A separate diagnostic Vite process announced readiness, but an HTTP request to `/loading-harness.html` also timed out. The diagnostic server was stopped. No browser test pass is claimed. Existing browser suites mainly test loading/layout with mocked API responses and would not by themselves prove this submission workflow.

## Reproduce

From `C:\Users\Mavys\Downloads\QED_System\thesis_qed`:

```powershell
node --test test/gradebookWorkflow.test.js
node --test test/gradeTemplateAdaptive.test.js test/templateStorage.test.js
```

The first command intentionally exits nonzero while the six audit findings remain unfixed. Full output is saved in `gradebook-workflow-test-results.txt`; existing regression output is saved in `gradebook-existing-regression-results.txt` alongside this report.

## Recommended next work

Enforce parent visibility and term-end gates in every parent grade endpoint; add role authorization to principal routes; support sectionless parent reports; align advisory assignments, subjects, and rosters to the active school year. Then rerun the audit and validate the full journey against an isolated test database and three test accounts, including an adviser with two classes. Decide whether incomplete advisory submission should remain supported.
