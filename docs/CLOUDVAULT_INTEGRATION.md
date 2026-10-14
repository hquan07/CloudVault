# CloudVault Integration Architecture

> **Status:** Proposed architecture  
> **Environment:** Local development, Docker Compose  
> **Core stack:** CloudVault API, MinIO, PostgreSQL, Apache Airflow

## 1. Tổng quan

CloudVault hiện là dự án lưu trữ cá nhân sử dụng **MinIO** làm object storage. Ý tưởng mở rộng là biến CloudVault thành **dịch vụ lưu trữ tập trung (Centralized Storage Service)** để nhiều dự án độc lập có thể lưu và truy xuất file qua một REST API thống nhất.

Các dự án tích hợp ví dụ:

- **E-commerce:** ảnh sản phẩm, hóa đơn, báo cáo doanh thu CSV/PDF/Parquet.
- **Banking:** chứng từ, báo cáo giao dịch và báo cáo phát hiện gian lận (dữ liệu nhạy cảm cần kiểm soát nghiêm ngặt).
- **Finance:** báo cáo phân tích cổ phiếu, kết quả tính toán và export dữ liệu.
- **Data Engineering Platform:** raw datasets, processed outputs, snapshot và tài liệu pipeline.

**Nguyên tắc:** CloudVault lưu **file/object**, không thay thế database giao dịch của từng dự án. Mỗi dự án tiếp tục sở hữu database nghiệp vụ của mình và lưu `file_id`/tham chiếu trong database đó.

## 2. Mục tiêu và phạm vi

### Mục tiêu

1. Kết nối nhiều dự án Docker Compose chạy trên cùng máy local.
2. Dùng CloudVault API làm điểm truy cập thống nhất tới MinIO.
3. Phân tách dữ liệu, quyền truy cập và quota theo project/service account.
4. Tự động tạo và upload báo cáo định kỳ qua Apache Airflow.
5. Có monitoring, audit log, retry, backup và quy trình khôi phục.
6. Cho phép di chuyển sang nhiều host/VPS sau này mà không đổi hợp đồng API của client.

### Ngoài phạm vi giai đoạn đầu

- Thay thế PostgreSQL/MySQL nghiệp vụ bằng MinIO.
- Public file storage không kiểm soát quyền.
- High availability thực sự trên một máy local duy nhất.
- Cam kết tuân thủ quy định ngân hàng chỉ nhờ lưu file vào CloudVault.

## 3. Kiến trúc tổng thể

```mermaid
flowchart TB
    subgraph HOST["Local Docker Host"]
      subgraph SHARED["cloudvault-shared Docker network"]
        EC["E-commerce API"]
        BK["Banking API"]
        FN["Finance API"]
        AF["Airflow Worker / DAGs"]
        CV["CloudVault REST API"]
        EC -->|HTTPS/HTTP nội bộ + token| CV
        BK -->|API + token| CV
        FN -->|API + token| CV
        AF -->|Upload reports + token| CV
      end
      subgraph PRIVATE["CloudVault private network"]
        DB[("PostgreSQL metadata")]
        S3[("MinIO object storage")]
      end
      CV --> DB
      CV --> S3
      S3 --> VOL[("Persistent volume")]
    end
```

- **CloudVault API:** xác thực, kiểm tra quyền/quota, quản lý metadata và cấp quyền truy cập file.
- **PostgreSQL của CloudVault:** lưu project, service account, metadata file, audit log, quota và trạng thái upload.
- **MinIO:** lưu object thực tế, không lưu business records thay cho database dự án.
- **Airflow:** điều phối DAG lấy dữ liệu, tạo báo cáo, upload và theo dõi kết quả.
- **Docker:** mỗi dự án giữ Compose độc lập; chỉ backend cần thiết tham gia shared network.

## 4. Kết nối Docker Compose trên local

Tạo network một lần:

```bash
docker network create cloudvault-shared
```

### 4.1 CloudVault Compose (minh họa)

```yaml
services:
  cloudvault-api:
    build: ./backend
    environment:
      MINIO_ENDPOINT: minio:9000
      DATABASE_URL: postgresql://cloudvault:${DB_PASSWORD}@postgres:5432/cloudvault
    ports:
      - "127.0.0.1:8000:8000"
    networks:
      cloudvault-shared:
        aliases: [cloudvault-api]
      cloudvault-private: {}

  minio:
    image: minio/minio:<tested-version>
    command: server /data --console-address ':9001'
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - minio_data:/data
    networks: [cloudvault-private]

  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: cloudvault
      POSTGRES_USER: cloudvault
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks: [cloudvault-private]

networks:
  cloudvault-shared:
    external: true
  cloudvault-private:
    internal: true

volumes:
  minio_data:
  postgres_data:
```

