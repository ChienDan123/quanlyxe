/* =========================================================================
   AppsScript_DoPost.gs — BỘ ĐỊNH TUYẾN POST DUY NHẤT (bản 2, tự đủ)
   Thay TOÀN BỘ nội dung file AppsScript_DoPost.gs cũ bằng file này.

   Lỗi cũ: «Unknown POST action: updateRow — không tìm thấy bộ xử lý POST cũ». Router bản cũ chuyển các action thường (updateRow…) cho hàm doPost
   gốc đã bị đổi tên, nhưng không tìm thấy tên đó nữa -> mọi cập nhật Chủ xe / CCCD / Phiếu scan / Kiểm phiếu / Kết quả đối chiếu đều báo lỗi.

   Bản này xử lý theo THỨ TỰ:
     1) action bắt đầu bằng «scan»  -> scanDispatch_(data) (file AppsScript_ScanPatch.gs).
     2) routerPing                  -> báo bản router + tên bộ xử lý cũ tìm được (để kiểm tra từ web).
     3) Có hàm doPost gốc đã đổi tên (doPostLegacy_ …) -> giao cho nó (giữ nguyên hành vi cũ cho mọi action thường).
     4) KHÔNG thấy bộ xử lý cũ      -> updateRow được TỰ XỬ LÝ NGAY trong file này (khớp dòng theo Mã ID / MOTO_ID / Biển số, tự tạo cột còn thiếu),
        nên đồng bộ không còn phụ thuộc vào hàm cũ.
     5) action khác                 -> báo lỗi rõ ràng.

   YÊU CẦU: trong cả dự án chỉ được có 1 hàm tên doPost (là hàm trong file này). Nếu AppsScript.gs còn «function doPost(e)» hãy đổi tên
   thành «function doPostLegacy_(e)» (router sẽ tự tìm thấy). Không cần sửa gì khác.
   Sau khi dán: Lưu → Triển khai → Quản lý triển khai → ✏️ → Phiên bản: «Phiên bản mới» → Triển khai (giữ nguyên URL /exec).
   ========================================================================= */
var DP_ROUTER_VERSION = 2;

// Tên có thể có của hàm doPost gốc sau khi bị đổi tên (thử lần lượt)
var DP_LEGACY_NAMES = ['doPostLegacy_', 'doPostLegacy', 'doPostOld_', 'doPostOld', 'doPost_old', 'doPost_legacy', 'doPost_', 'legacyDoPost_', 'legacyDoPost',
  'oldDoPost_', 'oldDoPost', 'doPostOriginal_', 'doPostOriginal', 'doPostMain_', 'doPostMain', 'handlePost_', 'handlePost', 'handlePostLegacy_'];

function doPost(e) {
  var data;
  try { data = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return DP_json_({ ok: false, error: 'Dữ liệu POST không phải JSON: ' + err }); }
  var action = String((data && data.action) || '');
  try {
    // 1) Nhóm scan* (lưu ảnh phiếu, phiếu lạ, scanPing…) do file AppsScript_ScanPatch.gs đảm nhiệm
    if (/^scan/i.test(action) && typeof scanDispatch_ === 'function') {
      var r = scanDispatch_(data);
      return DP_wrap_(action === 'scanPing' ? DP_decoratePing_(r) : r);
    }
    // 2) Chẩn đoán router
    var legacy = DP_findLegacy_();
    if (action === 'routerPing') {
      return DP_json_({ ok: true, router: DP_ROUTER_VERSION, legacy: legacy ? legacy.name : '', scanDispatch: typeof scanDispatch_ === 'function', builtin: ['updateRow'] });
    }
    // 3) Bộ xử lý POST gốc (đã đổi tên) -> giữ nguyên hành vi cũ
    if (legacy) return DP_wrap_(legacy.fn(e));
    // 4) Không có bộ xử lý cũ: tự xử lý updateRow
    if (action === 'updateRow') return DP_json_(DP_updateRow_(data));
    return DP_json_({ ok: false, error: 'Unknown POST action: ' + action + ' — không tìm thấy bộ xử lý POST cũ (đổi tên doPost gốc thành doPostLegacy_ nếu action này do nó xử lý).' });
  } catch (err) {
    return DP_json_({ ok: false, error: 'Lỗi Apps Script: ' + (err && err.message ? err.message : err) });
  }
}

/* ---------------- tiện ích trả JSON / tìm bộ xử lý cũ ---------------- */
function DP_json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
// Hàm khác có thể trả object thường hoặc TextOutput: chuẩn hóa về TextOutput
function DP_wrap_(r) {
  if (r && typeof r.getContent === 'function') return r;
  return DP_json_(r == null ? { ok: true } : r);
}
function DP_findLegacy_() {
  var g = (typeof globalThis !== 'undefined') ? globalThis : this;
  for (var i = 0; i < DP_LEGACY_NAMES.length; i++) {
    var f = g[DP_LEGACY_NAMES[i]];
    if (typeof f === 'function') return { name: DP_LEGACY_NAMES[i], fn: f };
  }
  return null;
}
// scanPing: thêm thông tin router để web biết «bản triển khai này đã chạy code mới chưa»
function DP_decoratePing_(r) {
  try {
    var o = (r && typeof r.getContent === 'function') ? JSON.parse(r.getContent()) : (r || {});
    var l = DP_findLegacy_();
    o.router = DP_ROUTER_VERSION; o.legacy = l ? l.name : ''; o.updateRow = true;
    if (o.actions && o.actions.indexOf('updateRow') < 0) o.actions.push('updateRow');
    return o;
  } catch (e) { return r; }
}

