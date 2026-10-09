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
   PHẦN 5 — PHIẾU LẠ: GHI VÀO CỘT AL–AP Ở HÀNG TRỐNG MỚI CỦA SHEET ĐANG LÀM VIỆC + XÓA HÀNG KHI TRÙNG XE CÓ SẴN
   Việc cần làm: dán PHẦN 5 này vào dự án, thêm 2 case trong scanDispatch_ (đã có ở trên nếu bạn dùng bản file này), Deploy PHIÊN BẢN MỚI.
   Cách chọn sheet: (1) tên sheet web gửi lên (sheetName) → (2) Script property «SCAN_MAIN_SHEET» (nếu bạn đặt) → (3) hằng SHEET_NAME trong Code.gs (nếu có) → (4) tab «Tong hop» → (5) tự dò: tab đầu tiên
   có dòng tiêu đề chứa cột «Biển số» (bỏ qua tab «PhieuLa»). Kết quả trả về luôn kèm tên sheet đã dùng để người dùng kiểm tra.
   An toàn: hàng phiếu lạ nhận dạng bằng «Phiếu lạ - Biển số» (cột AL) nên gửi lại nhiều lần KHÔNG tạo hàng trùng; khi xóa chỉ xóa hàng
   mà mọi cột ngoài AL–AP đều trống nên KHÔNG xóa nhầm hàng xe thật.
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
  var mainName = (typeof SHEET_NAME !== 'undefined') ? SHEET_NAME : '';   // hằng SHEET_NAME của Code.gs (cùng phạm vi toàn cục) = đúng sheet web đang đọc
  [name, pn, mainName, 'Tong hop'].forEach(function (n) { var s = n && ss.getSheetByName(n); if (s && cands.indexOf(s) < 0) cands.push(s); });
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

/* ---- PHIẾU LẠ → 5 cột cố định AL–AP của sheet «Tong hop» ----
   AL «Phiếu lạ - Biển số» · AM «Phiếu lạ - Họ tên» · AN «Phiếu lạ - CCCD» · AO «Phiếu lạ - Địa chỉ» · AP «Phiếu lạ - Số điện thoại»
   Tìm cột theo TIÊU ĐỀ trước; không thấy thì dùng đúng vị trí AL–AP (chỉ số 0-based 37–41). Mọi cột khác của hàng phiếu lạ để TRỐNG. */
var SCAN_ORPHAN_COLS_ = [
  { key: 'bienSo', header: 'Phiếu lạ - Biển số',        fixed: 37 },   // AL
  { key: 'hoTen',  header: 'Phiếu lạ - Họ tên',         fixed: 38 },   // AM
  { key: 'cccd',   header: 'Phiếu lạ - CCCD',           fixed: 39 },   // AN
  { key: 'diaChi', header: 'Phiếu lạ - Địa chỉ',        fixed: 40 },   // AO
  { key: 'sdt',    header: 'Phiếu lạ - Số điện thoại',  fixed: 41 }    // AP
];
// Trả { cols: {key: idx0}, newHeaders: [{idx, header}] } hoặc { error }
function scanOrphanCols_(headers) {
  var cols = {}, newHeaders = [], i, c;
  for (i = 0; i < SCAN_ORPHAN_COLS_.length; i++) {
    c = SCAN_ORPHAN_COLS_[i];
    var idx = scanFindCol_(headers, { header: c.header, aliases: [] });
    if (idx < 0) {
      var cur = String(headers[c.fixed] == null ? '' : headers[c.fixed]).trim();
      if (cur !== '') return { error: 'Cột thứ ' + (c.fixed + 1) + ' đang có tiêu đề «' + cur + '», không phải «' + c.header + '». Hãy đặt lại tiêu đề cột AL–AP đúng tên.' };
      idx = c.fixed; newHeaders.push({ idx: idx, header: c.header });   // ô tiêu đề trống đúng vị trí AL–AP -> điền tiêu đề
    }
    cols[c.key] = idx;
  }
  return { cols: cols, newHeaders: newHeaders };
}
// Chỉ số (0-based, trong dữ liệu dưới tiêu đề) của hàng cuối CÓ giá trị ở 1 trong các cột cho trước; -1 nếu chưa có
function scanLastFilled_(sh, headerRow, colIdxList) {
  var last = -1;
  colIdxList.forEach(function (ci) {
    var v = scanColValues_(sh, headerRow, ci);
    for (var i = v.length - 1; i > last; i--) if (v[i].trim() !== '') { last = i; break; }
  });
  return last;
}

