import os
import sys
import unittest
from pathlib import Path

from pydantic import ValidationError


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "auth-service"))

os.environ.setdefault("MYSQL_PASSWORD", "m" * 32)
os.environ.setdefault("REDIS_PASSWORD", "r" * 32)
os.environ.setdefault("JWT_SECRET_KEY", "j" * 32)

from app.schemas import (  # noqa: E402
    AccountDeletionCancelRequest,
    AccountDeletionRequestCreate,
)


class AccountDeletionContractTests(unittest.TestCase):
    def test_deletion_confirmation_requires_password_and_valid_mfa_shape(self):
        request = AccountDeletionRequestCreate(
            current_password="correct horse battery staple",
            confirmation="user@example.com",
        )
        self.assertEqual(request.confirmation, "user@example.com")

        with self.assertRaises(ValidationError):
            AccountDeletionRequestCreate(
                current_password="password",
                confirmation="user@example.com",
                mfa_code="123",
            )

    def test_cancellation_requires_a_valid_email(self):
        with self.assertRaises(ValidationError):
            AccountDeletionCancelRequest(
                email="not-an-email",
                current_password="password",
            )

    def test_service_account_creator_can_be_detached_without_revoking_project_credential(self):
        migration = (ROOT / "infrastructure/mysql/migrations/014_account_deletion.sql").read_text()
        self.assertIn("MODIFY COLUMN created_by CHAR(36) NULL", migration)
        self.assertIn("REFERENCES users(id) ON DELETE SET NULL", migration)

    def test_user_exposes_explicit_deletion_lifecycle(self):
        migration = (ROOT / "infrastructure/mysql/migrations/014_account_deletion.sql").read_text()
        for column in (
            "deletion_status",
            "deletion_requested_at",
            "deletion_scheduled_at",
            "deletion_completed_at",
            "anonymized_at",
        ):
            self.assertIn(column, migration)

    def test_admin_accounts_are_always_blocked_from_self_service_deletion(self):
        auth_source = (ROOT / "services/auth-service/app/main.py").read_text()
        settings_source = (ROOT / "frontend/src/components/SettingsModal.tsx").read_text()

        self.assertIn(
            'if user.role == "admin":\n        blockers.append("SYSTEM_ADMIN")',
            auth_source,
        )
        self.assertNotIn('blockers.append("LAST_SYSTEM_ADMIN")', auth_source)
        self.assertIn("blockers.includes('SYSTEM_ADMIN')", settings_source)


if __name__ == "__main__":
    unittest.main()
