-- Run once against the QED database before deploying immutable template exports.
ALTER TABLE subject_grade_templates
  ADD COLUMN checksum_sha256 CHAR(64) NULL AFTER file_path,
  ADD COLUMN export_map_json JSON NULL AFTER structure_json;

CREATE TABLE IF NOT EXISTS subject_grade_template_periods (
  subject_section_id BIGINT NOT NULL,
  grading_period_id BIGINT NOT NULL,
  template_id BIGINT NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assignment_source ENUM('legacy_snapshot', 'first_assessment', 'first_export') NOT NULL DEFAULT 'first_assessment',
  PRIMARY KEY (subject_section_id, grading_period_id),
  KEY idx_template_period_template (template_id)
);

-- Existing term data is pinned to the active template at migration time. This
-- is the only deterministic choice available for legacy rows without a stored
-- template-version reference; all later uploads leave these assignments alone.
INSERT IGNORE INTO subject_grade_template_periods
  (subject_section_id, grading_period_id, template_id, assignment_source)
SELECT DISTINCT gi.subject_section_id, gi.grading_period_id, t.id, 'legacy_snapshot'
  FROM grade_items gi
  INNER JOIN `subject-section` ss ON ss.id = gi.subject_section_id
  INNER JOIN subject_grade_templates t ON t.subject_id = ss.subject_id AND t.is_active = 1
 WHERE gi.grading_period_id IS NOT NULL;

-- Older template versions already remain as inactive rows/files. Populate
-- their checksums and mapping JSON in a controlled backend maintenance pass;
-- this migration intentionally avoids rewriting any uploaded workbook bytes.
