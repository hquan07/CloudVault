"""
CloudVault — Audit Logger Worker
Consumes file-events and user-events from Kafka and logs them to the audit_logs table.
"""

import asyncio
import json
import os
import uuid
import logging

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import text

from common.reliable_kafka import build_consumer, consume_reliably

logging.basicConfig(level=logging.INFO, format="%(asctime)s [AuditLogger] %(message)s")
logger = logging.getLogger(__name__)

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092")
TOPICS = [
    os.getenv("KAFKA_TOPIC_FILE_EVENTS", "file-events"),
    os.getenv("KAFKA_TOPIC_USER_EVENTS", "user-events"),
]

DB_USER = os.getenv("MYSQL_USER", "cloudvault")
DB_PASS = os.environ["MYSQL_PASSWORD"]
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
    "FILE_STARRED": "FILE_STARRED",
    "FILE_UNSTARRED": "FILE_UNSTARRED",
    "FILE_PERMANENTLY_DELETED": "FILE_PERMANENTLY_DELETED",
    "FOLDER_CREATED": "FOLDER_CREATED",
    "FOLDER_DELETED": "FOLDER_DELETED",
    "QUOTA_EXCEEDED": "QUOTA_EXCEEDED",
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
    "FILE_STARRED": "file",
    "FILE_UNSTARRED": "file",
    "FILE_PERMANENTLY_DELETED": "file",
    "FOLDER_CREATED": "folder",
    "FOLDER_DELETED": "folder",
    "QUOTA_EXCEEDED": "project",
    "USER_REGISTERED": "user",
    "USER_LOGGED_IN": "user",
    "USER_LOGGED_OUT": "user",
}


async def main():
    engine = create_async_engine(DB_URL, echo=False, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def handle_event(data: dict) -> None:
        event = data.get("event", "")
        action = EVENT_TO_ACTION.get(event)
        if not action:
            return

        resource_type = EVENT_TO_RESOURCE.get(event, "file")
        resource_id = (
            data.get("file_id")
            or data.get("folder_id")
            or data.get("project_id")
            or data.get("user_id")
        )
        user_id = data.get("user_id")
        event_id = data["event_id"]

        async with session_factory() as session:
            result = await session.execute(
                text("""
                    INSERT INTO audit_logs (
                        id, event_id, user_id, project_id, service_account_id,
                        action, resource_type, resource_id, details_json
                    )
                    VALUES (
                        :id, :event_id, :user_id, :project_id, :service_account_id,
                        :action, :resource_type, :resource_id, :details
                    )
                    ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)
                """),
                {
                    "id": str(uuid.uuid4()),
                    "event_id": event_id,
                    "user_id": user_id,
                    "project_id": data.get("project_id"),
                    "service_account_id": data.get("service_account_id"),
                    "action": action,
                    "resource_type": resource_type,
                    "resource_id": resource_id,
                    "details": json.dumps(data),
                },
            )
            await session.commit()
            if result.rowcount == 1:
                logger.info("Logged event %s: %s on %s", event_id, action, resource_id)
            else:
                logger.info("Skipped duplicate audit event %s", event_id)

    consumer = build_consumer(*TOPICS, group_id="audit-logger")
    try:
        await consume_reliably(
            consumer,
            handle_event,
            group_id="audit-logger",
            logger=logger,
        )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
