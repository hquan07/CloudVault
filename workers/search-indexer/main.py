"""
CloudVault — Search Indexer Worker
Consumes file-events from Kafka and indexes file metadata into Elasticsearch.
"""

import asyncio
import json
import os
import logging
import io

from aiokafka import AIOKafkaConsumer
from elasticsearch import AsyncElasticsearch
from minio import Minio
import redis.asyncio as aioredis

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
                        "folder_id": {"type": "keyword"},
                        "size": {"type": "long"},
                        "is_deleted": {"type": "boolean"},
                        "created_at": {"type": "date"},
                        "updated_at": {"type": "date"},
                    }
                },
            },
        )
        logger.info(f"Created ES index: {ES_INDEX}")


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

    consumer = AIOKafkaConsumer(
        KAFKA_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id="search-indexer",
        auto_offset_reset="earliest",
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
    )
    await consumer.start()
    logger.info(f"Consuming from {KAFKA_TOPIC}...")

    try:
        async for msg in consumer:
            data = msg.value
            event = data.get("event")
            file_id = data.get("file_id")

            if not file_id:
                continue

            if event == "FILE_UPLOADED":
                doc = {
                    "filename": data.get("filename", ""),
                    "original_name": data.get("filename", ""),
                    "mime_type": data.get("mime_type", ""),
                    "user_id": data.get("user_id", ""),
                    "size": data.get("size", 0),
                    "is_deleted": False,
                    "created_at": data.get("created_at"),
                }
                
                mime_type = doc["mime_type"]
                content = ""
                minio_key = data.get("minio_key")
                
                if minio_key and mime_type in ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"]:
                    try:
                        logger.info(f"Extracting content from {minio_key}")
                        resp = minio_client.get_object(BUCKET_FILES, minio_key)
                        file_data = resp.read()
                        resp.close()
                        content = extract_text(file_data, mime_type)
                    except Exception as e:
                        logger.error(f"Content extraction failed: {e}")
                
                doc["content"] = content
                
                await es.index(index=ES_INDEX, id=file_id, document=doc)
                logger.info(f"Indexed {file_id}: {doc['filename']}")
                
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
                    except Exception as e:
                        logger.error(f"Failed to publish to redis: {e}")
                
            elif event == "FILE_RESTORED":
                try:
                    await es.update(
                        index=ES_INDEX, id=file_id,
                        body={"doc": {"is_deleted": False}},
                    )
                    logger.info(f"Marked restored: {file_id}")
                except Exception:
                    pass

            elif event == "FILE_DELETED":
                try:
                    await es.update(
                        index=ES_INDEX, id=file_id,
                        body={"doc": {"is_deleted": True}},
                    )
                    logger.info(f"Marked deleted: {file_id}")
                except Exception:
                    pass

    finally:
        await consumer.stop()
        await es.close()
        await redis_client.close()


if __name__ == "__main__":
    asyncio.run(main())
