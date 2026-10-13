"""
CloudVault — Auth Service Pydantic Schemas
Request/response models matching the frontend API client expectations.
"""

from pydantic import BaseModel, EmailStr, Field
from typing import Any, Optional
from datetime import datetime


# ── Request Schemas ──

class RegisterRequest(BaseModel):
    email: EmailStr
    username: str = Field(..., min_length=3, max_length=100)
    password: str = Field(..., min_length=6, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UpdateProfileRequest(BaseModel):
    username: Optional[str] = Field(None, min_length=3, max_length=100)
    avatar_url: Optional[str] = None


# ── Response Schemas ──

class UserResponse(BaseModel):
    id: str
    email: str
    username: str
    avatar_url: Optional[str] = None
    role: str
    is_active: bool
    storage_quota: int
    storage_used: int
    created_at: datetime

    class Config:
        from_attributes = True


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str


class AuthResponse(BaseModel):
    """
    Frontend expects: { tokens: { access_token, refresh_token }, user: { ... } }
    """
    tokens: TokenPair
    user: UserResponse

class AdminStatsResponse(BaseModel):
    total_users: int
    active_users: int
    total_storage_used: int
    total_storage_quota: int


class MeResponse(BaseModel):
    user: UserResponse


class MessageResponse(BaseModel):
    detail: str


class ProjectCreateRequest(BaseModel):
    slug: str = Field(..., min_length=2, max_length=63, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(..., min_length=2, max_length=120)
    description: Optional[str] = Field(None, max_length=1000)
    storage_quota: int = Field(..., ge=0)
    max_file_size: int = Field(..., gt=0)
    warning_percent: int = Field(80, ge=1, le=100)
    retention_policy: Optional[dict[str, Any]] = None


class ProjectUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=120)
    description: Optional[str] = Field(None, max_length=1000)
    status: Optional[str] = None
    storage_quota: Optional[int] = Field(None, ge=0)
    max_file_size: Optional[int] = Field(None, gt=0)
    warning_percent: Optional[int] = Field(None, ge=1, le=100)
    retention_policy: Optional[dict[str, Any]] = None


class ProjectMembershipRequest(BaseModel):
    user_id: str
    role: str = "viewer"


class ProjectMembershipRoleRequest(BaseModel):
    role: str


class ProjectMembershipResponse(BaseModel):
    id: str
    project_id: str
    user_id: str
    role: str
    username: str
    email: str
    created_at: datetime


class ProjectResponse(BaseModel):
    id: str
    slug: str
    name: str
    description: Optional[str] = None
    status: str
    storage_quota: int
    storage_used: int
    max_file_size: int
    warning_percent: int
    retention_policy: Optional[dict[str, Any]] = None
    member_role: Optional[str] = None
    created_by: str
    created_at: datetime
    updated_at: datetime


class ProjectUsageResponse(BaseModel):
    project_id: str
    storage_used: int
    storage_quota: int
    available_bytes: int
    percentage: float
    warning_percent: int


class ServiceAccountCreateRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    scopes: list[str] = Field(default_factory=lambda: ["files:create"])
    expires_at: Optional[datetime] = None


class ServiceAccountResponse(BaseModel):
    id: str
    project_id: str
    name: str
    token_prefix: Optional[str] = None
    scopes: list[str]
    is_active: bool
    expires_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    created_at: datetime


class ServiceAccountIssuedResponse(ServiceAccountResponse):
    token: str
