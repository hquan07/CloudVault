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
import hmac
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import FastAPI, Depends, HTTPException, Header, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator
from sqlalchemy import delete, select, func, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import async_session, get_db
from app.models import (
    AuditLog, User, RefreshToken, Project, ProjectFileRecord, ProjectMembership, ProjectPin,
    ServiceAccount, AccountDeletionRequest,
)
from app.schemas import (
    RegisterRequest, LoginRequest, RefreshRequest, ChangePasswordRequest,
    MfaCodeRequest, MfaDisableRequest, MfaEnableResponse, MfaSetupRequest, MfaSetupResponse,
    UpdateProfileRequest, AuthResponse, MeResponse,
    MessageResponse, SecurityEventResponse, SessionResponse, UserResponse, TokenPair,
    AdminStatsResponse, ProjectCreateRequest, ProjectDeleteRequest, ProjectUpdateRequest,
    ProjectMembershipRequest, ProjectMembershipRoleRequest,
    ProjectMemberCandidateResponse, ProjectMembershipResponse, ProjectResponse, ProjectUsageResponse,
    ServiceAccountCreateRequest, ServiceAccountResponse, ServiceAccountIssuedResponse,
    AccountDeletionImpactResponse, OwnedProjectSummary, ProjectTransferOwnershipRequest,
    AccountDeletionCancelRequest, AccountDeletionRequestCreate, AccountDeletionStatusResponse,
)
from app.auth import (
    hash_password, verify_password,
    create_access_token, create_refresh_token,
    decode_access_token, blacklist_token, is_token_blacklisted,
    init_redis, close_redis, create_service_token,
    enforce_rate_limit, RateLimitExceeded,
    decrypt_mfa_secret, encrypt_mfa_secret, generate_recovery_codes,
    generate_totp_secret, hash_recovery_code, verify_totp,
)
from typing import List
from pydantic import BaseModel


# ── Lifespan ──

def _is_bootstrap_admin(email: str) -> bool:
    configured = settings.BOOTSTRAP_ADMIN_EMAIL.strip().lower()
    return bool(configured) and email.strip().lower() == configured


async def _reconcile_bootstrap_admin() -> None:
    """Promote an existing configured bootstrap account idempotently."""
    configured = settings.BOOTSTRAP_ADMIN_EMAIL.strip().lower()
    if not configured:
        return
    async with async_session() as db:
        result = await db.execute(select(User).where(func.lower(User.email) == configured))
        user = result.scalar_one_or_none()
        if user and user.role != "admin":
            user.role = "admin"
            await db.commit()

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_redis()
    await _reconcile_bootstrap_admin()
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
    allow_origins=settings.cors_origins,
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
        is_verified=user.is_verified,
        mfa_enabled=user.mfa_enabled,
        oauth_provider=user.oauth_provider,
        storage_quota=user.storage_quota,
        storage_used=user.storage_used,
        last_login_at=user.last_login_at,
        created_at=user.created_at,
    )


def _request_context(request: Request) -> tuple[str | None, str | None]:
    forwarded = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[0]
    client_ip = (forwarded or (request.client.host if request.client else "")).strip()[:45] or None
    user_agent = request.headers.get("user-agent", "").strip()[:500] or None
    return client_ip, user_agent


def _new_refresh_session(
    user_id: str,
    request: Request,
    session_started_at: datetime | None = None,
) -> tuple[str, RefreshToken]:
    raw_refresh, refresh_hash, expires_at = create_refresh_token()
    client_ip, user_agent = _request_context(request)
    now = datetime.now(timezone.utc)
    return raw_refresh, RefreshToken(
        id=str(uuid.uuid4()),
        user_id=user_id,
        token_hash=refresh_hash,
        expires_at=expires_at,
        ip_address=client_ip,
        user_agent=user_agent,
        session_started_at=session_started_at or now,
        last_used_at=now,
    )


def _add_security_audit(
    db: AsyncSession,
    action: str,
    request: Request,
    *,
    user_id: str | None = None,
    resource_id: str | None = None,
    details: dict | None = None,
) -> None:
    client_ip, user_agent = _request_context(request)
    db.add(AuditLog(
        user_id=user_id,
        action=action,
        resource_type="user",
        resource_id=resource_id or user_id,
        ip_address=client_ip,
        user_agent=user_agent,
        details_json=details or {},
    ))


