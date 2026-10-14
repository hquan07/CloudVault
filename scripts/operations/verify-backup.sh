#!/usr/bin/env bash
set -euo pipefail

backup_dir="${1:-}"
if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
  echo "Cách dùng: $0 /duong-dan/cloudvault-YYYYMMDDTHHMMSSZ-PID" >&2
  exit 2
fi

for required in MANIFEST.json SHA256SUMS mysql/cloudvault.sql.gz project-objects.tsv minio; do
  if [[ ! -e "$backup_dir/$required" ]]; then
    echo "Backup thiếu: $required" >&2
    exit 1
  fi
done

(
  cd "$backup_dir"
  sha256sum --check --strict SHA256SUMS
  gzip -t mysql/cloudvault.sql.gz
)

echo "Backup hợp lệ: $backup_dir"
