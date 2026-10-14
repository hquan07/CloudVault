# Phase 8 — Runbook vận hành, khôi phục và mở rộng

Tài liệu này áp dụng cho CloudVault và ba project `ecommerce`, `news-flow`,
`real-time-stock`. Mục tiêu là phát hiện sai lệch sớm, giới hạn tác động của sự
cố theo từng project và khôi phục dữ liệu từ bản sao độc lập với Docker volume.

## 1. Thành phần Phase 8

- `project-operations` đối chiếu MySQL với MinIO mỗi 5 phút và xuất metrics tại
  cổng nội bộ `9100`.
- Prometheus thu metrics API theo project, usage, quota, object thiếu/mồ côi,
  upload treo và file quá retention.
- Alertmanager nhận alert; Grafana có dashboard **CloudVault Project Operations**.
- Trang chi tiết project hiển thị trạng thái `healthy`, `warning` hoặc `critical`
  gần nhất cho thành viên project.
- Bộ script trong `scripts/operations` tạo backup, xác minh backup, diễn tập
  restore cô lập và khôi phục chọn lọc một project qua API.

Worker mặc định chỉ quan sát. Không có object hoặc metadata nào bị xóa chỉ vì
worker được khởi động.

## 2. Khởi động và kiểm tra hệ thống

```bash
./scripts/setup_shared_network.sh
docker compose run --rm mysql-migrate
docker compose up -d --build
docker compose ps
```

Kiểm tra các endpoint:

```bash
curl -fsS http://localhost/health/auth
curl -fsS http://localhost/health/file
curl -fsS http://localhost/health/metadata
curl -fsS http://localhost:9090/-/ready
curl -fsS http://localhost:9093/-/ready
```

Chạy reconciliation thủ công ở chế độ chỉ đọc:

```bash
docker compose run --rm project-operations python main.py --once --json
```

Kết quả cần có `errors: []`. Với mỗi project:

- `usage_drift_bytes` phải bằng `0`.
- `missing_objects` và `missing_thumbnails` phải rỗng.
- `orphan_objects` phải rỗng hoặc đã có giải thích.
- `stale_uploads` phải bằng `0`.

## 3. Metrics và cảnh báo

Dashboard Grafana: `http://localhost:3001`, dashboard **CloudVault Project
Operations**. Alertmanager: `http://localhost:9093`.

Các alert quan trọng:

| Alert | Ý nghĩa | Phản ứng ban đầu |
|---|---|---|
| `CloudVaultProjectQuotaWarning` | Vượt ngưỡng cảnh báo của project | Báo owner, kiểm tra retention |
| `CloudVaultProjectQuotaCritical` | Usage từ 95% | Tạm dừng producer không thiết yếu |
| `CloudVaultProjectMissingObject` | Metadata trỏ đến object không còn tồn tại | Không chạy usage repair; chuẩn bị restore |
| `CloudVaultProjectUsageDrift` | Ledger quota lệch metadata | Chạy dry-run và điều tra trước khi sửa |
| `CloudVaultProjectStaleUpload` | Upload `PENDING` quá 30 phút | Kiểm tra MinIO/API rồi cleanup |
| `CloudVaultProjectApiErrors` | HTTP 5xx vượt 5% | Xem log file-service và dependency |
| `CloudVaultProjectApiLatency` | p95 lớn hơn 2 giây | Kiểm tra MySQL, MinIO và tải upload |

Receiver mặc định giữ alert trong Alertmanager UI và trang project. Khi triển
khai ngoài máy local, thêm `email_configs` hoặc `webhook_configs` vào
`infrastructure/alertmanager/alertmanager.yml`; lấy secret từ secret manager,
không commit SMTP password hoặc webhook URL. Route theo label `project` để báo
đúng owner, đồng thời gửi alert `critical` cho người vận hành chung.

Kiểm tra rule:

```bash
docker compose exec prometheus promtool check config /etc/prometheus/prometheus.yml
docker compose exec prometheus promtool check rules /etc/prometheus/alerts.yml
```

## 4. Chế độ sửa dữ liệu của operations worker

Các biến sau mặc định là `false`:

```dotenv
PROJECT_APPLY_STALE_UPLOAD_CLEANUP=false
PROJECT_APPLY_RETENTION=false
PROJECT_APPLY_USAGE_RECONCILIATION=false
PROJECT_DELETE_ORPHANS=false
```

Quy trình an toàn:

1. Tạo và xác minh backup.
2. Chạy `--once --json` ở dry-run và lưu output vào ticket/sự cố.
3. Nếu có missing object, không tự động sửa usage hoặc xóa orphan.
4. Chạy một lần với `--apply`; lệnh này cleanup upload treo, áp dụng retention
   và sửa usage khi không có object bị thiếu:

```bash
docker compose run --rm project-operations python main.py --once --apply --json
```

5. Chạy dry-run lần nữa. Chỉ bật cờ liên tục trong `.env` sau khi đã quan sát
   ổn định trên từng project.

Xóa orphan là thao tác riêng và không được `--apply` tự động bật:

```bash
docker compose run --rm project-operations \
  python main.py --once --delete-orphans --json
```

Object orphan chỉ bị xóa khi cũ hơn `PROJECT_ORPHAN_GRACE_HOURS`. Luôn kiểm tra
backup trước khi dùng lệnh này.

## 5. Retention và hoàn quota

`retention_policy` của project có thể dùng các khóa:

```json
{
  "default_days": 90,
  "report_days": 365,
  "raw_html_days": 14,
  "model_days": 730,
  "allowed_mime_types": ["application/json", "text/csv"]
}
```

