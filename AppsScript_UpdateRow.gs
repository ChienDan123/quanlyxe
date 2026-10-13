// ============================================================================
// AppsScript_UpdateRow.gs — "CỬA VÀO" DUY NHẤT cho POST của Web App (bản 8)
// ----------------------------------------------------------------------------
// NGUYÊN NHÂN CÁC LỖI CŨ (đã sửa trong bản này):
//   1) Dự án có NHIỀU hàm doPost (Code.gs, AppsScript_DoPost.gs, file này). Apps Script chỉ chạy MỘT hàm — hàm nạp sau cùng
//      thắng — nên action «updateRow» bị báo «Unknown POST action».
//   2) Bản 7 gọi scanDispatch_(e) (truyền SỰ KIỆN) trong khi scanDispatch_ cần DỮ LIỆU ĐÃ PARSE (d.action) -> luôn trả null
//      -> MỌI action scan* (scanPing, scanPut…) báo «Unknown POST action: scanPing». Bản này truyền đúng `data` và bọc kết quả JSON.
//   3) Bản 7 thiếu appendRow và lưu saveSettings vào DocumentProperties trong khi doGet đọc từ tab «Settings» -> mẫu cam kết
//      lưu xong không đọc lại được. Bản này ghi vào Settings!A1 (khớp doGet của Code.gs) và có appendRow.
// CÁCH DÙNG: xem phần HƯỚNG DẪN ở cuối file. QUAN TRỌNG: toàn dự án chỉ được có ĐÚNG 1 hàm doPost (hàm ở file này).
// ============================================================================

const UR_VERSION = 8;
const UR_SETTINGS_SHEET = 'Settings';                                  // trùng SETTINGS_SHEET_NAME của Code.gs
const UR_SYSTEM_TABS = ['GeminiConfig', 'Settings', 'PhieuLa'];        // tab hệ thống: không bao giờ dò làm tab dữ liệu

/* ------------------------------ tiện ích ------------------------------ */
function ur_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
// Hàm khác có thể trả object thường hoặc TextOutput -> chuẩn hóa về TextOutput (doPost bắt buộc trả TextOutput)
function ur_wrap_(r) {
  if (r && typeof r.getContent === 'function') return r;
  return ur_json_(r == null ? { ok: true } : r);
}
// Chuẩn hóa tên cột: bỏ dấu, hoa/thường, khoảng trắng thừa (dùng \u0300-\u036f thay vì ký tự tổ hợp viết thẳng)
function ur_norm_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
// Cột biển số? (so khớp biển số bỏ dấu chấm/gạch/khoảng trắng)
function ur_isPlateHeader_(h) { return /^(bien so|bks|bien kiem soat)$/.test(ur_norm_(h)); }
// Khóa so khớp dòng
function ur_key_(header, v) {
  var s = String(v == null ? '' : v).trim();
  return ur_isPlateHeader_(header) ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : s.toLowerCase();
}
// Giá trị dễ bị Sheets tự đổi kiểu (số 0 đầu của CCCD/SĐT, dãy số, ngày, bắt đầu bằng = + - @) -> ghi dạng VĂN BẢN để giữ nguyên
function ur_needText_(v) { return typeof v === 'string' && /^[\d=+\-@]/.test(v); }
function ur_setCell_(range, v) {
  var s = v == null ? '' : String(v).slice(0, 49000);
  if (ur_needText_(s)) range.setNumberFormat('@');
  range.setValue(s);
}
// Danh sách tab cần thử, theo thứ tự ưu tiên: tên web gửi lên → GeminiConfig!B1 → hằng SHEET_NAME → «Tong hop» → các tab còn lại (trừ tab hệ thống)
function ur_candidates_(ss, wanted) {
  var out = [];
  var add = function (n) { n = String(n || '').trim(); var s = n && ss.getSheetByName(n); if (s && out.indexOf(s) < 0) out.push(s); };
  add(wanted);
  var cfg = ss.getSheetByName('GeminiConfig'); if (cfg) { try { add(cfg.getRange(1, 2).getValue()); } catch (e) { /* bỏ qua */ } }
  try { if (typeof SHEET_NAME !== 'undefined') add(SHEET_NAME); } catch (e) { /* bỏ qua */ }
  add('Tong hop');
  if (!out.length || !String(wanted || '').trim()) {                  // không chỉ định rõ -> dò thêm các tab còn lại
    ss.getSheets().forEach(function (s) { if (UR_SYSTEM_TABS.indexOf(s.getName()) < 0 && out.indexOf(s) < 0) out.push(s); });
  }
  return out;
}

