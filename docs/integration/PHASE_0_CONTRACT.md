# Giai đoạn 0 — Hợp đồng tích hợp và dung lượng

Tài liệu này là hợp đồng chung giữa CloudVault và các dự án client. Các dự án
mới có thể áp dụng cùng nguyên tắc mà không phụ thuộc vào tên repo hoặc công
nghệ pipeline.

## 1. Ranh giới project

| Project ID | Mục đích lưu trữ | Không lưu mặc định |
|---|---|---|
| `ecommerce` | Báo cáo cuối, kết quả kiểm tra dữ liệu, artifact đã duyệt | Raw/Bronze/Silver, cache Spark, Kafka, log |
| `news-flow` | Intelligence report và HTML được chọn lọc | Toàn bộ crawler output, database, thư mục backup |
| `real-time-stock` | Model đã kiểm định và báo cáo tín hiệu gọn | Dữ liệu thị trường, checkpoint, model tạm, log training |

Project là ranh giới quyền hạn, quota và vận hành. Folder chỉ dùng để tổ chức
nội dung bên trong project; không tạo ra quyền truy cập mới.

## 2. Quyền và thông tin xác thực

- Người dùng truy cập bằng JWT và phải là thành viên project, trừ quản trị viên
  hệ thống.
- Ứng dụng dùng service token riêng có tiền tố `cvp_`, truyền bằng
  `Authorization: Bearer <token>`.
- Token chỉ được hiển thị khi tạo hoặc rotate. CloudVault chỉ lưu hash.
- Scope tối thiểu gồm `files:create`, `files:read`, `files:delete` và
  `project:usage:read`; chỉ cấp scope cần thiết cho từng client.
- Token của project này không được phép truy cập project khác, kể cả khi biết
  `file_id`.

## 3. Hợp đồng upload

- Endpoint: `POST /api/v1/projects/{project_id}/files/upload`.
- Bắt buộc có `Idempotency-Key`, ổn định theo logical run và artifact.
- Dữ liệu gửi dưới dạng multipart với trường `file`; metadata bổ sung gửi bằng
  `metadata_json` khi cần.
- Upload thành công trả về `file_id`; client phải lưu ID này cùng run/model/report.
- Cùng idempotency key và cùng nội dung phải trả lại kết quả nhất quán. Cùng key
  nhưng khác nội dung phải bị từ chối.
- File chỉ ở trạng thái `AVAILABLE` sau khi object và metadata đã được xác minh.
- Client không được nhận credential MinIO hoặc ghi trực tiếp vào object storage.

Metadata nên có `source_project`, loại artifact, logical run, môi trường, checksum
SHA-256 và phiên bản schema/pipeline. Model cần thêm model version, runtime,
feature schema và phạm vi ticker.

## 4. Dung lượng và retention

- Quota là hard limit theo project và được giữ chỗ nguyên tử trước khi upload.
- Usage tính cả object/version vật lý còn được retention giữ lại.
- Không cấp hết dung lượng khả dụng: phải chừa chỗ cho dữ liệu cá nhân, phiên bản,
  thumbnail, backup tạm và tăng trưởng hệ thống.
- Retention khởi đầu: report 30–90 ngày; HTML chọn lọc 7–30 ngày; model đã kiểm
  định giữ đến khi được retire rõ ràng.
- Xóa tự động chỉ được bật sau khi chạy chế độ dry-run, theo dõi cảnh báo và có
  backup/restore đã kiểm chứng.

## 5. Lỗi và retry

- Chỉ retry timeout, lỗi mạng, HTTP 429 và lỗi 5xx bằng exponential backoff có
  jitter; luôn tái sử dụng cùng idempotency key.
- Không retry tự động lỗi xác thực, thiếu scope, file không hợp lệ hoặc hard quota.
- Upload thất bại không được xóa artifact nguồn hoặc đánh dấu là đã lưu an toàn.
- CloudVault gián đoạn không được làm client nạp artifact chưa hoàn chỉnh.

## 6. Điều kiện nghiệm thu chung

1. Client chỉ gọi API gateway và không truy cập trực tiếp database/MinIO.
2. Upload lặp lại không sinh bản trùng ngoài ý muốn.
3. File xuất hiện đúng project, tải lại được và checksum khớp.
4. Hết quota, token sai scope và truy cập chéo project đều bị từ chối rõ ràng.
5. Có thể rotate/revoke credential độc lập và khôi phục project từ backup.
