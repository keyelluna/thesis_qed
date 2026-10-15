-- MANUAL OWNER REVIEW ONLY. Not executed by QED or by automated tests.
-- Use a read-only account and an encrypted/private terminal. Export only aggregates.
START TRANSACTION READ ONLY;
SELECT TABLE_NAME, ENGINE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN
 ('qed_authentication','admin_table','principal_table','teacher_table','parent_table',
  'school_year','grading_periods','elem_students','parent_student','classes','subject-section',
  'grade_visibility','grade_submissions','subject_grade_submissions','grade_submission_history',
  'subject_grade_templates','subject_grade_template_periods','grade_items','grade_scores',
  'subject_grade_cache','advisory_overall_grades','system_audit_logs','login_logs');
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN
 ('qed_authentication','admin_table','principal_table','teacher_table','parent_table',
  'grading_periods','elem_students','grade_visibility','grade_submissions',
  'subject_grade_templates','subject_grade_template_periods','grade_items')
ORDER BY TABLE_NAME, ORDINAL_POSITION;
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN
 ('qed_authentication','admin_table','principal_table','teacher_table','parent_table',
  'grade_visibility','grade_submissions','subject_grade_template_periods')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
-- No usernames, password hashes, reset codes, names, contacts or student rows.
SELECT CASE WHEN UPPER(role) IN ('ADMIN','PRINCIPAL','TEACHER','PARENT')
 THEN UPPER(role) ELSE 'UNRECOGNIZED' END AS role_class, COUNT(*) AS account_count
FROM qed_authentication GROUP BY role_class;
SELECT COUNT(*) AS authentication_rows_without_matching_role_profile
FROM qed_authentication a
LEFT JOIN admin_table ad ON UPPER(a.role)='ADMIN' AND ad.user_id=a.id
LEFT JOIN principal_table pr ON UPPER(a.role)='PRINCIPAL' AND pr.user_id=a.id
LEFT JOIN teacher_table tc ON UPPER(a.role)='TEACHER' AND tc.user_id=a.id
LEFT JOIN parent_table pa ON UPPER(a.role)='PARENT' AND pa.user_id=a.id
WHERE ad.id IS NULL AND pr.id IS NULL AND tc.id IS NULL AND pa.id IS NULL;
SELECT COUNT(*) AS duplicated_authentication_identifiers
FROM (SELECT user_name FROM qed_authentication GROUP BY user_name HAVING COUNT(*)>1) duplicates;
-- Audit table may be absent on an older deployment: stop and record the absence.
SELECT status_code, COUNT(*) AS registration_requests
FROM system_audit_logs WHERE endpoint='/api/auth/register' GROUP BY status_code;
COMMIT;
