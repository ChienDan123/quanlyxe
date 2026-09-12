/**
 * ============================================================================
 *  Code.gs — "Quản lý Phương tiện & Bản cam kết"
 *  Chạy 100% bên trong Google Apps Script (HTML Service).
 *  KHÔNG cần host riêng, KHÔNG cần dán URL/API Key — chỉ cần Deploy 1 lần.
 * ============================================================================
 *
 *  CÁCH DÙNG NHANH (xem chi tiết trong HUONG_DAN_DEPLOY.md đi kèm):
 *  1. Mở Google Sheet chứa dữ liệu xe.
 *  2. Menu: Tiện ích mở rộng (Extensions) → Apps Script.
 *  3. Tạo các file: Code.gs, Index.html, Style.html, JavaScript.html — dán
 *     đúng nội dung tương ứng từ gói này vào (xoá code mẫu trước khi dán).
 *  4. Sửa hằng số SHEET_NAME bên dưới cho đúng tên tab chứa dữ liệu.
 *  5. Bấm "Triển khai" (Deploy) → "Triển khai mới" (New deployment).
 *     - Loại (Select type): Ứng dụng web (Web app)
 *     - Thực thi với quyền của (Execute as): Tôi (Me)
 *     - Người có quyền truy cập (Who has access): Bất kỳ ai (Anyone)
 *       (hoặc "Bất kỳ ai có Tài khoản Google" nếu muốn giới hạn hơn)
 *  6. Bấm Deploy, cấp quyền (Authorize) khi được hỏi.
 *  7. Copy URL dạng: https://script.google.com/macros/s/XXXXXXXXXXXX/exec
 *     — đây chính là địa chỉ ứng dụng web, mở được trên MÁY TÍNH KHÁC và
 *     ĐIỆN THOẠI, không cần cài gì thêm.
 *
 *  LƯU Ý:
 *  - Mỗi khi sửa code (Code.gs / Index.html / Style.html / JavaScript.html),
 *    phải vào "Quản lý phiên bản triển khai" (Manage deployments) → biểu
 *    tượng bút chì (Edit) → Version: "New version" → Deploy thì thay đổi
 *    mới có hiệu lực. URL /exec giữ nguyên, không cần chia sẻ lại link.
 *  - Dòng đầu tiên (Row 1) của sheet dữ liệu PHẢI là tiêu đề cột, ví dụ:
 *    STT | Mã ID | MOTO_ID | Số khung | Số máy | Biển số | Màu biển |
 *    Nhãn hiệu | Loại xe | Chủ phương tiện | Số CCCD/MST | Địa chỉ đăng ký |
 *    Phường/Xã mới (2026) | Ngày đăng ký | Trạng thái ĐK | Trạng thái xe |
 *    Ngày ĐK đầu | Mã điểm ĐK | Tên điểm ĐK | Đơn vị quản lý |
 *    Số điện thoại | Ghi Chú
 * ============================================================================
 */

// Để trống nếu file Code.gs này được tạo bằng cách mở TRỰC TIẾP từ Google
// Sheet dữ liệu (Tiện ích mở rộng → Apps Script) — đây là cách khuyên dùng.
// Chỉ điền ID Sheet vào đây nếu bạn tạo project Apps Script kiểu "độc lập"
// (standalone, không gắn với Sheet nào) rồi muốn trỏ nó tới một Sheet khác.
const SHEET_ID = '';

const SHEET_NAME = 'Data';              // Tên tab (sheet) chứa dữ liệu xe
const SETTINGS_SHEET_NAME = 'Settings'; // Tab lưu mẫu Bản cam kết (tự tạo nếu chưa có)
const EXPORT_FLAG_HEADER = 'Ngày xuất cam kết';

/* --------------------------- ĐIỂM VÀO (ENTRY POINTS) --------------------------- */

