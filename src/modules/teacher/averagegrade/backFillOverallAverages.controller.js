// One-time backfill: recompute every student's overall_average for every
// grading period using the corrected recalcOverallAverage logic, so
// existing rows written by the old (buggy) function get fixed.
//
// The old function counted any subject with a non-null cached average,
// including subjects that were fully scored but not yet submitted, and
// it silently skipped every student in a section-less (grade-level-only)
// class. This script re-derives every row from scratch with the fixed
// rule, so it's safe to run repeatedly (it's just an UPSERT per row).
//
// IMPORTANT: adjust the two require() paths below to match where you
// place this script relative to your project root — they must resolve
// to the same config/db and gradeCache.service files your controllers use.
const connection = require("../../../../config/db");
const { recalcOverallAverage } = require("../../shared/grades/gradeCache.service"); 

async function backfill() {
  const [periods] = await connection.execute(
    `SELECT id FROM grading_periods ORDER BY id`
  );
  const [students] = await connection.execute(
    `SELECT id FROM elem_students WHERE is_deleted = 0 ORDER BY id`
  );

  console.log(
    `Backfilling overall averages for ${students.length} students across ${periods.length} grading periods...`
  );

  let done = 0;
  let errors = 0;

  for (const period of periods) {
    for (const student of students) {
      try {
        await recalcOverallAverage(student.id, period.id);
      } catch (err) {
        errors++;
        console.error(
          `Failed for student ${student.id}, period ${period.id}:`,
          err.message
        );
      }
      done++;
      if (done % 50 === 0) {
        console.log(`  ...${done} / ${students.length * periods.length}`);
      }
    }
  }

  console.log(`Done. ${done} processed, ${errors} errors.`);
  process.exit(errors > 0 ? 1 : 0);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});