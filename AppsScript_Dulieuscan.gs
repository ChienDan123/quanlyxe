/* =========================================================================
   AppsScript_Dulieuscan.gs — GHI DỮ LIỆU «TỪ PHIẾU SCAN» VÀO SHEET «Dulieuscan»
   - CHỈ đọc/ghi đúng tab «Dulieuscan» (tự tạo nếu chưa có). KHÔNG đụng «Tong hop», «DL PC08 do», «Settings»…
   - Mỗi XE trên mỗi PHIẾU = 1 dòng. Khóa: «Mã phiếu» + «Mã mục» -> gửi lại nhiều lần chỉ CẬP NHẬT dòng cũ, không tạo dòng trùng.
   - Chỉ ghi các cột web gửi lên; cột khác do bạn tự thêm trong sheet được GIỮ NGUYÊN.
   - Phiếu bị xóa trên web: dòng KHÔNG bị xóa, chỉ đánh dấu «Đã xóa trên web» ở cột «Trạng thái phiếu».
   - Action: scanSheetUpsert · scanSheetDelete · scanSheetPing (được nối trong scanDispatch_ ở Ma_lenh_luu_anh.gs).
   Dán file này vào dự án Apps Script (file mới), rồi Triển khai → Quản lý bản triển khai → ✏ → Phiên bản mới.
   ========================================================================= */
var DLS_SHEET_NAME = 'Dulieuscan';
var DLS_KEY_SCAN = 'Mã phiếu';
var DLS_KEY_ITEM = 'Mã mục';
var DLS_HEADERS = [
  'Mã phiếu', 'Mã mục', 'Thời gian quét', 'Nguồn phiếu', 'Loại phiếu',
  'Biển số', 'Biển số đọc trên phiếu', 'Chủ xe', 'CCCD', 'SĐT',
  'Tình trạng phương tiện', 'Tình trạng ghi trên phiếu', 'Ghi chú', 'Ghi chú chung của phiếu',
  'Mặt 2 có nội dung', 'Trường không rõ', 'Biển khớp danh sách',
  'Trạng thái kiểm', 'Người thực hiện', 'Tình trạng cam kết', 'Trạng thái xe (đối chiếu)',
  'Kết quả đối chiếu (JSON)', 'Dữ liệu mục (JSON)', 'Dữ liệu từ phiếu (JSON)',
  'Trạng thái phiếu', 'Cập nhật lúc'
];

function dls_now_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy HH:mm:ss'); }
function dls_cell_(v) { return v == null ? '' : String(v).slice(0, 49000); }   // ô Google Sheet tối đa 50.000 ký tự
function dls_sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(DLS_SHEET_NAME) || ss.insertSheet(DLS_SHEET_NAME);
}
// Đảm bảo dòng 1 có tiêu đề; cột còn thiếu được THÊM Ở CUỐI (không đổi thứ tự / không xóa cột có sẵn). Trả về mảng tiêu đề.
function dls_headers_(sh, needed) {
  var lastC = sh.getLastColumn(), headers = lastC ? sh.getRange(1, 1, 1, lastC).getValues()[0].map(String) : [];
  var empty = !headers.some(function (h) { return h !== ''; });
  if (empty) headers = [];
  var add = [];
  needed.forEach(function (h) { if (headers.indexOf(h) < 0 && add.indexOf(h) < 0) add.push(h); });
  if (add.length) {
    var from = headers.length;
    if (sh.getMaxColumns() < from + add.length) sh.insertColumnsAfter(sh.getMaxColumns(), from + add.length - sh.getMaxColumns());
    var rng = sh.getRange(1, from + 1, 1, add.length);
    rng.setValues([add]).setFontWeight('bold');
    if (empty) sh.setFrozenRows(1);
    headers = headers.concat(add);
  }
  return headers;
}
function dls_rowArray_(headers, r) {
  return headers.map(function (h) { return Object.prototype.hasOwnProperty.call(r, h) ? dls_cell_(r[h]) : ''; });
}
// Cập nhật 1 dòng có sẵn: chỉ đè các cột có trong r, giữ nguyên cột khác
function dls_writeRow_(sh, rowNo, headers, r) {
  var rng = sh.getRange(rowNo, 1, 1, headers.length), vals = rng.getValues()[0];
  headers.forEach(function (h, c) { if (Object.prototype.hasOwnProperty.call(r, h)) vals[c] = dls_cell_(r[h]); });
  rng.setNumberFormat('@');          // dạng văn bản: giữ số 0 đầu của CCCD / SĐT
  rng.setValues([vals]);
}

