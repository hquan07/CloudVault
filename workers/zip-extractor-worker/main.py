"""
CloudVault — Zip Extractor Worker
Consumes FILE_UPLOADED events for .zip files, extracts them,
and uploads individual files back to MinIO.
"""

import asyncio
import io
import json
import mimetypes
import os
import tempfile
import uuid
import zipfile
import logging

from minio import Minio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text

from common.reliable_kafka import build_consumer, consume_reliably

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ZipExtractor] %(message)s")
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC_FILE_EVENTS", "file-events")

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ROOT_USER", "cloudvault_admin")
MINIO_SECRET_KEY = os.environ["MINIO_ROOT_PASSWORD"]
BUCKET_FILES = os.getenv("MINIO_BUCKET_FILES", "cloudvault-files")

DB_USER = os.getenv("MYSQL_USER", "cloudvault")
DB_PASS = os.environ["MYSQL_PASSWORD"]
DB_HOST = os.getenv("MYSQL_HOST", "mysql")
DB_PORT = os.getenv("MYSQL_PORT", "3306")
DB_NAME = os.getenv("MYSQL_DATABASE", "cloudvault")
DB_URL = f"mysql+asyncmy://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

ZIP_MIMES = {"application/zip", "application/x-zip-compressed"}
MAX_ZIP_ENTRIES = int(os.getenv("MAX_ZIP_ENTRIES", "1000"))
MAX_ZIP_UNCOMPRESSED_BYTES = int(
    os.getenv("MAX_ZIP_UNCOMPRESSED_BYTES", str(500 * 1024 * 1024))
)
MAX_ZIP_COMPRESSION_RATIO = int(os.getenv("MAX_ZIP_COMPRESSION_RATIO", "200"))


async def main():
    minio_client = Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False,
    )

    engine = create_async_engine(DB_URL, echo=False, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    def download_zip(object_key: str):
        response = minio_client.get_object(BUCKET_FILES, object_key)
        archive = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024)
        try:
            while chunk := response.read(1024 * 1024):
                archive.write(chunk)
            archive.seek(0)
            return archive
        except Exception:
            archive.close()
            raise
        finally:
            response.close()
            response.release_conn()

    def put_object(object_key: str, contents: bytes, content_type: str) -> None:
        minio_client.put_object(
            BUCKET_FILES,
            object_key,
            io.BytesIO(contents),
            length=len(contents),
            content_type=content_type,
        )

    async def already_processed(event_id: str) -> bool:
        async with session_factory() as session:
            result = await session.execute(
                text(
                    "SELECT 1 FROM worker_processed_events "
                    "WHERE consumer_group = 'zip-extractor' AND event_id = :event_id"
                ),
                {"event_id": event_id},
            )
            return result.first() is not None

    async def handle_event(data: dict) -> None:
        if data.get("event") != "FILE_UPLOADED":
            return
        if data.get("mime_type", "") not in ZIP_MIMES:
            return
        # Project archives are stored as project artifacts; extraction currently
        # belongs only to the personal-file workflow and its user quota.
        if data.get("project_id"):
            return

        file_id = data.get("file_id")
        minio_key = data.get("minio_key")
        user_id = data.get("user_id")
        event_id = data["event_id"]
        if not file_id or not minio_key or not user_id:
            raise ValueError("ZIP upload event is missing file_id, minio_key, or user_id")
        if await already_processed(event_id):
            logger.info("Skipped duplicate ZIP event %s", event_id)
            return

        logger.info("Extracting zip %s for event %s", file_id, event_id)
        zip_file = await asyncio.to_thread(download_zip, minio_key)
        uploaded_keys: list[str] = []
        try:
            with zipfile.ZipFile(zip_file) as archive:
                entries = [info for info in archive.infolist() if not info.is_dir()]
                if len(entries) > MAX_ZIP_ENTRIES:
                    raise ValueError(f"ZIP contains too many files ({len(entries)})")

                total_size = sum(info.file_size for info in entries)
                if total_size > MAX_ZIP_UNCOMPRESSED_BYTES:
                    raise ValueError(f"ZIP expands beyond limit ({total_size} bytes)")

                for info in entries:
                    if info.flag_bits & 0x1:
                        raise ValueError("Encrypted ZIP entries are not supported")
                    compressed_size = max(info.compress_size, 1)
                    if (
                        info.file_size > 10 * 1024 * 1024
                        and info.file_size / compressed_size > MAX_ZIP_COMPRESSION_RATIO
                    ):
                        raise ValueError(f"Suspicious compression ratio: {info.filename}")

                async with session_factory() as session:
                    processed = await session.execute(
                        text(
                            "SELECT 1 FROM worker_processed_events "
                            "WHERE consumer_group = 'zip-extractor' "
                            "AND event_id = :event_id FOR UPDATE"
                        ),
                        {"event_id": event_id},
                    )
                    if processed.first() is not None:
                        return

                    quota_result = await session.execute(
                        text(
                            "SELECT storage_used, storage_quota FROM users "
                            "WHERE id = :uid FOR UPDATE"
                        ),
                        {"uid": user_id},
                    )
                    quota = quota_result.first()
                    if not quota:
                        raise ValueError("ZIP owner no longer exists")
                    if quota.storage_used + total_size > quota.storage_quota:
                        raise ValueError("Extracted files would exceed storage quota")

                    namespace = uuid.UUID(event_id)
                    for info in entries:
                        original_name = os.path.basename(info.filename)
                        if not original_name:
                            continue
                        extracted = await asyncio.to_thread(archive.read, info)
                        new_id = str(uuid.uuid5(namespace, info.filename))
                        new_key = f"{user_id}/{new_id}"
                        content_type = (
                            mimetypes.guess_type(original_name)[0]
                            or "application/octet-stream"
                        )
                        await asyncio.to_thread(
                            put_object, new_key, extracted, content_type
                        )
                        uploaded_keys.append(new_key)

                        await session.execute(
                            text("""
                                INSERT INTO files (id, filename, original_name, mime_type, size,
                                    user_id, minio_bucket, minio_key)
                                VALUES (:id, :filename, :original_name, :mime_type, :size,
                                    :user_id, :bucket, :key)
                            """),
                            {
                                "id": new_id,
                                "filename": new_id,
                                "original_name": original_name,
                                "mime_type": content_type,
                                "size": len(extracted),
                                "user_id": user_id,
                                "bucket": BUCKET_FILES,
                                "key": new_key,
                            },
                        )
                        logger.info("Extracted %s -> %s", info.filename, new_id)

                    await session.execute(
                        text(
                            "UPDATE users SET storage_used = storage_used + :size "
                            "WHERE id = :uid"
                        ),
                        {"size": total_size, "uid": user_id},
                    )
                    await session.execute(
                        text(
                            "INSERT INTO worker_processed_events "
                            "(consumer_group, event_id) VALUES ('zip-extractor', :event_id)"
                        ),
                        {"event_id": event_id},
                    )
                    await session.commit()
        except Exception:
            for uploaded_key in uploaded_keys:
                try:
                    await asyncio.to_thread(
                        minio_client.remove_object, BUCKET_FILES, uploaded_key
                    )
                except Exception:
                    logger.exception("Failed to clean up extracted object %s", uploaded_key)
            raise
        finally:
            zip_file.close()

    consumer = build_consumer(KAFKA_TOPIC, group_id="zip-extractor")
    try:
        await consume_reliably(
            consumer,
            handle_event,
            group_id="zip-extractor",
            logger=logger,
        )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
