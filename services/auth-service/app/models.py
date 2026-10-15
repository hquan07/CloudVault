"""
CloudVault — Auth Service SQLAlchemy Models
Maps to the users and refresh_tokens tables defined in 01_schema.sql.
"""

import uuid
from sqlalchemy import (
    Column, String, BigInteger, Boolean, Enum, DateTime, JSON, func, ForeignKey,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email = Column(String(255), nullable=False, unique=True, index=True)
    username = Column(String(100), nullable=False, unique=True, index=True)
    password_hash = Column(String(255), nullable=True)
    avatar_url = Column(String(500), nullable=True)
    storage_quota = Column(BigInteger, nullable=False, default=5368709120)  # 5GB
    storage_used = Column(BigInteger, nullable=False, default=0)
    oauth_provider = Column(
        Enum("local", "google", "github", name="oauth_provider_enum"),
        nullable=False, default="local",
    )
    oauth_id = Column(String(255), nullable=True)
    role = Column(
        Enum("user", "admin", name="user_role_enum"),
        nullable=False, default="user"
    )
    is_active = Column(Boolean, nullable=False, default=True)
    is_verified = Column(Boolean, nullable=False, default=False)
    mfa_enabled = Column(Boolean, nullable=False, default=False)
    mfa_secret_encrypted = Column(String(1000), nullable=True)
    mfa_recovery_codes = Column(JSON, nullable=True)
    deletion_status = Column(String(20), nullable=False, default="active")
    deletion_requested_at = Column(DateTime, nullable=True)
    deletion_scheduled_at = Column(DateTime, nullable=True)
    deletion_completed_at = Column(DateTime, nullable=True)
    anonymized_at = Column(DateTime, nullable=True)
    last_login_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )

    refresh_tokens = relationship("RefreshToken", back_populates="user", cascade="all, delete-orphan")


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(255), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime, nullable=False)
    revoked = Column(Boolean, nullable=False, default=False)
    revoked_at = Column(DateTime, nullable=True)
    user_agent = Column(String(500), nullable=True)
    ip_address = Column(String(45), nullable=True)
    session_started_at = Column(DateTime, nullable=False, default=func.now())
    last_used_at = Column(DateTime, nullable=False, default=func.now())
    created_at = Column(DateTime, nullable=False, server_default=func.now())

    user = relationship("User", back_populates="refresh_tokens")


class Project(Base):
    __tablename__ = "projects"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    slug = Column(String(63), nullable=False, unique=True, index=True)
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

    memberships = relationship("ProjectMembership", back_populates="project", cascade="all, delete-orphan")
    service_accounts = relationship("ServiceAccount", back_populates="project", cascade="all, delete-orphan")


class ProjectFileRecord(Base):
    """Minimal files-table mapping used for safe project lifecycle checks."""

    __tablename__ = "files"

    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    size = Column(BigInteger, nullable=False, default=0)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    event_id = Column(String(36), nullable=True, unique=True, index=True)
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


class ProjectMembership(Base):
    __tablename__ = "project_memberships"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False, default="viewer")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    project = relationship("Project", back_populates="memberships")
    user = relationship("User")


class ProjectPin(Base):
    __tablename__ = "project_pins"

    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class ServiceAccount(Base):
    __tablename__ = "service_accounts"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    token_prefix = Column(String(24), nullable=True)
    token_hash = Column(String(64), nullable=True, unique=True)
    scopes = Column(JSON, nullable=False, default=list)
    is_active = Column(Boolean, nullable=False, default=True)
    expires_at = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    created_by = Column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())

    project = relationship("Project", back_populates="service_accounts")


class AccountDeletionRequest(Base):
    __tablename__ = "account_deletion_requests"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True)
    status = Column(String(20), nullable=False, default="scheduled")
    execute_after = Column(DateTime, nullable=False)
    attempt_count = Column(BigInteger, nullable=False, default=0)
    last_error = Column(String(1000), nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    cancelled_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
