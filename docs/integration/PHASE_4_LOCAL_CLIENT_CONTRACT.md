# Giai đoạn 4 — Hợp đồng client và Docker network local

## 1. Mô hình mạng

CloudVault giữ mạng riêng cho database, Redis, RabbitMQ và MinIO. Gateway Nginx
là service duy nhất được nối thêm vào mạng dùng chung `cloudvault-shared` với
alias `cloudvault-api`.

Mỗi stack client chỉ nối đúng service thực hiện upload/download vào mạng ngoài:

```yaml
services:
  artifact-uploader:
    networks:
      - default
      - cloudvault-shared

networks:
  cloudvault-shared:
    external: true
    name: cloudvault-shared
```

Client trong container gọi `http://cloudvault-api`. Trình duyệt hoặc tiến trình
chạy trên host phải dùng URL host, ví dụ `http://localhost`, vì hostname Docker
không phân giải được bên ngoài network.

## 2. Cấu hình client tối thiểu

```dotenv
CLOUDVAULT_ENABLED=true
CLOUDVAULT_BASE_URL=http://cloudvault-api
CLOUDVAULT_PROJECT_ID=ecommerce
CLOUDVAULT_SERVICE_TOKEN=cvp_replace_me
CLOUDVAULT_CONNECT_TIMEOUT_SECONDS=5
CLOUDVAULT_READ_TIMEOUT_SECONDS=60
CLOUDVAULT_MAX_RETRIES=3
```

Token phải nằm trong secret/runtime environment, không commit vào repo, image,
log hoặc XCom. Mỗi project dùng token riêng và chỉ cấp các scope cần thiết.

## 3. Trách nhiệm của wrapper

- Chuẩn hóa URL dưới `/api/v1/projects/{project_id}`.
- Gửi `Authorization: Bearer <service token>` và `Idempotency-Key`.
- Tính checksum SHA-256 và gửi metadata nhận diện logical run/artifact.
- Dùng timeout hữu hạn và retry có backoff cho lỗi tạm thời.
- Phân biệt lỗi có thể retry với lỗi cấu hình/quota/quyền.
- Trả `file_id` cho pipeline lưu cùng kết quả nghiệp vụ.
- Có feature flag để tắt CloudVault mà không phá luồng chính khi upload là tùy chọn.

## 4. Kiểm tra kết nối

```bash
docker network inspect cloudvault-shared
docker compose exec artifact-uploader getent hosts cloudvault-api
docker compose exec artifact-uploader curl -fsS http://cloudvault-api/health
```

Sau đó dùng một file nhỏ để kiểm tra upload, retry cùng idempotency key, liệt kê,
download và checksum. Không dùng credential MinIO để kiểm tra đường tắt.

## 5. Checklist an toàn

- Chỉ gateway có mặt trên cả mạng riêng và mạng dùng chung.
- Database, broker, Redis và MinIO không tham gia `cloudvault-shared`.
- Không đưa token vào source control hoặc log CI.
- Project ID trong URL phải khớp project của token.
- Source artifact chỉ được dọn sau khi bản CloudVault đã được xác minh và có chính
  sách retention/backup phù hợp.
