# Giai đoạn 4 — Kết nối Compose local và hợp đồng client

## 1. Ranh giới mạng

CloudVault dùng hai mạng Docker:

- `cloudvault-network`: mạng riêng chứa frontend, API nội bộ, MySQL, MinIO, Redis, Kafka và các worker;
- `cloudvault-shared`: mạng ngoài chỉ dành cho Nginx gateway và đúng container client của các project.

Nginx có alias ổn định `cloudvault-api`. Client trong container gọi
`http://cloudvault-api`; không gọi trực tiếp MinIO, MySQL hoặc hostname nội bộ
khác của CloudVault.

Tạo network một lần trước khi khởi động Compose:

```bash
./scripts/setup_shared_network.sh
docker compose up -d
```

## 2. Cấu hình client thống nhất

Mỗi uploader nhận cấu hình từ biến môi trường, không commit token:

| Biến | Ý nghĩa |
|---|---|
| `CLOUDVAULT_BASE_URL` | URL gateway, mặc định trong Docker là `http://cloudvault-api` |
| `CLOUDVAULT_PROJECT_ID` | Slug cố định: `ecommerce`, `news-flow` hoặc `real-time-stock` |
| `CLOUDVAULT_SERVICE_TOKEN` | Token `cvp_...` của service account đúng project |
| `CLOUDVAULT_CONNECT_TIMEOUT_SECONDS` | Timeout mở kết nối |
| `CLOUDVAULT_READ_TIMEOUT_SECONDS` | Timeout đọc phản hồi |
| `CLOUDVAULT_MAX_RETRIES` | Số lần retry lỗi mạng, `429` và `5xx` |
| `CLOUDVAULT_RETRY_BASE_SECONDS` | Thời gian backoff cơ sở |
| `CLOUDVAULT_MAX_FILE_BYTES` | Giới hạn phía client, không thay thế giới hạn server |

Client wrapper ở mỗi repo thực hiện cùng một hợp đồng:

- gửi `Authorization: Bearer <service-token>`;
- dùng endpoint `/api/v1/projects/{project_id}/files/upload`;
- gửi `Idempotency-Key` ổn định theo artifact và logical run;
- tính SHA-256 trước upload và đưa `checksum_sha256` vào `metadata_json`;
- chỉ retry lỗi kết nối/timeout, HTTP `429` và `5xx` với backoff có giới hạn;
- không retry lỗi xác thực, phân quyền, validation, quota hoặc xung đột idempotency;
- không ghi token hoặc nội dung file vào log;
- download qua gateway vào file tạm, kiểm tra checksum nếu có và thay thế đích theo cách nguyên tử.

## 3. Service tham gia mạng chung

| Repo | Service uploader được nối `cloudvault-shared` | Service không được nối |
|---|---|---|
| E-commerce | `airflow` | PostgreSQL, MinIO, Kafka, Spark, dashboard |
| News_Flow | `airflow-scheduler` | MongoDB, ClickHouse, PostgreSQL, MinIO, Kafka, Spark, API/UI |
| Real-Time Stock | `airflow-scheduler` | PostgreSQL, Kafka, Spark, MLflow, Redis, dashboard |

Việc có network và client wrapper chưa tự động upload dữ liệu. Các giai đoạn
5–7 mới nối wrapper vào bước sinh artifact thật của từng pipeline.

## 4. Kiểm tra nghiệm thu local

Sau khi CloudVault đang chạy:

```bash
docker network inspect cloudvault-shared
docker run --rm --network cloudvault-shared nginx:1.25-alpine \
  wget -qO- http://cloudvault-api/health/auth
```

Kết quả network phải chỉ có gateway CloudVault và uploader đang được bật. Các
hostname `mysql`, `minio`, `redis`, `kafka` của CloudVault không được phân giải
từ container chỉ tham gia `cloudvault-shared`.

Trước khi bật upload thật, tạo project và service account trong giao diện
CloudVault, lưu token vào `.env` cục bộ của repo tương ứng và không đưa `.env`
hoặc token vào Git.