// p = { sheetName, plate:{header,aliases}, rows:[{ plateRaw, cells:{bienSo, hoTen, cccd, diaChi, sdt} }] }
// Ghi mỗi phiếu lạ vào HÀNG TRỐNG MỚI, CHỈ các cột AL–AP. Cùng biển phiếu lạ đã có -> cập nhật AM–AP của hàng đó (không tạo hàng trùng).
function scanOrphanUpsert_(p) {
  if (!p || !p.rows || !p.rows.length) return { ok: true, results: [] };
  if (!p.plate) return { ok: false, error: 'Thiếu thông tin cột Biển số để tìm sheet.' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ms = scanMainSheet_(ss, p.sheetName, p.plate);
    if (!ms) return { ok: false, error: 'Không tìm thấy sheet có cột «' + p.plate.header + '». Đặt Script property SCAN_MAIN_SHEET = tên sheet đang làm việc.' };
    var sh = ms.sh, headerRow = ms.headerRow, headers = ms.headers.slice();
    var oc = scanOrphanCols_(headers);
    if (oc.error) return { ok: false, error: oc.error };
    var cols = oc.cols, i;
    if (oc.newHeaders.length) {
      var maxIdx = 0; oc.newHeaders.forEach(function (h) { if (h.idx + 1 > maxIdx) maxIdx = h.idx + 1; });
      if (maxIdx > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), maxIdx - sh.getMaxColumns());
      oc.newHeaders.forEach(function (h) { sh.getRange(headerRow, h.idx + 1).setValue(h.header); });
    }
    var plateCol = scanFindCol_(headers, p.plate);                       // cột «Biển số» của xe thật (chỉ để biết hàng cuối có dữ liệu)
    var orphanPlates = scanColValues_(sh, headerRow, cols.bienSo);
    var lastIdx = scanLastFilled_(sh, headerRow, plateCol >= 0 ? [plateCol, cols.bienSo] : [cols.bienSo]);
    var results = [], toAppend = [];
    p.rows.forEach(function (row) {
      var pk = scanPlate_(row.plateRaw || (row.cells && row.cells.bienSo)), existing = -1;
      for (i = 0; i < orphanPlates.length; i++) if (pk && scanPlate_(orphanPlates[i]) === pk) { existing = i; break; }
      if (existing >= 0) {                                               // đã có hàng phiếu lạ cùng biển -> chỉ cập nhật ô có dữ liệu (AM–AP)
        ['hoTen', 'cccd', 'diaChi', 'sdt'].forEach(function (k) {
          var v = row.cells && row.cells[k] != null ? String(row.cells[k]).trim() : '';
          if (v === '') return;
          var rg = sh.getRange(headerRow + 1 + existing, cols[k] + 1);
          if (/^\d+$/.test(v)) rg.setNumberFormat('@');                  // giữ số 0 đầu CCCD / SĐT
          rg.setValue(v);
        });
        results.push({ plateRaw: row.plateRaw, row: headerRow + 1 + existing, existed: true });
        return;
      }
      toAppend.push(row);
    });
    if (toAppend.length) {
      var firstRow = headerRow + 1 + lastIdx + 1;                       // hàng TRỐNG đầu tiên dưới hàng cuối có dữ liệu
      var need = firstRow + toAppend.length - 1;
      if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
      Object.keys(cols).forEach(function (k) {                          // ghi từng cột AL..AP, KHÔNG đụng ô nào khác trong hàng
        var vals = [], anyDigits = false;
        toAppend.forEach(function (row) {
          var v = row.cells && row.cells[k] != null ? String(row.cells[k]).trim() : '';
          if (/^\d+$/.test(v)) anyDigits = true;
          vals.push([v]);
        });
        var rg = sh.getRange(firstRow, cols[k] + 1, toAppend.length, 1);
        if (anyDigits) rg.setNumberFormat('@');
        rg.setValues(vals);
      });
      toAppend.forEach(function (row, n) { results.push({ plateRaw: row.plateRaw, row: firstRow + n, existed: false }); });
    }
    SpreadsheetApp.flush();
    return { ok: true, sheet: sh.getName(), results: results, createdCols: oc.newHeaders.map(function (h) { return h.header; }) };
  } finally { lock.releaseLock(); }
}

// p = { sheetName, plateRaw, plate:{header,aliases} } — xóa hàng phiếu lạ có «Phiếu lạ - Biển số» = plateRaw.
// AN TOÀN: chỉ xóa hàng mà MỌI cột ngoài AL–AP đều trống (không bao giờ xóa nhầm hàng xe thật).
function scanOrphanDelete_(p) {
  if (!p || !p.plateRaw || !p.plate) return { ok: false, error: 'Thiếu thông tin để xác định hàng cần xóa.' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ms = scanMainSheet_(ss, p.sheetName, p.plate);
    if (!ms) return { ok: false, error: 'Không tìm thấy sheet đang làm việc.' };
    var sh = ms.sh, oc = scanOrphanCols_(ms.headers);
    if (oc.error || oc.newHeaders.length) return { ok: true, deleted: 0, sheet: sh.getName() };   // chưa có cột AL–AP -> chưa từng ghi phiếu lạ
    var n = sh.getLastRow() - ms.headerRow;
    if (n <= 0) return { ok: true, deleted: 0, sheet: sh.getName() };
    var data = sh.getRange(ms.headerRow + 1, 1, n, sh.getLastColumn()).getValues();
    var isOrphanCol = {}; Object.keys(oc.cols).forEach(function (k) { isOrphanCol[oc.cols[k]] = true; });
    var pk = scanPlate_(p.plateRaw), rows = [];
    data.forEach(function (r, i) {
      if (scanPlate_(r[oc.cols.bienSo]) !== pk) return;
      for (var c = 0; c < r.length; c++) if (!isOrphanCol[c] && String(r[c]).trim() !== '') return;   // có dữ liệu cột khác -> là xe thật, bỏ qua
      rows.push(ms.headerRow + 1 + i);
    });
    for (var k = rows.length - 1; k >= 0; k--) sh.deleteRow(rows[k]);   // xóa từ dưới lên để chỉ số dòng không lệch
    SpreadsheetApp.flush();
    return { ok: true, deleted: rows.length, rows: rows, sheet: sh.getName() };
  } finally { lock.releaseLock(); }
}
