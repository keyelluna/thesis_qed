const connection = require('../../../../config/db');
const { summarize } = require('./examinationStatistics');

exports.getExaminationAnalytics = async (req, res) => {
  const { schoolYear = '', term = 'Term 1', grade = '', section = '', subject = '', examination = 'ST1' } = req.query;
  const id = value => value === '' || (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
  if (![schoolYear, section, subject].every(id) || typeof grade !== 'string' || typeof term !== 'string' || !['ST1', 'ST2', 'TE'].includes(examination)) {
    return res.status(400).json({ success: false, message: 'Invalid examination filters.' });
  }
  try {
    const [years] = await connection.query('SELECT id, school_year AS label, is_active AS active FROM school_year ORDER BY id DESC');
    const yearId = schoolYear || years.find(year => year.active)?.id || years[0]?.id;
    if (!yearId) return res.json({ success: true, data: { ...summarize([]), schoolYear: null, options: { years, terms: [], sections: [], subjects: [] } } });
    const [terms] = await connection.query('SELECT term_label AS label FROM grading_periods WHERE school_year_id = ? ORDER BY term_number', [yearId]);
    const [assignments] = await connection.query(`SELECT ss.id, ss.section_id AS sectionId, gls.section_name AS section,
      es.id AS subjectId, es.subject_name AS subject, gl.grade_level AS grade
      FROM \`subject-section\` ss JOIN elem_subjects es ON es.id = ss.subject_id
      JOIN grade_level gl ON gl.id = es.grade_level_id
      LEFT JOIN grade_level_sections gls ON gls.id = ss.section_id WHERE ss.school_year_id = ?`, [yearId]);
    const conditions = ['ss.school_year_id = ?', 'gp.school_year_id = ?', 'gp.term_label = ?', "gi.tab = 'exams'", 'UPPER(gi.exam_type) = ?', 'st.is_deleted = 0'];
    const params = [yearId, yearId, term, examination];
    for (const [value, column] of [[grade, 'gl.grade_level'], [section, 'ss.section_id'], [subject, 'es.id']]) {
      if (value) { conditions.push(`${column} = ?`); params.push(value); }
    }
    const [rows] = await connection.query(`SELECT gs.student_id AS studentId, gi.id AS itemId,
      ss.id AS subjectSectionId, es.id AS subjectId, es.subject_name AS subject,
      UPPER(gi.exam_type) AS examination, gi.max_items AS hps, gs.score
      FROM grade_items gi JOIN grade_scores gs ON gs.item_id = gi.id
      JOIN \`subject-section\` ss ON ss.id = gi.subject_section_id
      JOIN grading_periods gp ON gp.id = gi.grading_period_id
      JOIN elem_subjects es ON es.id = ss.subject_id JOIN grade_level gl ON gl.id = es.grade_level_id
      JOIN elem_students st ON st.id = gs.student_id
      WHERE ${conditions.join(' AND ')} ORDER BY es.subject_name, gi.id, gs.student_id`, params);
    const unique = (rows, key, label) => [...new Map(rows.filter(row => row[key] != null).map(row => [String(row[key]), { id: String(row[key]), label: row[label] }])).values()];
    return res.json({ success: true, data: { ...summarize(rows), schoolYear: String(yearId), options: {
      years: years.map(year => ({ id: String(year.id), label: year.label })), terms: terms.map(row => row.label),
      sections: unique(assignments.filter(row => !grade || row.grade === grade), 'sectionId', 'section'),
      subjects: unique(assignments.filter(row => (!grade || row.grade === grade) && (!section || String(row.sectionId) === section)), 'subjectId', 'subject'),
    } } });
  } catch (error) {
    console.error('Examination analytics failed:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch examination statistics.' });
  }
};