def _verify_mfa_code(user: User, code: str) -> tuple[bool, bool]:
    """Return (valid, used_recovery_code), consuming recovery codes in memory."""
    if not user.mfa_secret_encrypted:
        return False, False
    try:
        if verify_totp(code.strip(), decrypt_mfa_secret(user.mfa_secret_encrypted)):
            return True, False
    except Exception:
        return False, False

    candidate = hash_recovery_code(code)
    recovery_codes = list(user.mfa_recovery_codes or [])
    for stored in recovery_codes:
        if hmac.compare_digest(stored, candidate):
            recovery_codes.remove(stored)
            user.mfa_recovery_codes = recovery_codes
            return True, True
    return False, False


async def _enforce_auth_rate_limit(
    request: Request,
    scope: str,
    subject: str,
    limit: int,
) -> None:
    client_ip, _ = _request_context(request)
    try:
        await enforce_rate_limit(
            scope,
            f"{client_ip or 'unknown'}:{subject.casefold()}",
            limit=limit,
            window_seconds=settings.AUTH_RATE_LIMIT_WINDOW_SECONDS,
        )
    except RateLimitExceeded as error:
        raise HTTPException(
            status_code=429,
            detail="Too many authentication attempts. Try again later.",
            headers={"Retry-After": str(error.retry_after)},
        )


async def _blacklist_authorization_token(authorization: str | None) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        return
    try:
        payload = decode_access_token(authorization.split(" ", 1)[1])
        jti = payload.get("jti")
        if jti:
            exp = payload.get("exp", 0)
            ttl = max(int(exp - datetime.now(timezone.utc).timestamp()), 60)
            await blacklist_token(jti, ttl)
    except Exception:
        return


# ── Routes ──

@app.get("/health")
async def health():
    return {"status": "ok", "service": "auth"}


@app.post("/api/v1/auth/register", response_model=AuthResponse, status_code=201)
async def register(req: RegisterRequest, request: Request, db: AsyncSession = Depends(get_db)):
    await _enforce_auth_rate_limit(
        request, "register", req.email, settings.AUTH_REGISTER_ATTEMPTS_PER_WINDOW
    )
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
        role="admin" if _is_bootstrap_admin(req.email) else "user",
        is_verified=True,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)

    # Generate tokens
    raw_refresh, rt = _new_refresh_session(user.id, request)
    access = create_access_token(user.id, user.email, rt.id)
    db.add(rt)
    _add_security_audit(db, "USER_REGISTERED", request, user_id=user.id)
    await db.commit()

    return AuthResponse(
        tokens=TokenPair(access_token=access, refresh_token=raw_refresh),
        user=_user_response(user),
    )


@app.post("/api/v1/auth/login", response_model=AuthResponse)
async def login(req: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    await _enforce_auth_rate_limit(
        request, "login", req.email, settings.AUTH_LOGIN_ATTEMPTS_PER_WINDOW
    )
    result = await db.execute(select(User).where(User.email == req.email))
    user = result.scalar_one_or_none()

    if not user or not user.password_hash or not verify_password(req.password, user.password_hash):
        _add_security_audit(
            db,
            "USER_LOGIN_FAILED",
            request,
            user_id=user.id if user else None,
            resource_id=user.id if user else None,
            details={"reason": "invalid_credentials"},
        )
        await db.commit()
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if user.deletion_status == "pending":
        raise HTTPException(status_code=409, detail="ACCOUNT_PENDING_DELETION")
    if not user.is_active or user.deletion_status != "active":
        raise HTTPException(status_code=403, detail="Account is disabled")

    if user.mfa_enabled:
        if not req.otp_code:
            raise HTTPException(status_code=428, detail="MFA_REQUIRED")
        valid_mfa, used_recovery = _verify_mfa_code(user, req.otp_code)
        if not valid_mfa:
            _add_security_audit(
                db,
                "USER_LOGIN_FAILED",
                request,
                user_id=user.id,
                details={"reason": "invalid_mfa"},
            )
            await db.commit()
            raise HTTPException(status_code=401, detail="Invalid authentication code")
        if used_recovery:
            _add_security_audit(db, "MFA_RECOVERY_USED", request, user_id=user.id)

    # Update last login
    user.last_login_at = datetime.now(timezone.utc)
    await db.flush()

    raw_refresh, rt = _new_refresh_session(user.id, request)
    access = create_access_token(user.id, user.email, rt.id)
    db.add(rt)
    _add_security_audit(db, "USER_LOGGED_IN", request, user_id=user.id)
    await db.commit()

    return AuthResponse(
        tokens=TokenPair(access_token=access, refresh_token=raw_refresh),
        user=_user_response(user),
    )


@app.post("/api/v1/auth/logout", response_model=MessageResponse)
async def logout(
    request: Request,
    req: RefreshRequest | None = None,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    user_id = None
    if authorization and authorization.startswith("Bearer "):
        try:
            user_id = decode_access_token(authorization.split(" ", 1)[1]).get("sub")
        except Exception:
            pass
    await _blacklist_authorization_token(authorization)

    if req:
        refresh_hash = hashlib.sha256(req.refresh_token.encode()).hexdigest()
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == refresh_hash)
        )
        refresh_token = result.scalar_one_or_none()
        if refresh_token and not refresh_token.revoked:
            refresh_token.revoked = True
            refresh_token.revoked_at = datetime.now(timezone.utc)
            user_id = user_id or refresh_token.user_id
    if user_id:
        _add_security_audit(db, "USER_LOGGED_OUT", request, user_id=user_id)
    await db.commit()
    return MessageResponse(detail="Logged out successfully")


