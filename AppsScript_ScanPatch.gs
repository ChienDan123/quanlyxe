/* =========================================================================
   >>> CÁCH NHANH NHẤT (làm 1 lần, chỉ 1 DÒNG) <<<
   1) Dán TOÀN BỘ file này vào dự án Apps Script (cuối file hiện có).
   2) Trong doPost(e), ngay SAU dòng parse JSON (chỗ có biến `data`), thêm DUY NHẤT 1 dòng:
          var sr = scanDispatch_(data); if (sr) return json_(sr);      // đổi json_ cho đúng tên hàm trả JSON của bạn
      -> KHÔNG cần thêm từng nhánh if (scanPut / scanList / scanInventory / …) như hướng dẫn cũ nữa.
   3) Triển khai → Quản lý bản triển khai → ✏ → Phiên bản MỚI → Triển khai. Cho phép quyền Drive nếu được hỏi.
   Lỗi «Unknown POST action: scanInventory» = doPost chưa có nhánh cho action đó -> làm đúng 3 bước trên là hết (PHẦN 4 ở cuối file).
   ========================================================================= */
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


/* =========================================================================
   PHẦN 4 — BỘ ĐỊNH TUYẾN DUY NHẤT: gọi từ doPost bằng 1 dòng (xem đầu file)
   Trả kết quả nếu là action của phần Quét phiếu, trả null nếu không phải (để doPost xử lý tiếp các action cũ như updateRow…).
   Thêm action mới sau này chỉ cần thêm 1 case ở đây.
   ========================================================================= */
function scanDispatch_(d) {
  if (!d || !d.action) return null;
  switch (d.action) {
    case 'scanPing':          return { ok: true, version: 5, actions: ['scanPut', 'scanGet', 'scanList', 'scanGetBatch', 'scanMetaBatch', 'scanInventory', 'scanDelete', 'scanTextGet', 'scanOrphanUpsert', 'scanOrphanDelete'] };
    case 'appendScanOrphans': return appendScanOrphans_(d.rows);
    case 'scanPut':           return scanPut_(d);
    case 'scanGet':           return scanGet_(d);
    case 'scanList':          return scanList_(d);
    case 'scanGetBatch':      return scanGetBatch_(d);
    case 'scanMetaBatch':     return scanMetaBatch_(d.ids);
    case 'scanInventory':     return scanInventory_();
    case 'scanDelete':        return scanDelete_(d);
    case 'scanTextGet':       return scanTextGet_(d);
    case 'scanOrphanUpsert':  return scanOrphanUpsert_(d);   // PHẦN 5: ghi phiếu lạ vào hàng trống mới của sheet đang làm việc
    case 'scanOrphanDelete':  return scanOrphanDelete_(d);   // PHẦN 5: xóa hàng phiếu lạ khi hóa ra trùng xe đã có
    default:                  return null;
  }
}


/* =========================================================================
   PHẦN 5 — PHIẾU LẠ: GHI VÀO HÀNG TRỐNG MỚI CỦA SHEET ĐANG LÀM VIỆC (thay cho tab riêng «PhieuLa») + XÓA HÀNG KHI TRÙNG XE CÓ SẴN
   Việc cần làm: dán PHẦN 5 này vào dự án, thêm 2 case trong scanDispatch_ (đã có ở trên nếu bạn dùng bản file này), Deploy PHIÊN BẢN MỚI.
   Cách chọn sheet: (1) tên sheet web gửi lên (sheetName) → (2) Script property «SCAN_MAIN_SHEET» (nếu bạn đặt) → (3) tự dò: tab đầu tiên
   có dòng tiêu đề chứa cột «Biển số» (bỏ qua tab «PhieuLa»). Kết quả trả về luôn kèm tên sheet đã dùng để người dùng kiểm tra.
   An toàn: ghi/xóa chỉ nhận dạng hàng bằng (biển số + «mã phiếu» trong cột «Phiếu scan») nên gửi lại nhiều lần KHÔNG tạo hàng trùng
   và KHÔNG xóa nhầm hàng xe thật.
   ========================================================================= */
