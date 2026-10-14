-- Per-user stars for files stored inside shared projects.
-- A project file can be starred independently by multiple project members.

CREATE TABLE IF NOT EXISTS project_file_stars (
    user_id CHAR(36) NOT NULL,
    file_id CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, file_id),
    INDEX idx_project_file_stars_file (file_id),
    INDEX idx_project_file_stars_user_created (user_id, created_at),
    CONSTRAINT fk_project_file_stars_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_file_stars_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