@app.post("/api/v1/auth/refresh", response_model=AuthResponse)
async def refresh(req: RefreshRequest, request: Request, db: AsyncSession = Depends(get_db)):
    await _enforce_auth_rate_limit(
        request,
        "refresh",
        hashlib.sha256(req.refresh_token.encode()).hexdigest(),
        settings.AUTH_REFRESH_ATTEMPTS_PER_WINDOW,
    )
    token_hash = hashlib.sha256(req.refresh_token.encode()).hexdigest()
    result = await db.execute(
        select(RefreshToken)
        .where(RefreshToken.token_hash == token_hash)
        .with_for_update()
    )
    rt = result.scalar_one_or_none()

    if not rt:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    if rt.revoked:
        now = datetime.now(timezone.utc)
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == rt.user_id, RefreshToken.revoked == False)
            .values(revoked=True, revoked_at=now)
        )
        _add_security_audit(
            db,
            "REFRESH_TOKEN_REPLAYED",
            request,
            user_id=rt.user_id,
            details={"response": "all_refresh_sessions_revoked"},
        )
        await db.commit()
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    if rt.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        rt.revoked = True
        rt.revoked_at = datetime.now(timezone.utc)
        await db.commit()
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
    raw_refresh, new_rt = _new_refresh_session(
        user.id,
        request,
        rt.session_started_at or rt.created_at,
    )
    access = create_access_token(user.id, user.email, new_rt.id)
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


@app.post("/api/v1/auth/change-password", response_model=MessageResponse)
async def change_password(
    req: ChangePasswordRequest,
    request: Request,
    authorization: str = Header(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not user.password_hash or not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if verify_password(req.new_password, user.password_hash):
        raise HTTPException(status_code=400, detail="New password must be different")

    user.password_hash = hash_password(req.new_password)
    now = datetime.now(timezone.utc)
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked == False)
        .values(revoked=True, revoked_at=now)
    )
    _add_security_audit(
        db,
        "PASSWORD_CHANGED",
        request,
        user_id=user.id,
        details={"refresh_sessions_revoked": True},
    )
    await db.commit()
    await _blacklist_authorization_token(authorization)
    return MessageResponse(detail="Password changed. Sign in again on all devices.")


