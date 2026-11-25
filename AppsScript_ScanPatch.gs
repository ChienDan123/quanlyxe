/* =========================================================================
   AppsScript_ScanPatch.gs — PHIẾU SCAN + PHIẾU LẠ + ĐỒNG BỘ CỘT AV + HÀNG ĐỢI SERVER (bản 8)
   -------------------------------------------------------------------------
   BẢN 8 — FIX PHASE 1 (cột AV trống). Thay đổi so với bản 7:
   • syncAvStatus_ sửa 3 lỗi gốc:
     (1) RANK trạng thái: Chưa kiểm < Đã kiểm < Đã kiểm lại lần 1 < lần 2 < …
         KHÔNG ghi đè trạng thái cao hơn bằng trạng thái thấp hơn (yêu cầu [1c]).
     (2) Nhận diện cột AV theo alias ('trang thai kiem' / 'trang thai kiem tra' /
         'trang thai kiem phieu' / 'av'); nếu AV1 có tiêu đề KHÁC và không rỗng
         → trả lỗi rõ ràng (bảo vệ dữ liệu) thay vì ghi đè cột khác.
     (3) Chuẩn hoá biển số kỹ hơn: bỏ cả tab / quote / non-breaking space /
         gạch dài – — tránh lệch khi frontend gửi biển số dán từ Excel.
   • THÊM action 'syncAvStatusDiagnose': chẩn đoán vị trí cột AV, tiêu đề AV1,
     mẫu biển số + AV hiện tại (10 dòng đầu), log lần sync gần nhất.
   • scanPing nâng version 8 → 9.
   • Log AV_LAST_SYNC_LOG chi tiết hơn: avCol, avHeaderBefore, downgradesList,
     totalItems, notFoundList, duplicates.
   -------------------------------------------------------------------------
   CÁCH CÀI (làm đúng 4 bước, không bỏ bước nào):
   1) XÓA SẠCH nội dung file «Ma lenh luu anh.gs» rồi dán TOÀN BỘ file này vào
      (KHÔNG dán nối thêm bên dưới bản cũ: 2 bản cùng tên hàm → bản nằm sau thắng).
   2) Dán file AppsScript_UpdateRow.gs vào dự án (file «cửa vào» POST duy nhất).
      KHÔNG cần đổi tên; chỉ cần trong cả dự án có DUY NHẤT một hàm doPost.
   3) Triển khai → Quản lý bản triển khai → ✏ → Phiên bản: «Phiên bản mới» → Triển khai.
      (KHÔNG chọn «Bản triển khai mới» vì URL /exec sẽ đổi.) Cho phép quyền Drive / Sheets.
   4) Trong trình soạn thảo Apps Script chọn hàm scanSelfTest → Chạy → xem
      «Nhật ký thực thi». Phải thấy dòng «KẾT LUẬN: MỌI THỨ SẴN SÀNG».
   -------------------------------------------------------------------------
   KIỂM TRA CỘT AV SAU KHI CÀI:
   • Mở  <URL/exec>?action=syncAvStatusDiagnose  trên trình duyệt — phải thấy
     JSON có avCol: 47, avHeader: "Trạng thái kiểm" (hoặc ""), sampleRows có biển số
     khớp với sheet, và lastLog: null (lần đầu) hoặc log của lần sync gần nhất.
   • Nếu avHeader khác "Trạng thái kiểm" → đổi tiêu đề ô AV1 hoặc xoá trắng AV1
     để hệ thống tự đặt lại, rồi gọi lại syncAvStatusDiagnose.
   ========================================================================= */