function scanKey_(s) { return String(s == null ? '' : s).toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); }
function scanPlate_(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Tìm cột theo tiêu đề (so khớp bỏ dấu / hoa-thường / ký tự lạ) trong danh sách tên chấp nhận
function scanFindCol_(headers, spec) {
  var want = {}, i;
  [spec.header].concat(spec.aliases || []).forEach(function (h) { if (h) want[scanKey_(h)] = true; });
  for (i = 0; i < headers.length; i++) if (headers[i] !== '' && want[scanKey_(headers[i])]) return i;   // trả về chỉ số 0-based
  return -1;
}
// Tìm sheet đang làm việc + dòng tiêu đề (dò 10 dòng đầu). Trả { sh, headerRow(1-based), headers[] } hoặc null
function scanMainSheet_(ss, name, plateSpec) {
  var cands = [], pn = PropertiesService.getScriptProperties().getProperty('SCAN_MAIN_SHEET');
  [name, pn].forEach(function (n) { var s = n && ss.getSheetByName(n); if (s) cands.push(s); });
  ss.getSheets().forEach(function (s) { if (s.getName() !== 'PhieuLa' && cands.indexOf(s) < 0) cands.push(s); });
  for (var c = 0; c < cands.length; c++) {
    var sh = cands[c], lastC = sh.getLastColumn(), lastR = Math.min(10, sh.getLastRow());
    if (!lastC || !lastR) continue;
    var top = sh.getRange(1, 1, lastR, lastC).getValues();
    for (var r = 0; r < top.length; r++) {
      var hdr = top[r].map(String);
      if (scanFindCol_(hdr, plateSpec) >= 0) return { sh: sh, headerRow: r + 1, headers: hdr };
    }
  }
  return null;
}
// Đọc 1 cột dữ liệu (từ dòng dưới tiêu đề đến hết) -> mảng giá trị chuỗi
function scanColValues_(sh, headerRow, col0) {
  var n = sh.getLastRow() - headerRow;
  return n > 0 ? sh.getRange(headerRow + 1, col0 + 1, n, 1).getValues().map(function (r) { return String(r[0]); }) : [];
}

// p = { sheetName, rows:[{ scanId8, plateRaw, cells:[{key, header, aliases[], value}] }] }
function scanOrphanUpsert_(p) {
  if (!p || !p.rows || !p.rows.length) return { ok: true, results: [] };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var plateCell = null; p.rows[0].cells.forEach(function (c) { if (c.key === 'bienSo') plateCell = c; });
    if (!plateCell) return { ok: false, error: 'Thiếu ô Biển số trong dữ liệu gửi lên.' };
    var ms = scanMainSheet_(ss, p.sheetName, plateCell);
    if (!ms) return { ok: false, error: 'Không tìm thấy sheet có cột «' + plateCell.header + '». Đặt Script property SCAN_MAIN_SHEET = tên sheet đang làm việc.' };
    var sh = ms.sh, headerRow = ms.headerRow, headers = ms.headers.slice();
    var colOf = {}, nextCol = 0, i;                       // nextCol = số cột đã dùng (vị trí cột trống đầu tiên, 0-based)
    for (i = 0; i < headers.length; i++) if (headers[i] !== '') nextCol = i + 1;
    // Gom mọi cột cần dùng; thiếu thì TẠO MỚI ở cột trống đầu tiên (riêng Biển số bắt buộc phải có sẵn)
    var created = [];
    p.rows.forEach(function (row) {
      row.cells.forEach(function (c) {
        if (colOf[c.key] != null) return;
        var idx = scanFindCol_(headers, c);
        if (idx < 0) { idx = nextCol++; headers[idx] = c.header; created.push({ idx: idx, header: c.header }); }
        colOf[c.key] = idx;
      });
    });
    if (created.length) {
      if (nextCol > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), nextCol - sh.getMaxColumns());
      created.forEach(function (c) { sh.getRange(headerRow, c.idx + 1).setValue(c.header); });
    }
    // Cột để nhận dạng hàng đã ghi (chống trùng khi gửi lại)
    var plateVals = scanColValues_(sh, headerRow, colOf.bienSo);
    var phieuVals = colOf.phieuScan != null ? scanColValues_(sh, headerRow, colOf.phieuScan) : [];
    var lastDataIdx = -1;                                  // chỉ số (0-based, trong mảng plateVals) của hàng cuối CÓ biển số
    for (i = plateVals.length - 1; i >= 0; i--) if (plateVals[i].trim() !== '') { lastDataIdx = i; break; }
    var results = [], toAppend = [];
    p.rows.forEach(function (row) {
      var pk = scanPlate_(row.plateRaw), existing = -1;
      for (i = 0; i < plateVals.length; i++) if (scanPlate_(plateVals[i]) === pk && String(phieuVals[i] || '').indexOf('mã ' + row.scanId8) >= 0) { existing = i; break; }
      if (existing >= 0) { results.push({ plateRaw: row.plateRaw, row: headerRow + 1 + existing, existed: true }); return; }
      toAppend.push(row);
    });
    if (toAppend.length) {
      var firstRow = headerRow + 1 + lastDataIdx + 1;     // hàng TRỐNG đầu tiên ngay dưới hàng dữ liệu cuối
      var need = firstRow + toAppend.length - 1;
      if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
      var byCol = {};                                       // ghi theo từng CỘT (ít lệnh hơn, không đụng ô khác trong hàng như công thức có sẵn)
      toAppend.forEach(function (row, k) {
        row.cells.forEach(function (c) { (byCol[colOf[c.key]] = byCol[colOf[c.key]] || {})[k] = String(c.value); });
        results.push({ plateRaw: row.plateRaw, row: firstRow + k, existed: false });
      });
      Object.keys(byCol).forEach(function (ci) {
        var vals = [], anyDigits = false;
        for (var k = 0; k < toAppend.length; k++) { var v = byCol[ci][k] == null ? '' : byCol[ci][k]; if (/^\d+$/.test(v)) anyDigits = true; vals.push([v]); }
        var rg = sh.getRange(firstRow, Number(ci) + 1, toAppend.length, 1);
        if (anyDigits) rg.setNumberFormat('@');             // giữ số 0 đầu của CCCD / SĐT
        rg.setValues(vals);
      });
    }
    SpreadsheetApp.flush();
    return { ok: true, sheet: sh.getName(), results: results, createdCols: created.map(function (c) { return c.header; }) };
  } finally { lock.releaseLock(); }
}

