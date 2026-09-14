"""
CloudVault — Auth Service Pydantic Schemas
Request/response models matching the frontend API client expectations.
"""

from pydantic import BaseModel, EmailStr, Field
from typing import Optional
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
