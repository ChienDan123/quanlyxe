# Hướng dẫn Deploy — Ứng dụng chạy 100% trên Google Apps Script

Gói này gồm **4 file**, tất cả dán vào **cùng một project Apps Script**:

| File | Vai trò |
|---|---|
| `Code.gs` | Server: phục vụ giao diện + đọc/ghi Google Sheet |
| `Index.html` | Khung giao diện chính (HTML) |
| `Style.html` | Toàn bộ CSS (giao diện, responsive) |
| `JavaScript.html` | Toàn bộ logic phía trình duyệt (lọc, panel chi tiết, xuất Bản cam kết...) |

Không còn file `.js`/`.css` rời và **không cần dán URL Apps Script vào đâu cả** —
ứng dụng tự gọi thẳng tới Sheet ngay khi mở trang, vì nó chạy sẵn bên trong
Apps Script rồi. Bạn chỉ cần Deploy **một lần** và có 1 link duy nhất, mở
được trên máy tính khác, điện thoại, không cần cài đặt gì thêm.

---

## Bước 1 — Chuẩn bị Google Sheet dữ liệu

Mở Google Sheet chứa dữ liệu xe. Tab (sheet) chứa dữ liệu, mặc định đặt tên
là **`Data`**, cần có dòng 1 là tiêu đề cột, đúng thứ tự/tên như sau (có thể
thêm cột khác ở cuối, không sao):

```
STT | Mã ID | MOTO_ID | Số khung | Số máy | Biển số | Màu biển | Nhãn hiệu |
Loại xe | Chủ phương tiện | Số CCCD/MST | Địa chỉ đăng ký |
Phường/Xã mới (2026) | Ngày đăng ký | Trạng thái ĐK | Trạng thái xe |
Ngày ĐK đầu | Mã điểm ĐK | Tên điểm ĐK | Đơn vị quản lý | Số điện thoại | Ghi Chú
```

Nếu tab dữ liệu của bạn tên khác `Data`, bạn sẽ sửa lại ở Bước 3.

## Bước 2 — Tạo project Apps Script gắn liền với Sheet

1. Trong Google Sheet, vào menu **Tiện ích mở rộng (Extensions) → Apps Script**.
   (Cách này tạo ra một "bound script" — script này tự động biết Sheet nào
   là Sheet của mình, không cần cấu hình ID gì cả.)
2. Trình soạn thảo Apps Script mở ra với sẵn 1 file `Code.gs` trống (hoặc có
   sẵn `function myFunction() {}`) — **xoá hết nội dung mẫu đó đi**.

## Bước 3 — Dán code vào 4 file

1. **Code.gs**: dán toàn bộ nội dung file `Code.gs` (đi kèm gói này) vào,
   thay thế hoàn toàn nội dung cũ.
   - Sửa hằng số `const SHEET_NAME = 'Data';` cho đúng tên tab chứa dữ liệu
     của bạn nếu khác `"Data"`.
2. Bấm dấu **+** cạnh "Files" → chọn **HTML** → đặt tên chính xác là
   `Index` (Apps Script tự thêm đuôi `.html`) → dán nội dung file
   `Index.html` vào.
3. Lặp lại: bấm **+** → **HTML** → đặt tên `Style` → dán nội dung
   `Style.html` vào.
4. Lặp lại: bấm **+** → **HTML** → đặt tên `JavaScript` → dán nội dung
   `JavaScript.html` vào.
5. Bấm biểu tượng 💾 (Lưu project) hoặc Ctrl/Cmd+S.

> ⚠️ Tên file phải đúng **`Index`**, **`Style`**, **`JavaScript`** (không dấu,
> không khoảng trắng) vì `Code.gs` gọi đúng các tên này qua hàm `include()`.

## Bước 4 — Deploy thành Ứng dụng web (Web App)

1. Góc trên bên phải, bấm **Triển khai (Deploy) → Triển khai mới (New deployment)**.
2. Bấm biểu tượng bánh răng cạnh "Select type" → chọn **Ứng dụng web (Web app)**.
3. Điền:
   - **Mô tả**: tuỳ ý, ví dụ "Bản 1".
   - **Thực thi với quyền của (Execute as)**: **Tôi (Me)**.
   - **Người có quyền truy cập (Who has access)**: **Bất kỳ ai (Anyone)** —
     để mở được từ máy khác/điện thoại mà không cần đăng nhập Google. Nếu
     dữ liệu nhạy cảm và chỉ muốn nội bộ dùng, chọn **"Bất kỳ ai có Tài
     khoản Google"** hoặc **"Chỉ tôi"** tuỳ nhu cầu.
