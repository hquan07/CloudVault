# Tích hợp Real-Time Stock Prediction Pipeline với CloudVault

**Repo đích:** `Real-Time_Stock_Prediction_Pipeline`  
**CloudVault project ID:** `real-time-stock`  
**Trạng thái:** Hướng dẫn tích hợp; cần triển khai CloudVault API dành cho máy/project trước khi bật client.

## Mục đích và ranh giới

Dùng CloudVault làm catalog/bản sao bền vững theo project cho model version đã kiểm định và output dự đoán gọn. Trong đợt đầu, giữ database PostgreSQL thị trường/dự đoán, checkpoint streaming, log Airflow, file model đang làm việc và artifact store MLflow trong project Stock.

Repo có model registry cục bộ theo version tại `src/machine_learning/artifacts/registry`, ghi `model.pkl`, `scaler.pkl` và `metadata.json`; đồng thời có artifact theo ticker tại `src/machine_learning/artifacts` và `src/deep_learning/artifacts`. Compose mount các artifact đó vào Airflow và cấu hình volume MLflow. Inference hiện tải model từ registry local. Ban đầu CloudVault chỉ nhận bản sao đã kiểm định; chưa chuyển inference sang phụ thuộc download từ xa.

## Nhóm file ban đầu đưa lên CloudVault

Bắt đầu với:

- model bundle đã kiểm định (model, scaler/tokenizer nếu cần, metadata, schema feature, metric đánh giá, phiên bản runtime/thư viện);
- export tín hiệu/dự đoán JSON hoặc CSV theo ngày, dung lượng nhỏ;
- summary feature importance hoặc forecast đã chọn.

Giữ trong project:

- dữ liệu thị trường và các bảng PostgreSQL;
- log Airflow, dữ liệu Kafka, checkpoint Spark, mảng/file training tạm;
- các lần training lỗi, dở dang, chưa kiểm định hoặc đã thay thế, trừ khi retention yêu cầu rõ ràng;
- storage MLflow hiện tại cho đến khi có kế hoạch di chuyển artifact riêng.

## Các giai đoạn tích hợp

### S1 — Chốt hợp đồng artifact và tính tương thích

1. Tạo project `real-time-stock` và service account cho workload training/report.
2. Thống nhất model family và phạm vi ticker được phép, kích thước bundle tối đa, quota, retention và người có thể tải model.
3. Định nghĩa manifest gồm model version, loại model, phạm vi ticker, tên/thứ tự feature, target, cửa sổ training, metric, phiên bản Python/thư viện, định dạng serialize, thời điểm tạo và checksum.
4. Chốt thời điểm publish artifact: chỉ sau khi training, validation và lưu registry local đều thành công.

### S2 — Cấu hình network và uploader

Chỉ nối runtime task Airflow hoặc publisher service riêng vào `cloudvault-shared`. Giữ PostgreSQL, Redis, Kafka, Spark, dashboard và MLflow trong network hiện tại của Stock.

```yaml
services:
  airflow-scheduler:
    environment:
      CLOUDVAULT_BASE_URL: ${CLOUDVAULT_BASE_URL}
      CLOUDVAULT_PROJECT_ID: real-time-stock
      CLOUDVAULT_SERVICE_TOKEN: ${CLOUDVAULT_SERVICE_TOKEN}
    networks:
      - default
      - cloudvault-shared

networks:
  cloudvault-shared:
    external: true
    name: cloudvault-shared
```

Đây là phác thảo; cần xác nhận thành phần Airflow nào thực sự thực thi training task và dùng chung đường dẫn artifact. Chỉ cấp network cho nơi cần thiết. Dùng alias gateway CloudVault, không dùng `localhost`. Không cấp credential MinIO cho project Stock.

### S3 — Publish model version đã kiểm định

