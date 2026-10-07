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


/* =========================================================================
   PHẦN 2 — LƯU ẢNH / PDF PHIẾU SCAN ONLINE (Google Drive) để máy khác vẫn xem được và làm tiếp việc dở dang.
   Việc cần làm (ngoài mục 1–3 ở đầu file):
   1) Dán toàn bộ các hàm scan*_ bên dưới vào dự án Apps Script.
   2) Trong doPost(e) thêm các nhánh (cùng chỗ với appendScanOrphans):
        if (data.action === 'scanPut')       return json_(scanPut_(data));
        if (data.action === 'scanGet')       return json_(scanGet_(data));
        if (data.action === 'scanList')      return json_(scanList_());
        if (data.action === 'scanMetaBatch') return json_(scanMetaBatch_(data.ids));
   3) Deploy lại Web App (New version) và CHO PHÉP quyền Google Drive khi được hỏi.
   Cách lưu: thư mục «QuanLyXe_PhieuScan» trong Drive của CHỦ script, mỗi phiếu 3 file:
        <mã phiếu>__front (ảnh mặt 1) · <mã phiếu>__back (mặt 2) · <mã phiếu>__meta (JSON: dữ liệu đọc được + trạng thái đối chiếu).
   File để RIÊNG TƯ (không chia sẻ công khai); web chỉ lấy được qua Web App này. Mô tả mỗi file ghi sẵn các biển số để dễ tìm trong Drive.
   ========================================================================= */
var SCAN_FOLDER_NAME = 'QuanLyXe_PhieuScan';

function scanFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('SCAN_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* thư mục đã bị xóa -> tạo lại bên dưới */ } }
  var it = DriveApp.getFoldersByName(SCAN_FOLDER_NAME);
  var f = it.hasNext() ? it.next() : DriveApp.createFolder(SCAN_FOLDER_NAME);
  props.setProperty('SCAN_FOLDER_ID', f.getId());
  return f;
}
function scanName_(scanId, kind) { return String(scanId).replace(/[^\w\-]/g, '') + '__' + kind; }
function scanFile_(folder, name) { var it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; }

// Ghi (hoặc ghi đè) 1 file của phiếu. p = { scanId, kind:'front'|'back'|'meta', mime, b64 | text, plates }
function scanPut_(p) {
  if (!p || !p.scanId || !/^(front|back|meta)$/.test(p.kind)) return { ok: false, error: 'Thiếu scanId / kind' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var folder = scanFolder_(), name = scanName_(p.scanId, p.kind), f = scanFile_(folder, name);
    if (p.kind === 'meta') {
      if (f) f.setContent(p.text || '{}'); else f = folder.createFile(name, p.text || '{}', 'application/json');
    } else {
      var blob = Utilities.newBlob(Utilities.base64Decode(p.b64 || ''), p.mime || 'image/jpeg', name);
      if (f) f.setTrashed(true);                 // file nhị phân không sửa nội dung tại chỗ được -> thay bằng bản mới
      f = folder.createFile(blob);
    }
    f.setDescription('Biển số: ' + (p.plates || ''));
    return { ok: true, fileId: f.getId(), updated: f.getLastUpdated().getTime() };
  } finally { lock.releaseLock(); }
}
// Đọc 1 file ảnh/PDF về dạng base64 (web không truy cập thẳng Drive riêng tư được)
function scanGet_(p) {
  var f = scanFile_(scanFolder_(), scanName_(p.scanId, p.kind));
  if (!f) return { ok: false, error: 'Không thấy file trên Drive' };
  return { ok: true, mime: f.getMimeType(), b64: Utilities.base64Encode(f.getBlob().getBytes()) };
}
// Danh sách phiếu đã có online + thời điểm cập nhật (để máy khác biết phiếu nào mới)
function scanList_() {
  var it = scanFolder_().searchFiles("title contains '__meta'"), list = [];
  while (it.hasNext()) { var f = it.next(); list.push({ scanId: f.getName().replace('__meta', ''), updated: f.getLastUpdated().getTime() }); }
  return { ok: true, list: list };
}
// Lấy nội dung meta của nhiều phiếu 1 lượt (client gọi từng nhóm ~15 phiếu)
function scanMetaBatch_(ids) {
  var folder = scanFolder_(), metas = {};
  (ids || []).forEach(function (id) { var f = scanFile_(folder, scanName_(id, 'meta')); if (f) metas[id] = f.getBlob().getDataAsString(); });
  return { ok: true, metas: metas };
}
