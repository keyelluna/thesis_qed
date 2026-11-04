// Weekly evaluations use the school's Philippine calendar, independent of host timezone.
function schoolDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function addDays(date, days) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function schoolWeekday(now = new Date()) { return new Date(schoolDate(now) + 'T00:00:00Z').getUTCDay(); }
function getCurrentWeekStartDate(now = new Date()) {
  const day = schoolWeekday(now);
  return addDays(schoolDate(now), day === 0 ? -6 : 1 - day);
}
function fail(message, statusCode = 422) { throw Object.assign(new Error(message), { statusCode }); }
function chooseHolisticTerm(periods, week, requestedTerm, today = schoolDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(Date.parse(week + 'T00:00:00Z')) || new Date(week + 'T00:00:00Z').toISOString().slice(0, 10) !== week) fail('A valid holistic evaluation week is required.', 400);
  const supplied = requestedTerm !== undefined && requestedTerm !== null && requestedTerm !== '';
  if (supplied && (!Number.isInteger(Number(requestedTerm)) || Number(requestedTerm) < 1 || Number(requestedTerm) > 3)) fail('A valid grading term is required.', 400);
  const end = addDays(week, 4);
  const matches = periods.filter(p => p.startDate && p.endDate && p.startDate <= end && p.endDate >= week);
  if (!matches.length) fail('This evaluation week is outside the configured term dates. Ask an admin to check the academic year.');
  if (supplied) {
    const matching = matches.filter(p => Number(p.termNumber) === Number(requestedTerm));
    if (matching.length === 1) return Number(matching[0].termNumber);
    fail('The selected term does not contain this evaluation week. Reload and choose the correct term.', 409);
  }
  const current = matches.filter(p => p.startDate <= today && p.endDate >= today && week <= today && today <= addDays(week, 6));
  if (current.length === 1) return Number(current[0].termNumber);
  if (matches.length === 1) return Number(matches[0].termNumber);
  fail('This evaluation week overlaps multiple terms. Select its grading term explicitly.', 409);
}
async function resolveHolisticTerm(connection, subjectSectionId, week, requestedTerm) {
  const [periods] = await connection.execute(`SELECT gp.term_number AS termNumber,
    DATE_FORMAT(gp.start_date, '%Y-%m-%d') AS startDate, DATE_FORMAT(gp.end_date, '%Y-%m-%d') AS endDate
    FROM grading_periods gp INNER JOIN \`subject-section\` ss ON ss.school_year_id = gp.school_year_id
    WHERE ss.id = ? ORDER BY gp.term_number`, [subjectSectionId]);
  return chooseHolisticTerm(periods, week, requestedTerm);
}
module.exports = { schoolDate, schoolWeekday, getCurrentWeekStartDate, chooseHolisticTerm, resolveHolisticTerm };
