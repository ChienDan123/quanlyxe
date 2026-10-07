/* =========================================================================
   AppsScript_StorageOnly.gs — Apps Script RIÊNG chỉ để lưu ảnh / PDF phiếu scan (không đụng Google Sheet).
   Dùng khi chọn «Apps Script RIÊNG» ở Cài đặt → Lưu trữ. Dán toàn bộ file này vào dự án mới tại script.google.com,
   rồi Triển khai → Ứng dụng web (Thực thi: Tôi · Ai có quyền truy cập: Bất kỳ ai) → copy URL /exec dán vào web.
   ========================================================================= */
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return json_({ ok: true, service: 'QuanLyXe-PhieuScan-Storage' }); }
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    switch (data.action) {
      case 'scanPut':       return json_(scanPut_(data));
      case 'scanGet':       return json_(scanGet_(data));
      case 'scanList':      return json_(scanList_());
      case 'scanMetaBatch': return json_(scanMetaBatch_(data.ids));
      case 'scanInventory': return json_(scanInventory_());
      case 'scanDelete':    return json_(scanDelete_(data));
      case 'scanTextGet':   return json_(scanTextGet_(data));
      default:              return json_({ ok: false, error: 'Action không hỗ trợ: ' + data.action });
    }
  } catch (err) { return json_({ ok: false, error: String(err && err.message || err) }); }
}

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
function scanList_() {
  var it = scanFolder_().getFiles(), list = [], gone = [], m;
  while (it.hasNext()) {
    var f = it.next(); m = /^(.+)__(meta|gone)$/.exec(f.getName()); if (!m) continue;
    if (m[2] === 'meta') list.push({ scanId: m[1], updated: f.getLastUpdated().getTime() }); else gone.push(m[1]);
  }
  return { ok: true, list: list, gone: gone };
}
// Lấy nội dung meta của nhiều phiếu 1 lượt (client gọi từng nhóm ~15 phiếu)
function scanMetaBatch_(ids) {
  var folder = scanFolder_(), metas = {};
  (ids || []).forEach(function (id) { var f = scanFile_(folder, scanName_(id, 'meta')); if (f) metas[id] = f.getBlob().getDataAsString(); });
  return { ok: true, metas: metas };
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