/* ------------------------------ updateRow ------------------------------ */
/** Tìm dòng có cột matchHeader == matchValue rồi ghi các cột trong updates (cột chưa có → tự tạo ở cuối hàng tiêu đề). */
function updateRowAction_(data) {
  var matchHeader = String(data.matchHeader || '').trim();
  var matchValue = String(data.matchValue == null ? '' : data.matchValue).trim();
  var updates = data.updates || {};
  if (!matchHeader || !matchValue) return { ok: false, error: 'Thiếu matchHeader / matchValue.' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'Máy chủ đang bận (lock timeout), sẽ tự thử lại.' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = ur_candidates_(ss, data.sheetName);
    if (!sheets.length) return { ok: false, error: 'Không tìm thấy tab dữ liệu (sheet not found).' };
    var sawHeader = false, key = ur_key_(matchHeader, matchValue);
    for (var s = 0; s < sheets.length; s++) {
      var sh = sheets[s], lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
      if (lastCol < 1 || lastRow < 1) continue;
      var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(ur_norm_);
      var colOf = function (h) { return headers.indexOf(ur_norm_(h)) + 1; };   // 0 nếu chưa có
      var mCol = colOf(matchHeader);
      if (!mCol) continue;
      sawHeader = true;
      if (lastRow < 2) continue;
      // getDisplayValues: giữ nguyên số 0 đầu (CCCD / SĐT) như người dùng thấy trên Sheet
      var vals = sh.getRange(2, mCol, lastRow - 1, 1).getDisplayValues(), row = 0;
      for (var i = 0; i < vals.length; i++) { if (ur_key_(matchHeader, vals[i][0]) === key) { row = i + 2; break; } }
      if (!row) continue;
      var created = [], width = lastCol;
      Object.keys(updates).forEach(function (h) {
        var c = colOf(h);
        if (!c) {                                                       // cột chưa có -> tạo ở cuối hàng tiêu đề
          width++;
          if (width > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
          sh.getRange(1, width).setValue(h);
          headers[width - 1] = ur_norm_(h); c = width; created.push(h);
        }
        ur_setCell_(sh.getRange(row, c), updates[h]);
      });
      SpreadsheetApp.flush();
      return { ok: true, row: row, created: created, sheet: sh.getName() };
    }
    return { ok: false, error: sawHeader
      ? 'Không tìm thấy dòng có ' + matchHeader + ' = ' + matchValue + ' (row not found).'
      : 'Không tìm thấy cột khớp "' + matchHeader + '" trên Sheet (column not found).' };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally { lock.releaseLock(); }
}

/** appendRow: thêm 1 dòng mới cuối Sheet. data.row = { 'Tiêu đề cột': giá trị, … } (khớp tiêu đề không phân biệt hoa/thường, dấu) */
function appendRowAction_(data) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'Máy chủ đang bận (lock timeout), sẽ tự thử lại.' };
  try {
    var sh = ur_candidates_(SpreadsheetApp.getActiveSpreadsheet(), data.sheetName)[0];
    if (!sh) return { ok: false, error: 'Không tìm thấy tab dữ liệu (sheet not found).' };
    var headers = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    var src = data.row || {}, byNorm = {};
    Object.keys(src).forEach(function (k) { byNorm[ur_norm_(k)] = src[k]; });
    var newRow = headers.map(function (h) { var v = byNorm[ur_norm_(h)]; return v != null ? v : ''; });
    sh.appendRow(newRow);
    return { ok: true, row: sh.getLastRow(), sheet: sh.getName() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally { lock.releaseLock(); }
}

/** saveSettings: lưu mẫu Bản cam kết vào tab «Settings»!A1 (đúng nơi doGet?action=settings đọc lại) */
function saveSettingsAction_(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(UR_SETTINGS_SHEET) || ss.insertSheet(UR_SETTINGS_SHEET);
  sh.getRange('A1').setValue(JSON.stringify(data.template || {}));
  return { ok: true };
}

/* ------------------------------ ĐIỂM VÀO ------------------------------ */
// Tên các hàm doPost cũ (nếu bạn đổi tên thay vì xóa) — chỉ dùng cho action mà file này không biết
var UR_LEGACY_NAMES = ['doPostOld1_', 'doPostOld2_', 'doPostOld3_', 'doPostLegacy_', 'doPostGoc_', 'doPostCu_'];

/** CỬA VÀO DUY NHẤT của POST. Xóa/đổi tên mọi hàm doPost khác trong dự án. */
function doPost(e) {
  var data;
  try { data = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return ur_json_({ ok: false, error: 'Body không phải JSON hợp lệ.' }); }
  var action = String((data && data.action) || '');
  try {
    switch (action) {
      case 'updateRow':    return ur_json_(updateRowAction_(data));
      case 'appendRow':    return ur_json_(appendRowAction_(data));
      case 'saveSettings': return ur_json_(saveSettingsAction_(data));
      case 'write': {      // tương thích Code.gs cũ (ghi 1 ô)
        var sh = SpreadsheetApp.getActive().getSheetByName(data.sheet || 'Sheet1');
        if (!sh) return ur_json_({ ok: false, error: 'Sheet not found: ' + data.sheet });
        sh.getRange(data.row, data.col).setValue(data.value);
        return ur_json_({ ok: true });
      }
      case 'urPing':       return ur_json_({ ok: true, urVersion: UR_VERSION, scanDispatch: typeof scanDispatch_ === 'function' });
    }
    // Nhóm scan* (scanPing, scanPut, scanList, scanOrphanUpsert…): scanDispatch_ nhận DỮ LIỆU ĐÃ PARSE (không phải e) và trả object / null
    if (typeof scanDispatch_ === 'function') {
      var out = scanDispatch_(data);
      if (out) {
        if (action === 'scanPing' && !out.getContent) { out.urVersion = UR_VERSION; out.updateRow = true; }   // để web biết bản triển khai đã chạy code mới
        return ur_wrap_(out);
      }
    }
    // Dự phòng: bộ xử lý POST cũ đã đổi tên (nếu có) cho action lạ
    for (var i = 0; i < UR_LEGACY_NAMES.length; i++) {
      var f = this[UR_LEGACY_NAMES[i]];
      if (typeof f === 'function') return ur_wrap_(f(e));
    }
    return ur_json_({ ok: false, error: 'Unknown POST action: ' + action });
  } catch (err) {
    return ur_json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ------------------------------ TỰ KIỂM TRA ------------------------------
 * Chạy hàm urSelfTest trong trình soạn thảo (chọn hàm → ▶ Chạy → xem «Nhật ký thực thi»). Không ghi dữ liệu.
 * Báo: doPost có nhận đúng updateRow / scanPing chưa, có tab dữ liệu chưa, và cột «Người kiểm phiếu» đang ở cột nào (phải là AQ). */
function urSelfTest() {
  var out = [];
  var say = function (ok, m) { out.push((ok ? '✔ ' : '✘ ') + m); };
  try {
    var j = JSON.parse(doPost({ postData: { contents: JSON.stringify({ action: 'urPing' }) } }).getContent());
    say(j.ok && j.urVersion === UR_VERSION, 'doPost chạy bản ' + j.urVersion + (j.scanDispatch ? ' (đã nối scanDispatch_)' : ' — THIẾU scanDispatch_ (dán Ma_lenh_luu_anh.gs)'));
    var p = JSON.parse(doPost({ postData: { contents: JSON.stringify({ action: 'scanPing' }) } }).getContent());
    say(p.ok !== false && p.actions && p.actions.indexOf('scanOrphanUpsert') >= 0, 'scanPing: ' + JSON.stringify(p).slice(0, 160));
  } catch (e) { say(false, 'doPost lỗi: ' + e.message); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ur_candidates_(ss, '')[0];
    say(!!sh, 'Tab dữ liệu: ' + (sh ? sh.getName() : 'KHÔNG TÌM THẤY'));
    if (sh) {
      var hd = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(ur_norm_), c = hd.indexOf(ur_norm_('Người kiểm phiếu')) + 1;
      var letter = function (n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
      say(c === 43, 'Cột «Người kiểm phiếu»: ' + (c ? letter(c) + (c === 43 ? ' (đúng AQ)' : ' (khác AQ — kiểm tra lại tiêu đề)') : 'CHƯA CÓ (web sẽ tự tạo ở cuối)'));
    }
  } catch (e) { say(false, 'Kiểm tra Sheet lỗi: ' + e.message); }
  Logger.log(out.join('\n')); return out.join('\n');
}

/* ============================== HƯỚNG DẪN ==============================
 * 1) Apps Script → thay TOÀN BỘ nội dung file AppsScript_UpdateRow.gs bằng file này.
 * 2) XÓA file AppsScript_DoPost.gs (hàm doPost của nó trùng tên). Trong Code.gs đổi «function doPost(e)» thành «function doPostOld1_(e)»
 *    (file Code.gs đi kèm đã đổi sẵn). Đừng xóa scanDispatch_ và các hàm scan* (file Ma_lenh_luu_anh.gs). Chỉ giữ 1 doGet (ở Code.gs).
 * 3) Lưu → chạy urSelfTest() một lần (cấp quyền nếu được hỏi) → mọi dòng phải có dấu ✔.
 * 4) Triển khai → Quản lý bản triển khai → ✏️ trên bản có ID …R4vCoBPw → Phiên bản: «Phiên bản mới» → Triển khai (GIỮ NGUYÊN URL /exec).
 * 5) Kiểm tra từ trình duyệt máy khác: web tự gọi scanPing / updateRow; hoặc POST {"action":"urPing"} phải ra {"ok":true,"urVersion":8,…}.
 * ======================================================================= */
