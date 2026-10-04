-- Run once against the QED database before restarting the updated backend.
-- Existing teachers remain NULL until an administrator confirms their gender;
-- do not infer a personal attribute solely from a name.
ALTER TABLE teacher_table
  ADD COLUMN gender ENUM('Male', 'Female') NULL DEFAULT NULL AFTER status;
git 