# Real-Time Stock → CloudVault

**Trạng thái:** Giai đoạn 7 đã triển khai; model/report đã được CloudVault xác
minh về upload, checksum, metadata và reconciliation.

## Phạm vi lưu

Nên lưu:

- Model bundle có version, đã vượt qua validation và được duyệt.
- Manifest gồm model type, ticker, feature schema, runtime/library version,
  training time và checksum.
- Báo cáo tín hiệu/dự đoán dạng tổng hợp, kích thước gọn.

Không lưu mặc định:

- Lịch sử giá/thị trường trong PostgreSQL.
- Checkpoint, cache, log Airflow/training, model thử nghiệm hoặc file inference tạm.
- Toàn bộ MLflow artifact store khi chưa có chính sách chọn lọc.

## Cấu hình

```dotenv
CLOUDVAULT_ENABLED=true
CLOUDVAULT_BASE_URL=http://cloudvault-api
CLOUDVAULT_PROJECT_ID=real-time-stock
CLOUDVAULT_SERVICE_TOKEN=cvp_replace_me
```

Chỉ service publish model/report tham gia `cloudvault-shared`. Pipeline inference
tiếp tục dùng artifact local/MLflow cho đến khi quy trình tải từ xa, cache,
availability và rollback được kiểm chứng độc lập.

## Điểm tích hợp

1. Train và validate model hoàn tất; không upload checkpoint đang ghi.
2. Đóng gói model cùng manifest; tính checksum.
3. Dùng idempotency key bất biến theo model name + version + checksum.
4. Upload vào project `real-time-stock` và lưu `file_id` trong model registry/run.
5. Chỉ đánh dấu bản CloudVault là bền vững sau khi download kiểm tra checksum.

Gợi ý folder: `models/<model>/<version>`, `signals/<yyyy-mm-dd>` và
`reports/<năm>/<tháng>`.

## Kiểm thử nghiệm thu

- Cùng model version không bị ghi đè âm thầm hoặc tạo bản trùng.
- Bundle tải lại bằng `file_id`, checksum và manifest khớp.
- Token dự án khác không đọc được model.
- CloudVault gián đoạn không khiến inference chọn model chưa hoàn chỉnh.
- Luôn giữ ít nhất một model version đã biết hoạt động để rollback.

## Rollback

Tắt publisher CloudVault, tiếp tục dùng artifact local/MLflow và model đang chạy.
Rotate/revoke token của riêng project khi cần. Không xóa model local trước khi
restore drill và quy trình rollback đã được xác nhận.
