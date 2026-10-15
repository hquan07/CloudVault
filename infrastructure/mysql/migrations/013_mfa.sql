-- Optional TOTP multi-factor authentication with encrypted secrets and
-- one-time recovery-code hashes.

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'mfa_enabled') = 0,
    'ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER is_verified',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'mfa_secret_encrypted') = 0,
    'ALTER TABLE users ADD COLUMN mfa_secret_encrypted VARCHAR(1000) NULL AFTER mfa_enabled',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'mfa_recovery_codes') = 0,
    'ALTER TABLE users ADD COLUMN mfa_recovery_codes JSON NULL AFTER mfa_secret_encrypted',
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE audit_logs
    MODIFY COLUMN action ENUM(
        'USER_REGISTERED', 'USER_LOGGED_IN', 'USER_LOGGED_OUT', 'USER_UPDATED',
        'FILE_UPLOADED', 'FILE_DOWNLOADED', 'FILE_DELETED', 'FILE_RESTORED',
        'FILE_MOVED', 'FILE_COPIED', 'FILE_SHARED', 'FILE_VERSIONED',
        'FILE_STARRED', 'FILE_UNSTARRED', 'FILE_PERMANENTLY_DELETED',
        'FOLDER_CREATED', 'FOLDER_DELETED', 'FOLDER_RENAMED',
        'SHARE_CREATED', 'SHARE_ACCESSED', 'SHARE_REVOKED',
        'PASSWORD_CHANGED', 'QUOTA_EXCEEDED',
        'PROJECT_CREATED', 'PROJECT_UPDATED', 'PROJECT_ARCHIVED',
        'PROJECT_RESTORED', 'PROJECT_DELETED', 'PROJECT_PINNED', 'PROJECT_UNPINNED',
        'USER_LOGIN_FAILED', 'SESSION_REVOKED', 'SESSIONS_REVOKED',
        'REFRESH_TOKEN_REPLAYED', 'MFA_ENABLED', 'MFA_DISABLED',
        'MFA_RECOVERY_USED'
    ) NOT NULL;
