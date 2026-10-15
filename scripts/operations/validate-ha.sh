#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/../.." && pwd)"

: "${CLOUDVAULT_HA_MODE_ACK:?Set CLOUDVAULT_HA_MODE_ACK after backup and HA migration planning}"

compose=(
  docker compose
  --project-directory "$project_dir"
  -f "$project_dir/docker-compose.yml"
  -f "$project_dir/docker-compose.ha.yml"
)

fail() {
  echo "HA validation failed: $*" >&2
  exit 1
}

expect_running_replicas() {
  local service="$1"
  local expected="$2"
  local actual
  actual="$("${compose[@]}" ps --status running -q "$service" | wc -l | tr -d ' ')"
  [[ "$actual" == "$expected" ]] || fail "$service has $actual running replica(s), expected $expected"
  printf '  %-24s %s/%s running\n' "$service" "$actual" "$expected"
}

echo "Validating the merged Compose model..."
"${compose[@]}" config -q

echo "Checking application and worker replicas..."
expect_running_replicas frontend "${FRONTEND_REPLICAS:-2}"
expect_running_replicas auth-service "${AUTH_SERVICE_REPLICAS:-2}"
expect_running_replicas file-service "${FILE_SERVICE_REPLICAS:-2}"
expect_running_replicas metadata-service "${METADATA_SERVICE_REPLICAS:-2}"
expect_running_replicas thumbnail-worker "${THUMBNAIL_WORKER_REPLICAS:-2}"
expect_running_replicas search-indexer "${SEARCH_INDEXER_REPLICAS:-2}"
expect_running_replicas audit-logger "${AUDIT_LOGGER_REPLICAS:-2}"
expect_running_replicas zip-extractor-worker "${ZIP_EXTRACTOR_REPLICAS:-2}"

echo "Checking Kafka broker registration and topic durability..."
broker_info="$("${compose[@]}" exec -T kafka \
  kafka-broker-api-versions --bootstrap-server kafka:29092,kafka-2:29092,kafka-3:29092)"
broker_count="$(printf '%s\n' "$broker_info" | grep -Ec '\(id: [0-9]+' || true)"
[[ "$broker_count" -eq 3 ]] || fail "Kafka reports $broker_count broker(s), expected 3"

for topic in "${KAFKA_TOPIC_FILE_EVENTS:-file-events}" \
             "${KAFKA_TOPIC_USER_EVENTS:-user-events}" \
             "${KAFKA_TOPIC_DEAD_LETTER:-dead-letter-events}"; do
  topic_info="$("${compose[@]}" exec -T kafka kafka-topics \
    --bootstrap-server kafka:29092,kafka-2:29092,kafka-3:29092 \
    --describe --topic "$topic")"
  printf '%s\n' "$topic_info" | grep -Eq 'ReplicationFactor:[[:space:]]*3' \
    || fail "$topic does not use replication factor 3"
  printf '%s\n' "$topic_info" | grep -Eq 'min\.insync\.replicas=2' \
    || fail "$topic does not use min.insync.replicas=2"
  echo "  $topic: RF=3, min ISR=2"
done

echo "Checking the authenticated MinIO cluster..."
minio_info="$("${compose[@]}" exec -T minio sh -ec '
  mc alias set validate http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  mc admin info validate --json
')"
online_disks="$(printf '%s\n' "$minio_info" | grep -Eo '"onlineDisks":[[:space:]]*[0-9]+' | tail -1 | grep -Eo '[0-9]+' || true)"
[[ "${online_disks:-0}" -eq 4 ]] || fail "MinIO reports ${online_disks:-0} online disks, expected 4"
echo "  MinIO: 4/4 disks online"

echo "HA validation passed."
