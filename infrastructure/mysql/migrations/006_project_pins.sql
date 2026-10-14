-- Per-user project pins for prioritizing projects without changing shared state.

CREATE TABLE IF NOT EXISTS project_pins (
    user_id CHAR(36) NOT NULL,
    project_id CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, project_id),
    INDEX idx_project_pins_project (project_id),
    INDEX idx_project_pins_user_created (user_id, created_at),
    CONSTRAINT fk_project_pins_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_pins_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
