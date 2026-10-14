-- Project ownership and machine-client foundation for existing CloudVault databases.
-- This migration is recorded by run-migrations.sh and is safe for existing personal rows.

CREATE TABLE IF NOT EXISTS projects (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    slug VARCHAR(63) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    description VARCHAR(1000),
    status ENUM('active', 'suspended', 'archived') NOT NULL DEFAULT 'active',
    storage_quota BIGINT NOT NULL,
    storage_used BIGINT NOT NULL DEFAULT 0,
    max_file_size BIGINT NOT NULL,
    warning_percent TINYINT UNSIGNED NOT NULL DEFAULT 80,
    retention_policy JSON,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_projects_status (status),
    INDEX idx_projects_created_by (created_by),
    CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_projects_warning_percent CHECK (warning_percent BETWEEN 1 AND 100),
    CONSTRAINT chk_projects_quota CHECK (storage_quota >= 0 AND storage_used >= 0),
    CONSTRAINT chk_projects_max_file CHECK (max_file_size > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_memberships (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    project_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    role ENUM('viewer', 'editor', 'admin') NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_project_membership (project_id, user_id),
    INDEX idx_project_memberships_user (user_id),
    CONSTRAINT fk_project_memberships_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_memberships_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_accounts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    project_id CHAR(36) NOT NULL,
    name VARCHAR(120) NOT NULL,
    token_prefix VARCHAR(24),
    token_hash CHAR(64),
    scopes JSON NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMP NULL,
    last_used_at TIMESTAMP NULL,
    revoked_at TIMESTAMP NULL,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_service_account_name (project_id, name),
    UNIQUE INDEX uq_service_account_token_hash (token_hash),
    INDEX idx_service_accounts_project_active (project_id, is_active),
    CONSTRAINT fk_service_accounts_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_service_accounts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'folders' AND column_name = 'project_id') = 0,
    'ALTER TABLE folders ADD COLUMN project_id CHAR(36) NULL AFTER user_id, ADD COLUMN created_by_service_account_id CHAR(36) NULL AFTER project_id, ADD INDEX idx_folders_project (project_id), ADD CONSTRAINT fk_folders_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE, ADD CONSTRAINT fk_folders_service_account FOREIGN KEY (created_by_service_account_id) REFERENCES service_accounts(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
ALTER TABLE folders MODIFY COLUMN user_id CHAR(36) NULL;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'files' AND column_name = 'project_id') = 0,
    'ALTER TABLE files ADD COLUMN project_id CHAR(36) NULL AFTER user_id, ADD COLUMN created_by_service_account_id CHAR(36) NULL AFTER project_id, ADD COLUMN status ENUM(''PENDING'',''AVAILABLE'',''FAILED'',''DELETED'') NOT NULL DEFAULT ''AVAILABLE'' AFTER current_version, ADD COLUMN metadata_json JSON NULL AFTER status, ADD COLUMN retention_until TIMESTAMP NULL AFTER metadata_json, ADD INDEX idx_files_project (project_id), ADD INDEX idx_files_project_status (project_id, status), ADD CONSTRAINT fk_files_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE, ADD CONSTRAINT fk_files_service_account FOREIGN KEY (created_by_service_account_id) REFERENCES service_accounts(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
ALTER TABLE files MODIFY COLUMN user_id CHAR(36) NULL;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'file_versions' AND column_name = 'uploaded_by_service_account_id') = 0,
    'ALTER TABLE file_versions ADD COLUMN uploaded_by_service_account_id CHAR(36) NULL AFTER uploaded_by, ADD CONSTRAINT fk_file_versions_service_account FOREIGN KEY (uploaded_by_service_account_id) REFERENCES service_accounts(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
ALTER TABLE file_versions MODIFY COLUMN uploaded_by CHAR(36) NULL;
ALTER TABLE file_versions DROP FOREIGN KEY fk_file_versions_user;
ALTER TABLE file_versions ADD CONSTRAINT fk_file_versions_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS project_uploads (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    project_id CHAR(36) NOT NULL,
    service_account_id CHAR(36),
    user_id CHAR(36),
    file_id CHAR(36),
    idempotency_key VARCHAR(255) NOT NULL,
    checksum_sha256 CHAR(64) NOT NULL,
    reserved_bytes BIGINT NOT NULL DEFAULT 0,
    status ENUM('PENDING', 'AVAILABLE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    error_code VARCHAR(64),
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE INDEX uq_project_upload_idempotency (project_id, idempotency_key),
    INDEX idx_project_upload_status (project_id, status, created_at),
    CONSTRAINT fk_project_uploads_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_uploads_service_account FOREIGN KEY (service_account_id) REFERENCES service_accounts(id) ON DELETE SET NULL,
    CONSTRAINT fk_project_uploads_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_project_uploads_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
