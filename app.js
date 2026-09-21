/* =========================================================================
   QUẢN LÝ PHƯƠNG TIỆN & BẢN CAM KẾT — app.js
   - Kết nối Google Sheet 2 chiều qua Apps Script Web App (đọc + ghi),
     hoặc chế độ CSV công khai (chỉ đọc) làm phương án dự phòng.
   - Bộ lọc cascade multi-select, bảng dữ liệu có phân trang.
   - Panel chi tiết chủ xe với 4 mục đối chiếu (CCCD trùng, tên trùng,
     tên gần đúng - fuzzy, số khung/số máy gần đúng - fuzzy).
   - Tạo Bản cam kết (in/PDF + tải Word), mẫu nội dung có thể tuỳ chỉnh
     và lưu lại (localStorage + đồng bộ Sheet nếu có Apps Script).
   ========================================================================= */

/* ---------------------------- 1. CẤU HÌNH CỘT ---------------------------- */
const FIELD_MAP = [
  { key: 'stt',          header: 'STT' },
  { key: 'maId',         header: 'Mã ID' },
  { key: 'motoId',       header: 'MOTO_ID' },
  { key: 'soKhung',      header: 'Số khung' },
  { key: 'soMay',        header: 'Số máy' },
  { key: 'bienSo',       header: 'Biển số' },
  { key: 'mauBien',      header: 'Màu biển' },
  { key: 'nhanHieu',     header: 'Nhãn hiệu' },
  { key: 'loaiXe',       header: 'Loại xe' },
  { key: 'chuXe',        header: 'Chủ phương tiện' },
  { key: 'cccd',         header: 'Số CCCD/MST' },
  { key: 'diaChi',       header: 'Địa chỉ đăng ký' },
  { key: 'phuongXaMoi',  header: 'Phường/Xã mới (2026)' },
  { key: 'ngayDangKy',   header: 'Ngày đăng ký' },
  { key: 'trangThaiDK',  header: 'Trạng thái ĐK' },
  { key: 'trangThaiXe',  header: 'Trạng thái xe' },
  { key: 'ngayDkDau',    header: 'Ngày ĐK đầu' },
  { key: 'maDiemDK',     header: 'Mã điểm ĐK' },
  { key: 'tenDiemDK',    header: 'Tên điểm ĐK' },
  { key: 'donViQuanLy',  header: 'Đơn vị quản lý' },
  { key: 'soDienThoai',  header: 'Số điện thoại' },
  { key: 'ghiChu',       header: 'Ghi Chú' },
  // Yêu cầu #5: cột "Người thực hiện" — ai đang phụ trách/đã xử lý hồ sơ này.
  // Nếu cột này chưa có trên Sheet, updateRow_() trong AppsScript.gs sẽ TỰ ĐỘNG
  // tạo cột mới (giống hệt cơ chế đã có sẵn cho "Ghi Chú"), không cần sửa Apps Script.
  { key: 'nguoiThucHien', header: 'Người thực hiện' },
];
// Cột dùng để khớp dòng khi ghi ngược về Sheet, theo thứ tự ưu tiên.
const MATCH_KEY_PRIORITY = ['maId', 'motoId', 'bienSo'];
// Tên cột trên Sheet dùng để đánh dấu đã xuất bản cam kết (tự tạo nếu Sheet chưa có).
const EXPORT_FLAG_HEADER = 'Ngày xuất cam kết';
// Cột "Y" trên Sheet (đếm A=cột 0, B=cột 1... nên Y là cột thứ 25, index 24)
// chứa thông tin quan hệ gia đình, dạng: "Cùng gia đình với: <CCCD>|<CCCD>...".
// Không phụ thuộc tên tiêu đề cột: nếu không tìm thấy cột nào có tên chứa
// "gia đình", hệ thống sẽ tự lấy đúng cột theo VỊ TRÍ (cột Y) làm phương án dự phòng.
const FAMILY_COLUMN_INDEX = 24;

// Thêm bộ lọc "Người thực hiện" ở trang chủ: cho phép lọc theo từng người cụ
// thể (kết hợp được nhiều người cùng lúc, giống các bộ lọc khác), kèm tuỳ
// chọn đặc biệt "Chưa có ai thực hiện" (xem UNASSIGNED_FILTER_VALUE bên dưới).
// Bỏ trống bộ lọc (không tick ai) mặc định đã có nghĩa là "Tất cả".
const FILTER_FIELDS = ['bienSo', 'cccd', 'chuXe', 'diaChi', 'trangThaiXe', 'nguoiThucHien'];
const FILTER_LABELS = {
  bienSo: 'Biển số', cccd: 'Số CCCD/MST', chuXe: 'Chủ phương tiện',
  diaChi: 'Địa chỉ / Phường-Xã', trangThaiXe: 'Trạng thái xe',
  nguoiThucHien: 'Người thực hiện'
};
// Giá trị "giả" đại diện cho các dòng CHƯA gán Người thực hiện, dùng trong bộ
// lọc "Người thực hiện" ở trang chủ (không phải giá trị thật trong dữ liệu).
const UNASSIGNED_FILTER_VALUE = '__chua_thuc_hien__';
const UNASSIGNED_FILTER_LABEL = 'Chưa có ai thực hiện';

// Yêu cầu 2A: danh sách cột cho phép chọn làm tiêu chí sắp xếp (kết hợp nhiều
// tiêu chí cùng lúc). "type: name" -> chỉ so sánh theo TÊN (từ cuối), bỏ qua
// họ và chữ lót. "type: number" -> so sánh dạng số (VD số lượng xe cùng chủ).
const SORT_FIELDS = [
  { key: 'chuXe',       label: 'Tên (chủ phương tiện)', type: 'name' },
  { key: 'bienSo',      label: 'Biển số',               type: 'text' },
  { key: 'soKhung',     label: 'Số khung',               type: 'text' },
  { key: 'soMay',       label: 'Số máy',                 type: 'text' },
  { key: 'nhanHieu',    label: 'Nhãn hiệu',              type: 'text' },
  { key: 'loaiXe',      label: 'Loại xe',                type: 'text' },
  { key: 'diaChi',      label: 'Địa chỉ đăng ký',        type: 'text' },
  { key: 'phuongXaMoi', label: 'Phường/Xã mới',          type: 'text' },
  { key: 'trangThaiXe', label: 'Trạng thái xe',          type: 'text' },
  { key: 'ngayDangKy',  label: 'Ngày đăng ký',           type: 'text' },
  { key: 'soDienThoai', label: 'Số điện thoại',          type: 'text' },
  { key: 'nguoiThucHien', label: 'Người thực hiện',      type: 'text' },
  { key: 'soLuongXe',   label: 'Số lượng xe cùng chủ',   type: 'number' },
];

// Yêu cầu #2: danh sách Trạng thái dùng chung cho MỌI nơi cho phép sửa trạng
// thái (ô chọn trên từng dòng ở bảng chính, bảng mini trong panel chi tiết...).
// Mục "Cập nhật hàng loạt" và "Cập nhật cho riêng xe này" (đã có sẵn trong
// index.html) giữ nguyên danh sách tĩnh của chúng để không phá vỡ giao diện cũ.
const STATUS_OPTIONS = [
  'Còn sử dụng', 'Đã bán/chuyển nhượng', 'Đã liên hệ', 'Đã xác minh',
  'Đã ký cam kết', 'Chưa liên hệ được', 'Cần xác minh thêm',
];
// Trạng thái được coi là "cần liên hệ lại" cho bộ lọc ở Yêu cầu #6.
const RECONTACT_STATUS = 'Chưa liên hệ được';

const NOTES_KEY = 'vehicleNotesV1';
const LAST_URL_KEY = 'vehicleLastSheetCsvUrl';
const GAS_URL_KEY = 'vehicleGasUrl';
// URL Apps Script Web App mặc định — tự động dùng khi mở trang lần đầu / trên
// thiết bị chưa từng kết nối, KHÔNG cần bấm "Kết nối Google Sheet".
// Vẫn có thể đổi URL khác bất cứ lúc nào qua nút "Kết nối Google Sheet".
const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbyRbBYByqGMQoLGrKBK2CMZSrDvBbw2epgMjKzMNmUNAsCYZg58gb-Ia47S31R4vCoBPw/exec';
const MODE_KEY = 'vehicleConnectMode'; // 'gas' | 'csv'
const TEMPLATE_KEY = 'vehicleCommitmentTemplateV1';
// Lưu các trường hợp đã được người dùng "Xác nhận xe đúng" ở Mục III, để xe đó
// được coi là thuộc về chủ xe đang xem (chuyển hiển thị lên Mục I) mà KHÔNG
// làm thay đổi Số CCCD/MST gốc đã lưu của chính xe đó.
const CONFIRMED_OWNER_KEY = 'vehicleConfirmedOwnerV1';
// Yêu cầu #5: danh sách "Người thực hiện" — lưu cục bộ trên trình duyệt, cho
// phép thêm người mới và người mới sẽ xuất hiện lại ở các lần mở sau.
const ASSIGNEE_LIST_KEY = 'vehicleAssigneeListV1';
const DEFAULT_ASSIGNEES = ['Nhơn', 'Tiến', 'Tuấn', 'Thuận', 'Thi'];
// Giá trị đặc biệt trong <select> Người thực hiện dùng để mở hộp thoại thêm mới.
const ASSIGNEE_ADD_NEW_VALUE = '__add_new__';
// Yêu cầu (Lưu dữ liệu cục bộ + lọc): key lưu bộ lọc/sắp xếp đang chọn trên
// localStorage (nhẹ, chỉ vài trăm byte -> dùng localStorage là đủ, không cần
// IndexedDB). Dữ liệu XE (nặng, có thể hàng trăm nghìn dòng) dùng IndexedDB —
// xem FILTER_STATE_KEY và IDB_* bên dưới.
const FILTER_STATE_KEY = 'vehicleFilterStateV1';

const DEFAULT_TEMPLATE = {
  kinhGui: 'Kính gửi: Công an xã Chiên Đàn',
  diaDanh: '.......',
  mucI:
`Tôi đã bán/chuyển nhượng/cho/tặng (chuyển quyền sở hữu) các phương tiện có biển số nêu trên cho người khác.
Hiện nay tôi không xác định được thông tin (họ tên, địa chỉ, số điện thoại) của người đã mua hoặc người đang quản lý, sử dụng phương tiện nêu trên.
Tôi xin cam kết kể từ thời điểm chuyển quyền sở hữu phương tiện nêu trên, tôi không còn quyền liên quan đến việc quản lý, sử dụng phương tiện; Đề nghị cơ quan Công an cập nhật trạng thái xe trên hệ thống đăng ký, quản lý phương tiện theo quy định.`,
  mucII:
`Tôi xin xác nhận các các xe có biển số:.....................đã bị hư hỏng không còn hoạt động/bị mất.
Tôi đã được Công an xã hướng dẫn và cam kết sẽ làm thủ tục thu hồi biển số, đăng ký xe theo quy định.`,
  mucIII:
`Tôi xin xác nhận phương tiện nêu trên hiện vẫn thuộc quyền sở hữu và do tôi trực tiếp quản lý, sử dụng; chưa thực hiện việc bán, chuyển nhượng, cho, tặng phương tiện cho bất kỳ tổ chức, cá nhân nào khác.
Tôi cam kết tiếp tục quản lý, sử dụng phương tiện đúng quy định của pháp luật về giao thông đường bộ và các quy định có liên quan.
Trường hợp sau này có thay đổi về tình trạng sở hữu, sử dụng phương tiện (bán, chuyển nhượng, cho, tặng, hư hỏng không còn sử dụng, bị mất...), tôi cam kết sẽ chủ động thông báo và thực hiện đầy đủ thủ tục đăng ký sang tên hoặc thu hồi đăng ký, biển số xe theo đúng quy định của pháp luật.`,
 
   camDoan: 'Tôi cam đoan những nội dung kê khai, cam kết nêu trên là hoàn toàn đúng sự thật. Nếu có nội dung nào không đúng sự thật, tôi xin hoàn toàn chịu trách nhiệm trước pháp luật.'
};

/* ---------------------------- 2. STATE TOÀN CỤC --------------------------- */
const state = {
  rawData: [],
  filters: Object.fromEntries(FILTER_FIELDS.map(f => [f, new Set()])),
  msUI: Object.fromEntries(FILTER_FIELDS.map(f => [f, { search: '', open: false }])),
  page: 1,
  pageSize: 50,
  exportSelected: new Set(),
  lastCsvUrl: null,
  gasUrl: null,
  mode: null, // 'gas' | 'csv'
  commitmentDocs: [],
  template: loadTemplate(),
  // Yêu cầu 2A: danh sách tiêu chí sắp xếp kết hợp, thứ tự = độ ưu tiên.
  // Mỗi phần tử: { field: 'chuXe', dir: 'asc' | 'desc' }.
  sortCriteria: [],
  // Yêu cầu 2B + Yêu cầu #6: các bộ lọc bổ sung (tích chọn).
  // excludeDone / excludeRecontact MẶC ĐỊNH BẬT (true) theo đúng yêu cầu: khi
  // mở trang, tự động loại người "đã thực hiện" và người "cần liên hệ lại".
  extraFilters: { hasPhone: false, multiVehicle: false, excludeDone: true, excludeRecontact: true },
  // Yêu cầu (Lọc nhanh theo Địa bàn cũ): null = không lọc (hiện đầy đủ), hoặc
  // 1 trong các key của QUICK_DIA_BAN_OPTIONS ('tam_dan' | 'tam_thai' | 'phu_thinh').
  quickDiaBan: null,
  // Cache số lượng xe theo từng chủ xe (tính theo CCCD hiệu lực, có tính cả
  // các xe đã được "Xác nhận xe đúng"). Được tính lại mỗi khi dữ liệu thay đổi.
  ownerVehicleCounts: new Map(),
};

/* ---------------------------- 3. TIỆN ÍCH CHUNG ---------------------------- */
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function normalizeHeader(s) {
  return (s || '').toString().normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}
function normalizeName(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}
function stripDiacritics(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim().replace(/\s+/g, ' ');
}

/* ---- Lọc nhanh theo Địa bàn cũ -------------------------------------------
   Dữ liệu địa chỉ thực tế viết rất đa dạng: "Tam Đàn", "Tam đàn", "T.Đàn",
   "T Đàn", "TĐàn"... Sau khi bỏ dấu + viết thường (stripDiacritics), các biến
   thể trên đều quy về dạng gần giống nhau, nên mỗi địa bàn được nhận diện
   bằng 1 regex duy nhất: tên đầy đủ ("tam") HOẶC chữ viết tắt ("t"), theo sau
   là dấu chấm/khoảng trắng tuỳ ý, rồi đến phần tên riêng ("dan", "thai",...).
   \b (word boundary) ở đầu/cuối đảm bảo không khớp nhầm vào giữa 1 từ khác
   (VD: "phat dan" sẽ KHÔNG bị coi là khớp "t dan" vì "t" ở giữa từ "phat").
   Phú Thịnh: theo yêu cầu, "Tam Vinh" thuộc địa bàn Phú Thịnh cũ nên được
   gộp luôn vào cùng 1 lựa chọn lọc. */
const QUICK_DIA_BAN_OPTIONS = [
  { key: 'tam_dan', label: 'Tam Đàn', patterns: [/\bt(?:am)?\.?\s*dan\b/] },
  { key: 'tam_thai', label: 'Tam Thái', patterns: [/\bt(?:am)?\.?\s*thai\b/] },
  {
    key: 'phu_thinh', label: 'Phú Thịnh',
    patterns: [/\bp(?:hu)?\.?\s*thinh\b/, /\bt(?:am)?\.?\s*vinh\b/],
  },
];
// Kiểm tra 1 dòng xe có thuộc địa bàn cũ `key` hay không — so khớp trên cả
// "Địa chỉ đăng ký" (địa chỉ gốc, ghi theo địa bàn cũ) lẫn "Phường/Xã mới"
// (đề phòng trường hợp dữ liệu ghi tên địa bàn cũ vào cột này).
function rowMatchesQuickDiaBan(row, key) {
  const opt = QUICK_DIA_BAN_OPTIONS.find(o => o.key === key);
  if (!opt) return true;
  const haystack = stripDiacritics(`${row.diaChi || ''} ${row.phuongXaMoi || ''}`);
  return opt.patterns.some(re => re.test(haystack));
}

function uniq(arr) { return Array.from(new Set(arr.filter(v => v && v.trim() !== ''))); }


// TỐI ƯU HIỆU NĂNG (cập nhật hàng loạt nhiều xe): chạy các tác vụ bất đồng bộ
// (VD: ghi từng dòng về Google Sheet) với SỐ LƯỢNG ĐỒNG THỜI GIỚI HẠN thay vì
// hoàn toàn tuần tự (await từng cái một, rất chậm khi có nhiều request mạng)
// hoặc hoàn toàn song song không giới hạn (dễ làm quá tải Apps Script Web App
// vốn xử lý từng request một cách khá chậm). `limit` ~ 6 là mức cân bằng tốt.
async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runner() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner);
  await Promise.all(workers);
  return results;
}

/* ---- Yêu cầu #6: "đã thực hiện" / "cần liên hệ lại" ------------------------
   Quy ước (có thể điều chỉnh nếu nghiệp vụ thực tế khác):
   - "Đã thực hiện": hồ sơ ĐÃ được gán một "Người thực hiện" cụ thể (đã có
     người phụ trách xử lý xong/đang xử lý), dùng để ẩn bớt các hồ sơ không
     cần theo dõi lại nữa.
   - "Cần liên hệ lại": Trạng thái xe đang là "Chưa liên hệ được".            */
function isRowDone(row) {
  return !!((row.nguoiThucHien || '').trim());
}
function isRowNeedRecontact(row) {
  return normalizeName(row.trangThaiXe) === normalizeName(RECONTACT_STATUS);
}

// Khoảng cách Levenshtein — dùng cho fuzzy match tên / số khung / số máy.
function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }

// true nếu đang ở chế độ đọc + GHI 2 chiều (Apps Script) — dùng chung cho các
// tính năng ghi ngược mới (xác nhận chủ xe, cập nhật hàng loạt...).
function isWriteConnected() { return state.mode === 'gas' && !!state.gasUrl; }

// Tách chuỗi cột "gia đình" dạng "Cùng gia đình với: 123|456" thành mảng số CCCD.
function parseFamilyIds(str) {
  if (!str) return [];
  const idx = str.indexOf(':');
  const listPart = idx >= 0 ? str.slice(idx + 1) : str;
  return listPart.split('|').map(s => s.trim()).filter(Boolean);
}

document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) closeModal(closeBtn.dataset.close);
  if (e.target.classList.contains('modal-overlay')) e.target.classList.add('hidden');
});

