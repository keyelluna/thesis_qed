CREATE TABLE IF NOT EXISTS system_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT NULL,
  actor_username VARCHAR(150) NULL,
  actor_role VARCHAR(40) NULL,
  action_type VARCHAR(40) NOT NULL,
  resource_name VARCHAR(190) NOT NULL,
  resource_id VARCHAR(100) NULL,
  http_method VARCHAR(10) NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  status_code SMALLINT UNSIGNED NOT NULL,
  changed_fields JSON NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_created (created_at),
  INDEX idx_audit_actor (actor_user_id, actor_role),
  INDEX idx_audit_resource (resource_name, resource_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
