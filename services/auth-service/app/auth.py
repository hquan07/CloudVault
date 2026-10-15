"""
CloudVault — Auth Service JWT & Password Utilities
"""

import hashlib
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
import redis.asyncio as aioredis

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

def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "type": "access",
        "exp": datetime.now(timezone.utc)
        + timedelta(minutes=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES),
        "iat": datetime.now(timezone.utc),
        "jti": str(uuid.uuid4()),
    }
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
