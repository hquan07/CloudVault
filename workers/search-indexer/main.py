"""
CloudVault — Search Indexer Worker
Consumes file-events from Kafka and indexes file metadata into Elasticsearch.
"""

import asyncio
import json
import os
import logging
import io

import asyncmy
from elasticsearch import AsyncElasticsearch
from elasticsearch.helpers import async_bulk
from minio import Minio
import redis.asyncio as aioredis

from common.reliable_kafka import build_consumer, consume_reliably

logging.basicConfig(level=logging.INFO, format="%(asctime)s [SearchIndexer] %(message)s")
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC_FILE_EVENTS", "file-events")
ES_URL = os.getenv("ELASTICSEARCH_URL", "http://elasticsearch:9200")
ES_USERNAME = os.getenv("ELASTICSEARCH_USERNAME", "cloudvault_app")
ES_PASSWORD = os.environ["ELASTICSEARCH_APP_PASSWORD"]
ES_INDEX = "cloudvault-files"

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ROOT_USER", "cloudvault_admin")
MINIO_SECRET_KEY = os.environ["MINIO_ROOT_PASSWORD"]
BUCKET_FILES = os.getenv("MINIO_BUCKET_FILES", "cloudvault-files")

REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PASSWORD = os.environ["REDIS_PASSWORD"]
REDIS_URL = f"redis://:{REDIS_PASSWORD}@{REDIS_HOST}:6379/0"

MYSQL_HOST = os.getenv("MYSQL_HOST", "mysql")
MYSQL_PORT = int(os.getenv("MYSQL_PORT", "3306"))
MYSQL_DATABASE = os.getenv("MYSQL_DATABASE", "cloudvault")
MYSQL_USER = os.getenv("MYSQL_USER", "cloudvault")
MYSQL_PASSWORD = os.environ["MYSQL_PASSWORD"]

def extract_text(file_data: bytes, mime_type: str) -> str:
    text = ""
    try:
        if mime_type == "application/pdf":
            import fitz
            doc = fitz.open(stream=file_data, filetype="pdf")
            for page in doc:
                text += page.get_text() + "\n"
        elif mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            import docx
            doc = docx.Document(io.BytesIO(file_data))
            text = "\n".join([p.text for p in doc.paragraphs])
        elif mime_type == "text/plain":
            text = file_data.decode("utf-8", errors="ignore")
    except Exception as e:
        logger.error(f"Failed to extract text for {mime_type}: {e}")
    
    return text[:100000] # Limit to 100k chars to avoid huge payloads


async def ensure_index(es: AsyncElasticsearch):
    if not await es.indices.exists(index=ES_INDEX):
        try:
            await es.indices.create(
                index=ES_INDEX,
                body={
                "settings": {
                    "analysis": {
                        "analyzer": {
                            "edge_ngram_analyzer": {
                                "type": "custom",
                                "tokenizer": "edge_ngram_tokenizer",
                                "filter": ["lowercase"],
                            },
                            "search_analyzer": {
                                "type": "custom",
                                "tokenizer": "standard",
                                "filter": ["lowercase"],
                            },
                        },
                        "tokenizer": {
                            "edge_ngram_tokenizer": {
                                "type": "edge_ngram",
                                "min_gram": 2,
                                "max_gram": 20,
                                "token_chars": ["letter", "digit"],
                            }
                        },
                    }
                },
                "mappings": {
                    "properties": {
                        "filename": {"type": "text", "analyzer": "edge_ngram_analyzer", "search_analyzer": "search_analyzer"},
                        "original_name": {"type": "text", "analyzer": "edge_ngram_analyzer", "search_analyzer": "search_analyzer"},
                        "content": {"type": "text", "analyzer": "standard"},
                        "mime_type": {"type": "keyword"},
                        "user_id": {"type": "keyword"},
                        "project_id": {"type": "keyword"},
                        "folder_id": {"type": "keyword"},
                        "size": {"type": "long"},
                        "is_deleted": {"type": "boolean"},
                        "created_at": {"type": "date"},
                        "updated_at": {"type": "date"},
                    }
                },
                },
            )
            logger.info("Created ES index: %s", ES_INDEX)
        except Exception:
            # Multiple scaled replicas may race on first startup. Only suppress
            # the loser when the index now exists.
            if not await es.indices.exists(index=ES_INDEX):
                raise
    else:
        await es.indices.put_mapping(
            index=ES_INDEX,
            properties={"project_id": {"type": "keyword"}},
        )