Khi upload, `retention_class=report` dùng `report_days`; nếu không có khóa tương
ứng thì dùng `default_days`. Khi retention hết hạn, worker:

1. chuyển file sang project trash;
2. chờ `PROJECT_TRASH_GRACE_DAYS`;
3. xóa mọi object version và thumbnail;
4. xóa metadata và hoàn quota theo các object version duy nhất.

Trong thời gian pilot nên giữ `PROJECT_APPLY_RETENTION=false` và kiểm tra trường
`expired_files` trước.

## 6. Backup độc lập

Đường dẫn backup phải là đường dẫn tuyệt đối nằm ngoài Docker named volumes,
ưu tiên ổ đĩa khác hoặc kho backup được mã hóa:

```bash
./scripts/operations/backup.sh /mnt/cloudvault-backups
./scripts/operations/verify-backup.sh \
  /mnt/cloudvault-backups/cloudvault-YYYYMMDDTHHMMSSZ-PID
```

Backup gồm:

- MySQL dump nhất quán và nén;
- toàn bộ bucket files, thumbnails và avatars;
- ánh xạ `file_id → bucket/object/checksum` cho file project;
- `SHA256SUMS` và manifest.

Không lưu `.env`, JWT secret hoặc service token trong backup. Mã hóa backup ở
tầng filesystem/kho lưu trữ và giới hạn quyền đọc.

Lịch gợi ý: backup hằng ngày, giữ 7 bản ngày + 4 bản tuần; luôn giữ ít nhất một
bản trên thiết bị/kho không dùng chung Docker host.

## 7. Restore drill

Lệnh sau tạo MySQL và MinIO tạm, restore đầy đủ, xác minh checksum cùng ánh xạ
`file_id`, rồi tự xóa môi trường tạm. Nó không ghi vào stack CloudVault đang chạy:

```bash
./scripts/operations/restore-drill.sh \
  /mnt/cloudvault-backups/cloudvault-YYYYMMDDTHHMMSSZ-PID
```

Drill chỉ đạt khi:

- checksum manifest và SQL gzip hợp lệ;
- schema/dữ liệu MySQL import được;
- mọi object trong `project-objects.tsv` tồn tại sau restore;
- checksum nội dung khớp;
- các bảng `projects`, `files`, `service_accounts`, `audit_logs` truy vấn được.

Thực hiện drill ít nhất mỗi tháng và sau thay đổi schema/backup script.

## 8. Khôi phục chọn lọc một project

Khi chỉ một project hỏng, không restore dump trực tiếp đè lên database đang chạy.

1. Archive project bị ảnh hưởng để revoke toàn bộ credential.
2. Tạo project recovery mới với quota/chính sách phù hợp và tạo service account
   chỉ có `files:create`, `files:read`, `project:usage:read`.
3. Chạy dry-run từ backup:

```bash
./scripts/operations/recover-project.sh BACKUP_DIR ecommerce \
  ecommerce-recovery http://localhost SERVICE_TOKEN --dry-run
```

4. Nếu checksum và object đầy đủ, chạy lại không có `--dry-run`.
5. Script upload qua API bình thường, dùng idempotency key ổn định và tạo file
   mapping `old_file_id → new_file_id → checksum`.
6. Kiểm tra report/model bằng download, chuyển client sang project recovery rồi
   mới quyết định retire project cũ.

Cơ chế này không sửa database hoặc object của project khác. ID mới là chủ ý để
tránh va chạm với metadata hiện tại; mapping đầu ra phải được lưu cùng biên bản
sự cố. Nếu cần giữ nguyên toàn bộ `file_id`, thực hiện full restore sang stack
thay thế và chuyển traffic sau khi kiểm chứng, không import chọn lọc vào production.

## 9. Rotate/revoke credential

- Token chỉ hiển thị một lần khi tạo/rotate.
- Khi nghi ngờ lộ token, revoke ngay trên tab **Service accounts**.
- Rotate tạo token mới và vô hiệu token cũ; cập nhật secret của đúng producer,
  chạy kiểm tra upload/download, rồi xóa secret cũ.
- Archive project tự revoke mọi service account của project đó và không ảnh
  hưởng credential của hai project còn lại.

## 10. Xử lý gián đoạn và hết quota

### CloudVault/MinIO gián đoạn

1. Không xóa artifact nguồn tại E-commerce, News_Flow hoặc Real-Time Stock.
2. Producer giữ retry có backoff và idempotency key không đổi.
3. Kiểm tra `/health/file`, MinIO health, MySQL và `project-operations`.
4. Khi dịch vụ phục hồi, retry cùng logical run; xác nhận không tạo bản trùng.

### Project hết quota

1. Tạm dừng upload loại file ít quan trọng; pipeline chính vẫn giữ artifact local.
2. Kiểm tra trash, retention, file version và object mồ côi bằng dry-run.
3. Chỉ purge khi có backup hợp lệ.
4. Chỉ tăng quota khi dung lượng MinIO vật lý còn đủ và vẫn giữ dự phòng chung.

## 11. Rollout theo project

Triển khai theo thứ tự `ecommerce` → `news-flow` → `real-time-stock`. Với mỗi
project:

1. bật một loại artifact nhỏ;
2. quan sát ít nhất một chu kỳ reconciliation;
3. kiểm tra retry/idempotency/quota/retention;
4. tạo backup và chạy restore drill;
5. mới mở rộng loại file hoặc tần suất.

Giữ MinIO/local/MLflow hiện tại làm nguồn fallback cho đến khi artifact đã qua
ít nhất một lần backup và restore drill thành công.