> Đây là ví dụ cấu trúc, không phải cấu hình có thể chạy nguyên trạng: thay `<tested-version>`, điều chỉnh Dockerfile, biến môi trường và healthcheck. Backend CloudVault nên dùng **MinIO credentials giới hạn quyền**, không dùng root credentials trong ứng dụng. Với môi trường production, sử dụng TLS và cơ chế quản lý secrets phù hợp.

### 4.2 E-commerce Compose (minh họa)

```yaml
services:
  ecommerce-api:
    build: .
    environment:
      CLOUDVAULT_BASE_URL: http://cloudvault-api:8000
      CLOUDVAULT_API_TOKEN: ${CLOUDVAULT_API_TOKEN}
    networks:
      - ecommerce-private
      - cloudvault-shared

networks:
  ecommerce-private: {}
  cloudvault-shared:
    external: true
```

**Lưu ý networking:** `localhost` bên trong container là chính container đó. Dùng `http://cloudvault-api:8000` trên shared Docker network. Đặt alias duy nhất để tránh xung đột tên. Các database và MinIO không cần tham gia shared network.

## 5. Thiết kế API CloudVault

Các endpoint **đề xuất tự triển khai**, không phải API có sẵn của MinIO:

| Method | Endpoint | Chức năng |
|---|---|---|
| `POST` | `/api/v1/files` | Upload file nhỏ/vừa |
| `GET` | `/api/v1/files/{file_id}` | Xem metadata |
| `GET` | `/api/v1/files/{file_id}/download` | Download/redirect có kiểm soát |
| `DELETE` | `/api/v1/files/{file_id}` | Xóa mềm hoặc xóa theo policy |
| `GET` | `/api/v1/files?project_id=...` | Liệt kê file có phân quyền |
| `POST` | `/api/v1/uploads/presign` | Khởi tạo upload qua presigned URL |
| `POST` | `/api/v1/uploads/{upload_id}/complete` | Xác nhận object đã upload |
| `GET` | `/api/v1/projects/{project_id}/usage` | Dung lượng đã dùng/quota |
| `POST` | `/api/v1/reports/runs` | Ghi nhận metadata và trạng thái report run |

**Mẫu response upload:**

```json
{
  "file_id": "file_01JEXAMPLE",
  "project_id": "ecommerce",
  "filename": "sales_2026-10-11.csv",
  "content_type": "text/csv",
  "size_bytes": 12345,
  "status": "available"
}
```

Client lưu `file_id` trong database riêng, không phụ thuộc trực tiếp vào tên bucket hoặc object key.

## 6. Luồng upload và download

### 6.1 Upload thông qua CloudVault API

```mermaid
sequenceDiagram
    participant App as Project Backend
    participant API as CloudVault API
    participant DB as CloudVault PostgreSQL
    participant MinIO as MinIO
    App->>API: POST /files + service token + file
    API->>API: Verify token, project scope, quota, file policy
    API->>MinIO: PutObject
    MinIO-->>API: Success + object metadata
    API->>DB: Save metadata (file_id, project, key, checksum)
    API-->>App: 201 Created + file_id
```

Cần xử lý trường hợp ghi MinIO thành công nhưng ghi metadata thất bại (cleanup/reconciliation). Giới hạn kích thước file, content type, checksum và timeout.

### 6.2 Upload file lớn qua presigned URL

1. Client yêu cầu upload từ CloudVault và được xác thực/phân quyền.
2. CloudVault cấp URL có thời hạn, giới hạn key, size/type theo khả năng triển khai.
3. Client upload trực tiếp tới MinIO.
4. Client gọi `complete`; CloudVault kiểm tra object thực sự tồn tại, size/checksum rồi cập nhật trạng thái.

**Trên local:** presigned URL phải dùng hostname/port **truy cập được từ client thực hiện upload**. URL ký cho hostname nội bộ Docker thường không dùng được từ trình duyệt trên host; không được tùy ý thay hostname trong URL đã ký. Có thể dùng reverse proxy hoặc một endpoint phù hợp với cả client và MinIO.

### 6.3 Download

CloudVault xác thực quyền truy cập file theo project, sau đó stream nội dung hoặc cấp presigned download URL ngắn hạn. Không trả MinIO root credentials cho client.

## 7. Data isolation và metadata

### Gợi ý object key

```text
cloudvault-storage/
  personal/<user-id>/...
  ecommerce/reports/daily/2026/10/sales_2026-10-11.csv
  ecommerce/invoices/...
  banking/reports/transactions/...
  finance/reports/stock-performance/...
  data-platform/raw/...
  data-platform/processed/...
```

