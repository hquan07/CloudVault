"""
CloudVault — Auth Service Main Application
FastAPI application with all auth endpoints.

Endpoints match the frontend api.ts contract:
  POST /api/v1/auth/register
  POST /api/v1/auth/login
  POST /api/v1/auth/logout
  POST /api/v1/auth/refresh
  GET  /api/v1/auth/me
  PUT  /api/v1/auth/me
"""

import hashlib
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Depends, HTTPException, Header, status
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import get_db
from app.models import User, RefreshToken
from app.schemas import (
    RegisterRequest, LoginRequest, RefreshRequest,
    UpdateProfileRequest, AuthResponse, MeResponse,
    MessageResponse, UserResponse, TokenPair,
    AdminStatsResponse,
)
from app.auth import (
    hash_password, verify_password,
    create_access_token, create_refresh_token,
    decode_access_token, blacklist_token, is_token_blacklisted,
    init_redis, close_redis,
)
from typing import List
from pydantic import BaseModel


# ── Lifespan ──

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_redis()
    yield
    await close_redis()


# ── FastAPI App ──

app = FastAPI(
    title="CloudVault Auth Service",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Instrumentator().instrument(app).expose(app)

from app.telemetry import setup_opentelemetry
setup_opentelemetry(app, "auth-service")


# ── Dependencies ──

async def get_current_user(
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")

    token = authorization.split(" ", 1)[1]
    try:
        payload = decode_access_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    jti = payload.get("jti")
    if jti and await is_token_blacklisted(jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


def _user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        username=user.username,
        avatar_url=user.avatar_url,
        role=user.role,
        is_active=user.is_active,
        storage_quota=user.storage_quota,
        storage_used=user.storage_used,
        created_at=user.created_at,
    )


# ── Routes ──

@app.get("/health")
async def health():
    return {"status": "ok", "service": "auth"}


@app.post("/api/v1/auth/register", response_model=AuthResponse, status_code=201)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    # Check duplicate email
    existing = await db.execute(select(User).where(User.email == req.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    # Check duplicate username
    existing_uname = await db.execute(select(User).where(User.username == req.username))
    if existing_uname.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username already taken")

    user = User(
        email=req.email,
        username=req.username,
        password_hash=hash_password(req.password),
        is_verified=True,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)

    # Generate tokens
    access = create_access_token(user.id, user.email)
    raw_refresh, refresh_hash, expires_at = create_refresh_token()

    rt = RefreshToken(
        user_id=user.id,
        token_hash=refresh_hash,
        expires_at=expires_at,
    )
    db.add(rt)
    await db.commit()

    return AuthResponse(
        tokens=TokenPair(access_token=access, refresh_token=raw_refresh),
        user=_user_response(user),
    )


@app.post("/api/v1/auth/login", response_model=AuthResponse)
async def login(req: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == req.email))
    user = result.scalar_one_or_none()

    if not user or not user.password_hash or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled")

    # Update last login
    user.last_login_at = datetime.now(timezone.utc)
    await db.flush()

    access = create_access_token(user.id, user.email)
    raw_refresh, refresh_hash, expires_at = create_refresh_token()

    rt = RefreshToken(
        user_id=user.id,
        token_hash=refresh_hash,
        expires_at=expires_at,
    )
    db.add(rt)
    await db.commit()

    return AuthResponse(
        tokens=TokenPair(access_token=access, refresh_token=raw_refresh),
        user=_user_response(user),
    )


@app.post("/api/v1/auth/logout", response_model=MessageResponse)
async def logout(
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ", 1)[1]
        try:
            payload = decode_access_token(token)
            jti = payload.get("jti")
            if jti:
                # Blacklist the access token for the remaining TTL
                exp = payload.get("exp", 0)
                ttl = max(int(exp - datetime.now(timezone.utc).timestamp()), 60)
                await blacklist_token(jti, ttl)
        except Exception:
            pass  # Token might already be expired, that's fine
    return MessageResponse(detail="Logged out successfully")


@app.post("/api/v1/auth/refresh", response_model=AuthResponse)
async def refresh(req: RefreshRequest, db: AsyncSession = Depends(get_db)):
    token_hash = hashlib.sha256(req.refresh_token.encode()).hexdigest()
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked == False,
        )
    )
    rt = result.scalar_one_or_none()

    if not rt:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    if rt.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="Refresh token expired")

    # Get user
    user_result = await db.execute(select(User).where(User.id == rt.user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Revoke old refresh token (rotation)
    rt.revoked = True
    rt.revoked_at = datetime.now(timezone.utc)

    # Issue new tokens
    access = create_access_token(user.id, user.email)
    raw_refresh, new_hash, expires_at = create_refresh_token()

    new_rt = RefreshToken(
        user_id=user.id,
        token_hash=new_hash,
        expires_at=expires_at,
    )
    db.add(new_rt)
    await db.commit()

    return AuthResponse(
        tokens=TokenPair(access_token=access, refresh_token=raw_refresh),
        user=_user_response(user),
    )


@app.get("/api/v1/auth/me", response_model=MeResponse)
async def get_me(user: User = Depends(get_current_user)):
    return MeResponse(user=_user_response(user))


@app.put("/api/v1/auth/me", response_model=MeResponse)
async def update_me(
    req: UpdateProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if req.username is not None:
        # Check uniqueness
        existing = await db.execute(
            select(User).where(User.username == req.username, User.id != user.id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="Username already taken")
        user.username = req.username

    if req.avatar_url is not None:
        user.avatar_url = req.avatar_url

    await db.commit()
    await db.refresh(user)
    return MeResponse(user=_user_response(user))

# ── Admin Routes ──

async def get_current_admin(
    user: User = Depends(get_current_user),
) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user

@app.get("/api/v1/admin/stats", response_model=AdminStatsResponse)
async def get_admin_stats(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    # Total Users
    total_users = await db.scalar(select(func.count(User.id)))
    # Active Users
    active_users = await db.scalar(select(func.count(User.id)).where(User.is_active == True))
    # Total Storage Used
    total_storage_used = await db.scalar(select(func.sum(User.storage_used))) or 0
    # Total Storage Quota
    total_storage_quota = await db.scalar(select(func.sum(User.storage_quota))) or 0
    
    return AdminStatsResponse(
        total_users=total_users or 0,
        active_users=active_users or 0,
        total_storage_used=int(total_storage_used),
        total_storage_quota=int(total_storage_quota)
    )

@app.get("/api/v1/admin/users", response_model=List[UserResponse])
async def get_users(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    users = result.scalars().all()
    return [_user_response(u) for u in users]

class RoleUpdateRequest(BaseModel):
    role: str

@app.put("/api/v1/admin/users/{user_id}/role", response_model=UserResponse)
async def update_user_role(
    user_id: str,
    req: RoleUpdateRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    if req.role not in ["user", "admin"]:
        raise HTTPException(status_code=400, detail="Invalid role")
    
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    user.role = req.role
    await db.commit()
    await db.refresh(user)
    return _user_response(user)

class QuotaUpdateRequest(BaseModel):
    storage_quota: int

@app.put("/api/v1/admin/users/{user_id}/quota", response_model=UserResponse)
async def update_user_quota(
    user_id: str,
    req: QuotaUpdateRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    user.storage_quota = req.storage_quota
    await db.commit()
    await db.refresh(user)
    return _user_response(user)

class StatusUpdateRequest(BaseModel):
    is_active: bool

@app.put("/api/v1/admin/users/{user_id}/status", response_model=UserResponse)
async def update_user_status(
    user_id: str,
    req: StatusUpdateRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot change your own status")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    user.is_active = req.is_active
    await db.commit()
    await db.refresh(user)
    return _user_response(user)

