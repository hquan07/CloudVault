# Tích hợp News_Flow với CloudVault

**Repo đích:** `News_Flow`  
**CloudVault project ID:** `news-flow`  
**Trạng thái:** Network và client contract Giai đoạn 4 đã triển khai; chưa bật export/archive của Giai đoạn 6.

## Mục đích và ranh giới

Dùng CloudVault cho các export intelligence đã chọn và raw HTML được lựa chọn rõ ràng với retention ngắn. News_Flow hiện có MinIO `raw-html` riêng và `MinIOPipeline` trong Scrapy; `infrastructure/docker/docker-compose.yml` cũng định nghĩa volume backup database. Không upload toàn bộ crawler hoặc thư mục `backups` hiện tại lên CloudVault.

Pipeline Scrapy hiện tạo S3 client từ cấu hình MinIO, tạo tên object từ hash URL, upload `raw_html`, rồi chỉ ghi log khi lỗi upload thay vì báo lỗi ngược lại. Cần chốt chính sách trước khi thay thế hoặc bổ sung luồng này: upload lưu trữ được chọn phải có trạng thái lỗi/retry rõ; crawler thông thường vẫn chạy độc lập khi CloudVault bị tắt.

## Nhóm file ban đầu đưa lên CloudVault

Bắt đầu với:

- export intelligence/briefing theo lịch cần tải xuống bền vững;
- HTML nguồn quan trọng được chọn nếu bật theo chính sách source/category/retention;
- snapshot analytics gọn khi có consumer cần file mang đi được.

Không upload:

- toàn bộ raw HTML theo mặc định;
- backup MongoDB/PostgreSQL/Airflow hoặc archive backup;
- dữ liệu trung gian Kafka/Spark, cache, log, `node_modules` frontend hoặc nội dung warehouse.

## Các giai đoạn tích hợp

### N1 — Chốt chính sách nội dung, riêng tư và vòng đời

1. Tạo project `news-flow` và service account riêng cho crawler/archive hoặc workload report.
2. Quyết định report thuộc riêng owner, chia sẻ trong workspace hay hiển thị cho cả project. Membership project không được tự ý làm lộ report intelligence cá nhân cho mọi thành viên.
3. Chọn HTML đủ điều kiện bằng allow rule rõ ràng và đặt TTL ngắn (đề xuất ban đầu: 7–30 ngày).
4. Đặt hard quota, kích thước file tối đa và cách xử lý retention. Chừa dung lượng cho project khác trong CloudVault.

### N2 — Cấu hình client và network

Cấu hình `CLOUDVAULT_BASE_URL`, project ID và project token qua secret cho riêng uploader service/container. Chỉ nối uploader vào `cloudvault-shared`; giữ MongoDB, ClickHouse, Kafka, Spark và MinIO local trên network hiện hữu của News_Flow.

```yaml
services:
  crawler:
    environment:
      CLOUDVAULT_BASE_URL: ${CLOUDVAULT_BASE_URL}
      CLOUDVAULT_PROJECT_ID: news-flow
      CLOUDVAULT_SERVICE_TOKEN: ${CLOUDVAULT_SERVICE_TOKEN}
    networks:
      - default
      - cloudvault-shared

networks:
  cloudvault-shared:
    external: true
    name: cloudvault-shared
```

Đây là phác thảo thay đổi; cần xác nhận service Compose nào thực sự chạy Scrapy trong stack hiện tại. Dùng alias gateway trong Docker, không dùng `localhost`. Không nối crawler vào network riêng của CloudVault hoặc MinIO.

### N3 — Thêm client upload và chọn dữ liệu archive

Wrapper đã được thêm tại `integrations/cloudvault.py` trong repo News_Flow và
được mount read-only vào `airflow-scheduler`. Wrapper cố định project
`news-flow`; chưa được gọi từ DAG report hoặc crawler trong giai đoạn này.

Thêm client wrapper News_Flow có timeout/retry giới hạn, SHA-256, idempotency ổn định và log an toàn. Chọn raw HTML trước khi upload bằng hàm policy rõ ràng, ví dụ allowlist source + kích thước nội dung + tiêu chí freshness/importance. Giữ khả năng archive MinIO local trong giai đoạn chuyển đổi và rollback.

Với raw HTML, chuẩn hóa URL và dùng hash ổn định làm một phần idempotency key. Không dùng MD5 URL hash làm checksum bảo mật; dùng SHA-256 để kiểm tra toàn vẹn file. Lưu source URL, spider/source, thời điểm crawl và thời điểm hết hạn thành metadata, tuân theo chính sách riêng tư/retention của News_Flow.

### N4 — Tích hợp report theo lịch trước

1. Chọn định dạng export và serialize report thành file có kích thước giới hạn.
2. Upload sau khi tạo report thành công, dùng key có phạm vi owner và logical date của lần chạy.
3. Lưu `file_id` trả về cùng report record News_Flow. Giữ dữ liệu report gốc và quyền owner trong MongoDB/chính sách ứng dụng.
4. Đảm bảo retry không tạo export trùng. Nếu CloudVault lỗi, hiển thị trạng thái thất bại và cho retry; không báo report đã có bản archive để tải.

### N5 — Bật archive HTML có chọn lọc

Chỉ bật sau khi report upload hoạt động. Bắt đầu bằng allowlist source nhỏ và giới hạn số lượng mỗi ngày. Có cấu hình tắt archive; khi tắt, việc crawl và lưu MongoDB/Kafka vẫn chạy. Với item đủ điều kiện, quyết định rõ lỗi CloudVault có chặn completion marker hay ghi vào hàng đợi retry; không được âm thầm bỏ qua lỗi archive.

## Tổ chức object và metadata gợi ý

```text
news-flow/reports/intelligence/YYYY/MM/DD/<report-id>.json
news-flow/reports/briefings/YYYY/MM/DD/<report-id>.pdf
news-flow/raw-html/<source>/YYYY/MM/<url-sha256>.html
```

Metadata gợi ý:

```json
{
  "project_id": "news-flow",
  "artifact_type": "selected_raw_html",
  "source": "<source-name>",
  "canonical_url": "<url>",
  "crawled_at": "<timestamp>",
  "expires_at": "<timestamp>",
  "sha256": "<digest>"
}
```

Không đưa token, dữ liệu cá nhân hoặc nội dung nhạy cảm chưa xử lý vào metadata hay object key.

## Danh sách cấu hình

- [ ] Đã tạo project, service account least-privilege, quota và retention.
- [ ] Chính sách hiển thị report khớp quyền owner/workspace.
- [ ] Chỉ crawler/report uploader cần thiết tham gia `cloudvault-shared`.
- [ ] Raw HTML chỉ upload theo lựa chọn, có giới hạn và metadata hết hạn.
- [ ] MinIO `raw-html` hiện tại vẫn hoạt động trong pilot và rollback.
- [ ] Lỗi CloudVault trở thành trạng thái retry/thất bại nhìn thấy được với item cần archive.
- [ ] Backup database hiện tại tiếp tục dùng đường backup độc lập.
- [ ] `file_id` được lưu cùng metadata report/archive liên quan.

## Tiêu chí nghiệm thu

- Export intelligence theo lịch chỉ upload một lần cho mỗi logical run và giữ đúng quyền user/workspace của News_Flow.
- Article không đủ điều kiện không bị upload; article được chọn có thể chống trùng và hết hạn theo policy.
- CloudVault gián đoạn không âm thầm đánh dấu archive hoàn tất hoặc làm dừng luồng crawl không liên quan.
- Token News_Flow không thể truy cập file project khác.
