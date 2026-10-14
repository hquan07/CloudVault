# News_Flow → CloudVault

**Trạng thái:** Giai đoạn 6 đã triển khai; report/HTML chọn lọc đã được CloudVault
xác minh về upload, phân quyền, checksum và reconciliation.

## Phạm vi lưu

Nên lưu:

- Intelligence report, briefing hoặc export theo lịch.
- Raw HTML chỉ khi được rule lựa chọn rõ ràng và có retention ngắn.
- Manifest/checksum gọn giúp truy vết nguồn report.

Không lưu mặc định:

- Toàn bộ crawler output hoặc bucket `raw-html`.
- MongoDB/ClickHouse dump, Kafka data, cache và thư mục `backups`.
- Nội dung trùng lặp hoặc không qua bộ lọc kích thước/nguồn.

## Cấu hình

```dotenv
CLOUDVAULT_ENABLED=true
CLOUDVAULT_BASE_URL=http://cloudvault-api
CLOUDVAULT_PROJECT_ID=news-flow
CLOUDVAULT_SERVICE_TOKEN=cvp_replace_me
CLOUDVAULT_RAW_HTML_ENABLED=false
```

Chỉ scheduler/exporter hoặc uploader tham gia `cloudvault-shared`. Không nối
MongoDB, ClickHouse, Kafka hay crawler không cần upload vào mạng này.

## Điểm tích hợp

1. Sau khi export thành công, tạo idempotency key theo loại report, lịch chạy và
   version.
2. Upload report trước; lưu `file_id` vào bản ghi run/report.
3. Với HTML, áp dụng allowlist/filter, giới hạn kích thước, checksum nội dung và
   retention 7–30 ngày trước khi upload.
4. Không coi task là đã lưu nếu upload bắt buộc thất bại; nếu upload tùy chọn thì
   ghi trạng thái/cảnh báo có thể retry.

Gợi ý folder: `reports/<năm>/<tháng>`, `briefings/<chủ-đề>` và
`selected-html/<yyyy-mm-dd>`.

## Kiểm thử nghiệm thu

- Retry cùng logical run không tạo bản trùng.
- Report tải lại được, checksum khớp và chỉ thành viên/token đúng project đọc được.
- Công tắc HTML tắt không ảnh hưởng crawler thông thường.
- File HTML quá giới hạn hoặc không qua bộ lọc không được upload.
- Usage/retention của project hiển thị đúng trong CloudVault.

## Rollback

Tắt upload CloudVault/HTML, tiếp tục luồng MongoDB–Kafka hiện tại và giữ export
nguồn. Revoke/rotate token riêng của News_Flow; không dùng chung token với dự án
khác.
