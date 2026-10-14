-- Manual additive migration. Run once, before using the updated backend/scripts.
-- Keep file_path for legacy recovery. Existing template IDs and period pins are unchanged.
-- New object-backed rows store an empty file_path (also compatible with NOT NULL legacy schemas).
ALTER TABLE subject_grade_templates
  ADD COLUMN storage_key VARCHAR(512) NULL AFTER file_path;