/* ---------------- updateRow TỰ XỬ LÝ (dùng khi không có bộ xử lý cũ) ----------------
   Payload từ web: { action:'updateRow', matchHeader:'Biển số'|'Mã ID'|'MOTO_ID', matchValue:'…', updates:{ 'Tiêu đề cột': 'giá trị', … }, sheetName? }
   - Tab dữ liệu: data.sheetName → hằng SHEET_NAME / TAB_NAME (nếu dự án có khai báo) → tự dò: tab đầu tiên có cột matchHeader VÀ có dòng khớp.
   - Cột chưa có trên Sheet được TỰ TẠO ở cuối hàng tiêu đề (vd. «Người kiểm phiếu» AQ, «Kiểm phiếu»…).
   - Dùng khóa script để 2 yêu cầu cùng lúc không ghi đè lẫn nhau. Ghi lại cùng giá trị nhiều lần vẫn an toàn (thử lại không gây trùng). */
function DP_updateRow_(data) {
  var mh = String(data.matchHeader || '').trim(), mv = data.matchValue, ups = data.updates || {};
  if (!mh || mv == null || String(mv).trim() === '') return { ok: false, error: 'Thiếu matchHeader / matchValue.' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { ok: false, error: 'Lock timeout: Sheet đang bận, thử lại sau.' }; }
  try {
    var sheets = DP_candidateSheets_(data.sheetName);
    if (!sheets.length) return { ok: false, error: 'Không tìm thấy sheet (tab) dữ liệu. Gửi sheetName hoặc khai báo hằng SHEET_NAME trong Apps Script.' };
    var sawHeader = false;
    for (var s = 0; s < sheets.length; s++) {
      var sh = sheets[s], lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
      if (lastCol < 1 || lastRow < 1) continue;
      var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h); });
      var col = DP_colIndex_(headers, mh);
      if (col < 0) continue;
      sawHeader = true;
      if (lastRow < 2) continue;
      var vals = sh.getRange(2, col + 1, lastRow - 1, 1).getDisplayValues(), key = DP_keyNorm_(mh, mv), rowNo = -1;
      for (var i = 0; i < vals.length; i++) { if (DP_keyNorm_(mh, vals[i][0]) === key) { rowNo = i + 2; break; } }
      if (rowNo < 0) continue;
      var created = [], n = 0;
      Object.keys(ups).forEach(function (h) {
        var c = DP_colIndex_(headers, h);
        if (c < 0) {                                          // cột chưa có -> tạo ở cuối hàng tiêu đề
          headers.push(h); c = headers.length - 1;
          if (c + 1 > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), c + 1 - sh.getMaxColumns());
          sh.getRange(1, c + 1).setValue(h); created.push(h);
        }
        DP_setCell_(sh.getRange(rowNo, c + 1), ups[h]); n++;
      });
      SpreadsheetApp.flush();
      return { ok: true, row: rowNo, updated: n, createdColumns: created, sheet: sh.getName(), via: 'router-builtin' };
    }
    return { ok: false, error: sawHeader ? ('Không tìm thấy dòng có ' + mh + ' = ' + mv + ' trên Sheet.') : ('Không tìm thấy cột «' + mh + '» trên Sheet.') };
  } finally { lock.releaseLock(); }
}

// Ghi 1 ô: chuỗi dễ bị Sheets đổi kiểu (CCCD/SĐT số 0 đầu, dãy số dài, bắt đầu bằng = + - @) được ghi dạng VĂN BẢN để giữ nguyên
function DP_setCell_(range, v) {
  if (v == null) v = '';
  if (typeof v === 'string' && (/^0\d+$/.test(v) || /^\d{9,}$/.test(v) || /^[=+\-@]/.test(v))) range.setNumberFormat('@');
  range.setValue(v);
}
// Danh sách tab cần thử: chỉ định rõ (tham số / hằng) thì chỉ tab đó; không thì mọi tab theo thứ tự
function DP_candidateSheets_(name) {
  var ss = DP_spreadsheet_(); if (!ss) return [];
  var want = String(name || DP_cfgSheetName_() || '').trim();
  if (want) { var one = ss.getSheetByName(want); return one ? [one] : []; }
  return ss.getSheets();
}
// Các hằng thường gặp trong dự án (nếu có); typeof không ném lỗi khi hằng chưa khai báo
function DP_cfgSheetName_() {
  try { if (typeof SHEET_NAME !== 'undefined' && SHEET_NAME) return SHEET_NAME; } catch (e) { /* bỏ qua */ }
  try { if (typeof TAB_NAME !== 'undefined' && TAB_NAME) return TAB_NAME; } catch (e) { /* bỏ qua */ }
  return '';
}
function DP_spreadsheet_() {
  var id = '';
  try { if (typeof SPREADSHEET_ID !== 'undefined' && SPREADSHEET_ID) id = SPREADSHEET_ID; } catch (e) { /* bỏ qua */ }
  if (!id) { try { if (typeof SHEET_ID !== 'undefined' && SHEET_ID) id = SHEET_ID; } catch (e) { /* bỏ qua */ } }
  if (!id) { try { if (typeof SS_ID !== 'undefined' && SS_ID) id = SS_ID; } catch (e) { /* bỏ qua */ } }
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
// So tiêu đề cột không phân biệt hoa/thường, dấu tiếng Việt và ký tự lạ
function DP_norm_(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function DP_colIndex_(headers, name) {
  var n = DP_norm_(name);
  for (var i = 0; i < headers.length; i++) if (DP_norm_(headers[i]) === n) return i;
  return -1;
}
// Khóa khớp dòng: biển số bỏ dấu chấm/gạch/khoảng trắng + in hoa; cột khác chỉ cắt khoảng trắng
function DP_keyNorm_(header, v) {
  var s = String(v == null ? '' : v).trim();
  return /bien\s*so/.test(DP_norm_(header).replace(/(bien)(so)/, '$1 $2')) ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : s;
}
