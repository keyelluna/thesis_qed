// SQL translation of the existing Principal Gradesheets controller gate:
// advisory class/term submission first; external subjects require subject submission;
// the adviser's own completed subject is eligible through advisory submission.
// Callers retain their existing completeness/null checks and all arithmetic.
// EXISTS preserves aggregate cardinality. Aliases are fixed internal call-site constants.
const publishedClass = function(student,period,extra='1 = 1'){return `EXISTS (
 SELECT 1 FROM classes publication_class
 JOIN grading_periods publication_period ON publication_period.id = ${period}
 JOIN grade_submissions publication_submission
   ON publication_submission.grading_period_id = publication_period.id
  AND ((publication_class.section_id IS NOT NULL AND publication_submission.section_id = publication_class.section_id)
    OR (publication_class.section_id IS NULL AND publication_submission.section_id IS NULL AND publication_submission.grade_level_id = publication_class.grade_level_id))
 WHERE publication_class.status = 'Active'
   AND publication_class.school_year_id = publication_period.school_year_id
   AND ${student}.current_school_year_id = publication_period.school_year_id
   AND ((${student}.section_id IS NOT NULL AND publication_class.section_id = ${student}.section_id)
     OR (${student}.section_id IS NULL AND publication_class.section_id IS NULL AND publication_class.grade_level_id = ${student}.grade_level_id))
   AND (${extra})
)`;};
const subjectGradePublished = function(student='st',cache='sgc',subject='ss'){return publishedClass(student,`${cache}.grading_period_id`,`${subject}.school_year_id = publication_period.school_year_id AND ${subject}.status = 'Active'
 AND (${subject}.section_id = publication_class.section_id
   OR (${subject}.section_id IS NULL AND EXISTS (SELECT 1 FROM elem_subjects publication_definition WHERE publication_definition.id = ${subject}.subject_id AND publication_definition.grade_level_id = publication_class.grade_level_id)))
 AND (
 (publication_class.class_adviser_id IS NOT NULL AND ${subject}.teacher_id = publication_class.class_adviser_id)
 OR EXISTS (SELECT 1 FROM subject_grade_submissions publication_subject
   WHERE publication_subject.subject_section_id = ${cache}.subject_section_id
     AND publication_subject.grading_period_id = ${cache}.grading_period_id)
)`);};
const advisoryGradePublished = function(student='st',cache='aog'){return `(((${cache}.section_id IS NOT NULL AND ${cache}.section_id = ${student}.section_id)
 OR (${cache}.section_id IS NULL AND ${student}.section_id IS NULL AND ${cache}.grade_level_id = ${student}.grade_level_id))
 AND ${publishedClass(student,`${cache}.grading_period_id`)})`;};
module.exports = { subjectGradePublished, advisoryGradePublished };
