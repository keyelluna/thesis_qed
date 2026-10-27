function fail(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }
function reportingMonths(terms) {
  const months = new Set();
  for (const term of terms) {
    if (!term.startDate || !term.endDate) continue;
    let cursor = term.startDate.slice(0, 7);
    const end = term.endDate.slice(0, 7);
    while (cursor <= end) {
      months.add(cursor);
      const [year, month] = cursor.split('-').map(Number);
      cursor = month === 12 ? String(year + 1) + '-01' : String(year) + '-' + String(month + 1).padStart(2, '0');
      if (months.size > 120) fail(409, 'The school year has invalid grading-period dates.');
    }
  }
  return [...months].sort();
}
function aggregateReport(roster, records, month, dropouts = []) {
  const dropped = new Map(dropouts.map(d => [String(d.studentId), d.effectiveDate]));
  const students = new Map(roster.map(s => [String(s.id), s]));
  const genderOf = s => ({male: 'male', m: 'male', female: 'female', f: 'female'})[String(s.gender ?? '').trim().toLowerCase()] ?? null;
  const enrollment = { male: 0, female: 0, total: 0 };
  const annualEnrollment = { male: 0, female: 0, total: 0 };
  const unknownGender = [];
  for (const student of students.values()) {
    if (student.joinedDate && student.joinedDate.slice(0,7)>month) continue;
    const gender = genderOf(student);
    if (gender) { annualEnrollment[gender]++; if (!dropped.has(String(student.id)) || dropped.get(String(student.id)) > month+'-01') enrollment[gender]++; }
    else unknownGender.push({ id: String(student.id), name: student.name });
  }
  enrollment.total = enrollment.male + enrollment.female;
  annualEnrollment.total = annualEnrollment.male + annualEnrollment.female;
  const dates = new Map();
  for (const record of records) {
    const date = String(record.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month) continue;
    const day = new Date(date + 'T12:00:00Z').getUTCDay();
    if (day === 0 || day === 6) continue;
    if (students.get(String(record.studentId))?.joinedDate > date) continue;
    if (!students.has(String(record.studentId)) || (dropped.has(String(record.studentId)) && date >= dropped.get(String(record.studentId)))) continue;
    if (!dates.has(date)) dates.set(date, new Map());
    const marks = dates.get(date), id = String(record.studentId);
    if (marks.has(id) && marks.get(id) !== record.status) fail(409, 'Conflicting attendance marks were found. Correct the source records before reporting.');
    marks.set(id, record.status);
  }
  const days = [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([date, marks]) => {
    const row = { date, malePresent: 0, femalePresent: 0, maleAbsent: 0, femaleAbsent: 0, unmarked: 0, enrollment: { male: 0, female: 0, total: 0 } };
    for (const student of students.values()) {
      if (student.joinedDate && date < student.joinedDate) continue;
      if (dropped.has(String(student.id)) && date >= dropped.get(String(student.id))) continue;
      const status = marks.get(String(student.id)), gender = genderOf(student);
      if (gender) { row.enrollment[gender]++; row.enrollment.total++; }
      if (!['P', 'L', 'A', 'E'].includes(status)) { row.unmarked++; continue; }
      if (gender) row[gender + (status === 'P' || status === 'L' ? 'Present' : 'Absent')]++;
    }
    return row;
  });
  const sums = days.reduce((sum, day) => ({ male: sum.male + day.malePresent, female: sum.female + day.femalePresent }), { male: 0, female: 0 });
  const ada = days.length ? { male: Math.round(sums.male / days.length), female: Math.round(sums.female / days.length), total: 0 } : null;
  if (ada) ada.total = ada.male + ada.female;
  return { annualEnrollment, enrollment, rosterCount: students.size, unknownGender, days, numberOfDays: days.length, sums, ada };
}
module.exports = { aggregateReport, reportingMonths, fail };