// =========================================================================
// [DEPRECATED — bản 7] appendScanOrphans_: ghi phiếu lạ vào tab «PhieuLa» (11 cột).
// Từ bản 6, hệ thống chuyển sang scanOrphanUpsert_ (ghi AL–AP của «Tong hop»).
// Hàm này giữ lại chỉ để không phá code cũ nếu còn nơi gọi action 'appendScanOrphans'.
// Có thể xoá an toàn sau khi xác nhận toàn bộ frontend không còn tham chiếu.
// =========================================================================
function appendScanOrphans_(rows) {
  var HEADERS = ['Thời gian', 'Biển số', 'Chủ hộ', 'CCCD', 'SĐT', 'Tình trạng', 'Ghi chú', 'Nguồn', 'Mã phiếu', 'Kiểm phiếu', 'Người thực hiện'];
  var KEYS = ['thoiGian', 'bienSo', 'chuHo', 'cccd', 'sdt', 'tinhTrang', 'ghiChu', 'nguon', 'maPhieu', 'kiem', 'nguoiThucHien'];
  if (!rows || !rows.length) return { ok: true, added: 0 };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('PhieuLa') || ss.insertSheet('PhieuLa');
    if (sh.getLastRow() === 0) { sh.appendRow(HEADERS); sh.setFrozenRows(1); }
    else if (sh.getRange(1, HEADERS.length).getValue() === '') sh.getRange(1, HEADERS.length).setValue(HEADERS[HEADERS.length - 1]);
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
   PHẦN 2 — LƯU ẢNH / PDF PHIẾU SCAN ONLINE (Google Drive)
   ========================================================================= */
var SCAN_FOLDER_NAME = 'QuanLyXe_PhieuScan';

function scanFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('SCAN_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* tạo lại bên dưới */ } }
  var it = DriveApp.getFoldersByName(SCAN_FOLDER_NAME);
  var f = it.hasNext() ? it.next() : DriveApp.createFolder(SCAN_FOLDER_NAME);
  props.setProperty('SCAN_FOLDER_ID', f.getId());
  return f;
}
function scanName_(scanId, kind) { return String(scanId).replace(/[^\w\-]/g, '') + '__' + kind; }
function scanFile_(folder, name) { var it = folder.getFilesByName(name); return it.hasNext() ? it.next() : null; }

function scanPut_(p) {
  if (!p || !p.scanId || !/^(front|back|meta|keys|p\d{1,2})$/.test(p.kind)) return { ok: false, error: 'Thiếu scanId / kind' };   /*NM:P5-15*/ // p3, p4… = mặt 3..N
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var folder = scanFolder_(), name = scanName_(p.scanId, p.kind), f = scanFile_(folder, name);
    if (p.kind === 'meta' || p.kind === 'keys') {
      if (f) f.setContent(p.text || '{}'); else f = folder.createFile(name, p.text || '{}', 'application/json');
    } else {
      var blob = Utilities.newBlob(Utilities.base64Decode(p.b64 || ''), p.mime || 'image/jpeg', name);
      if (f) f.setTrashed(true);
      f = folder.createFile(blob);
    }
    f.setDescription('Biển số: ' + (p.plates || ''));
    return { ok: true, fileId: f.getId(), updated: f.getLastUpdated().getTime() };
  } finally { lock.releaseLock(); }
}
function scanGet_(p) {
  var f = scanFile_(scanFolder_(), scanName_(p.scanId, p.kind));
  if (!f) return { ok: false, error: 'Không thấy file trên Drive' };
  return { ok: true, mime: f.getMimeType(), b64: Utilities.base64Encode(f.getBlob().getBytes()) };
}
function scanList_(p) {
  var folder = scanFolder_(), since = Number(p && p.since) || 0, now = Date.now(), list = [], gone = [], m, it, f;
  if (since > 0) {
    try {
      var iso = Utilities.formatDate(new Date(since), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
      it = folder.searchFiles("title contains '__meta' and modifiedDate > '" + iso + "'");
      while (it.hasNext()) { f = it.next(); m = /^(.+)__meta$/.exec(f.getName()); if (m) list.push({ scanId: m[1], updated: f.getLastUpdated().getTime() }); }
      it = folder.searchFiles("title contains '__gone'");
      while (it.hasNext()) { m = /^(.+)__gone$/.exec(it.next().getName()); if (m) gone.push(m[1]); }
      return { ok: true, list: list, gone: gone, serverNow: now, incremental: true };
    } catch (e) { list = []; gone = []; }
  }
  it = folder.getFiles();
  while (it.hasNext()) {
    f = it.next(); m = /^(.+)__(meta|gone)$/.exec(f.getName()); if (!m) continue;
    if (m[2] === 'meta') list.push({ scanId: m[1], updated: f.getLastUpdated().getTime() }); else gone.push(m[1]);
  }
  return { ok: true, list: list, gone: gone, serverNow: now };
}
function scanMetaBatch_(ids) {
  var folder = scanFolder_(), metas = {}, updated = {};
  (ids || []).forEach(function (id) { var f = scanFile_(folder, scanName_(id, 'meta')); if (f) { metas[id] = f.getBlob().getDataAsString(); updated[id] = f.getLastUpdated().getTime(); } });
  return { ok: true, metas: metas, updated: updated };
}
function scanGetBatch_(p) {
  var folder = scanFolder_(), out = [], total = 0, LIMIT = 6e6;
  (p.items || []).forEach(function (x) {
    if (out.length && total > LIMIT) return;
    if (!x || !/^(front|back|p\d{1,2})$/.test(x.kind)) return;   /*NM:P5-16*/
    var f = scanFile_(folder, scanName_(x.scanId, x.kind));
    if (!f) { out.push({ scanId: x.scanId, kind: x.kind, ok: false, error: 'Không thấy file trên Drive' }); return; }
    var b64 = Utilities.base64Encode(f.getBlob().getBytes()); total += b64.length;
    out.push({ scanId: x.scanId, kind: x.kind, ok: true, mime: f.getMimeType(), b64: b64 });
  });
  return { ok: true, files: out };
}

/* =========================================================================
   PHẦN 3 — KHO ẢNH: kiểm tra / xóa phiếu / xóa 1 mặt + KHO KHÓA GEMINI MÃ HÓA
   ========================================================================= */
function scanInventory_() {
  var it = scanFolder_().getFiles(), files = [], gone = [], m;
  while (it.hasNext()) {
    var f = it.next(); m = /^(.+)__(front|back|meta|keys|gone|p\d{1,2})$/.exec(f.getName()); if (!m) continue;   /*NM:P5-17*/
    if (m[2] === 'gone') { gone.push(m[1]); continue; }
    if (m[2] === 'keys') continue;
    files.push({ scanId: m[1], kind: m[2], size: f.getSize(), updated: f.getLastUpdated().getTime(), plates: String(f.getDescription() || '').replace(/^Biển số:\s*/, '') });
  }
  return { ok: true, files: files, gone: gone };
}
function scanDelete_(p) {
  if (!p || !p.scanId) return { ok: false, error: 'Thiếu scanId' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var folder = scanFolder_(), kinds = (p.kinds && p.kinds.length) ? p.kinds : ['front', 'back', 'meta'], n = 0;
    kinds.forEach(function (k) {
      if (!/^(front|back|meta)$/.test(k)) return;
      var it = folder.getFilesByName(scanName_(p.scanId, k));
      while (it.hasNext()) { it.next().setTrashed(true); n++; }
    });
    if (kinds.indexOf('meta') >= 0) {   /*NM:P5-18*/ // xóa cả phiếu → dọn mặt 3..N
      var pre = String(p.scanId).replace(/[^\w\-]/g, '') + '__p', it2 = folder.searchFiles("title contains '" + pre + "'");
      while (it2.hasNext()) { var f2 = it2.next(); if (new RegExp('^' + pre + '\\d{1,2}$').test(f2.getName())) { f2.setTrashed(true); n++; } }
    }
    if (kinds.indexOf('meta') >= 0 && !scanFile_(folder, scanName_(p.scanId, 'gone'))) folder.createFile(scanName_(p.scanId, 'gone'), String(Date.now()), 'text/plain');
    return { ok: true, deleted: n };
  } finally { lock.releaseLock(); }
}
function scanTextGet_(p) {
  var f = scanFile_(scanFolder_(), scanName_(p.scanId, p.kind));
  return f ? { ok: true, text: f.getBlob().getDataAsString(), updated: f.getLastUpdated().getTime() } : { ok: false, error: 'Chưa có trên Drive' };
}

/* =========================================================================
   PHẦN 4 — BỘ ĐỊNH TUYẾN DUY NHẤT
   ========================================================================= */
function scanDispatch_(d) {
  if (!d || !d.action) return null;
  if (typeof ur_dispatch_ === 'function') { var ur = ur_dispatch_(d); if (ur) return ur; }   /*NM:P5-19*/
  switch (d.action) {
    case 'scanPing': return { ok: true, version: 9, actions: [
      'scanPut','scanGet','scanList','scanGetBatch','scanMetaBatch','scanInventory','scanDelete','scanTextGet',
      'scanOrphanUpsert','scanOrphanDelete','scanSheetUpsert','scanSheetDelete','scanSheetPing',
      'syncAvStatus','syncAvStatusDiagnose','getAvSyncLog','scanQueuePush','scanQueueStatus','scanQueueClear'] };
    case 'appendScanOrphans': return appendScanOrphans_(d.rows);
    case 'scanPut': return scanPut_(d);
    case 'scanGet': return scanGet_(d);
    case 'scanList': return scanList_(d);
    case 'scanGetBatch': return scanGetBatch_(d);
    case 'scanMetaBatch': return scanMetaBatch_(d.ids);
    case 'scanInventory': return scanInventory_();
    case 'scanDelete': return scanDelete_(d);
    case 'scanTextGet': return scanTextGet_(d);
    case 'scanOrphanUpsert': return scanOrphanUpsert_(d);
    case 'scanOrphanDelete': return scanOrphanDelete_(d);
    case 'scanSheetUpsert': return dls_upsert_(d);
    case 'scanSheetDelete': return dls_delete_(d);
    case 'scanSheetPing': return dls_ping_();
    case 'syncAvStatus': return syncAvStatus_(d);
    case 'syncAvStatusDiagnose': return syncAvStatusDiagnose_(d);
    case 'getAvSyncLog': return getAvSyncLog_();
    case 'scanQueuePush': return scanQueuePush_(d);
    case 'scanQueueStatus': return scanQueueStatus_();
    case 'scanQueueClear': return scanQueueClear_(d);
    default: return null;
  }
}

/* =========================================================================
   PHẦN 5 — PHIẾU LẠ: GHI VÀO CỘT AL–AP Ở HÀNG TRỐNG MỚI
   ========================================================================= */
function scanKey_(s) { return String(s == null ? '' : s).toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); }
function scanPlate_(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function scanFindCol_(headers, spec) {
  var want = {}, i;
  [spec.header].concat(spec.aliases || []).forEach(function (h) { if (h) want[scanKey_(h)] = true; });
  for (i = 0; i < headers.length; i++) if (headers[i] !== '' && want[scanKey_(headers[i])]) return i;
  return -1;
}
function scanMainSheet_(ss, name, plateSpec) {
  var cands = [], pn = PropertiesService.getScriptProperties().getProperty('SCAN_MAIN_SHEET');
  var mainName = (typeof SHEET_NAME !== 'undefined') ? SHEET_NAME : '';
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
function scanColValues_(sh, headerRow, col0) {
  var n = sh.getLastRow() - headerRow;
  return n > 0 ? sh.getRange(headerRow + 1, col0 + 1, n, 1).getValues().map(function (r) { return String(r[0]); }) : [];
}

var SCAN_ORPHAN_COLS_ = [
  { key: 'bienSo', header: 'Phiếu lạ - Biển số',        fixed: 37, aliases: ['Phiếu lạ - BKS', 'Phiếu lạ Biển số'] },
  { key: 'hoTen',  header: 'Phiếu lạ - Họ tên',         fixed: 38, aliases: ['Phiếu lạ - Họ và tên', 'Phiếu lạ - Tên', 'Phiếu lạ - Chủ hộ'] },
  { key: 'cccd',   header: 'Phiếu lạ - CCCD',           fixed: 39, aliases: ['Phiếu lạ - Số CCCD', 'Phiếu lạ - CMND', 'Phiếu lạ - Số CCCD/MST'] },
  { key: 'diaChi', header: 'Phiếu lạ - Địa chỉ',        fixed: 40, aliases: ['Phiếu lạ - Địa chỉ đăng ký'] },
  { key: 'sdt',    header: 'Phiếu lạ - Số điện thoại',  fixed: 41, aliases: ['Phiếu lạ - SĐT', 'Phiếu lạ - Số ĐT', 'Phiếu lạ - Điện thoại', 'Phiếu lạ - SDT'] }
];
var SCAN_PLATE_DEFAULT_ = { header: 'Biển số', aliases: ['Bien so', 'BKS', 'Biển kiểm soát'] };

function scanOrphanCols_(headers) {
  var cols = {}, newHeaders = [], i, c;
  for (i = 0; i < SCAN_ORPHAN_COLS_.length; i++) {
    c = SCAN_ORPHAN_COLS_[i];
    var idx = scanFindCol_(headers, { header: c.header, aliases: c.aliases });
    if (idx < 0) {
      var cur = String(headers[c.fixed] == null ? '' : headers[c.fixed]).trim();
      if (cur !== '') return { error: 'Cột thứ ' + (c.fixed + 1) + ' đang có tiêu đề «' + cur + '», không phải «' + c.header + '». Hãy đặt lại tiêu đề cột AL–AP đúng tên.' };
      idx = c.fixed; newHeaders.push({ idx: idx, header: c.header });
    }
    cols[c.key] = idx;
  }
  return { cols: cols, newHeaders: newHeaders };
}
function scanLastFilled_(sh, headerRow, colIdxList) {
  var last = -1;
  colIdxList.forEach(function (ci) {
    var v = scanColValues_(sh, headerRow, ci);
    for (var i = v.length - 1; i > last; i--) if (v[i].trim() !== '') { last = i; break; }
  });
  return last;
}
function scanWriteExtras_(sh, headerRow, hdrs, rowNo, extras) {
  var n = 0;
  (extras || []).forEach(function (x) {
    var v = x && x.value != null ? String(x.value).trim() : '';
    if (!x || !x.header || v === '') return;
    var idx = scanFindCol_(hdrs, { header: x.header, aliases: x.aliases || [] });
    if (idx < 0) {
      idx = hdrs.length;
      if (idx + 1 > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), idx + 1 - sh.getMaxColumns());
      sh.getRange(headerRow, idx + 1).setValue(x.header);
      hdrs.push(x.header);
    }
    var rg = sh.getRange(rowNo, idx + 1);
    if (/^[\d=+\-@]/.test(v)) rg.setNumberFormat('@');
    rg.setValue(v); n++;
  });
  return n;
}
function scanOrphanUpsert_(p) {
  if (!p || !p.rows || !p.rows.length) return { ok: true, results: [] };
  if (!p.plate) p.plate = SCAN_PLATE_DEFAULT_;
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
    var hdrs = headers.slice();
    oc.newHeaders.forEach(function (h) { while (hdrs.length <= h.idx) hdrs.push(''); hdrs[h.idx] = h.header; });
    var plateCol = scanFindCol_(headers, p.plate);
    var orphanPlates = scanColValues_(sh, headerRow, cols.bienSo);
    var lastIdx = scanLastFilled_(sh, headerRow, plateCol >= 0 ? [plateCol, cols.bienSo] : [cols.bienSo]);
    var results = [], toAppend = [];
    p.rows.forEach(function (row) {
      var pk = scanPlate_(row.plateRaw || (row.cells && row.cells.bienSo)), existing = -1;
      for (i = 0; i < orphanPlates.length; i++) if (pk && scanPlate_(orphanPlates[i]) === pk) { existing = i; break; }
      if (existing >= 0) {
        ['hoTen', 'cccd', 'diaChi', 'sdt'].forEach(function (k) {
          var v = row.cells && row.cells[k] != null ? String(row.cells[k]).trim() : '';
          if (v === '') return;
          var rg = sh.getRange(headerRow + 1 + existing, cols[k] + 1);
          if (/^\d+$/.test(v)) rg.setNumberFormat('@');
          rg.setValue(v);
        });
        results.push({ plateRaw: row.plateRaw, row: headerRow + 1 + existing, existed: true,
          extra: scanWriteExtras_(sh, headerRow, hdrs, headerRow + 1 + existing, row.extra) });
        return;
      }
      toAppend.push(row);
    });
    if (toAppend.length) {
      var firstRow = headerRow + 1 + lastIdx + 1;
      var need = firstRow + toAppend.length - 1;
      if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
      Object.keys(cols).forEach(function (k) {
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
      toAppend.forEach(function (row, n) {
        results.push({ plateRaw: row.plateRaw, row: firstRow + n, existed: false,
          extra: scanWriteExtras_(sh, headerRow, hdrs, firstRow + n, row.extra) });
      });
    }
    SpreadsheetApp.flush();
    return { ok: true, sheet: sh.getName(), results: results, createdCols: oc.newHeaders.map(function (h) { return h.header; }) };
  } finally { lock.releaseLock(); }
}
function scanOrphanDelete_(p) {
  if (!p || !p.plateRaw) return { ok: false, error: 'Thiếu thông tin để xác định hàng cần xóa.' };
  if (!p.plate) p.plate = SCAN_PLATE_DEFAULT_;
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ms = scanMainSheet_(ss, p.sheetName, p.plate);
    if (!ms) return { ok: false, error: 'Không tìm thấy sheet đang làm việc.' };
    var sh = ms.sh, oc = scanOrphanCols_(ms.headers);
    if (oc.error || oc.newHeaders.length) return { ok: true, deleted: 0, sheet: sh.getName() };
    var n = sh.getLastRow() - ms.headerRow;
    if (n <= 0) return { ok: true, deleted: 0, sheet: sh.getName() };
    var data = sh.getRange(ms.headerRow + 1, 1, n, sh.getLastColumn()).getValues();
    var isOrphanCol = {}; Object.keys(oc.cols).forEach(function (k) { isOrphanCol[oc.cols[k]] = true; });
    var pk = scanPlate_(p.plateRaw), rows = [];
    data.forEach(function (r, i) {
      if (scanPlate_(r[oc.cols.bienSo]) !== pk) return;
      for (var c = 0; c < r.length; c++) if (!isOrphanCol[c] && String(r[c]).trim() !== '') return;
      rows.push(ms.headerRow + 1 + i);
    });
    for (var k = rows.length - 1; k >= 0; k--) sh.deleteRow(rows[k]);
    SpreadsheetApp.flush();
    return { ok: true, deleted: rows.length, rows: rows, sheet: sh.getName() };
  } finally { lock.releaseLock(); }
}

/* =========================================================================
   PHẦN 6 — TỰ KIỂM TRA
   ========================================================================= */
function scanSelfTest() {
  var out = [], ok = true;
  function say(good, msg) { out.push((good ? '✔ ' : '✘ ') + msg); if (!good) ok = false; }
  try {
    var r = doPost({ postData: { contents: JSON.stringify({ action: 'scanPing' }) } });
    var j = JSON.parse(r.getContent());
    if (j && j.ok === false) say(false, 'doPost trả lỗi: ' + j.error);
    else if (!j || !j.actions) say(false, 'doPost trả kết quả lạ: ' + r.getContent());
    else {
      say(true, 'doPost đã nối scanDispatch_ (version ' + j.version + ').');
      say(j.version >= 9, 'Phiên bản code = ' + j.version + (j.version >= 9 ? '' : ' (<9: đang chạy bản CŨ)'));
      say(j.actions.indexOf('scanOrphanUpsert') >= 0, 'Có action scanOrphanUpsert.');
      say(j.actions.indexOf('syncAvStatus') >= 0, 'Có action syncAvStatus (PHẦN 7).');
      say(j.actions.indexOf('syncAvStatusDiagnose') >= 0, 'Có action syncAvStatusDiagnose (chẩn đoán AV).');
      say(j.actions.indexOf('scanQueuePush') >= 0, 'Có action scanQueuePush (PHẦN 8).');
    }
  } catch (e) { say(false, 'Gọi doPost bị lỗi: ' + e.message); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ms = scanMainSheet_(ss, '', SCAN_PLATE_DEFAULT_);
    if (!ms) say(false, 'Không tìm thấy sheet có cột «Biển số».');
    else {
      say(true, 'Sheet đang làm việc: «' + ms.sh.getName() + '», dòng tiêu đề = ' + ms.headerRow + '.');
      var oc = scanOrphanCols_(ms.headers);
      if (oc.error) say(false, oc.error);
      else {
        var L = function (n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); } return s; };
        SCAN_ORPHAN_COLS_.forEach(function (c) { say(true, 'Cột ' + L(oc.cols[c.key]) + ' ← ' + c.header); });
        if (oc.newHeaders.length) out.push('ℹ Cột AL–AP chưa có tiêu đề: sẽ tự điền tiêu đề khi ghi lần đầu.');
      }
    }
  } catch (e2) { say(false, 'Lỗi đọc sheet: ' + e2.message); }
  // Kiểm tra nhanh cột AV
  try {
    var diag = syncAvStatusDiagnose_({ sheetName: AV_SHEET_DEFAULT });
    if (diag && diag.ok) {
      say(true, 'AV: cột ' + diag.avColLetter + ' (index ' + diag.avCol + '), tiêu đề = "' + (diag.avHeader || '(trống)') + '", plateCol = "' + diag.plateHeader + '".');
      var validHeader = !diag.avHeader || /^(trang thai xe chua kiem|trang thai kiem|trang thai kiem phieu|trang thai kiem tra|av)$/i
        .test(String(diag.avHeader).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim());
      say(validHeader, 'Tiêu đề AV hợp lệ (trống hoặc "Trạng thái kiểm").' + (validHeader ? '' : ' → đổi AV1 thành "Trạng thái kiểm" hoặc xoá trắng.'));
    } else {
      say(false, 'syncAvStatusDiagnose lỗi: ' + (diag && diag.error));
    }
  } catch (e3) { say(false, 'Chẩn đoán AV lỗi: ' + e3.message); }
  out.push(ok ? 'KẾT LUẬN: MỌI THỨ SẴN SÀNG' : 'KẾT LUẬN: CÒN LỖI — sửa các dòng ✘ ở trên rồi chạy lại.');
  Logger.log(out.join('\n'));
  return out.join('\n');
}
function scanTestOrphanWrite() {
  var r = scanOrphanUpsert_({ plate: SCAN_PLATE_DEFAULT_, rows: [{ plateRaw: 'TEST-ORPHAN', cells: { bienSo: 'TEST-ORPHAN', hoTen: 'Nguyen Van Test', cccd: '012345678901', diaChi: 'Dia chi thu', sdt: '0900000000' } }] });
  Logger.log(JSON.stringify(r) + (r.ok ? '\n→ Mở sheet «' + r.sheet + '», xem hàng ' + (r.results[0] && r.results[0].row) + ' (cột AL–AP).' : ''));
  return r;
}
function scanTestOrphanCleanup() {
  var r = scanOrphanDelete_({ plate: SCAN_PLATE_DEFAULT_, plateRaw: 'TEST-ORPHAN' });
  Logger.log(JSON.stringify(r)); return r;
}

