"""
CloudVault — Audit Logger Worker
Consumes file-events and user-events from Kafka and logs them to the audit_logs table.
"""

import asyncio
import json
import os
import uuid
import logging

from aiokafka import AIOKafkaConsumer
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text

logging.basicConfig(level=logging.INFO, format="%(asctime)s [AuditLogger] %(message)s")
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092")
TOPICS = [
    os.getenv("KAFKA_TOPIC_FILE_EVENTS", "file-events"),
    os.getenv("KAFKA_TOPIC_USER_EVENTS", "user-events"),
]

DB_USER = os.getenv("MYSQL_USER", "cloudvault")
DB_PASS = os.getenv("MYSQL_PASSWORD", "cloudvault_pass")
DB_HOST = os.getenv("MYSQL_HOST", "mysql")
DB_PORT = os.getenv("MYSQL_PORT", "3306")
DB_NAME = os.getenv("MYSQL_DATABASE", "cloudvault")
DB_URL = f"mysql+asyncmy://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

EVENT_TO_ACTION = {
    "FILE_UPLOADED": "FILE_UPLOADED",
    "FILE_DOWNLOADED": "FILE_DOWNLOADED",
    "FILE_DELETED": "FILE_DELETED",
    "FILE_RESTORED": "FILE_RESTORED",
    "FILE_MOVED": "FILE_MOVED",
    "FILE_COPIED": "FILE_COPIED",
    "USER_REGISTERED": "USER_REGISTERED",
    "USER_LOGGED_IN": "USER_LOGGED_IN",
    "USER_LOGGED_OUT": "USER_LOGGED_OUT",
}

EVENT_TO_RESOURCE = {
    "FILE_UPLOADED": "file",
    "FILE_DOWNLOADED": "file",
    "FILE_DELETED": "file",
    "FILE_RESTORED": "file",
    "FILE_MOVED": "file",
    "FILE_COPIED": "file",
    "USER_REGISTERED": "user",
    "USER_LOGGED_IN": "user",
    "USER_LOGGED_OUT": "user",
}


async def main():
    engine = create_async_engine(DB_URL, echo=False, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    consumer = AIOKafkaConsumer(
        *TOPICS,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id="audit-logger",
        auto_offset_reset="earliest",
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
    )
    await consumer.start()
    logger.info(f"Consuming from {TOPICS}...")

    try:
        async for msg in consumer:
            data = msg.value
            event = data.get("event", "")
            action = EVENT_TO_ACTION.get(event)
            if not action:
                continue

            resource_type = EVENT_TO_RESOURCE.get(event, "file")
            resource_id = data.get("file_id") or data.get("user_id")
            user_id = data.get("user_id")

            async with session_factory() as session:
                await session.execute(
                    text("""
                        INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, details_json)
                        VALUES (:id, :user_id, :action, :resource_type, :resource_id, :details)
                    """),
                    {
                        "id": str(uuid.uuid4()),
                        "user_id": user_id,
                        "action": action,
                        "resource_type": resource_type,
                        "resource_id": resource_id,
                        "details": json.dumps(data),
                    },
                )
                await session.commit()
                logger.info(f"Logged: {action} by {user_id} on {resource_id}")

    finally:
        await consumer.stop()
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