4. Bấm **Deploy (Triển khai)**.
5. Google sẽ yêu cầu **cấp quyền (Authorize access)**:
   - Chọn tài khoản Google của bạn.
   - Màn hình cảnh báo "Google chưa xác minh ứng dụng này" — đây là **bình
     thường** vì đây là script do chính bạn viết. Bấm **Advanced (Nâng cao)**
     → **Go to [tên project] (unsafe)** → **Allow (Cho phép)**.
6. Sau khi Deploy xong, bạn sẽ thấy **Web app URL** dạng:
   ```
   https://script.google.com/macros/s/AKfycb.................../exec
   ```
   **Copy URL này** — đó chính là địa chỉ ứng dụng của bạn.

## Bước 5 — Dùng trên máy khác / điện thoại

Mở URL `/exec` ở trên bằng trình duyệt bất kỳ (Chrome, Safari...) trên
máy tính khác hoặc điện thoại — ứng dụng sẽ tự tải dữ liệu từ Google Sheet
và hiển thị ngay, không cần cài đặt hay đăng nhập thêm gì (nếu chọn "Bất kỳ
ai" ở Bước 4). Có thể lưu URL này ra màn hình chính điện thoại như một app.

## Bước 6 — Mỗi khi sửa code, phải Deploy lại phiên bản mới

URL `/exec` **giữ nguyên vĩnh viễn**, nhưng mỗi khi bạn sửa lại `Code.gs`,
`Index.html`, `Style.html` hoặc `JavaScript.html`, thay đổi đó **chưa hiển thị
ngay** cho người dùng — bạn cần:

1. **Triển khai (Deploy) → Quản lý phiên bản triển khai (Manage deployments)**.
2. Bấm biểu tượng ✏️ (bút chì) ở bản deploy hiện tại.
3. Mục **Version**, chọn **New version (Phiên bản mới)**.
4. Bấm **Deploy**.

## Ghi chú bảo mật

- Vì chọn "Bất kỳ ai", **ai có URL `/exec` này đều mở được ứng dụng và xem/ghi
  được dữ liệu Sheet** (thông qua ứng dụng, không phải trực tiếp vào Sheet).
  Coi URL này như một chiếc chìa khoá — chỉ chia sẻ cho người cần dùng.
- Muốn hạn chế hơn, đổi "Who has access" thành "Anyone with Google account"
  (yêu cầu đăng nhập Google) trong Bước 4, hoặc quản lý qua nhóm/Workspace
  của bạn nếu dùng Google Workspace.
- File `AppsScript.gs` cũ (kiểu API riêng để gọi từ một trang HTML host
  ngoài) không còn cần thiết với cách dùng mới này, nhưng `Code.gs` mới vẫn
  giữ khả năng trả JSON qua `?action=read`/`?action=settings` nếu bạn từng có
  nhu cầu đó — không bắt buộc phải dùng.

## Câu hỏi thường gặp

**Tôi có 2 Google Sheet, script chạy nhầm Sheet khác?**
Nếu bạn mở Apps Script từ đúng menu "Tiện ích mở rộng" của Sheet dữ liệu
(Bước 2), script luôn tự gắn với đúng Sheet đó — không cần chỉnh gì thêm.
Chỉ khi bạn tạo project Apps Script "độc lập" riêng (không qua Sheet) thì
mới cần điền ID Sheet vào biến `SHEET_ID` ở đầu `Code.gs`.

**Muốn quay lại cách cũ (host web tách riêng + Apps Script chỉ làm API)?**
Vẫn được — `Code.gs` mới tương thích ngược: gọi `.../exec?action=read` vẫn
trả JSON như file `AppsScript.gs` cũ. Bạn có thể dùng lại `index.html` /
`style.css` / `app.js` cũ với `GAS_URL` trỏ vào `/exec` này nếu muốn.
