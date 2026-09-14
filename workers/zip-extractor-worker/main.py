"""
CloudVault — Zip Extractor Worker
Consumes FILE_UPLOADED events for .zip files, extracts them,
and uploads individual files back to MinIO.
"""

import asyncio
import io
import json
import os
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

            try:
                resp = minio_client.get_object(BUCKET_FILES, minio_key)
                zip_data = resp.read()
                resp.close()
            except Exception as e:
                logger.error(f"Failed to fetch zip: {e}")
                continue

            try:
                with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
                    for info in zf.infolist():
                        if info.is_dir():
                            continue
                        extracted = zf.read(info.filename)
                        new_id = str(uuid.uuid4())
                        new_key = f"{user_id}/{new_id}"
                        minio_client.put_object(
                            BUCKET_FILES,
                            new_key,
                            io.BytesIO(extracted),
                            length=len(extracted),
                        )

                        async with session_factory() as session:
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
                                    "original_name": os.path.basename(info.filename),
                                    "mime_type": "application/octet-stream",
                                    "size": len(extracted),
                                    "user_id": user_id,
                                    "bucket": BUCKET_FILES,
                                    "key": new_key,
                                },
                            )
                            await session.commit()

                        logger.info(f"  Extracted: {info.filename} -> {new_id}")

            except zipfile.BadZipFile:
                logger.error(f"Invalid zip file: {file_id}")
            except Exception as e:
                logger.error(f"Extraction failed: {e}")

    finally:
        await consumer.stop()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
