"""
CloudVault — Thumbnail Worker
Consumes FILE_UPLOADED events, generates thumbnails for image files, 
uploads them to MinIO thumbnails bucket, and updates the file record.
"""

import asyncio
import io
import json
import os
import logging
import subprocess
import tempfile

from minio import Minio
from PIL import Image
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text
import redis.asyncio as aioredis

from common.reliable_kafka import build_consumer, consume_reliably

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ThumbnailWorker] %(message)s")
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC_FILE_EVENTS", "file-events")

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ROOT_USER", "cloudvault_admin")
MINIO_SECRET_KEY = os.environ["MINIO_ROOT_PASSWORD"]
BUCKET_FILES = os.getenv("MINIO_BUCKET_FILES", "cloudvault-files")
BUCKET_THUMBNAILS = os.getenv("MINIO_BUCKET_THUMBNAILS", "cloudvault-thumbnails")

REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PASSWORD = os.environ["REDIS_PASSWORD"]
REDIS_URL = f"redis://:{REDIS_PASSWORD}@{REDIS_HOST}:6379/0"

DB_USER = os.getenv("MYSQL_USER", "cloudvault")
DB_PASS = os.environ["MYSQL_PASSWORD"]
DB_HOST = os.getenv("MYSQL_HOST", "mysql")
DB_PORT = os.getenv("MYSQL_PORT", "3306")
DB_NAME = os.getenv("MYSQL_DATABASE", "cloudvault")
DB_URL = f"mysql+asyncmy://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

THUMBNAIL_SIZE = (300, 300)
IMAGE_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"}
VIDEO_MIMES = {"video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-msvideo", "video/x-matroska"}

def generate_video_thumbnail(video_data: bytes) -> bytes | None:
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as temp_video:
            temp_video.write(video_data)
            temp_video_path = temp_video.name
            
        temp_thumb_path = temp_video_path + ".jpg"
        
        # Run ffmpeg to extract a frame at 1 second (or fallback to frame 1)
        cmd = [
            "ffmpeg", "-y", "-i", temp_video_path,
            "-ss", "00:00:01.000", "-vframes", "1",
            "-vf", f"scale={THUMBNAIL_SIZE[0]}:{THUMBNAIL_SIZE[1]}:force_original_aspect_ratio=decrease",
            "-q:v", "2",
            temp_thumb_path
        ]
        
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # If it failed to extract at 1s (e.g. video is too short), try without -ss
        if result.returncode != 0 or not os.path.exists(temp_thumb_path):
            cmd_fallback = [
                "ffmpeg", "-y", "-i", temp_video_path,
                "-vframes", "1",
                "-vf", f"scale={THUMBNAIL_SIZE[0]}:{THUMBNAIL_SIZE[1]}:force_original_aspect_ratio=decrease",
                "-q:v", "2",
                temp_thumb_path
            ]
            subprocess.run(cmd_fallback, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        
        with open(temp_thumb_path, "rb") as f:
            thumb_data = f.read()
            
        os.remove(temp_video_path)
        os.remove(temp_thumb_path)
        
        return thumb_data
    except Exception as e:
        logger.error(f"Video thumbnail generation failed: {e}")
        if 'temp_video_path' in locals() and os.path.exists(temp_video_path):
            os.remove(temp_video_path)
        if 'temp_thumb_path' in locals() and os.path.exists(temp_thumb_path):
            os.remove(temp_thumb_path)
        return None


def generate_thumbnail(image_data: bytes) -> bytes | None:
    try:
        img = Image.open(io.BytesIO(image_data))
        img.thumbnail(THUMBNAIL_SIZE, Image.LANCZOS)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85, optimize=True)
        return buf.getvalue()
    except Exception as e:
        logger.error(f"Thumbnail generation failed: {e}")
        return None


async def main():
    minio_client = Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False,
    )

    engine = create_async_engine(DB_URL, echo=False, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    
    redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)

    def read_object(object_key: str) -> bytes:
        response = minio_client.get_object(BUCKET_FILES, object_key)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    def put_thumbnail(object_key: str, thumbnail: bytes) -> None:
        minio_client.put_object(
            BUCKET_THUMBNAILS,
            object_key,
            io.BytesIO(thumbnail),
            length=len(thumbnail),
            content_type="image/jpeg",
        )

    async def handle_event(data: dict) -> None:
        if data.get("event") != "FILE_UPLOADED":
            return

        mime_type = data.get("mime_type", "")
        if mime_type not in IMAGE_MIMES and mime_type not in VIDEO_MIMES:
            return

        file_id = data.get("file_id")
        minio_key = data.get("minio_key")
        if not file_id or not minio_key:
            raise ValueError("FILE_UPLOADED event is missing file_id or minio_key")

        logger.info("Generating thumbnail for %s", file_id)
        file_data = await asyncio.to_thread(read_object, minio_key)
        generator = generate_video_thumbnail if mime_type in VIDEO_MIMES else generate_thumbnail
        thumb_data = await asyncio.to_thread(generator, file_data)
        if not thumb_data:
            raise ValueError(f"Thumbnail generation returned no data for {file_id}")

        thumb_key = f"thumb_{file_id}.jpg"
        await asyncio.to_thread(put_thumbnail, thumb_key, thumb_data)

        async with session_factory() as session:
            await session.execute(
                text("UPDATE files SET thumbnail_key = :key WHERE id = :fid"),
                {"key": thumb_key, "fid": file_id},
            )
            await session.commit()

        logger.info("Thumbnail created: %s", thumb_key)
        user_id = data.get("user_id")
        if user_id:
            try:
                await redis_client.publish(
                    f"notifications:{user_id}",
                    json.dumps({
                        "type": "THUMBNAIL_READY",
                        "file_id": file_id,
                        "message": f"Ảnh bìa cho {data.get('filename', 'video')} đã sẵn sàng!"
                    })
                )
            except Exception:
                logger.exception("Failed to publish thumbnail notification")

    consumer = build_consumer(KAFKA_TOPIC, group_id="thumbnail-worker")
    try:
        await consume_reliably(
            consumer,
            handle_event,
            group_id="thumbnail-worker",
            logger=logger,
        )
    finally:
        await engine.dispose()
        await redis_client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
