// ============================================================================
// AppsScript_UpdateRow.gs — "CỬA VÀO" DUY NHẤT cho POST của Web App (bản 11)
// ----------------------------------------------------------------------------
// SỬA SO VỚI BẢN 10:
//   • Cột «Trạng thái xe chưa kiểm» được ghi đúng vào cột AV (cột 48) khi tiêu đề chưa có trên Sheet
//     — thay vì tạo thêm cột mới vô tội vạ (gây "cột rác" và lệch cột AV).
//   • ur_avFallbackCol_ kiểm tra ô tiêu đề AV: chỉ dùng AV khi ô đó trống hoặc đúng tiêu đề; nếu AV đang
//     bị chiếm bởi tiêu đề khác thì KHÔNG ghi đè (tránh mất dữ liệu) → khi đó mới tạo cột mới.
//   • Giữ nguyên toàn bộ logic updateRow / appendRow / saveSettings / doPost / scan* của bản 10.
// ============================================================================

const UR_VERSION = 11;
const UR_SETTINGS_SHEET = 'Settings';
const UR_SYSTEM_TABS = ['GeminiConfig', 'Settings', 'PhieuLa'];

/* ------------------------------ tiện ích ------------------------------ */
function ur_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function ur_wrap_(r) {
  if (r && typeof r.getContent === 'function') return r;
  return ur_json_(r == null ? { ok: true } : r);
}
function ur_norm_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function ur_isPlateHeader_(h) { return /^(bien so|bks|bien kiem soat)$/.test(ur_norm_(h)); }
function ur_key_(header, v) {
  var s = String(v == null ? '' : v).trim();
  return ur_isPlateHeader_(header) ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : s.toLowerCase();
}
function ur_needText_(v) { return typeof v === 'string' && /^[\d=+\-@]/.test(v); }
function ur_setCell_(range, v) {
  var s = v == null ? '' : String(v).slice(0, 49000);
  if (ur_needText_(s)) range.setNumberFormat('@');
  range.setValue(s);
}

/**
 * Cột «Trạng thái xe chưa kiểm» — fallback vị trí AV (cột 48, index 47).
 * Trả về số cột (1-based) nếu dùng được, hoặc 0 nếu AV đang bị cột khác chiếm.
 */
function ur_avFallbackCol_(sh, headers) {
  var AV_POS = 48;
  try {
    if (sh.getMaxColumns() < AV_POS) sh.insertColumnsAfter(sh.getMaxColumns(), AV_POS - sh.getMaxColumns());
    var curH = String(sh.getRange(1, AV_POS).getValue()).trim();
    if (curH && ur_norm_(curH) !== ur_norm_('Trạng thái xe chưa kiểm')) return 0;
    if (!curH) sh.getRange(1, AV_POS).setValue('Trạng thái xe chưa kiểm');
    while (headers.length < AV_POS) headers.push('');
    headers[AV_POS - 1] = ur_norm_('Trạng thái xe chưa kiểm');
    return AV_POS;
  } catch (e) { return 0; }
}