@app.post("/api/v1/auth/mfa/setup", response_model=MfaSetupResponse)
async def setup_mfa(
    req: MfaSetupRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user.mfa_enabled:
        raise HTTPException(status_code=409, detail="Multi-factor authentication is already enabled")
    if not user.password_hash or not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    secret = generate_totp_secret()
    user.mfa_secret_encrypted = encrypt_mfa_secret(secret)
    user.mfa_recovery_codes = None
    await db.commit()
    label = quote(f"CloudVault:{user.email}")
    uri = f"otpauth://totp/{label}?secret={secret}&issuer=CloudVault&algorithm=SHA1&digits=6&period=30"
    return MfaSetupResponse(secret=secret, otpauth_uri=uri)


@app.post("/api/v1/auth/mfa/enable", response_model=MfaEnableResponse)
async def enable_mfa(
    req: MfaCodeRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user.mfa_enabled:
        raise HTTPException(status_code=409, detail="Multi-factor authentication is already enabled")
    if not user.mfa_secret_encrypted:
        raise HTTPException(status_code=409, detail="Start MFA setup before enabling it")
    try:
        valid = verify_totp(req.code.strip(), decrypt_mfa_secret(user.mfa_secret_encrypted))
    except Exception:
        valid = False
    if not valid:
        raise HTTPException(status_code=400, detail="Invalid authentication code")
    recovery_codes = generate_recovery_codes()
    user.mfa_enabled = True
    user.mfa_recovery_codes = [hash_recovery_code(code) for code in recovery_codes]
    _add_security_audit(db, "MFA_ENABLED", request, user_id=user.id)
    await db.commit()
    return MfaEnableResponse(
        detail="Multi-factor authentication enabled",
        recovery_codes=recovery_codes,
    )


@app.post("/api/v1/auth/mfa/disable", response_model=MessageResponse)
async def disable_mfa(
    req: MfaDisableRequest,
    request: Request,
    authorization: str = Header(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not user.mfa_enabled:
        raise HTTPException(status_code=409, detail="Multi-factor authentication is not enabled")
    if not user.password_hash or not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    valid, used_recovery = _verify_mfa_code(user, req.code)
    if not valid:
        raise HTTPException(status_code=400, detail="Invalid authentication code")
    user.mfa_enabled = False
    user.mfa_secret_encrypted = None
    user.mfa_recovery_codes = None
    now = datetime.now(timezone.utc)
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked == False)
        .values(revoked=True, revoked_at=now)
    )
    _add_security_audit(
        db,
        "MFA_DISABLED",
        request,
        user_id=user.id,
        details={"used_recovery_code": used_recovery, "refresh_sessions_revoked": True},
    )
    await db.commit()
    await _blacklist_authorization_token(authorization)
    return MessageResponse(detail="Multi-factor authentication disabled. Sign in again.")


@app.get("/api/v1/auth/sessions", response_model=List[SessionResponse])
async def list_sessions(
    authorization: str = Header(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_session_id = None
    if authorization and authorization.startswith("Bearer "):
        try:
            current_session_id = decode_access_token(authorization.split(" ", 1)[1]).get("sid")
        except Exception:
            pass
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    result = await db.execute(
        select(RefreshToken)
        .where(
            RefreshToken.user_id == user.id,
            RefreshToken.revoked == False,
            RefreshToken.expires_at > now,
        )
        .order_by(RefreshToken.created_at.desc())
    )
    return [
        SessionResponse(
            id=session.id,
            ip_address=session.ip_address,
            user_agent=session.user_agent,
            created_at=session.created_at,
            session_started_at=session.session_started_at,
            last_active_at=session.last_used_at,
            expires_at=session.expires_at,
            is_current=session.id == current_session_id,
        )
        for session in result.scalars().all()
    ]


@app.get("/api/v1/auth/security-events", response_model=List[SecurityEventResponse])
async def list_security_events(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    security_actions = (
        "USER_REGISTERED",
        "USER_LOGGED_IN",
        "USER_LOGIN_FAILED",
        "USER_LOGGED_OUT",
        "PASSWORD_CHANGED",
        "SESSION_REVOKED",
        "SESSIONS_REVOKED",
        "REFRESH_TOKEN_REPLAYED",
        "MFA_ENABLED",
        "MFA_DISABLED",
        "MFA_RECOVERY_USED",
    )
    result = await db.execute(
        select(AuditLog)
        .where(AuditLog.user_id == user.id, AuditLog.action.in_(security_actions))
        .order_by(AuditLog.created_at.desc())
        .limit(20)
    )
    return [
        SecurityEventResponse(
            id=event.id,
            action=event.action,
            ip_address=event.ip_address,
            user_agent=event.user_agent,
            created_at=event.created_at,
        )
        for event in result.scalars().all()
    ]


@app.delete("/api/v1/auth/sessions/{session_id}", response_model=MessageResponse)
async def revoke_session(
    session_id: str,
    request: Request,
    authorization: str = Header(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(RefreshToken)
        .where(RefreshToken.id == session_id, RefreshToken.user_id == user.id)
        .with_for_update()
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not session.revoked:
        session.revoked = True
        session.revoked_at = datetime.now(timezone.utc)
        _add_security_audit(
            db,
            "SESSION_REVOKED",
            request,
            user_id=user.id,
            details={"session_id": session.id},
        )
        await db.commit()
    if authorization and authorization.startswith("Bearer "):
        try:
            payload = decode_access_token(authorization.split(" ", 1)[1])
            if payload.get("sid") == session.id:
                await _blacklist_authorization_token(authorization)
        except Exception:
            pass
    return MessageResponse(detail="Session revoked")


@app.delete("/api/v1/auth/sessions", response_model=MessageResponse)
async def revoke_all_sessions(
    request: Request,
    authorization: str = Header(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    result = await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked == False)
        .values(revoked=True, revoked_at=now)
    )
    _add_security_audit(
        db,
        "SESSIONS_REVOKED",
        request,
        user_id=user.id,
        details={"revoked_count": result.rowcount or 0},
    )
    await db.commit()
    await _blacklist_authorization_token(authorization)
    return MessageResponse(detail="All sessions revoked")

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


def _project_response(
    project: Project,
    member_role: str | None = None,
    is_pinned: bool = False,
) -> ProjectResponse:
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
        is_pinned=is_pinned,
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


async def _project_is_pinned(db: AsyncSession, user_id: str, project_id: str) -> bool:
    return await db.get(ProjectPin, (user_id, project_id)) is not None


def _add_project_audit(
    db: AsyncSession,
    action: str,
    project: Project,
    user: User,
    details: dict | None = None,
) -> None:
    db.add(AuditLog(
        user_id=user.id,
        project_id=project.id,
        action=action,
        resource_type="project",
        resource_id=project.id,
        details_json={"project_name": project.name, "project_slug": project.slug, **(details or {})},
    ))


async def _build_account_deletion_impact(
    user: User,
    db: AsyncSession,
) -> AccountDeletionImpactResponse:
    owned_result = await db.execute(
        select(Project).where(Project.created_by == user.id).order_by(Project.name.asc())
    )
    owned_projects = owned_result.scalars().all()
    personal_file_count = await db.scalar(
        select(func.count(ProjectFileRecord.id)).where(
            ProjectFileRecord.user_id == user.id,
            ProjectFileRecord.project_id.is_(None),
        )
    ) or 0
    project_membership_count = await db.scalar(
        select(func.count(ProjectMembership.id)).where(ProjectMembership.user_id == user.id)
    ) or 0
    active_session_count = await db.scalar(
        select(func.count(RefreshToken.id)).where(
            RefreshToken.user_id == user.id,
            RefreshToken.revoked.is_(False),
            RefreshToken.expires_at > datetime.now(timezone.utc).replace(tzinfo=None),
        )
    ) or 0
    created_service_account_count = await db.scalar(
        select(func.count(ServiceAccount.id)).where(ServiceAccount.created_by == user.id)
    ) or 0
    # shared_links is owned by file-service models, so keep this count in a
    # narrow SQL expression without introducing a conflicting ORM mapping.
    active_shared_link_count = await db.scalar(
        text("SELECT COUNT(*) FROM shared_links WHERE user_id = :user_id AND is_active = TRUE"),
        {"user_id": user.id},
    ) or 0

    blockers: list[str] = []
    if owned_projects:
        blockers.append("OWNED_PROJECTS")
    if user.role == "admin":
        active_admin_count = await db.scalar(
            select(func.count(User.id)).where(
                User.role == "admin",
                User.is_active.is_(True),
                User.deletion_status == "active",
            )
        ) or 0
        if active_admin_count <= 1:
            blockers.append("LAST_SYSTEM_ADMIN")

    return AccountDeletionImpactResponse(
        deletion_status=user.deletion_status,
        can_delete=not blockers and user.deletion_status == "active",
        blockers=blockers,
        personal_file_count=int(personal_file_count),
        personal_storage_bytes=int(user.storage_used or 0),
        owned_projects=[
            OwnedProjectSummary(id=project.id, slug=project.slug, name=project.name)
            for project in owned_projects
        ],
        project_membership_count=int(project_membership_count),
        active_shared_link_count=int(active_shared_link_count),
        active_session_count=int(active_session_count),
        created_service_account_count=int(created_service_account_count),
        scheduled_for=user.deletion_scheduled_at,
    )


@app.get("/api/v1/auth/account/deletion-impact", response_model=AccountDeletionImpactResponse)
async def account_deletion_impact(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _build_account_deletion_impact(user, db)


@app.post("/api/v1/auth/account/deletion-request", response_model=AccountDeletionStatusResponse)
async def request_account_deletion(
    req: AccountDeletionRequestCreate,
    request: Request,
    authorization: str = Header(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if req.confirmation.strip().casefold() != user.email.casefold():
        raise HTTPException(status_code=400, detail="Email confirmation does not match")
    if not user.password_hash or not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if user.mfa_enabled:
        if not req.mfa_code:
            raise HTTPException(status_code=400, detail="Authentication code is required")
        valid_mfa, used_recovery = _verify_mfa_code(user, req.mfa_code)
        if not valid_mfa:
            raise HTTPException(status_code=400, detail="Invalid authentication code")
    else:
        used_recovery = False

    impact = await _build_account_deletion_impact(user, db)
    if impact.blockers:
        readable = ", ".join(impact.blockers)
        raise HTTPException(status_code=409, detail=f"Resolve account deletion blockers: {readable}")

    locked_result = await db.execute(
        select(User).where(User.id == user.id).with_for_update()
    )
    locked_user = locked_result.scalar_one()
    if locked_user.deletion_status != "active":
        raise HTTPException(status_code=409, detail="Account deletion is already in progress")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    execute_after = now + timedelta(days=settings.ACCOUNT_DELETION_GRACE_DAYS)
    existing_result = await db.execute(
        select(AccountDeletionRequest)
        .where(AccountDeletionRequest.user_id == locked_user.id)
        .with_for_update()
    )
    deletion_request = existing_result.scalar_one_or_none()
    if deletion_request:
        deletion_request.status = "scheduled"
        deletion_request.execute_after = execute_after
        deletion_request.attempt_count = 0
        deletion_request.last_error = None
        deletion_request.started_at = None
        deletion_request.completed_at = None
        deletion_request.cancelled_at = None
    else:
        deletion_request = AccountDeletionRequest(
            user_id=locked_user.id,
            status="scheduled",
            execute_after=execute_after,
        )
        db.add(deletion_request)

    locked_user.deletion_status = "pending"
    locked_user.deletion_requested_at = now
    locked_user.deletion_scheduled_at = execute_after
    locked_user.is_active = False
    revoke_result = await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == locked_user.id, RefreshToken.revoked.is_(False))
        .values(revoked=True, revoked_at=now)
    )
    _add_security_audit(
        db,
        "ACCOUNT_DELETION_REQUESTED",
        request,
        user_id=locked_user.id,
        details={
            "execute_after": execute_after.isoformat(),
            "refresh_sessions_revoked": revoke_result.rowcount or 0,
            "used_recovery_code": used_recovery,
        },
    )
    await db.commit()
    await _blacklist_authorization_token(authorization)
    return AccountDeletionStatusResponse(
        detail="Account deletion scheduled",
        status="pending",
        scheduled_for=execute_after,
    )


@app.post("/api/v1/auth/account/deletion-cancel", response_model=AccountDeletionStatusResponse)
async def cancel_account_deletion(
    req: AccountDeletionCancelRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    await _enforce_auth_rate_limit(
        request, "deletion-cancel", req.email, settings.AUTH_LOGIN_ATTEMPTS_PER_WINDOW
    )
    result = await db.execute(
        select(User).where(func.lower(User.email) == req.email.lower()).with_for_update()
    )
    user = result.scalar_one_or_none()
    if not user or not user.password_hash or not verify_password(req.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if user.deletion_status != "pending":
        raise HTTPException(status_code=409, detail="Account deletion cannot be cancelled")
    if user.mfa_enabled:
        if not req.mfa_code:
            raise HTTPException(status_code=428, detail="MFA_REQUIRED")
        valid_mfa, used_recovery = _verify_mfa_code(user, req.mfa_code)
        if not valid_mfa:
            raise HTTPException(status_code=401, detail="Invalid authentication code")
    else:
        used_recovery = False

    deletion_result = await db.execute(
        select(AccountDeletionRequest)
        .where(AccountDeletionRequest.user_id == user.id)
        .with_for_update()
    )
    deletion_request = deletion_result.scalar_one_or_none()
    if not deletion_request or deletion_request.status != "scheduled":
        raise HTTPException(status_code=409, detail="Account deletion can no longer be cancelled")

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    deletion_request.status = "cancelled"
    deletion_request.cancelled_at = now
    deletion_request.last_error = None
    user.deletion_status = "active"
    user.deletion_requested_at = None
    user.deletion_scheduled_at = None
    user.is_active = True
    _add_security_audit(
        db,
        "ACCOUNT_DELETION_CANCELLED",
        request,
        user_id=user.id,
        details={"used_recovery_code": used_recovery},
    )
    await db.commit()
    return AccountDeletionStatusResponse(
        detail="Account deletion cancelled. Sign in again to continue.",
        status="active",
    )


@app.post("/api/v1/projects/{project_id}/transfer-ownership", response_model=ProjectResponse)
async def transfer_project_ownership(
    project_id: str,
    req: ProjectTransferOwnershipRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, membership = await _project_membership(db, project_id, user, {"admin"})
    if project.created_by != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="Only the project owner can transfer ownership")
    if req.new_owner_user_id == project.created_by:
        raise HTTPException(status_code=409, detail="User already owns this project")

    target_result = await db.execute(
        select(ProjectMembership, User)
        .join(User, User.id == ProjectMembership.user_id)
        .where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == req.new_owner_user_id,
            ProjectMembership.role == "admin",
        )
    )
    target_row = target_result.one_or_none()
    if not target_row:
        raise HTTPException(status_code=409, detail="New owner must be a project admin")
    _, target_user = target_row
    if not target_user.is_active or target_user.deletion_status != "active":
        raise HTTPException(status_code=409, detail="New owner account must be active")

    previous_owner_id = project.created_by
    project.created_by = target_user.id
    _add_project_audit(
        db,
        "PROJECT_OWNERSHIP_TRANSFERRED",
        project,
        user,
        {"previous_owner_id": previous_owner_id, "new_owner_id": target_user.id},
    )
    await db.commit()
    await db.refresh(project)
    return _project_response(
        project,
        "admin" if user.role == "admin" else membership.role,
        await _project_is_pinned(db, user.id, project.id),
    )


@app.get("/api/v1/projects", response_model=List[ProjectResponse])
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user.role == "admin":
        result = await db.execute(
            select(Project, ProjectPin.project_id)
            .outerjoin(
                ProjectPin,
                (ProjectPin.project_id == Project.id) & (ProjectPin.user_id == user.id),
            )
            .order_by(ProjectPin.project_id.is_(None), Project.name.asc())
        )
        return [
            _project_response(project, "admin", pin_project_id is not None)
            for project, pin_project_id in result.all()
        ]

    result = await db.execute(
        select(Project, ProjectMembership.role, ProjectPin.project_id)
        .join(ProjectMembership, ProjectMembership.project_id == Project.id)
        .outerjoin(
            ProjectPin,
            (ProjectPin.project_id == Project.id) & (ProjectPin.user_id == user.id),
        )
        .where(ProjectMembership.user_id == user.id)
        .order_by(ProjectPin.project_id.is_(None), Project.name.asc())
    )
    return [
        _project_response(project, role, pin_project_id is not None)
        for project, role, pin_project_id in result.all()
    ]


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
        _add_project_audit(db, "PROJECT_CREATED", project, admin)
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
    return _project_response(
        project,
        "admin" if user.role == "admin" else membership.role,
        await _project_is_pinned(db, user.id, project.id),
    )


@app.post("/api/v1/projects/{project_id}/pin", response_model=ProjectResponse)
async def pin_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, membership = await _project_membership(db, project_id, user)
    existing = await db.get(ProjectPin, (user.id, project.id))
    if not existing:
        db.add(ProjectPin(user_id=user.id, project_id=project.id))
        _add_project_audit(db, "PROJECT_PINNED", project, user)
        await db.commit()
    return _project_response(
        project,
        "admin" if user.role == "admin" else membership.role,
        True,
    )


@app.delete("/api/v1/projects/{project_id}/pin", response_model=ProjectResponse)
async def unpin_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, membership = await _project_membership(db, project_id, user)
    existing = await db.get(ProjectPin, (user.id, project.id))
    if existing:
        await db.delete(existing)
        _add_project_audit(db, "PROJECT_UNPINNED", project, user)
        await db.commit()
    return _project_response(
        project,
        "admin" if user.role == "admin" else membership.role,
        False,
    )


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
    if updates.get("status") == "archived" or (project.status == "archived" and "status" in updates):
        raise HTTPException(
            status_code=409,
            detail="Use the project archive or restore endpoint to change archived state",
        )
    if "storage_quota" in updates and updates["storage_quota"] < project.storage_used:
        raise HTTPException(status_code=409, detail="Quota cannot be lower than storage used")
    for key, value in updates.items():
        setattr(project, key, value)
    if updates:
        _add_project_audit(db, "PROJECT_UPDATED", project, user, {"changed_fields": sorted(updates)})
    await db.commit()
    await db.refresh(project)
    return _project_response(
        project,
        "admin" if user.role == "admin" else membership.role,
        await _project_is_pinned(db, user.id, project.id),
    )


@app.post("/api/v1/projects/{project_id}/archive", response_model=ProjectResponse)
async def archive_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, membership = await _project_membership(db, project_id, user, {"admin"})
    if project.status != "archived":
        revoked_at = datetime.now(timezone.utc)
        project.status = "archived"
        await db.execute(
            update(ServiceAccount)
            .where(ServiceAccount.project_id == project.id, ServiceAccount.is_active.is_(True))
            .values(is_active=False, token_hash=None, revoked_at=revoked_at)
        )
        _add_project_audit(db, "PROJECT_ARCHIVED", project, user)
        await db.commit()
        await db.refresh(project)
    return _project_response(
        project,
        "admin" if user.role == "admin" else membership.role,
        await _project_is_pinned(db, user.id, project.id),
    )


@app.post("/api/v1/projects/{project_id}/restore", response_model=ProjectResponse)
async def restore_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, membership = await _project_membership(db, project_id, user, {"admin"})
    if project.status != "archived":
        raise HTTPException(status_code=409, detail="Only archived projects can be restored")
    project.status = "active"
    _add_project_audit(db, "PROJECT_RESTORED", project, user)
    await db.commit()
    await db.refresh(project)
    return _project_response(
        project,
        "admin" if user.role == "admin" else membership.role,
        await _project_is_pinned(db, user.id, project.id),
    )


@app.delete("/api/v1/projects/{project_id}", status_code=204)
async def delete_project(
    project_id: str,
    req: ProjectDeleteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    if req.confirm_slug != project.slug:
        raise HTTPException(status_code=400, detail="Project slug confirmation does not match")
    if project.status != "archived":
        raise HTTPException(status_code=409, detail="Archive the project before deleting it")

    file_count = await db.scalar(
        select(func.count()).select_from(ProjectFileRecord).where(ProjectFileRecord.project_id == project.id)
    )
    if file_count or project.storage_used:
        raise HTTPException(
            status_code=409,
            detail="Project still contains files. Empty project trash before permanent deletion",
        )

    _add_project_audit(db, "PROJECT_DELETED", project, user)
    await db.flush()
    await db.execute(delete(Project).where(Project.id == project.id))
    await db.commit()
    return Response(status_code=204)


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


@app.get(
    "/api/v1/projects/{project_id}/member-candidates",
    response_model=List[ProjectMemberCandidateResponse],
)
async def search_project_member_candidates(
    project_id: str,
    q: str = Query(..., min_length=2, max_length=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project, _ = await _project_membership(db, project_id, user, {"admin"})
    normalized = q.strip()
    if len(normalized) < 2:
        raise HTTPException(status_code=400, detail="Search requires at least 2 characters")
    existing_members = select(ProjectMembership.user_id).where(
        ProjectMembership.project_id == project.id,
    )
    result = await db.execute(
        select(User)
        .where(
            User.is_active == True,
            ~User.id.in_(existing_members),
            (User.email.ilike(f"%{normalized}%")) | (User.username.ilike(f"%{normalized}%")),
        )
        .order_by(User.username.asc())
        .limit(20)
    )
    return [
        ProjectMemberCandidateResponse(id=candidate.id, username=candidate.username, email=candidate.email)
        for candidate in result.scalars().all()
    ]


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
    if project.status != "active":
        raise HTTPException(status_code=409, detail="Project must be active to create service accounts")
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
    if project.status != "active":
        raise HTTPException(status_code=409, detail="Restore the project before rotating service accounts")
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
