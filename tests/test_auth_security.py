import hashlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "auth-service"))

os.environ.setdefault("MYSQL_PASSWORD", "m" * 32)
os.environ.setdefault("REDIS_PASSWORD", "r" * 32)
os.environ.setdefault("JWT_SECRET_KEY", "j" * 32)

from app import auth  # noqa: E402
from app.schemas import RegisterRequest  # noqa: E402
from pydantic import ValidationError  # noqa: E402


class FakeRedis:
    def __init__(self):
        self.counts: dict[str, int] = {}
        self.keys: list[str] = []

    async def eval(self, _script, _key_count, key, window_seconds):
        self.keys.append(key)
        self.counts[key] = self.counts.get(key, 0) + 1
        return [self.counts[key], int(window_seconds)]


class BrokenRedis:
    async def eval(self, *_args):
        raise ConnectionError("unavailable")


class AuthenticationSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.original_redis = auth.redis_client

    async def asyncTearDown(self):
        auth.redis_client = self.original_redis

    async def test_rate_limit_hashes_identifier_and_enforces_threshold(self):
        fake = FakeRedis()
        auth.redis_client = fake
        identifier = "127.0.0.1:user@example.com"

        await auth.enforce_rate_limit("login", identifier, limit=2, window_seconds=60)
        await auth.enforce_rate_limit("login", identifier, limit=2, window_seconds=60)
        with self.assertRaises(auth.RateLimitExceeded) as raised:
            await auth.enforce_rate_limit("login", identifier, limit=2, window_seconds=60)

        self.assertEqual(raised.exception.retry_after, 60)
        self.assertNotIn(identifier, fake.keys[0])
        self.assertIn(hashlib.sha256(identifier.encode()).hexdigest(), fake.keys[0])

    async def test_rate_limiter_fails_open_when_redis_is_unavailable(self):
        auth.redis_client = BrokenRedis()
        with patch.object(auth.logger, "exception") as logged:
            await auth.enforce_rate_limit("login", "client", limit=1, window_seconds=60)
        logged.assert_called_once()

    def test_registration_requires_twelve_character_password(self):
        with self.assertRaises(ValidationError):
            RegisterRequest(email="user@example.com", username="user", password="shortpass")

        request = RegisterRequest(
            email="user@example.com",
            username="user",
            password="a-long-passphrase",
        )
        self.assertEqual(request.username, "user")

    def test_refresh_token_is_stored_as_hash(self):
        raw, token_hash, expires_at = auth.create_refresh_token()
        self.assertNotEqual(raw, token_hash)
        self.assertEqual(hashlib.sha256(raw.encode()).hexdigest(), token_hash)
        self.assertGreater(expires_at.timestamp(), 0)

    def test_access_token_tracks_refresh_session(self):
        token = auth.create_access_token("user-1", "user@example.com", "session-1")
        payload = auth.decode_access_token(token)
        self.assertEqual(payload["sub"], "user-1")
        self.assertEqual(payload["sid"], "session-1")

    def test_totp_accepts_current_window_and_rejects_invalid_code(self):
        secret = auth.generate_totp_secret()
        code = auth.totp_code(secret, timestamp=1_700_000_000)
        self.assertTrue(auth.verify_totp(code, secret, timestamp=1_700_000_000))
        self.assertFalse(auth.verify_totp("000000" if code != "000000" else "111111", secret, timestamp=1_700_000_000))

    def test_mfa_secret_is_encrypted_at_rest(self):
        secret = auth.generate_totp_secret()
        encrypted = auth.encrypt_mfa_secret(secret)
        self.assertNotIn(secret, encrypted)
        self.assertEqual(auth.decrypt_mfa_secret(encrypted), secret)

    def test_recovery_codes_are_normalized_before_hashing(self):
        code = auth.generate_recovery_codes(1)[0]
        self.assertEqual(auth.hash_recovery_code(code), auth.hash_recovery_code(code.lower()))


if __name__ == "__main__":
    unittest.main()
