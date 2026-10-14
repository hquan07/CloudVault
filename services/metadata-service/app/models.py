"""
CloudVault — Metadata Service SQLAlchemy Models
Maps to files, folders, file_versions, shared_links, audit_logs, analytics_daily tables.
"""

import uuid
from sqlalchemy import (
    Column, String, BigInteger, Integer, Boolean, Enum, DateTime, JSON, Date, Text, func, ForeignKey,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    """Read-only reference to users table (owned by auth-service)."""
    __tablename__ = "users"

    id = Column(String(36), primary_key=True)
    email = Column(String(255), nullable=False, unique=True)
    username = Column(String(100), nullable=False, unique=True)
    storage_quota = Column(BigInteger, nullable=False, default=5368709120)
    storage_used = Column(BigInteger, nullable=False, default=0)
    role = Column(String(50), nullable=False, default="user")
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class Project(Base):
    __tablename__ = "projects"

    id = Column(String(36), primary_key=True)
    slug = Column(String(63), nullable=False, unique=True)
    name = Column(String(120), nullable=False)
    description = Column(String(1000), nullable=True)
    status = Column(String(20), nullable=False, default="active")
    storage_quota = Column(BigInteger, nullable=False)
    storage_used = Column(BigInteger, nullable=False, default=0)
    max_file_size = Column(BigInteger, nullable=False)
    warning_percent = Column(BigInteger, nullable=False, default=80)
    retention_policy = Column(JSON, nullable=True)
    created_by = Column(String(36), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class ProjectMembership(Base):
    __tablename__ = "project_memberships"

    id = Column(String(36), primary_key=True)
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class ProjectFileStar(Base):
    __tablename__ = "project_file_stars"

    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    file_id = Column(String(36), ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class ServiceAccount(Base):
    __tablename__ = "service_accounts"

    id = Column(String(36), primary_key=True)
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    token_prefix = Column(String(24), nullable=True)
    token_hash = Column(String(64), nullable=True, unique=True)
    scopes = Column(JSON, nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    expires_at = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)


class Folder(Base):
    __tablename__ = "folders"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    parent_id = Column(String(36), ForeignKey("folders.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    created_by_service_account_id = Column(String(36), ForeignKey("service_accounts.id", ondelete="SET NULL"), nullable=True)
    path = Column(String(2000), nullable=False, default="/")
    depth = Column(Integer, nullable=False, default=0)
    is_deleted = Column(Boolean, nullable=False, default=False)
    deleted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    files = relationship("File", back_populates="folder")
    permissions = relationship("FolderPermission", back_populates="folder", cascade="all, delete-orphan")


class FolderPermission(Base):
    __tablename__ = "folder_permissions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    folder_id = Column(String(36), ForeignKey("folders.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False) # 'viewer', 'editor', 'manager'
    created_at = Column(DateTime, nullable=False, server_default=func.now())

    folder = relationship("Folder", back_populates="permissions")


class File(Base):
    __tablename__ = "files"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    filename = Column(String(255), nullable=False)
    original_name = Column(String(255), nullable=False)
    mime_type = Column(String(127), nullable=False, default="application/octet-stream")
    size = Column(BigInteger, nullable=False, default=0)
    folder_id = Column(String(36), ForeignKey("folders.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    created_by_service_account_id = Column(String(36), ForeignKey("service_accounts.id", ondelete="SET NULL"), nullable=True)
    minio_bucket = Column(String(63), nullable=False)
    minio_key = Column(String(1024), nullable=False)
    checksum_sha256 = Column(String(64), nullable=True)
    thumbnail_key = Column(String(1024), nullable=True)
    current_version = Column(Integer, nullable=False, default=1)
    status = Column(String(20), nullable=False, default="AVAILABLE")
    metadata_json = Column(JSON, nullable=True)
    retention_until = Column(DateTime, nullable=True)
    is_starred = Column(Boolean, nullable=False, default=False)
    is_deleted = Column(Boolean, nullable=False, default=False)
    deleted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    folder = relationship("Folder", back_populates="files")
    versions = relationship("FileVersion", back_populates="file", cascade="all, delete-orphan")
    shared_links = relationship("SharedLink", back_populates="file", cascade="all, delete-orphan")


class FileVersion(Base):
    __tablename__ = "file_versions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    file_id = Column(String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True)
    version_number = Column(Integer, nullable=False)
    minio_key = Column(String(1024), nullable=False)
    size = Column(BigInteger, nullable=False, default=0)
    checksum_sha256 = Column(String(64), nullable=True)
    uploaded_by = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    uploaded_by_service_account_id = Column(String(36), ForeignKey("service_accounts.id", ondelete="SET NULL"), nullable=True)
    comment = Column(String(500), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())

    file = relationship("File", back_populates="versions")


class ProjectUpload(Base):
    __tablename__ = "project_uploads"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    service_account_id = Column(String(36), ForeignKey("service_accounts.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    file_id = Column(String(36), ForeignKey("files.id", ondelete="SET NULL"), nullable=True)
    idempotency_key = Column(String(255), nullable=False)
    checksum_sha256 = Column(String(64), nullable=False)
    object_key = Column(String(1024), nullable=True)
    reserved_bytes = Column(BigInteger, nullable=False, default=0)
    status = Column(String(20), nullable=False, default="PENDING")
    error_code = Column(String(64), nullable=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class SharedLink(Base):
    __tablename__ = "shared_links"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    file_id = Column(String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token = Column(String(64), nullable=False, unique=True, index=True)
    password_hash = Column(String(255), nullable=True)
    expires_at = Column(DateTime, nullable=True)
    download_count = Column(Integer, nullable=False, default=0)
    max_downloads = Column(Integer, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())

    file = relationship("File", back_populates="shared_links")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    service_account_id = Column(String(36), ForeignKey("service_accounts.id", ondelete="SET NULL"), nullable=True)
    action = Column(String(50), nullable=False)
    resource_type = Column(String(20), nullable=False)
    resource_id = Column(String(36), nullable=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(String(500), nullable=True)
    details_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class AnalyticsDaily(Base):
    __tablename__ = "analytics_daily"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    date = Column(Date, nullable=False, unique=True)
    total_uploads = Column(Integer, nullable=False, default=0)
    total_downloads = Column(Integer, nullable=False, default=0)
    total_storage_delta = Column(BigInteger, nullable=False, default=0)
    total_shares = Column(Integer, nullable=False, default=0)
    active_users = Column(Integer, nullable=False, default=0)
    new_users = Column(Integer, nullable=False, default=0)
    bytes_uploaded = Column(BigInteger, nullable=False, default=0)
    bytes_downloaded = Column(BigInteger, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
