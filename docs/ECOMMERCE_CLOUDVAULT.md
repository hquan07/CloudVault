# Tích hợp E-commerce Data Platform với CloudVault

**Repo đích:** `ecommerce-data-platform`  
**CloudVault project ID:** `ecommerce`  
**Trạng thái:** Network và client contract Giai đoạn 4 đã triển khai; chưa bật upload report của Giai đoạn 5.

## Mục đích và ranh giới

Dùng CloudVault cho các artifact hoàn tất đã chọn, cần truy cập bền vững bên ngoài stack E-commerce. Giữ data lake MinIO và database hiện tại của project.

Repo hiện có MinIO riêng và sử dụng S3 theo bucket. `src/ingestion/batch/load_olist.py` tải CSV Olist thô lên; `src/processing/batch/transform_olist.py` đọc đường dẫn `s3a://ecommerce-data/...`; Compose cấp credential MinIO cho app. Đây là luồng data lake và cần giữ nguyên trong đợt tích hợp đầu. DAG Airflow `ecommerce_batch_pipeline` hiện mô tả ingestion giả lập, sau đó chạy dbt và data quality; không được mặc định rằng đã có file báo cáo thật cho đến khi xác định bước export.

## Nhóm file ban đầu đưa lên CloudVault

Chỉ upload:

- báo cáo kinh doanh Daily Sales CSV hoặc Parquet sau khi có bước export thực tế;
- kết quả kiểm tra chất lượng dữ liệu gọn JSON/HTML sau khi kiểm tra thành công;
- artifact customer segmentation đã được duyệt và có version nếu service/người dùng khác cần dùng.

Giữ trong project:

- file Olist thô và toàn bộ Bronze/Silver lake;
- output trung gian/staging của Spark;
- dữ liệu PostgreSQL, Kafka, log Airflow, cache và file tạm;
- model chưa được kiểm định.

## Các giai đoạn tích hợp

### E1 — Khởi tạo project và cấu hình

1. Tạo project `ecommerce` trong CloudVault và service account cho workload tạo báo cáo (ưu tiên task Airflow hoặc backend worker chuyên dụng, không dùng trình duyệt/dashboard).
2. Chỉ cấp `files:create` và `files:read` nếu workload cần xác minh/tải file. Chỉ thêm `files:delete` khi có quy trình dọn file cụ thể.
3. Đặt hard quota và giới hạn kích thước từ số liệu capacity thực tế. Đặt retention cho report riêng với retention model artifact.
4. Thêm `CLOUDVAULT_BASE_URL` và project token qua cơ chế nạp secret của workload. Không dùng lại MinIO root credential, không commit token.

### E2 — Kết nối Docker local

Chỉ nối service thực hiện upload (ban đầu là runtime task Airflow hoặc app worker riêng) vào network ngoài `cloudvault-shared`. Giữ PostgreSQL, Airflow metadata DB, Kafka, Spark và MinIO của project trong network riêng/mặc định của E-commerce.

```yaml
services:
  airflow:
    environment:
      CLOUDVAULT_BASE_URL: ${CLOUDVAULT_BASE_URL}
      CLOUDVAULT_PROJECT_ID: ecommerce
      CLOUDVAULT_SERVICE_TOKEN: ${CLOUDVAULT_SERVICE_TOKEN}
    networks:
      - default
      - cloudvault-shared

networks:
  cloudvault-shared:
    external: true
    name: cloudvault-shared
```

Đây là ví dụ thay đổi; giữ nguyên cấu hình service hiện tại và chỉ gắn đúng uploader. Trong container, dùng alias Docker ổn định của gateway, ví dụ `http://cloudvault-api`; `localhost` không trỏ đến container khác. Gateway CloudVault tham gia shared network, còn MinIO và MySQL vẫn ở mạng riêng.

### E3 — Thêm client wrapper nhỏ

