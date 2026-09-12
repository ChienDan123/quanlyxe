/**
 * ============================================================================
 *  AppsScript.gs — Backend đồng bộ 2 chiều cho "Quản lý Phương tiện & Bản cam kết"
 * ============================================================================
 *  CÁCH DÙNG:
 *  1. Mở Google Sheet chứa dữ liệu xe.
 *  2. Menu: Tiện ích mở rộng (Extensions) → Apps Script.
 *  3. Xoá hết code mẫu (myFunction...) và dán TOÀN BỘ nội dung file này vào.
 *  4. Sửa hằng số SHEET_NAME bên dưới cho đúng tên tab (sheet) chứa dữ liệu.
 *  5. Bấm "Triển khai" (Deploy) → "Triển khai mới" (New deployment).
 *     - Loại (Select type): Ứng dụng web (Web app)
 *     - Thực thi với quyền của (Execute as): Tôi (Me)
 *     - Người có quyền truy cập (Who has access): Bất kỳ ai (Anyone)
 *  6. Bấm Deploy, cấp quyền (Authorize) khi được hỏi.
 *  7. Copy URL dạng: https://script.google.com/macros/s/XXXXXXXXXXXX/exec
 *  8. Dán URL đó vào ô "Apps Script Web App URL" trong ứng dụng web.
 *
 *  LƯU Ý:
 *  - Mỗi khi bạn sửa code này, phải "Quản lý phiên bản triển khai" (Manage
 *    deployments) → Edit → chọn "New version" rồi Deploy lại để URL cập nhật
 *    logic mới (URL /exec giữ nguyên).
 *  - Dòng đầu tiên (Row 1) của sheet PHẢI là tiêu đề cột đúng như trong ứng
 *    dụng, ví dụ: STT | Mã ID | MOTO_ID | Số khung | Số máy | Biển số | ...
 * ============================================================================
 */

const SHEET_NAME = 'Data';          // Đổi tên tab chứa dữ liệu xe cho đúng
const SETTINGS_SHEET_NAME = 'Settings'; // Tab lưu mẫu Bản cam kết (tự tạo nếu chưa có)

/* --------------------------- ĐIỂM VÀO (ENTRY POINTS) --------------------------- */

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'read';
    if (action === 'read') return readData_();
    if (action === 'settings') return readSettings_();
    return jsonResponse_({ ok: false, error: 'Unknown GET action: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    if (action === 'updateRow') return updateRow_(body);
    if (action === 'saveSettings') return saveSettings_(body);
    if (action === 'appendRow') return appendRow_(body);
    return jsonResponse_({ ok: false, error: 'Unknown POST action: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

/* --------------------------------- ĐỌC DỮ LIỆU --------------------------------- */

function readData_() {
  const sh = getDataSheet_();
  const values = sh.getDataRange().getValues();
  if (!values.length) return jsonResponse_({ ok: true, headers: [], rows: [] });
  const headers = values.shift();
  return jsonResponse_({ ok: true, headers: headers, rows: values });
}

/* --------------------------------- GHI DỮ LIỆU --------------------------------- */

/**
 * body: {
 *   matchHeader: 'Mã ID',      // tên cột dùng để tìm đúng dòng
 *   matchValue: 'ABC123',      // giá trị cần khớp trong cột đó
 *   updates: { 'Trạng thái xe': 'Còn sử dụng', 'Ghi Chú': '...' }
 * }
 * Nếu cột trong "updates" chưa tồn tại trên Sheet, hàm sẽ TỰ ĐỘNG thêm cột mới
 * (ví dụ cột "Ngày xuất cam kết" dùng để đánh dấu đã xuất Bản cam kết).
 */
function updateRow_(body) {
  const sh = getDataSheet_();
  const range = sh.getDataRange();
  const values = range.getValues();
  const headers = values[0];

  const matchIdx = headers.indexOf(body.matchHeader);
  if (matchIdx === -1) {
    return jsonResponse_({ ok: false, error: 'Không tìm thấy cột khớp trên Sheet: ' + body.matchHeader });
  }

  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][matchIdx]).trim() === String(body.matchValue).trim()) { rowIndex = i; break; }
  }
  if (rowIndex === -1) {
    return jsonResponse_({ ok: false, error: 'Không tìm thấy dòng khớp giá trị: ' + body.matchValue });
  }

  const updates = body.updates || {};
  Object.keys(updates).forEach(function (colName) {
    let colIdx = headers.indexOf(colName);
    if (colIdx === -1) {
      // Cột chưa có trên Sheet -> tự thêm cột mới ở cuối.
      colIdx = headers.length;
      sh.getRange(1, colIdx + 1).setValue(colName);
      headers.push(colName);
    }
    sh.getRange(rowIndex + 1, colIdx + 1).setValue(updates[colName]);
  });

  return jsonResponse_({ ok: true, rowIndex: rowIndex + 1 });
}

/** Thêm 1 dòng mới vào cuối Sheet. body: { row: { 'Biển số': '...', ... } } */
function appendRow_(body) {
  const sh = getDataSheet_();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rowData = body.row || {};
  const newRow = headers.map(function (h) { return rowData[h] != null ? rowData[h] : ''; });
  sh.appendRow(newRow);
  return jsonResponse_({ ok: true });
}

/* --------------------------------- CÀI ĐẶT MẪU --------------------------------- */

function readSettings_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sh) return jsonResponse_({ ok: true, template: null });
  const val = sh.getRange('A1').getValue();
  return jsonResponse_({ ok: true, template: val || null });
}

function saveSettings_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SETTINGS_SHEET_NAME);
  sh.getRange('A1').setValue(JSON.stringify(body.template || {}));
  return jsonResponse_({ ok: true });
}

/* ------------------------------------ TIỆN ÍCH ---------------------------------- */

function getDataSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Không tìm thấy tab tên "' + SHEET_NAME + '". Kiểm tra lại hằng số SHEET_NAME.');
  return sh;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
