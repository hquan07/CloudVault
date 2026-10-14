-- Attribute audit records to project users and service accounts.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND column_name = 'project_id') = 0,
    'ALTER TABLE audit_logs ADD COLUMN project_id CHAR(36) NULL AFTER user_id, ADD COLUMN service_account_id CHAR(36) NULL AFTER project_id, ADD INDEX idx_audit_project (project_id), ADD INDEX idx_audit_service_account (service_account_id), ADD CONSTRAINT fk_audit_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL, ADD CONSTRAINT fk_audit_service_account FOREIGN KEY (service_account_id) REFERENCES service_accounts(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'object_key') = 0,
    'ALTER TABLE project_uploads ADD COLUMN object_key VARCHAR(1024) NULL AFTER checksum_sha256',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