Prefix chỉ là cách tổ chức; **không tự động bảo đảm isolation**. CloudVault phải áp dụng authorization theo `project_id` và `service_account_id`. Khi cần cách ly mạnh hơn, dùng bucket/MinIO policy riêng theo dự án.

### Bảng metadata đề xuất

| Bảng | Trường quan trọng |
|---|---|
| `projects` | `id`, `name`, `status`, `quota_bytes` |
| `service_accounts` | `id`, `project_id`, `name`, `status`, `token_hash` |
| `files` | `id`, `project_id`, `object_key`, `filename`, `size_bytes`, `checksum`, `status`, `created_at` |
| `report_runs` | `id`, `project_id`, `report_type`, `logical_date`, `status`, `file_id`, `dag_run_id` |
| `audit_logs` | `id`, `actor_id`, `project_id`, `action`, `file_id`, `timestamp` |

Nên có unique constraint cho `(project_id, report_type, logical_date)` hoặc một idempotency key tương đương, tùy chính sách lưu phiên bản.

## 8. Airflow: tạo và lưu báo cáo định kỳ

### 8.1 Lịch báo cáo ví dụ

| Dự án | Báo cáo | Schedule (múi giờ cấu hình) | Định dạng |
|---|---|---|---|
| E-commerce | Daily Sales | `0 1 * * *` | CSV/Parquet |
| Banking | Transaction Summary | `0 2 * * *` | CSV/PDF |
| Finance | Stock Performance | `0 18 * * 1-5` | CSV/PDF |
| CloudVault | Storage Usage | `0 0 * * 0` | CSV |

### 8.2 Luồng DAG

```mermaid
flowchart LR
    A[Airflow Scheduler] --> B[Extract DB/API]
    B --> C[Transform / Aggregate]
    C --> D[Generate report]
    D --> E[Upload CloudVault API]
    E --> F[Persist file_id / report_run]
    E -->|failure| G[Retry + Alert]
```

**Task DAG gợi ý:** `extract_data >> transform_data >> generate_report >> upload_to_cloudvault >> record_report_run`.

- Mỗi DAG dùng connection và token của dự án tương ứng.
- Không đặt secret trong source code; dùng Airflow Connections, secret backend hoặc cơ chế secret phù hợp.
- Dùng logical date/data interval để xác định dữ liệu báo cáo, tránh phụ thuộc vào thời điểm chạy thực tế.
- Bảo đảm upload **idempotent** khi retry; có thể overwrite theo key xác định hoặc tạo version có kiểm soát.
- Báo cáo lớn không nên truyền binary qua XCom; dùng file tạm/volume chung hoặc object staging và chỉ truyền tham chiếu.
- Đặt `retries`, `retry_delay`, timeout, SLA/alert phù hợp; cân nhắc giới hạn concurrency.
- Tránh dùng một token quyền rộng cho tất cả DAG. Airflow dùng chung là tiện cho local, nhưng không phải ranh giới bảo mật cứng giữa các DAG.

### 8.3 Báo cáo trạng thái

CloudVault có thể hiển thị: project, loại báo cáo, logical date, file, dung lượng, thời gian hoàn tất, trạng thái `PENDING/RUNNING/SUCCESS/FAILED` và link download có phân quyền.

Nếu DAG thất bại trước khi gọi CloudVault, hệ thống cần **Airflow failure callback/notification** hoặc cơ chế đối soát để CloudVault biết báo cáo bị thiếu; không thể chỉ dựa vào callback ở task upload.

## 9. Bảo mật và vận hành

- **Authentication:** service account/token riêng theo project, lưu hash hoặc dùng token xác minh an toàn; hỗ trợ rotation/revocation.
- **Authorization:** project-scoped RBAC, deny-by-default; không cho dự án đọc file dự án khác.
- **MinIO:** không lộ root key; least-privilege credentials; bucket policy phù hợp.
- **Network:** tách shared/private Docker networks; local chỉ publish port cần thiết lên `127.0.0.1`; dùng TLS khi vượt ranh giới máy/host.
- **Input security:** kiểm tra file size, MIME/content validation, tên file, checksum; scan malware nếu nhận file không tin cậy.
- **Sensitive data:** mã hóa at rest/in transit, retention policy, audit, masking/anonymization với dữ liệu ngân hàng và dữ liệu cá nhân.
- **Quota/rate limits:** giới hạn theo project, chống lạm dụng upload và hết dung lượng.
- **Consistency:** xử lý orphan objects, metadata thất bại, incomplete multipart uploads.
- **Backups:** backup cả MinIO objects **và** PostgreSQL metadata; sao lưu ra thiết bị/host khác, định kỳ test restore.