/**
 * doGet phục vụ 2 việc:
 *  - Không có tham số "action": trả về TOÀN BỘ giao diện web app (mặc định).
 *  - Có tham số "action" (?action=read / ?action=settings): trả JSON thuần,
 *    để tương thích ngược với bản index.html/app.js độc lập (nếu ai đó vẫn
 *    muốn host tách riêng và gọi Apps Script này làm API — không bắt buộc).
 */
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action) {
    try {
      if (action === 'read') return jsonResponse_(serverGetData());
      if (action === 'settings') return jsonResponse_(serverGetSettings());
      return jsonResponse_({ ok: false, error: 'Unknown GET action: ' + action });
    } catch (err) {
      return jsonResponse_({ ok: false, error: String(err) });
    }
  }

  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Quản lý Phương tiện & Bản cam kết')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Giữ lại doPost dạng JSON API (tuỳ chọn, để tương thích ngược). */
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    if (action === 'updateRow') return jsonResponse_(updateRow_(body));
    if (action === 'saveSettings') return jsonResponse_(serverSaveSettings(body.template));
    if (action === 'appendRow') return jsonResponse_(appendRow_(body));
    return jsonResponse_({ ok: false, error: 'Unknown POST action: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

/** Cho phép Index.html nhúng Style.html / JavaScript.html bằng <?!= include('Xyz'); ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ------------------- HÀM SERVER GỌI TỪ CLIENT (google.script.run) ------------------- */
/* Đây là "API nội bộ" của web app — client (JavaScript.html) gọi thẳng các
   hàm này, không qua fetch/URL nào cả, nên không lo CORS hay lộ API Key. */

function serverGetData() {
  try {
    const sh = getDataSheet_();
    const values = sh.getDataRange().getValues();
    if (!values.length) return { ok: true, headers: [], rows: [] };
    const headers = values.shift();
    return { ok: true, headers: headers, rows: values };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function serverGetSettings() {
  try {
    const sh = getSpreadsheet_().getSheetByName(SETTINGS_SHEET_NAME);
    if (!sh) return { ok: true, template: null };
    const val = sh.getRange('A1').getValue();
    return { ok: true, template: val || null };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function serverSaveSettings(template) {
  try {
    const ss = getSpreadsheet_();
    let sh = ss.getSheetByName(SETTINGS_SHEET_NAME);
    if (!sh) sh = ss.insertSheet(SETTINGS_SHEET_NAME);
    sh.getRange('A1').setValue(JSON.stringify(template || {}));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Ghi 1 hoặc nhiều trường của 1 dòng ngược về Sheet.
 * matchHeader/matchValue dùng để tìm đúng dòng (VD: cột "Mã ID" = "ABC123").
 * updates: object { 'Trạng thái xe': 'Còn sử dụng', 'Ghi Chú': '...' }.
 * Nếu cột trong "updates" chưa tồn tại trên Sheet, hàm sẽ TỰ ĐỘNG thêm cột mới
 * (ví dụ cột "Ngày xuất cam kết" dùng để đánh dấu đã xuất Bản cam kết).
 */
function serverUpdateRow(matchHeader, matchValue, updates) {
  return updateRow_({ matchHeader: matchHeader, matchValue: matchValue, updates: updates });
}

/** Thêm 1 dòng mới vào cuối Sheet. row: { 'Biển số': '...', ... } */
function serverAppendRow(row) {
  return appendRow_({ row: row });
}

/* --------------------------------- LOGIC DÙNG CHUNG --------------------------------- */

function updateRow_(body) {
  try {
    const sh = getDataSheet_();
    const range = sh.getDataRange();
    const values = range.getValues();
    const headers = values[0];

    const matchIdx = headers.indexOf(body.matchHeader);
    if (matchIdx === -1) {
      return { ok: false, error: 'Không tìm thấy cột khớp trên Sheet: ' + body.matchHeader };
    }

    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][matchIdx]).trim() === String(body.matchValue).trim()) { rowIndex = i; break; }
    }
    if (rowIndex === -1) {
      return { ok: false, error: 'Không tìm thấy dòng khớp giá trị: ' + body.matchValue };
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

    return { ok: true, rowIndex: rowIndex + 1 };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function appendRow_(body) {
  try {
    const sh = getDataSheet_();
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const rowData = body.row || {};
    const newRow = headers.map(function (h) { return rowData[h] != null ? rowData[h] : ''; });
    sh.appendRow(newRow);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* ------------------------------------ TIỆN ÍCH ---------------------------------- */

function getSpreadsheet_() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getDataSheet_() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Không tìm thấy tab tên "' + SHEET_NAME + '". Kiểm tra lại hằng số SHEET_NAME trong Code.gs.');
  return sh;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
