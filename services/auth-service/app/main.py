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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import get_db
from app.models import User, RefreshToken, Project, ProjectMembership, ServiceAccount
from app.schemas import (
    RegisterRequest, LoginRequest, RefreshRequest,
    UpdateProfileRequest, AuthResponse, MeResponse,
    MessageResponse, UserResponse, TokenPair,
    AdminStatsResponse, ProjectCreateRequest, ProjectUpdateRequest,
    ProjectMembershipRequest, ProjectMembershipRoleRequest,
    ProjectMembershipResponse, ProjectResponse, ProjectUsageResponse,
    ServiceAccountCreateRequest, ServiceAccountResponse, ServiceAccountIssuedResponse,
)
from app.auth import (
    hash_password, verify_password,
    create_access_token, create_refresh_token,
    decode_access_token, blacklist_token, is_token_blacklisted,
    init_redis, close_redis, create_service_token,
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
    req: RefreshRequest | None = None,
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

    if req:
        refresh_hash = hashlib.sha256(req.refresh_token.encode()).hexdigest()
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == refresh_hash)
        )
        refresh_token = result.scalar_one_or_none()
        if refresh_token and not refresh_token.revoked:
            refresh_token.revoked = True
            refresh_token.revoked_at = datetime.now(timezone.utc)
            await db.commit()
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
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")

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


# ── Project Routes ──

PROJECT_ROLES = {"viewer", "editor", "admin"}
PROJECT_STATUSES = {"active", "suspended", "archived"}
SERVICE_ACCOUNT_SCOPES = {"files:create", "files:read", "files:delete", "project:usage:read"}


def _project_response(project: Project, member_role: str | None = None) -> ProjectResponse:
    return ProjectResponse(
        id=project.id,
        slug=project.slug,
        name=project.name,
        description=project.description,
        status=project.status,
        storage_quota=project.storage_quota,
        storage_used=project.storage_used,
        max_file_size=project.max_file_size,
        warning_percent=project.warning_percent,
        retention_policy=project.retention_policy,
        member_role=member_role,
        created_by=project.created_by,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


async def _project_membership(
    db: AsyncSession,
    project_id: str,
    user: User,
    required_roles: set[str] | None = None,
) -> tuple[Project, ProjectMembership | None]:
    project_result = await db.execute(
        select(Project).where((Project.id == project_id) | (Project.slug == project_id))
    )
    project = project_result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    membership_result = await db.execute(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == user.id,
        )
    )
    membership = membership_result.scalar_one_or_none()
    if user.role != "admin" and not membership:
        raise HTTPException(status_code=403, detail="Project access denied")
    if required_roles and user.role != "admin" and membership.role not in required_roles:
        raise HTTPException(status_code=403, detail="Project role is insufficient")
    return project, membership


@app.get("/api/v1/projects", response_model=List[ProjectResponse])
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "admin":
        result = await db.execute(select(Project).order_by(Project.name.asc()))
        return [_project_response(project, "admin") for project in result.scalars().all()]

    result = await db.execute(
        select(Project, ProjectMembership.role)
        .join(ProjectMembership, ProjectMembership.project_id == Project.id)
        .where(ProjectMembership.user_id == user.id)
        .order_by(Project.name.asc())
    )
    return [_project_response(project, role) for project, role in result.all()]


