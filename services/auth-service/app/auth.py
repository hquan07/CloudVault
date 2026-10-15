"""
CloudVault — Auth Service JWT & Password Utilities
"""

import base64
import hashlib
import hmac
import logging
import secrets
import struct
import time
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
import redis.asyncio as aioredis
from cryptography.fernet import Fernet

from app.config import settings

# ── Redis client for token blacklisting ──
redis_client: aioredis.Redis | None = None
logger = logging.getLogger(__name__)


class RateLimitExceeded(Exception):
    def __init__(self, retry_after: int):
        super().__init__("Authentication rate limit exceeded")
        self.retry_after = max(1, retry_after)


async def init_redis():
    global redis_client
    redis_client = aioredis.from_url(
        settings.redis_url, decode_responses=True
    )


async def close_redis():
    global redis_client
    if redis_client:
        await redis_client.close()


# ── Password hashing ──

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


# ── JWT tokens ──

def create_access_token(user_id: str, email: str, session_id: str | None = None) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "type": "access",
        "exp": datetime.now(timezone.utc)
        + timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES),
        "iat": datetime.now(timezone.utc),
        "jti": str(uuid.uuid4()),
    }
    if session_id:
        payload["sid"] = session_id
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token() -> tuple[str, str, datetime]:
    """Returns (raw_token, token_hash, expires_at)."""
    raw = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS)
    return raw, token_hash, expires_at


def create_service_token() -> tuple[str, str, str]:
    """Return a one-time raw token, display prefix, and SHA-256 hash."""
    prefix = f"cvp_{uuid.uuid4().hex[:12]}"
    raw = f"{prefix}.{secrets.token_urlsafe(36)}"
    return raw, prefix, hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ── TOTP multi-factor authentication ──

def _mfa_cipher() -> Fernet:
    source = settings.MFA_ENCRYPTION_KEY or settings.JWT_SECRET_KEY
    key = base64.urlsafe_b64encode(hashlib.sha256(source.encode("utf-8")).digest())
    return Fernet(key)


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def encrypt_mfa_secret(secret: str) -> str:
    return _mfa_cipher().encrypt(secret.encode("ascii")).decode("ascii")


def decrypt_mfa_secret(encrypted: str) -> str:
    return _mfa_cipher().decrypt(encrypted.encode("ascii")).decode("ascii")


def totp_code(secret: str, timestamp: int | None = None) -> str:
    normalized = secret.upper() + "=" * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(normalized)
    counter = int((timestamp if timestamp is not None else time.time()) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def verify_totp(code: str, secret: str, timestamp: int | None = None) -> bool:
    if not code.isdigit() or len(code) != 6:
        return False
    now = timestamp if timestamp is not None else int(time.time())
    return any(
        secrets.compare_digest(code, totp_code(secret, now + offset * 30))
        for offset in (-1, 0, 1)
    )


def generate_recovery_codes(count: int = 8) -> list[str]:
    return [f"{secrets.token_hex(3).upper()}-{secrets.token_hex(3).upper()}" for _ in range(count)]


def hash_recovery_code(code: str) -> str:
    normalized = code.strip().upper().replace(" ", "")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def decode_access_token(token: str) -> dict:
    """Decode and validate an access token. Raises jwt exceptions on failure."""
    return jwt.decode(
        token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
    )


# ── Token blacklisting via Redis ──

async def blacklist_token(jti: str, ttl_seconds: int = 1800):
    if redis_client:
        await redis_client.setex(f"blacklist:{jti}", ttl_seconds, "1")


async def is_token_blacklisted(jti: str) -> bool:
    if redis_client:
        return bool(await redis_client.get(f"blacklist:{jti}"))
    return False


async def enforce_rate_limit(
    scope: str,
    identifier: str,
    *,
    limit: int,
    window_seconds: int,
) -> None:
    """Apply a fixed-window Redis limit without storing raw identifiers."""
    if not redis_client:
        return
    digest = hashlib.sha256(identifier.encode("utf-8")).hexdigest()
    key = f"auth-rate:{scope}:{digest}"
    try:
        current, ttl = await redis_client.eval(
            """
            local current = redis.call('INCR', KEYS[1])
            if current == 1 then
                redis.call('EXPIRE', KEYS[1], ARGV[1])
            end
            return {current, redis.call('TTL', KEYS[1])}
            """,
            1,
            key,
            window_seconds,
        )
    except Exception:
        # Nginx remains the outer limiter. A Redis outage must not turn into an
        # authentication outage, and no credential material is logged here.
        logger.exception("Redis authentication rate limiter is unavailable")
        return
    if int(current) > limit:
        raise RateLimitExceeded(int(ttl) if int(ttl) > 0 else window_seconds)