// p = { sheetName, scanId8, plateRaw, plate:{header,aliases}, phieu:{header,aliases} } — xóa CHÍNH XÁC hàng phiếu lạ đã ghi
function scanOrphanDelete_(p) {
  if (!p || !p.scanId8 || !p.plateRaw || !p.plate || !p.phieu) return { ok: false, error: 'Thiếu thông tin để xác định hàng cần xóa.' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ms = scanMainSheet_(ss, p.sheetName, p.plate);
    if (!ms) return { ok: false, error: 'Không tìm thấy sheet đang làm việc.' };
    var sh = ms.sh, pc = scanFindCol_(ms.headers, p.plate), fc = scanFindCol_(ms.headers, p.phieu);
    if (pc < 0 || fc < 0) return { ok: true, deleted: 0, sheet: sh.getName() };   // chưa có cột Phiếu scan -> chưa từng ghi hàng nào bằng cách này, không xóa gì
    var plates = scanColValues_(sh, ms.headerRow, pc), phieus = scanColValues_(sh, ms.headerRow, fc), pk = scanPlate_(p.plateRaw), rows = [];
    for (var i = 0; i < plates.length; i++) if (scanPlate_(plates[i]) === pk && String(phieus[i]).indexOf('mã ' + p.scanId8) >= 0) rows.push(ms.headerRow + 1 + i);
    for (var k = rows.length - 1; k >= 0; k--) sh.deleteRow(rows[k]);     // xóa từ dưới lên để chỉ số dòng không lệch
    SpreadsheetApp.flush();
    return { ok: true, deleted: rows.length, rows: rows, sheet: sh.getName() };
  } finally { lock.releaseLock(); }
}
