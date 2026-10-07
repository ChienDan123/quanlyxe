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
        if (data.action === 'scanList')      return json_(scanList_(data));          // có tham số since (đồng bộ tăng dần)
        if (data.action === 'scanGetBatch')  return json_(scanGetBatch_(data));      // tải nhiều ảnh / 1 request
        if (data.action === 'scanMetaBatch') return json_(scanMetaBatch_(data.ids));
        if (data.action === 'scanInventory') return json_(scanInventory_());   // PHẦN 3: kho ảnh
        if (data.action === 'scanDelete')    return json_(scanDelete_(data));  // PHẦN 3: xóa phiếu / 1 mặt
        if (data.action === 'scanTextGet')   return json_(scanTextGet_(data)); // PHẦN 3: kho khóa mã hóa
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
  if (!p || !p.scanId || !/^(front|back|meta|keys)$/.test(p.kind)) return { ok: false, error: 'Thiếu scanId / kind' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var folder = scanFolder_(), name = scanName_(p.scanId, p.kind), f = scanFile_(folder, name);
    if (p.kind === 'meta' || p.kind === 'keys') {   // meta / keys = văn bản; front / back = ảnh nhị phân
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
// Danh sách phiếu đã có online + thời điểm cập nhật (để máy khác biết phiếu nào mới) + danh sách phiếu ĐÃ XÓA (để máy khác dọn theo)
// p.since (ms, tùy chọn): chỉ liệt kê phiếu có meta đổi SAU mốc này -> lần đồng bộ định kỳ rất nhẹ dù kho có hàng nghìn file.
// Trả thêm serverNow để client dùng làm mốc since lần sau (không phụ thuộc đồng hồ máy khách).
function scanList_(p) {
  var folder = scanFolder_(), since = Number(p && p.since) || 0, now = Date.now(), list = [], gone = [], m, it, f;
  if (since > 0) {
    try {
      var iso = Utilities.formatDate(new Date(since), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
      it = folder.searchFiles("title contains '__meta' and modifiedDate > '" + iso + "'");
      while (it.hasNext()) { f = it.next(); m = /^(.+)__meta$/.exec(f.getName()); if (m) list.push({ scanId: m[1], updated: f.getLastUpdated().getTime() }); }
      it = folder.searchFiles("title contains '__gone'");     // danh sách đã xóa luôn trả đủ (rất nhỏ)
      while (it.hasNext()) { m = /^(.+)__gone$/.exec(it.next().getName()); if (m) gone.push(m[1]); }
      return { ok: true, list: list, gone: gone, serverNow: now, incremental: true };
    } catch (e) { list = []; gone = []; /* cú pháp tìm kiếm lỗi -> lùi về duyệt toàn bộ bên dưới */ }
  }
  it = folder.getFiles();
  while (it.hasNext()) {
    f = it.next(); m = /^(.+)__(meta|gone)$/.exec(f.getName()); if (!m) continue;
    if (m[2] === 'meta') list.push({ scanId: m[1], updated: f.getLastUpdated().getTime() }); else gone.push(m[1]);
  }
  return { ok: true, list: list, gone: gone, serverNow: now };
}
// Lấy nội dung meta của nhiều phiếu 1 lượt (client gọi từng nhóm ~15 phiếu). Trả thêm updated{id: ms} để client biết bản online mới tới đâu.
function scanMetaBatch_(ids) {
  var folder = scanFolder_(), metas = {}, updated = {};
  (ids || []).forEach(function (id) { var f = scanFile_(folder, scanName_(id, 'meta')); if (f) { metas[id] = f.getBlob().getDataAsString(); updated[id] = f.getLastUpdated().getTime(); } });
  return { ok: true, metas: metas, updated: updated };
}
// Tải NHIỀU ảnh trong 1 request (tiết kiệm thời gian khởi động + độ trễ mỗi lần gọi Apps Script).
// p.items = [{scanId, kind:'front'|'back'}]. Dừng khi tổng base64 vượt ~6 triệu ký tự -> client tự xin phần còn lại (phần chưa xử lý không có trong files).
function scanGetBatch_(p) {
  var folder = scanFolder_(), out = [], total = 0, LIMIT = 6e6;
  (p.items || []).forEach(function (x) {
    if (out.length && total > LIMIT) return;
    if (!x || !/^(front|back)$/.test(x.kind)) return;
    var f = scanFile_(folder, scanName_(x.scanId, x.kind));
    if (!f) { out.push({ scanId: x.scanId, kind: x.kind, ok: false, error: 'Không thấy file trên Drive' }); return; }
    var b64 = Utilities.base64Encode(f.getBlob().getBytes()); total += b64.length;
    out.push({ scanId: x.scanId, kind: x.kind, ok: true, mime: f.getMimeType(), b64: b64 });
  });
  return { ok: true, files: out };
}


/* =========================================================================
   PHẦN 3 — KHO ẢNH: kiểm tra / xóa phiếu / xóa 1 mặt + KHO KHÓA GEMINI MÃ HÓA (dùng chung nhiều máy)
   Việc cần làm: dán các hàm bên dưới, thêm 3 nhánh action ở đầu PHẦN 2 (scanInventory, scanDelete, scanTextGet), Deploy lại (New version).
   - scanDelete CHUYỂN FILE VÀO THÙNG RÁC Drive (khôi phục được ~30 ngày), đồng thời ghi file «<mã>__gone» để các máy khác biết mà dọn theo.
   - Kho khóa: web chỉ gửi lên BẢN ĐÃ MÃ HÓA bằng mật khẩu người dùng (AES-GCM); Apps Script không bao giờ thấy khóa gốc.
   ========================================================================= */
// Liệt kê MỌI file của kho: mã phiếu, loại, dung lượng, thời điểm cập nhật, biển số (từ mô tả file)
function scanInventory_() {
  var it = scanFolder_().getFiles(), files = [], gone = [], m;
  while (it.hasNext()) {
    var f = it.next(); m = /^(.+)__(front|back|meta|keys|gone)$/.exec(f.getName()); if (!m) continue;
    if (m[2] === 'gone') { gone.push(m[1]); continue; }
    if (m[2] === 'keys') continue;   // kho khóa không phải phiếu
    files.push({ scanId: m[1], kind: m[2], size: f.getSize(), updated: f.getLastUpdated().getTime(), plates: String(f.getDescription() || '').replace(/^Biển số:\s*/, '') });
  }
  return { ok: true, files: files, gone: gone };
}
// Xóa phiếu: p = { scanId, kinds?: ['front','back','meta'] } — bỏ trống kinds = xóa CẢ phiếu (và ghi dấu «gone»)
function scanDelete_(p) {
  if (!p || !p.scanId) return { ok: false, error: 'Thiếu scanId' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var folder = scanFolder_(), kinds = (p.kinds && p.kinds.length) ? p.kinds : ['front', 'back', 'meta'], n = 0;
    kinds.forEach(function (k) {
      if (!/^(front|back|meta)$/.test(k)) return;
      var it = folder.getFilesByName(scanName_(p.scanId, k));
      while (it.hasNext()) { it.next().setTrashed(true); n++; }   // có thể có >1 file trùng tên -> bỏ hết
    });
    if (kinds.indexOf('meta') >= 0 && !scanFile_(folder, scanName_(p.scanId, 'gone'))) folder.createFile(scanName_(p.scanId, 'gone'), String(Date.now()), 'text/plain');
    return { ok: true, deleted: n };
  } finally { lock.releaseLock(); }
}
// Đọc 1 file văn bản (dùng cho kho khóa mã hóa)
function scanTextGet_(p) {
  var f = scanFile_(scanFolder_(), scanName_(p.scanId, p.kind));
  return f ? { ok: true, text: f.getBlob().getDataAsString(), updated: f.getLastUpdated().getTime() } : { ok: false, error: 'Chưa có trên Drive' };
}
