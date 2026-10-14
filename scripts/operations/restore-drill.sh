#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup_dir="${1:-}"
if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
  echo "Cách dùng: $0 /duong-dan/cloudvault-YYYYMMDDTHHMMSSZ-PID" >&2
  exit 2
fi
backup_dir="$(cd "$backup_dir" && pwd)"

"$repo_root/scripts/operations/verify-backup.sh" "$backup_dir"

suffix="$(date +%s)-$$"
network="cloudvault-restore-drill-$suffix"
mysql_container="cloudvault-restore-mysql-$suffix"
minio_container="cloudvault-restore-minio-$suffix"
mysql_password="restore-drill-${suffix}-password"
minio_password="restore-drill-${suffix}-minio-password"
drill_database="cloudvault_restore"

cleanup() {
  docker rm -f "$mysql_container" "$minio_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[1/5] Khởi tạo môi trường restore cô lập..."
docker network create "$network" >/dev/null
docker run -d --name "$mysql_container" --network "$network" \
  -e MYSQL_ROOT_PASSWORD="$mysql_password" mysql:8.0 >/dev/null
docker run -d --name "$minio_container" --network "$network" \
  -e MINIO_ROOT_USER=restore_admin \
  -e MINIO_ROOT_PASSWORD="$minio_password" \
  quay.io/minio/minio:latest server /data >/dev/null

for _ in $(seq 1 60); do
  if docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
    mysql -uroot -N -B -e "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
  mysql -uroot -N -B -e "SELECT 1" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$minio_container" mc ready local >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$minio_container" mc ready local >/dev/null

echo "[2/5] Restore metadata vào MySQL tạm..."
docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
  mysql -uroot -e "CREATE DATABASE cloudvault_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gzip -dc "$backup_dir/mysql/cloudvault.sql.gz" \
  | docker exec -i -e MYSQL_PWD="$mysql_password" "$mysql_container" \
    mysql -uroot cloudvault_restore

echo "[3/5] Restore object vào MinIO tạm..."
for bucket_dir in "$backup_dir"/minio/*; do
  [[ -d "$bucket_dir" ]] || continue
  bucket="$(basename "$bucket_dir")"
  docker run --rm --network "$network" \
    -e DRILL_MINIO_PASSWORD="$minio_password" \
    -v "$bucket_dir:/backup:ro" \
    --entrypoint /bin/sh quay.io/minio/mc:latest -c \
    'mc alias set drill http://'"$minio_container"':9000 restore_admin "$DRILL_MINIO_PASSWORD" >/dev/null && mc mb --ignore-existing "drill/'"$bucket"'" >/dev/null && mc mirror --overwrite /backup "drill/'"$bucket"'"'
done

echo "[4/5] Kiểm tra ánh xạ file_id và checksum trên object đã restore..."
docker run --rm --network "$network" \
  -e DRILL_MINIO_PASSWORD="$minio_password" \
  -v "$backup_dir/project-objects.tsv:/mapping.tsv:ro" \
  --entrypoint /bin/sh quay.io/minio/mc:latest -c '
    set -eu
    mc alias set drill http://'"$minio_container"':9000 restore_admin "$DRILL_MINIO_PASSWORD" >/dev/null
    checked=0
    while IFS="	" read -r file_id bucket object_key expected; do
      [ -n "$object_key" ] || continue
      mc stat "drill/$bucket/$object_key" >/dev/null
      if [ -n "$expected" ]; then
        observed="$(mc cat "drill/$bucket/$object_key" | sha256sum | cut -d" " -f1)"
        if [ "$observed" != "$expected" ]; then
          echo "Checksum sai: file_id=$file_id object=$bucket/$object_key" >&2
          exit 1
        fi
      fi
      checked=$((checked + 1))
    done < /mapping.tsv
    echo "Đã xác minh $checked ánh xạ object."
  '

echo "[5/5] Kiểm tra các bảng cốt lõi sau restore..."
docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
  mysql -uroot -N -B cloudvault_restore -e '
    SELECT CONCAT("projects=", COUNT(*)) FROM projects;
    SELECT CONCAT("project_files=", COUNT(*)) FROM files WHERE project_id IS NOT NULL;
    SELECT CONCAT("service_accounts=", COUNT(*)) FROM service_accounts;
    SELECT CONCAT("audit_logs=", COUNT(*)) FROM audit_logs;'

echo "Restore drill thành công; môi trường tạm sẽ được tự động xóa."
