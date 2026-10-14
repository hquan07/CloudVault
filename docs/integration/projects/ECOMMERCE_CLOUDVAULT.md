# E-commerce → CloudVault

**Trạng thái:** Giai đoạn 5 đã triển khai và được CloudVault xác minh bằng upload,
download/checksum, idempotency và reconciliation.

## Phạm vi lưu

Nên lưu:

- Báo cáo cuối đã xuất bản (`pdf`, `csv`, `xlsx`, `json` gọn).
- Kết quả kiểm tra chất lượng dữ liệu dạng tổng hợp.
- Model hoặc artifact phân tích chỉ sau khi được duyệt.

Không lưu mặc định:

- Olist raw, Bronze/Silver/Gold đầy đủ.
- File tạm Spark, checkpoint, cache, Kafka data và log Airflow.
- Bản sao toàn bộ MinIO/data lake hiện tại.

## Cấu hình

```dotenv
CLOUDVAULT_ENABLED=true
CLOUDVAULT_BASE_URL=http://cloudvault-api
CLOUDVAULT_PROJECT_ID=ecommerce
CLOUDVAULT_SERVICE_TOKEN=cvp_replace_me
```

Service tạo báo cáo là service duy nhất cần tham gia external network
`cloudvault-shared`. Token pilot nên có `files:create`, `files:read` và
`project:usage:read`; chỉ thêm `files:delete` nếu pipeline thực sự cần xóa.

## Điểm tích hợp

1. Pipeline tạo xong báo cáo và đóng file hoàn chỉnh.
2. Tính SHA-256; tạo idempotency key từ report type, logical date và version.
3. Upload qua `POST /api/v1/projects/ecommerce/files/upload`.
4. Lưu `file_id`, checksum và logical run vào metadata của báo cáo.
5. Không xóa bản nguồn nếu upload hoặc bước xác minh thất bại.

Gợi ý folder: `reports/<năm>/<tháng>`, `quality/<dataset>` và
`artifacts/<loại>/<version>`. Folder chỉ để sắp xếp, không thay thế phân quyền.

## Kiểm thử nghiệm thu

- Chạy một logical date hai lần và xác nhận không tạo bản trùng.
- Tải file bằng `file_id`, so checksum với bản nguồn.
- Thử token thiếu scope, token project khác và hard quota.
- Tắt `CLOUDVAULT_ENABLED` và xác nhận pipeline nghiệp vụ vẫn theo chính sách đã
  chọn (tiếp tục có cảnh báo hoặc fail nếu upload là bắt buộc).
- Kiểm tra Projects → E-commerce hiển thị đúng file và usage.

## Rollback

Tắt feature flag CloudVault, giữ data lake/report nguồn và revoke token nếu có
nghi ngờ lộ credential. Chỉ dọn nguồn cũ sau khi backup/restore CloudVault đã
được diễn tập thành công.
