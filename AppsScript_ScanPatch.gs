/* =========================================================================
   AppsScript_ScanPatch.gs — BỔ SUNG cho AppsScript.gs hiện có (không thay thế).
   Việc cần làm:
   1) Dán hàm appendScanOrphans_() bên dưới vào dự án Apps Script.
   2) Trong doPost(e), ở chỗ switch/if theo `action`, thêm 1 nhánh:
        if (data.action === 'appendScanOrphans') return json_(appendScanOrphans_(data.rows));
      (đổi `json_` thành hàm trả JSON bạn đang dùng cho các action khác, vd. updateRow).
   3) Deploy lại Web App (New version).
   Ghi chú: 3 cột «Phiếu scan», «Kiểm phiếu», «Kết quả đối chiếu phiếu» KHÔNG cần patch —
   updateRow_() sẵn có đã tự tạo cột chưa tồn tại (xem comment trong app.js, FIELD_MAP).
   ========================================================================= */
function appendScanOrphans_(rows) {
  var HEADERS = ['Thời gian', 'Biển số', 'Chủ hộ', 'CCCD', 'SĐT', 'Tình trạng', 'Ghi chú', 'Nguồn', 'Mã phiếu', 'Kiểm phiếu', 'Người thực hiện'];
  var KEYS = ['thoiGian', 'bienSo', 'chuHo', 'cccd', 'sdt', 'tinhTrang', 'ghiChu', 'nguon', 'maPhieu', 'kiem', 'nguoiThucHien'];
  if (!rows || !rows.length) return { ok: true, added: 0 };
  var lock = LockService.getScriptLock(); lock.waitLock(20000); // tránh 2 request ghi chồng nhau
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // Tab RIÊNG — KHÔNG đụng tab dữ liệu xe nên không làm tăng số xe cần rà soát.
    var sh = ss.getSheetByName('PhieuLa') || ss.insertSheet('PhieuLa');
    if (sh.getLastRow() === 0) { sh.appendRow(HEADERS); sh.setFrozenRows(1); }
    // Tab tạo từ bản patch trước (10 cột) chưa có cột «Người thực hiện» -> thêm tiêu đề cột 11
    else if (sh.getRange(1, HEADERS.length).getValue() === '') sh.getRange(1, HEADERS.length).setValue(HEADERS[HEADERS.length - 1]);
    // Chống ghi trùng: bỏ qua nếu (Mã phiếu + Biển số) đã có.
    var last = sh.getLastRow(), seen = {};
    if (last > 1) sh.getRange(2, 1, last - 1, HEADERS.length).getValues().forEach(function (r) { seen[r[8] + '|' + r[1]] = true; });
    var out = [];
    rows.forEach(function (o) {
      if (seen[o.maPhieu + '|' + o.bienSo]) return;
      out.push(KEYS.map(function (k) { return o[k] == null ? '' : String(o[k]); }));
    });
    if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, HEADERS.length).setValues(out);
    return { ok: true, added: out.length };
  } finally { lock.releaseLock(); }
}