function escapeHtml(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---- 3b. Phân biệt "click để xem chi tiết" và "kéo chuột để bôi đen/copy" -
   Trước đây, mọi click lên 1 dòng xe (bảng chính hoặc bảng mini trong panel
   chi tiết) đều mở panel Chi tiết ngay lập tức — kể cả khi người dùng chỉ
   đang RÊ CHUỘT để BÔI ĐEN copy biển số / họ tên / địa chỉ... Sự kiện `click`
   vẫn nổ ra ngay sau khi thả chuột (mouseup), nên vừa bôi đen xong là bị
   "nhảy" sang panel chi tiết, mất luôn vùng chọn.
   Giải pháp: ghi lại toạ độ chuột lúc `mousedown` (dùng chung cho toàn trang
   qua 1 listener duy nhất), rồi khi `click` xảy ra, chỉ coi là "click xem chi
   tiết" nếu (1) chuột KHÔNG di chuyển đáng kể giữa mousedown và click, VÀ
   (2) hiện KHÔNG có vùng văn bản nào đang được bôi đen (window.getSelection()
   rỗng). Nếu người dùng rê chuột để chọn chữ (hoặc double/triple-click chọn
   nhanh 1 từ/1 dòng), điều kiện trên sẽ không thoả -> không mở panel, cho
   phép Ctrl+C copy bình thường; còn 1 click đơn thuần (không kéo) vẫn mở
   panel chi tiết như cũ. */
let _rowMouseDownPos = null;
document.addEventListener('mousedown', (e) => {
  _rowMouseDownPos = { x: e.clientX, y: e.clientY };
});
const ROW_DRAG_THRESHOLD_PX = 5;
function isTextSelectOrDragClick(e) {
  const selection = window.getSelection();
  const hasTextSelection = !!(selection && selection.toString().trim().length > 0);
  const dragged = !!(_rowMouseDownPos && (
    Math.abs(e.clientX - _rowMouseDownPos.x) > ROW_DRAG_THRESHOLD_PX ||
    Math.abs(e.clientY - _rowMouseDownPos.y) > ROW_DRAG_THRESHOLD_PX
  ));
  return hasTextSelection || dragged;
}

/* ---------------------------- 4. KẾT NỐI GOOGLE SHEET ---------------------- */

/* ---- 4a. Tab UI của modal kết nối ---- */
$('#connectTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  $all('.tab-btn', $('#connectTabs')).forEach(b => b.classList.toggle('active', b === btn));
  $all('.tab-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== btn.dataset.tab));
});

$('#btnConnect').addEventListener('click', () => {
  $('#gasUrlInput').value = localStorage.getItem(GAS_URL_KEY) || DEFAULT_GAS_URL;
  $('#sheetUrlInput').value = localStorage.getItem(LAST_URL_KEY) || '';
  const preferGas = (localStorage.getItem(MODE_KEY) || 'gas') === 'gas';
  $all('.tab-btn', $('#connectTabs')).forEach(b => b.classList.toggle('active', (b.dataset.tab === 'gas') === preferGas));
  $all('.tab-pane').forEach(p => p.classList.toggle('hidden', (p.dataset.pane === 'gas') !== preferGas));
  openModal('connectModal');
});

$('#btnDoConnect').addEventListener('click', () => {
  const activeTab = $('.tab-btn.active', $('#connectTabs')).dataset.tab;
  if (activeTab === 'gas') {
    const url = $('#gasUrlInput').value.trim();
    const errEl = $('#gasError');
    errEl.classList.add('hidden');
    if (!url) { errEl.textContent = 'Vui lòng nhập URL Apps Script Web App.'; errEl.classList.remove('hidden'); return; }
    connectViaAppsScript(url);
  } else {
    const url = $('#sheetUrlInput').value.trim();
    const gid = $('#sheetGidInput').value.trim();
    const errEl = $('#connectError');
    errEl.classList.add('hidden');
    if (!url) { errEl.textContent = 'Vui lòng nhập URL.'; errEl.classList.remove('hidden'); return; }
    const csvUrl = buildCsvUrl(url, gid);
    connectViaCsv(csvUrl);
  }
});

$('#btnReload').addEventListener('click', () => {
  if (state.mode === 'gas' && state.gasUrl) { connectViaAppsScript(state.gasUrl, { silent: true }); return; }
  if (state.mode === 'csv' && state.lastCsvUrl) { connectViaCsv(state.lastCsvUrl, { silent: true }); return; }
  toast('Chưa kết nối Google Sheet nào.', true);
});

function updateModeBadge() {
  const el = $('#modeBadge');
  if (!state.mode) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (state.mode === 'gas') {
    el.textContent = '🔄 Đồng bộ 2 chiều (Apps Script)';
    el.className = 'badge badge-mode mode-gas';
  } else {
    el.textContent = '👁️ Chỉ đọc (CSV)';
    el.className = 'badge badge-mode mode-csv';
  }
}

/* ---- 4b. Chế độ CSV (chỉ đọc) ---- */
function buildCsvUrl(rawUrl, gid) {
  let url = (rawUrl || '').trim();
  if (!url) return null;

  if (/output=csv/i.test(url) || /\.csv($|\?)/i.test(url)) {
    if (gid && !/[?&]gid=/i.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'gid=' + encodeURIComponent(gid);
    }
    return url;
  }

  const pubMatch = url.match(/\/spreadsheets\/d\/e\/([^/]+)\//);
  if (pubMatch) {
    const pubId = pubMatch[1];
    let out = `https://docs.google.com/spreadsheets/d/e/${pubId}/pub?output=csv`;
    if (gid) out += '&gid=' + encodeURIComponent(gid);
    return out;
  }

  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (idMatch) {
    const sheetId = idMatch[1];
    let effectiveGid = gid;
    if (!effectiveGid) {
      const gidMatch = url.match(/[?#&]gid=([0-9]+)/);
      if (gidMatch) effectiveGid = gidMatch[1];
    }
    let out = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
    if (effectiveGid) out += '&gid=' + encodeURIComponent(effectiveGid);
    return out;
  }

  return url;
}

function connectViaCsv(csvUrl, { silent = false } = {}) {
  if (!csvUrl) return;
  const errEl = $('#connectError');
  errEl.classList.add('hidden');
  Papa.parse(csvUrl, {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      if (!results.data || !results.data.length) {
        const msg = 'Không đọc được dữ liệu (sheet trống hoặc URL không đúng / chưa công khai).';
        if (!silent) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
        toast(msg, true);
        return;
      }
      processRows(results.data);
      state.lastCsvUrl = csvUrl;
      state.mode = 'csv';
      state.gasUrl = null;
      localStorage.setItem(LAST_URL_KEY, csvUrl);
      localStorage.setItem(MODE_KEY, 'csv');
      updateModeBadge();
      closeModal('connectModal');
      toast(`Đã tải ${state.rawData.length} bản ghi từ Google Sheet (chỉ đọc).`);
    },
    error: (err) => {
      const msg = 'Lỗi tải dữ liệu: ' + (err && err.message ? err.message : 'không xác định') +
        '. Kiểm tra sheet đã "Xuất bản lên web" hoặc chia sẻ "Bất kỳ ai có link" chưa.';
      if (!silent) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
      toast('Lỗi tải dữ liệu từ Google Sheet.', true);
    }
  });
}

/* ---- 4c. Chế độ Apps Script (đọc + ghi) ---- */
async function gasRequest(url, payload) {
  // payload = null  -> GET (đọc dữ liệu)
  // payload = {...} -> POST dạng text/plain để Apps Script không cần xử lý CORS preflight.
  if (!payload) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=read', { method: 'GET' });
    return res.json();
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

async function connectViaAppsScript(url, { silent = false } = {}) {
  const errEl = $('#gasError');
  if (errEl) errEl.classList.add('hidden');
  try {
    if (!silent) toast('Đang kết nối Apps Script...');
    const data = await gasRequest(url, null);
    if (!data || data.ok === false) {
      throw new Error((data && data.error) || 'Phản hồi không hợp lệ từ Apps Script.');
    }
    const rows = rowsFromHeaderArray(data.headers, data.rows);
    if (!rows.length) {
      const msg = 'Không có dữ liệu trong Sheet, hoặc sai SHEET_NAME trong Apps Script.';
      if (!silent) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
      toast(msg, true);
      return;
    }
    processRows(rows);
    state.gasUrl = url;
    state.mode = 'gas';
    state.lastCsvUrl = null;
    localStorage.setItem(GAS_URL_KEY, url);
    localStorage.setItem(MODE_KEY, 'gas');
    updateModeBadge();
    closeModal('connectModal');
    toast(`Đã tải ${state.rawData.length} bản ghi (đồng bộ 2 chiều đang bật).`);
    // Đồng bộ mẫu Bản cam kết từ Sheet nếu có, và Sheet chưa có mẫu cục bộ mới hơn.
    trySyncTemplateFromSheet(url);
    // Yêu cầu #5: nếu phiên trước còn để lại các thay đổi CHƯA kịp đồng bộ lên
    // Sheet (đóng trình duyệt/mất mạng giữa chừng), thử gửi tiếp NGAY khi vừa
    // kết nối lại được — không phải chờ người dùng sửa thêm 1 dòng mới thì mới
    // kích hoạt hàng đợi.
    processSyncQueue();
  } catch (err) {
    console.error(err);
    const msg = 'Lỗi kết nối Apps Script: ' + err.message +
      '. Kiểm tra đã Deploy "Ứng dụng web" với quyền truy cập "Bất kỳ ai" chưa, và URL kết thúc bằng /exec.';
    if (!silent && errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    toast('Không kết nối được Apps Script.', true);
  }
}

function rowsFromHeaderArray(headers, rows) {
  if (!headers || !rows) return [];
  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] != null ? String(r[i]) : ''; });
    return obj;
  }).filter(r => Object.values(r).some(v => v && v.trim() !== ''));
}

// Xác định cột (header gốc trên Sheet) dùng để khớp dòng khi ghi ngược.
function matchKeyForRow(row) {
  for (const key of MATCH_KEY_PRIORITY) {
    const f = FIELD_MAP.find(f => f.key === key);
    if (f && row[key]) return { header: f.header, value: row[key] };
  }
  return null;
}

// Đưa 1 thay đổi của dòng `row` vào hàng đợi đồng bộ NGẦM (không await, không
// chặn UI) — dùng chung cho MỌI nơi cần ghi ngược Sheet theo mô hình local-first:
// lưu local trước, đồng bộ sau. Nếu dòng thiếu khoá khớp (Mã ID/MOTO_ID/Biển
// số), báo cho người dùng biết thay đổi này chỉ nằm ở local, không tự đồng bộ
// lên Sheet được (nhưng KHÔNG mất dữ liệu — vẫn còn trong IndexedDB).
function enqueueRowSync(row, updatesByHeader) {
  if (!isWriteConnected()) return;
  const mk = matchKeyForRow(row);
  if (!mk) {
    toast('Đã lưu cục bộ, nhưng dòng này thiếu Mã ID/MOTO_ID/Biển số nên không tự đồng bộ lên Sheet được.', true);
    return;
  }
  enqueueSync(mk.header, mk.value, updatesByHeader, row._rowId);
}

// Ghi một hoặc nhiều trường của 1 dòng ngược về Google Sheet (yêu cầu chế độ 'gas').
// LƯU Ý: hàm này gọi mạng TRỰC TIẾP (await) — chỉ còn dùng cho các thao tác cần
// biết ngay kết quả thành/bại (hiện không còn nơi nào gọi theo kiểu chặn UI
// nữa, mọi luồng cập nhật dữ liệu chính đều qua enqueueRowSync() ở trên).
async function updateRowOnSheet(row, updatesByHeader) {
  if (state.mode !== 'gas' || !state.gasUrl) {
    return { ok: false, error: 'Chưa kết nối chế độ Apps Script (2 chiều).' };
  }
  const mk = matchKeyForRow(row);
  if (!mk) return { ok: false, error: 'Dòng này thiếu Mã ID / MOTO_ID / Biển số để khớp khi ghi.' };
  try {
    const res = await gasRequest(state.gasUrl, {
      action: 'updateRow',
      matchHeader: mk.header,
      matchValue: mk.value,
      updates: updatesByHeader
    });
    return res;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* ---- 4d. LƯU CỤC BỘ (IndexedDB) + HÀNG ĐỢI ĐỒNG BỘ NGẦM ------------------
   Mục tiêu (3 yêu cầu lớn của tính năng này):
   1) Lưu toàn bộ dữ liệu xe xuống máy (IndexedDB — phù hợp dữ liệu lớn, hạn
      mức lưu trữ cao hơn nhiều so với localStorage) để mở lại trang là có
      ngay dữ liệu, không phải chờ tải lại từ server.
   2) Mọi thay đổi (trạng thái, ghi chú, người thực hiện, xác nhận xe...) được
      áp dụng NGAY vào bộ nhớ + lưu cục bộ trước, việc ghi lên Google Sheet
      được đẩy vào 1 HÀNG ĐỢI, xử lý NGẦM phía sau — không chờ, không chặn
      thao tác tiếp theo của người dùng. Hàng đợi cũng được lưu IndexedDB nên
      nếu mạng lỗi / đóng trình duyệt giữa chừng, lần mở sau sẽ tự thử lại.
   ------------------------------------------------------------------------- */
const IDB_DB_NAME = 'vehicleAppCacheV1';
const IDB_STORE_NAME = 'kv';
const IDB_KEY_RAW_DATA = 'rawData';
const IDB_KEY_SYNC_QUEUE = 'syncQueue';

let _idbPromise = null;
function openIdb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve) => {
    if (!('indexedDB' in window)) { resolve(null); return; } // trình duyệt không hỗ trợ -> bỏ qua cache, app vẫn chạy bình thường
    let req;
    try { req = indexedDB.open(IDB_DB_NAME, 1); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) db.createObjectStore(IDB_STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // lỗi mở DB (VD chế độ ẩn danh chặn) -> coi như không có cache
  });
  return _idbPromise;
}
// Lưu ý: IndexedDB lưu trực tiếp object/array (structured clone) — KHÔNG cần
// JSON.stringify/parse như localStorage, nên nhanh hơn nhiều với mảng lớn.
async function idbGet(key) {
  const db = await openIdb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const req = tx.objectStore(IDB_STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch (e) { resolve(undefined); }
  });
}
async function idbSet(key, value) {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

// Ghi toàn bộ `state.rawData` (đã bao gồm mọi chỉnh sửa cục bộ mới nhất) xuống
// IndexedDB. Chạy NỀN (không await ở nơi gọi) + DEBOUNCE nhẹ (400ms) để gộp
// nhiều thay đổi liên tiếp (VD: cập nhật hàng loạt nhiều xe) thành 1 lần ghi
// duy nhất, tránh ghi ổ đĩa lặp lại liên tục gây tốn tài nguyên với dữ liệu lớn.
let _persistRawDataTimer = null;
function persistRawDataToCache() {
  clearTimeout(_persistRawDataTimer);
  _persistRawDataTimer = setTimeout(() => {
    idbSet(IDB_KEY_RAW_DATA, state.rawData).catch(() => {});
  }, 400);
}

/* ---- Hàng đợi đồng bộ ngầm lên Google Sheet ------------------------------ */
let syncQueue = [];
let syncQueueLoaded = false;
let syncInFlight = false;
let syncRetryTimer = null;
// Yêu cầu #5 (thử lại khi lỗi/rớt mạng): dùng BACKOFF TĂNG DẦN thay vì cố định
// 15s — thử lại nhanh (5s) cho các lỗi tạm thời, giãn dần tối đa 2 phút nếu
// lỗi lặp lại nhiều lần liên tiếp (tránh spam request khi mất mạng lâu), rồi
// reset về mức nhanh nhất ngay khi có 1 lần đồng bộ thành công.
const SYNC_RETRY_BASE_MS = 5000;
const SYNC_RETRY_MAX_MS = 120000;
let syncRetryAttempt = 0;

async function ensureSyncQueueLoaded() {
  if (syncQueueLoaded) return;
  syncQueueLoaded = true;
  const saved = await idbGet(IDB_KEY_SYNC_QUEUE);
  syncQueue = Array.isArray(saved) ? saved : [];
}
function persistSyncQueue() {
  return idbSet(IDB_KEY_SYNC_QUEUE, syncQueue).catch(() => {});
}

// Thêm 1 tác vụ ghi ngược lên Sheet vào hàng đợi rồi kích hoạt xử lý NỀN ngay
// (không await — hàm gọi hàm này có thể trả về/kết thúc ngay lập tức).
//
// TỐI ƯU (Yêu cầu #4 — "chỉ đồng bộ những dòng thực sự có thay đổi"): nếu dòng
// này ĐÃ có sẵn 1 tác vụ CHƯA GỬI (chưa xử lý) trong hàng đợi, GỘP các trường
// thay đổi mới vào tác vụ đó thay vì tạo thêm 1 tác vụ mới — vừa giảm số lần
// gọi Apps Script khi người dùng sửa liên tiếp nhiều trường/nhiều lần trên
// cùng 1 xe, vừa tránh 2 request cùng ghi 1 dòng chồng chéo nhau. Tác vụ đang
// ở đầu hàng đợi và ĐANG được gửi đi (syncInFlight) thì KHÔNG gộp vào (để
// không đổi nội dung 1 request đã bay đi), mà tạo tác vụ mới nối tiếp sau nó.
function enqueueSync(matchHeader, matchValue, updatesByHeader, rowId) {
  const startIdx = syncInFlight ? 1 : 0; // bỏ qua job đầu nếu đang gửi dở
  for (let i = syncQueue.length - 1; i >= startIdx; i--) {
    const job = syncQueue[i];
    if (job.matchHeader === matchHeader && job.matchValue === matchValue) {
      Object.assign(job.updates, updatesByHeader);
      job.rowId = rowId;
      persistSyncQueue();
      updateSyncStatusBadge();
      processSyncQueue();
      return;
    }
  }
  syncQueue.push({
    id: 'sync_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    rowId, matchHeader, matchValue, updates: updatesByHeader,
    attempts: 0, createdAt: Date.now(),
  });
  persistSyncQueue();
  updateSyncStatusBadge();
  processSyncQueue(); // fire-and-forget, chạy nền
}

// Xử lý hàng đợi TUẦN TỰ (không song song) để giữ đúng thứ tự ghi khi cùng 1
// dòng bị sửa nhiều lần liên tiếp. Nếu 1 tác vụ lỗi, DỪNG lại và hẹn thử lại
// sau ít giây thay vì thử liên tục làm nghẽn — nhẹ nhàng báo qua badge trạng
// thái, không hiện popup lỗi gây khó chịu cho người dùng. KHÔNG BAO GIỜ xoá
// tác vụ lỗi khỏi hàng đợi (chỉ xoá khi ghi THÀNH CÔNG) -> không mất dữ liệu
// người dùng đã nhập dù mất mạng/lỗi bao lâu đi nữa, hễ có mạng lại là tự ghi tiếp.
async function processSyncQueue() {
  if (syncInFlight) return;
  await ensureSyncQueueLoaded();
  if (!syncQueue.length || !isWriteConnected()) { updateSyncStatusBadge(); return; }
  // navigator.onLine=false là tín hiệu chắc chắn KHÔNG có mạng -> khỏi thử,
  // để dành cho listener 'online' bên dưới kích hoạt lại ngay khi có mạng.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    scheduleSyncRetry();
    updateSyncStatusBadge();
    return;
  }
  syncInFlight = true;
  updateSyncStatusBadge();
  const hadQueueBefore = syncQueue.length > 0;
  try {
    while (syncQueue.length && isWriteConnected()) {
      const job = syncQueue[0];
      try {
        const res = await gasRequest(state.gasUrl, {
          action: 'updateRow', matchHeader: job.matchHeader, matchValue: job.matchValue, updates: job.updates,
        });
        if (!res || res.ok === false) throw new Error((res && res.error) || 'Phản hồi không hợp lệ từ Apps Script.');
        syncQueue.shift();
        await persistSyncQueue();
        syncRetryAttempt = 0; // thành công -> reset backoff về mức nhanh nhất cho lần lỗi sau (nếu có)
      } catch (err) {
        job.attempts = (job.attempts || 0) + 1;
        job.lastError = String((err && err.message) || err);
        await persistSyncQueue();
        scheduleSyncRetry();
        break; // dừng vòng lặp, để dành các tác vụ còn lại cho lần thử sau
      }
    }
  } finally {
    syncInFlight = false;
    // Hàng đợi vừa rỗng hẳn (không còn lỗi treo) -> báo "đã đồng bộ xong" rồi tự ẩn.
    if (hadQueueBefore && !syncQueue.length) flashSyncDone();
    updateSyncStatusBadge();
  }
}
function scheduleSyncRetry() {
  if (syncRetryTimer) return;
  const delay = Math.min(SYNC_RETRY_MAX_MS, SYNC_RETRY_BASE_MS * Math.pow(2, syncRetryAttempt));
  syncRetryAttempt++;
  syncRetryTimer = setTimeout(() => {
    syncRetryTimer = null;
    processSyncQueue();
  }, delay);
}
// Badge nhỏ báo trạng thái đồng bộ ngầm (cạnh badge chế độ kết nối) — chỉ hiện
// khi có việc đang chờ/đang chạy, ẩn hẳn khi hàng đợi rỗng để không gây rối mắt.
function updateSyncStatusBadge() {
  const el = $('#syncStatusBadge');
  if (!el) return;
  if (!syncQueue.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline) {
    el.textContent = `📴 Mất mạng — ${syncQueue.length} thay đổi sẽ tự đồng bộ khi có mạng lại`;
    el.className = 'badge badge-mode sync-error';
  } else if (syncInFlight) {
    el.textContent = `🔄 Đang đồng bộ ngầm (${syncQueue.length})...`;
    el.className = 'badge badge-mode mode-gas';
  } else if (syncQueue.some(j => j.attempts > 0)) {
    el.textContent = `⏳ ${syncQueue.length} thay đổi lỗi — đang chờ thử lại tự động`;
    el.className = 'badge badge-mode sync-error';
  } else {
    el.textContent = `⏳ ${syncQueue.length} thay đổi chờ đồng bộ`;
    el.className = 'badge badge-mode mode-csv';
  }
}
// Nhấp nháy "✅ Đã đồng bộ xong" trong vài giây khi hàng đợi vừa được xử lý
// hết sạch — cho người dùng biết chắc mọi thứ đã lên Sheet, đúng yêu cầu có
// trạng thái rõ ràng cho cả 3 pha (đang đồng bộ / đang chờ thử lại / đã xong).
function flashSyncDone() {
  const el = $('#syncStatusBadge');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = '✅ Đã đồng bộ xong';
  el.className = 'badge badge-mode sync-done';
  setTimeout(() => { if (!syncQueue.length) el.classList.add('hidden'); }, 2500);
}