Wrapper đã được thêm tại `integrations/cloudvault.py` trong repo E-commerce và
được mount read-only vào container `airflow`. Wrapper cố định project
`ecommerce`; token tiếp tục được nạp từ `.env`/secret local.

Thêm một module client dùng lại trong E-commerce để:

- gửi credential project qua mạng nội bộ;
- đặt timeout kết nối/đọc rõ ràng;
- gửi idempotency key xác định từ report type và logical date của Airflow;
- gửi filename, MIME type, logical date, report type, checksum và metadata kích thước;
- retry lỗi mạng/5xx tạm thời với exponential backoff có giới hạn và jitter;
- không retry vô hạn lỗi xác thực, validation hoặc quota;
- trả `file_id` và trạng thái upload cho caller;
- không ghi token hoặc nội dung report vào log.

Đường dẫn API và cách auth phải khớp hợp đồng machine-client CloudVault đã triển khai. Endpoint hiện có `/api/v1/files/upload` đang dùng JWT người dùng; không gửi service token cho đến khi CloudVault hỗ trợ và phân quyền rõ ràng.

### E4 — Upload report thật từ Airflow

1. Xác định hoặc xây bước export report thật sau khi dbt/data-quality thành công; các bước hiện có chưa tự đảm bảo một đường dẫn artifact ổn định.
2. Ghi file tạm với filename xác định theo logical date.
3. Tính SHA-256 và kích thước; từ chối output rỗng hoặc lớn bất thường.
4. Upload với idempotency key xác định.
5. Lưu `file_id`, logical date, report type và trạng thái vào report-run record hoặc bảng metadata E-commerce phù hợp. Không truyền binary report qua XCom.
6. Chỉ xóa file tạm sau khi xác nhận upload; khi lỗi thì giữ file nguồn để retry.

### E5 — Mở rộng có kiểm soát

Sau khi report upload ổn định, cân nhắc thêm kết quả data quality gọn và bundle customer segmentation được duyệt. Giữ dataset raw/Silver/Gold vận hành trong storage hiện tại, trừ khi có nhu cầu chia sẻ/khôi phục được đo đạc và được cấp quota riêng.

## Tổ chức object và metadata gợi ý

```text
ecommerce/reports/daily-sales/YYYY/MM/DD/<logical-date>.parquet
ecommerce/quality/YYYY/MM/DD/<run-id>.json
ecommerce/models/customer-segmentation/<version>/...
```

Key chỉ là cách tổ chức nội bộ. Client E-commerce cần lưu `file_id` trả về; không phụ thuộc tên bucket hay object key nội bộ.

Metadata gợi ý:

```json
{
  "project_id": "ecommerce",
  "artifact_type": "daily_sales_report",
  "logical_date": "YYYY-MM-DD",
  "format": "parquet",
  "source_run_id": "<airflow-run-id>",
  "sha256": "<digest>"
}
```

## Danh sách cấu hình

- [ ] Đã tạo project và service account least-privilege trong CloudVault.
- [ ] Đã thống nhất hard quota, kích thước file tối đa và retention.
- [ ] Đã kiểm tra network gateway và URL từ đúng container uploader.
- [ ] Token được nạp qua secret, không nằm trong source control hoặc log.
- [ ] Đã có đường dẫn export report thật; không nhầm DAG mô phỏng là bước tạo file.
- [ ] Idempotency key gồm report type và logical date.
- [ ] Client lưu `file_id` và trạng thái upload.
- [ ] Dataset raw/Bronze/Silver vẫn hoạt động với MinIO của project.

## Tiêu chí nghiệm thu

- Một daily report thành công hiển thị ở Projects → E-commerce và tải được qua phân quyền CloudVault.
- Chạy lại cùng logical date có tính idempotent.
- Hết quota hoặc CloudVault gián đoạn thì file report local vẫn còn và DAG thể hiện trạng thái lỗi/có thể retry.
- Credential E-commerce không thể liệt kê, đọc hoặc xóa file của project khác.
