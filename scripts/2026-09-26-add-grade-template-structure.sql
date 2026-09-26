-- Run once against the QED database before deploying template-structure support.
ALTER TABLE subject_grade_templates
  ADD COLUMN structure_json JSON NULL AFTER exam_te_subweight_percent;

ALTER TABLE grade_items
  ADD COLUMN template_domain_id VARCHAR(100) NULL AFTER topic_id;