/* =========================================================================
   PHẦN 7 — ĐỒNG BỘ NGẦM «TRẠNG THÁI KIỂM» LÊN CỘT AV (yêu cầu [1])
   -------------------------------------------------------------------------
   Action: 'syncAvStatus'
   Input:  { action:'syncAvStatus', sheetName?:'Tong hop', items:[
              { bienSo, status:'chua_kiem'|'da_kiem'|'da_kiem_lai', lanKiem?:n }
            ] }
   Output: { ok, wrote, notFoundCount, notFoundList:[...], duplicates:[{bienSo, rows:[]}],
             skipped, downgradesSkipped, totalItems, avCol, avColLetter }

   • Chuẩn hoá biển số: UPPERCASE, bỏ khoảng trắng / tab / '.' / '-' / gạch dài /
     quote / non-breaking space khi khớp hàng.
   • Cột AV (index 48 = 0-based 47) của sheet «Tong hop». Nhận diện theo alias
     ('trang thai kiem' / 'trang thai kiem tra' / 'trang thai kiem phieu' / 'av');
     nếu AV1 đang có tiêu đề KHÁC (không rỗng) → trả lỗi rõ ràng (bảo vệ dữ liệu).
   • RANK trạng thái: '' < 'Chưa kiểm' < 'Đã kiểm' < 'Đã kiểm lại lần 1' < lần 2 < …
     KHÔNG ghi đè trạng thái cao hơn bằng thấp hơn (đếm vào downgradesSkipped).
   • Idempotent: chỉ ghi khi giá trị khác hiện tại.
   • Batch setValues (1 lần ghi cho cả cột AV), LockService 25s.
   • Log AV_LAST_SYNC_LOG trong PropertiesService (action 'getAvSyncLog' để đọc).
   ========================================================================= */