// Yêu cầu #5: khi trình duyệt báo có mạng lại (sự kiện 'online'), thử đồng bộ
// ngay lập tức thay vì chờ hết thời gian backoff hiện tại -> trải nghiệm mượt
// hơn nhiều so với chỉ dựa vào hẹn giờ cố định.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    syncRetryAttempt = 0;
    if (syncRetryTimer) { clearTimeout(syncRetryTimer); syncRetryTimer = null; }
    processSyncQueue();
    updateSyncStatusBadge();
  });
  window.addEventListener('offline', updateSyncStatusBadge);
  // Cảnh báo nếu người dùng đóng tab/trình duyệt khi còn thay đổi CHƯA kịp
  // đồng bộ lên Sheet — dữ liệu vẫn AN TOÀN (đã lưu IndexedDB, lần sau mở lại
  // sẽ tự tiếp tục đồng bộ), nhưng vẫn nên nhắc để người dùng yên tâm chờ thêm
  // chút nếu mạng đang chập chờn.
  window.addEventListener('beforeunload', (e) => {
    if (syncQueue.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// Sau khi tải dữ liệu MỚI từ server (kết nối lại / tự làm mới ngầm), áp lại
// các thay đổi ĐANG CHỜ trong hàng đợi lên trên dữ liệu vừa tải — tránh tình
// huống dữ liệu mới từ Sheet (còn giá trị CŨ vì chưa kịp nhận thay đổi) đè mất
// thay đổi người dùng vừa thao tác nhưng chưa kịp đồng bộ xong.
function reapplyPendingSyncToRawData() {
  if (!syncQueueLoaded || !syncQueue.length) return;
  syncQueue.forEach(job => {
    const matchField = FIELD_MAP.find(f => f.header === job.matchHeader);
    if (!matchField) return;
    const row = state.rawData.find(r => (r[matchField.key] || '') === job.matchValue);
    if (!row) return;
    Object.keys(job.updates || {}).forEach(header => {
      const f = FIELD_MAP.find(f => f.header === header);
      if (f) row[f.key] = job.updates[header];
    });
  });
}

/* ---- Lưu / khôi phục trạng thái bộ lọc + sắp xếp -------------------------
   Lưu trên localStorage (dữ liệu nhỏ, chỉ danh sách lựa chọn) để khi mở lại
   trang (kể cả sau khi tắt hẳn trình duyệt), các bộ lọc đang chọn (Địa chỉ,
   Trạng thái, Người thực hiện, Lọc nhanh địa bàn cũ, Lọc bổ sung, Sắp xếp...)
   được khôi phục nguyên trạng, không phải lọc lại từ đầu. */
function persistFilterState() {
  try {
    const data = {
      filters: Object.fromEntries(FILTER_FIELDS.map(f => [f, Array.from(state.filters[f] || [])])),
      extraFilters: { ...state.extraFilters },
      quickDiaBan: state.quickDiaBan,
      sortCriteria: state.sortCriteria,
    };
    localStorage.setItem(FILTER_STATE_KEY, JSON.stringify(data));
  } catch (e) { /* localStorage đầy/bị chặn -> bỏ qua, không ảnh hưởng chức năng chính */ }
}
function restoreFilterState() {
  try {
    const raw = localStorage.getItem(FILTER_STATE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && data.filters) {
      FILTER_FIELDS.forEach(f => {
        state.filters[f] = new Set(Array.isArray(data.filters[f]) ? data.filters[f] : []);
      });
    }
    if (data && data.extraFilters) Object.assign(state.extraFilters, data.extraFilters);
    if (data && typeof data.quickDiaBan !== 'undefined') state.quickDiaBan = data.quickDiaBan;
    if (data && Array.isArray(data.sortCriteria)) state.sortCriteria = data.sortCriteria;
  } catch (e) { /* dữ liệu lưu bị hỏng -> bỏ qua, dùng mặc định */ }
}

/* ---------------------------- 5. XỬ LÝ DỮ LIỆU ĐỌC VÀO ---------------------- */
function processRows(rows) {
  const sampleHeaders = Object.keys(rows[0] || {});
  const headerToKey = {};
  sampleHeaders.forEach(h => {
    const norm = normalizeHeader(h);
    const match = FIELD_MAP.find(f => normalizeHeader(f.header) === norm);
    if (match) headerToKey[h] = match.key;
  });

  // Xác định cột "gia đình" (cột Y): ưu tiên tìm theo tên cột có chứa "gia đình",
  // nếu không thấy thì lấy đúng theo VỊ TRÍ cột Y (index 24) làm phương án dự phòng.
  let familyHeaderKey = sampleHeaders.find(h => stripDiacritics(h).includes('gia dinh'));
  if (!familyHeaderKey && sampleHeaders[FAMILY_COLUMN_INDEX]) familyHeaderKey = sampleHeaders[FAMILY_COLUMN_INDEX];

  state.rawData = rows.map((r, i) => {
    const obj = { _rowId: 'r' + i };
    FIELD_MAP.forEach(f => { obj[f.key] = ''; });
    Object.keys(r).forEach(h => {
      const key = headerToKey[h];
      if (key) obj[key] = (r[h] || '').toString().trim();
    });
    obj.giaDinh = familyHeaderKey ? (r[familyHeaderKey] || '').toString().trim() : '';
    return obj;
  }).filter(r => r.bienSo || r.soKhung || r.chuXe || r.cccd);

  // Yêu cầu (lưu trước, đồng bộ ngầm sau): dữ liệu mới tải từ server có thể
  // chưa kịp phản ánh các thay đổi người dùng vừa thao tác nhưng còn đang chờ
  // trong hàng đợi đồng bộ ngầm -> áp lại các thay đổi đó NGAY trên dữ liệu
  // vừa tải, để không bị "trồi ngược" về giá trị cũ trên giao diện.
  reapplyPendingSyncToRawData();

  state.filters = Object.fromEntries(FILTER_FIELDS.map(f => [f, new Set()]));
  // Yêu cầu (Lưu trạng thái bộ lọc đã chọn): khôi phục lại đúng các bộ lọc /
  // sắp xếp / lọc nhanh địa bàn cũ mà người dùng đã chọn ở phiên trước, thay vì
  // luôn bắt đầu từ danh sách trống mỗi lần tải dữ liệu (kể cả khi tải ngầm).
  restoreFilterState();
  state.exportSelected = new Set();
  state.page = 1;
  computeOwnerVehicleCounts();
  refreshAll();
  // Yêu cầu (Lưu dữ liệu cục bộ): lưu ngay dữ liệu vừa xử lý xong xuống
  // IndexedDB để lần mở trang sau có ngay dữ liệu mà không cần chờ mạng.
  persistRawDataToCache();
}

/* ---------------------------- 6. BỘ LỌC CASCADE ---------------------------- */
function getFiltered(excludeField) {
  return state.rawData.filter(row => {
    for (const key of FILTER_FIELDS) {
      if (key === excludeField) continue;
      const set = state.filters[key];
      if (!set || set.size === 0) continue;
      if (key === 'diaChi') {
        if (!set.has(row.diaChi) && !set.has(row.phuongXaMoi)) return false;
      } else if (key === 'nguoiThucHien') {
        const val = (row.nguoiThucHien || '').trim();
        if (!set.has(val || UNASSIGNED_FILTER_VALUE)) return false;
      } else {
        if (!set.has(row[key])) return false;
      }
    }
    // Yêu cầu 2B: bộ lọc bổ sung — chỉ giữ người có SĐT / người có nhiều xe.
    if (state.extraFilters.hasPhone && !(row.soDienThoai || '').trim()) return false;
    if (state.extraFilters.multiVehicle) {
      const count = state.ownerVehicleCounts.get(getEffectiveOwnerKey(row)) || 0;
      if (count < 2) return false;
    }
    // Yêu cầu #6: mặc định (và khi tích chọn) loại bỏ người "đã thực hiện" /
    // người "cần liên hệ lại" khỏi danh sách. NHƯNG nếu người dùng đang chủ
    // động lọc theo Người thực hiện cụ thể (bộ lọc mới), bỏ qua "Loại bỏ đã
    // thực hiện" — nếu không 2 bộ lọc sẽ triệt tiêu lẫn nhau (lọc ra người đã
    // gán rồi lại tự ẩn hết người đã gán).
    const hasAssigneeFilter = state.filters.nguoiThucHien && state.filters.nguoiThucHien.size > 0;
    if (state.extraFilters.excludeDone && !hasAssigneeFilter && isRowDone(row)) return false;
    if (state.extraFilters.excludeRecontact && isRowNeedRecontact(row)) return false;
    // Yêu cầu (Lọc nhanh theo Địa bàn cũ): kết hợp AND với các bộ lọc khác.
    if (state.quickDiaBan && !rowMatchesQuickDiaBan(row, state.quickDiaBan)) return false;
    return true;
  });
}

function getOptionsFor(field) {
  const data = getFiltered(field);
  const set = new Set();
  // Bộ lọc "Người thực hiện": liệt kê đủ mọi người đang có trong danh sách
  // "Người thực hiện" (kể cả người vừa được thêm mới nhưng chưa gán cho xe
  // nào), CỘNG với các dòng chưa gán ai (tuỳ chọn "Chưa có ai thực hiện").
  if (field === 'nguoiThucHien') {
    let hasUnassigned = false;
    data.forEach(row => {
      const v = (row.nguoiThucHien || '').trim();
      if (v) set.add(v); else hasUnassigned = true;
    });
    loadAssigneeList().forEach(a => set.add(a));
    const names = Array.from(set).sort((a, b) => a.localeCompare(b, 'vi'));
    return hasUnassigned ? [...names, UNASSIGNED_FILTER_VALUE] : names;
  }
  data.forEach(row => {
    if (field === 'diaChi') {
      if (row.diaChi) set.add(row.diaChi);
      if (row.phuongXaMoi) set.add(row.phuongXaMoi);
    } else if (row[field]) {
      set.add(row[field]);
    }
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'vi'));
}

// Nhãn hiển thị cho 1 giá trị trong bộ lọc — chỉ khác giá trị thật đối với
// tuỳ chọn đặc biệt "Chưa có ai thực hiện" (giá trị thật là UNASSIGNED_FILTER_VALUE).
function filterOptionLabel(field, value) {
  if (field === 'nguoiThucHien' && value === UNASSIGNED_FILTER_VALUE) return UNASSIGNED_FILTER_LABEL;
  return value;
}

/* ---------------------------- 6b. SẮP XẾP KẾT HỢP NHIỀU TIÊU CHÍ ------------ */
// Lấy giá trị dùng để so sánh khi sắp xếp cho 1 dòng theo 1 trường cụ thể.
// Yêu cầu 2A: cột "Tên" (chủ phương tiện) CHỈ so sánh theo TÊN (từ cuối cùng
// trong họ tên), bỏ qua họ và chữ lót — dùng lại splitNameParts() đã có sẵn
// để tách tên (phục vụ đối chiếu Mục III).
function getSortValue(row, field) {
  if (field === 'soLuongXe') {
    return state.ownerVehicleCounts.get(getEffectiveOwnerKey(row)) || 0;
  }
  const raw = (row[field] || '').toString().trim();
  if (field === 'chuXe') {
    const parts = splitNameParts(raw);
    return parts ? parts.ten : normalizeName(raw);
  }
  return raw;
}

// So sánh 2 dòng dữ liệu theo TOÀN BỘ danh sách tiêu chí đã chọn (state.sortCriteria),
// theo đúng thứ tự ưu tiên (tiêu chí đầu tiên quyết định trước, các tiêu chí sau
// chỉ dùng để "phân giải" khi tiêu chí trước bằng nhau).
// Nếu người dùng chưa chọn tiêu chí nào nhưng đang bật lọc "nhiều xe", mặc định
// sắp xếp theo số lượng xe giảm dần (nhiều -> ít) như yêu cầu 2B.
function compareBySortCriteria(a, b) {
  const criteria = state.sortCriteria.length
    ? state.sortCriteria
    : (state.extraFilters.multiVehicle ? [{ field: 'soLuongXe', dir: 'desc' }] : []);
  for (const { field, dir } of criteria) {
    const fieldDef = SORT_FIELDS.find(f => f.key === field);
    const va = getSortValue(a, field);
    const vb = getSortValue(b, field);
    let cmp;
    if (fieldDef && fieldDef.type === 'number') {
      cmp = (Number(va) || 0) - (Number(vb) || 0);
    } else {
      cmp = va.toString().localeCompare(vb.toString(), 'vi', { sensitivity: 'base' });
    }
    if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}

// Khi đã chọn nhiều hơn số này VÀ ô lọc đang KHÔNG mở, gom các chip lại thành
// 1 chip tóm tắt "N giá trị đã chọn" cho gọn, thay vì liệt kê hết ra (từng gây
// vỡ giao diện khi chọn hàng chục/hàng trăm giá trị).
const MS_COLLAPSE_THRESHOLD = 3;

function renderMultiSelect(field) {
  const container = $(`.ms-control[data-field="${field}"]`);
  if (!container) return;
  const ui = state.msUI[field];
  const selected = state.filters[field];
  const allOptions = getOptionsFor(field);
  const searchLower = ui.search.trim().toLowerCase();
  const visibleOptions = searchLower
    ? allOptions.filter(o => filterOptionLabel(field, o).toLowerCase().includes(searchLower))
    : allOptions;

  // Gọn: khi không đang thao tác (đóng dropdown) và chọn nhiều -> chỉ hiện 1 chip tóm tắt.
  // Đầy đủ: khi đang mở dropdown để chỉnh sửa -> liệt kê hết (có scroll riêng, không đẩy vỡ trang).
  const isCollapsed = !ui.open && selected.size > MS_COLLAPSE_THRESHOLD;

  const chipsHtml = isCollapsed
    ? `<span class="ms-chip ms-chip-summary" data-role="ms-summary" title="Bấm để xem/chỉnh sửa danh sách đã chọn">
         ✓ Đã chọn ${selected.size} giá trị
         <span class="x" data-clear-all="1" title="Bỏ chọn tất cả">✕</span>
       </span>`
    : Array.from(selected).map(v => `
    <span class="ms-chip" data-value="${escapeHtml(v)}">
      ${escapeHtml(filterOptionLabel(field, v))}<span class="x" data-remove="${escapeHtml(v)}">✕</span>
    </span>`).join('');

  let dropdownHtml = '';
  if (ui.open) {
    const allSelectedVisible = visibleOptions.length > 0 && visibleOptions.every(o => selected.has(o));
    let optsHtml = '';
    if (visibleOptions.length === 0) {
      optsHtml = `<div class="ms-empty">Không tìm thấy giá trị phù hợp</div>`;
    } else {
      optsHtml = `<div class="ms-option all-option" data-toggle-all="1">
          <input type="checkbox" ${allSelectedVisible ? 'checked' : ''}> Chọn tất cả (${visibleOptions.length})
        </div>` +
        visibleOptions.slice(0, 300).map(o => `
          <div class="ms-option" data-value="${escapeHtml(o)}">
            <input type="checkbox" ${selected.has(o) ? 'checked' : ''}> ${escapeHtml(filterOptionLabel(field, o))}
          </div>`).join('');
    }
    dropdownHtml = `<div class="ms-dropdown">${optsHtml}</div>`;
  }

  container.innerHTML = `
    <div class="ms-input-box ${ui.open ? 'ms-input-box-expanded' : ''}">
      ${chipsHtml}
      <input type="text" placeholder="Gõ để tìm..." value="${escapeHtml(ui.search)}" data-role="ms-search">
    </div>
    ${dropdownHtml}
  `;
}

function refreshFilterUIs() { FILTER_FIELDS.forEach(renderMultiSelect); }

const filterBar = $('#filterBar');
filterBar.addEventListener('focusin', (e) => {
  const input = e.target.closest('[data-role="ms-search"]');
  if (!input) return;
  const field = input.closest('.ms-control').dataset.field;
  if (state.msUI[field].open) return; // đã mở sẵn -> khỏi render lại, tránh mất focus khi đang gõ
  state.msUI[field].open = true;
  refreshFilterUIs();
  // BUG CŨ: refreshFilterUIs() thay mới toàn bộ DOM của các ô lọc (innerHTML=...),
  // nên ô input vừa được click/focus cũng bị thay bằng 1 <input> mới hoàn toàn
  // và MẤT FOCUS ngay lập tức -> gõ chữ vào không có tác dụng. Phải focus lại
  // đúng ô input mới được tạo ra cho field này thì mới gõ được.
  const newInput = $(`.ms-control[data-field="${field}"] [data-role="ms-search"]`);
  if (newInput) newInput.focus();
});
filterBar.addEventListener('input', (e) => {
  const input = e.target.closest('[data-role="ms-search"]');
  if (!input) return;
  const field = input.closest('.ms-control').dataset.field;
  state.msUI[field].search = input.value;
  state.msUI[field].open = true;
  renderMultiSelect(field);
  const newInput = $(`.ms-control[data-field="${field}"] [data-role="ms-search"]`);
  if (newInput) { newInput.focus(); newInput.selectionStart = newInput.selectionEnd = newInput.value.length; }
});
filterBar.addEventListener('keydown', (e) => {
  const input = e.target.closest('[data-role="ms-search"]');
  if (!input || e.key !== 'Enter') return;
  e.preventDefault();
  const field = input.closest('.ms-control').dataset.field;
  const search = state.msUI[field].search.trim().toLowerCase();
  if (!search) return;
  const matches = getOptionsFor(field).filter(o => filterOptionLabel(field, o).toLowerCase().includes(search));
  matches.forEach(m => state.filters[field].add(m));
  state.msUI[field].search = '';
  state.page = 1;
  refreshFilterUIs();
  renderTable();
});
filterBar.addEventListener('click', (e) => {
  const clearAllBtn = e.target.closest('[data-clear-all]');
  const removeBtn = e.target.closest('[data-remove]');
  const option = e.target.closest('.ms-option');
  const control = e.target.closest('.ms-control');
  if (!control) return;
  const field = control.dataset.field;

  if (clearAllBtn) {
    e.stopPropagation();
    state.filters[field].clear();
    state.page = 1;
    refreshFilterUIs(); renderTable();
    return;
  }
  const summaryChip = e.target.closest('[data-role="ms-summary"]');
  if (summaryChip) {
    const input = control.querySelector('[data-role="ms-search"]');
    if (input) input.focus();
    return;
  }
  if (removeBtn) {
    state.filters[field].delete(removeBtn.dataset.remove);
    state.page = 1;
    refreshFilterUIs(); renderTable();
    return;
  }
  if (option) {
    if (option.dataset.toggleAll) {
      const visible = getOptionsFor(field).filter(o =>
        !state.msUI[field].search || o.toLowerCase().includes(state.msUI[field].search.trim().toLowerCase()));
      const allSelected = visible.every(o => state.filters[field].has(o));
      if (allSelected) visible.forEach(o => state.filters[field].delete(o));
      else visible.forEach(o => state.filters[field].add(o));
    } else {
      const val = option.dataset.value;
      if (state.filters[field].has(val)) state.filters[field].delete(val);
      else state.filters[field].add(val);
    }
    state.page = 1;
    refreshFilterUIs(); renderTable();
  }
});
document.addEventListener('click', (e) => {
  FILTER_FIELDS.forEach(field => {
    const control = $(`.ms-control[data-field="${field}"]`);
    if (control && !control.contains(e.target) && state.msUI[field].open) {
      state.msUI[field].open = false;
      renderMultiSelect(field);
    }
  });
});
$('#btnClearFilters').addEventListener('click', () => {
  FILTER_FIELDS.forEach(f => { state.filters[f].clear(); state.msUI[f].search = ''; });
  // Yêu cầu 2B: "Xóa bộ lọc" cũng bỏ tích 2 bộ lọc bổ sung (SĐT / nhiều xe).
  state.extraFilters.hasPhone = false;
  state.extraFilters.multiVehicle = false;
  // Yêu cầu #6: đưa 2 bộ lọc "đã thực hiện" / "cần liên hệ lại" về đúng trạng
  // thái mặc định của trang (BẬT — tự động loại khỏi danh sách), thay vì tắt hẳn.
  state.extraFilters.excludeDone = true;
  state.extraFilters.excludeRecontact = true;
  // Yêu cầu (Lọc nhanh theo Địa bàn cũ): "Xóa bộ lọc" cũng bỏ chọn địa bàn cũ.
  state.quickDiaBan = null;
  updateQuickDiaBanButtonsUI();
  renderSortBar();
  state.page = 1;
  // FIX BUG: trước đây xóa bộ lọc không reset trạng thái đã chọn xe (checkbox),
  // khiến các dòng đã chọn từ trước vẫn hiện "đã chọn" nhưng không bấm bỏ chọn
  // được nữa (do state cũ không khớp với dòng dữ liệu hiển thị lại sau khi lọc
  // thay đổi). Nay chủ động reset hoàn toàn danh sách xe đã chọn để xuất.
  state.exportSelected.clear();
  refreshFilterUIs(); renderTable();
});

/* ------------------- 6b-2. LỌC NHANH THEO ĐỊA BÀN CŨ ----------------------- */
// Nhóm nút bấm 1 lần để lọc nhanh theo địa bàn cũ (Tam Đàn / Tam Thái / Phú
// Thịnh — Phú Thịnh gộp luôn "Tam Vinh"), kết hợp AND được với mọi bộ lọc
// khác đang có (bộ lọc "Địa chỉ", "Trạng thái xe"...). Hoạt động như nhóm nút
// chọn 1 (radio): bấm vào nút đang chọn sẽ BỎ CHỌN (quay lại danh sách đầy đủ).
function updateQuickDiaBanButtonsUI() {
  $all('[data-quick-diaban]').forEach(btn => {
    btn.classList.toggle('active', state.quickDiaBan === btn.dataset.quickDiaban);
  });
}
const quickDiaBanWrap = $('#quickDiaBanWrap');
if (quickDiaBanWrap) {
  quickDiaBanWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-diaban]');
    if (!btn) return;
    const key = btn.dataset.quickDiaban;
    state.quickDiaBan = (state.quickDiaBan === key) ? null : key;
    state.page = 1;
    updateQuickDiaBanButtonsUI();
    renderTable();
  });
}

/* ------------------- 6c. THANH SẮP XẾP + LỌC BỔ SUNG + XUẤT EXCEL --------- */
// Yêu cầu 2A: vẽ danh sách tiêu chí sắp xếp đang chọn (kéo thêm được nhiều
// tiêu chí, mỗi tiêu chí có thể chọn cột + hướng tăng/giảm dần).
function renderSortBar() {
  const list = $('#sortCriteriaList');
  if (!list) return; // phòng trường hợp HTML chưa có (an toàn khi tái sử dụng script)
  if (!state.sortCriteria.length) {
    list.innerHTML = `<p class="hint" style="margin:2px 0 6px;">Chưa chọn tiêu chí nào — bấm "+ Thêm tiêu chí" bên dưới. Có thể thêm nhiều tiêu chí, tiêu chí phía trên được ưu tiên trước.</p>`;
  } else {
    list.innerHTML = state.sortCriteria.map((c, idx) => `
      <div class="sort-criteria-row" data-idx="${idx}">
        <span class="sort-order-badge">${idx + 1}</span>
        <select class="sort-field-select" data-idx="${idx}">
          ${SORT_FIELDS.map(f => `<option value="${f.key}" ${f.key === c.field ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
        </select>
        <select class="sort-dir-select" data-idx="${idx}">
          <option value="asc" ${c.dir !== 'desc' ? 'selected' : ''}>Tăng dần (A→Z)</option>
          <option value="desc" ${c.dir === 'desc' ? 'selected' : ''}>Giảm dần (Z→A)</option>
        </select>
        <button type="button" class="btn btn-ghost btn-sm sort-remove-btn" data-idx="${idx}" title="Xóa tiêu chí này">✕</button>
      </div>`).join('');
  }
  const chkPhone = $('#chkHasPhone');
  const chkMulti = $('#chkMultiVehicle');
  const chkDone = $('#chkExcludeDone');
  const chkRecontact = $('#chkExcludeRecontact');
  if (chkPhone) chkPhone.checked = state.extraFilters.hasPhone;
  if (chkMulti) chkMulti.checked = state.extraFilters.multiVehicle;
  if (chkDone) chkDone.checked = state.extraFilters.excludeDone;
  if (chkRecontact) chkRecontact.checked = state.extraFilters.excludeRecontact;
}

const sortBarEl = $('#sortBar');
if (sortBarEl) {
  $('#btnAddSortCriteria').addEventListener('click', () => {
    // Ưu tiên gợi ý cột chưa được dùng làm tiêu chí, để khuyến khích kết hợp
    // nhiều tiêu chí khác nhau (VD: tên + địa chỉ + số lượng xe cùng gia đình).
    const usedFields = new Set(state.sortCriteria.map(c => c.field));
    const nextField = SORT_FIELDS.find(f => !usedFields.has(f.key)) || SORT_FIELDS[0];
    state.sortCriteria.push({ field: nextField.key, dir: 'asc' });
    renderSortBar();
    renderTable();
  });

  $('#sortCriteriaList').addEventListener('change', (e) => {
    const idx = parseInt(e.target.dataset.idx, 10);
    if (Number.isNaN(idx) || !state.sortCriteria[idx]) return;
    if (e.target.classList.contains('sort-field-select')) state.sortCriteria[idx].field = e.target.value;
    if (e.target.classList.contains('sort-dir-select')) state.sortCriteria[idx].dir = e.target.value;
    renderTable();
  });

  $('#sortCriteriaList').addEventListener('click', (e) => {
    const btn = e.target.closest('.sort-remove-btn');
    if (!btn) return;
    state.sortCriteria.splice(parseInt(btn.dataset.idx, 10), 1);
    renderSortBar();
    renderTable();
  });

  $('#btnClearSort').addEventListener('click', () => {
    state.sortCriteria = [];
    renderSortBar();
    renderTable();
  });

  $('#chkHasPhone').addEventListener('change', (e) => {
    state.extraFilters.hasPhone = e.target.checked;
    state.page = 1;
    renderTable();
  });
  $('#chkMultiVehicle').addEventListener('change', (e) => {
    state.extraFilters.multiVehicle = e.target.checked;
    state.page = 1;
    renderTable();
  });
  // Yêu cầu #6: 2 bộ lọc bổ sung mới — loại bỏ "đã thực hiện" / "cần liên hệ lại".
  const chkExcludeDoneEl = $('#chkExcludeDone');
  if (chkExcludeDoneEl) chkExcludeDoneEl.addEventListener('change', (e) => {
    state.extraFilters.excludeDone = e.target.checked;
    state.page = 1;
    renderTable();
  });
  const chkExcludeRecontactEl = $('#chkExcludeRecontact');
  if (chkExcludeRecontactEl) chkExcludeRecontactEl.addEventListener('change', (e) => {
    state.extraFilters.excludeRecontact = e.target.checked;
    state.page = 1;
    renderTable();
  });

  /* ---- Xuất file .xlsx theo đúng dữ liệu đã lọc + đã sắp xếp (để in) ---- */
  // Thư viện SheetJS (xlsx) được tải "lười" (chỉ khi bấm xuất) qua CDN, tránh
  // phải sửa index.html và giữ trang tải nhanh khi không dùng tới tính năng này.
  let xlsxLibPromise = null;
  function loadXlsxLib() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLibPromise) return xlsxLibPromise;
    xlsxLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => reject(new Error('Không tải được thư viện xuất Excel (kiểm tra kết nối mạng).'));
      document.head.appendChild(script);
    });
    return xlsxLibPromise;
  }

  const EXPORT_COLUMNS = [
    { header: 'STT', key: 'stt' }, { header: 'Biển số', key: 'bienSo' },
    { header: 'Số khung', key: 'soKhung' }, { header: 'Số máy', key: 'soMay' },
    { header: 'Nhãn hiệu', key: 'nhanHieu' }, { header: 'Loại xe', key: 'loaiXe' },
    { header: 'Chủ phương tiện', key: 'chuXe' }, { header: 'Số CCCD/MST', key: 'cccd' },
    { header: 'Địa chỉ đăng ký', key: 'diaChi' }, { header: 'Phường/Xã mới', key: 'phuongXaMoi' },
    { header: 'Trạng thái xe', key: 'trangThaiXe' }, { header: 'Ngày đăng ký', key: 'ngayDangKy' },
    { header: 'Số điện thoại', key: 'soDienThoai' }, { header: 'Ghi Chú', key: 'ghiChu' },
    { header: 'Người thực hiện', key: 'nguoiThucHien' },
  ];

  $('#btnExportXlsx').addEventListener('click', async () => {
    // Xuất đúng những gì đang thấy trên bảng: đã lọc (kể cả lọc bổ sung) VÀ
    // đã sắp xếp theo đúng thứ tự tiêu chí hiện tại — để in ra là dùng được ngay.
    const rows = getFiltered(null).slice().sort(compareBySortCriteria);
    if (!rows.length) { toast('Không có dòng nào để xuất theo bộ lọc hiện tại.', true); return; }

    const btn = $('#btnExportXlsx');
    const oldText = btn.textContent;
    btn.disabled = true; btn.textContent = 'Đang xuất...';
    try {
      const XLSX = await loadXlsxLib();
      const aoa = [EXPORT_COLUMNS.map(c => c.header)]
        .concat(rows.map(r => EXPORT_COLUMNS.map(c => r[c.key] || '')));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = EXPORT_COLUMNS.map(() => ({ wch: 20 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Danh sách');
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `DanhSachPhuongTien_${stamp}.xlsx`);
      toast(`Đã xuất ${rows.length} dòng ra file Excel.`);
    } catch (err) {
      toast('Lỗi khi xuất Excel: ' + (err && err.message ? err.message : String(err)), true);
    } finally {
      btn.disabled = false; btn.textContent = oldText;
    }
  });
}

/* ---------------------------- 7. BẢNG DỮ LIỆU ------------------------------ */
$('#pageSizeSelect').addEventListener('change', (e) => {
  state.pageSize = parseInt(e.target.value, 10);
  state.page = 1;
  renderTable();
});

function updateRecordCount() {
  $('#recordCount').textContent = `${state.rawData.length} bản ghi`;
}

// SỬA LỖI (Yêu cầu #2): khi bộ lọc thay đổi, các xe ĐÃ CHỌN trước đó nhưng
// không còn nằm trong kết quả lọc hiện tại phải được TỰ ĐỘNG BỎ CHỌN — nếu
// không, chúng vẫn bị tính là "đã chọn" (ảnh hưởng số đếm, xuất Excel, tạo
// Bản cam kết, cập nhật hàng loạt...) dù người dùng không còn thấy chúng đâu
// trên danh sách để bỏ chọn thủ công. Hàm này chỉ giữ lại trong exportSelected
// những rowId thực sự có trong `visibleRows` (kết quả lọc hiện tại, CHƯA phân
// trang — tức là "còn thấy được nếu chuyển trang", chỉ loại bỏ khi bộ lọc thực
// sự đã thay đổi). Trả về true nếu có thay đổi (để nơi gọi biết mà vẽ lại nơi
// khác nếu cần, ví dụ panel chi tiết).
function pruneSelectionToRows(visibleRows) {
  const visibleIds = new Set(visibleRows.map(r => r._rowId));
  let changed = false;
  state.exportSelected.forEach(id => {
    if (!visibleIds.has(id)) { state.exportSelected.delete(id); changed = true; }
  });
  return changed;
}

function renderTable() {
  const filtered = getFiltered(null);
  // Yêu cầu 2A/2B: áp dụng sắp xếp (kết hợp nhiều tiêu chí) sau khi đã lọc,
  // trước khi phân trang, để thứ tự hiển thị và thứ tự xuất Excel khớp nhau.
  filtered.sort(compareBySortCriteria);
  // Yêu cầu #2: tự động bỏ chọn các xe không còn nằm trong bộ lọc hiện tại
  // (xem giải thích ở pruneSelectionToRows() phía trên).
  pruneSelectionToRows(filtered);
  $('#filteredCount').textContent = `${filtered.length} / ${state.rawData.length} dòng`;

  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);

  const tbody = $('#tableBody');
  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="16" class="empty-state">Không có dòng nào khớp bộ lọc.</td></tr>`;
  } else {
    tbody.innerHTML = pageRows.map(row => `
      <tr data-rowid="${row._rowId}" class="${state.exportSelected.has(row._rowId) ? 'selected-row' : ''}">
        <td class="col-chk"><input type="checkbox" data-role="row-chk" ${state.exportSelected.has(row._rowId) ? 'checked' : ''}></td>
        <td>${escapeHtml(row.stt)}</td>
        <td class="sticky-col col-sticky-bienso">${escapeHtml(row.bienSo)}</td>
        <td>${escapeHtml(row.soKhung)}</td>
        <td>${escapeHtml(row.soMay)}</td>
        <td>${escapeHtml(row.nhanHieu)}</td>
        <td>${escapeHtml(row.loaiXe)}</td>
        <td class="sticky-col col-sticky-chuxe">${escapeHtml(row.chuXe)}</td>
        <td>${escapeHtml(row.cccd)}</td>
        <td>${escapeHtml(row.diaChi)}</td>
        <td>${escapeHtml(row.phuongXaMoi)}</td>
        <td>${buildRowStatusSelectHtml(row)}</td>
        <td>${escapeHtml(row.ngayDangKy)}</td>
        <td>${escapeHtml(row.soDienThoai)}</td>
        <td>${buildRowNoteInputHtml(row)}</td>
        <td>${buildRowAssigneeSelectHtml(row)}</td>
      </tr>
    `).join('');
  }

  renderPagination(totalPages, filtered.length);
  updateSelectedCount();
  updateSelectAllPageCheckbox(pageRows);
  setupMainHScrollSync();
}

// Yêu cầu (thanh trượt ngang dính cố định dưới chân trang): thanh
// #mainHScrollTrack dùng chung 1 <input type="range"> đồng bộ 2 chiều với
// thanh cuộn ngang GỐC của .table-wrap — luôn hiện rõ (position:sticky) dù
// danh sách xe rất dài, thay vì phải kéo xuống tận đáy bảng mới thấy được
// thanh cuộn ngang mặc định của trình duyệt.
function setupMainHScrollSync() {
  const track = $('#mainHScrollTrack');
  const range = $('#mainHScrollRange');
  const wrap = $('.table-wrap');
  if (!track || !range || !wrap) return;
  const maxScroll = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
  if (maxScroll <= 2) { track.classList.add('hidden'); return; }
  track.classList.remove('hidden');
  range.max = String(maxScroll);
  range.value = String(wrap.scrollLeft || 0);

  let syncing = false;
  range.oninput = () => {
    if (syncing) return;
    syncing = true;
    wrap.scrollLeft = Number(range.value);
    syncing = false;
  };
  wrap.onscroll = () => {
    if (syncing) return;
    syncing = true;
    range.value = String(wrap.scrollLeft);
    syncing = false;
  };
}
window.addEventListener('resize', () => { if (typeof renderTable === 'function') setupMainHScrollSync(); });

function renderPagination(totalPages, totalRows) {
  const el = $('#pagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  const cur = state.page;
  const buttons = [];
  buttons.push(`<button data-page="${cur - 1}" ${cur === 1 ? 'disabled' : ''}>‹</button>`);
  const windowSize = 2;
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= cur - windowSize && p <= cur + windowSize)) {
      buttons.push(`<button data-page="${p}" class="${p === cur ? 'active' : ''}">${p}</button>`);
    } else if (p === cur - windowSize - 1 || p === cur + windowSize + 1) {
      buttons.push(`<span style="padding:6px 2px;">…</span>`);
    }
  }
  buttons.push(`<button data-page="${cur + 1}" ${cur === totalPages ? 'disabled' : ''}>›</button>`);
  el.innerHTML = buttons.join('');
}
$('#pagination').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]');
  if (!btn || btn.disabled) return;
  state.page = parseInt(btn.dataset.page, 10);
  renderTable();
});