async def backfill_project_scope(es: AsyncElasticsearch):
    """Attach project scope to documents indexed before project-aware search."""
    connection = await asyncmy.connect(
        host=MYSQL_HOST,
        port=MYSQL_PORT,
        user=MYSQL_USER,
        password=MYSQL_PASSWORD,
        database=MYSQL_DATABASE,
    )
    updated = 0
    try:
        async with connection.cursor() as cursor:
            await cursor.execute("SELECT id, project_id FROM files WHERE project_id IS NOT NULL")
            while rows := await cursor.fetchmany(500):
                actions = [
                    {
                        "_op_type": "update",
                        "_index": ES_INDEX,
                        "_id": file_id,
                        "doc": {"project_id": project_id},
                    }
                    for file_id, project_id in rows
                ]
                succeeded, _ = await async_bulk(
                    es,
                    actions,
                    raise_on_error=False,
                    raise_on_exception=False,
                )
                updated += succeeded
    finally:
        connection.close()
    logger.info("Backfilled project scope on %s existing search documents", updated)


async def main():
    minio_client = Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False,
    )
    
    redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
    
    es = AsyncElasticsearch(ES_URL, basic_auth=(ES_USERNAME, ES_PASSWORD))
    await ensure_index(es)
    backfill_lock = redis_client.lock(
        "search-indexer:project-scope-backfill:v1", timeout=600
    )
    if await backfill_lock.acquire(blocking=False):
        try:
            await backfill_project_scope(es)
        except Exception as error:
            logger.warning("Project scope backfill skipped: %s", error)
        finally:
            try:
                await backfill_lock.release()
            except Exception:
                logger.warning("Search backfill lock expired before release")
    else:
        logger.info("Another search-indexer replica owns the project-scope backfill")

    def read_object(object_key: str) -> bytes:
        response = minio_client.get_object(BUCKET_FILES, object_key)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    async def handle_event(data: dict) -> None:
        event = data.get("event")
        if event not in {"FILE_UPLOADED", "FILE_RESTORED", "FILE_DELETED"}:
            return

        file_id = data.get("file_id")
        if not file_id:
            raise ValueError(f"{event} event is missing file_id")

        if event == "FILE_UPLOADED":
            doc = {
                "filename": data.get("filename", ""),
                "original_name": data.get("filename", ""),
                "mime_type": data.get("mime_type", ""),
                "user_id": data.get("user_id", ""),
                "project_id": data.get("project_id"),
                "size": data.get("size", 0),
                "is_deleted": False,
                "created_at": data.get("created_at"),
            }

            mime_type = doc["mime_type"]
            content = ""
            minio_key = data.get("minio_key")
            extractable = {
                "application/pdf",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "text/plain",
            }
            if minio_key and mime_type in extractable:
                try:
                    logger.info("Extracting content from %s", minio_key)
                    file_data = await asyncio.to_thread(read_object, minio_key)
                    content = await asyncio.to_thread(extract_text, file_data, mime_type)
                except Exception:
                    logger.exception("Content extraction failed; indexing metadata only")

            doc["content"] = content
            await es.index(index=ES_INDEX, id=file_id, document=doc)
            logger.info("Indexed %s: %s", file_id, doc["filename"])

            user_id = data.get("user_id")
            if user_id:
                try:
                    await redis_client.publish(
                        f"notifications:{user_id}",
                        json.dumps({
                            "type": "INDEX_READY",
                            "file_id": file_id,
                            "message": f"Tệp tin {doc['filename']} đã được lập chỉ mục tìm kiếm!"
                        })
                    )
                except Exception:
                    logger.exception("Failed to publish index notification")
            return

        is_deleted = event == "FILE_DELETED"
        await es.update(
            index=ES_INDEX,
            id=file_id,
            body={
                "doc": {"is_deleted": is_deleted},
                "doc_as_upsert": True,
            },
        )
        logger.info("Marked %s: %s", "deleted" if is_deleted else "restored", file_id)

    consumer = build_consumer(KAFKA_TOPIC, group_id="search-indexer")
    try:
        await consume_reliably(
            consumer,
            handle_event,
            group_id="search-indexer",
            logger=logger,
        )
    finally:
        await es.close()
        await redis_client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
