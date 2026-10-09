# Việc còn lại trong scan.js (file này chưa được gửi lên nên tôi chưa sửa được)

scan-review.js đã sẵn sàng nhận 2 khóa MỚI trên TỪNG XE (trong `extracted.vehicles[i]`):

| Khóa              | Lấy từ chỗ nào trên phiếu                          |
|-------------------|-----------------------------------------------------|
| `tenDKX`          | ô «Tên trong ĐKX» của dòng xe (chủ phương tiện)     |
| `nguoiMuaSuDung`  | dòng «Tên người mua / người sử dụng» của dòng xe    |

Để trống chuỗi "" nếu dòng xe không ghi. (Tên khóa khác cũng được chấp nhận: tenTrongDKX, chuPhuongTien /
nguoiMua, nguoiSuDung — xem VEH_OWNER_KEYS / VEH_USER_KEYS trong scan-review.js.)

## Đoạn thêm vào prompt Gemini
- "chuHo" ở đầu phiếu là CHỦ PHIẾU (người khai), KHÔNG mặc định là chủ xe.
- Với MỖI xe, đọc riêng: "tenDKX" = tên ghi ở ô «Tên trong ĐKX» (chủ phương tiện);
  "nguoiMuaSuDung" = tên ghi ở dòng «Tên người mua / người sử dụng».
- Nếu dòng xe KHÔNG ghi tên thì để "" (đừng tự điền tên chủ phiếu vào).

## Schema (nếu scan.js dùng responseSchema): thêm 2 trường string vào object của vehicles[]
tenDKX: { type: "STRING" }, nguoiMuaSuDung: { type: "STRING" }
