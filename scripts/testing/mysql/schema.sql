-- Synthetic local fixture only. NEVER run against a deployed QED database.
USE qed_release_test;
CREATE TABLE qed_authentication (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_name VARCHAR(191) NOT NULL UNIQUE,
 password VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL,
 must_change_password TINYINT NOT NULL DEFAULT 1, is_deleted TINYINT NOT NULL DEFAULT 0,
 password_reset_otp VARCHAR(255) NULL, otp_expires_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE admin_table (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL UNIQUE,
 first_name VARCHAR(100) NOT NULL, last_name VARCHAR(100) NOT NULL, middle_name VARCHAR(100) NOT NULL DEFAULT '',
 email_address VARCHAR(254) NOT NULL, contact_number VARCHAR(32) NOT NULL,
 status VARCHAR(20) NOT NULL, is_deleted TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE teacher_table LIKE admin_table;
ALTER TABLE teacher_table ADD gender ENUM('Male','Female') NULL, ADD avatar_key VARCHAR(40) NULL;
CREATE TABLE principal_table LIKE admin_table;
ALTER TABLE principal_table ADD gender ENUM('Male','Female') NULL;
CREATE TABLE parent_table LIKE admin_table;
ALTER TABLE parent_table ADD gender ENUM('Male','Female') NULL;
CREATE TABLE school_year (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, school_year VARCHAR(40) NOT NULL, is_active TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;
CREATE TABLE grading_periods (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, school_year_id BIGINT NOT NULL,
 term_number INT NOT NULL, term_label VARCHAR(100), start_date DATE, end_date DATE, is_active TINYINT DEFAULT 0,
 UNIQUE KEY uq_period (school_year_id,term_number)
) ENGINE=InnoDB;
CREATE TABLE elem_students (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, section_id BIGINT NULL, grade_level_id BIGINT NOT NULL,
 current_school_year_id BIGINT NOT NULL, status VARCHAR(20) DEFAULT 'Active', is_deleted TINYINT DEFAULT 0
) ENGINE=InnoDB;
CREATE TABLE parent_student (
 parent_id BIGINT UNSIGNED NOT NULL, student_id BIGINT NOT NULL, PRIMARY KEY (parent_id,student_id)
) ENGINE=InnoDB;
CREATE TABLE grade_visibility (
 student_id BIGINT NOT NULL, grading_period_id BIGINT NOT NULL, is_visible TINYINT NOT NULL DEFAULT 0,
 updated_by BIGINT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(student_id,grading_period_id)
) ENGINE=InnoDB;
CREATE TABLE grade_submissions (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, section_id BIGINT NULL, grade_level_id BIGINT NULL,
 grading_period_id BIGINT NOT NULL, submitted_by BIGINT NOT NULL,
 submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_section (section_id,grading_period_id), UNIQUE KEY uq_grade (grade_level_id,grading_period_id)
) ENGINE=InnoDB;
CREATE TABLE elem_subjects (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, subject_name VARCHAR(100) NOT NULL, grade_level_id BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE `subject-section` (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, subject_id BIGINT NOT NULL, school_year_id BIGINT NOT NULL,
 section_id BIGINT NULL, teacher_id BIGINT NULL, status VARCHAR(20) DEFAULT 'Active'
) ENGINE=InnoDB;
CREATE TABLE subject_grade_templates (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, subject_id BIGINT NOT NULL, file_name VARCHAR(255) NOT NULL,
 file_path VARCHAR(512) NOT NULL DEFAULT '', storage_key VARCHAR(512) NULL,
 checksum_sha256 CHAR(64) NULL, structure_json JSON NULL, export_map_json JSON NULL,
 is_active TINYINT DEFAULT 1,
 ww_weight_percent DECIMAL(8,3) DEFAULT 0, pt_weight_percent DECIMAL(8,3) DEFAULT 0,
 exam_weight_percent DECIMAL(8,3) DEFAULT 0,
 exam_st1_subweight_percent DECIMAL(8,3) DEFAULT 0, exam_st2_subweight_percent DECIMAL(8,3) DEFAULT 0,
 exam_te_subweight_percent DECIMAL(8,3) DEFAULT 0
) ENGINE=InnoDB;
CREATE TABLE subject_grade_template_periods (
 subject_section_id BIGINT NOT NULL, grading_period_id BIGINT NOT NULL, template_id BIGINT NOT NULL,
 assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, assignment_source VARCHAR(30) DEFAULT 'first_assessment',
 PRIMARY KEY(subject_section_id,grading_period_id), KEY idx_template_period_template(template_id)
) ENGINE=InnoDB;
CREATE TABLE grade_submission_history (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, submission_type ENUM('subject','advisory') NOT NULL,
 section_id BIGINT NULL, grade_level_id BIGINT NULL, subject_section_id BIGINT NULL,
 grading_period_id BIGINT NOT NULL, submitted_by BIGINT NOT NULL, submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 KEY idx_grade_history_section(section_id,grading_period_id,submitted_at),
 KEY idx_grade_history_grade(grade_level_id,grading_period_id,submitted_at),
 KEY idx_grade_history_subject(subject_section_id,grading_period_id,submitted_at)
) ENGINE=InnoDB;
