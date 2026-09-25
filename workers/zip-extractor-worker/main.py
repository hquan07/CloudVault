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

from aiokafka import AIOKafkaConsumer
from minio import Minio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ZipExtractor] %(message)s")
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC_FILE_EVENTS", "file-events")

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ROOT_USER", "cloudvault_admin")
MINIO_SECRET_KEY = os.getenv("MINIO_ROOT_PASSWORD", "cloudvault_minio_2026")
BUCKET_FILES = os.getenv("MINIO_BUCKET_FILES", "cloudvault-files")

DB_USER = os.getenv("MYSQL_USER", "cloudvault")
DB_PASS = os.getenv("MYSQL_PASSWORD", "cloudvault_pass")
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

    consumer = AIOKafkaConsumer(
        KAFKA_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id="zip-extractor",
        auto_offset_reset="earliest",
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
    )
    await consumer.start()
    logger.info("Listening for zip file events...")

    try:
        async for msg in consumer:
            data = msg.value
            event = data.get("event")
            if event != "FILE_UPLOADED":
                continue

            mime_type = data.get("mime_type", "")
            if mime_type not in ZIP_MIMES:
                continue

            file_id = data.get("file_id")
            minio_key = data.get("minio_key")
            user_id = data.get("user_id")
            if not file_id or not minio_key or not user_id:
                continue

            logger.info(f"Extracting zip: {file_id}")

            resp = None
            try:
                resp = minio_client.get_object(BUCKET_FILES, minio_key)
                zip_file = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024)
                while chunk := resp.read(1024 * 1024):
                    zip_file.write(chunk)
                zip_file.seek(0)
            except Exception as e:
                logger.error(f"Failed to fetch zip: {e}")
                continue
            finally:
                if resp is not None:
                    resp.close()
                    resp.release_conn()

            uploaded_keys = []
            try:
                with zipfile.ZipFile(zip_file) as zf:
                    entries = [info for info in zf.infolist() if not info.is_dir()]
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

                        for info in entries:
                            original_name = os.path.basename(info.filename)
                            if not original_name:
                                continue
                            extracted = zf.read(info)
                            new_id = str(uuid.uuid4())
                            new_key = f"{user_id}/{new_id}"
                            mime_type = mimetypes.guess_type(original_name)[0] or "application/octet-stream"
                            minio_client.put_object(
                                BUCKET_FILES,
                                new_key,
                                io.BytesIO(extracted),
                                length=len(extracted),
                                content_type=mime_type,
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
                                    "mime_type": mime_type,
                                    "size": len(extracted),
                                    "user_id": user_id,
                                    "bucket": BUCKET_FILES,
                                    "key": new_key,
                                },
                            )

                            logger.info(f"  Extracted: {info.filename} -> {new_id}")

                        await session.execute(
                            text(
                                "UPDATE users SET storage_used = storage_used + :size "
                                "WHERE id = :uid"
                            ),
                            {"size": total_size, "uid": user_id},
                        )
                        await session.commit()

            except zipfile.BadZipFile:
                logger.error(f"Invalid zip file: {file_id}")
            except Exception as e:
                logger.error(f"Extraction failed: {e}")
                for uploaded_key in uploaded_keys:
                    try:
                        minio_client.remove_object(BUCKET_FILES, uploaded_key)
                    except Exception:
                        logger.exception("Failed to clean up extracted object %s", uploaded_key)
            finally:
                zip_file.close()

    finally:
        await consumer.stop()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