function updateSelectedCount() {
  $('#selectedCount').textContent = `${state.exportSelected.size} xe đã chọn để xuất`;
  const bulkBtn = $('#btnBulkUpdate');
  if (bulkBtn) bulkBtn.disabled = state.exportSelected.size === 0;
  // Yêu cầu #2: nút "Bỏ chọn tất cả" chỉ bật khi đang có ít nhất 1 xe được chọn.
  const deselectBtn = $('#btnDeselectAll');
  if (deselectBtn) deselectBtn.disabled = state.exportSelected.size === 0;
}

// Yêu cầu #2: "Bỏ chọn tất cả" ở trang chủ — xoá TOÀN BỘ lựa chọn hiện tại
// (trên mọi trang / không chỉ trang đang xem), vì selectedCount vốn cũng đang
// đếm theo toàn bộ state.exportSelected (không giới hạn theo trang).
$('#btnDeselectAll').addEventListener('click', () => {
  if (!state.exportSelected.size) return;
  state.exportSelected.clear();
  renderTable();
  // Nếu panel chi tiết đang mở, vẽ lại để đồng bộ checkbox trong các bảng mini.
  if (currentDetailRow && !$('#detailOverlay').classList.contains('hidden')) {
    renderDetailPanelFor(currentDetailRow);
  }
  toast('Đã bỏ chọn tất cả.');
});
function updateSelectAllPageCheckbox(pageRows) {
  const chk = $('#chkSelectAllPage');
  if (!pageRows.length) { chk.checked = false; chk.indeterminate = false; return; }
  const allChecked = pageRows.every(r => state.exportSelected.has(r._rowId));
  const anyChecked = pageRows.some(r => state.exportSelected.has(r._rowId));
  chk.checked = allChecked;
  chk.indeterminate = anyChecked && !allChecked;
}
$('#chkSelectAllPage').addEventListener('change', (e) => {
  const filtered = getFiltered(null);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);
  if (e.target.checked) pageRows.forEach(r => state.exportSelected.add(r._rowId));
  else pageRows.forEach(r => state.exportSelected.delete(r._rowId));
  renderTable();
});

