// Each observation is one student/subject-section/examination in one period.
// Multiple recorded items are combined as earned points / possible points.
// Missing items do not become zeros; partial results remain explicitly eligible.
function statistics(values) {
  if (!values.length) return { count: 0, mean: null, sd: null };
  let mean = 0, m2 = 0, count = 0;
  for (const value of values) {
    count++;
    const delta = value - mean;
    mean += delta / count;
    m2 += delta * (value - mean);
  }
  return { count, mean, sd: Math.sqrt(Math.max(0, m2 / count)) };
}

function summarize(rows) {
  const items = new Map();
  for (const row of rows) {
    if (row.score === null || row.score === undefined || String(row.score).trim() === '') continue;
    const score = Number(row.score), hps = Number(row.hps);
    if (!Number.isFinite(score) || !Number.isFinite(hps) || hps <= 0 || score < 0 || score > hps) continue;
    const key = `${row.studentId}:${row.itemId}`;
    // Identical duplicate joins count once; conflicting duplicates are excluded.
    if (items.has(key)) {
      const previous = items.get(key);
      if (previous && (Number(previous.score) !== score || Number(previous.hps) !== hps)) items.set(key, null);
    } else items.set(key, row);
  }
  const observations = new Map();
  for (const row of items.values()) {
    if (!row) continue;
    const key = `${row.studentId}:${row.subjectSectionId}:${row.examination}`;
    const entry = observations.get(key) ?? { ...row, earned: 0, possible: 0 };
    entry.earned += Number(row.score);
    entry.possible += Number(row.hps);
    observations.set(key, entry);
  }
  const groups = new Map(), values = [], students = new Set();
  const distribution = Array.from({ length: 10 }, (_, i) => ({ interval: i === 9 ? '90–100%' : `${i * 10}–<${(i + 1) * 10}%`, count: 0 }));
  for (const row of observations.values()) {
    const value = row.earned / row.possible * 100;
    values.push(value); students.add(String(row.studentId));
    distribution[Math.min(9, Math.floor(value / 10))].count++;
    const key = `${row.subjectId}:${row.examination}`;
    const group = groups.get(key) ?? { subjectId: row.subjectId, subject: row.subject, examination: row.examination, values: [], students: new Set() };
    group.values.push(value); group.students.add(String(row.studentId)); groups.set(key, group);
  }
  return {
    summary: { ...statistics(values), students: students.size, scale: 'Percentage (0–100)' },
    rows: [...groups.values()].map(({ values, students, ...group }) => ({ ...group, ...statistics(values), students: students.size })),
    distribution,
  };
}
module.exports = { statistics, summarize };
