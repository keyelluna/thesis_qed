CREATE TABLE IF NOT EXISTS student_transfer_ins (
 student_id BIGINT NOT NULL, school_year_id BIGINT NOT NULL,
 joined_date DATE NOT NULL, recorded_by BIGINT NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (student_id, school_year_id), KEY idx_transfer_joined (school_year_id, joined_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