var AV_SHEET_DEFAULT = 'Tong hop';
var AV_HEADER = 'Trạng thái xe chưa kiểm';
var AV_COL_INDEX = 47;      // 0-based: cột 48 = AV

// Chuẩn hoá biển số để khớp: bỏ mọi ký tự không phải chữ/số, viết hoa.
function avNormalizePlate_(s) {
  return String(s == null ? '' : s)
    .normalize('NFC').toUpperCase()
    .replace(/[\s\u00A0.\-\u2010-\u2015'"`´‘’“”]/g, '')
    .trim();
}
// Nhãn hiển thị cho AV theo status/lanKiem gửi từ frontend.
function avStatusLabel_(status, lanKiem) {
  if (status === 'da_kiem_lai') { var n = parseInt(lanKiem, 10); return 'Đã kiểm lại lần ' + (n > 0 ? n : 1); }
  if (status === 'da_kiem') return 'Đã kiểm';
  return 'Chưa kiểm';
}
// RANK trạng thái: càng cao càng "mạnh", không cho ghi đè bằng rank thấp hơn.
function avStatusRank_(str) {
  var s = String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return 0;
  if (/^chua kiem$/.test(s)) return 1;
  if (/^da kiem$/.test(s)) return 2;
  var m = s.match(/^da kiem lai lan (\d+)$/);
  if (m) return 2 + parseInt(m[1], 10);
  return 1; // giá trị lạ → coi là thấp, cho phép ghi đè bằng "Đã kiểm" / "Đã kiểm lại"
}
// Chuyển số cột 1-based sang chữ cái cột (48 → AV).
function columnLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function getAvSyncLog_() {
  try { var raw = PropertiesService.getScriptProperties().getProperty('AV_LAST_SYNC_LOG'); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}

// Chẩn đoán nhanh: cột AV đang ở đâu, tiêu đề gì, mẫu 10 dòng đầu biển số ↔ AV.
function syncAvStatusDiagnose_(d) {
  var sheetName = (d && d.sheetName) || AV_SHEET_DEFAULT;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(sheetName);
  if (!sh) return { ok: false, error: 'Không tìm thấy sheet "' + sheetName + '".' };
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  var headers = lastRow >= 1 ? sh.getRange(1, 1, 1, Math.max(lastCol, AV_COL_INDEX + 1)).getValues()[0] : [];
  var plateCol = -1;
  for (var i = 0; i < headers.length; i++) {
    var hn = String(headers[i] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/\s+/g, ' ').trim();
    if (plateCol < 0 && (hn === 'bien so' || hn === 'bks' || hn === 'bien kiem soat')) plateCol = i;
  }
  var result = {
    ok: true, sheet: sheetName, lastRow: lastRow, lastCol: lastCol,
    avCol: AV_COL_INDEX, avColLetter: columnLetter_(AV_COL_INDEX + 1),
    plateCol: plateCol, plateHeader: plateCol >= 0 ? String(headers[plateCol] || '') : '',
    avHeader: String(headers[AV_COL_INDEX] || '').trim(),
    sampleRows: [], lastLog: getAvSyncLog_()
  };
  if (lastRow >= 2 && plateCol >= 0) {
    var n = Math.min(10, lastRow - 1);
    var data = sh.getRange(2, 1, n, Math.max(lastCol, AV_COL_INDEX + 1)).getValues();
    data.forEach(function (row) {
      result.sampleRows.push({
        bienSo: String(row[plateCol] || ''),
        normalizedBienSo: avNormalizePlate_(row[plateCol]),
        avValue: String(row[AV_COL_INDEX] || '')
      });
    });
  }
  return result;
}

function syncAvStatus_(d) {
  if (!d || !Array.isArray(d.items) || !d.items.length) {
    return { ok: true, wrote: 0, notFoundCount: 0, notFoundList: [], duplicates: [], skipped: 0, downgradesSkipped: 0, totalItems: 0 };
  }
  var sheetName = d.sheetName || AV_SHEET_DEFAULT;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'Lock timeout (25s) — thử lại sau.' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return { ok: false, error: 'Không tìm thấy sheet "' + sheetName + '".' };
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2) return { ok: true, wrote: 0, notFoundCount: d.items.length, notFoundList: [], duplicates: [], skipped: 0, downgradesSkipped: 0, totalItems: d.items.length };

    // 1) Tìm cột "Biển số" (theo tiêu đề dòng 1, có alias).
    var headers = sh.getRange(1, 1, 1, Math.max(lastCol, AV_COL_INDEX + 1)).getValues()[0];
    var plateCol = -1;
    for (var i = 0; i < headers.length; i++) {
      var hn = String(headers[i] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/\s+/g, ' ').trim();
      if (plateCol < 0 && (hn === 'bien so' || hn === 'bks' || hn === 'bien kiem soat')) plateCol = i;
    }
    if (plateCol < 0) return { ok: false, error: 'Không tìm thấy cột "Biển số" trong sheet "' + sheetName + '".' };

    // 2) Đảm bảo cột AV (48) tồn tại & có tiêu đề đúng. Nếu AV1 có tiêu đề KHÁC (không rỗng, không phải alias) → báo lỗi để bảo vệ dữ liệu.
    var avCol = AV_COL_INDEX;
    var existingHeader = '';
    try { existingHeader = String(sh.getRange(1, avCol + 1).getValue() || '').trim(); } catch (e) { existingHeader = ''; }
    var existingHeaderNorm = String(existingHeader).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    var avAliasesNorm = ['trang thai xe chua kiem', 'trang thai kiem', 'trang thai kiem phieu', 'trang thai kiem tra', 'av'];
    if (existingHeader && avAliasesNorm.indexOf(existingHeaderNorm) < 0) {
      return { ok: false, error: 'Cột AV (48) đang có tiêu đề "' + existingHeader + '" — không phải "' + AV_HEADER + '". Đổi tiêu đề hoặc xoá trắng AV1 rồi thử lại.' };
    }
    if (avCol + 1 > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), avCol + 1 - sh.getMaxColumns());
    if (!existingHeader) sh.getRange(1, avCol + 1).setValue(AV_HEADER).setFontWeight('bold');
    lastCol = Math.max(lastCol, avCol + 1);

    // 3) Đọc toàn bộ vùng dữ liệu 1 lần (giữ nguyên display values cho CCCD/số khung).
    var data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    // 4) Map plate chuẩn hoá → danh sách row index (0-based trong data).
    var plateMap = {};
    for (var r = 0; r < data.length; r++) {
      var pk = avNormalizePlate_(data[r][plateCol]);
      if (!pk) continue;
      if (!plateMap[pk]) plateMap[pk] = [];
      plateMap[pk].push(r);
    }

    // 5) Đọc AV hiện tại (toàn cột).
    var avValues = data.map(function (row) { return String(row[avCol] || '').trim(); });

    var wrote = 0, notFound = [], duplicates = [], skipped = 0, downgrades = [];

    // 6) Xử lý từng item.
    d.items.forEach(function (it) {
      var pk = avNormalizePlate_(it.bienSo);
      if (!pk) { skipped++; return; }
      var rows = plateMap[pk];
      if (!rows || !rows.length) { notFound.push(it.bienSo); return; }
      if (rows.length > 1) {
        duplicates.push({ bienSo: it.bienSo, rows: rows.map(function (i) { return i + 2; }) });
        return;
      }
      var r0 = rows[0];
      var newVal = avStatusLabel_(it.status, it.lanKiem);
      if (avValues[r0] === newVal) return;                        // idempotent (đã đúng)
      var newRank = avStatusRank_(newVal), curRank = avStatusRank_(avValues[r0]);
      if (newRank <= curRank) {                                   // KHÔNG hạ cấp
        if (newRank < curRank) downgrades.push({ bienSo: it.bienSo, row: r0 + 2, from: avValues[r0], to: newVal });
        return;
      }
      avValues[r0] = newVal;
      wrote++;
    });

    // 7) Ghi AV cột 1 lần bằng setValues (batch, đúng yêu cầu [1c]).
    if (wrote > 0) {
      var avRange = sh.getRange(2, avCol + 1, avValues.length, 1);
      avRange.setNumberFormat('@');
      avRange.setValues(avValues.map(function (v) { return [v]; }));
      SpreadsheetApp.flush();
    }

    // 8) Log chi tiết.
    var log = {
      at: new Date().toISOString(), sheet: sheetName,
      avCol: avCol, avColLetter: columnLetter_(avCol + 1),
      avHeaderBefore: existingHeader,
      totalItems: d.items.length, wrote: wrote,
      notFoundCount: notFound.length, notFoundList: notFound.slice(0, 30),
      duplicatesCount: duplicates.length, duplicates: duplicates.slice(0, 10),
      skipped: skipped,
      downgradesSkipped: downgrades.length, downgradesList: downgrades.slice(0, 20)
    };
    try { PropertiesService.getScriptProperties().setProperty('AV_LAST_SYNC_LOG', JSON.stringify(log)); } catch (e) { /* bỏ qua */ }

    return {
      ok: true, wrote: wrote, totalItems: d.items.length,
      notFoundCount: notFound.length, notFoundList: notFound.slice(0, 30),
      duplicates: duplicates, skipped: skipped,
      downgradesSkipped: downgrades.length,
      avCol: avCol, avColLetter: columnLetter_(avCol + 1)
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally { lock.releaseLock(); }
}

/* =========================================================================
   PHẦN 8 — HÀNG ĐỢI KIỂM LẠI PHIẾU CHƯA KIỂM CHẠY NGẦM TRÊN SERVER (yêu cầu [2])
   -------------------------------------------------------------------------
   Cài đặt 1 lần:
     1) setGeminiApiKey('AIza...')  — lưu API key vào PropertiesService (không lộ ra FE).
     2) installScanQueueTrigger()   — tạo trigger 5 phút chạy scanQueueTick_.
   Frontend gọi:
     • 'scanQueuePush'  — { jobs:[ { scanId, itemId, bienSo, lanKiemHienTai, scanData:{...} } ] }
     • 'scanQueueStatus'— xem tiến độ + log tick cuối
     • 'scanQueueClear' — xoá job done/error cũ (mode:'done'|'all'|'error')
   Server (scanQueueTick_) mỗi lần xử lý 1 job 'pending':
     • Lấy ảnh từ Drive qua scanGet_.
     • Gọi Gemini với prompt đọc lại.
     • So sánh từng trường với scanData đã lưu.
     • Khớp hết → 'done' + tự ghi AV = 'Đã kiểm lại lần {n+1}'.
     • Lệch → 'needs_review' + lưu diff JSON để người dùng xem.
     • 429 → backoff 60 phút rồi tự tiếp tục.
   ========================================================================= */
var SQ_SHEET = 'ScanQueue';
var SQ_GEMINI_KEY_PROP = 'GEMINI_API_KEY';
var SQ_GEMINI_MODEL = 'gemini-2.5-flash';
var SQ_GEMINI_FALLBACK = ['gemini-2.5-flash-lite', 'gemini-1.5-flash'];
var SQ_GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
var SQ_BATCH_LIMIT = 1;
var SQ_HEADERS = ['Mã job','Mã phiếu','Mã mục','Biển số','Lần kiểm','Dữ liệu cũ (JSON)','Trạng thái','Kết quả (JSON)','Lỗi','Thời gian tạo','Thời gian xử lý','Backoff đến'];

function sqSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SQ_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SQ_SHEET);
    sh.getRange(1, 1, 1, SQ_HEADERS.length).setValues([SQ_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else {
    var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    var missing = SQ_HEADERS.filter(function (h) { return cur.indexOf(h) < 0; });
    if (missing.length) {
      var from = cur.length;
      if (sh.getMaxColumns() < from + missing.length) sh.insertColumnsAfter(sh.getMaxColumns(), from + missing.length - sh.getMaxColumns());
      sh.getRange(1, from + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    }
  }
  return sh;
}
function sqHeaders_(sh) { return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]; }
function sqCol_(headers, name) { return headers.indexOf(name); }
function sqNow_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy HH:mm:ss'); }
function sqCell_(v) { return v == null ? '' : String(v).slice(0, 49000); }

function scanQueuePush_(d) {
  if (!d || !Array.isArray(d.jobs) || !d.jobs.length) return { ok: true, added: 0 };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Lock timeout — thử lại sau.' };
  try {
    var sh = sqSheet_(), headers = sqHeaders_(sh);
    var cJob = sqCol_(headers, 'Mã job'), cScan = sqCol_(headers, 'Mã phiếu'), cItem = sqCol_(headers, 'Mã mục');
    var cPlate = sqCol_(headers, 'Biển số'), cLan = sqCol_(headers, 'Lần kiểm'), cOld = sqCol_(headers, 'Dữ liệu cũ (JSON)');
    var cStatus = sqCol_(headers, 'Trạng thái'), cCreated = sqCol_(headers, 'Thời gian tạo');
    var now = sqNow_();
    var existing = {};
    var lastRow = sh.getLastRow();
    if (lastRow > 1) {
      var scanVals = sh.getRange(2, cScan + 1, lastRow - 1, 1).getValues();
      var itemVals = sh.getRange(2, cItem + 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < scanVals.length; i++) existing[scanVals[i][0] + '|' + itemVals[i][0]] = true;
    }
    var newRows = [];
    d.jobs.forEach(function (j) {
      if (!j || !j.scanId || !j.itemId) return;
      var key = j.scanId + '|' + j.itemId;
      if (existing[key]) return;
      var row = new Array(headers.length).fill('');
      row[cJob] = Utilities.getUuid();
      row[cScan] = j.scanId;
      row[cItem] = j.itemId;
      row[cPlate] = j.bienSo || '';
      row[cLan] = j.lanKiemHienTai || 0;
      row[cOld] = sqCell_(JSON.stringify(j.scanData || {}));
      row[cStatus] = 'pending';
      row[cCreated] = now;
      newRows.push(row);
      existing[key] = true;
    });
    if (!newRows.length) return { ok: true, added: 0 };
    var startRow = sh.getLastRow() + 1;
    var rg = sh.getRange(startRow, 1, newRows.length, headers.length);
    rg.setNumberFormat('@');
    rg.setValues(newRows);
    return { ok: true, added: newRows.length };
  } finally { lock.releaseLock(); }
}

function scanQueueStatus_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SQ_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: true, counts: {}, total: 0 };
  var headers = sqHeaders_(sh), cStatus = sqCol_(headers, 'Trạng thái');
  if (cStatus < 0) return { ok: true, counts: {}, total: 0 };
  var vals = sh.getRange(2, cStatus + 1, sh.getLastRow() - 1, 1).getValues();
  var counts = {};
  vals.forEach(function (v) { var s = String(v[0] || 'pending'); counts[s] = (counts[s] || 0) + 1; });
  var log = null;
  try { var raw = PropertiesService.getScriptProperties().getProperty('SQ_LAST_TICK'); if (raw) log = JSON.parse(raw); } catch (e) { /* bỏ qua */ }
  return { ok: true, counts: counts, total: vals.length, lastTick: log };
}

