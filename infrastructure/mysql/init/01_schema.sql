-- ============================================
-- CloudVault — Database Schema
-- Modern Personal Cloud Storage Platform
-- ============================================

-- Use the cloudvault database
USE cloudvault;

-- ============================================
-- USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255),
    avatar_url VARCHAR(500),
    storage_quota BIGINT NOT NULL DEFAULT 5368709120,  -- 5GB in bytes
    storage_used BIGINT NOT NULL DEFAULT 0,
    oauth_provider ENUM('local', 'google', 'github') NOT NULL DEFAULT 'local',
    oauth_id VARCHAR(255),
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_users_email (email),
    INDEX idx_users_username (username),
    INDEX idx_users_oauth (oauth_provider, oauth_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- REFRESH TOKENS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMP NULL,
    user_agent VARCHAR(500),
    ip_address VARCHAR(45),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_refresh_tokens_user (user_id),
    INDEX idx_refresh_tokens_hash (token_hash),
    INDEX idx_refresh_tokens_expires (expires_at),
    CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) 
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- FOLDERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS folders (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    name VARCHAR(255) NOT NULL,
    parent_id CHAR(36),
    user_id CHAR(36) NOT NULL,
    path VARCHAR(2000) NOT NULL DEFAULT '/',
    depth INT NOT NULL DEFAULT 0,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_folders_user (user_id),
    INDEX idx_folders_parent (parent_id),
    INDEX idx_folders_path (path(768)),
    CONSTRAINT fk_folders_user FOREIGN KEY (user_id) 
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_folders_parent FOREIGN KEY (parent_id) 
        REFERENCES folders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- FILES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS files (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(127) NOT NULL DEFAULT 'application/octet-stream',
    size BIGINT NOT NULL DEFAULT 0,
    folder_id CHAR(36),
    user_id CHAR(36) NOT NULL,
    minio_bucket VARCHAR(63) NOT NULL,
    minio_key VARCHAR(1024) NOT NULL,
    checksum_sha256 VARCHAR(64),
    thumbnail_key VARCHAR(1024),
    current_version INT NOT NULL DEFAULT 1,
    is_starred BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_files_user (user_id),
    INDEX idx_files_folder (folder_id),
    INDEX idx_files_mime (mime_type),
    INDEX idx_files_deleted (is_deleted, deleted_at),
    INDEX idx_files_created (created_at),
    FULLTEXT INDEX ft_files_name (original_name),
    CONSTRAINT fk_files_user FOREIGN KEY (user_id) 
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_files_folder FOREIGN KEY (folder_id) 
        REFERENCES folders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- FILE VERSIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS file_versions (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    file_id CHAR(36) NOT NULL,
    version_number INT NOT NULL,
    minio_key VARCHAR(1024) NOT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    checksum_sha256 VARCHAR(64),
    uploaded_by CHAR(36) NOT NULL,
    comment VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_file_versions_file (file_id),
    UNIQUE INDEX idx_file_versions_unique (file_id, version_number),
    CONSTRAINT fk_file_versions_file FOREIGN KEY (file_id) 
        REFERENCES files(id) ON DELETE CASCADE,
    CONSTRAINT fk_file_versions_user FOREIGN KEY (uploaded_by) 
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- SHARED LINKS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS shared_links (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    file_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    token VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255),
    expires_at TIMESTAMP NULL,
    download_count INT NOT NULL DEFAULT 0,
    max_downloads INT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_shared_links_token (token),
    INDEX idx_shared_links_file (file_id),
    INDEX idx_shared_links_user (user_id),
    INDEX idx_shared_links_expires (expires_at),
    CONSTRAINT fk_shared_links_file FOREIGN KEY (file_id) 
        REFERENCES files(id) ON DELETE CASCADE,
    CONSTRAINT fk_shared_links_user FOREIGN KEY (user_id) 
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- AUDIT LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36),
    action ENUM(
        'USER_REGISTERED', 'USER_LOGGED_IN', 'USER_LOGGED_OUT', 'USER_UPDATED',
        'FILE_UPLOADED', 'FILE_DOWNLOADED', 'FILE_DELETED', 'FILE_RESTORED',
        'FILE_MOVED', 'FILE_COPIED', 'FILE_SHARED', 'FILE_VERSIONED',
        'FOLDER_CREATED', 'FOLDER_DELETED', 'FOLDER_RENAMED',
        'SHARE_CREATED', 'SHARE_ACCESSED', 'SHARE_REVOKED',
        'PASSWORD_CHANGED', 'QUOTA_EXCEEDED'
    ) NOT NULL,
    resource_type ENUM('user', 'file', 'folder', 'share') NOT NULL,
    resource_id CHAR(36),
    ip_address VARCHAR(45),
    user_agent VARCHAR(500),
    details_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_action (action),
    INDEX idx_audit_resource (resource_type, resource_id),
    INDEX idx_audit_created (created_at),
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) 
        REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- ANALYTICS DAILY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS analytics_daily (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    date DATE NOT NULL UNIQUE,
    total_uploads INT NOT NULL DEFAULT 0,
    total_downloads INT NOT NULL DEFAULT 0,
    total_storage_delta BIGINT NOT NULL DEFAULT 0,
    total_shares INT NOT NULL DEFAULT 0,
    active_users INT NOT NULL DEFAULT 0,
    new_users INT NOT NULL DEFAULT 0,
    bytes_uploaded BIGINT NOT NULL DEFAULT 0,
    bytes_downloaded BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_analytics_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- SEED DATA: Create a demo user (password: demo123)
-- ============================================
-- Password hash for 'demo123' using bcrypt
-- INSERT INTO users (email, username, password_hash, is_verified) 
-- VALUES ('demo@cloudvault.dev', 'demo', '$2b$12$...hash...', TRUE);
