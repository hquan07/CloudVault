"""
CloudVault — File Service SQLAlchemy Models
"""

import uuid
from sqlalchemy import (
    Column, String, BigInteger, Integer, Boolean, DateTime, JSON, func, ForeignKey,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    """Read-only reference to users table."""
    __tablename__ = "users"

    id = Column(String(36), primary_key=True)
    email = Column(String(255), nullable=False, unique=True)
    username = Column(String(100), nullable=False)
    storage_quota = Column(BigInteger, nullable=False, default=5368709120)
    storage_used = Column(BigInteger, nullable=False, default=0)
    role = Column(String(50), nullable=False, default="user")
    is_active = Column(Boolean, nullable=False, default=True)


class Project(Base):
    __tablename__ = "projects"

    id = Column(String(36), primary_key=True)
    slug = Column(String(63), nullable=False, unique=True)
    name = Column(String(120), nullable=False)
    status = Column(String(20), nullable=False, default="active")
    storage_quota = Column(BigInteger, nullable=False)
    storage_used = Column(BigInteger, nullable=False, default=0)
    max_file_size = Column(BigInteger, nullable=False)
    warning_percent = Column(BigInteger, nullable=False, default=80)
    retention_policy = Column(JSON, nullable=True)


class ProjectMembership(Base):
    __tablename__ = "project_memberships"

    id = Column(String(36), primary_key=True)
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False)


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
    revoked_at = Column(DateTime, nullable=True)


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


class FolderPermission(Base):
    __tablename__ = "folder_permissions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    folder_id = Column(String(36), ForeignKey("folders.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False) # 'viewer', 'editor', 'manager'
    created_at = Column(DateTime, nullable=False, server_default=func.now())

    folder = relationship("Folder", back_populates="permissions")

Folder.permissions = relationship("FolderPermission", back_populates="folder", cascade="all, delete-orphan")

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


class FileVersion(Base):
    __tablename__ = "file_versions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    file_id = Column(String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False)
    version_number = Column(Integer, nullable=False)
    minio_key = Column(String(1024), nullable=False)
    size = Column(BigInteger, nullable=False, default=0)
    checksum_sha256 = Column(String(64), nullable=True)
    uploaded_by = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    uploaded_by_service_account_id = Column(String(36), ForeignKey("service_accounts.id", ondelete="SET NULL"), nullable=True)
    comment = Column(String(500), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class ProjectFileStar(Base):
    __tablename__ = "project_file_stars"

    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    file_id = Column(String(36), ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


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
