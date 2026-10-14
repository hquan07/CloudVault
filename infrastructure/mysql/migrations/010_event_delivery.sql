-- Idempotency records for at-least-once Kafka delivery.

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'audit_logs'
       AND column_name = 'event_id') = 0,
    'ALTER TABLE audit_logs ADD COLUMN event_id CHAR(36) NULL AFTER id',
    'SELECT 1'
);
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF(
    (SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'audit_logs'
       AND index_name = 'uq_audit_event') = 0,
    'CREATE UNIQUE INDEX uq_audit_event ON audit_logs(event_id)',
    'SELECT 1'
);
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

CREATE TABLE IF NOT EXISTS worker_processed_events (
    consumer_group VARCHAR(100) NOT NULL,
    event_id CHAR(36) NOT NULL,
    processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (consumer_group, event_id),
    INDEX idx_worker_events_processed (processed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
