#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup_dir="${1:-}"
source_slug="${2:-}"
target_project="${3:-}"
base_url="${4:-}"
service_token="${5:-}"
mode="${6:-}"

if [[ -z "$backup_dir" || -z "$source_slug" || -z "$target_project" || -z "$base_url" || -z "$service_token" ]]; then
  echo "Cách dùng: $0 BACKUP_DIR SOURCE_SLUG TARGET_PROJECT BASE_URL SERVICE_TOKEN [--dry-run]" >&2
  exit 2
fi
if [[ ! "$source_slug" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "SOURCE_SLUG không hợp lệ" >&2
  exit 2
fi
backup_dir="$(cd "$backup_dir" && pwd)"
"$repo_root/scripts/operations/verify-backup.sh" "$backup_dir" >/dev/null

suffix="$(date +%s)-$$"
mysql_container="cloudvault-project-recovery-$suffix"
mysql_password="project-recovery-${suffix}-password"
work_dir="$(mktemp -d)"
mapping_file="$PWD/recovery-${source_slug}-${suffix}.tsv"

cleanup() {
  docker rm -f "$mysql_container" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

docker run -d --name "$mysql_container" -e MYSQL_ROOT_PASSWORD="$mysql_password" mysql:8.0 >/dev/null
for _ in $(seq 1 60); do
  if docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
    mysql -uroot -N -B -e "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
  mysql -uroot -N -B -e "SELECT 1" >/dev/null
docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
  mysql -uroot -e "CREATE DATABASE cloudvault_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gzip -dc "$backup_dir/mysql/cloudvault.sql.gz" \
  | docker exec -i -e MYSQL_PWD="$mysql_password" "$mysql_container" \
    mysql -uroot cloudvault_restore

project_query="
    SELECT REPLACE(TO_BASE64(f.id), '\\n', ''),
           REPLACE(TO_BASE64(f.original_name), '\\n', ''),
           REPLACE(TO_BASE64(f.mime_type), '\\n', ''),
           REPLACE(TO_BASE64(f.minio_bucket), '\\n', ''),
           REPLACE(TO_BASE64(f.minio_key), '\\n', ''),
           REPLACE(TO_BASE64(COALESCE(f.checksum_sha256, '')), '\\n', ''),
           REPLACE(TO_BASE64(CAST(COALESCE(f.metadata_json, JSON_OBJECT()) AS CHAR)), '\\n', '')
    FROM files f JOIN projects p ON p.id=f.project_id
    WHERE p.slug='$source_slug' AND f.status='AVAILABLE' AND f.is_deleted=FALSE
    ORDER BY f.created_at;"
docker exec -e MYSQL_PWD="$mysql_password" "$mysql_container" \
  mysql -uroot -N -B cloudvault_restore -e "$project_query" > "$work_dir/files.tsv"

file_count="$(wc -l < "$work_dir/files.tsv")"
if [[ "$file_count" -eq 0 ]]; then
  echo "Không tìm thấy file AVAILABLE trong project nguồn: $source_slug" >&2
  exit 1
fi

printf 'old_file_id\tnew_file_id\tchecksum_sha256\n' > "$mapping_file"
echo "Tìm thấy $file_count file; mapping sẽ ghi tại $mapping_file"

while IFS=$'\t' read -r old_id_b64 name_b64 mime_b64 bucket_b64 key_b64 checksum_b64 metadata_b64; do
  old_id="$(printf '%s' "$old_id_b64" | base64 -d)"
  original_name="$(printf '%s' "$name_b64" | base64 -d)"
  mime_type="$(printf '%s' "$mime_b64" | base64 -d)"
  bucket="$(printf '%s' "$bucket_b64" | base64 -d)"
  object_key="$(printf '%s' "$key_b64" | base64 -d)"
  checksum="$(printf '%s' "$checksum_b64" | base64 -d)"
  object_path="$backup_dir/minio/$bucket/$object_key"
  if [[ ! -f "$object_path" ]]; then
    echo "Thiếu object cho file_id=$old_id: $bucket/$object_key" >&2
    exit 1
  fi
  observed="$(sha256sum "$object_path" | cut -d' ' -f1)"
  if [[ -n "$checksum" && "$observed" != "$checksum" ]]; then
    echo "Checksum sai cho file_id=$old_id" >&2
    exit 1
  fi
  metadata_file="$work_dir/$old_id.json"
  printf '%s' "$metadata_b64" | base64 -d | python3 -c '
import json, sys
old_id = sys.argv[1]
data = json.load(sys.stdin)
data["recovered_from_file_id"] = old_id
data["checksum_sha256"] = data.get("checksum_sha256") or sys.argv[2]
print(json.dumps(data, separators=(",", ":")))
' "$old_id" "$observed" > "$metadata_file"

  if [[ "$mode" == "--dry-run" ]]; then
    printf '%s\t%s\t%s\n' "$old_id" 'DRY_RUN' "$observed" >> "$mapping_file"
    continue
  fi

  response_file="$work_dir/$old_id.response.json"
  status="$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
    --request POST "${base_url%/}/api/v1/projects/$target_project/files/upload" \
    --header "Authorization: Bearer $service_token" \
    --header "Idempotency-Key: recovery:$old_id:$observed" \
    --form "file=@$object_path;filename=$original_name;type=$mime_type" \
    --form "metadata_json=<$metadata_file")"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    echo "Khôi phục file_id=$old_id thất bại (HTTP $status): $(cat "$response_file")" >&2
    exit 1
  fi
  new_id="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); print(data.get("file_id") or data["id"])' "$response_file")"
  printf '%s\t%s\t%s\n' "$old_id" "$new_id" "$observed" >> "$mapping_file"
done < "$work_dir/files.tsv"

if [[ "$mode" == "--dry-run" ]]; then
  echo "Dry-run khôi phục project thành công; không gọi CloudVault API."
else
  echo "Khôi phục project thành công. Kiểm tra mapping: $mapping_file"
fi
