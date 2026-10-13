-- Add the folder sharing permissions table required by file-service.
-- Safe for existing installations and idempotent for fresh databases.

CREATE TABLE IF NOT EXISTS folder_permissions (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    folder_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    role ENUM('viewer', 'editor', 'manager') NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE INDEX uq_folder_permissions_folder_user (folder_id, user_id),
    INDEX idx_folder_permissions_user (user_id),
    CONSTRAINT fk_folder_permissions_folder FOREIGN KEY (folder_id)
        REFERENCES folders(id) ON DELETE CASCADE,
    CONSTRAINT fk_folder_permissions_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
