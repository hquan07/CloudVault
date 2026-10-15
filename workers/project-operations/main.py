"""CloudVault project operations controller.

The controller continuously reconciles project metadata with MinIO and exposes
low-cardinality Prometheus gauges. Mutating maintenance is disabled by default;
operators must explicitly enable each apply flag or run ``--apply`` manually.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import pymysql
from minio import Minio
from minio.error import S3Error
from prometheus_client import Gauge, start_http_server


logging.basicConfig(level=logging.INFO, format="%(asctime)s [ProjectOperations] %(message)s")
logger = logging.getLogger(__name__)


def _bool_env(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


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
    interval_seconds: int = int(os.getenv("PROJECT_OPERATIONS_INTERVAL_SECONDS", "300"))
    stale_upload_minutes: int = int(os.getenv("PROJECT_STALE_UPLOAD_MINUTES", "30"))
    trash_grace_days: int = int(os.getenv("PROJECT_TRASH_GRACE_DAYS", "7"))
    orphan_grace_hours: int = int(os.getenv("PROJECT_ORPHAN_GRACE_HOURS", "24"))
    metrics_port: int = int(os.getenv("PROJECT_OPERATIONS_METRICS_PORT", "9100"))
    apply_stale_uploads: bool = _bool_env("PROJECT_APPLY_STALE_UPLOAD_CLEANUP")
    apply_retention: bool = _bool_env("PROJECT_APPLY_RETENTION")
    apply_usage: bool = _bool_env("PROJECT_APPLY_USAGE_RECONCILIATION")
    delete_orphans: bool = _bool_env("PROJECT_DELETE_ORPHANS")


PROJECT_STORAGE_USED = Gauge(
    "cloudvault_project_storage_used_bytes", "Recorded project usage.", ("project", "project_id")
)
PROJECT_STORAGE_QUOTA = Gauge(
    "cloudvault_project_storage_quota_bytes", "Project hard quota.", ("project", "project_id")
)
PROJECT_QUOTA_RATIO = Gauge(
    "cloudvault_project_quota_ratio", "Recorded usage divided by quota.", ("project", "project_id")
)
PROJECT_WARNING_RATIO = Gauge(
    "cloudvault_project_warning_ratio", "Configured quota warning threshold.", ("project", "project_id")
)
PROJECT_METADATA_BYTES = Gauge(
    "cloudvault_project_metadata_bytes", "Bytes referenced by file versions plus reservations.", ("project", "project_id")
)
PROJECT_OBJECT_BYTES = Gauge(
    "cloudvault_project_object_bytes", "Bytes present in the project MinIO prefix.", ("project", "project_id")
)
PROJECT_USAGE_DRIFT = Gauge(
    "cloudvault_project_usage_drift_bytes", "Recorded usage minus metadata-derived usage.", ("project", "project_id")
)
PROJECT_MISSING_OBJECTS = Gauge(
    "cloudvault_project_missing_objects", "Metadata objects missing from MinIO.", ("project", "project_id")
)
PROJECT_ORPHAN_OBJECTS = Gauge(
    "cloudvault_project_orphan_objects", "MinIO project objects not referenced by metadata.", ("project", "project_id")
)
PROJECT_STALE_UPLOADS = Gauge(
    "cloudvault_project_stale_uploads", "PENDING uploads older than the configured threshold.", ("project", "project_id")
)
PROJECT_EXPIRED_FILES = Gauge(
    "cloudvault_project_expired_files", "Available files past their retention deadline.", ("project", "project_id")
)
PROJECT_FILE_COUNT = Gauge(
    "cloudvault_project_files", "Project file records grouped by status.", ("project", "project_id", "status")
)
OPERATIONS_LAST_SUCCESS = Gauge(
    "cloudvault_project_operations_last_success_timestamp_seconds",
    "Unix timestamp of the last successful full reconciliation cycle.",
)
OPERATIONS_CYCLE_ERRORS = Gauge(
    "cloudvault_project_operations_cycle_errors", "Projects that failed during the latest cycle."
)


class ProjectOperations:
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

    @staticmethod
    def _reset_project_metrics() -> None:
        for metric in (
            PROJECT_STORAGE_USED, PROJECT_STORAGE_QUOTA, PROJECT_QUOTA_RATIO,
            PROJECT_WARNING_RATIO, PROJECT_METADATA_BYTES, PROJECT_OBJECT_BYTES,
            PROJECT_USAGE_DRIFT, PROJECT_MISSING_OBJECTS, PROJECT_ORPHAN_OBJECTS,
            PROJECT_STALE_UPLOADS, PROJECT_EXPIRED_FILES, PROJECT_FILE_COUNT,
        ):
            metric.clear()

    def _remove_object(self, bucket: str, key: str) -> bool:
        try:
            self.minio.remove_object(bucket, key)
            return True
        except S3Error as exc:
            logger.error("Cannot remove %s/%s: %s", bucket, key, exc)
            return False

    def _cleanup_stale_uploads(self, db, project: dict[str, Any]) -> int:
        if not self.settings.apply_stale_uploads:
            return 0
        stale_before = datetime.now(timezone.utc) - timedelta(minutes=self.settings.stale_upload_minutes)
        with db.cursor() as cursor:
            # Match the API lock order: project first, then upload rows.
            cursor.execute(
                "SELECT id FROM projects WHERE id=%s FOR UPDATE",
                (project["id"],),
            )
            cursor.execute(
                """
                SELECT id, object_key, reserved_bytes
                FROM project_uploads
                WHERE project_id=%s AND status='PENDING' AND updated_at < %s
                FOR UPDATE
                """,
                (project["id"], stale_before.replace(tzinfo=None)),
            )
            uploads = cursor.fetchall()
            released = sum(int(row["reserved_bytes"] or 0) for row in uploads)
            if uploads:
                cursor.execute(
                    "UPDATE projects SET storage_used=GREATEST(0, storage_used-%s) WHERE id=%s",
                    (released, project["id"]),
                )
                cursor.execute(
                    """
                    UPDATE project_uploads
                    SET status='FAILED', reserved_bytes=0, error_code=COALESCE(error_code, 'STALE_UPLOAD')
                    WHERE project_id=%s AND status='PENDING' AND updated_at < %s
                    """,
                    (project["id"], stale_before.replace(tzinfo=None)),
                )
        db.commit()
        for upload in uploads:
            if upload["object_key"]:
                self._remove_object(self.settings.files_bucket, upload["object_key"])
        return len(uploads)

    def _apply_retention(self, db, project: dict[str, Any]) -> dict[str, int]:
        if not self.settings.apply_retention:
            return {"soft_deleted": 0, "purged": 0}
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        purge_before = now - timedelta(days=self.settings.trash_grace_days)
        with db.cursor() as cursor:
            cursor.execute(
                """
                UPDATE files
                SET status='DELETED', is_deleted=TRUE, deleted_at=%s
                WHERE project_id=%s AND status='AVAILABLE' AND is_deleted=FALSE
                  AND retention_until IS NOT NULL AND retention_until <= %s
                """,
                (now, project["id"], now),
            )
            soft_deleted = cursor.rowcount
            cursor.execute(
                """
                SELECT id
                FROM files
                WHERE project_id=%s AND status='DELETED' AND is_deleted=TRUE
                  AND retention_until IS NOT NULL AND retention_until <= %s
                  AND deleted_at <= %s
                """,
                (project["id"], now, purge_before),
            )
            files = cursor.fetchall()
        db.commit()

        purged = 0
        for stored in files:
            try:
                with db.cursor() as cursor:
                    # Match permanent-delete lock ordering and re-check that the
                    # retention candidate is still eligible after waiting.
                    cursor.execute(
                        "SELECT id FROM projects WHERE id=%s FOR UPDATE",
                        (project["id"],),
                    )
                    cursor.execute(
                        """
                        SELECT id, minio_bucket, minio_key, size, thumbnail_key
                        FROM files
                        WHERE id=%s AND project_id=%s
                          AND status='DELETED' AND is_deleted=TRUE
                          AND retention_until IS NOT NULL AND retention_until <= %s
                          AND deleted_at <= %s
                        FOR UPDATE
                        """,
                        (stored["id"], project["id"], now, purge_before),
                    )
                    locked_file = cursor.fetchone()
                    if not locked_file:
                        db.rollback()
                        continue
                    cursor.execute(
                        "SELECT minio_key, size FROM file_versions WHERE file_id=%s",
                        (locked_file["id"],),
                    )
                    versions = cursor.fetchall()

                objects = {
                    (locked_file["minio_bucket"], locked_file["minio_key"]):
                        int(locked_file["size"] or 0)
                }
                for version in versions:
                    objects[(locked_file["minio_bucket"], version["minio_key"])] = int(
                        version["size"] or 0
                    )
                objects_removed = all(
                    self._remove_object(bucket, key) for bucket, key in objects
                )
                thumbnail_removed = (
                    not locked_file["thumbnail_key"]
                    or self._remove_object(
                        self.settings.thumbnails_bucket,
                        locked_file["thumbnail_key"],
                    )
                )
                if not objects_removed or not thumbnail_removed:
                    db.rollback()
                    continue

                released = sum(objects.values())
                with db.cursor() as cursor:
                    cursor.execute(
                        """
                        DELETE FROM files
                        WHERE id=%s AND project_id=%s
                          AND status='DELETED' AND is_deleted=TRUE
                        """,
                        (locked_file["id"], project["id"]),
                    )
                    if cursor.rowcount != 1:
                        db.rollback()
                        continue
                    cursor.execute(
                        "UPDATE projects SET storage_used=GREATEST(0, storage_used-%s) WHERE id=%s",
                        (released, project["id"]),
                    )
                db.commit()
                purged += 1
            except Exception:
                db.rollback()
                raise
        return {"soft_deleted": soft_deleted, "purged": purged}

    def _scan_project(self, db, project: dict[str, Any]) -> dict[str, Any]:
        project_id = project["id"]
        with db.cursor() as cursor:
            cursor.execute(
                "SELECT storage_used, storage_quota, warning_percent FROM projects WHERE id=%s",
                (project_id,),
            )
            project.update(cursor.fetchone())
            cursor.execute(
                """
                SELECT f.id AS file_id, f.minio_bucket, f.minio_key, f.size,
                       f.checksum_sha256, f.thumbnail_key, f.status
                FROM files f WHERE f.project_id=%s
                """,
                (project_id,),
            )
            files = cursor.fetchall()
            cursor.execute(
                """
                SELECT f.minio_bucket, fv.minio_key, fv.size, fv.checksum_sha256
                FROM file_versions fv JOIN files f ON f.id=fv.file_id
                WHERE f.project_id=%s
                """,
                (project_id,),
            )
            versions = cursor.fetchall()
            cursor.execute(
                """
                SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved,
                       SUM(status='PENDING' AND updated_at < %s) AS stale
                FROM project_uploads WHERE project_id=%s
                """,
                (
                    (datetime.now(timezone.utc) - timedelta(minutes=self.settings.stale_upload_minutes)).replace(tzinfo=None),
                    project_id,
                ),
            )
            upload_summary = cursor.fetchone()
            cursor.execute(
                """
                SELECT status, COUNT(*) AS count FROM files
                WHERE project_id=%s GROUP BY status
                """,
                (project_id,),
            )
            file_counts = {row["status"]: int(row["count"]) for row in cursor.fetchall()}
            cursor.execute(
                """
                SELECT COUNT(*) AS count FROM files
                WHERE project_id=%s AND status='AVAILABLE' AND is_deleted=FALSE
                  AND retention_until IS NOT NULL AND retention_until <= UTC_TIMESTAMP()
                """,
                (project_id,),
            )
            expired = int(cursor.fetchone()["count"])

        expected: dict[tuple[str, str], int] = {}
        for row in versions:
            expected[(row["minio_bucket"], row["minio_key"])] = int(row["size"] or 0)
        for row in files:
            expected.setdefault((row["minio_bucket"], row["minio_key"]), int(row["size"] or 0))

        actual: dict[tuple[str, str], tuple[int, datetime | None]] = {}
        prefix = f"projects/{project['slug']}/"
        for item in self.minio.list_objects(self.settings.files_bucket, prefix=prefix, recursive=True):
            actual[(self.settings.files_bucket, item.object_name)] = (int(item.size or 0), item.last_modified)

        missing = sorted(f"{bucket}/{key}" for bucket, key in expected if (bucket, key) not in actual)
        orphans = sorted(
            f"{bucket}/{key}" for bucket, key in actual
            if (bucket, key) not in expected
        )
        missing_thumbnails = []
        for row in files:
            if not row["thumbnail_key"]:
                continue
            try:
                self.minio.stat_object(self.settings.thumbnails_bucket, row["thumbnail_key"])
            except S3Error as exc:
                if exc.code in {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}:
                    missing_thumbnails.append(row["thumbnail_key"])
                else:
                    raise

        reserved = int(upload_summary["reserved"] or 0)
        metadata_bytes = sum(expected.values()) + reserved
        object_bytes = sum(size for size, _ in actual.values())

        if self.settings.delete_orphans:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=self.settings.orphan_grace_hours)
            for bucket, key in list(actual):
                if (bucket, key) in expected:
                    continue
                last_modified = actual[(bucket, key)][1]
                if last_modified and last_modified <= cutoff:
                    self._remove_object(bucket, key)

        if self.settings.apply_usage and not missing:
            with db.cursor() as cursor:
                cursor.execute(
                    "UPDATE projects SET storage_used=%s WHERE id=%s",
                    (metadata_bytes, project_id),
                )
            db.commit()
            project["storage_used"] = metadata_bytes

        return {
            "project": project["slug"],
            "project_id": project_id,
            "recorded_bytes": int(project["storage_used"]),
            "quota_bytes": int(project["storage_quota"]),
            "metadata_bytes": metadata_bytes,
            "object_bytes": object_bytes,
            "usage_drift_bytes": int(project["storage_used"]) - metadata_bytes,
            "missing_objects": missing,
            "missing_thumbnails": missing_thumbnails,
            "orphan_objects": orphans,
            "stale_uploads": int(upload_summary["stale"] or 0),
            "expired_files": expired,
            "file_counts": file_counts,
        }

    @staticmethod
    def _publish(project: dict[str, Any], summary: dict[str, Any]) -> None:
        labels = (project["slug"], project["id"])
        used = int(summary["recorded_bytes"])
        quota = int(summary["quota_bytes"])
        PROJECT_STORAGE_USED.labels(*labels).set(used)
        PROJECT_STORAGE_QUOTA.labels(*labels).set(quota)
        PROJECT_QUOTA_RATIO.labels(*labels).set(used / quota if quota else 0)
        PROJECT_WARNING_RATIO.labels(*labels).set(int(project["warning_percent"]) / 100)
        PROJECT_METADATA_BYTES.labels(*labels).set(summary["metadata_bytes"])
        PROJECT_OBJECT_BYTES.labels(*labels).set(summary["object_bytes"])
        PROJECT_USAGE_DRIFT.labels(*labels).set(summary["usage_drift_bytes"])
        PROJECT_MISSING_OBJECTS.labels(*labels).set(
            len(summary["missing_objects"]) + len(summary["missing_thumbnails"])
        )
        PROJECT_ORPHAN_OBJECTS.labels(*labels).set(len(summary["orphan_objects"]))
        PROJECT_STALE_UPLOADS.labels(*labels).set(summary["stale_uploads"])
        PROJECT_EXPIRED_FILES.labels(*labels).set(summary["expired_files"])
        for status in ("AVAILABLE", "DELETED", "PENDING", "FAILED"):
            PROJECT_FILE_COUNT.labels(*labels, status).set(summary["file_counts"].get(status, 0))

    @staticmethod
    def _persist_status(db, project: dict[str, Any], summary: dict[str, Any]) -> None:
        missing_count = len(summary["missing_objects"]) + len(summary["missing_thumbnails"])
        quota_ratio = (
            summary["recorded_bytes"] / summary["quota_bytes"]
            if summary["quota_bytes"] else 0
        )
        if missing_count:
            health = "critical"
        elif any((
            summary["usage_drift_bytes"],
            summary["orphan_objects"],
            summary["stale_uploads"],
            summary["expired_files"],
            quota_ratio >= int(project["warning_percent"]) / 100,
        )):
            health = "warning"
        else:
            health = "healthy"
        summary["health_status"] = health
        details = {
            "missing_objects": summary["missing_objects"][:100],
            "missing_thumbnails": summary["missing_thumbnails"][:100],
            "orphan_objects": summary["orphan_objects"][:100],
            "maintenance": summary["maintenance"],
        }
        with db.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO project_operation_status (
                    project_id, health_status, metadata_bytes, object_bytes,
                    usage_drift_bytes, missing_objects, orphan_objects,
                    stale_uploads, expired_files, details_json, checked_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, UTC_TIMESTAMP())
                ON DUPLICATE KEY UPDATE
                    health_status=VALUES(health_status),
                    metadata_bytes=VALUES(metadata_bytes),
                    object_bytes=VALUES(object_bytes),
                    usage_drift_bytes=VALUES(usage_drift_bytes),
                    missing_objects=VALUES(missing_objects),
                    orphan_objects=VALUES(orphan_objects),
                    stale_uploads=VALUES(stale_uploads),
                    expired_files=VALUES(expired_files),
                    details_json=VALUES(details_json),
                    checked_at=VALUES(checked_at)
                """,
                (
                    project["id"], health, summary["metadata_bytes"], summary["object_bytes"],
                    summary["usage_drift_bytes"], missing_count, len(summary["orphan_objects"]),
                    summary["stale_uploads"], summary["expired_files"], json.dumps(details),
                ),
            )
        db.commit()

    def run_once(self) -> dict[str, Any]:
        self._reset_project_metrics()
        summaries = []
        errors = []
        with self.connect() as db:
            with db.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, slug, status, storage_used, storage_quota, warning_percent
                    FROM projects ORDER BY slug
                    """
                )
                projects = cursor.fetchall()
            for project in projects:
                try:
                    maintenance = {
                        "stale_uploads_cleaned": self._cleanup_stale_uploads(db, project),
                        **self._apply_retention(db, project),
                    }
                    summary = self._scan_project(db, project)
                    summary["maintenance"] = maintenance
                    self._persist_status(db, project, summary)
                    self._publish(project, summary)
                    summaries.append(summary)
                except Exception as exc:
                    db.rollback()
                    errors.append({"project": project["slug"], "error": str(exc)})
                    logger.exception("Project reconciliation failed for %s", project["slug"])
        OPERATIONS_CYCLE_ERRORS.set(len(errors))
        if not errors:
            OPERATIONS_LAST_SUCCESS.set(time.time())
        result = {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "mode": "apply" if any((
                self.settings.apply_stale_uploads,
                self.settings.apply_retention,
                self.settings.apply_usage,
                self.settings.delete_orphans,
            )) else "dry-run",
            "projects": summaries,
            "errors": errors,
        }
        logger.info("Reconciliation result: %s", json.dumps(result, default=str))
        return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CloudVault project operations controller")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    parser.add_argument("--apply", action="store_true", help="Apply stale-upload, retention, and usage repairs")
    parser.add_argument("--delete-orphans", action="store_true", help="Delete orphan objects older than the grace period")
    parser.add_argument("--json", action="store_true", help="Print the one-shot result as JSON")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    settings = Settings()
    if args.apply or args.delete_orphans:
        settings = Settings(
            **{
                **settings.__dict__,
                "apply_stale_uploads": settings.apply_stale_uploads or args.apply,
                "apply_retention": settings.apply_retention or args.apply,
                "apply_usage": settings.apply_usage or args.apply,
                "delete_orphans": settings.delete_orphans or args.delete_orphans,
            }
        )
    controller = ProjectOperations(settings)
    if args.once:
        result = controller.run_once()
        if args.json:
            print(json.dumps(result, indent=2, default=str))
        return 1 if result["errors"] else 0

    start_http_server(settings.metrics_port)
    logger.info(
        "Metrics listening on :%s; interval=%ss; mutation flags stale=%s retention=%s usage=%s orphans=%s",
        settings.metrics_port,
        settings.interval_seconds,
        settings.apply_stale_uploads,
        settings.apply_retention,
        settings.apply_usage,
        settings.delete_orphans,
    )
    while True:
        controller.run_once()
        time.sleep(settings.interval_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
