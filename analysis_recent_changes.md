# Báo cáo Phân tích Thay đổi (Changelog Analysis)

Bản commit mới nhất (`6c6ccd6c`) tập trung giải quyết các bài toán về **Bảo mật (Security)**, **Tối ưu Hiệu năng (Performance/Memory)**, và **Cải thiện Trải nghiệm Người dùng (UI/UX)**. Dưới đây là phân tích chi tiết về những thay đổi cốt lõi:

## 1. Nâng cấp Bảo mật & Quản lý Token (Security Enhancements)
- **Kiểm tra Token bị thu hồi (Blacklisted Tokens):** Cả `file-service` và `metadata-service` đã được bổ sung kết nối tới `Redis`. Khi decode JWT, hệ thống sẽ kiểm tra xem `jti` (JWT ID) có nằm trong danh sách đen của Redis hay không. Điều này đảm bảo khi người dùng đăng xuất (`/auth/logout`), token cũ sẽ lập tức vô hiệu hóa trên toàn hệ thống (không phải chờ đến khi token tự hết hạn).
- **Kiểm tra loại Token:** Bổ sung logic kiểm tra `payload.get("type") == "access"` để ngăn chặn việc dùng nhầm `refresh_token` cho các API yêu cầu `access_token`.
- **Khóa tài khoản (Account Deactivation):** Cột `is_active` được thêm vào bảng `users`. Mọi API giờ đây sẽ kiểm tra trạng thái này; nếu tài khoản bị khóa, mọi thao tác truy cập sẽ trả về `401 Unauthorized`.
- **Sửa lỗi Phân quyền Thư mục (Inherited Permissions):** Hàm `verify_file_access` ở `file-service` trước đây dùng `folder_obj.path.split('/')` bị sai logic (do `path` lưu tên chứ không phải ID). Đoạn code mới đã được viết lại để duyệt ngược lên cây thư mục (`parent_id`) bằng Database, đảm bảo tính toán quyền truy cập kế thừa chính xác tuyệt đối.

## 2. Tối ưu Hiệu năng Cốt lõi & Fix Memory Leak
- **Stream Upload Files (`file-service`):** API tải file lên (`upload_file`) trước đây đọc toàn bộ file vào RAM (`content = await file.read()`), có thể gây sập server nếu tải file lớn (VD: file vài GB). Thay đổi mới đã chuyển sang đọc theo từng chunk nhỏ (`chunk = await file.read(1024 * 1024)`) và cập nhật checksum liên tục, sau đó dùng trực tiếp `file.file` (một dạng SpooledTemporaryFile) để stream lên MinIO.
- **Dọn dẹp triệt để (Permanent Delete):** Tính năng xóa vĩnh viễn đã được sửa lại: 
  - Chỉ cho phép xóa khi file thực sự nằm trong thùng rác (`is_deleted == True`).
  - Lặp qua tất cả các phiên bản (File Versions) và xóa toàn bộ object vật lý tương ứng trên MinIO (bao gồm cả ảnh thumbnail).
  - Cập nhật chính xác lại `user.storage_used` sau khi xóa.

## 3. Quản trị Rủi ro Giải nén ZIP (`zip-extractor-worker`)
Các luồng tấn công **Zip Bomb** đã được ngăn chặn bằng các lớp bảo vệ dày đặc:
- Không còn đọc toàn bộ file zip vào RAM. Code dùng `SpooledTemporaryFile` để tải zip file tạm thời về ổ đĩa cứng hoặc RAM với kích thước an toàn.
- **Áp dụng các Giới hạn Tối đa (Quotas & Limits):**
  - `MAX_ZIP_ENTRIES` (Mặc định 1000): Không giải nén nếu file zip chứa quá nhiều file con.
  - `MAX_ZIP_UNCOMPRESSED_BYTES` (500MB): Dừng ngay nếu dung lượng thực tế sau giải nén vượt quá giới hạn.
  - `MAX_ZIP_COMPRESSION_RATIO`: Đánh dấu là file độc hại (Zip Bomb) nếu tỷ lệ nén cao một cách bất thường.
  - Tính toán trước tổng dung lượng và **Lock (FOR UPDATE)** user profile trong database để kiểm tra giới hạn `storage_quota`. Nếu vượt quá quota, sẽ hủy thao tác giải nén.
- **Rollback tự động:** Nếu đang giải nén dở dang mà gặp lỗi, worker sẽ tự động dọn dẹp các object vừa mới upload lên MinIO để tránh rác (garbage).

## 4. UI/UX & Client Logic
- Sửa lỗi Retry Logic trong `frontend/src/lib/api.ts`: API Client giờ đây handle các lỗi 400/404 từ API một cách mượt mà và trả lỗi về giao diện, thay vì ép người dùng đăng xuất (lỗi đã thảo luận trước đó).
- Nâng cấp một loạt màn hình như Dashboard, Share, Recent, Search, Activity và NotificationProvider để hiển thị trạng thái mượt mà và trực quan hơn.
- Cập nhật `frontend/src/lib/crypto.ts` nhằm tinh chỉnh các luồng liên quan tới chia sẻ có mật khẩu hoặc mã hóa.

---
**Tóm tắt:** Bản cập nhật này biến hệ thống từ một bản thiết kế tốt trở thành một hệ thống thực sự an toàn (Production-ready), có khả năng chống chọi tốt với tải trọng lớn và các hành vi tấn công mã hóa/lưu trữ cơ bản.