// d.scans = [{ scanId, rows: [ { 'Mã mục': '...', 'Biển số': '...', ... } ] }]
// Với mỗi phiếu: cập nhật dòng trùng «Mã mục», thêm dòng mới, và bỏ các dòng cũ của CHÍNH phiếu đó không còn trong danh sách (vd. dòng tạm trước khi có mục so sánh).
function dls_upsert_(d) {
  var scans = (d && d.scans) || [];
  if (!scans.length) return { ok: true, added: 0, updated: 0, removed: 0 };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var sh = dls_sheet_(), need = DLS_HEADERS.slice();
    scans.forEach(function (s) { (s.rows || []).forEach(function (r) { Object.keys(r).forEach(function (k) { if (need.indexOf(k) < 0) need.push(k); }); }); });
    var headers = dls_headers_(sh, need), W = headers.length;
    var cS = headers.indexOf(DLS_KEY_SCAN), cI = headers.indexOf(DLS_KEY_ITEM), now = dls_now_();
    var last = sh.getLastRow(), existing = {}, delRows = [];
    if (last > 1) {
      var ks = sh.getRange(2, cS + 1, last - 1, 1).getValues(), ki = sh.getRange(2, cI + 1, last - 1, 1).getValues();
      for (var i = 0; i < ks.length; i++) {
        var sid = String(ks[i][0]); if (!sid) continue;
        var m = existing[sid] = existing[sid] || {}, key = String(ki[i][0]);
        if (m[key]) delRows.push(m[key]);          // dòng trùng khóa (hiếm) -> bỏ bản cũ
        m[key] = i + 2;
      }
    }
    var added = 0, updated = 0, appendRows = [];
    scans.forEach(function (sc) {
      var scanId = String(sc.scanId || ''); if (!scanId) return;
      var cur = existing[scanId] || {}, keep = {};
      (sc.rows || []).forEach(function (r) {
        r[DLS_KEY_SCAN] = scanId; r['Cập nhật lúc'] = now; r['Trạng thái phiếu'] = 'Đang có';
        var k = String(r[DLS_KEY_ITEM] || ''); keep[k] = true;
        if (cur[k]) { dls_writeRow_(sh, cur[k], headers, r); updated++; }
        else appendRows.push(dls_rowArray_(headers, r));
      });
      Object.keys(cur).forEach(function (k) { if (!keep[k]) delRows.push(cur[k]); });
    });
    if (appendRows.length) {
      var start = sh.getLastRow() + 1, endRow = start + appendRows.length - 1;
      if (sh.getMaxRows() < endRow) sh.insertRowsAfter(sh.getMaxRows(), endRow - sh.getMaxRows());
      var rng = sh.getRange(start, 1, appendRows.length, W);
      rng.setNumberFormat('@'); rng.setValues(appendRows); added = appendRows.length;
    }
    delRows.sort(function (a, b) { return b - a; });                  // xóa từ dưới lên để số dòng không lệch
    delRows.forEach(function (r) { try { sh.deleteRow(r); } catch (e) { sh.getRange(r, 1, 1, W).clearContent(); } });
    return { ok: true, added: added, updated: updated, removed: delRows.length };
  } finally { lock.releaseLock(); }
}

// d.scanIds = [...]: phiếu bị xóa trên web -> KHÔNG xóa dòng, chỉ đánh dấu
function dls_delete_(d) {
  var ids = (d && d.scanIds) || (d && d.scanId ? [d.scanId] : []);
  if (!ids.length) return { ok: true, marked: 0 };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var sh = dls_sheet_(), headers = dls_headers_(sh, DLS_HEADERS), last = sh.getLastRow(), marked = 0;
    if (last < 2) return { ok: true, marked: 0 };
    var cS = headers.indexOf(DLS_KEY_SCAN), cT = headers.indexOf('Trạng thái phiếu'), cU = headers.indexOf('Cập nhật lúc');
    var want = {}; ids.forEach(function (x) { want[String(x)] = true; });
    var ks = sh.getRange(2, cS + 1, last - 1, 1).getValues(), now = dls_now_();
    for (var i = 0; i < ks.length; i++) {
      if (!want[String(ks[i][0])]) continue;
      sh.getRange(i + 2, cT + 1).setNumberFormat('@').setValue('Đã xóa trên web');
      sh.getRange(i + 2, cU + 1).setNumberFormat('@').setValue(now); marked++;
    }
    return { ok: true, marked: marked };
  } finally { lock.releaseLock(); }
}

function dls_ping_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DLS_SHEET_NAME);
  return { ok: true, sheet: DLS_SHEET_NAME, exists: !!sh, rows: sh ? Math.max(0, sh.getLastRow() - 1) : 0 };
}

/* Tự kiểm tra: chọn hàm dlsSelfTest → Chạy → xem «Nhật ký thực thi». Không ghi dữ liệu. */
function dlsSelfTest() {
  var out = [], say = function (ok, m) { out.push((ok ? '✔ ' : '✘ ') + m); };
  var p = dls_ping_();
  say(true, 'Tab «' + DLS_SHEET_NAME + '»: ' + (p.exists ? 'có (' + p.rows + ' dòng dữ liệu)' : 'CHƯA có — sẽ tự tạo khi web gửi dữ liệu đầu tiên'));
  try {
    var j = JSON.parse(doPost({ postData: { contents: JSON.stringify({ action: 'scanSheetPing' }) } }).getContent());
    say(j.ok === true && j.sheet === DLS_SHEET_NAME, 'doPost đã nối scanSheetPing: ' + JSON.stringify(j));
  } catch (e) { say(false, 'doPost chưa nhận scanSheetPing — thêm 3 case scanSheet* vào scanDispatch_ (xem Ma_lenh_luu_anh.gs): ' + e.message); }
  Logger.log(out.join('\n')); return out.join('\n');
}
