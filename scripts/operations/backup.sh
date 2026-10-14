#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup_root="${1:-}"

if [[ -z "$backup_root" || "$backup_root" != /* ]]; then
  echo "Cách dùng: $0 /duong-dan-tuyet-doi/ngoai-docker-volumes" >&2
  exit 2
fi

cd "$repo_root"
set -a
source .env
set +a

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${backup_root%/}/cloudvault-${timestamp}-$$"
mkdir -p "$backup_dir/mysql" "$backup_dir/minio"
chmod 700 "$backup_dir"
umask 077

echo "[1/4] Sao lưu MySQL nhất quán..."
docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --single-transaction --routines --triggers --events --hex-blob "$MYSQL_DATABASE"' \
  | gzip -9 > "$backup_dir/mysql/cloudvault.sql.gz"

echo "[2/4] Xuất ánh xạ file_id/object/checksum..."
docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -B "$MYSQL_DATABASE" -e "
    SELECT f.id, f.minio_bucket, fv.minio_key, COALESCE(fv.checksum_sha256, \"\")
    FROM file_versions fv JOIN files f ON f.id=fv.file_id
    WHERE f.project_id IS NOT NULL
    UNION
    SELECT f.id, f.minio_bucket, f.minio_key, COALESCE(f.checksum_sha256, \"\")
    FROM files f WHERE f.project_id IS NOT NULL
    ORDER BY 1, 3;"' > "$backup_dir/project-objects.tsv"

echo "[3/4] Sao lưu các bucket MinIO..."
for bucket in "$MINIO_BUCKET_FILES" "$MINIO_BUCKET_THUMBNAILS" "$MINIO_BUCKET_AVATARS"; do
  mkdir -p "$backup_dir/minio/$bucket"
  docker run --rm --network cloudvault-network \
    -e MINIO_ROOT_USER="$MINIO_ROOT_USER" \
    -e MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
    -v "$backup_dir/minio/$bucket:/backup" \
    --entrypoint /bin/sh quay.io/minio/mc:latest -c \
    'mc alias set source http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --overwrite "source/'"$bucket"'" /backup'
done

cat > "$backup_dir/MANIFEST.json" <<EOF
{
  "format_version": 1,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "${MYSQL_DATABASE}",
  "buckets": ["${MINIO_BUCKET_FILES}", "${MINIO_BUCKET_THUMBNAILS}", "${MINIO_BUCKET_AVATARS}"],
  "source": "cloudvault-compose"
}
EOF

echo "[4/4] Tạo manifest checksum..."
(
  cd "$backup_dir"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)

echo "Backup hoàn tất: $backup_dir"