$('#tableBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-rowid]');
  if (!tr) return;
  const rowId = tr.dataset.rowid;
  if (e.target.closest('[data-role="row-chk"]')) {
    if (state.exportSelected.has(rowId)) state.exportSelected.delete(rowId);
    else state.exportSelected.add(rowId);
    renderTable();
    return;
  }
  // Yêu cầu #2: bấm vào ô Ghi chú / chọn Trạng thái / chọn Người thực hiện
  // ngay trên dòng KHÔNG được mở panel Chi tiết (chỉ để nhập liệu tại chỗ).
  if (e.target.closest('[data-role="row-status-select"], [data-role="row-note-input"], [data-role="row-assignee-select"]')) {
    return;
  }
  // Yêu cầu (bôi đen để copy thông tin dòng xe): nếu đây là thao tác kéo
  // chuột để chọn chữ (hoặc đang có vùng bôi đen), KHÔNG mở panel chi tiết —
  // xem giải thích chi tiết ở isTextSelectOrDragClick().
  if (isTextSelectOrDragClick(e)) return;
  openDetailPanel(rowId);
});

// Yêu cầu #2: xử lý thay đổi Trạng thái / Ghi chú / Người thực hiện nhập trực
// tiếp trên từng dòng ở bảng chính. Dùng "change" (không phải "input") để chỉ
// lưu khi người dùng đã gõ xong (rời khỏi ô / bấm Enter), tránh ghi liên tục.
$('#tableBody').addEventListener('change', async (e) => {
  const statusSelect = e.target.closest('[data-role="row-status-select"]');
  const noteInput = e.target.closest('[data-role="row-note-input"]');
  const assigneeSelect = e.target.closest('[data-role="row-assignee-select"]');
  if (!statusSelect && !noteInput && !assigneeSelect) return;

  const rowId = (statusSelect || noteInput || assigneeSelect).dataset.rowid;
  const row = state.rawData.find(r => r._rowId === rowId);
  if (!row) return;

  if (statusSelect) {
    await updateSingleRowFields(row, { trangThaiXe: statusSelect.value });
  } else if (noteInput) {
    await updateSingleRowFields(row, { ghiChu: noteInput.value });
  } else if (assigneeSelect) {
    let value = assigneeSelect.value;
    if (value === ASSIGNEE_ADD_NEW_VALUE) {
      const name = window.prompt('Nhập tên Người thực hiện mới:');
      const added = addAssigneeToList(name);
      if (!added) { renderTable(); return; } // người dùng hủy / để trống -> không đổi gì
      value = added;
    }
    await updateSingleRowFields(row, { nguoiThucHien: value });
  }
  // Vẽ lại bảng: cần thiết vì Trạng thái / Người thực hiện có thể ảnh hưởng
  // tới các bộ lọc "Cần liên hệ lại" / "Loại bỏ đã thực hiện" đang bật.
  renderTable();
});

/* ---------------------------- 7b. CẬP NHẬT HÀNG LOẠT (NHIỀU XE) ------------ */
// Yêu cầu #3: cho phép chọn nhiều xe (checkbox ở bảng chính / panel chi tiết)
// rồi cập nhật Trạng thái xe / Ghi chú / Người thực hiện cùng lúc cho tất cả
// các xe đã chọn.
//
// `bulkUpdateRows` lưu ĐÚNG danh sách xe sẽ bị áp dụng khi bấm "Áp dụng" trong
// modal — mặc định là toàn bộ state.exportSelected (nút "Cập nhật hàng loạt"
// trên thanh công cụ chính), nhưng cũng có thể là một TẬP CON đã chọn, ví dụ
// riêng các xe đã tích trong Mục I của panel chi tiết chủ phương tiện (Yêu cầu
// mới: "Cập nhật hàng loạt trong Mục I"). Dùng chung 1 modal + 1 luồng ghi dữ
// liệu duy nhất để tránh trùng lặp code và giảm rủi ro phát sinh lỗi mới.
let bulkUpdateRows = [];

