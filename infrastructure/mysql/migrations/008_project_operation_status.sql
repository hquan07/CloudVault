-- Latest reconciliation result shown to project members and operators.
CREATE TABLE IF NOT EXISTS project_operation_status (
    project_id CHAR(36) PRIMARY KEY,
    health_status ENUM('healthy', 'warning', 'critical') NOT NULL DEFAULT 'healthy',
    metadata_bytes BIGINT NOT NULL DEFAULT 0,
    object_bytes BIGINT NOT NULL DEFAULT 0,
    usage_drift_bytes BIGINT NOT NULL DEFAULT 0,
    missing_objects INT NOT NULL DEFAULT 0,
    orphan_objects INT NOT NULL DEFAULT 0,
    stale_uploads INT NOT NULL DEFAULT 0,
    expired_files INT NOT NULL DEFAULT 0,
    details_json JSON,
    checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_project_operation_status_project FOREIGN KEY (project_id)
        REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
