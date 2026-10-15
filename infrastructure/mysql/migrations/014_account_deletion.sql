-- Safe account deletion lifecycle, ownership transfer support and purge queue.

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='deletion_status') = 0,
    'ALTER TABLE users ADD COLUMN deletion_status ENUM(''active'', ''pending'', ''purging'', ''failed'', ''deleted'') NOT NULL DEFAULT ''active'' AFTER mfa_recovery_codes',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='deletion_requested_at') = 0,
    'ALTER TABLE users ADD COLUMN deletion_requested_at TIMESTAMP NULL AFTER deletion_status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='deletion_scheduled_at') = 0,
    'ALTER TABLE users ADD COLUMN deletion_scheduled_at TIMESTAMP NULL AFTER deletion_requested_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='deletion_completed_at') = 0,
    'ALTER TABLE users ADD COLUMN deletion_completed_at TIMESTAMP NULL AFTER deletion_scheduled_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='anonymized_at') = 0,
    'ALTER TABLE users ADD COLUMN anonymized_at TIMESTAMP NULL AFTER deletion_completed_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='users' AND index_name='idx_users_deletion_status') = 0,
    'CREATE INDEX idx_users_deletion_status ON users(deletion_status, deletion_scheduled_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='service_accounts' AND constraint_name='fk_service_accounts_created_by') > 0,
    'ALTER TABLE service_accounts DROP FOREIGN KEY fk_service_accounts_created_by', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE service_accounts MODIFY COLUMN created_by CHAR(36) NULL;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='service_accounts' AND constraint_name='fk_service_accounts_created_by') = 0,
    'ALTER TABLE service_accounts ADD CONSTRAINT fk_service_accounts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE account_deletion_requests (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    status ENUM('scheduled', 'purging', 'completed', 'cancelled', 'failed')
        NOT NULL DEFAULT 'scheduled',
    execute_after TIMESTAMP NOT NULL,
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_error VARCHAR(1000),
    started_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    cancelled_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE INDEX uq_account_deletion_user (user_id),
    INDEX idx_account_deletion_due (status, execute_after),
    CONSTRAINT fk_account_deletion_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE audit_logs
    MODIFY COLUMN action ENUM(
        'USER_REGISTERED', 'USER_LOGGED_IN', 'USER_LOGGED_OUT', 'USER_UPDATED',
        'FILE_UPLOADED', 'FILE_DOWNLOADED', 'FILE_DELETED', 'FILE_RESTORED',
        'FILE_MOVED', 'FILE_COPIED', 'FILE_SHARED', 'FILE_VERSIONED',
        'FILE_STARRED', 'FILE_UNSTARRED', 'FILE_PERMANENTLY_DELETED',
        'FOLDER_CREATED', 'FOLDER_DELETED', 'FOLDER_RENAMED',
        'SHARE_CREATED', 'SHARE_ACCESSED', 'SHARE_REVOKED',
        'PASSWORD_CHANGED', 'QUOTA_EXCEEDED',
        'USER_LOGIN_FAILED', 'SESSION_REVOKED', 'SESSIONS_REVOKED',
        'REFRESH_TOKEN_REPLAYED', 'MFA_ENABLED', 'MFA_DISABLED',
        'MFA_RECOVERY_USED',
        'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_ARCHIVED',
        'PROJECT_RESTORED', 'PROJECT_DELETED', 'PROJECT_PINNED', 'PROJECT_UNPINNED',
        'PROJECT_OWNERSHIP_TRANSFERRED', 'ACCOUNT_DELETION_REQUESTED',
        'ACCOUNT_DELETION_CANCELLED', 'ACCOUNT_DELETION_COMPLETED',
        'ACCOUNT_DELETION_FAILED'
    ) NOT NULL,
    MODIFY COLUMN resource_type ENUM('user', 'file', 'folder', 'share', 'project') NOT NULL;
