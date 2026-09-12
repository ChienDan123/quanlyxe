# Hướng dẫn kết nối Google Sheet 2 chiều

Gói này gồm 4 file:

| File | Vai trò |
|---|---|
| `index.html`, `style.css`, `app.js` | Ứng dụng web (mở `index.html` trên trình duyệt, hoặc host lên bất kỳ nơi nào — GitHub Pages, Netlify, server nội bộ...) |
| `AppsScript.gs` | Code backend chạy trên Google, dán vào Apps Script của chính Google Sheet dữ liệu |

## Vì sao cần Apps Script?

Google Sheet **không cho phép ghi dữ liệu trực tiếp từ JavaScript chạy trên trình duyệt** chỉ bằng API Key (API Key công khai chỉ đọc được sheet công khai, không ghi được và lộ key rất nguy hiểm). Cách an toàn, miễn phí, không cần server riêng là dùng **Google Apps Script Web App** làm cầu nối: nó chạy dưới quyền tài khoản Google của bạn, ứng dụng web chỉ gọi `fetch()` tới URL đó để đọc/ghi.

## Các bước cấu hình (làm 1 lần)

1. Mở Google Sheet chứa dữ liệu xe (dòng 1 là tiêu đề cột, đúng như cấu trúc: `STT | Mã ID | MOTO_ID | Số khung | Số máy | Biển số | Màu biển | Nhãn hiệu | Loại xe | Chủ phương tiện | Số CCCD/MST | Địa chỉ đăng ký | Phường/Xã mới (2026) | Ngày đăng ký | Trạng thái ĐK | Trạng thái xe | Ngày ĐK đầu | Mã điểm ĐK | Tên điểm ĐK | Đơn vị quản lý | Số điện thoại | Ghi Chú`).
2. Vào **Tiện ích mở rộng → Apps Script**.
3. Xoá code mẫu, dán toàn bộ nội dung `AppsScript.gs` vào.
4. Sửa dòng `const SHEET_NAME = 'Data';` thành đúng tên tab (sheet) chứa dữ liệu của bạn.
5. Bấm **Triển khai → Triển khai mới**:
   - Loại: **Ứng dụng web**
   - Thực thi với quyền của: **Tôi**
   - Người có quyền truy cập: **Bất kỳ ai**
6. Bấm **Deploy**, cấp quyền khi Google hỏi (chọn tài khoản → Advanced → Go to project (unsafe) → Allow — đây là bình thường vì đây là script do chính bạn viết).
7. Copy URL dạng `https://script.google.com/macros/s/AKfycb.../exec`.
8. Mở ứng dụng web → bấm **"🔗 Kết nối Google Sheet"** → tab **"Apps Script (Đọc + Ghi)"** → dán URL vào → **Kết nối & Tải dữ liệu**.

Từ giờ, mọi thay đổi Trạng thái xe / Ghi chú, và việc đánh dấu "Ngày xuất cam kết" khi tải file Word, sẽ được **ghi thẳng về đúng dòng trên Google Sheet gốc** — không chỉ lưu tạm trên trình duyệt.

> Mỗi lần bạn **sửa lại nội dung `AppsScript.gs`**, phải vào **Quản lý phiên bản triển khai (Manage deployments) → biểu tượng bút chì → Version: New version → Deploy** thì thay đổi mới có hiệu lực (URL `/exec` giữ nguyên, không cần dán lại).

## Chế độ dự phòng: CSV chỉ đọc

Nếu bạn chỉ cần xem/lọc/xuất Bản cam kết mà không cần ghi ngược về Sheet, có thể dùng tab **"CSV công khai (Chỉ đọc)"** — dán URL sheet đã "Xuất bản lên web" dạng CSV, giống cách cũ. Chế độ này không cần Apps Script nhưng cũng **không ghi được** Trạng thái xe/Ghi chú về Sheet (chỉ lưu tạm trên trình duyệt).

## Ghi chú bảo mật

- Web App Apps Script chạy dưới quyền của bạn — bất kỳ ai có URL `/exec` đều gọi được, nên **không chia sẻ URL này công khai** nếu dữ liệu nhạy cảm (CCCD, số điện thoại...). Coi URL này như một chiếc chìa khoá.
- Muốn chặt hơn, có thể thêm một "mã bí mật" (`?token=...`) và kiểm tra trong `doGet`/`doPost` trước khi cho đọc/ghi.
