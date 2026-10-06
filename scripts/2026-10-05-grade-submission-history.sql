CREATE TABLE IF NOT EXISTS grade_submission_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  submission_type ENUM('subject', 'advisory') NOT NULL,
  section_id BIGINT NULL,
  grade_level_id BIGINT NULL,
  subject_section_id BIGINT NULL,
  grading_period_id BIGINT NOT NULL,
  submitted_by BIGINT NOT NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_grade_history_section (section_id, grading_period_id, submitted_at),
  INDEX idx_grade_history_grade (grade_level_id, grading_period_id, submitted_at),
  INDEX idx_grade_history_subject (subject_section_id, grading_period_id, submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