1. Để `ModelRegistry.save_model` ghi version vào thư mục local như hiện tại.
2. Chạy validation và lưu kết quả. Chỉ upload nếu validation đạt.
3. Tạo manifest và checksum cho từng file trong bundle; từ chối thiếu/thừa file ngoài dự kiến và kiểm tra ngưỡng kích thước.
4. Upload bằng idempotency key lấy từ model version bất biến. Không âm thầm ghi đè version đã có.
5. Lưu CloudVault `file_id`, version, checksum và trạng thái publish vào metadata registry/MLflow phù hợp.
6. Giữ artifact local nguyên vẹn nếu CloudVault upload lỗi; báo lỗi publish tách biệt với trạng thái training thành công.

Trong giai đoạn đầu, `latest.json` hiện có vẫn là con trỏ inference local. Chưa đổi sang object CloudVault cho đến khi thiết kế xong download từ xa, xác minh checksum/tương thích, fallback khi gián đoạn và rollback.

### S4 — Publish output dự đoán gọn

Thêm bước export tường minh vào DAG tín hiệu/dự đoán phù hợp, sau khi kết quả đã commit. Gồm logical date, ticker, thời điểm tạo, model version và liên kết `file_id` nếu cần. Database vẫn là nguồn truy vấn vận hành; CloudVault dùng cho report/snapshot portable, không thay time-series database.

### S5 — Tùy chọn khôi phục model từ xa

Chỉ làm nếu có nhu cầu portability/khôi phục thực tế. Download theo `file_id` vào đường dẫn tạm, xác minh mọi checksum trong manifest và tính tương thích, sau đó chuyển nguyên tử vào registry local và giữ version chạy trước để rollback. Nếu xác minh lỗi, tuyệt đối không thay model đang hoạt động.

## Tổ chức object và manifest gợi ý

```text
real-time-stock/models/<model-type>/<version>/model.pkl
real-time-stock/models/<model-type>/<version>/scaler.pkl
real-time-stock/models/<model-type>/<version>/metadata.json
real-time-stock/reports/predictions/YYYY/MM/DD/<run-id>.json
```

Trường manifest ví dụ:

```json
{
  "project_id": "real-time-stock",
  "artifact_type": "validated_model_bundle",
  "version": "<immutable-version>",
  "model_type": "random_forest",
  "tickers": ["<approved-scope>"],
  "features": ["<ordered-feature-list>"],
  "metrics": {},
  "python_version": "<version>",
  "dependencies": {},
  "files": [{"name": "model.pkl", "sha256": "<digest>", "size_bytes": 0}]
}
```

File pickle có thể thực thi code khi nạp. Chỉ tin artifact tải về sau khi xác minh quyền project, nguồn, checksum và môi trường tương thích; không xem pickle tùy ý do người dùng upload là model có thể deploy.

## Danh sách cấu hình

- [ ] Đã tạo project và service account có quyền tối thiểu.
- [ ] Giới hạn bundle/file và quota tính đến lịch sử model version được giữ lại.
- [ ] Chỉ upload sau khi validation và lưu local thành công.
- [ ] Version/idempotency key bất biến; không ghi đè âm thầm.
- [ ] Manifest có schema feature, version môi trường, metric và checksum.
- [ ] CloudVault `file_id` được lưu cùng metadata registry local/MLflow.
- [ ] CloudVault gián đoạn không làm hỏng trạng thái training hoặc artifact inference local.
- [ ] Tắt khôi phục model từ xa cho đến khi có checksum/tương thích/rollback.
- [ ] Dữ liệu thị trường và database vận hành không chuyển vào CloudVault.

## Tiêu chí nghiệm thu

- Model version đã kiểm định upload và download độc lập được bằng service account Stock có quyền.
- Checksum khớp; retry không tạo model version trùng.
- Bundle thiếu hoặc chưa kiểm định không được publish.
- Upload CloudVault thất bại nhưng model local vẫn dùng được, trạng thái publish thể hiện chưa thành công.
- Credential Stock không thể truy cập file E-commerce hoặc News_Flow.