function scanQueueClear_(d) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SQ_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: true, deleted: 0 };
  var headers = sqHeaders_(sh), cStatus = sqCol_(headers, 'Trạng thái');
  var mode = (d && d.mode) || 'done';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, error: 'Lock timeout.' };
  try {
    var last = sh.getLastRow(), vals = sh.getRange(2, cStatus + 1, last - 1, 1).getValues();
    var toDel = [];
    vals.forEach(function (v, i) {
      var s = String(v[0] || '');
      if (mode === 'all' || (mode === 'done' && (s === 'done' || s === 'needs_review')) || (mode === 'error' && s === 'error')) toDel.push(i + 2);
    });
    toDel.sort(function (a, b) { return b - a; });
    toDel.forEach(function (r) { sh.deleteRow(r); });
    return { ok: true, deleted: toDel.length };
  } finally { lock.releaseLock(); }
}

var SQ_SCAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    loaiPhieu: { type: 'STRING' },
    danhSachXe: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          bienSo: { type: 'STRING' }, loaiXe: { type: 'STRING' },
          tinhTrang: { type: 'STRING' }, tinhTrangGhiTrenPhieu: { type: 'STRING' },
          ghiChu: { type: 'STRING' }, tenDKX: { type: 'STRING' }, nguoiMuaSuDung: { type: 'STRING' }
        },
        required: ['bienSo']
      }
    },
    chuHo: { type: 'STRING' }, cccd: { type: 'STRING' }, sdt: { type: 'STRING' },
    ghiChuTay: { type: 'STRING' }, backHasContent: { type: 'BOOLEAN' },
    backNote: { type: 'STRING' }, truongKhongRo: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['loaiPhieu', 'danhSachXe', 'chuHo', 'cccd', 'sdt', 'ghiChuTay']
};
function sqPrompt_() {
  return 'Bạn là công cụ OCR chuyên đọc phiếu giấy tiếng Việt về phương tiện. Đọc ảnh và trả về DUY NHẤT JSON đúng schema. ' +
    'Quy tắc: (1) Mỗi xe trên phiếu = 1 phần tử danhSachXe; bienSo chép ĐÚNG như phiếu; ' +
    'tenDKX là "Tên trong ĐKX" của dòng xe (chủ phương tiện thật); nguoiMuaSuDung là "Tên người mua / người sử dụng" của dòng xe; ' +
    'chuHo là tên chủ phiếu/chủ hộ ở đầu phiếu; (2) cccd/sdt chỉ gồm chữ số; (3) KHÔNG bịa — trường không có để "".';
}

