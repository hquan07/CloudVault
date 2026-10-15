-- Resumable project uploads backed by MinIO multipart sessions.
SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'multipart_upload_id') = 0,
    'ALTER TABLE project_uploads ADD COLUMN multipart_upload_id VARCHAR(255) NULL AFTER object_key',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'upload_kind') = 0,
    'ALTER TABLE project_uploads ADD COLUMN upload_kind VARCHAR(20) NOT NULL DEFAULT ''proxy'' AFTER multipart_upload_id',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'original_name') = 0,
    'ALTER TABLE project_uploads ADD COLUMN original_name VARCHAR(255) NULL AFTER upload_kind',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'mime_type') = 0,
    'ALTER TABLE project_uploads ADD COLUMN mime_type VARCHAR(255) NULL AFTER original_name',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'file_size') = 0,
    'ALTER TABLE project_uploads ADD COLUMN file_size BIGINT NULL AFTER mime_type',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'folder_id') = 0,
    'ALTER TABLE project_uploads ADD COLUMN folder_id CHAR(36) NULL AFTER file_size, ADD INDEX idx_project_upload_folder (folder_id), ADD CONSTRAINT fk_project_uploads_folder FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'metadata_json') = 0,
    'ALTER TABLE project_uploads ADD COLUMN metadata_json JSON NULL AFTER folder_id',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'part_size') = 0,
    'ALTER TABLE project_uploads ADD COLUMN part_size BIGINT NULL AFTER metadata_json',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @sql = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'project_uploads' AND column_name = 'part_count') = 0,
    'ALTER TABLE project_uploads ADD COLUMN part_count INT NULL AFTER part_size',
    'SELECT 1');
PREPARE migration_stmt FROM @sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
