// scripts/backfillGradeCache.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const connection = require('../config/db');
const { recalcAllStudentsForSubject } = require('../src/modules/shared/grades/gradeCache.service');

async function backfill() {
  console.log('Starting grade cache backfill...');

  const [gradingPeriods] = await connection.execute(
    `SELECT id, term_label FROM grading_periods`
  );
  const [subjectSections] = await connection.execute(
    `SELECT id FROM \`subject-section\` WHERE status = 'Active'`
  );

  console.log(`Found ${gradingPeriods.length} grading period(s) and ${subjectSections.length} subject-section(s).`);

  for (const period of gradingPeriods) {
    for (const ss of subjectSections) {
      await recalcAllStudentsForSubject(ss.id, period.id);
    }
    console.log(`Done: ${period.term_label} (id=${period.id})`);
  }

  console.log('Backfill complete.');
  await connection.end();
  process.exit(0);
}

backfill().catch(async (err) => {
  console.error('Backfill failed:', err);
  await connection.end();
  process.exit(1);
});