// Mở modal cập nhật hàng loạt cho đúng danh sách `rows` được truyền vào.
function openBulkUpdateModal(rows) {
  if (!rows.length) { toast('Vui lòng chọn ít nhất 1 xe (checkbox) trước.', true); return; }
  bulkUpdateRows = rows;
  $('#bulkUpdateCount').textContent = rows.length;
  $('#bulkStatusSelect').value = '';
  $('#bulkNoteText').value = '';
  $('#bulkNoteMode').value = 'append';
  // Yêu cầu #5: dựng lại danh sách "Người thực hiện" mỗi lần mở modal (để
  // thấy được cả những người vừa được thêm mới), để trống = giữ nguyên.
  const bulkAssignee = $('#bulkAssigneeSelect');
  if (bulkAssignee) {
    bulkAssignee.innerHTML = [`<option value="">— Giữ nguyên Người thực hiện —</option>`]
      .concat(loadAssigneeList().map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`))
      .concat([`<option value="${ASSIGNEE_ADD_NEW_VALUE}">+ Thêm người mới...</option>`])
      .join('');
    bulkAssignee.value = '';
  }
  openModal('bulkUpdateModal');
}

$('#btnBulkUpdate').addEventListener('click', () => {
  openBulkUpdateModal(state.rawData.filter(r => state.exportSelected.has(r._rowId)));
});

// Yêu cầu #5: chọn "+ Thêm người mới..." ngay trong modal cập nhật hàng loạt.
const bulkAssigneeSelectEl = $('#bulkAssigneeSelect');
if (bulkAssigneeSelectEl) {
  bulkAssigneeSelectEl.addEventListener('change', () => {
    if (bulkAssigneeSelectEl.value !== ASSIGNEE_ADD_NEW_VALUE) return;
    const name = window.prompt('Nhập tên Người thực hiện mới:');
    const added = addAssigneeToList(name);
    if (added) {
      const opt = document.createElement('option');
      opt.value = added; opt.textContent = added;
      bulkAssigneeSelectEl.insertBefore(opt, bulkAssigneeSelectEl.lastElementChild);
      bulkAssigneeSelectEl.value = added;
    } else {
      bulkAssigneeSelectEl.value = '';
    }
  });
}

// LƯU Ý (đã nâng cấp lên mô hình local-first): trước đây khối cập nhật hàng
// loạt bên dưới ghi trực tiếp lên Google Sheet (tuần tự, hoặc sau đó là tối đa
// 6 request đồng thời qua runWithConcurrencyLimit()) và người dùng phải CHỜ
// đến khi tất cả request xong mới thấy modal đóng lại. Nay mọi thay đổi được
// áp dụng NGAY vào bộ nhớ + IndexedDB, còn việc ghi lên Sheet được đẩy vào
// hàng đợi đồng bộ NGẦM (enqueueRowSync) — xem handler '#btnBulkApply' bên
// dưới. runWithConcurrencyLimit() vẫn được giữ lại (không xoá) để không phá vỡ
// nơi khác có thể đang dùng, nhưng không còn cần thiết cho luồng này nữa.

// LOCAL-FIRST (Yêu cầu #2 + #4): áp dụng thay đổi cho TẤT CẢ xe đã chọn NGAY
// LẬP TỨC trong bộ nhớ + IndexedDB (không chờ mạng), rồi đẩy từng dòng THỰC SỰ
// thay đổi vào hàng đợi đồng bộ ngầm. Nhờ vậy modal đóng lại tức thì kể cả khi
// chọn hàng nghìn xe hoặc mạng đang chậm/mất — trước đây phải chờ từng đợt
// request (dù đã giới hạn 6 đồng thời) mới xong, dễ gây cảm giác "đơ" trên máy
// yếu/mobile. runWithConcurrencyLimit() không còn cần dùng ở đây nữa.
$('#btnBulkApply').addEventListener('click', () => {
  const rows = bulkUpdateRows;
  if (!rows.length) { closeModal('bulkUpdateModal'); return; }

  const statusVal = $('#bulkStatusSelect').value;
  const noteVal = $('#bulkNoteText').value.trim();
  const mode = $('#bulkNoteMode').value; // 'append' | 'replace'
  // Yêu cầu #5: cho phép gán "Người thực hiện" hàng loạt (bỏ trống = giữ nguyên).
  const bulkAssigneeEl = $('#bulkAssigneeSelect');
  const assigneeVal = (bulkAssigneeEl && bulkAssigneeEl.value !== ASSIGNEE_ADD_NEW_VALUE) ? bulkAssigneeEl.value : '';
  if (!statusVal && !noteVal && !assigneeVal) { toast('Chưa nhập Trạng thái xe, Ghi chú hoặc Người thực hiện để cập nhật.', true); return; }

  const writeConnected = isWriteConnected();

  rows.forEach(r => {
    const newGhiChu = noteVal
      ? (mode === 'append' && r.ghiChu ? `${r.ghiChu}; ${noteVal}` : noteVal)
      : r.ghiChu;
    const updates = {};
    if (statusVal) { updates['Trạng thái xe'] = statusVal; r.trangThaiXe = statusVal; }
    if (noteVal) { updates['Ghi Chú'] = newGhiChu; r.ghiChu = newGhiChu; }
    if (assigneeVal) { updates['Người thực hiện'] = assigneeVal; r.nguoiThucHien = assigneeVal; }
    // Gộp ghi 1 lần cho toàn bộ lô (persist=false) — xem persistNotesStore() dưới.
    saveNoteFor(getEffectiveOwnerKey(r), { status: r.trangThaiXe, text: r.ghiChu }, false);
    // Chỉ đưa vào hàng đợi đồng bộ những dòng THỰC SỰ có thay đổi ghi lên Sheet.
    if (writeConnected && Object.keys(updates).length) enqueueRowSync(r, updates);
  });

  persistNotesStore();       // ghi ghi-chú-cục-bộ 1 lần duy nhất cho toàn bộ lô
  persistRawDataToCache();   // lưu IndexedDB 1 lần duy nhất cho toàn bộ lô

  bulkUpdateRows = [];
  renderTable();
  // Nếu panel chi tiết đang mở, vẽ lại để phản ánh đúng thay đổi (VD: cập nhật
  // hàng loạt vừa thực hiện từ Mục I của panel).
  if (currentDetailRow && !$('#detailOverlay').classList.contains('hidden')) {
    renderDetailPanelFor(currentDetailRow);
  }
  closeModal('bulkUpdateModal');
  toast(`Đã cập nhật ${rows.length} xe (lưu cục bộ ngay).` + (writeConnected ? ' Đang đồng bộ ngầm lên Google Sheet...' : ''));
});

/* ---------------------------- 8. GHI CHÚ / TRẠNG THÁI CỤC BỘ ---------------- */
// TỐI ƯU HIỆU NĂNG (mục "Cải thiện hiệu năng tải/lưu"): loadNotesStore() trước
// đây gọi JSON.parse() từ localStorage MỖI LẦN được gọi — hàm này được gọi rất
// nhiều lần trong 1 thao tác (mỗi dòng xe khi lưu ghi chú, mỗi lần mở panel chi
// tiết...), nên với dữ liệu lớn hoặc cập nhật hàng loạt nhiều xe, việc đọc lại +
// parse JSON liên tục gây chậm rõ rệt. Nay CACHE kết quả trong bộ nhớ (module-
// level), chỉ đọc từ localStorage 1 lần, và cập nhật cache mỗi khi lưu.
let _notesStoreCache = null;
function loadNotesStore() {
  if (_notesStoreCache) return _notesStoreCache;
  try { _notesStoreCache = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); }
  catch (e) { _notesStoreCache = {}; }
  return _notesStoreCache;
}
// `persist = false` cho phép gộp nhiều lần sửa (VD: cập nhật hàng loạt nhiều
// xe cùng lúc) thành ĐÚNG 1 LẦN ghi xuống localStorage ở cuối (persistNotesStore()),
// thay vì ghi ổ đĩa lặp lại cho từng xe một — giảm đáng kể thời gian xử lý khi
// cập nhật hàng loạt lúc chưa kết nối Apps Script (chế độ chỉ đọc / CSV).
function saveNoteFor(ownerKey, data, persist = true) {
  const store = loadNotesStore();
  store[ownerKey] = { ...data, updatedAt: new Date().toISOString() };
  if (persist) persistNotesStore();
}
function persistNotesStore() {
  localStorage.setItem(NOTES_KEY, JSON.stringify(_notesStoreCache || {}));
}

/* ---- 8a-2. Danh sách "Người thực hiện" (Yêu cầu #5) ----------------------- */
// Cùng lý do tối ưu như loadNotesStore(): hàm này được gọi cho MỖI DÒNG XE khi
// vẽ bảng (buildRowAssigneeSelectHtml) — với hàng trăm dòng/trang, đọc lại
// localStorage + JSON.parse cho từng dòng là lãng phí CPU không cần thiết.
// Cache lại trong bộ nhớ, chỉ tính lại khi danh sách thực sự thay đổi.
let _assigneeListCache = null;
function loadAssigneeList() {
  if (_assigneeListCache) return _assigneeListCache;
  try {
    const raw = JSON.parse(localStorage.getItem(ASSIGNEE_LIST_KEY) || 'null');
    _assigneeListCache = Array.isArray(raw) ? uniq([...DEFAULT_ASSIGNEES, ...raw]) : [...DEFAULT_ASSIGNEES];
  } catch (e) { _assigneeListCache = [...DEFAULT_ASSIGNEES]; }
  return _assigneeListCache;
}
function saveAssigneeList(list) {
  _assigneeListCache = uniq(list);
  localStorage.setItem(ASSIGNEE_LIST_KEY, JSON.stringify(_assigneeListCache));
}
// Thêm 1 người thực hiện mới vào danh sách (nếu chưa có) và lưu lại — để lần
// mở trang sau vẫn thấy người này trong danh sách chọn.
function addAssigneeToList(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const list = loadAssigneeList();
  if (!list.includes(clean)) { list.push(clean); saveAssigneeList(list); }
  return clean;
}

/* ---- 8a-3. Sinh HTML cho các ô nhập liệu TRÊN TỪNG DÒNG XE (Yêu cầu #2) ---
   Dùng chung cho cả bảng chính (trang chủ) và bảng mini trong panel Chi tiết
   chủ phương tiện. Mọi thay đổi được xử lý qua sự kiện "change" (không phải
   "input") để tránh vẽ lại bảng liên tục khi người dùng đang gõ dở.          */
function buildRowStatusSelectHtml(row) {
  const current = (row.trangThaiXe || '').trim();
  // Nếu giá trị hiện tại không nằm trong danh sách chuẩn (VD do nhập tay khác
  // trên Sheet), vẫn thêm nó vào option đầu để không làm mất dữ liệu hiện có.
  const options = STATUS_OPTIONS.includes(current) || !current ? STATUS_OPTIONS : [current, ...STATUS_OPTIONS];
  const optsHtml = [`<option value="">— Chưa cập nhật —</option>`]
    .concat(options.map(o => `<option value="${escapeHtml(o)}" ${o === current ? 'selected' : ''}>${escapeHtml(o)}</option>`))
    .join('');
  return `<select class="row-inline-select" data-role="row-status-select" data-rowid="${row._rowId}">${optsHtml}</select>`;
}
function buildRowNoteInputHtml(row) {
  return `<input type="text" class="row-inline-input" data-role="row-note-input" data-rowid="${row._rowId}" value="${escapeHtml(row.ghiChu)}" placeholder="Ghi chú...">`;
}
function buildRowAssigneeSelectHtml(row) {
  const current = (row.nguoiThucHien || '').trim();
  const list = loadAssigneeList();
  const optsHtml = [`<option value="">— Chưa gán —</option>`]
    .concat((list.includes(current) || !current ? list : [current, ...list])
      .map(a => `<option value="${escapeHtml(a)}" ${a === current ? 'selected' : ''}>${escapeHtml(a)}</option>`))
    .concat([`<option value="${ASSIGNEE_ADD_NEW_VALUE}">+ Thêm người mới...</option>`])
    .join('');
  return `<select class="row-inline-select" data-role="row-assignee-select" data-rowid="${row._rowId}">${optsHtml}</select>`;
}

// Ghi 1 hoặc nhiều trường của MỘT dòng xe cụ thể (Trạng thái xe / Ghi Chú /
// Người thực hiện...) — dùng chung cho ô nhập trên từng dòng (bảng chính +
// bảng mini trong panel chi tiết) và mục "Cập nhật... cho riêng xe này".
// `fieldUpdates` dạng { trangThaiXe: '...', ghiChu: '...', nguoiThucHien: '...' }.
// LOCAL-FIRST: áp dụng thay đổi NGAY vào bộ nhớ + lưu xuống IndexedDB TRƯỚC,
// rồi mới đẩy việc ghi lên Google Sheet vào hàng đợi đồng bộ NGẦM phía sau —
// không await mạng, không chặn thao tác tiếp theo của người dùng (Yêu cầu #2).
// Vẫn giữ kiểu `async function` (trả về Promise) để KHÔNG phải sửa các nơi
// đang gọi `await updateSingleRowFields(...)` — hàm chỉ đơn giản resolve ngay.
async function updateSingleRowFields(row, fieldUpdates) {
  const updatesByHeader = {};
  Object.keys(fieldUpdates).forEach(key => {
    const f = FIELD_MAP.find(f => f.key === key);
    if (f) updatesByHeader[f.header] = fieldUpdates[key];
  });

  // 1) Cập nhật ngay trong bộ nhớ (áp dụng cả khi đang ở chế độ chỉ đọc CSV).
  Object.assign(row, fieldUpdates);
  // 2) Lưu ngay xuống IndexedDB (debounce nhẹ bên trong) — không mất dữ liệu
  //    nếu đóng trình duyệt/mất mạng ngay sau khi vừa nhập.
  persistRawDataToCache();
  // 3) Lưu ghi chú cục bộ (localStorage) — dùng cho các đối chiếu chủ xe khác.
  saveNoteFor(getEffectiveOwnerKey(row), { status: row.trangThaiXe, text: row.ghiChu });
  // 4) Đồng bộ NGẦM lên Google Sheet nếu đang kết nối 2 chiều — fire-and-forget,
  //    có hàng đợi lưu bền + tự thử lại (xem enqueueSync/processSyncQueue).
  if (isWriteConnected()) enqueueRowSync(row, updatesByHeader);
  return true;
}

/* ---- 8b. "Xác nhận xe đúng" (Mục III -> Mục I) --------------------------- */
// map: { [vehicleKey]: { ownerCccd, ownerName, confirmedAt } }
// TỐI ƯU HIỆU NĂNG QUAN TRỌNG NHẤT trong ứng dụng: loadConfirmedOwnerMap() được
// gọi BÊN TRONG getEffectiveOwnerKey(), mà getEffectiveOwnerKey() lại được gọi
// cho TỪNG DÒNG dữ liệu ở nhiều nơi nóng (hot path) — đặc biệt là bên trong
// compareBySortCriteria() (chạy trong hàm so sánh của Array.sort(), tức là
// O(n log n) lần gọi mỗi khi vẽ lại bảng!) và trong getFiltered() khi bật lọc
// "nhiều xe". Trước đây mỗi lần gọi đều đọc lại localStorage + JSON.parse ->
// với vài nghìn dòng dữ liệu, việc này lặp lại hàng chục nghìn lần mỗi lần
// thao tác, gây "đơ" rõ rệt khi lọc/sắp xếp/cập nhật nhiều xe cùng lúc.
// Nay CACHE kết quả trong bộ nhớ, chỉ đọc 1 lần và cập nhật cache ngay khi lưu.
let _confirmedOwnerMapCache = null;
function loadConfirmedOwnerMap() {
  if (_confirmedOwnerMapCache) return _confirmedOwnerMapCache;
  try { _confirmedOwnerMapCache = JSON.parse(localStorage.getItem(CONFIRMED_OWNER_KEY) || '{}'); }
  catch (e) { _confirmedOwnerMapCache = {}; }
  return _confirmedOwnerMapCache;
}
function saveConfirmedOwnerMap(map) {
  _confirmedOwnerMapCache = map;
  localStorage.setItem(CONFIRMED_OWNER_KEY, JSON.stringify(map));
}

// Đánh dấu `vehicleRow` là thuộc về `ownerRow` (theo Số CCCD), tự thêm ghi chú
// (giữ nguyên ghi chú cũ nếu có) và ghi ngược về Sheet nếu đang kết nối 2 chiều.
// KHÔNG đổi Số CCCD/MST gốc của vehicleRow — chỉ đánh dấu qua bảng ánh xạ riêng,
// nên khi xem chi tiết trực tiếp xe này hoặc in Bản cam kết, xe vẫn hiển thị
// đúng thông tin gốc như trước.
// LOCAL-FIRST: xác nhận + cập nhật Ghi Chú ngay trong bộ nhớ/IndexedDB, đồng
// bộ Sheet ở hàng đợi ngầm (không await mạng, không còn cần try/catch báo lỗi
// ngay tại đây — lỗi mạng sẽ tự được xử lý/thử lại bởi hàng đợi đồng bộ).
async function confirmVehicleOwner(vehicleRow, ownerRow) {
  const map = loadConfirmedOwnerMap();
  map[vehicleKey(vehicleRow)] = {
    ownerCccd: ownerRow.cccd, ownerName: ownerRow.chuXe, confirmedAt: new Date().toISOString()
  };
  saveConfirmedOwnerMap(map);

  const noteAddition = `Đã xác nhận thuộc về ${ownerRow.chuXe}${ownerRow.cccd ? ' - CCCD ' + ownerRow.cccd : ''}`;
  const oldNote = (vehicleRow.ghiChu || '').trim();
  const newNote = (!oldNote || !oldNote.includes(noteAddition)) ? (oldNote ? `${oldNote}; ${noteAddition}` : noteAddition) : oldNote;
  vehicleRow.ghiChu = newNote;
  persistRawDataToCache();

  if (isWriteConnected()) enqueueRowSync(vehicleRow, { 'Ghi Chú': newNote });
  // Xe vừa được xác nhận sẽ được tính vào đúng nhóm chủ xe mới -> tính lại số
  // lượng xe/chủ xe để bộ lọc "nhiều xe" và cột sắp xếp "Số lượng xe" cập nhật đúng.
  computeOwnerVehicleCounts();
  renderTable();
}

/* ---------------------------- 9. FUZZY MATCHING (4 MỤC) -------------------- */
const NUMBER_FUZZY_MAX_DIST = 2;
// Bỏ qua số khung/số máy quá ngắn khi so khớp gần đúng, để tránh việc các
// chuỗi ngắn (VD "50", "Q12"...) tình cờ giống nhau khắp cả nghìn dòng dữ liệu.
const NUMBER_FUZZY_MIN_LEN = 5;

function vehicleKey(v) { return v.motoId || v.maId || v._rowId; }

// "CCCD hiệu lực" của 1 xe dùng để GOM NHÓM theo đúng chủ xe thật sự: nếu xe
// đã được người dùng bấm "Xác nhận xe đúng" (ở Mục II/III) để gán về một chủ
// xe khác, dùng đúng Số CCCD của chủ xe đó; ngược lại dùng Số CCCD/tên gốc ghi
// trên chính dòng dữ liệu. Dùng chung cho: gộp Bản cam kết, đếm số xe/chủ xe,
// và lọc "gia đình có nhiều xe".
function getEffectiveOwnerKey(row) {
  const confirmedMap = loadConfirmedOwnerMap();
  const confirmed = confirmedMap[vehicleKey(row)];
  if (confirmed && confirmed.ownerCccd) return confirmed.ownerCccd;
  return row.cccd || ('name:' + normalizeName(row.chuXe));
}

// Tính lại số lượng xe theo từng chủ xe (dùng getEffectiveOwnerKey) — gọi lại
// mỗi khi dữ liệu được tải mới hoặc có xe vừa được "Xác nhận xe đúng".
function computeOwnerVehicleCounts() {
  const map = new Map();
  state.rawData.forEach(row => {
    const key = getEffectiveOwnerKey(row);
    map.set(key, (map.get(key) || 0) + 1);
  });
  state.ownerVehicleCounts = map;
}

// Tách 1 họ tên (đã chuẩn hoá) thành: họ (từ đầu), tên (từ cuối), chữ lót (ở giữa).
function splitNameParts(name) {
  const norm = normalizeName(name);
  if (!norm) return null;
  const words = norm.split(' ').filter(Boolean);
  if (!words.length) return null;
  return {
    ho: words[0],
    ten: words[words.length - 1],
    dem: words.slice(1, -1).join(' '),
    words
  };
}

// Mục III chỉ chấp nhận ĐÚNG 1 trong 3 trường hợp sau (không match rộng hơn):
//  a) Chỉ sai dấu trên toàn bộ họ tên (VD: Nguyễn -> Nguyen, Thành -> Thanh).
//  b) Chỉ sai/khác chữ lót (tên đệm) — họ và tên chính phải giống hệt nhau.
//  c) Chỉ sai họ — chữ lót và tên chính phải giống hệt nhau.
function isFuzzyNameMatch(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const normA = normalizeName(nameA), normB = normalizeName(nameB);
  if (!normA || !normB || normA === normB) return false; // trùng hệt -> thuộc Mục II

  // a) Chỉ sai dấu.
  const stripA = stripDiacritics(nameA), stripB = stripDiacritics(nameB);
  if (stripA && stripB && stripA === stripB) return true;

  const partsA = splitNameParts(nameA), partsB = splitNameParts(nameB);
  if (!partsA || !partsB || partsA.words.length < 2 || partsB.words.length < 2) return false;

  // b) Chỉ sai chữ lót: họ giống hệt + tên chính giống hệt, chữ lót khác nhau.
  if (partsA.ho === partsB.ho && partsA.ten === partsB.ten && partsA.dem !== partsB.dem) return true;

  // c) Chỉ sai họ: chữ lót + tên chính giống hệt nhau, chỉ khác họ.
  const restA = partsA.words.slice(1).join(' ');
  const restB = partsB.words.slice(1).join(' ');
  if (partsA.ho !== partsB.ho && restA === restB) return true;

  return false;
}

// Mục IV: Số khung/Số máy chỉ được coi là "gần đúng" khi sai hoặc thiếu tối đa
// 1–2 ký tự (Levenshtein distance <= 2), các ký tự còn lại phải giống hệt, và
// chuỗi phải đủ dài để so khớp có ý nghĩa (tránh trùng ngẫu nhiên hàng loạt).
function isFuzzyNumberMatch(numA, numB) {
  if (!numA || !numB) return false;
  if (numA.length < NUMBER_FUZZY_MIN_LEN || numB.length < NUMBER_FUZZY_MIN_LEN) return false;
  if (Math.abs(numA.length - numB.length) > NUMBER_FUZZY_MAX_DIST) return false;
  const d = levenshtein(numA, numB);
  return d > 0 && d <= NUMBER_FUZZY_MAX_DIST;
}

// Tính 5 mục đối chiếu cho một chủ xe, dựa trên xe hiện đang xem (`vehicle`).
//  I   - Xe cùng Số CCCD (+ xe đã được "Xác nhận xe đúng" thuộc về người này).
//  II  - Xe của người trùng họ tên, khác Số CCCD (có thể "Xác nhận đúng").
//  III - Xe của người có họ tên gần đúng (chưa xác nhận).
//  IV  - Xe của người cùng gia đình (theo cột Y).
//  V   - Xe có Số khung/Số máy gần đúng (trước đây là Mục IV).
function computeOwnerSections(vehicle) {
  const all = state.rawData;
  const cccd = (vehicle.cccd || '').trim();
  const nameNorm = normalizeName(vehicle.chuXe);
  const confirmedMap = loadConfirmedOwnerMap();

  // Mục I: tất cả xe cùng Số CCCD, CỘNG THÊM các xe đã được xác nhận (từ Mục II
  // hoặc Mục III) là thuộc về đúng người có Số CCCD này — dù Số CCCD gốc trên
  // dòng đó khác.
  const sectionI = cccd
    ? all.filter(v => (v.cccd || '').trim() === cccd || (confirmedMap[vehicleKey(v)] || {}).ownerCccd === cccd)
    : [vehicle];

  // Mục II: xe của người trùng họ tên chính xác nhưng khác Số CCCD — loại trừ
  // xe đã thuộc Mục I (kể cả xe vừa được "Xác nhận đúng" chuyển lên đó), và
  // loại trừ xe ĐÃ được xác nhận thuộc về người khác (đã có kết luận rồi).
  const sectionIKeys = new Set(sectionI.map(vehicleKey));
  const sectionII = nameNorm
    ? all.filter(v => {
        if (sectionIKeys.has(vehicleKey(v))) return false;
        if (confirmedMap[vehicleKey(v)]) return false;
        return normalizeName(v.chuXe) === nameNorm && (v.cccd || '').trim() !== cccd;
      })
    : [];

  // Mục III: chỉ những trường hợp sai dấu / sai chữ lót / sai họ (xem isFuzzyNameMatch),
  // loại trừ những xe đã thuộc Mục I hoặc Mục II, và loại trừ xe ĐÃ được xác nhận
  // (dù xác nhận cho chính người này hay cho người khác) vì đã có kết luận rồi.
  const usedAfterII = new Set([...sectionI, ...sectionII].map(vehicleKey));
  const sectionIII = vehicle.chuXe ? all.filter(v => {
    if (usedAfterII.has(vehicleKey(v))) return false;
    if (confirmedMap[vehicleKey(v)]) return false;
    return isFuzzyNameMatch(vehicle.chuXe, v.chuXe);
  }) : [];

  // Mục IV: xe của người CÙNG GIA ĐÌNH — lấy từ cột Y, dạng
  // "Cùng gia đình với: <CCCD>|<CCCD>...". Liệt kê mọi dòng mà cột Y của
  // CHÍNH dòng đó có chứa đúng Số CCCD của người đang xem.
  const usedAfterIII = new Set([...sectionI, ...sectionII, ...sectionIII].map(vehicleKey));
  const sectionIV = cccd ? all.filter(v => {
    if (usedAfterIII.has(vehicleKey(v))) return false;
    return parseFamilyIds(v.giaDinh).includes(cccd);
  }) : [];

  // Mục V (trước đây là Mục IV): xe có Số khung hoặc Số máy gần đúng (sai/thiếu
  // tối đa 2 ký tự) với các xe trong danh sách (Mục I) của người này, loại trừ
  // Mục I–IV.
  const usedAfterIV = new Set([...sectionI, ...sectionII, ...sectionIII, ...sectionIV].map(vehicleKey));
  const ownNumbers = uniq(sectionI.flatMap(v => [
    (v.soKhung || '').trim().toUpperCase(),
    (v.soMay || '').trim().toUpperCase()
  ])).filter(n => n.length >= NUMBER_FUZZY_MIN_LEN);
  const sectionV = ownNumbers.length ? all.filter(v => {
    if (usedAfterIV.has(vehicleKey(v))) return false;
    const sk = (v.soKhung || '').trim().toUpperCase();
    const sm = (v.soMay || '').trim().toUpperCase();
    return ownNumbers.some(own => isFuzzyNumberMatch(sk, own) || isFuzzyNumberMatch(sm, own));
  }) : [];

  return { sectionI, sectionII, sectionIII, sectionIV, sectionV };
}

/* ---------------------------- 10. PANEL CHI TIẾT CHỦ XE --------------------- */
// "Chủ xe đang được xem" trong panel — dùng chung cho 2 nút Lưu ở chân trang
// dính cố định (#detailStickyFooter), vì 2 nút đó nằm NGOÀI #detailBody nên
// KHÔNG được vẽ lại mỗi lần renderDetailPanelFor() chạy (đây chính là điểm
// mấu chốt giúp chúng luôn hiện rõ, không bị khuất). Do đó không thể dùng
// closure bắt biến `row` như cũ — phải đọc "chủ xe hiện tại" qua biến này.
let currentDetailRow = null;

// Yêu cầu (thanh trượt ngang dính cố định): đồng bộ MỘT thanh trượt ngang dùng
// chung cho TẤT CẢ bảng mini (Mục I-V) đang hiển thị trong panel — kéo 1 lần
// là mọi bảng cùng cuộn theo (rất tiện vì các bảng dùng chung phần lớn cột).
// Gắn lại mỗi lần renderDetailPanelFor() vẽ lại nội dung panel.
function setupDetailHScrollSync() {
  const track = $('#detailHScrollTrack');
  const range = $('#detailHScrollRange');
  if (!track || !range) return;
  const wraps = $all('#detailBody .mini-table-wrap');
  const maxScroll = wraps.length
    ? Math.max(0, ...wraps.map(w => w.scrollWidth - w.clientWidth))
    : 0;
  if (maxScroll <= 2) { track.classList.add('hidden'); return; }
  track.classList.remove('hidden');
  range.max = String(maxScroll);
  range.value = String(wraps[0].scrollLeft || 0);

  let syncing = false;
  range.oninput = () => {
    if (syncing) return;
    syncing = true;
    const v = Number(range.value);
    wraps.forEach(w => { w.scrollLeft = Math.min(v, w.scrollWidth - w.clientWidth); });
    syncing = false;
  };
  wraps.forEach(w => {
    w.onscroll = () => {
      if (syncing) return;
      syncing = true;
      range.value = String(w.scrollLeft);
      wraps.forEach(w2 => { if (w2 !== w) w2.scrollLeft = w.scrollLeft; });
      syncing = false;
    };
  });
}

// 2 nút "Lưu tạm / Lưu về Google Sheet" nằm cố định ở #detailStickyFooter —
// chỉ gắn sự kiện MỘT LẦN DUY NHẤT (không nằm trong renderDetailPanelFor),
// luôn thao tác trên `currentDetailRow` (chủ xe đang xem tại thời điểm bấm).
(function setupDetailSaveButtons() {
  const btnLocal = $('#btnSaveNoteLocal');
  const btnSheet = $('#btnSaveNoteSheet');
  if (!btnLocal || !btnSheet) return;

  const doSaveLocal = (row) => {
    saveNoteFor(getEffectiveOwnerKey(row), {
      status: $('#noteStatusSelect').value || row.trangThaiXe,
      text: $('#noteTextArea').value
    });
    toast('Đã lưu ghi chú tạm trên trình duyệt.');
  };

  btnLocal.addEventListener('click', () => {
    const row = currentDetailRow;
    if (!row) return;
    const assigneeVal = $('#noteAssigneeSelect') ? $('#noteAssigneeSelect').value : '';
    row.ghiChu = $('#noteTextArea').value;
    const statusVal = $('#noteStatusSelect').value;
    if (statusVal) row.trangThaiXe = statusVal;
    if (assigneeVal && assigneeVal !== ASSIGNEE_ADD_NEW_VALUE) row.nguoiThucHien = assigneeVal;
    doSaveLocal(row);
    renderTable();
  });

  // LOCAL-FIRST: nút này giờ chỉ khác nút "Lưu tạm" ở chỗ CÓ đẩy thêm việc ghi
  // lên Google Sheet vào hàng đợi đồng bộ ngầm — vẫn lưu local + IndexedDB
  // ngay lập tức, không chờ mạng, và có tự thử lại nếu lỗi/mất mạng (không
  // còn báo lỗi một lần rồi thôi như trước).
  btnSheet.addEventListener('click', () => {
    const row = currentDetailRow;
    if (!row) return;
    const updates = { 'Ghi Chú': $('#noteTextArea').value };
    const statusVal = $('#noteStatusSelect').value;
    const assigneeVal = $('#noteAssigneeSelect') ? $('#noteAssigneeSelect').value : '';
    if (statusVal) updates['Trạng thái xe'] = statusVal;
    if (assigneeVal && assigneeVal !== ASSIGNEE_ADD_NEW_VALUE) updates['Người thực hiện'] = assigneeVal;

    row.ghiChu = updates['Ghi Chú'];
    if (statusVal) row.trangThaiXe = statusVal;
    if (updates['Người thực hiện']) row.nguoiThucHien = updates['Người thực hiện'];
    persistRawDataToCache();
    doSaveLocal(row);
    renderTable();

    if (isWriteConnected()) {
      enqueueRowSync(row, updates);
      toast('Đã lưu cục bộ — đang đồng bộ ngầm lên Google Sheet...');
    } else {
      toast('Đã lưu cục bộ (chưa kết nối chế độ 2 chiều nên chưa đồng bộ Sheet).');
    }
  });
})();

function openDetailPanel(rowId) {
  const row = state.rawData.find(r => r._rowId === rowId);
  if (!row) return;
  renderDetailPanelFor(row);
  openModal('detailOverlay');
}

function renderDetailPanelFor(row) {
  const cccd = row.cccd;
  const chuXe = row.chuXe;
  // Yêu cầu #3: dùng đúng "CCCD hiệu lực" (getEffectiveOwnerKey) của xe ĐANG
  // ĐƯỢC XEM trong panel này làm khóa lưu ghi chú/trạng thái — để khi xe đã
  // được "Xác nhận xe đúng" thuộc về một chủ khác, việc "cập nhật cho riêng xe
  // này" vẫn gắn đúng vào chủ xe (theo số định danh) đang hiển thị, không bị
  // lưu nhầm theo Số CCCD/tên gốc còn ghi trên chính dòng dữ liệu đó.
  const ownerKey = getEffectiveOwnerKey(row);

  const { sectionI, sectionII, sectionIII, sectionIV, sectionV } = computeOwnerSections(row);
  const phones = uniq(sectionI.map(r => r.soDienThoai)).join(' | ') || '—';
  const addr = uniq(sectionI.map(r => r.diaChi)).join(' | ') || '—';

  const notesStore = loadNotesStore();
  const existingNote = notesStore[ownerKey] || { status: '', text: '' };

  // Yêu cầu #1 + #2: bảng mini cũng cần cố định cột Biển số/Chủ xe khi kéo
  // ngang, và có ô Ghi chú / chọn Trạng thái / chọn Người thực hiện ngay trên
  // từng dòng — bọc trong .mini-table-wrap để có thanh trượt ngang riêng.
  const miniTable = (rows, sectionId, extraCols, extraCellsFn, cssClass) => rows.length ? `
    <div class="mini-table-wrap">
    <table class="mini-table" data-section="${sectionId}">
      <thead><tr>
        <th class="col-chk-mini"></th>
        <th class="mini-sticky-col mini-sticky-bienso">Biển số</th>
        <th class="mini-sticky-col mini-sticky-chuxe">Chủ xe</th>
        <th>Số CCCD</th><th>Số khung</th><th>Số máy</th>
        <th>Loại xe</th><th>Trạng thái</th><th>Ghi chú</th><th>Người thực hiện</th>${extraCols || ''}
      </tr></thead>
      <tbody>
        ${rows.map(r => `<tr data-rowid="${r._rowId}" class="${cssClass || ''}">
          <td class="col-chk-mini"><input type="checkbox" data-role="mini-chk" data-rowid="${r._rowId}" ${state.exportSelected.has(r._rowId) ? 'checked' : ''}></td>
          <td class="mini-sticky-col mini-sticky-bienso">${escapeHtml(r.bienSo)}</td>
          <td class="mini-sticky-col mini-sticky-chuxe">${escapeHtml(r.chuXe)}</td>
          <td>${escapeHtml(r.cccd) || '—'}</td>
          <td>${escapeHtml(r.soKhung)}</td><td>${escapeHtml(r.soMay)}</td>
          <td>${escapeHtml(r.loaiXe)}</td>
          <td>${buildRowStatusSelectHtml(r)}</td>
          <td>${buildRowNoteInputHtml(r)}</td>
          <td>${buildRowAssigneeSelectHtml(r)}</td>
          ${extraCellsFn ? extraCellsFn(r) : ''}
        </tr>`).join('')}
      </tbody>
    </table>
    </div>` : `<p class="hint">Không tìm thấy trường hợp phù hợp.</p>`;

  const selectAllBtn = (sectionId, rows) => rows.length
    ? `<button type="button" class="btn btn-ghost btn-sm" style="margin-left:8px;" data-select-all="${sectionId}">☑️ Chọn tất cả (${rows.length})</button>`
    : '';

  // Yêu cầu (bố trí lại nút "Cập nhật hàng loạt (Mục I đã chọn)"): nút này cần
  // nằm CÙNG HÀNG với tiêu đề Mục I và nút "☑️ Chọn tất cả", nên được truyền vào
  // sectionBlock() qua tham số `titleExtra` — chỉ hiển thị khi Mục I có ít nhất
  // 1 xe (tương tự điều kiện của nút "Chọn tất cả").
  const bulkUpdateSectionIBtn = sectionI.length
    ? `<button type="button" id="btnBulkUpdateSectionI" class="btn btn-secondary btn-sm" style="margin-left:8px;" title="Tích chọn (checkbox) các xe cần cập nhật trong Mục I bên dưới, rồi bấm nút này">🔄 Cập nhật hàng loạt (Mục I đã chọn)</button>`
    : '';

  // Yêu cầu #5: ẩn hoàn toàn các mục II, III, IV, V khi không có dữ liệu (không
  // tiêu đề, không khoảng trống thừa). Mục I luôn hiển thị (ít nhất là chính xe
  // đang xem), nên không cần ẩn.
  const sectionBlock = ({ id, title, desc, rows, extraCols, extraCellsFn, cssClass, hideIfEmpty, titleExtra }) => {
    if (hideIfEmpty && !rows.length) return '';
    return `
    <div class="section-title">${title} <span class="tag-count">${rows.length}</span>${selectAllBtn(id, rows)}${titleExtra || ''}</div>
    ${desc ? `<div class="section-desc">${desc}</div>` : ''}
    ${miniTable(rows, id, extraCols, extraCellsFn, cssClass)}`;
  };

  // Mục II và III: mỗi dòng có thêm nút "Xác nhận xe đúng" để chuyển xe đó lên
  // Mục I của người đang xem. Chỉ khả dụng khi người đang xem đã có Số CCCD.
  const confirmCol = cccd
    ? (r) => `<td><button type="button" class="btn btn-ghost btn-sm" data-confirm-owner="${r._rowId}" title="Xác nhận xe này thuộc về ${escapeHtml(chuXe)}">✅ Xác nhận đúng</button></td>`
    : (r) => `<td><span class="hint" style="margin:0;">Cần CCCD để xác nhận</span></td>`;

  const bodyHtml = `
    <div class="owner-card">
      <div class="row"><b>Họ và tên:</b> ${escapeHtml(chuXe) || '—'}</div>
      <div class="row"><b>Số CCCD/MST:</b> ${escapeHtml(cccd) || '—'}</div>
      <div class="row"><b>Địa chỉ:</b> ${escapeHtml(addr)}</div>
      <div class="row phone-edit-row">
        <b>Số điện thoại:</b>
        <input type="text" id="ownerPhoneInput" class="tpl-input" value="${escapeHtml(phones === '—' ? '' : phones)}" placeholder="Nhập SĐT, phân cách bằng dấu phẩy nếu có nhiều số">
        <button type="button" id="btnSavePhone" class="btn btn-ghost btn-sm">💾 Lưu SĐT</button>
      </div>
      <div class="owner-card-actions">
        <button type="button" id="btnCreateCommitmentPanel" class="btn btn-primary btn-sm">
          📄 Tạo Bản cam kết (${state.exportSelected.size} xe đã chọn)
        </button>
        <button type="button" id="btnDeselectAllPanel" class="btn btn-ghost btn-sm" ${state.exportSelected.size ? '' : 'disabled'} title="Bỏ chọn tất cả xe đang chọn (mọi trang / mọi bộ lọc)">
          🗑️ Bỏ chọn tất cả
        </button>
      </div>
    </div>

    ${sectionBlock({
      id: 'I', title: 'I. Xe cùng Số CCCD (xe chính thức)', rows: sectionI, hideIfEmpty: false,
      titleExtra: bulkUpdateSectionIBtn,
      desc: sectionI.length
        ? 'Tích chọn (checkbox) các xe cần cập nhật ở bảng dưới, rồi bấm "🔄 Cập nhật hàng loạt (Mục I đã chọn)" ở trên để cập nhật Trạng thái xe / Người thực hiện cùng lúc cho các xe đã chọn trong Mục I.'
        : undefined
    })}

    ${sectionBlock({
      id: 'II', title: 'II. Xe của người trùng họ tên, khác Số CCCD',
      desc: `Có thể là cùng một người kê khai CCCD khác nhau, hoặc trùng tên ngẫu nhiên — cần đối chiếu thêm. Bấm "Xác nhận đúng" nếu chắc chắn đây là cùng một người với "${escapeHtml(chuXe)}" — xe sẽ được chuyển lên Mục I.`,
      rows: sectionII, extraCols: '<th>Địa chỉ đăng ký</th><th>Xác nhận</th>',
      extraCellsFn: (r) => `<td>${escapeHtml(r.diaChi) || '—'}</td>${confirmCol(r)}`,
      cssClass: 'diff-cccd', hideIfEmpty: true
    })}

    ${sectionBlock({
      id: 'III', title: 'III. Xe của người có họ tên gần đúng',
      desc: `Chỉ hiện các trường hợp: sai dấu (VD: Nguyễn → Nguyen), hoặc chỉ sai chữ lót, hoặc chỉ sai họ (còn chữ lót + tên chính giống hệt "${escapeHtml(chuXe)}"). Bấm "Xác nhận đúng" nếu chắc chắn đây là cùng một người — xe sẽ được chuyển lên Mục I.`,
      rows: sectionIII, extraCols: '<th>Địa chỉ đăng ký</th><th>Xác nhận</th>',
      extraCellsFn: (r) => `<td>${escapeHtml(r.diaChi) || '—'}</td>${confirmCol(r)}`,
      cssClass: 'fuzzy-name', hideIfEmpty: true
    })}

    ${sectionBlock({
      id: 'IV', title: 'IV. Xe của người cùng gia đình',
      desc: 'Lấy từ cột quan hệ gia đình (cột Y): liệt kê các xe có ghi "Cùng gia đình với" chứa đúng Số CCCD của người đang xem.',
      rows: sectionIV, cssClass: 'fuzzy-name', hideIfEmpty: true
    })}

    ${sectionBlock({
      id: 'V', title: 'V. Xe có Số khung/Số máy gần đúng với xe của người này',
      desc: `Số khung/số máy sai hoặc thiếu tối đa ${NUMBER_FUZZY_MAX_DIST} ký tự so với các xe ở Mục I (các ký tự còn lại phải giống hệt) — nghi ngờ nhập liệu sai hoặc trùng khung/máy.`,
      rows: sectionV, cssClass: 'fuzzy-number', hideIfEmpty: true
    })}

    <div class="section-title">Cập nhật Trạng thái xe / Ghi chú (cho riêng xe này)</div>
    <div class="section-desc">Muốn cập nhật cùng lúc nhiều xe? Chọn checkbox các xe cần cập nhật ở bảng chính rồi bấm nút "🔄 Cập nhật hàng loạt" trên thanh công cụ.</div>
    <div class="note-box">
      <select id="noteStatusSelect">
        <option value="">— Giữ nguyên trạng thái hiện tại —</option>
        <option value="Còn sử dụng">Còn sử dụng</option>
        <option value="Đã bán/chuyển nhượng">Đã bán/chuyển nhượng</option>
        <option value="Đã liên hệ">Đã liên hệ</option>
        <option value="Đã xác minh">Đã xác minh</option>
        <option value="Đã ký cam kết">Đã ký cam kết</option>
        <option value="Chưa liên hệ được">Chưa liên hệ được</option>
        <option value="Cần xác minh thêm">Cần xác minh thêm</option>
      </select>
      <textarea id="noteTextArea" placeholder="Ghi chú thêm...">${escapeHtml(row.ghiChu || existingNote.text || '')}</textarea>
      <label class="hint-label">Người thực hiện</label>
      ${buildRowAssigneeSelectHtml(row).replace('class="row-inline-select"', 'class="row-inline-select" id="noteAssigneeSelect"')}
    </div>
  `;
  $('#detailBody').innerHTML = bodyHtml;
  $('#noteStatusSelect').value = '';

  // Yêu cầu (thanh trượt ngang + nút Lưu dính cố định): 2 nút Lưu và thanh
  // trượt ngang nằm ở #detailStickyFooter — NGOÀI #detailBody nên không bị vẽ
  // lại/mất mỗi lần renderDetailPanelFor() chạy. Ở đây chỉ cần cập nhật lại
  // "chủ xe đang xem hiện tại" + trạng thái nút/ghi chú đồng bộ cho đúng.
  currentDetailRow = row;
  const btnSheetEl = $('#btnSaveNoteSheet');
  if (btnSheetEl) {
    btnSheetEl.disabled = state.mode !== 'gas';
    btnSheetEl.title = state.mode !== 'gas' ? 'Cần kết nối chế độ Apps Script (2 chiều)' : '';
  }
  const syncNoteEl = $('#detailSyncNote');
  if (syncNoteEl) {
    syncNoteEl.textContent = state.mode === 'gas'
      ? 'Đã kết nối 2 chiều — có thể ghi trực tiếp về Sheet.'
      : 'Đang ở chế độ chỉ đọc (CSV) — chỉ lưu tạm trên trình duyệt này. Kết nối Apps Script để ghi về Sheet.';
  }
  setupDetailHScrollSync();

  // Yêu cầu #4: cho phép sửa số điện thoại hiện có / thêm số điện thoại mới.
  // Áp dụng cho đúng xe đang xem (`row`) — nếu chủ xe có nhiều xe với SĐT khác
  // nhau, mở panel đúng xe cần sửa rồi lưu ở đây.
  const btnSavePhone = $('#btnSavePhone');
  if (btnSavePhone) {
    btnSavePhone.addEventListener('click', async () => {
      const val = $('#ownerPhoneInput').value.trim();
      btnSavePhone.disabled = true; btnSavePhone.textContent = 'Đang lưu...';
      await updateSingleRowFields(row, { soDienThoai: val });
      btnSavePhone.disabled = false; btnSavePhone.textContent = '💾 Lưu SĐT';
      renderTable();
      renderDetailPanelFor(row);
      toast('Đã lưu số điện thoại.');
    });
  }

  // Yêu cầu #5: chọn "+ Thêm người mới..." trong select Người thực hiện của
  // mục "Cập nhật cho riêng xe này" -> hỏi tên, thêm vào danh sách, chọn luôn.
  const noteAssigneeSelect = $('#noteAssigneeSelect');
  if (noteAssigneeSelect) {
    noteAssigneeSelect.addEventListener('change', () => {
      if (noteAssigneeSelect.value !== ASSIGNEE_ADD_NEW_VALUE) return;
      const name = window.prompt('Nhập tên Người thực hiện mới:');
      const added = addAssigneeToList(name);
      if (added) {
        renderDetailPanelFor(row);
        // renderDetailPanelFor vẽ lại toàn bộ panel -> chọn sẵn người vừa thêm.
        const sel = $('#noteAssigneeSelect');
        if (sel) sel.value = added;
      } else {
        noteAssigneeSelect.value = '';
      }
    });
  }

  // Click vào 1 dòng trong mục I-IV => chuyển panel sang xem chi tiết của xe đó.
  $('#detailBody').querySelectorAll('.mini-table tbody tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="mini-chk"]')) return;
      // Yêu cầu #2: không chuyển panel khi bấm vào ô nhập Ghi chú / chọn
      // Trạng thái / chọn Người thực hiện ngay trên dòng của bảng mini.
      if (e.target.closest('[data-role="row-status-select"], [data-role="row-note-input"], [data-role="row-assignee-select"], [data-confirm-owner]')) return;
      // Yêu cầu (bôi đen để copy thông tin dòng xe): tương tự bảng chính,
      // không chuyển panel nếu đây là thao tác kéo chuột chọn chữ / đang có
      // vùng bôi đen — xem isTextSelectOrDragClick().
      if (isTextSelectOrDragClick(e)) return;
      const targetRow = state.rawData.find(r => r._rowId === tr.dataset.rowid);
      if (targetRow) renderDetailPanelFor(targetRow);
    });
  });
  // Yêu cầu #2: xử lý thay đổi Trạng thái / Ghi chú / Người thực hiện nhập
  // trực tiếp trên từng dòng trong các bảng mini (Mục I-V) của panel chi tiết.
  // LƯU Ý: chỉ chọn phần tử NẰM TRONG .mini-table — tránh khớp nhầm vào ô
  // "Người thực hiện" của khối "Cập nhật cho riêng xe này" bên dưới (khối đó
  // dùng chung hàm buildRowAssigneeSelectHtml() nên có cùng data-role, nhưng
  // được lưu qua nút "Lưu tạm/Lưu Google Sheet" riêng, không nên lưu ngay khi
  // vừa chọn).
  $('#detailBody').querySelectorAll('.mini-table [data-role="row-status-select"], .mini-table [data-role="row-note-input"], .mini-table [data-role="row-assignee-select"]').forEach(el => {
    el.addEventListener('change', async (e) => {
      e.stopPropagation();
      const target = e.target;
      const targetRow = state.rawData.find(r => r._rowId === target.dataset.rowid);
      if (!targetRow) return;
      const role = target.dataset.role;
      if (role === 'row-status-select') {
        await updateSingleRowFields(targetRow, { trangThaiXe: target.value });
      } else if (role === 'row-note-input') {
        await updateSingleRowFields(targetRow, { ghiChu: target.value });
      } else if (role === 'row-assignee-select') {
        let value = target.value;
        if (value === ASSIGNEE_ADD_NEW_VALUE) {
          const name = window.prompt('Nhập tên Người thực hiện mới:');
          const added = addAssigneeToList(name);
          if (!added) { renderDetailPanelFor(row); return; }
          value = added;
        }
        await updateSingleRowFields(targetRow, { nguoiThucHien: value });
      }
      renderTable();
      renderDetailPanelFor(row); // vẽ lại panel: có thể ảnh hưởng số đếm/nhóm ở các mục
    });
  });
  $('#detailBody').querySelectorAll('[data-role="mini-chk"]').forEach(chk => {
    chk.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = chk.dataset.rowid;
      if (chk.checked) state.exportSelected.add(id); else state.exportSelected.delete(id);
      updateSelectedCount();
      // Cập nhật lại số đếm hiển thị trên nút "Tạo Bản cam kết" trong panel.
      const btnPanel = $('#btnCreateCommitmentPanel');
      if (btnPanel) btnPanel.textContent = `📄 Tạo Bản cam kết (${state.exportSelected.size} xe đã chọn)`;
      renderTable();
    });
  });

  // Yêu cầu #1: nút "Tạo Bản cam kết" ngay trong panel Chi tiết chủ xe — dùng
  // đúng danh sách xe đang được chọn (checkbox) ở panel này (và/hoặc ở bảng
  // chính), gộp theo đúng chủ xe thực sự (xem createCommitmentFromSelection()).
  const btnCommitPanel = $('#btnCreateCommitmentPanel');
  if (btnCommitPanel) btnCommitPanel.addEventListener('click', createCommitmentFromSelection);

  // Yêu cầu #2: "Bỏ chọn tất cả" ngay trong panel chi tiết — xoá TOÀN BỘ lựa
  // chọn hiện tại (dùng chung state.exportSelected với trang chủ), rồi vẽ lại
  // cả bảng chính lẫn panel để đồng bộ checkbox ở mọi nơi.
  const btnDeselectAllPanel = $('#btnDeselectAllPanel');
  if (btnDeselectAllPanel) {
    btnDeselectAllPanel.addEventListener('click', () => {
      if (!state.exportSelected.size) return;
      state.exportSelected.clear();
      renderTable();
      renderDetailPanelFor(row);
      toast('Đã bỏ chọn tất cả.');
    });
  }

  // Yêu cầu mới: "Cập nhật hàng loạt (Mục I đã chọn)" — chỉ áp dụng cho các xe
  // ĐANG được tích chọn (checkbox) VÀ đang nằm trong Mục I của chủ xe này (tập
  // giao giữa sectionI và state.exportSelected), dùng lại chung modal/luồng ghi
  // dữ liệu với nút "Cập nhật hàng loạt" ở thanh công cụ chính (openBulkUpdateModal).
  const btnBulkUpdateSectionI = $('#btnBulkUpdateSectionI');
  if (btnBulkUpdateSectionI) {
    btnBulkUpdateSectionI.addEventListener('click', () => {
      const targetRows = sectionI.filter(r => state.exportSelected.has(r._rowId));
      if (!targetRows.length) {
        toast('Vui lòng tích chọn (checkbox) ít nhất 1 xe trong Mục I trước.', true);
        return;
      }
      openBulkUpdateModal(targetRows);
    });
  }

  // Nút "Chọn tất cả" riêng cho từng mục I/II/III/IV/V.
  const sectionsById = { I: sectionI, II: sectionII, III: sectionIII, IV: sectionIV, V: sectionV };
  $('#detailBody').querySelectorAll('[data-select-all]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const secId = btn.dataset.selectAll;
      const rows = sectionsById[secId] || [];
      rows.forEach(r => state.exportSelected.add(r._rowId));
      renderDetailPanelFor(row);
      renderTable();
      toast(`Đã chọn tất cả ${rows.length} xe ở Mục ${secId} để xuất.`);
    });
  });

  // Yêu cầu: nút "Xác nhận xe đúng" ở Mục II và Mục III -> chuyển xe đó lên Mục I.
  $('#detailBody').querySelectorAll('[data-confirm-owner]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const vehicleRow = state.rawData.find(r => r._rowId === btn.dataset.confirmOwner);
      if (!vehicleRow) return;
      btn.disabled = true; btn.textContent = 'Đang lưu...';
      await confirmVehicleOwner(vehicleRow, row);
      toast(`Đã xác nhận xe ${vehicleRow.bienSo || vehicleRow.soKhung || ''} thuộc về ${chuXe}.`);
      renderDetailPanelFor(row); // render lại: xe vừa xác nhận sẽ chuyển từ Mục II/III lên Mục I
    });
  });
}

/* ---------------------------- 11. MẪU BẢN CAM KẾT (CÀI ĐẶT) ---------------- */
function loadTemplate() {
  try {
    const raw = localStorage.getItem(TEMPLATE_KEY);
    return raw ? { ...DEFAULT_TEMPLATE, ...JSON.parse(raw) } : { ...DEFAULT_TEMPLATE };
  } catch (e) { return { ...DEFAULT_TEMPLATE }; }
}
function saveTemplateLocal(tpl) {
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify(tpl));
}

function fillSettingsForm() {
  $('#tplKinhGui').value = state.template.kinhGui;
  $('#tplDiaDanh').value = state.template.diaDanh;
  $('#tplMucI').value = state.template.mucI;
  $('#tplMucII').value = state.template.mucII;
  $('#tplCamDoan').value = state.template.camDoan;
}

$('#btnSettings').addEventListener('click', () => {
  fillSettingsForm();
  openModal('settingsModal');
});

$('#btnResetTemplate').addEventListener('click', () => {
  state.template = { ...DEFAULT_TEMPLATE };
  fillSettingsForm();
  toast('Đã khôi phục mẫu mặc định (chưa lưu).');
});

$('#btnSaveTemplate').addEventListener('click', () => {
  const tpl = {
    kinhGui: $('#tplKinhGui').value.trim() || DEFAULT_TEMPLATE.kinhGui,
    diaDanh: $('#tplDiaDanh').value.trim() || DEFAULT_TEMPLATE.diaDanh,
    mucI: $('#tplMucI').value,
    mucII: $('#tplMucII').value,
    camDoan: $('#tplCamDoan').value,
  };
  state.template = tpl;
  saveTemplateLocal(tpl);
  toast('Đã lưu mẫu Bản cam kết trên trình duyệt.');
  closeModal('settingsModal');
  // LOCAL-FIRST: đã lưu xong trên trình duyệt (ở trên) — phần đồng bộ mẫu lên
  // Google Sheet chạy NGẦM phía sau, không giữ modal mở để chờ mạng.
  if (state.mode === 'gas' && state.gasUrl) {
    gasRequest(state.gasUrl, { action: 'saveSettings', template: tpl })
      .then(res => {
        if (res && res.ok) toast('Đã đồng bộ mẫu về Google Sheet.');
        else toast('Lưu tạm thành công, nhưng đồng bộ Sheet thất bại: ' + ((res && res.error) || ''), true);
      })
      .catch(e => toast('Lưu tạm thành công, nhưng đồng bộ Sheet thất bại: ' + String(e), true));
  }
});

async function trySyncTemplateFromSheet(url) {
  try {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=settings', { method: 'GET' }).then(r => r.json());
    if (res && res.ok && res.template) {
      const remote = typeof res.template === 'string' ? JSON.parse(res.template) : res.template;
      // Chỉ dùng mẫu từ Sheet nếu trình duyệt hiện chưa có mẫu tuỳ chỉnh riêng.
      if (!localStorage.getItem(TEMPLATE_KEY) && remote) {
        state.template = { ...DEFAULT_TEMPLATE, ...remote };
        saveTemplateLocal(state.template);
      }
    }
  } catch (e) { /* im lặng bỏ qua — không bắt buộc phải có mẫu trên Sheet */ }
}

/* ---------------------------- 12. TẠO BẢN CAM KẾT --------------------------- */
// Yêu cầu #1: gộp các xe của CÙNG MỘT chủ xe vào CHUNG một bản cam kết, kể cả
// những xe ở Mục I chỉ được xác định là "cùng chủ" nhờ đã bấm "Xác nhận xe
// đúng" (nên Số CCCD/tên gốc ghi trên chính dòng đó có thể khác) — dùng
// getEffectiveOwnerKey() thay vì chỉ dựa vào row.cccd để nhóm cho đúng.
// Được gọi từ cả nút trên thanh công cụ và nút trong panel Chi tiết chủ xe.
function createCommitmentFromSelection() {
  const selectedRows = state.rawData.filter(r => state.exportSelected.has(r._rowId));
  if (!selectedRows.length) { toast('Vui lòng chọn ít nhất 1 xe (checkbox) để xuất Bản cam kết.', true); return; }

  const groups = new Map();
  selectedRows.forEach(row => {
    const ownerKey = getEffectiveOwnerKey(row);
    if (!groups.has(ownerKey)) groups.set(ownerKey, { vehicles: [] });
    groups.get(ownerKey).vehicles.push(row);
  });

  groups.forEach((g, ownerKey) => {
    // Lấy tên/CCCD hiển thị từ đúng dòng "chính chủ" (Số CCCD trùng ownerKey)
    // trong toàn bộ dữ liệu — không lấy từ dòng xe đã xác nhận (vì dòng đó vẫn
    // giữ nguyên tên/CCCD gốc của chính xe). Nếu nhóm theo tên (không có CCCD)
    // thì không có "chính chủ" riêng biệt, dùng luôn xe đầu tiên trong nhóm.
    const canonicalRow = state.rawData.find(r => (r.cccd || '').trim() === ownerKey) || g.vehicles[0];
    g.chuXe = canonicalRow.chuXe;
    g.cccd = canonicalRow.cccd;
    g.diaChi = uniq(g.vehicles.map(r => r.diaChi)).join(' | ');
    g.phones = uniq(g.vehicles.map(r => r.soDienThoai)).join(' | ');
  });

  state.commitmentDocs = Array.from(groups.values());
  renderAllCommitmentDocs();
  openModal('commitmentOverlay');
}

$('#btnCreateCommitment').addEventListener('click', createCommitmentFromSelection);

function renderAllCommitmentDocs() {
  const container = $('#commitmentContainer');
  container.innerHTML = '';
  state.commitmentDocs.forEach((doc, i) => {
    container.appendChild(buildDocPageElement(doc, i));
  });
  $('#docCounter').textContent = `${state.commitmentDocs.length} bản cam kết`;
}

// Ghép nhiều dòng nội dung (textarea) thành các <div class="doc-field-line">.
function multilineToFieldLines(text, extraClass) {
  return (text || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map((line, i) => `<div class="doc-field-line ${extraClass || ''}">${i + 1}. ${escapeHtml(line)}</div>`).join('');
}

function buildDocPageElement(doc, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc-page';
  wrapper.contentEditable = 'true';
  wrapper.dataset.docIndex = index;
  const tpl = state.template;

  const soldPlates = doc.vehicles
    .filter(v => /bán|chuyển nhượng|cho|tặng/i.test(v.trangThaiXe || ''))
    .map(v => v.bienSo).filter(Boolean).join(', ');

  // Cột "Loại xe, nhãn hiệu, số loại" GỘP CHUNG với "Số khung + Số máy" trong 1 cột
  // để tránh tràn trang khi in (theo yêu cầu bố cục).
  const rowsHtml = doc.vehicles.map((v, i) => `
    <tr>
      <td style="text-align:center;">${i + 1}</td>
      <td>${escapeHtml(v.bienSo)}</td>
      <td>
        ${escapeHtml(v.loaiXe)}${v.nhanHieu ? ' - ' + escapeHtml(v.nhanHieu) : ''}<br>
        <span style="font-size:9.5pt;color:#333;">Số khung: ${escapeHtml(v.soKhung) || '—'}</span><br>
        <span style="font-size:9.5pt;color:#333;">Số máy: ${escapeHtml(v.soMay) || '—'}</span>
      </td>
      <td class="fill" contenteditable="true"></td>
      <td>${escapeHtml(v.trangThaiXe) || '<span class="fill" contenteditable="true"></span>'}</td>
      <td>${escapeHtml(v.ghiChu) || '<span class="fill" contenteditable="true"></span>'}</td>
    </tr>
  `).join('');

  wrapper.innerHTML = `
    <div class="doc-center doc-bold">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
    <div class="doc-center doc-bold">Độc lập - Tự do - Hạnh phúc</div>
    <div class="doc-center doc-title">BẢN CAM KẾT</div>
    <div class="doc-center doc-italic">(Về việc kê khai, xác nhận tình trạng phương tiện và cam kết trách nhiệm đối với phương tiện đứng tên sở hữu)</div>

    <div class="doc-field-line">${escapeHtml(tpl.kinhGui)}</div>

    <div class="doc-field-line">Tên tôi là (chủ xe đứng tên trong Giấy chứng nhận đăng ký xe):</div>
    <div class="doc-field-line">Họ và tên: <span class="fill" contenteditable="true">${escapeHtml(doc.chuXe)}</span></div>
    <div class="doc-field-line">Ngày, tháng, năm sinh: <span class="fill" contenteditable="true">......................</span></div>
    <div class="doc-field-line">Số CCCD/Mã định danh cá nhân: <span class="fill" contenteditable="true">${escapeHtml(doc.cccd)}</span></div>
    <div class="doc-field-line">Ngày cấp: <span class="fill" contenteditable="true">.................</span> &nbsp; Nơi cấp: <span class="fill" contenteditable="true">.................</span></div>
    <div class="doc-field-line">Địa chỉ thường trú: <span class="fill" contenteditable="true">${escapeHtml(doc.diaChi)}</span></div>
    <div class="doc-field-line">Số điện thoại liên hệ: <span class="fill" contenteditable="true">${escapeHtml(doc.phones)}</span></div>

    <div class="doc-field-line">Là chủ sở hữu phương tiện có thông tin như sau:</div>

    <table class="doc-table">
      <thead>
        <tr>
          <th style="width:6%;">STT</th>
          <th style="width:14%;">Biển số</th>
          <th style="width:34%;">Loại xe, nhãn hiệu, số loại<br>(kèm Số khung/Số máy)</th>
          <th style="width:16%;">GCNĐKX số;<br>cấp ngày</th>
          <th style="width:14%;">Tình trạng xe<br><span style="font-weight:400;">(còn sử dụng/đã bán)</span></th>
          <th style="width:16%;">Ghi chú</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="doc-field-line">Nay tôi làm Bản cam kết này để kê khai, xác nhận tình trạng phương tiện nêu trên và cam đoan, chịu trách nhiệm về các nội dung sau đây (đối chiếu theo tình trạng từng xe đã kê khai tại cột "Tình trạng xe" nêu trên):</div>

    <div class="doc-field-line doc-bold">I. Đối với phương tiện đã bán/chuyển nhượng/cho/tặng nhưng không xác định được thông tin người mua/người đang sử dụng xe</div>
    ${soldPlates ? `<div class="doc-field-line">Các phương tiện liên quan có biển số: <span class="fill" contenteditable="true">${escapeHtml(soldPlates)}</span>.</div>` : ''}
    ${multilineToFieldLines(tpl.mucI)}

    <div class="doc-field-line doc-bold">II. Đối với phương tiện hư hỏng, không còn hoạt động hoặc bị mất:</div>
    ${multilineToFieldLines(tpl.mucII)}
    
    <div class="doc-field-line doc-bold">III. Đối với phương tiện còn đang sử dụng (ngoài những phương tiện ở mục I và mục II):</div>
    ${multilineToFieldLines(tpl.mucIII)}

    <div class="doc-field-line">${escapeHtml(tpl.camDoan)}</div>

    <div class="doc-signature">
      <div class="doc-signature-block">
        <div class="doc-italic">${escapeHtml(tpl.diaDanh)}, ngày ..... tháng ..... năm ..........</div>
        <div class="doc-bold" style="margin-top:6px;">NGƯỜI CAM KẾT</div>
        <div class="doc-italic">(Ký, ghi rõ họ tên)</div>
        <div class="sign-space"></div>
      </div>
    </div>
  `;
  return wrapper;
}

$('#btnPrevDoc').addEventListener('click', () => scrollDoc(-1));
$('#btnNextDoc').addEventListener('click', () => scrollDoc(1));
let currentDocScrollIndex = 0;
function scrollDoc(delta) {
  const pages = $all('.doc-page', $('#commitmentContainer'));
  if (!pages.length) return;
  currentDocScrollIndex = Math.min(pages.length - 1, Math.max(0, currentDocScrollIndex + delta));
  pages[currentDocScrollIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#btnPrint').addEventListener('click', () => window.print());

/* ---------------------------- 13. TẢI VỀ WORD (.docx) ----------------------- */
$('#btnDownloadWord').addEventListener('click', async () => {
  if (typeof docx === 'undefined') { toast('Không tải được thư viện docx (kiểm tra kết nối mạng).', true); return; }
  const pages = $all('.doc-page', $('#commitmentContainer'));
  if (!pages.length) { toast('Chưa có bản cam kết nào để tải.', true); return; }
  toast('Đang tạo file Word...');
  for (let i = 0; i < pages.length; i++) {
    try {
      const doc = buildDocxFromPage(pages[i]);
      const blob = await docx.Packer.toBlob(doc);
      const ownerName = (state.commitmentDocs[i] && state.commitmentDocs[i].chuXe) || `BanCamKet_${i + 1}`;
      downloadBlob(blob, `BanCamKet_${sanitizeFilename(ownerName)}.docx`);
      await new Promise(res => setTimeout(res, 350));
    } catch (err) {
      console.error(err);
      toast('Lỗi khi tạo file Word cho bản #' + (i + 1), true);
    }
  }
  // Đánh dấu "đã xuất bản cam kết" ngược về Sheet (nếu đang ở chế độ 2 chiều).
  await markExportedOnSheet();
});

// LOCAL-FIRST: đưa việc đánh dấu ngày xuất cam kết vào hàng đợi đồng bộ ngầm
// cho từng xe thay vì ghi tuần tự và chờ (await) từng request một — không còn
// chặn UI khi xuất bản cam kết cho nhiều xe cùng lúc.
function markExportedOnSheet() {
  if (state.mode !== 'gas' || !state.gasUrl) return;
  const today = new Date().toLocaleDateString('vi-VN');
  const allExportedRows = state.commitmentDocs.flatMap(d => d.vehicles);
  allExportedRows.forEach(row => enqueueRowSync(row, { [EXPORT_FLAG_HEADER]: today }));
  if (allExportedRows.length) {
    toast(`Đang đồng bộ ngầm ngày xuất cam kết cho ${allExportedRows.length} xe lên Google Sheet...`);
  }
}

function sanitizeFilename(s) {
  return (s || 'ChuXe').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'ChuXe';
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function buildDocxFromPage(pageEl) {
  const { Document, Paragraph, TextRun, AlignmentType } = docx;
  const children = [];

  Array.from(pageEl.children).forEach(node => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'table') {
      children.push(buildDocxTable(node, docx));
      children.push(new Paragraph({ text: '' }));
      return;
    }
    if (node.classList.contains('doc-signature')) {
      const block = node.querySelector('.doc-signature-block');
      const lines = block ? Array.from(block.children).map(c => c.textContent.trim()).filter(Boolean) : [];
      lines.forEach((line, idx) => {
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: line, bold: idx === 1, italics: idx === 0 || idx === 2 })]
        }));
      });
      children.push(new Paragraph({ text: '' }));
      children.push(new Paragraph({ text: '' }));
      return;
    }
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const alignment = node.classList.contains('doc-center') ? AlignmentType.CENTER : AlignmentType.LEFT;
    const bold = node.classList.contains('doc-bold');
    const italics = node.classList.contains('doc-italic');
    const isTitle = node.classList.contains('doc-title');
    children.push(new Paragraph({
      alignment,
      spacing: { after: 120 },
      children: [new TextRun({ text, bold: bold || isTitle, italics, size: isTitle ? 30 : undefined })]
    }));
  });

  return new Document({ sections: [{ children }] });
}

function buildDocxTable(tableEl, docxLib) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, AlignmentType, WidthType, ShadingType } = docxLib;
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  if (!rows.length) return new Paragraph({ text: '' });
  const numCols = rows[0].children.length;
  const totalWidth = 9350;
  // Giữ tỉ lệ độ rộng tương đối giống bản xem trước (cột nội dung xe được rộng
  // nhất vì đã gộp Loại xe/Nhãn hiệu + Số khung/Số máy vào chung một cột).
  const relWidths = [0.06, 0.14, 0.34, 0.16, 0.14, 0.16];
  const colWidths = numCols === relWidths.length
    ? relWidths.map(r => Math.floor(totalWidth * r))
    : Array(numCols).fill(Math.floor(totalWidth / numCols));

  const docxRows = rows.map(tr => {
    const isHeader = tr.parentElement.tagName.toLowerCase() === 'thead';
    const cells = Array.from(tr.children).map((td, ci) => {
      // Với ô đã gộp nội dung xe (nhiều dòng do <br>), tách thành nhiều Paragraph.
      const lines = isHeader
        ? [td.textContent.replace(/\s+/g, ' ').trim()]
        : td.innerHTML.split(/<br\s*\/?>/i).map(h => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(l => l.length);
      const paras = (lines.length ? lines : ['']).map(line => new Paragraph({
        alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [new TextRun({ text: line, bold: isHeader, size: isHeader ? undefined : 20 })]
      }));
      return new TableCell({
        width: { size: colWidths[ci] || Math.floor(totalWidth / numCols), type: WidthType.DXA },
        shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } : undefined,
        children: paras
      });
    });
    return new TableRow({ children: cells });
  });

  return new Table({ columnWidths: colWidths, width: { size: totalWidth, type: WidthType.DXA }, rows: docxRows });
}

/* ---------------------------- 13b. KÉO GIÃN PANEL CHI TIẾT (DESKTOP) ------- */
// Yêu cầu #2: cho phép kéo rộng/thu hẹp panel "Chi tiết chủ phương tiện" trên
// desktop; trên điện thoại (màn hình <=1000px, trùng breakpoint responsive có
// sẵn) giữ nguyên giao diện cũ — không gắn thao tác kéo.
(function setupDetailPanelResize() {
  const handle = document.getElementById('detailResizeHandle');
  const panel = document.getElementById('detailPanel');
  if (!handle || !panel) return;
  const WIDTH_KEY = 'vehicleDetailPanelWidthV1';
  const MIN_W = 360, MAX_W = 1100;

  const savedWidth = parseInt(localStorage.getItem(WIDTH_KEY), 10);
  if (savedWidth && savedWidth >= MIN_W && savedWidth <= MAX_W) panel.style.width = savedWidth + 'px';

  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    if (window.innerWidth <= 1000) return; // mobile: không cho kéo, giữ nguyên giao diện
    dragging = true;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newWidth = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX));
    panel.style.width = newWidth + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    const w = parseInt(panel.style.width, 10);
    if (w) localStorage.setItem(WIDTH_KEY, w);
    // Đổi độ rộng panel -> độ rộng khả dụng của các bảng mini cũng đổi theo,
    // cần tính lại thanh trượt ngang dùng chung (setupDetailHScrollSync()).
    if (typeof setupDetailHScrollSync === 'function') setupDetailHScrollSync();
  });
})();

/* ---------------------------- 14. KHỞI ĐỘNG ------------------------------- */
function refreshAll() {
  updateRecordCount();
  refreshFilterUIs();
  renderSortBar();
  // Yêu cầu (Lọc nhanh theo Địa bàn cũ / Lưu trạng thái bộ lọc): đồng bộ lại
  // trạng thái "đang chọn" của nhóm nút lọc nhanh sau khi state.quickDiaBan có
  // thể vừa được khôi phục từ localStorage (restoreFilterState()).
  updateQuickDiaBanButtonsUI();
  renderTable();
  updateModeBadge();
  updateSyncStatusBadge();
}

(async function init() {
  // Yêu cầu (Lưu thay đổi trước, đồng bộ ngầm sau): nạp hàng đợi đồng bộ ngầm
  // (nếu phiên trước còn dang dở) TRƯỚC KHI xử lý dữ liệu, để mọi lần tải dữ
  // liệu (từ cache hay từ server) đều áp lại đúng các thay đổi đang chờ.
  await ensureSyncQueueLoaded();

  // Yêu cầu (Lưu dữ liệu cục bộ): ưu tiên hiển thị NGAY dữ liệu đã lưu trên máy
  // (IndexedDB) — không bắt buộc phải chờ tải lại từ server mới được làm việc.
  // Sau bước này, vẫn tự động tải bản mới nhất từ server ở NGẦM phía dưới như
  // trước đây (connectViaAppsScript/connectViaCsv silent) để luôn đồng bộ.
  let hasCachedData = false;
  try {
    const cached = await idbGet(IDB_KEY_RAW_DATA);
    if (Array.isArray(cached) && cached.length) {
      state.rawData = cached;
      reapplyPendingSyncToRawData();
      restoreFilterState();
      state.exportSelected = new Set();
      state.page = 1;
      computeOwnerVehicleCounts();
      hasCachedData = true;
    }
  } catch (e) { /* IndexedDB lỗi/không hỗ trợ -> bỏ qua, tải bình thường từ server */ }
  refreshAll();
  if (hasCachedData) {
    toast(`Đã hiển thị ${state.rawData.length} bản ghi từ bộ nhớ cục bộ — đang đồng bộ bản mới nhất...`);
  }

  const preferGas = (localStorage.getItem(MODE_KEY) || 'gas') === 'gas';
  // Nếu trình duyệt/thiết bị này chưa từng lưu URL riêng, dùng URL mặc định
  // đã hardcode ở trên -> luôn tự kết nối, kể cả tab mới / máy khác / điện thoại.
  const gasUrl = localStorage.getItem(GAS_URL_KEY) || DEFAULT_GAS_URL;
  const csvUrl = localStorage.getItem(LAST_URL_KEY);
  if (preferGas && gasUrl) {
    connectViaAppsScript(gasUrl, { silent: true });
  } else if (csvUrl) {
    connectViaCsv(csvUrl, { silent: true });
  } else if (gasUrl) {
    connectViaAppsScript(gasUrl, { silent: true });
  }
})();