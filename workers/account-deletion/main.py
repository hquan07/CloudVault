"""Delayed, idempotent account-data purge worker for CloudVault."""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import pymysql
from minio import Minio
from minio.error import S3Error
from prometheus_client import Counter, Gauge, start_http_server


logging.basicConfig(level=logging.INFO, format="%(asctime)s [AccountDeletion] %(message)s")
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Settings:
    mysql_host: str = os.getenv("MYSQL_HOST", "mysql")
    mysql_port: int = int(os.getenv("MYSQL_PORT", "3306"))
    mysql_database: str = os.getenv("MYSQL_DATABASE", "cloudvault")
    mysql_user: str = os.getenv("MYSQL_USER", "cloudvault")
    mysql_password: str = os.environ["MYSQL_PASSWORD"]
    minio_endpoint: str = os.getenv("MINIO_ENDPOINT", "minio:9000")
    minio_user: str = os.getenv("MINIO_ROOT_USER", "cloudvault_admin")
    minio_password: str = os.environ["MINIO_ROOT_PASSWORD"]
    files_bucket: str = os.getenv("MINIO_BUCKET_FILES", "cloudvault-files")
    thumbnails_bucket: str = os.getenv("MINIO_BUCKET_THUMBNAILS", "cloudvault-thumbnails")
    interval_seconds: int = int(os.getenv("ACCOUNT_DELETION_INTERVAL_SECONDS", "60"))
    retry_seconds: int = int(os.getenv("ACCOUNT_DELETION_RETRY_SECONDS", "300"))
    max_attempts: int = int(os.getenv("ACCOUNT_DELETION_MAX_ATTEMPTS", "5"))
    metrics_port: int = int(os.getenv("ACCOUNT_DELETION_METRICS_PORT", "9101"))


DELETION_PENDING = Gauge(
    "cloudvault_account_deletion_pending", "Account deletion requests waiting for purge."
)
DELETION_FAILED = Gauge(
    "cloudvault_account_deletion_failed", "Account deletion requests currently failed."
)
DELETION_COMPLETED = Counter(
    "cloudvault_account_deletion_completed_total", "Completed account deletions."
)
DELETION_ERRORS = Counter(
    "cloudvault_account_deletion_errors_total", "Account deletion worker errors."
)
DELETION_LAST_SUCCESS = Gauge(
    "cloudvault_account_deletion_last_success_timestamp_seconds",
    "Unix timestamp of the latest successful purge.",
)