function sqCallGemini_(parts) {
  var key = PropertiesService.getScriptProperties().getProperty(SQ_GEMINI_KEY_PROP);
  if (!key) throw new Error('Chưa cấu hình GEMINI_API_KEY. Chạy setGeminiApiKey("AIza...") 1 lần.');
  var models = [SQ_GEMINI_MODEL].concat(SQ_GEMINI_FALLBACK);
  var lastErr = '';
  for (var mi = 0; mi < models.length; mi++) {
    var model = models[mi];
    var payload = {
      contents: [{ role: 'user', parts: parts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SQ_SCAN_SCHEMA }
    };
    try {
      var res = UrlFetchApp.fetch(SQ_GEMINI_ENDPOINT + model + ':generateContent', {
        method: 'post', contentType: 'application/json',
        headers: { 'x-goog-api-key': key },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode(), txt = res.getContentText();
      if (code === 429) throw new Error('QUOTA_429: ' + txt.slice(0, 200));
      if (code === 503 || code === 500 || code === 502 || code === 504) { lastErr = 'HTTP ' + code + ': ' + txt.slice(0, 200); continue; }
      if (code === 404) { lastErr = 'Model ' + model + ' not found'; continue; }
      if (code !== 200) throw new Error('HTTP ' + code + ': ' + txt.slice(0, 200));
      var data = JSON.parse(txt);
      var cand = data.candidates && data.candidates[0];
      var block = data.promptFeedback && data.promptFeedback.blockReason;
      if (block) throw new Error('Gemini chặn nội dung: ' + block);
      var outTxt = cand && cand.content && cand.content.parts ? cand.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
      if (!outTxt.trim()) throw new Error('Gemini trả rỗng (finishReason=' + (cand && cand.finishReason) + ')');
      outTxt = outTxt.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
      return { json: JSON.parse(outTxt), model: model };
    } catch (e) {
      lastErr = String(e.message || e);
      if (/QUOTA_429/.test(lastErr)) throw e;
    }
  }
  throw new Error('Tất cả model đều lỗi. Lỗi cuối: ' + lastErr);
}

function sqCompareFields_(oldScanData, newJson) {
  var diffs = [];
  var norm = function (s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/[^a-z0-9]/g, '').trim(); };
  var vehicles = (newJson.danhSachXe || []);
  var firstVeh = vehicles[0] || {};
  var check = function (field, oldV, newV) {
    if (norm(oldV) !== norm(newV)) diffs.push({ field: field, old: oldV || '', new: newV || '' });
  };
  check('chuXe', oldScanData.chuXe, firstVeh.tenDKX || newJson.chuHo || '');
  check('cccd', oldScanData.cccd, newJson.cccd || '');
  check('soDienThoai', oldScanData.soDienThoai, newJson.sdt || '');
  var newNote = [newJson.ghiChuTay, newJson.backNote].filter(Boolean).join('; ');
  check('ghiChu', oldScanData.ghiChu, newNote);
  return diffs;
}

function processQueueJob_(sh, rowNo, headers, rowData) {
  var cScan = sqCol_(headers, 'Mã phiếu'), cOld = sqCol_(headers, 'Dữ liệu cũ (JSON)');
  var cLan = sqCol_(headers, 'Lần kiểm'), cStatus = sqCol_(headers, 'Trạng thái');
  var cResult = sqCol_(headers, 'Kết quả (JSON)'), cErr = sqCol_(headers, 'Lỗi'), cProc = sqCol_(headers, 'Thời gian xử lý');
  var cPlate = sqCol_(headers, 'Biển số');
  var scanId = String(rowData[cScan] || '');
  var oldData = {};
  try { oldData = JSON.parse(String(rowData[cOld] || '{}')); } catch (e) { oldData = {}; }
  var front = scanGet_({ scanId: scanId, kind: 'front' });
  var back = scanGet_({ scanId: scanId, kind: 'back' });
  if (!front.ok) throw new Error('Không lấy được ảnh front: ' + (front.error || ''));
  var parts = [{ text: sqPrompt_() }, { text: 'MẶT 1:' }, { inlineData: { mimeType: front.mime, data: front.b64 } }];
  if (back && back.ok) {
    parts.push({ text: 'MẶT 2:' });
    parts.push({ inlineData: { mimeType: back.mime, data: back.b64 } });
  }
  var r = sqCallGemini_(parts);
  var diffs = sqCompareFields_(oldData, r.json);
  var newStatus, result;
  if (diffs.length === 0) {
    var lanMoi = (parseInt(rowData[cLan], 10) || 0) + 1;
    newStatus = 'done';
    result = { ok: true, model: r.model, lanMoi: lanMoi, diffs: [] };
  } else {
    newStatus = 'needs_review';
    result = { ok: false, model: r.model, diffs: diffs, gemini: r.json };
  }
  sh.getRange(rowNo, cStatus + 1).setValue(newStatus);
  sh.getRange(rowNo, cResult + 1).setValue(sqCell_(JSON.stringify(result))).setNumberFormat('@');
  sh.getRange(rowNo, cProc + 1).setValue(sqNow_());
  sh.getRange(rowNo, cErr + 1).setValue('');
  if (newStatus === 'done' && cPlate >= 0) {
    try {
      syncAvStatus_({ sheetName: 'Tong hop', items: [{ bienSo: rowData[cPlate], status: 'da_kiem_lai', lanKiem: result.lanMoi }] });
    } catch (e) { /* bỏ qua — AV sẽ được đồng bộ lần sau */ }
  }
}

function scanQueueTick_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return { ok: false, error: 'Đang có tick khác chạy.' };
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SQ_SHEET);
    if (!sh || sh.getLastRow() < 2) return { ok: true, processed: 0, reason: 'no sheet or empty' };
    var headers = sqHeaders_(sh);
    var cStatus = sqCol_(headers, 'Trạng thái'), cBackoff = sqCol_(headers, 'Backoff đến');
    var now = new Date(), lastRow = sh.getLastRow();
    var statusVals = sh.getRange(2, cStatus + 1, lastRow - 1, 1).getValues();
    var backoffVals = sh.getRange(2, cBackoff + 1, lastRow - 1, 1).getValues();
    var candidates = [];
    for (var i = 0; i < statusVals.length; i++) {
      if (String(statusVals[i][0]) !== 'pending') continue;
      var bstr = String(backoffVals[i][0] || '').trim();
      if (bstr) { var bd = new Date(bstr); if (!isNaN(bd.getTime()) && bd > now) continue; }
      candidates.push(i + 2);
      if (candidates.length >= SQ_BATCH_LIMIT) break;
    }
    if (!candidates.length) {
      try { PropertiesService.getScriptProperties().setProperty('SQ_LAST_TICK', JSON.stringify({ at: new Date().toISOString(), processed: 0, reason: 'no pending' })); } catch (e) { /* bỏ qua */ }
      return { ok: true, processed: 0, reason: 'no pending' };
    }
    var processed = 0, errors = [];
    candidates.forEach(function (rowNo) {
      sh.getRange(rowNo, cStatus + 1).setValue('processing');
      SpreadsheetApp.flush();
      var rowData = sh.getRange(rowNo, 1, 1, sh.getLastColumn()).getValues()[0];
      try { processQueueJob_(sh, rowNo, headers, rowData); processed++; }
      catch (e) {
        var errMsg = String(e.message || e);
        sh.getRange(rowNo, sqCol_(headers, 'Lỗi') + 1).setValue(errMsg.slice(0, 500));
        if (/QUOTA_429/.test(errMsg)) {
          var nextAt = new Date(Date.now() + 60 * 60 * 1000);
          sh.getRange(rowNo, cStatus + 1).setValue('pending');
          sh.getRange(rowNo, cBackoff + 1).setValue(Utilities.formatDate(nextAt, Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd HH:mm:ss')).setNumberFormat('@');
        } else {
          sh.getRange(rowNo, cStatus + 1).setValue('error');
        }
        errors.push({ row: rowNo, error: errMsg });
      }
    });
    try { PropertiesService.getScriptProperties().setProperty('SQ_LAST_TICK', JSON.stringify({ at: new Date().toISOString(), processed: processed, errors: errors })); } catch (e) { /* bỏ qua */ }
    return { ok: true, processed: processed, errors: errors };
  } finally { lock.releaseLock(); }
}

function installScanQueueTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'scanQueueTick_') return { ok: true, message: 'Trigger đã tồn tại.', existing: true };
  }
  ScriptApp.newTrigger('scanQueueTick_').timeBased().everyMinutes(5).create();
  return { ok: true, message: 'Đã tạo trigger 5 phút.' };
}
function setGeminiApiKey(key) {
  if (!key || !/^AIza/.test(key)) return { ok: false, error: 'API key không hợp lệ (phải bắt đầu bằng AIza).' };
  PropertiesService.getScriptProperties().setProperty(SQ_GEMINI_KEY_PROP, String(key).trim());
  return { ok: true, message: 'Đã lưu GEMINI_API_KEY vào PropertiesService.' };
}