## 10. Monitoring, alerts và failure handling

| Thành phần | Metrics/cảnh báo cần theo dõi |
|---|---|
| CloudVault API | request rate, p95/p99 latency, 4xx/5xx, upload success rate |
| MinIO | storage usage, object errors, throughput, disk capacity |
| PostgreSQL | connections, slow queries, disk usage, replication/backup nếu có |
| Airflow | DAG success/failure, task duration, retries, scheduler health |
| Docker host | CPU, RAM, disk I/O, disk free, container restarts |

**Ngưỡng minh họa** (cần điều chỉnh theo workload): cảnh báo disk usage >80%, critical >90%; API 5xx >2% trong 5 phút; DAG báo cáo không hoàn tất sau deadline.

**Failure scenarios:**

1. **CloudVault down:** client timeout nhanh, retry exponential backoff + jitter cho thao tác idempotent, không retry vô hạn.
2. **MinIO hết dung lượng:** từ chối upload mới có thông báo rõ ràng; alert sớm; retention/archival policy.
3. **PostgreSQL down:** chặn cập nhật metadata; reconciliation cho object upload dở dang.
4. **Airflow failed:** gửi alert, cho phép rerun an toàn không sinh báo cáo trùng.
5. **Host/volume hỏng:** restore từ backup độc lập; single local host không có HA.

## 11. Lộ trình triển khai

### Phase 1 — Local integration MVP

- [ ] Tạo `cloudvault-shared` network.
- [ ] Cho CloudVault API và E-commerce API kết nối network.
- [ ] Xây dựng upload/download API có authentication.
- [ ] Upload file thử nghiệm vào MinIO, lưu metadata PostgreSQL.
- [ ] E-commerce lưu `file_id` và tải lại file thành công.

**Acceptance:** Một dự án khác upload/download file qua CloudVault API, không có MinIO credentials.

### Phase 2 — Multi-project storage

- [ ] Tạo bảng projects/service_accounts/files.
- [ ] Áp dụng project-level authorization và quota.
- [ ] Tổ chức bucket/key prefix; audit log.
- [ ] Kiểm thử truy cập chéo bị từ chối.

**Acceptance:** Token E-commerce không thể xem hoặc xóa file Banking.

### Phase 3 — Airflow reports

- [ ] Triển khai Airflow Compose riêng và kết nối shared network.
- [ ] Tạo DAG Daily Sales (extract → aggregate → CSV → CloudVault).
- [ ] Lưu report run và file_id.
- [ ] Thử retry/rerun cùng logical date, xác nhận không tạo duplicate ngoài ý muốn.
- [ ] Bổ sung DAG Finance/Banking sau khi MVP ổn định.

**Acceptance:** Báo cáo chạy tự động đúng lịch và có thể tải qua CloudVault.

### Phase 4 — Reliability & observability

- [ ] Prometheus/Grafana + alerting.
- [ ] Disk quota/usage monitoring, rate limits.
- [ ] Backup cả objects và metadata, diễn tập restore.
- [ ] Load test k6/Locust (phân biệt concurrent users và concurrent uploads).
- [ ] Kiểm tra failure scenarios và runbook.

**Acceptance:** Phát hiện sớm lỗi storage và có quy trình phục hồi đã kiểm thử.

### Phase 5 — Optional production migration

- [ ] Reverse proxy/TLS, DNS, private networking.
- [ ] Secret manager, IAM/RBAC và audit nâng cao.
- [ ] Object storage/DB HA theo yêu cầu thực tế.
- [ ] CI/CD, versioned API, migration plan.

## 12. Cấu trúc repository gợi ý

```text
cloudvault/
├── backend/
├── frontend/
├── infrastructure/
│   ├── compose.yaml
│   └── monitoring/
├── docs/
│   └── CLOUDVAULT_INTEGRATION.md
└── README.md

ecommerce/
├── backend/
├── compose.yaml
└── airflow/                  # hoặc DAG đặt ở repo orchestration chung

data-orchestration/
├── dags/
│   ├── ecommerce_daily_report.py
│   ├── finance_stock_report.py
│   └── banking_transaction_report.py
└── compose.yaml
```

## 13. Kết luận

Mô hình đề xuất là **CloudVault Storage-as-a-Service trên Docker local**: các ứng dụng độc lập giao tiếp qua CloudVault REST API; CloudVault quản lý metadata và quyền truy cập, MinIO lưu object; Airflow định kỳ tạo và upload báo cáo. Đây là nền tảng có thể mở rộng cho backup, data pipeline artifacts, reporting và archival, đồng thời giữ ranh giới sở hữu dữ liệu giữa các dự án.