class AccountDeletionWorker:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.minio = Minio(
            settings.minio_endpoint,
            access_key=settings.minio_user,
            secret_key=settings.minio_password,
            secure=False,
        )

    def connect(self):
        return pymysql.connect(
            host=self.settings.mysql_host,
            port=self.settings.mysql_port,
            user=self.settings.mysql_user,
            password=self.settings.mysql_password,
            database=self.settings.mysql_database,
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=False,
        )

    def _remove_object(self, bucket: str, key: str | None) -> None:
        if not key:
            return
        try:
            self.minio.remove_object(bucket, key)
        except S3Error as error:
            if error.code not in {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}:
                raise

    def _abort_multipart(self, key: str | None, upload_id: str | None) -> None:
        if not key or not upload_id:
            return
        try:
            self.minio._abort_multipart_upload(self.settings.files_bucket, key, upload_id)
        except S3Error as error:
            if error.code not in {"NoSuchUpload", "NoSuchKey", "NoSuchObject"}:
                raise

    def _claim(self, db) -> dict[str, Any] | None:
        with db.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, user_id, attempt_count
                FROM account_deletion_requests
                WHERE execute_after <= UTC_TIMESTAMP()
                  AND attempt_count < %s
                  AND (
                    status='scheduled'
                    OR (status='failed' AND updated_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL %s SECOND))
                  )
                ORDER BY execute_after, created_at
                LIMIT 1 FOR UPDATE SKIP LOCKED
                """,
                (self.settings.max_attempts, self.settings.retry_seconds),
            )
            request = cursor.fetchone()
            if not request:
                db.rollback()
                return None
            cursor.execute(
                """
                UPDATE account_deletion_requests
                SET status='purging', attempt_count=attempt_count+1,
                    started_at=UTC_TIMESTAMP(), last_error=NULL
                WHERE id=%s
                """,
                (request["id"],),
            )
            cursor.execute(
                "UPDATE users SET deletion_status='purging', is_active=FALSE WHERE id=%s",
                (request["user_id"],),
            )
        db.commit()
        return request

    @staticmethod
    def _assert_no_owned_projects(db, user_id: str) -> None:
        with db.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE created_by=%s LIMIT 1", (user_id,))
            if cursor.fetchone():
                raise RuntimeError("Account still owns one or more projects")
        db.rollback()

    def _cancel_pending_project_uploads(self, db, user_id: str) -> None:
        with db.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, project_id, object_key, multipart_upload_id, reserved_bytes
                FROM project_uploads
                WHERE user_id=%s AND status='PENDING'
                ORDER BY project_id, id
                """,
                (user_id,),
            )
            uploads = cursor.fetchall()

        for upload in uploads:
            self._abort_multipart(upload["object_key"], upload["multipart_upload_id"])
            with db.cursor() as cursor:
                cursor.execute("SELECT id FROM projects WHERE id=%s FOR UPDATE", (upload["project_id"],))
                cursor.execute(
                    """
                    SELECT reserved_bytes FROM project_uploads
                    WHERE id=%s AND user_id=%s AND status='PENDING' FOR UPDATE
                    """,
                    (upload["id"], user_id),
                )
                locked = cursor.fetchone()
                if not locked:
                    db.rollback()
                    continue
                released = int(locked["reserved_bytes"] or 0)
                cursor.execute(
                    "UPDATE projects SET storage_used=GREATEST(0, storage_used-%s) WHERE id=%s",
                    (released, upload["project_id"]),
                )
                cursor.execute(
                    """
                    UPDATE project_uploads
                    SET status='FAILED', error_code='ACCOUNT_DELETED', reserved_bytes=0,
                        multipart_upload_id=NULL, user_id=NULL
                    WHERE id=%s
                    """,
                    (upload["id"],),
                )
            db.commit()

    def _purge_personal_files(self, db, user_id: str) -> None:
        while True:
            with db.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, minio_bucket, minio_key, thumbnail_key
                    FROM files
                    WHERE user_id=%s AND project_id IS NULL
                    ORDER BY id LIMIT 1
                    """,
                    (user_id,),
                )
                stored_file = cursor.fetchone()
                if not stored_file:
                    db.rollback()
                    return
                cursor.execute(
                    "SELECT minio_key FROM file_versions WHERE file_id=%s",
                    (stored_file["id"],),
                )
                versions = cursor.fetchall()

            object_keys = {stored_file["minio_key"], *(row["minio_key"] for row in versions)}
            for key in object_keys:
                self._remove_object(stored_file["minio_bucket"], key)
            self._remove_object(self.settings.thumbnails_bucket, stored_file["thumbnail_key"])

            with db.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM files WHERE id=%s AND user_id=%s AND project_id IS NULL",
                    (stored_file["id"], user_id),
                )
            db.commit()

    def _finalize(self, db, request: dict[str, Any]) -> None:
        user_id = request["user_id"]
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        anonymized_email = f"deleted+{user_id}@invalid.cloudvault.local"
        anonymized_username = f"deleted-{user_id}"
        with db.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE created_by=%s LIMIT 1 FOR UPDATE", (user_id,))
            if cursor.fetchone():
                raise RuntimeError("Account acquired project ownership while purge was running")
            cursor.execute(
                "SELECT COUNT(*) AS count FROM files WHERE user_id=%s AND project_id IS NULL",
                (user_id,),
            )
            if int(cursor.fetchone()["count"] or 0):
                raise RuntimeError("Personal file metadata remains after object purge")

            cursor.execute("DELETE FROM shared_links WHERE user_id=%s", (user_id,))
            cursor.execute("DELETE FROM folder_permissions WHERE user_id=%s", (user_id,))
            cursor.execute("DELETE FROM project_pins WHERE user_id=%s", (user_id,))
            cursor.execute("DELETE FROM project_memberships WHERE user_id=%s", (user_id,))
            cursor.execute("DELETE FROM refresh_tokens WHERE user_id=%s", (user_id,))
            cursor.execute("UPDATE service_accounts SET created_by=NULL WHERE created_by=%s", (user_id,))
            cursor.execute("UPDATE project_uploads SET user_id=NULL WHERE user_id=%s", (user_id,))
            cursor.execute("UPDATE file_versions SET uploaded_by=NULL WHERE uploaded_by=%s", (user_id,))
            cursor.execute("DELETE FROM folders WHERE user_id=%s AND project_id IS NULL", (user_id,))
            cursor.execute(
                """
                UPDATE users
                SET email=%s, username=%s, password_hash=NULL, avatar_url=NULL,
                    storage_used=0, oauth_provider='local', oauth_id=NULL, role='user',
                    is_active=FALSE, is_verified=FALSE, mfa_enabled=FALSE,
                    mfa_secret_encrypted=NULL, mfa_recovery_codes=NULL,
                    deletion_status='deleted', deletion_completed_at=%s,
                    anonymized_at=%s, last_login_at=NULL
                WHERE id=%s AND deletion_status='purging'
                """,
                (anonymized_email, anonymized_username, now, now, user_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("Account is no longer in purging state")
            cursor.execute(
                """
                UPDATE account_deletion_requests
                SET status='completed', completed_at=%s, last_error=NULL
                WHERE id=%s AND status='purging'
                """,
                (now, request["id"]),
            )
            cursor.execute(
                """
                INSERT INTO audit_logs (
                    id, user_id, action, resource_type, resource_id, details_json
                ) VALUES (%s, %s, 'ACCOUNT_DELETION_COMPLETED', 'user', %s, %s)
                """,
                (
                    str(uuid.uuid4()), user_id, user_id,
                    json.dumps({"anonymized": True, "personal_storage_purged": True}),
                ),
            )
        db.commit()

    def _mark_failed(self, db, request: dict[str, Any], error: Exception) -> None:
        message = str(error)[:1000] or error.__class__.__name__
        db.rollback()
        with db.cursor() as cursor:
            cursor.execute(
                "UPDATE account_deletion_requests SET status='failed', last_error=%s WHERE id=%s",
                (message, request["id"]),
            )
            cursor.execute(
                "UPDATE users SET deletion_status='failed', is_active=FALSE WHERE id=%s",
                (request["user_id"],),
            )
            cursor.execute(
                """
                INSERT INTO audit_logs (
                    id, user_id, action, resource_type, resource_id, details_json
                ) VALUES (%s, %s, 'ACCOUNT_DELETION_FAILED', 'user', %s, %s)
                """,
                (
                    str(uuid.uuid4()), request["user_id"], request["user_id"],
                    json.dumps({"error": message}),
                ),
            )
        db.commit()

    def _update_metrics(self, db) -> None:
        with db.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    SUM(status='scheduled') AS pending,
                    SUM(status='failed') AS failed
                FROM account_deletion_requests
                """
            )
            counts = cursor.fetchone()
        db.rollback()
        DELETION_PENDING.set(int(counts["pending"] or 0))
        DELETION_FAILED.set(int(counts["failed"] or 0))

    def run_once(self) -> bool:
        with self.connect() as db:
            self._update_metrics(db)
            request = None
            try:
                request = self._claim(db)
                if not request:
                    return False
                self._assert_no_owned_projects(db, request["user_id"])
                self._cancel_pending_project_uploads(db, request["user_id"])
                self._purge_personal_files(db, request["user_id"])
                self._finalize(db, request)
                DELETION_COMPLETED.inc()
                DELETION_LAST_SUCCESS.set(time.time())
                logger.info("Completed account deletion request %s", request["id"])
                return True
            except Exception as error:  # noqa: BLE001 - worker boundary
                DELETION_ERRORS.inc()
                if request:
                    self._mark_failed(db, request, error)
                else:
                    db.rollback()
                logger.exception("Account deletion cycle failed")
                return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CloudVault account deletion worker")
    parser.add_argument("--once", action="store_true", help="Process at most one due request")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    settings = Settings()
    worker = AccountDeletionWorker(settings)
    if args.once:
        worker.run_once()
        return 0

    start_http_server(settings.metrics_port)
    logger.info("Metrics listening on :%s; interval=%ss", settings.metrics_port, settings.interval_seconds)
    while True:
        worker.run_once()
        time.sleep(settings.interval_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