@app.post("/api/v1/projects", response_model=ProjectResponse, status_code=201)
async def create_project(
    req: ProjectCreateRequest,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    project = Project(
        slug=req.slug,
        name=req.name,
        description=req.description,
        storage_quota=req.storage_quota,
        max_file_size=req.max_file_size,
        warning_percent=req.warning_percent,
        retention_policy=req.retention_policy,
        created_by=admin.id,
    )
    db.add(project)
    try:
        await db.flush()
        db.add(ProjectMembership(project_id=project.id, user_id=admin.id, role="admin"))
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Project slug already exists")
    await db.refresh(project)
    return _project_response(project, "admin")


@app.get("/api/v1/projects/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, membership = await _project_membership(db, project_id, user)
    return _project_response(project, "admin" if user.role == "admin" else membership.role)


@app.get("/api/v1/projects/{project_id}/usage", response_model=ProjectUsageResponse)
async def get_project_usage(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user)
    available = max(0, project.storage_quota - project.storage_used)
    percentage = round((project.storage_used / project.storage_quota * 100), 2) if project.storage_quota else 0
    return ProjectUsageResponse(
        project_id=project.id,
        storage_used=project.storage_used,
        storage_quota=project.storage_quota,
        available_bytes=available,
        percentage=percentage,
        warning_percent=project.warning_percent,
    )


@app.put("/api/v1/projects/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    req: ProjectUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, membership = await _project_membership(db, project_id, user, {"admin"})
    updates = req.model_dump(exclude_unset=True)
    if "status" in updates and updates["status"] not in PROJECT_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid project status")
    if "storage_quota" in updates and updates["storage_quota"] < project.storage_used:
        raise HTTPException(status_code=409, detail="Quota cannot be lower than storage used")
    for key, value in updates.items():
        setattr(project, key, value)
    await db.commit()
    await db.refresh(project)
    return _project_response(project, "admin" if user.role == "admin" else membership.role)


@app.get(
    "/api/v1/projects/{project_id}/members",
    response_model=List[ProjectMembershipResponse],
)
async def list_project_members(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user)
    result = await db.execute(
        select(ProjectMembership, User)
        .join(User, User.id == ProjectMembership.user_id)
        .where(ProjectMembership.project_id == project.id)
        .order_by(User.username.asc())
    )
    return [
        ProjectMembershipResponse(
            id=membership.id,
            project_id=membership.project_id,
            user_id=membership.user_id,
            role=membership.role,
            username=member.username,
            email=member.email,
            created_at=membership.created_at,
        )
        for membership, member in result.all()
    ]


@app.post(
    "/api/v1/projects/{project_id}/members",
    response_model=ProjectMembershipResponse,
    status_code=201,
)
async def add_project_member(
    project_id: str,
    req: ProjectMembershipRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    if req.role not in PROJECT_ROLES:
        raise HTTPException(status_code=400, detail="Invalid project role")
    member = await db.get(User, req.user_id)
    if not member or not member.is_active:
        raise HTTPException(status_code=404, detail="Active user not found")
    membership = ProjectMembership(project_id=project.id, user_id=member.id, role=req.role)
    db.add(membership)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="User is already a project member")
    await db.refresh(membership)
    return ProjectMembershipResponse(
        id=membership.id, project_id=project.id, user_id=member.id,
        role=membership.role, username=member.username, email=member.email,
        created_at=membership.created_at,
    )


@app.put(
    "/api/v1/projects/{project_id}/members/{member_id}",
    response_model=ProjectMembershipResponse,
)
async def update_project_member(
    project_id: str,
    member_id: str,
    req: ProjectMembershipRoleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    if req.role not in PROJECT_ROLES:
        raise HTTPException(status_code=400, detail="Invalid project role")
    result = await db.execute(
        select(ProjectMembership, User)
        .join(User, User.id == ProjectMembership.user_id)
        .where(ProjectMembership.id == member_id, ProjectMembership.project_id == project.id)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Project membership not found")
    membership, member = row
    if membership.role == "admin" and req.role != "admin":
        admin_count = await db.scalar(
            select(func.count(ProjectMembership.id)).where(
                ProjectMembership.project_id == project.id,
                ProjectMembership.role == "admin",
            )
        )
        if admin_count <= 1:
            raise HTTPException(status_code=409, detail="Project must keep at least one admin")
    membership.role = req.role
    await db.commit()
    await db.refresh(membership)
    return ProjectMembershipResponse(
        id=membership.id, project_id=project.id, user_id=member.id,
        role=membership.role, username=member.username, email=member.email,
        created_at=membership.created_at,
    )


@app.delete("/api/v1/projects/{project_id}/members/{member_id}", status_code=204)
async def remove_project_member(
    project_id: str,
    member_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    membership = await db.get(ProjectMembership, member_id)
    if not membership or membership.project_id != project.id:
        raise HTTPException(status_code=404, detail="Project membership not found")
    admin_count = await db.scalar(
        select(func.count(ProjectMembership.id)).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.role == "admin",
        )
    )
    if membership.role == "admin" and admin_count <= 1:
        raise HTTPException(status_code=409, detail="Project must keep at least one admin")
    await db.delete(membership)
    await db.commit()


def _service_account_response(account: ServiceAccount) -> ServiceAccountResponse:
    return ServiceAccountResponse(
        id=account.id,
        project_id=account.project_id,
        name=account.name,
        token_prefix=account.token_prefix,
        scopes=account.scopes or [],
        is_active=account.is_active,
        expires_at=account.expires_at,
        last_used_at=account.last_used_at,
        revoked_at=account.revoked_at,
        created_at=account.created_at,
    )


def _validate_service_account_request(req: ServiceAccountCreateRequest) -> None:
    invalid = set(req.scopes) - SERVICE_ACCOUNT_SCOPES
    if invalid:
        raise HTTPException(status_code=400, detail=f"Invalid scopes: {', '.join(sorted(invalid))}")
    if not req.scopes:
        raise HTTPException(status_code=400, detail="At least one scope is required")
    if req.expires_at:
        expires_at = req.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="expires_at must be in the future")


@app.get(
    "/api/v1/projects/{project_id}/service-accounts",
    response_model=List[ServiceAccountResponse],
)
async def list_service_accounts(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    result = await db.execute(
        select(ServiceAccount)
        .where(ServiceAccount.project_id == project.id)
        .order_by(ServiceAccount.created_at.desc())
    )
    return [_service_account_response(account) for account in result.scalars().all()]


@app.post(
    "/api/v1/projects/{project_id}/service-accounts",
    response_model=ServiceAccountIssuedResponse,
    status_code=201,
)
async def create_service_account(
    project_id: str,
    req: ServiceAccountCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    _validate_service_account_request(req)
    raw_token, prefix, token_hash = create_service_token()
    account = ServiceAccount(
        project_id=project.id,
        name=req.name,
        token_prefix=prefix,
        token_hash=token_hash,
        scopes=sorted(set(req.scopes)),
        expires_at=req.expires_at,
        created_by=user.id,
    )
    db.add(account)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Service account name already exists")
    await db.refresh(account)
    response = _service_account_response(account).model_dump()
    return ServiceAccountIssuedResponse(**response, token=raw_token)


@app.post(
    "/api/v1/projects/{project_id}/service-accounts/{account_id}/rotate",
    response_model=ServiceAccountIssuedResponse,
)
async def rotate_service_account(
    project_id: str,
    account_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    account = await db.get(ServiceAccount, account_id)
    if not account or account.project_id != project.id:
        raise HTTPException(status_code=404, detail="Service account not found")
    raw_token, prefix, token_hash = create_service_token()
    account.token_prefix = prefix
    account.token_hash = token_hash
    account.is_active = True
    account.revoked_at = None
    await db.commit()
    await db.refresh(account)
    response = _service_account_response(account).model_dump()
    return ServiceAccountIssuedResponse(**response, token=raw_token)


@app.delete("/api/v1/projects/{project_id}/service-accounts/{account_id}", status_code=204)
async def revoke_service_account(
    project_id: str,
    account_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    account = await db.get(ServiceAccount, account_id)
    if not account or account.project_id != project.id:
        raise HTTPException(status_code=404, detail="Service account not found")
    account.is_active = False
    account.token_hash = None
    account.revoked_at = datetime.now(timezone.utc)
    await db.commit()