function ur_candidates_(ss, wanted) {
  var out = [];
  var add = function (n) { n = String(n || '').trim(); var s = n && ss.getSheetByName(n); if (s && out.indexOf(s) < 0) out.push(s); };
  add(wanted);
  var cfg = ss.getSheetByName('GeminiConfig'); if (cfg) { try { add(cfg.getRange(1, 2).getValue()); } catch (e) { /* bỏ qua */ } }
  try { if (typeof SHEET_NAME !== 'undefined') add(SHEET_NAME); } catch (e) { /* bỏ qua */ }
  add('Tong hop');
  if (!out.length || !String(wanted || '').trim()) {
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
      var colOf = function (h) { return headers.indexOf(ur_norm_(h)) + 1; };
      var mCol = colOf(matchHeader);
      if (!mCol) continue;
      sawHeader = true;
      if (lastRow < 2) continue;
      var vals = sh.getRange(2, mCol, lastRow - 1, 1).getDisplayValues(), row = 0;
      for (var i = 0; i < vals.length; i++) { if (ur_key_(matchHeader, vals[i][0]) === key) { row = i + 2; break; } }
      if (!row) continue;
      var created = [], width = lastCol;
      Object.keys(updates).forEach(function (h) {
        var c = colOf(h);
        if (!c) {
          // Fallback cột «Trạng thái xe chưa kiểm» → AV (cột 48)
          if (ur_norm_(h) === ur_norm_('Trạng thái xe chưa kiểm')) {
            c = ur_avFallbackCol_(sh, headers);
            if (c && c > width) width = c;
          }
          if (!c) {
            width++;
            if (width > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
            sh.getRange(1, width).setValue(h);
            headers[width - 1] = ur_norm_(h); c = width; created.push(h);
          }
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

/** appendRow: thêm 1 dòng mới cuối Sheet. data.row = { 'Tiêu đề cột': giá trị, … } */
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

/** saveSettings: lưu mẫu Bản cam kết vào tab «Settings»!A1 */
function saveSettingsAction_(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(UR_SETTINGS_SHEET) || ss.insertSheet(UR_SETTINGS_SHEET);
  sh.getRange('A1').setValue(JSON.stringify(data.template || {}));
  return { ok: true };
}

/* ------------------------------ ĐIỂM VÀO ------------------------------ */
var UR_LEGACY_NAMES = ['doPostOld1_', 'doPostOld2_', 'doPostOld3_', 'doPostLegacy_', 'doPostGoc_', 'doPostCu_'];

function ur_dispatch_(data) {
  var action = String((data && data.action) || '');
  switch (action) {
    case 'updateRow':    return updateRowAction_(data);
    case 'appendRow':    return appendRowAction_(data);
    case 'saveSettings': return saveSettingsAction_(data);
    case 'write': {
      var sh = SpreadsheetApp.getActive().getSheetByName(data.sheet || 'Sheet1');
      if (!sh) return { ok: false, error: 'Sheet not found: ' + data.sheet };
      sh.getRange(data.row, data.col).setValue(data.value);
      return { ok: true };
    }
    case 'urPing':       return { ok: true, urVersion: UR_VERSION, scanDispatch: typeof scanDispatch_ === 'function', actions: ['updateRow', 'appendRow', 'saveSettings', 'write'] };
  }
  return null;
}

function ur_handleGet_(params) {
  var data;
  try { data = JSON.parse((params && params.data) || '{}'); }
  catch (err) { return { ok: false, error: 'Tham số data không phải JSON hợp lệ.' }; }
  data.action = String((params && params.action) || data.action || '');
  return ur_dispatch_(data) || { ok: false, error: 'Unknown GET action: ' + data.action };
}

function doPost(e) {
  var data;
  try { data = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return ur_json_({ ok: false, error: 'Body không phải JSON hợp lệ.' }); }
  var action = String((data && data.action) || '');
  try {
    var mine = ur_dispatch_(data);
    if (mine) return ur_json_(mine);
    if (typeof scanDispatch_ === 'function') {
      var out = scanDispatch_(data);
      if (out) {
        if (action === 'scanPing' && !out.getContent) { out.urVersion = UR_VERSION; out.updateRow = true; }
        return ur_wrap_(out);
      }
    }
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
 * urSelfTest(): chạy trong Apps Script (▶ Chạy) → xem «Nhật ký thực thi». Không ghi dữ liệu.
 * Kiểm tra: doPost chạy đúng, cột «Người kiểm phiếu» = AQ, cột «Trạng thái xe chưa kiểm» = AV. */
function urSelfTest() {
  var out = [];
  var say = function (ok, m) { out.push((ok ? '✔ ' : '✘ ') + m); };
  say(String(doPost).indexOf('UR_VERSION') >= 0, 'doPost đang chạy ' + (String(doPost).indexOf('UR_VERSION') >= 0 ? 'là của file này' : 'KHÔNG phải của file này — còn doPost khác trong dự án (xóa hoặc đổi tên)'));
  try {
    var j = JSON.parse(doPost({ postData: { contents: JSON.stringify({ action: 'urPing' }) } }).getContent());
    say(j.ok && j.urVersion === UR_VERSION, 'doPost chạy bản ' + j.urVersion);
    var p = JSON.parse(doPost({ postData: { contents: JSON.stringify({ action: 'scanPing' }) } }).getContent());
    say(p.ok !== false && p.actions && p.actions.indexOf('scanOrphanUpsert') >= 0, 'scanPing: OK');
  } catch (e) { say(false, 'doPost lỗi: ' + e.message); }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ur_candidates_(ss, '')[0];
    say(!!sh, 'Tab dữ liệu: ' + (sh ? sh.getName() : 'KHÔNG TÌM THẤY'));
    if (sh) {
      var hd = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(ur_norm_), c = hd.indexOf(ur_norm_('Người kiểm phiếu')) + 1;
      var letter = function (n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
      say(c === 43, 'Cột «Người kiểm phiếu»: ' + (c ? letter(c) + (c === 43 ? ' (đúng AQ)' : ' (khác AQ)') : 'CHƯA CÓ (web sẽ tự tạo)'));
      var avc = hd.indexOf(ur_norm_('Trạng thái xe chưa kiểm')) + 1;
      say(avc === 48 || avc === 0, 'Cột «Trạng thái xe chưa kiểm»: ' + (avc ? letter(avc) + (avc === 48 ? ' (đúng AV)' : ' (khác AV!)') : 'CHƯA CÓ (sẽ tự dùng AV hoặc tạo mới)'));
    }
  } catch (e) { say(false, 'Kiểm tra Sheet lỗi: ' + e.message); }
  Logger.log(out.join('\n')); return out.join('\n');
}
