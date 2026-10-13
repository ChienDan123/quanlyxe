// ============================================================================
// AppsScript_UpdateRow.gs — "CỬA VÀO" DUY NHẤT cho POST của Web App
// ----------------------------------------------------------------------------
// Vì sao có file này:
//   Lỗi "Unknown POST action: updateRow — không tìm thấy bộ xử lý POST cũ" xảy ra khi dự án có NHIỀU hàm doPost
//   (Code.gs của Gemini, AppsScript.gs, AppsScript_DoPost.gs...). Apps Script chỉ chạy MỘT doPost, nên bộ xử lý
//   updateRow cũ bị che mất. File này xử lý updateRow / saveSettings / write NGAY TẠI ĐÂY (không phụ thuộc bộ xử lý cũ),
//   các action scan* (scanPing, scanPut, scanList...) được chuyển tiếp cho scanDispatch_ (nếu dự án có).
// CÁCH DÙNG: xem phần "HƯỚNG DẪN" cuối file. QUAN TRỌNG: chỉ được còn ĐÚNG 1 hàm doPost trong toàn dự án (là hàm ở file này).
// ============================================================================

const UR_VERSION = 7;

function ur_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
// Chuẩn hóa để so tên cột: bỏ dấu, hoa/thường, khoảng trắng thừa
function ur_norm_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Tìm tab dữ liệu: ưu tiên tên web gửi lên → GeminiConfig!B1 → hằng SHEET_NAME (nếu dự án có) → tab đang mở
function ur_sheet_(ss, wanted) {
  const tryName = function (n) { n = String(n || '').trim(); return n ? ss.getSheetByName(n) : null; };
  let sh = tryName(wanted);
  if (!sh) { const cfg = ss.getSheetByName('GeminiConfig'); if (cfg) sh = tryName(cfg.getRange(1, 2).getValue()); }
  if (!sh && typeof SHEET_NAME !== 'undefined') sh = tryName(SHEET_NAME);
  return sh || ss.getActiveSheet();
}

/** updateRow: tìm dòng có cột matchHeader == matchValue rồi ghi các cột trong updates (cột chưa có → tự tạo ở cuối). */
function updateRowAction_(data) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'Máy chủ đang bận (lock timeout), sẽ tự thử lại.' };
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ur_sheet_(ss, data.sheetName);
    if (!sh) return { ok: false, error: 'Không tìm thấy tab dữ liệu (sheet not found).' };
    const updates = data.updates || {};
    const matchHeader = String(data.matchHeader || '').trim(), matchValue = String(data.matchValue == null ? '' : data.matchValue).trim();
    if (!matchHeader || !matchValue) return { ok: false, error: 'Thiếu matchHeader / matchValue.' };

    const lastCol = Math.max(sh.getLastColumn(), 1), lastRow = sh.getLastRow();
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return ur_norm_(h); });
    const colOf = function (h) { return headers.indexOf(ur_norm_(h)) + 1; };   // 0 nếu chưa có
    const mCol = colOf(matchHeader);
    if (!mCol) return { ok: false, error: 'Không tìm thấy cột khớp "' + matchHeader + '" trên Sheet (column not found).' };
    if (lastRow < 2) return { ok: false, error: 'Sheet chưa có dữ liệu (row not found).' };

    // Tìm dòng khớp (so chuỗi đã trim, không phân biệt hoa/thường)
    const vals = sh.getRange(2, mCol, lastRow - 1, 1).getValues();
    const want = matchValue.toLowerCase();
    let row = 0;
    for (let i = 0; i < vals.length; i++) { if (String(vals[i][0]).trim().toLowerCase() === want) { row = i + 2; break; } }
    if (!row) return { ok: false, error: 'Không tìm thấy dòng có ' + matchHeader + ' = ' + matchValue + ' (row not found).' };

    // Ghi từng cột; cột chưa có thì tạo ở cuối hàng tiêu đề
    const created = [];
    let width = lastCol;
    Object.keys(updates).forEach(function (h) {
      let c = colOf(h);
      if (!c) {
        width++;
        if (width > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
        sh.getRange(1, width).setValue(h);
        headers[width - 1] = ur_norm_(h); c = width; created.push(h);
      }
      const v = updates[h] == null ? '' : String(updates[h]);
      sh.getRange(row, c).setNumberFormat('@').setValue(v.slice(0, 49000));   // '@' giữ số 0 đầu của CCCD / SĐT
    });
    return { ok: true, row: row, created: created };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally { lock.releaseLock(); }
}

/** saveSettings: lưu mẫu Bản cam kết vào thuộc tính tài liệu (web đọc lại bằng GET ?action=settings) */
function saveSettingsAction_(data) {
  PropertiesService.getDocumentProperties().setProperty('commitmentTemplate', JSON.stringify(data.template || {}));
  return { ok: true };
}

/** CỬA VÀO DUY NHẤT của POST. Xóa/đổi tên mọi hàm doPost khác trong dự án. */
function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return ur_json_({ ok: false, error: 'Body không phải JSON hợp lệ.' }); }
  try {
    switch (data.action) {
      case 'updateRow': return ur_json_(updateRowAction_(data));
      case 'saveSettings': return ur_json_(saveSettingsAction_(data));
      case 'write': {   // tương thích Code.gs cũ (ghi 1 ô)
        const sh = SpreadsheetApp.getActive().getSheetByName(data.sheet || 'Sheet1');
        if (!sh) return ur_json_({ ok: false, error: 'Sheet not found: ' + data.sheet });
        sh.getRange(data.row, data.col).setValue(data.value);
        return ur_json_({ ok: true });
      }
      case 'urPing': return ur_json_({ ok: true, urVersion: UR_VERSION });
    }
    // Các action còn lại (scanPing, scanPut, scanList, scanMetaBatch, scanGet(Batch), scanInventory, scanOrphan*...) → bộ xử lý scan
    if (typeof scanDispatch_ === 'function') {
      const out = scanDispatch_(e);
      if (out) return out;
    }
    return ur_json_({ ok: false, error: 'Unknown POST action: ' + data.action });
  } catch (err) {
    return ur_json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ============================== HƯỚNG DẪN ==============================
 * 1) Apps Script → thêm file này (AppsScript_UpdateRow.gs).
 * 2) TÌM mọi "function doPost(" trong dự án (Code.gs, AppsScript.gs, AppsScript_DoPost.gs...) và ĐỔI TÊN thành
 *    doPostOld1_, doPostOld2_... (đừng xóa hàm scanDispatch_ và các hàm scan*). Chỉ doPost của file này được tồn tại.
 *    Tương tự: chỉ được 1 "function doGet(" — hàm doGet có action=read/settings của AppsScript.gs phải còn, doGet trong Code.gs đổi tên.
 * 3) Triển khai → Quản lý bản triển khai → ✏️ → Phiên bản: «Phiên bản mới» → Triển khai (GIỮ NGUYÊN URL /exec).
 * 4) Kiểm tra: POST {"action":"urPing"} phải ra {"ok":true,"urVersion":7}.
 * ======================================================================= */
