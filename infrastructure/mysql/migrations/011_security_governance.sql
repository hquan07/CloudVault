-- Authentication/session audit vocabulary and active-session lookup support.

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
        'REFRESH_TOKEN_REPLAYED'
    ) NOT NULL;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'refresh_tokens'
       AND index_name = 'idx_refresh_tokens_active') = 0,
    'CREATE INDEX idx_refresh_tokens_active ON refresh_tokens(user_id, revoked, expires_at)',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
