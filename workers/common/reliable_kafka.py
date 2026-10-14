"""Reliable Kafka consumption with bounded retry and dead-letter delivery."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import socket
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.structs import TopicPartition

EventHandler = Callable[[dict[str, Any]], Awaitable[None]]


def _decode_event(value: bytes) -> dict[str, Any]:
    payload = json.loads(value.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Kafka event must be a JSON object")
    return payload


def _encode_event(value: dict[str, Any]) -> bytes:
    return json.dumps(value, default=str).encode("utf-8")


def build_consumer(*topics: str, group_id: str) -> AIOKafkaConsumer:
    """Create a consumer that commits only after the handler succeeds or DLQs."""
    return AIOKafkaConsumer(
        *topics,
        bootstrap_servers=os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092"),
        group_id=group_id,
        client_id=f"{group_id}-{socket.gethostname()}",
        auto_offset_reset="earliest",
        enable_auto_commit=False,
        max_poll_records=1,
        max_poll_interval_ms=int(os.getenv("KAFKA_MAX_POLL_INTERVAL_MS", "900000")),
    )


def build_dead_letter_producer(group_id: str) -> AIOKafkaProducer:
    return AIOKafkaProducer(
        bootstrap_servers=os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:29092"),
        client_id=f"{group_id}-dlq-{socket.gethostname()}",
        acks="all",
        enable_idempotence=True,
        key_serializer=lambda value: value.encode("utf-8"),
        value_serializer=_encode_event,
    )


def stable_event_id(topic: str, partition: int, offset: int, payload: dict[str, Any]) -> str:
    """Use producer ID when available and a stable Kafka-position ID otherwise."""
    event_id = payload.get("event_id")
    if event_id:
        return str(event_id)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"kafka:{topic}:{partition}:{offset}"))


async def consume_reliably(
    consumer: AIOKafkaConsumer,
    handler: EventHandler,
    *,
    group_id: str,
    logger: logging.Logger,
) -> None:
    """Retry one record, DLQ poison events, then commit the exact next offset."""
    dead_letter_topic = os.getenv("KAFKA_TOPIC_DEAD_LETTER", "dead-letter-events")
    max_retries = max(1, int(os.getenv("KAFKA_CONSUMER_MAX_RETRIES", "3")))
    backoff = max(0.0, float(os.getenv("KAFKA_CONSUMER_RETRY_BACKOFF_SECONDS", "2")))
    dlq = build_dead_letter_producer(group_id)

    await consumer.start()
    try:
        await dlq.start()
        logger.info("Consumer %s started for %s", group_id, consumer.subscription())
        async for message in consumer:
            decode_error: Exception | None = None
            try:
                payload = _decode_event(message.value)
            except Exception as error:  # noqa: BLE001 - untrusted event payload
                decode_error = error
                payload = {
                    "malformed_payload_base64": base64.b64encode(message.value).decode("ascii")
                }
            event_id = stable_event_id(
                message.topic, message.partition, message.offset, payload
            )
            payload.setdefault("event_id", event_id)
            last_error: Exception | None = decode_error

            if decode_error is None:
                for attempt in range(1, max_retries + 1):
                    try:
                        await handler(payload)
                        last_error = None
                        break
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:  # noqa: BLE001 - worker boundary
                        last_error = error
                        logger.exception(
                            "Event %s failed on attempt %s/%s",
                            event_id,
                            attempt,
                            max_retries,
                        )
                        if attempt < max_retries and backoff:
                            await asyncio.sleep(backoff * attempt)
            else:
                logger.error("Malformed Kafka event %s: %s", event_id, decode_error)

            if last_error is not None:
                dead_letter = {
                    "event_id": event_id,
                    "event_version": 1,
                    "event": "DEAD_LETTERED",
                    "failed_consumer_group": group_id,
                    "source_topic": message.topic,
                    "source_partition": message.partition,
                    "source_offset": message.offset,
                    "failed_at": datetime.now(timezone.utc).isoformat(),
                    "error_type": type(last_error).__name__,
                    "error": str(last_error)[:2000],
                    "original_event": payload,
                }
                await dlq.send_and_wait(dead_letter_topic, dead_letter, key=event_id)
                logger.error("Event %s moved to %s", event_id, dead_letter_topic)

            await consumer.commit(
                {TopicPartition(message.topic, message.partition): message.offset + 1}
            )
    finally:
        await consumer.stop()
        await dlq.stop()
