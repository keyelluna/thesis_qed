CREATE TABLE IF NOT EXISTS principal_grade_approvals (
  student_id BIGINT NOT NULL,
  grading_period_id BIGINT NOT NULL,
  grade_fingerprint CHAR(64) CHARACTER SET ascii NOT NULL,
  approved_by BIGINT NOT NULL,
  approved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, grading_period_id)
) ENGINE=InnoDB;
