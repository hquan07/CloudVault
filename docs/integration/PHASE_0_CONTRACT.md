# Giai đoạn 0 — Hợp đồng tích hợp và chính sách dung lượng

**Trạng thái:** Đã chốt cho MVP  
**Ngày chốt:** 2026-10-13  
**Phạm vi:** CloudVault, `ecommerce`, `news-flow`, `real-time-stock`

## 1. Mục tiêu MVP

CloudVault cung cấp một vùng **Projects** tách khỏi **My Files**. Mỗi project có thành viên, service account, quyền, quota và file riêng. Ba dự án chỉ gửi sản phẩm đầu ra đã chọn lọc qua CloudVault API; chúng không truy cập trực tiếp MinIO/MySQL của CloudVault.

Pilot đầu tiên là một báo cáo nhỏ của E-commerce. News_Flow và Real-Time Stock chỉ được bật sau khi pilot xác minh được quyền truy cập chéo, idempotency, quota, retry và download.

## 2. Định danh project cố định

| Tên hiển thị | `project_id`/slug | Loại dữ liệu MVP |
|---|---|---|
| E-commerce | `ecommerce` | Báo cáo cuối và kết quả kiểm tra chất lượng gọn |
| News Flow | `news-flow` | Export intelligence; raw HTML chỉ khi bật chọn lọc |
| Real-Time Stock | `real-time-stock` | Model bundle đã kiểm định và báo cáo dự đoán gọn |

Slug là định danh ổn định dùng trong URL, credential và metadata. Đổi tên hiển thị không làm đổi slug.

## 3. Chính sách dung lượng khởi điểm

Các giá trị dưới đây là cấu hình MVP bảo thủ, có thể giảm trước khi chạy nếu dung lượng MinIO thực tế không đủ. Tổng quota project khởi điểm là 2,5 GiB; cần giữ riêng dung lượng cho file cá nhân, version, thumbnail và vận hành.

| Project | Hard quota | Cảnh báo | File tối đa | Retention ban đầu |
|---|---:|---:|---:|---|
| `ecommerce` | 1 GiB | 80% | 100 MiB | Report 180 ngày; quality 60 ngày |
| `news-flow` | 512 MiB | 80% | 10 MiB | Report 60 ngày; HTML chọn lọc 14 ngày |
| `real-time-stock` | 1 GiB | 80% | 100 MiB | Model giữ đến khi retire; report 90 ngày |

Quy tắc tính usage:

- Tính theo số byte vật lý của file `AVAILABLE` và mọi version còn được giữ.
- File đang upload giữ chỗ quota; upload lỗi hoặc hết hạn phải hoàn chỗ đã giữ.
- Soft delete vẫn tính quota đến khi object/version bị xóa vật lý.
- Thumbnail hoặc derived object được tính vào project tạo ra chúng.
- Không dùng tổng quota logic làm bằng chứng còn đủ dung lượng đĩa; vận hành vẫn phải theo dõi dung lượng MinIO thực tế.

## 4. Quyền và vai trò

Vai trò thành viên người dùng:

| Vai trò | Khả năng |
|---|---|
| `viewer` | Xem project, metadata và download file |
| `editor` | Quyền viewer, upload và cập nhật nội dung project |
| `admin` | Quyền editor, quản lý thành viên, quota/policy và service account |

Scope service account MVP:

- `files:create`
- `files:read`
- `files:delete` chỉ cấp khi có quy trình dọn file cụ thể
- `project:usage:read`

Project được lấy từ service account đã xác thực. Client không thể đổi project bằng request body/query/header.

## 5. Hợp đồng API MVP

Các endpoint project dành cho người dùng:

```text
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{project_id}
GET    /api/v1/projects/{project_id}/files
GET    /api/v1/projects/{project_id}/usage
POST   /api/v1/projects/{project_id}/service-accounts
POST   /api/v1/projects/{project_id}/service-accounts/{id}/rotate
DELETE /api/v1/projects/{project_id}/service-accounts/{id}
```

Endpoint file dùng chung được mở rộng để chấp nhận JWT người dùng có membership hoặc service token:

```text
POST   /api/v1/projects/{project_id}/files/upload
GET    /api/v1/projects/{project_id}/files/{file_id}
GET    /api/v1/projects/{project_id}/files/{file_id}/download
DELETE /api/v1/projects/{project_id}/files/{file_id}
```

MVP upload dùng multipart qua CloudVault API. Presigned upload chưa thuộc phạm vi Giai đoạn 0–3.

Header idempotency:

```text
Idempotency-Key: <chuỗi ổn định theo artifact và logical run>
```

Quy tắc:

- Cùng project + cùng key + cùng checksum: trả lại kết quả upload đã có.
- Cùng project + cùng key + khác checksum: trả `409 IDEMPOTENCY_CONFLICT`.
- Key hết hạn theo policy nhưng không ngắn hơn retention retry của workload.

## 6. Metadata tối thiểu

Mỗi upload project cần các trường:

```json
{
  "artifact_type": "daily_sales_report",
  "logical_date": "2026-10-13",
  "source_run_id": "airflow-run-id",
  "retention_class": "report",
  "checksum_sha256": "hex-digest"
}
```

CloudVault tự bổ sung `project_id`, `service_account_id` hoặc `created_by`, `size_bytes`, trạng thái và thời điểm tạo. Object key là chi tiết nội bộ; client chỉ lưu `file_id`.

Trạng thái file project:

```text
PENDING → AVAILABLE
PENDING → FAILED
AVAILABLE → DELETED
```

## 7. Lỗi chuẩn

| HTTP | Mã lỗi | Ý nghĩa |
|---:|---|---|
| 400 | `INVALID_FILE` | File/metadata không hợp lệ |
| 401 | `INVALID_CREDENTIAL` | Credential thiếu, hết hạn hoặc bị revoke |
| 403 | `PROJECT_ACCESS_DENIED` | Không có membership/scope cần thiết |
| 404 | `FILE_NOT_FOUND` | File không tồn tại trong project đã xác thực |
| 409 | `IDEMPOTENCY_CONFLICT` | Cùng key nhưng nội dung khác |
| 413 | `FILE_TOO_LARGE` | Vượt kích thước file hoặc hard quota |
| 429 | `RATE_LIMITED` | Vượt giới hạn request |
| 503 | `STORAGE_UNAVAILABLE` | Object storage tạm thời không sẵn sàng |

Client chỉ retry lỗi mạng, `429` và `5xx` có giới hạn. Không retry vô hạn lỗi `4xx` khác.

## 8. Network local

- Tạo network ngoài `cloudvault-shared` một lần.
- Chỉ Nginx gateway của CloudVault tham gia cả `cloudvault-network` và `cloudvault-shared`.
- Chỉ service uploader của từng project tham gia `cloudvault-shared`.
- Alias nội bộ ổn định: `cloudvault-api`.
- Client container dùng `CLOUDVAULT_BASE_URL=http://cloudvault-api`.
- MinIO, MySQL, Redis, Kafka và Elasticsearch của CloudVault không tham gia shared network.

## 9. Điều kiện bắt đầu và hoàn tất pilot

Trước pilot:

- Project/service account/quota API hoạt động.
- E-commerce có bước sinh report thật và đường dẫn file rõ ràng.
- Token được nạp bằng secret, không commit hoặc ghi log.

Pilot hoàn tất khi:

- Report xuất hiện trong Projects → E-commerce.
- Chạy lại cùng logical date không sinh file trùng.
- Token E-commerce không đọc được file News Flow/Stock.
- Upload vượt quota bị từ chối và usage không sai lệch.
- CloudVault lỗi không xóa file report nguồn của E-commerce.

## 10. Ngoài phạm vi Giai đoạn 0–3

- Di chuyển toàn bộ MinIO/data lake của E-commerce hoặc News_Flow.
- Đưa backup database vào CloudVault.
- Dùng CloudVault làm database time-series cho Stock.
- Presigned multipart upload, HA đa host hoặc thay inference Stock bằng tải model trực tiếp từ CloudVault.
