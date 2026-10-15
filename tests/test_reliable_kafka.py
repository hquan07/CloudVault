import logging
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from workers.common.reliable_kafka import consume_reliably, stable_event_id


class FakeConsumer:
    def __init__(self, messages):
        self.messages = messages
        self.commits = []
        self.started = False
        self.stopped = False

    async def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True

    def subscription(self):
        return {"file-events"}

    def __aiter__(self):
        async def iterate():
            for message in self.messages:
                yield message

        return iterate()

    async def commit(self, offsets):
        self.commits.append(offsets)


class FakeProducer:
    def __init__(self):
        self.messages = []
        self.started = False
        self.stopped = False

    async def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True

    async def send_and_wait(self, topic, value, key):
        self.messages.append((topic, value, key))


def message(value, offset=4):
    return SimpleNamespace(
        topic="file-events",
        partition=1,
        offset=offset,
        value=value,
    )


class ReliableKafkaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        os.environ["KAFKA_CONSUMER_MAX_RETRIES"] = "3"
        os.environ["KAFKA_CONSUMER_RETRY_BACKOFF_SECONDS"] = "0"
        self.logger = logging.getLogger("reliable-kafka-test")

    def test_stable_event_id(self):
        self.assertEqual(
            stable_event_id("topic", 0, 1, {"event_id": "provided"}),
            "provided",
        )
        self.assertEqual(
            stable_event_id("topic", 0, 1, {}),
            stable_event_id("topic", 0, 1, {}),
        )

    async def test_retries_then_commits(self):
        consumer = FakeConsumer([message(b'{"event":"FILE_UPLOADED"}')])
        producer = FakeProducer()
        attempts = 0

        async def handler(payload):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise RuntimeError("temporary")
            self.assertIn("event_id", payload)

        with patch(
            "workers.common.reliable_kafka.build_dead_letter_producer",
            return_value=producer,
        ):
            await consume_reliably(
                consumer,
                handler,
                group_id="test-worker",
                logger=self.logger,
            )

        self.assertEqual(attempts, 3)
        self.assertEqual(producer.messages, [])
        self.assertEqual(len(consumer.commits), 1)
        self.assertTrue(consumer.stopped)
        self.assertTrue(producer.stopped)

    async def test_dead_letters_after_retry_limit(self):
        consumer = FakeConsumer([message(b'{"event":"FILE_UPLOADED"}')])
        producer = FakeProducer()

        async def handler(_payload):
            raise ValueError("poison")

        with patch(
            "workers.common.reliable_kafka.build_dead_letter_producer",
            return_value=producer,
        ):
            await consume_reliably(
                consumer,
                handler,
                group_id="test-worker",
                logger=self.logger,
            )

        self.assertEqual(len(producer.messages), 1)
        topic, payload, event_id = producer.messages[0]
        self.assertEqual(topic, "dead-letter-events")
        self.assertEqual(payload["error_type"], "ValueError")
        self.assertEqual(payload["event_id"], event_id)
        self.assertEqual(len(consumer.commits), 1)

    async def test_malformed_json_is_dead_lettered_without_handler(self):
        consumer = FakeConsumer([message(b"not-json")])
        producer = FakeProducer()
        handled = False

        async def handler(_payload):
            nonlocal handled
            handled = True

        with patch(
            "workers.common.reliable_kafka.build_dead_letter_producer",
            return_value=producer,
        ):
            await consume_reliably(
                consumer,
                handler,
                group_id="test-worker",
                logger=self.logger,
            )

        self.assertFalse(handled)
        self.assertEqual(len(producer.messages), 1)
        self.assertIn(
            "malformed_payload_base64",
            producer.messages[0][1]["original_event"],
        )
        self.assertEqual(len(consumer.commits), 1)


if __name__ == "__main__":
    unittest.main()
