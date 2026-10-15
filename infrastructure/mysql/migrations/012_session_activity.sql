-- Preserve the logical sign-in start across refresh-token rotation and expose
-- the most recent renewal time in Account Settings.

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'refresh_tokens'
       AND column_name = 'session_started_at') = 0,
    'ALTER TABLE refresh_tokens ADD COLUMN session_started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER ip_address',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'refresh_tokens'
       AND column_name = 'last_used_at') = 0,
    'ALTER TABLE refresh_tokens ADD COLUMN last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER session_started_at',
    'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE refresh_tokens
SET session_started_at = created_at,
    last_used_at = created_at;
