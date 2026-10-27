CREATE TABLE IF NOT EXISTS student_dropout_events (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 student_id BIGINT NOT NULL, class_id BIGINT NOT NULL, school_year_id BIGINT NOT NULL,
 last_attended DATE NULL, effective_date DATE NOT NULL,
 reason VARCHAR(100) NOT NULL, remarks VARCHAR(1000) NOT NULL DEFAULT '',
 declared_by BIGINT NOT NULL, declared_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reversed_by BIGINT NULL, reversed_at TIMESTAMP NULL DEFAULT NULL, reversal_reason VARCHAR(1000) NULL,
 active_student_id BIGINT GENERATED ALWAYS AS (CASE WHEN reversed_at IS NULL THEN student_id ELSE NULL END) STORED,
 UNIQUE KEY uq_dropout_active_year (school_year_id, active_student_id),
 KEY idx_dropout_class (class_id, school_year_id, effective_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
