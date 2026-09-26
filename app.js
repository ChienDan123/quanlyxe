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
  // Yêu cầu mới: trường "Tình trạng cam kết" nằm GIỮA "Ghi chú" và "Người thực
  // hiện" trên giao diện. Chưa từng có trên Sheet -> updateRow_() trong
  // AppsScript.gs sẽ TỰ ĐỘNG tạo cột mới ở cuối (giống cơ chế đã có sẵn cho
  // "Ghi Chú" / "Người thực hiện"), rơi đúng vào cột Z theo đúng yêu cầu.
  { key: 'tinhTrangCamKet', header: 'Tình trạng cam kết' },
  // Yêu cầu #5: cột "Người thực hiện" — ai đang phụ trách/đã xử lý hồ sơ này.
  // Nếu cột này chưa có trên Sheet, updateRow_() trong AppsScript.gs sẽ TỰ ĐỘNG
  // tạo cột mới (giống hệt cơ chế đã có sẵn cho "Ghi Chú"), không cần sửa Apps Script.
  { key: 'nguoiThucHien', header: 'Người thực hiện' },
];
// Danh sách lựa chọn cho trường "Tình trạng cam kết" (giữa Ghi chú và Người
// thực hiện) — dùng chung cho mọi nơi hiển thị/sửa trường này.
const COMMITMENT_OPTIONS = [
  'Đã ký cam kết', 'Đã lập biên bản hướng dẫn', 'Chưa thu thập',
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

// Yêu cầu (Cách khớp khi tìm địa chỉ): địa chỉ thường có nhiều cấp ngăn cách
// bởi dấu phẩy (thôn, xã...), có nơi thiếu cấp thôn (VD "Tam Thái, Phú Ninh").
// Chỉ còn 2 CÁCH KHỚP (đã bỏ "Đúng cụm" / "Đúng hoàn toàn" vì gây nhầm lẫn):
//   - "contains": chứa chuỗi ở bất kỳ đâu trong địa chỉ (linh hoạt, mặc định cũ).
//   - "starts_with": CHỈ khớp khi CẢ địa chỉ bắt đầu đúng bằng chuỗi đã gõ
//     (VD gõ "Tam Thái" khớp "Tam Thái, Phú Ninh" nhưng KHÔNG khớp "Khánh
//     Thịnh, Tam Thái, Phú Ninh" vì chuỗi đó không nằm ở đầu địa chỉ).
// Cho phép người dùng CHỦ ĐỘNG chọn 1 trong 2 cách khớp, chỉ áp dụng riêng cho
// ô tìm/lọc của trường "Địa chỉ / Phường-Xã" — không ảnh hưởng các trường khác.
const ADDR_MATCH_MODES = [
  { key: 'contains', label: 'Chứa chuỗi (linh hoạt)', placeholder: 'Gõ để tìm...' },
  { key: 'starts_with', label: 'Bắt đầu bằng', placeholder: 'Gõ đúng phần đầu địa chỉ, VD: Tam Thái' },
];
const ADDR_MATCH_MODE_DEFAULT = 'contains';

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
  // Mới: 2 tiêu chí sắp xếp bổ sung theo yêu cầu.
  { key: 'cccd',        label: 'CCCD/MST',               type: 'text' },
  { key: 'giaDinh',     label: 'Người cùng gia đình',    type: 'text' },
];

// Yêu cầu #2: danh sách Trạng thái dùng chung cho MỌI nơi cho phép sửa trạng
// thái (ô chọn trên từng dòng ở bảng chính, bảng mini trong panel chi tiết...).
// Mục "Cập nhật hàng loạt" và "Cập nhật cho riêng xe này" (đã có sẵn trong
// index.html) giữ nguyên danh sách tĩnh của chúng để không phá vỡ giao diện cũ.
const STATUS_OPTIONS = [
  'Còn sử dụng', 'Bán không rõ người sử dụng', 'Đã bán phế liệu' , 'Hỏng, đang quản lý' , 'Đã liên hệ', 'Đã xác minh',
  'Chưa liên hệ được', 'Cần xác minh thêm',
  // Yêu cầu mới: bỏ "Đã ký cam kết" khỏi Trạng thái xe (đã chuyển thành lựa
  // chọn riêng ở trường "Tình trạng cam kết" mới), thay bằng 2 trạng thái sau.
  'Đã thực hiện thu hồi', 'Đã hoàn thành sang tên',
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
  // Yêu cầu (Cách khớp khi tìm địa chỉ): xem ADDR_MATCH_MODES ở trên. Được lưu
  // lại cùng bộ nhớ bộ lọc (xem persistFilterState/restoreFilterState).
  addrMatchMode: ADDR_MATCH_MODE_DEFAULT,
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
  // Yêu cầu (Đánh dấu đã in): Set các khoá xe (xem rowPrintKey) đã đánh dấu
  // "Đã in" — khởi tạo ngay từ localStorage để còn nguyên qua các lần tải lại.
  printedMarks: loadPrintedMarks(),
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
      addrMatchMode: state.addrMatchMode,
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
    if (data && ADDR_MATCH_MODES.some(m => m.key === data.addrMatchMode)) state.addrMatchMode = data.addrMatchMode;
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

// So khớp 1 giá trị tuỳ chọn trong ô tìm/lọc với chuỗi đang gõ (đã lowercase +
// trim sẵn). Riêng trường 'diaChi' áp dụng đúng "Cách khớp" người dùng đang
// chọn (state.addrMatchMode); các trường lọc khác giữ nguyên kiểu "chứa
// chuỗi" như trước giờ (không đổi hành vi).
function optionMatchesSearch(field, label, searchLower) {
  const text = (label || '').toString().toLowerCase();
  if (!searchLower) return true;
  if (field !== 'diaChi') return text.includes(searchLower);
  const mode = state.addrMatchMode;
  if (mode === 'starts_with') {
    // "Bắt đầu bằng": CHỈ khớp khi cả địa chỉ bắt đầu đúng bằng chuỗi đã gõ.
    // Không khớp theo từng cụm (thôn/xã...) nữa — trước đây có kiểm tra thêm
    // "1 trong các cụm giữa dấu phẩy bắt đầu bằng chuỗi gõ" khiến gõ "Tam Thái"
    // vẫn khớp nhầm "Khánh Thịnh, Tam Thái, Phú Ninh" (giống hệt "Chứa chuỗi").
    return text.trim().startsWith(searchLower);
  }
  return text.includes(searchLower); // 'contains' (mặc định, như hành vi cũ)
}

/* ---------------------------- 6b. SẮP XẾP KẾT HỢP NHIỀU TIÊU CHÍ ------------ */
// Bỏ các hậu tố hay bị dính vào cuối họ tên khi nhập liệu (năm sinh...), để
// không làm sai lệch việc xác định đâu là "Tên" thật sự (từ cuối cùng).
// Nhận diện các dạng: "TRẦN QUỐC NAM - 1980", "TRẦN QUỐC NAM 1980",
// "TRẦN QUỐC NAM-1980"... (dấu gạch nối tuỳ chọn, có/không có khoảng trắng).
function stripNameSuffix(raw) {
  let s = (raw || '').toString().trim();
  s = s.replace(/\s*[-–—]?\s*\d{4}\s*$/, '');
  return s.trim();
}

// Tách họ tên phục vụ SẮP XẾP: đã loại bỏ hậu tố (năm sinh...) trước khi tách,
// dùng lại splitNameParts() (họ = từ đầu, tên = từ cuối, chữ lót = ở giữa).
function splitNameForSort(raw) {
  const cleaned = stripNameSuffix(raw);
  return splitNameParts(cleaned) || { ho: '', ten: '', dem: '' };
}

// Yêu cầu 2A: khi sắp xếp theo "Tên" (chủ phương tiện), phải hiểu đúng TÊN là
// từ cuối cùng trong họ tên (VD "NAM" trong "TRẦN QUỐC NAM - 1980"), và sắp
// xếp theo thứ tự ưu tiên: Tên -> chữ lót -> Họ (nếu Tên trùng nhau thì so
// tiếp chữ lót, nếu chữ lót cũng trùng thì so tiếp Họ).
function compareNameCascade(rawA, rawB) {
  const pa = splitNameForSort(rawA);
  const pb = splitNameForSort(rawB);
  const cmpTen = (pa.ten || '').localeCompare(pb.ten || '', 'vi', { sensitivity: 'base' });
  if (cmpTen !== 0) return cmpTen;
  const cmpDem = (pa.dem || '').localeCompare(pb.dem || '', 'vi', { sensitivity: 'base' });
  if (cmpDem !== 0) return cmpDem;
  return (pa.ho || '').localeCompare(pb.ho || '', 'vi', { sensitivity: 'base' });
}

// Lấy giá trị dùng để so sánh khi sắp xếp cho 1 dòng theo 1 trường cụ thể.
// (Trường 'chuXe' được xử lý riêng bằng compareNameCascade() ở dưới, không
// qua hàm này, vì cần so sánh theo 3 cấp Tên -> chữ lót -> Họ.)
function getSortValue(row, field) {
  if (field === 'soLuongXe') {
    return state.ownerVehicleCounts.get(getEffectiveOwnerKey(row)) || 0;
  }
  return (row[field] || '').toString().trim();
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
    let cmp;
    if (field === 'chuXe') {
      // Yêu cầu 2A: Tên -> chữ lót -> Họ (xem compareNameCascade()).
      cmp = compareNameCascade(a[field], b[field]);
    } else if (fieldDef && fieldDef.type === 'number') {
      const va = getSortValue(a, field), vb = getSortValue(b, field);
      cmp = (Number(va) || 0) - (Number(vb) || 0);
    } else {
      const va = getSortValue(a, field), vb = getSortValue(b, field);
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
    ? allOptions.filter(o => optionMatchesSearch(field, filterOptionLabel(field, o), searchLower))
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

  // Yêu cầu (Cách khớp khi tìm địa chỉ): gợi ý ngay trong ô nhập cách gõ đúng
  // với chế độ khớp đang chọn (chỉ khác với trường 'diaChi').
  const placeholderText = field === 'diaChi'
    ? ((ADDR_MATCH_MODES.find(m => m.key === state.addrMatchMode) || {}).placeholder || 'Gõ để tìm...')
    : 'Gõ để tìm...';

  container.innerHTML = `
    <div class="ms-input-box ${ui.open ? 'ms-input-box-expanded' : ''}">
      ${chipsHtml}
      <input type="text" placeholder="${escapeHtml(placeholderText)}" value="${escapeHtml(ui.search)}" data-role="ms-search">
    </div>
    ${dropdownHtml}
  `;
}

function refreshFilterUIs() {
  FILTER_FIELDS.forEach(renderMultiSelect);
  // Yêu cầu (Cách khớp khi tìm địa chỉ): đồng bộ lại <select> hiển thị đúng
  // chế độ đang lưu trong state (kể cả sau khi restoreFilterState() vừa nạp
  // lại từ localStorage lúc tải dữ liệu).
  const addrMatchModeEl = $('#addrMatchMode');
  if (addrMatchModeEl) addrMatchModeEl.value = state.addrMatchMode;
}

const filterBar = $('#filterBar');
// Yêu cầu (Cách khớp khi tìm địa chỉ): người dùng chủ động đổi chế độ bất cứ
// lúc nào — lưu lại ngay (nhớ cho lần sau) và vẽ lại gợi ý/placeholder của ô
// tìm địa chỉ theo chế độ mới. KHÔNG cần renderTable() vì chế độ khớp chỉ ảnh
// hưởng tới việc TÌM/CHỌN giá trị trong ô lọc, không đổi các lựa chọn đã chọn.
const addrMatchModeEl = $('#addrMatchMode');
if (addrMatchModeEl) {
  addrMatchModeEl.addEventListener('change', (e) => {
    const val = e.target.value;
    state.addrMatchMode = ADDR_MATCH_MODES.some(m => m.key === val) ? val : ADDR_MATCH_MODE_DEFAULT;
    persistFilterState();
    renderMultiSelect('diaChi');
  });
}
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
  const matches = getOptionsFor(field).filter(o => optionMatchesSearch(field, filterOptionLabel(field, o), search));
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
      const toggleAllSearchLower = state.msUI[field].search.trim().toLowerCase();
      const visible = getOptionsFor(field).filter(o => optionMatchesSearch(field, o, toggleAllSearchLower));
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
    // Đồng bộ STT xuất ra với STT đang hiển thị trên bảng: đánh lại liên tục từ 1.
    rows.forEach((row, i) => { row.stt = i + 1; });

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

/* ---------------------------- 7c. XUẤT TRANG IN ----------------------------
   Nút "Xuất trang in" -> hộp thoại chọn cột + khổ giấy -> dựng 1 trang in riêng
   trong iframe ẩn rồi gọi hộp thoại in của trình duyệt (in giấy hoặc Lưu PDF).
   - Dữ liệu in = đúng danh sách đang thấy: getFiltered(null) + compareBySortCriteria
     (giống bảng chính và Xuất Excel), STT đánh lại từ 1 theo danh sách đó.
   - Lựa chọn cột + khổ giấy lưu vào localStorage (PRINT_SETTINGS_KEY).
   - Dùng iframe riêng nên KHÔNG đụng tới CSS @media print của Bản cam kết.       */
const PRINT_SETTINGS_KEY = 'vehiclePrintSettingsV1';
// Yêu cầu (Đánh dấu đã in): lưu danh sách các xe đã được đánh dấu "Đã in"
// (chỉ ở trình duyệt này, không đồng bộ Sheet) để có thể LOẠI TRỪ khi in lần
// sau -> dễ xác định phần chưa in. Khoá nhận diện 1 xe theo thứ tự ưu tiên
// giống MATCH_KEY_PRIORITY (mã ID/MOTO_ID/biển số), dự phòng số khung rồi
// đến CCCD+biển số, để vẫn ổn định qua các lần tải lại dữ liệu.
const PRINTED_MARKS_KEY = 'vehiclePrintedMarksV1';
function rowPrintKey(row) {
  for (const k of MATCH_KEY_PRIORITY) { if (row[k] && String(row[k]).trim()) return k + ':' + String(row[k]).trim(); }
  if (row.soKhung && row.soKhung.trim()) return 'soKhung:' + row.soKhung.trim();
  return 'cb:' + (row.cccd || '').trim() + '|' + (row.bienSo || '').trim();
}
function loadPrintedMarks() {
  try {
    const raw = localStorage.getItem(PRINTED_MARKS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) { return new Set(); }
}
function savePrintedMarks() {
  try { localStorage.setItem(PRINTED_MARKS_KEY, JSON.stringify(Array.from(state.printedMarks))); }
  catch (e) { /* localStorage đầy/bị chặn -> bỏ qua */ }
}
function isRowPrinted(row) { return state.printedMarks.has(rowPrintKey(row)); }
function markRowsPrinted(rows, printed) {
  rows.forEach(r => {
    const k = rowPrintKey(r);
    if (printed) state.printedMarks.add(k); else state.printedMarks.delete(k);
  });
  savePrintedMarks();
}

// nowrap: cột ngắn (biển số, số khung, CCCD, ngày, SĐT...) ưu tiên KHÔNG xuống
//   dòng để dễ đọc/đối chiếu; các cột dài (địa chỉ, ghi chú...) được xuống dòng.
// weight: độ rộng ước lượng (số ký tự) — chỉ dùng để tự chọn A4 ngang/dọc.
const PRINT_COLUMNS = [
  { key: 'stt',           header: 'STT',             locked: true, nowrap: true, weight: 4, align: 'center' },
  { key: 'bienSo',        header: 'Biển số',         nowrap: true, weight: 11, bold: true },
  { key: 'soKhung',       header: 'Số khung',        nowrap: true, weight: 18 },
  { key: 'soMay',         header: 'Số máy',          nowrap: true, weight: 14 },
  { key: 'nhanHieu',      header: 'Nhãn hiệu',       weight: 10 },
  { key: 'loaiXe',        header: 'Loại xe',         weight: 12 },
  { key: 'chuXe',         header: 'Chủ phương tiện', weight: 20 },
  { key: 'cccd',          header: 'Số CCCD/MST',     nowrap: true, weight: 13 },
  { key: 'diaChi',        header: 'Địa chỉ đăng ký', weight: 34 },
  { key: 'phuongXaMoi',   header: 'Phường/Xã mới',   weight: 16 },
  { key: 'trangThaiXe',   header: 'Trạng thái xe',   weight: 14 },
  { key: 'ngayDangKy',    header: 'Ngày đăng ký',    nowrap: true, weight: 10 },
  { key: 'soDienThoai',   header: 'Số điện thoại',   nowrap: true, weight: 11 },
  { key: 'ghiChu',        header: 'Ghi chú',         weight: 24 },
  { key: 'nguoiThucHien', header: 'Người thực hiện', weight: 11 },
];
const PRINT_DEFAULT_COLUMNS = ['stt', 'bienSo', 'chuXe', 'cccd', 'diaChi', 'soDienThoai', 'trangThaiXe', 'ghiChu'];
// Tổng weight <= ngưỡng này thì chế độ "Tự động" chọn A4 dọc, lớn hơn thì A4 ngang.
const PRINT_PORTRAIT_MAX_WEIGHT = 95;
// Cỡ chữ trên trang in: thử từ MAX xuống MIN (bước STEP) cho tới khi bảng vừa khổ giấy.
const PRINT_FONT_MAX_PT = 10;
const PRINT_FONT_MIN_PT = 7.5;
const PRINT_FONT_STEP_PT = 0.25;
const PRINT_PAGE_MARGIN_MM = 8;
// Danh sách quá dài (dễ treo trình duyệt/ra hàng trăm trang) -> hỏi xác nhận trước.
const PRINT_CONFIRM_ROWS = 2000;

// Yêu cầu (Nâng cấp chức năng In): thêm các tuỳ chọn lọc/mở rộng danh sách in,
// lưu chung với lựa chọn cột/khổ giấy (localStorage) để lần sau không phải
// chọn lại. excludePrinted: loại các dòng đã đánh dấu "Đã in". autoMark: sau
// khi in xong, tự động đánh dấu các dòng vừa in là "Đã in". expandSameCccd /
// expandSameNameOldId: xem expandPrintRows() bên dưới.
const PRINT_EXTRA_DEFAULTS = {
  excludePrinted: false,
  autoMarkPrinted: true,
  expandSameCccd: false,
  expandSameNameOldId: false,
};
function loadPrintSettings() {
  const fallback = { columns: PRINT_DEFAULT_COLUMNS.slice(), orientation: 'auto', ...PRINT_EXTRA_DEFAULTS };
  try {
    const raw = localStorage.getItem(PRINT_SETTINGS_KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw) || {};
    const known = new Set(PRINT_COLUMNS.map(c => c.key));
    const cols = Array.isArray(data.columns) ? data.columns.filter(k => known.has(k)) : [];
    const orientation = ['auto', 'landscape', 'portrait'].includes(data.orientation) ? data.orientation : 'auto';
    const extras = {};
    Object.keys(PRINT_EXTRA_DEFAULTS).forEach(k => {
      extras[k] = typeof data[k] === 'boolean' ? data[k] : PRINT_EXTRA_DEFAULTS[k];
    });
    // Dữ liệu lưu hỏng / không còn cột nào hợp lệ -> dùng cột mặc định.
    if (!cols.some(k => k !== 'stt')) return { columns: fallback.columns, orientation, ...extras };
    return { columns: cols, orientation, ...extras };
  } catch (e) { return fallback; }
}
function savePrintSettings(s) {
  try { localStorage.setItem(PRINT_SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* localStorage đầy/bị chặn -> bỏ qua */ }
}

// Danh sách cột thực sự sẽ in (đúng thứ tự cột trên bảng; STT luôn có).
function getPrintColumns(settings) {
  return PRINT_COLUMNS.filter(c => c.locked || settings.columns.includes(c.key));
}
function resolvePrintOrientation(cols, pref) {
  if (pref === 'landscape' || pref === 'portrait') return pref;
  const total = cols.reduce((sum, c) => sum + c.weight, 0);
  return total > PRINT_PORTRAIT_MAX_WEIGHT ? 'landscape' : 'portrait';
}

/* ---- Ghi chú người cùng gia đình / cùng chủ khi in -------------------------
   Quan hệ gia đình lấy từ cột Y (row.giaDinh = "Cùng gia đình với: CCCD|CCCD").
   Coi quan hệ là 2 chiều: A ghi B, hoặc B ghi A đều tính. Chỉ dẫn chiếu tới
   những người CÓ MẶT trong danh sách in (vì STT chỉ có nghĩa trong danh sách
   này). Trả về Map<_rowId, chuỗi ghi chú>.

   Logic (theo yêu cầu điều chỉnh):
   1) Cùng 1 người (cùng số CCCD, nhiều xe) không còn bị bỏ qua hoàn toàn như
      trước: nếu người đó có > 1 xe trong danh sách in, luôn ghi chú NGẮN GỌN
      "công dân có x xe cần rà soát" (không liệt kê chi tiết STT — vì đó vẫn
      chỉ là 1 người, không phải người khác trong gia đình).
   2) Ghi chú CHI TIẾT "có người trong gia đình tại STT …" chỉ dùng cho người
      KHÁC (khác số CCCD) được xác định qua cột "Người cùng gia đình". Nếu các
      dòng của "người chính" (cùng CCCD với dòng đang xét) đã được xếp GẦN
      NHAU và liền kề với dòng của người thân đó rồi (dễ nhận ra bằng mắt khi
      in ra), thì KHÔNG cần ghi chú chi tiết cho người thân đó nữa — chỉ ghi
      chi tiết khi họ KHÔNG nằm liền kề (xe/dòng của người thân nằm tách rời,
      cần dẫn chiếu STT để dễ tìm).                                          */
function buildPrintFamilyNotes(rows) {
  const listed = new Map(); // cccd -> { name, stts: [STT trong danh sách in] }
  rows.forEach((r, i) => {
    const c = (r.cccd || '').trim();
    if (!c) return;
    let e = listed.get(c);
    if (!e) { e = { name: (r.chuXe || '').trim(), stts: [] }; listed.set(c, e); }
    e.stts.push(i + 1);
  });
  // Chiều ngược: nếu dòng B (trong danh sách) ghi CCCD của A thì A cũng "có người gia đình" là B.
  const reverse = new Map(); // cccd của A -> Set cccd của các B ghi A vào cột gia đình
  rows.forEach(r => {
    const c = (r.cccd || '').trim();
    if (!c) return;
    parseFamilyIds(r.giaDinh).forEach(id => {
      if (!reverse.has(id)) reverse.set(id, new Set());
      reverse.get(id).add(c);
    });
  });

  // 1 dãy STT được coi là "đã xếp gần nhau" nếu, sau khi sắp xếp, nó tạo thành
  // 1 khối LIỀN MẠCH không có khoảng hở (VD [3,4,5] -> gần nhau; [3,7] -> không).
  function isAdjacentBlock(sttArr) {
    if (sttArr.length <= 1) return true;
    const sorted = [...sttArr].sort((a, b) => a - b);
    return sorted[sorted.length - 1] - sorted[0] + 1 === sorted.length;
  }

  const notes = new Map();
  rows.forEach((r, idx) => {
    const own = (r.cccd || '').trim();
    const parts = [];

    // (1) Cùng 1 người, nhiều xe -> ghi chú ngắn gọn "công dân có x xe cần rà soát".
    const selfEntry = own ? listed.get(own) : null;
    const selfCount = selfEntry ? selfEntry.stts.length : 1;
    if (selfCount > 1) parts.push(`công dân có ${selfCount} xe cần rà soát`);

    // (2) Người khác cùng gia đình (khác CCCD).
    const ids = new Set(parseFamilyIds(r.giaDinh));
    if (own && reverse.has(own)) reverse.get(own).forEach(id => ids.add(id));
    if (own) ids.delete(own); // (1) đã xử lý riêng, không tính là "người trong gia đình"
    const members = [];
    ids.forEach(id => { const e = listed.get(id); if (e) members.push(e); });

    if (members.length) {
      // Chỉ giữ lại chi tiết cho những người thân mà xe/dòng của họ CHƯA nằm
      // liền kề với (các) dòng của người chính đang được ghi chú -> nếu đã
      // liền kề (dễ thấy) thì bỏ, khỏi ghi chú chi tiết trùng lặp không cần thiết.
      const selfStts = selfEntry ? selfEntry.stts : [idx + 1];
      const needDetail = members.filter(m => !isAdjacentBlock([...selfStts, ...m.stts]));
      if (needDetail.length) {
        needDetail.sort((a, b) => a.stts[0] - b.stts[0]);
        const detailParts = needDetail.map(m => {
          const shown = m.stts.slice(0, 4).join(', ') + (m.stts.length > 4 ? ', …' : '');
          return `STT ${shown} ${m.name}`.trim();
        });
        parts.push('có người trong gia đình tại ' + detailParts.join('; '));
      }
    }

    if (parts.length) notes.set(r._rowId, parts.join('; '));
  });
  return notes;
}

// Tách "địa chỉ đăng ký" (row.diaChi, dạng "Thôn, Xã cũ" hoặc chỉ "Xã cũ" khi
// thiếu cấp thôn) thành { thon, xa }: xã = cụm CUỐI CÙNG (giữa các dấu phẩy),
// thôn = cụm ĐẦU TIÊN nếu địa chỉ có từ 2 cụm trở lên, ngược lại để trống.
function splitDiaChiThonXa(diaChi) {
  const segs = (diaChi || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!segs.length) return { thon: '', xa: '' };
  return { thon: segs.length > 1 ? segs[0] : '', xa: segs[segs.length - 1] };
}

/* ---- Mở rộng danh sách in để "in theo thôn" / "in lẻ từng người" ----------
   Yêu cầu: khi in, cho phép CHỌN THÊM (tự động bổ sung vào danh sách đang in)
   các trường hợp liên quan sau đây, tìm trên TOÀN BỘ dữ liệu (không chỉ đang
   lọc) và kể cả những dòng đã đánh dấu "Đã in":
     a) Cùng số CCCD (từ 9 ký tự trở lên) — tức là chắc chắn cùng 1 người, dù
        dòng đó có đang bị bộ lọc hiện tại loại ra hay không.
     b) Cùng xã (cũ) nhưng khác thôn, trùng tên, và số CMND/CCCD của dòng KHÁC
        THÔN đó có độ dài <= 9 ký tự (số CMND cũ) — đây là dấu hiệu 1 người có
        thể bị ghi trùng ở 2 thôn khác nhau do dữ liệu cũ, cần rà soát gần
        người trùng tên.
   Trả về mảng dòng mới (rows gốc + các dòng mở rộng, đã loại trùng), CHƯA sắp
   xếp lại (gọi compareBySortCriteria bên ngoài nếu cần).                     */
function expandPrintRows(baseRows, opts) {
  const result = baseRows.slice();
  const seen = new Set(result.map(r => r._rowId));
  const addRow = (r) => { if (!seen.has(r._rowId)) { seen.add(r._rowId); result.push(r); } };

  if (opts.expandSameCccd) {
    const cccds = new Set();
    baseRows.forEach(r => { const c = (r.cccd || '').trim(); if (c.length >= 9) cccds.add(c); });
    if (cccds.size) {
      state.rawData.forEach(r => {
        const c = (r.cccd || '').trim();
        if (c.length >= 9 && cccds.has(c)) addRow(r);
      });
    }
  }

  if (opts.expandSameNameOldId) {
    // Lấy nền từ danh sách hiện có (kể cả những dòng vừa được mở rộng ở bước
    // trên) để 1 người vừa được thêm vào cũng được dùng làm "gốc" để tìm tiếp.
    const bases = result.map(r => ({ row: r, name: normalizeName(r.chuXe), addr: splitDiaChiThonXa(r.diaChi) }))
      .filter(b => b.name && b.addr.xa);
    if (bases.length) {
      state.rawData.forEach(r => {
        const c = (r.cccd || '').trim();
        if (!c || c.length > 9) return; // chỉ bắt số CMND cũ (<=9 ký tự)
        const name = normalizeName(r.chuXe);
        const addr = splitDiaChiThonXa(r.diaChi);
        if (!name || !addr.xa) return;
        const match = bases.some(b => b.name === name && b.addr.xa === addr.xa && b.addr.thon !== addr.thon);
        if (match) addRow(r);
      });
    }
  }

  return result;
}

/* ---- Dựng tài liệu HTML của trang in ---------------------------------------
   Bố trí: lề 8mm, bảng rộng 100% khổ giấy, lưới mảnh + dòng chẵn tô xám nhạt,
   dòng tiêu đề bảng lặp lại ở mỗi trang, mỗi dòng không bị cắt đôi giữa 2 trang.
   Script nhúng trong tài liệu tự thu nhỏ chữ (từ 10pt xuống tối thiểu 7,5pt)
   cho tới khi bảng vừa bề ngang khổ giấy, rồi gọi window.print().            */
function buildPrintDocument(rows, cols, orientation, notes) {
  const landscape = orientation === 'landscape';
  const paperW = landscape ? 297 : 210;
  const margin = PRINT_PAGE_MARGIN_MM;

  const theadHtml = cols.map(c =>
    `<th class="${c.align === 'center' ? 'ctr' : ''}">${escapeHtml(c.header)}</th>`).join('');

  const tbodyHtml = rows.map((r, i) => {
    const tds = cols.map(c => {
      let inner;
      if (c.key === 'stt') {
        inner = String(i + 1); // STT đánh lại từ 1 theo danh sách đang lọc + sắp xếp
      } else if (c.key === 'chuXe') {
        inner = `<span class="nm">${escapeHtml(r.chuXe)}</span>`;
        const note = notes.get(r._rowId);
        if (note) inner += `<div class="fam">↳ ${escapeHtml(note)}</div>`;
      } else {
        inner = escapeHtml(r[c.key]);
      }
      const cls = [c.nowrap ? 'nw' : '', c.align === 'center' ? 'ctr' : '', c.bold ? 'b' : ''].filter(Boolean).join(' ');
      return `<td class="${cls}">${inner}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  const stamp = new Date().toLocaleString('vi-VN');
  const css = `
@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:${margin}mm;
  @bottom-right{content:"Trang " counter(page) " / " counter(pages);font:7.5pt Arial,sans-serif;color:#555;}}
*{box-sizing:border-box;}
:root{--fs:${PRINT_FONT_MAX_PT}pt;}
html,body{margin:0;padding:0;background:#fff;}
body{font-family:'Segoe UI',Roboto,Arial,'Helvetica Neue',sans-serif;color:#000;font-size:var(--fs);line-height:1.22;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;}
.sheet{width:${paperW - 2 * margin}mm;}
@media print{.sheet{width:auto;}}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:0 0 1.5mm;}
.head .t{font-size:11pt;font-weight:700;letter-spacing:.02em;}
.head .m{font-size:8pt;color:#333;}
table{border-collapse:collapse;width:100%;}
th,td{border:.4pt solid #666;padding:.8mm 1.3mm;text-align:left;vertical-align:top;overflow-wrap:break-word;}
th{background:#e3e3e3;font-weight:700;vertical-align:middle;}
thead{display:table-header-group;}
tr{break-inside:avoid;page-break-inside:avoid;}
tbody tr:nth-child(even) td{background:#f3f3f3;}
.ctr{text-align:center;}
td.nw{white-space:nowrap;}
td.b,.nm{font-weight:600;}
.fam{font-size:.85em;font-style:italic;color:#222;margin-top:.3mm;line-height:1.15;}
body.force-wrap td.nw{white-space:normal;overflow-wrap:anywhere;}`;

  // Script tự thu nhỏ chữ + in. Tìm cỡ chữ lớn nhất còn vừa bề ngang bằng tìm nhị phân.
  const script = `
(function(){
  var MAX=${PRINT_FONT_MAX_PT}, MIN=${PRINT_FONT_MIN_PT}, STEP=${PRINT_FONT_STEP_PT};
  var root=document.documentElement, sheet=document.querySelector('.sheet'), table=document.querySelector('table');
  function setPt(p){ root.style.setProperty('--fs', p+'pt'); }
  function fits(){ return Math.max(table.getBoundingClientRect().width, sheet.scrollWidth) <= sheet.clientWidth + 1; }
  function fitAt(n){ setPt(MAX - n*STEP); return fits(); }
  function shrink(){
    var N=Math.round((MAX-MIN)/STEP);
    if (fitAt(0)) return true;
    if (!fitAt(N)) return false;
    var lo=0, hi=N;
    while (hi-lo>1){ var mid=(lo+hi)>>1; if (fitAt(mid)) hi=mid; else lo=mid; }
    setPt(MAX - hi*STEP);
    return true;
  }
  function go(){
    if (!shrink()){
      document.body.classList.add('force-wrap');
      if (!shrink()) setPt(MIN);
    }
    window.addEventListener('afterprint', function(){
      try { parent.postMessage({type:'vehicle-print-done'}, '*'); } catch(e){}
    });
    setTimeout(function(){ window.focus(); window.print(); }, 60);
  }
  window.addEventListener('load', function(){
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go); else go();
  });
})();`;

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Danh sách phương tiện</title>
<style>${css}</style></head><body>
<div class="sheet">
<div class="head"><span class="t">DANH SÁCH PHƯƠNG TIỆN</span><span class="m">Tổng ${rows.length} dòng · In lúc ${escapeHtml(stamp)}</span></div>
<table><thead><tr>${theadHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table>
</div>
<script>${script}<\/script>
</body></html>`;
}

// Dựng + in: tạo iframe ẩn (kích thước = khổ giấy để đo bề ngang chính xác).
function runPrintList(rows, settings) {
  const cols = getPrintColumns(settings);
  const orientation = resolvePrintOrientation(cols, settings.orientation);
  const html = buildPrintDocument(rows, cols, orientation, buildPrintFamilyNotes(rows));

  const old = document.getElementById('printFrame');
  if (old) old.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'printFrame';
  iframe.setAttribute('aria-hidden', 'true');
  const w = orientation === 'landscape' ? 297 : 210;
  const h = orientation === 'landscape' ? 210 : 297;
  iframe.style.cssText = `position:fixed;left:-99999px;top:0;border:0;width:${w}mm;height:${h}mm;`;
  const onMsg = (ev) => {
    if (ev.source !== iframe.contentWindow || !ev.data || ev.data.type !== 'vehicle-print-done') return;
    window.removeEventListener('message', onMsg);
    setTimeout(() => iframe.remove(), 1000);
  };
  window.addEventListener('message', onMsg);
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
}

/* ---- Giao diện hộp thoại ---- */
let printRowCountAtOpen = 0;

function readPrintSettingsFromModal() {
  const columns = $all('#printColumnList input[data-key]').filter(i => i.checked).map(i => i.dataset.key);
  const get = (id, fallback) => { const el = $(id); return el ? el.checked : fallback; };
  return {
    columns,
    orientation: $('#printOrientation').value,
    excludePrinted: get('#chkPrintExcludePrinted', PRINT_EXTRA_DEFAULTS.excludePrinted),
    autoMarkPrinted: get('#chkPrintAutoMark', PRINT_EXTRA_DEFAULTS.autoMarkPrinted),
    expandSameCccd: get('#chkPrintExpandSameCccd', PRINT_EXTRA_DEFAULTS.expandSameCccd),
    expandSameNameOldId: get('#chkPrintExpandSameNameOldId', PRINT_EXTRA_DEFAULTS.expandSameNameOldId),
  };
}
// Tính danh sách dòng SẼ IN theo đúng luật: lọc + sắp xếp hiện tại (giống bảng
// chính) -> loại "Đã in" nếu bật -> mở rộng theo CCCD/tên trùng nếu bật (mở
// rộng LUÔN lấy trên toàn bộ dữ liệu, kể cả dòng đã đánh dấu "Đã in").
function computePrintRows(settings) {
  let rows = getFiltered(null).slice().sort(compareBySortCriteria);
  if (settings.excludePrinted) rows = rows.filter(r => !isRowPrinted(r));
  const beforeExpand = rows.length;
  if (settings.expandSameCccd || settings.expandSameNameOldId) {
    rows = expandPrintRows(rows, settings).sort(compareBySortCriteria);
  }
  return { rows, addedByExpand: rows.length - beforeExpand };
}
function renderPrintModal() {
  const s = loadPrintSettings();
  $('#printColumnList').innerHTML = PRINT_COLUMNS.map(c => {
    const on = c.locked || s.columns.includes(c.key);
    return `<label class="print-col-item ${on ? 'checked' : ''} ${c.locked ? 'locked' : ''}">
      <input type="checkbox" data-key="${c.key}" ${on ? 'checked' : ''} ${c.locked ? 'disabled' : ''}>
      <span>${escapeHtml(c.header)}</span></label>`;
  }).join('');
  $('#printOrientation').value = s.orientation;
  const setChk = (id, val) => { const el = $(id); if (el) el.checked = !!val; };
  setChk('#chkPrintExcludePrinted', s.excludePrinted);
  setChk('#chkPrintAutoMark', s.autoMarkPrinted);
  setChk('#chkPrintExpandSameCccd', s.expandSameCccd);
  setChk('#chkPrintExpandSameNameOldId', s.expandSameNameOldId);
  printRowCountAtOpen = getFiltered(null).length;
  updatePrintSummary();
}
function updatePrintSummary() {
  $all('#printColumnList .print-col-item').forEach(l => {
    l.classList.toggle('checked', l.querySelector('input').checked);
  });
  const s = readPrintSettingsFromModal();
  const el = $('#printSummary');
  if (!s.columns.some(k => k !== 'stt')) {
    el.innerHTML = '<span class="warn">Chưa chọn cột nào — hãy chọn ít nhất 1 cột để in.</span>';
    return;
  }
  const cols = getPrintColumns(s);
  const ori = resolvePrintOrientation(cols, s.orientation);
  const { rows, addedByExpand } = computePrintRows(s);
  let html = `Sẽ in <b>${rows.length}</b> dòng · <b>${cols.length}</b> cột · A4 <b>${ori === 'landscape' ? 'ngang' : 'dọc'}</b>${s.orientation === 'auto' ? ' (tự chọn)' : ''}`;
  if (s.excludePrinted) {
    html += `<div class="note">Đã loại các dòng đã đánh dấu "Đã in" (còn lại: phần chưa in, trong tổng ${printRowCountAtOpen} dòng theo bộ lọc hiện tại).</div>`;
  }
  if (addedByExpand > 0) {
    html += `<div class="note">Đã tự động thêm <b>${addedByExpand}</b> dòng liên quan (cùng CCCD / cùng xã khác thôn trùng tên), kể cả dòng đã in.</div>`;
  }
  if (!s.columns.includes('chuXe')) {
    html += '<div class="note">Cột "Chủ phương tiện" đang tắt nên sẽ không hiện ghi chú người cùng gia đình.</div>';
  }
  el.innerHTML = html;
}
// Lưu ngay khi người dùng đổi lựa chọn (chỉ lưu khi còn ít nhất 1 cột, tránh lưu trạng thái rỗng).
function persistPrintSettingsFromModal() {
  const s = readPrintSettingsFromModal();
  if (s.columns.some(k => k !== 'stt')) savePrintSettings(s);
  updatePrintSummary();
}

$('#btnPrintList').addEventListener('click', () => {
  renderPrintModal();
  openModal('printModal');
});
$('#printColumnList').addEventListener('change', persistPrintSettingsFromModal);
$('#printOrientation').addEventListener('change', persistPrintSettingsFromModal);
['#chkPrintExcludePrinted', '#chkPrintAutoMark', '#chkPrintExpandSameCccd', '#chkPrintExpandSameNameOldId'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', persistPrintSettingsFromModal);
});
function setAllPrintColumns(keys) {
  $all('#printColumnList input[data-key]').forEach(i => { if (!i.disabled) i.checked = keys.includes(i.dataset.key); });
  persistPrintSettingsFromModal();
}
$('#btnPrintColsAll').addEventListener('click', () => setAllPrintColumns(PRINT_COLUMNS.map(c => c.key)));
$('#btnPrintColsNone').addEventListener('click', () => setAllPrintColumns([]));
$('#btnPrintColsDefault').addEventListener('click', () => setAllPrintColumns(PRINT_DEFAULT_COLUMNS));

$('#btnDoPrintList').addEventListener('click', () => {
  const s = readPrintSettingsFromModal();
  if (!s.columns.some(k => k !== 'stt')) { toast('Vui lòng chọn ít nhất 1 cột để in.', true); return; }
  savePrintSettings(s);
  const { rows } = computePrintRows(s);
  if (!rows.length) { toast('Không có dòng nào để in theo bộ lọc/tuỳ chọn hiện tại.', true); return; }
  if (rows.length > PRINT_CONFIRM_ROWS &&
      !window.confirm(`Danh sách có ${rows.length} dòng, in có thể ra rất nhiều trang và mất thời gian chuẩn bị. Vẫn tiếp tục?`)) return;
  toast(`Đang chuẩn bị trang in (${rows.length} dòng)...`);
  // Yêu cầu (Đánh dấu đã in): đánh dấu NGAY khi bắt đầu in (nếu bật tuỳ chọn),
  // để không phụ thuộc việc trình duyệt có báo "in xong" hay không.
  if (s.autoMarkPrinted) { markRowsPrinted(rows, true); renderTable(); }
  runPrintList(rows, s);
});

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
  // SỬA LỖI: trước đây persistFilterState() chỉ được gọi khi đổi "Cách khớp"
  // địa chỉ, nên các lựa chọn bộ lọc / tiêu chí sắp xếp / lọc bổ sung / lọc
  // nhanh địa bàn KHÔNG hề được lưu lại như mô tả ở persistFilterState().
  // renderTable() luôn được gọi lại ngay sau MỌI thay đổi liên quan (chọn giá
  // trị lọc, thêm/sửa/xoá tiêu chí sắp xếp, tick lọc bổ sung, lọc nhanh địa
  // bàn...), nên đây là 1 điểm duy nhất, an toàn để luôn lưu trạng thái mới nhất.
  persistFilterState();
  const filtered = getFiltered(null);
  // Yêu cầu 2A/2B: áp dụng sắp xếp (kết hợp nhiều tiêu chí) sau khi đã lọc,
  // trước khi phân trang, để thứ tự hiển thị và thứ tự xuất Excel khớp nhau.
  filtered.sort(compareBySortCriteria);
  // Yêu cầu: STT luôn chạy liên tục từ 1 theo ĐÚNG danh sách đang hiển thị
  // (sau khi đã lọc + sắp xếp) — không dùng lại STT gốc từ dữ liệu thô nữa.
  filtered.forEach((row, i) => { row.stt = i + 1; });
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
    tbody.innerHTML = `<tr><td colspan="17" class="empty-state">Không có dòng nào khớp bộ lọc.</td></tr>`;
  } else {
    tbody.innerHTML = pageRows.map(row => `
      <tr data-rowid="${row._rowId}" class="${state.exportSelected.has(row._rowId) ? 'selected-row' : ''} ${isRowPrinted(row) ? 'row-printed' : ''}" ${isRowPrinted(row) ? 'title="Đã đánh dấu: Đã in"' : ''}>
        <td class="col-chk"><input type="checkbox" data-role="row-chk" ${state.exportSelected.has(row._rowId) ? 'checked' : ''}></td>
        <td>${escapeHtml(row.stt)}</td>
        <td class="sticky-col col-sticky-bienso">${escapeHtml(row.bienSo)} ${isRowPrinted(row) ? '<span class="printed-badge" title="Đã in">🖨️</span>' : ''}</td>
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
        <td>${buildRowCommitmentSelectHtml(row)}</td>
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
  // Yêu cầu (Đánh dấu đã in): 2 nút đánh dấu/bỏ đánh dấu cũng chỉ bật khi có
  // ít nhất 1 xe đang được chọn (dùng chung cơ chế chọn (checkbox) sẵn có).
  const markBtn = $('#btnMarkPrinted');
  if (markBtn) markBtn.disabled = state.exportSelected.size === 0;
  const unmarkBtn = $('#btnUnmarkPrinted');
  if (unmarkBtn) unmarkBtn.disabled = state.exportSelected.size === 0;
}

// Yêu cầu (Đánh dấu đã in): đánh dấu/bỏ đánh dấu "Đã in" cho các xe đang được
// tích chọn (checkbox) ở bảng chính — áp dụng trên MỌI trang/bộ lọc, giống
// hệt phạm vi của "Bỏ chọn tất cả" / "Cập nhật hàng loạt".
function selectedRowsForMarking() {
  return state.rawData.filter(r => state.exportSelected.has(r._rowId));
}
$('#btnMarkPrinted').addEventListener('click', () => {
  const rows = selectedRowsForMarking();
  if (!rows.length) return;
  markRowsPrinted(rows, true);
  toast(`Đã đánh dấu "Đã in" cho ${rows.length} xe.`);
});
$('#btnUnmarkPrinted').addEventListener('click', () => {
  const rows = selectedRowsForMarking();
  if (!rows.length) return;
  markRowsPrinted(rows, false);
  toast(`Đã bỏ đánh dấu "Đã in" cho ${rows.length} xe.`);
});

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
  if (e.target.closest('[data-role="row-status-select"], [data-role="row-note-input"], [data-role="row-commitment-select"], [data-role="row-assignee-select"]')) {
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
  const commitmentSelect = e.target.closest('[data-role="row-commitment-select"]');
  const assigneeSelect = e.target.closest('[data-role="row-assignee-select"]');
  if (!statusSelect && !noteInput && !commitmentSelect && !assigneeSelect) return;

  const rowId = (statusSelect || noteInput || commitmentSelect || assigneeSelect).dataset.rowid;
  const row = state.rawData.find(r => r._rowId === rowId);
  if (!row) return;

  if (statusSelect) {
    await updateSingleRowFields(row, { trangThaiXe: statusSelect.value });
  } else if (noteInput) {
    await updateSingleRowFields(row, { ghiChu: noteInput.value });
  } else if (commitmentSelect) {
    await updateSingleRowFields(row, { tinhTrangCamKet: commitmentSelect.value });
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
  if ($('#bulkCommitmentSelect')) $('#bulkCommitmentSelect').value = '';
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
  // Trường mới "Tình trạng cam kết" (bỏ trống = giữ nguyên).
  const commitmentEl = $('#bulkCommitmentSelect');
  const commitmentVal = commitmentEl ? commitmentEl.value : '';
  // Yêu cầu #5: cho phép gán "Người thực hiện" hàng loạt (bỏ trống = giữ nguyên).
  const bulkAssigneeEl = $('#bulkAssigneeSelect');
  const assigneeVal = (bulkAssigneeEl && bulkAssigneeEl.value !== ASSIGNEE_ADD_NEW_VALUE) ? bulkAssigneeEl.value : '';
  if (!statusVal && !noteVal && !commitmentVal && !assigneeVal) { toast('Chưa nhập Trạng thái xe, Ghi chú, Tình trạng cam kết hoặc Người thực hiện để cập nhật.', true); return; }

  const writeConnected = isWriteConnected();

  rows.forEach(r => {
    const newGhiChu = noteVal
      ? (mode === 'append' && r.ghiChu ? `${r.ghiChu}; ${noteVal}` : noteVal)
      : r.ghiChu;
    const updates = {};
    if (statusVal) { updates['Trạng thái xe'] = statusVal; r.trangThaiXe = statusVal; }
    if (noteVal) { updates['Ghi Chú'] = newGhiChu; r.ghiChu = newGhiChu; }
    if (commitmentVal) { updates['Tình trạng cam kết'] = commitmentVal; r.tinhTrangCamKet = commitmentVal; }
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
// Trường mới "Tình trạng cam kết" — nằm giữa Ghi chú và Người thực hiện.
function buildRowCommitmentSelectHtml(row) {
  const current = (row.tinhTrangCamKet || '').trim();
  // Nếu dữ liệu cũ có giá trị lạ (không nằm trong COMMITMENT_OPTIONS), vẫn
  // thêm nó vào option đầu để không làm mất dữ liệu hiện có (giống cách làm
  // của buildRowStatusSelectHtml()).
  const options = COMMITMENT_OPTIONS.includes(current) || !current ? COMMITMENT_OPTIONS : [current, ...COMMITMENT_OPTIONS];
  const optsHtml = [`<option value="">— Chưa cập nhật —</option>`]
    .concat(options.map(o => `<option value="${escapeHtml(o)}" ${o === current ? 'selected' : ''}>${escapeHtml(o)}</option>`))
    .join('');
  return `<select class="row-inline-select" data-role="row-commitment-select" data-rowid="${row._rowId}">${optsHtml}</select>`;
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
    const commitmentVal = $('#noteCommitmentSelect') ? $('#noteCommitmentSelect').value : '';
    row.ghiChu = $('#noteTextArea').value;
    const statusVal = $('#noteStatusSelect').value;
    if (statusVal) row.trangThaiXe = statusVal;
    if (commitmentVal) row.tinhTrangCamKet = commitmentVal;
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
    const commitmentVal = $('#noteCommitmentSelect') ? $('#noteCommitmentSelect').value : '';
    const assigneeVal = $('#noteAssigneeSelect') ? $('#noteAssigneeSelect').value : '';
    if (statusVal) updates['Trạng thái xe'] = statusVal;
    if (commitmentVal) updates['Tình trạng cam kết'] = commitmentVal;
    if (assigneeVal && assigneeVal !== ASSIGNEE_ADD_NEW_VALUE) updates['Người thực hiện'] = assigneeVal;

    row.ghiChu = updates['Ghi Chú'];
    if (statusVal) row.trangThaiXe = statusVal;
    if (updates['Tình trạng cam kết']) row.tinhTrangCamKet = updates['Tình trạng cam kết'];
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
        <th>Loại xe</th><th>Trạng thái</th><th>Ghi chú</th><th>Tình trạng cam kết</th><th>Người thực hiện</th>${extraCols || ''}
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
          <td>${buildRowCommitmentSelectHtml(r)}</td>
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
        <option value="Chưa liên hệ được">Chưa liên hệ được</option>
        <option value="Cần xác minh thêm">Cần xác minh thêm</option>
        <option value="Đã thực hiện thu hồi">Đã thực hiện thu hồi</option>
        <option value="Đã hoàn thành sang tên">Đã hoàn thành sang tên</option>
      </select>
      <textarea id="noteTextArea" placeholder="Ghi chú thêm...">${escapeHtml(row.ghiChu || existingNote.text || '')}</textarea>
      <label class="hint-label">Tình trạng cam kết</label>
      ${buildRowCommitmentSelectHtml(row).replace('class="row-inline-select"', 'class="row-inline-select" id="noteCommitmentSelect"')}
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
      if (e.target.closest('[data-role="row-status-select"], [data-role="row-note-input"], [data-role="row-commitment-select"], [data-role="row-assignee-select"], [data-confirm-owner]')) return;
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
  $('#detailBody').querySelectorAll('.mini-table [data-role="row-status-select"], .mini-table [data-role="row-note-input"], .mini-table [data-role="row-commitment-select"], .mini-table [data-role="row-assignee-select"]').forEach(el => {
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
      } else if (role === 'row-commitment-select') {
        await updateSingleRowFields(targetRow, { tinhTrangCamKet: target.value });
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
  // SỬA LỖI: ô nhập Mục III trước đây bị trùng id với ô Mục II (id="tplMucII")
  // trong index.html, nên $('#tplMucII') (querySelector, chỉ lấy phần tử ĐẦU
  // TIÊN khớp) luôn trả về đúng ô Mục II — ô Mục III không bao giờ được nạp
  // giá trị, và khi lưu (xem $('#btnSaveTemplate') bên dưới) mucIII cũng
  // không được đọc lại nên state.template.mucIII bị mất hẳn ("Nội dung Mục
  // III" người dùng gõ vào sẽ không bao giờ được lưu). Đã sửa id trong
  // index.html thành "tplMucIII" và bổ sung 2 dòng còn thiếu bên dưới.
  $('#tplMucIII').value = state.template.mucIII;
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
    mucIII: $('#tplMucIII').value,
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
  if (typeof ensureDocxLib === 'function') ensureDocxLib().catch(() => {}); // nạp sẵn thư viện Word
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

/* ---- 12b. THỂ THỨC BẢN CAM KẾT (dùng chung cho xem trước / in PDF / Word) ----
   Khổ A4, lề theo Nghị định 30/2020/NĐ-CP: trên 20mm, dưới 20mm, trái 30mm, phải 15mm
   => vùng nội dung rộng 165mm (= 9354 twips). Phông Times New Roman 13pt.
   Bảng luôn có tổng độ rộng = vùng nội dung nên KHÔNG tràn trang; ô dài tự xuống dòng. */
const DOC_TEXT_WIDTH = 9354; // twips (1mm ≈ 56.7 twips)
const DOC_TABLE_COLS = [ // tổng = DOC_TEXT_WIDTH
  { w: 640,  head: 'STT' },
  { w: 1400, head: 'Biển số' },
  { w: 3050, head: 'Loại xe, nhãn hiệu, số loại<br><span class="nb">(kèm Số khung / Số máy)</span>' },
  { w: 1500, head: 'GCNĐKX số;<br>cấp ngày' },
  { w: 1550, head: 'Tình trạng xe<br><span class="nb">(còn sử dụng / đã bán)</span>' },
  { w: 1214, head: 'Ghi chú' },
];

// CSS duy nhất của Bản cam kết: được nạp vào trang (xem trước) và chép vào iframe khi In/PDF.
const COMMITMENT_DOC_CSS = `
.doc-page{box-sizing:border-box;background:#fff;color:#000;width:210mm;min-height:297mm;margin:0 auto 20px;
  padding:20mm 15mm 20mm 30mm;box-shadow:0 2px 10px rgba(0,0,0,.15);
  font-family:'Times New Roman',Times,serif;font-size:13pt;line-height:1.3;}
.doc-page *{box-sizing:border-box;}
.doc-page:focus{outline:2px dashed #1e5fbf;outline-offset:4px;}
.doc-page u{text-decoration:underline;text-underline-offset:2px;}
.doc-quochieu{margin:0;text-align:center;font-weight:700;font-size:13pt;}
.doc-tieungu{margin:0;text-align:center;font-weight:700;font-size:14pt;}
.doc-title{margin:18pt 0 2pt;text-align:center;font-weight:700;font-size:14pt;}
.doc-trichyeu{margin:0 auto;max-width:125mm;text-align:center;font-weight:700;}
.doc-rule{width:40mm;margin:4pt auto 12pt;border-top:1px solid #000;height:0;}
.doc-kinhgui{margin:6pt 0 8pt;text-align:center;font-weight:700;}
.doc-p{margin:0 0 4pt;text-align:justify;text-indent:10mm;orphans:2;widows:2;}
.doc-heading{margin:8pt 0 3pt;text-align:justify;font-weight:700;break-after:avoid;page-break-after:avoid;}
.doc-fline{display:flex;align-items:baseline;gap:4mm;margin:0 0 3pt;}
.doc-fline .f{display:flex;align-items:baseline;flex:1 1 0;min-width:0;}
.doc-fline .l{white-space:nowrap;padding-right:2mm;}
.doc-fline .v{flex:1 1 auto;min-width:8mm;min-height:1.3em;padding:0 1mm;border-bottom:1px dotted #000;overflow-wrap:anywhere;}
.doc-fline .v:focus,.doc-table td:focus{outline:1px dashed #1e5fbf;}
table.doc-table{width:100%;table-layout:fixed;border-collapse:collapse;margin:6pt 0 10pt;font-size:11pt;line-height:1.25;}
table.doc-table th,table.doc-table td{border:1px solid #000;padding:1.2mm 1.8mm;vertical-align:top;
  overflow-wrap:anywhere;word-break:break-word;text-align:left;}
table.doc-table th{background:#f2f2f2;text-align:center;vertical-align:middle;font-weight:700;}
table.doc-table td.c{text-align:center;}
table.doc-table .nb{font-weight:400;}
table.doc-table .sub{font-size:10pt;}
table.doc-table thead{display:table-header-group;}
table.doc-table tr{break-inside:avoid;page-break-inside:avoid;}
.doc-sign{display:flex;justify-content:flex-end;margin-top:12pt;break-inside:avoid;page-break-inside:avoid;}
.doc-sign-block{width:75mm;text-align:center;}
.doc-sign-block .doc-bold{font-weight:700;}
.doc-sign-block .doc-italic{font-style:italic;}
.doc-sign-block .sign-space{height:26mm;}
`;
// Riêng khi in: bỏ khung giấy giả lập; lề do @page đảm nhiệm nên không bị tràn / mất lề.
const COMMITMENT_PRINT_CSS = `
@page{size:A4;margin:20mm 15mm 20mm 30mm;}
html,body{margin:0;padding:0;background:#fff;}
.doc-page{width:auto;min-height:0;margin:0;padding:0;box-shadow:none;break-after:page;page-break-after:always;}
.doc-page:last-child{break-after:auto;page-break-after:auto;}
`;
(function injectCommitmentCss() {
  const st = document.createElement('style');
  st.id = 'commitmentDocCss';
  st.textContent = COMMITMENT_DOC_CSS;
  document.head.appendChild(st);
})();

// Ghép nhiều dòng nội dung (textarea) thành các đoạn văn đánh số 1., 2., 3. ...
function multilineToFieldLines(text) {
  return (text || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map((line, i) => `<div class="doc-p">${i + 1}. ${escapeHtml(line)}</div>`).join('');
}

// Một dòng điền thông tin: [{label, value}, ...]. Giá trị đặt trên đường chấm chấm (gạch chân).
function docFieldLine(fields) {
  return `<div class="doc-fline">${fields.map(f =>
    `<span class="f"><span class="l">${escapeHtml(f.label)}</span><span class="v" contenteditable="true">${escapeHtml(f.value || '')}</span></span>`
  ).join('')}</div>`;
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

  const colsHtml = DOC_TABLE_COLS.map(c => `<col style="width:${(c.w / DOC_TEXT_WIDTH * 100).toFixed(2)}%">`).join('');
  const headHtml = DOC_TABLE_COLS.map(c => `<th>${c.head}</th>`).join('');
  const rowsHtml = doc.vehicles.map((v, i) => {
    const kind = [v.loaiXe, v.nhanHieu].filter(Boolean).map(escapeHtml).join(' - ');
    return `<tr>` +
      `<td class="c">${i + 1}</td>` +
      `<td>${escapeHtml(v.bienSo)}</td>` +
      `<td>${kind}<br><span class="sub">Số khung: ${escapeHtml(v.soKhung) || '…'}</span><br><span class="sub">Số máy: ${escapeHtml(v.soMay) || '…'}</span></td>` +
      `<td>Số: ............<br>Ngày: ..........</td>` +
      `<td>${escapeHtml(v.trangThaiXe) || '..........'}</td>` +
      `<td>${escapeHtml(v.ghiChu) || '..........'}</td>` +
      `</tr>`;
  }).join('');

  wrapper.innerHTML =
    `<div class="doc-quochieu">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>` +
    `<div class="doc-tieungu"><u>Độc lập - Tự do - Hạnh phúc</u></div>` +
    `<div class="doc-title">BẢN CAM KẾT</div>` +
    `<div class="doc-trichyeu">Về việc kê khai, xác nhận tình trạng phương tiện và cam kết trách nhiệm đối với phương tiện đứng tên sở hữu</div>` +
    `<div class="doc-rule"></div>` +
    `<div class="doc-kinhgui">${escapeHtml(tpl.kinhGui)}</div>` +
    `<div class="doc-p">Tên tôi là (chủ xe đứng tên trong Giấy chứng nhận đăng ký xe):</div>` +
    docFieldLine([{ label: 'Họ và tên:', value: doc.chuXe }]) +
    docFieldLine([{ label: 'Ngày, tháng, năm sinh:', value: '' }]) +
    docFieldLine([{ label: 'Số CCCD/Mã định danh cá nhân:', value: doc.cccd }]) +
    docFieldLine([{ label: 'Ngày cấp:', value: '' }, { label: 'Nơi cấp:', value: '' }]) +
    docFieldLine([{ label: 'Địa chỉ thường trú:', value: doc.diaChi }]) +
    docFieldLine([{ label: 'Số điện thoại liên hệ:', value: doc.phones }]) +
    `<div class="doc-p">Là chủ sở hữu phương tiện có thông tin như sau:</div>` +
    `<table class="doc-table"><colgroup>${colsHtml}</colgroup><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>` +
    `<div class="doc-p">Nay tôi làm Bản cam kết này để kê khai, xác nhận tình trạng phương tiện nêu trên và cam đoan, chịu trách nhiệm về các nội dung sau đây (đối chiếu theo tình trạng từng xe đã kê khai tại cột "Tình trạng xe" nêu trên):</div>` +
    `<div class="doc-heading">I. Đối với phương tiện <u>đã bán/chuyển nhượng/cho/tặng</u> nhưng không xác định được thông tin người mua/người đang sử dụng xe:</div>` +
    (soldPlates ? docFieldLine([{ label: 'Các phương tiện liên quan có biển số:', value: soldPlates }]) : '') +
    multilineToFieldLines(tpl.mucI) +
    `<div class="doc-heading">II. Đối với phương tiện <u>hư hỏng, không còn hoạt động hoặc bị mất</u>:</div>` +
    multilineToFieldLines(tpl.mucII) +
    `<div class="doc-heading">III. Đối với phương tiện <u>còn đang sử dụng</u> (ngoài những phương tiện ở mục I và mục II):</div>` +
    multilineToFieldLines(tpl.mucIII) +
    `<div class="doc-p">${escapeHtml(tpl.camDoan)}</div>` +
    `<div class="doc-sign"><div class="doc-sign-block">` +
      `<div class="doc-italic">${escapeHtml(tpl.diaDanh)}, ngày ..... tháng ..... năm ..........</div>` +
      `<div class="doc-bold">NGƯỜI CAM KẾT</div>` +
      `<div class="doc-italic">(Ký, ghi rõ họ tên)</div>` +
      `<div class="sign-space"></div>` +
    `</div></div>`;
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

// In / Xuất PDF: dựng bản in trong iframe ẩn (khổ A4 + @page lề chuẩn). Không in trực tiếp từ
// cửa sổ modal vì modal bị giới hạn chiều cao/overflow nên nội dung bị cắt và tràn trang.
function printCommitments() {
  const pages = $all('.doc-page', $('#commitmentContainer'));
  if (!pages.length) { toast('Chưa có bản cam kết nào để in.', true); return; }
  const body = pages.map(p => {
    const c = p.cloneNode(true); // lấy đúng nội dung người dùng đã chỉnh sửa
    c.removeAttribute('contenteditable'); c.removeAttribute('data-doc-index');
    c.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
    return c.outerHTML;
  }).join('');
  const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Bản cam kết</title>` +
    `<style>${COMMITMENT_DOC_CSS}${COMMITMENT_PRINT_CSS}</style></head><body>${body}</body></html>`;

  const old = document.getElementById('commitmentPrintFrame');
  if (old) old.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'commitmentPrintFrame';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;left:-99999px;top:0;border:0;width:210mm;height:297mm;';
  iframe.onload = () => {
    const w = iframe.contentWindow;
    const go = () => {
      w.onafterprint = () => setTimeout(() => iframe.remove(), 500);
      w.focus(); w.print();
    };
    if (w.document.fonts && w.document.fonts.ready) w.document.fonts.ready.then(() => setTimeout(go, 50)); else setTimeout(go, 100);
  };
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
}
$('#btnPrint').addEventListener('click', printCommitments);

/* ---------------------------- 13. TẢI VỀ WORD (.docx) ----------------------- */
// Lỗi cũ: index.html trỏ tới docx@8.5.0/build/index.js — file này KHÔNG tồn tại trong gói docx 8.5.0
// (bản chạy trên trình duyệt là build/index.umd.js) nên thư viện không bao giờ nạp được.
// Nay: nạp theo yêu cầu, ưu tiên bản đặt cùng ứng dụng (lib/docx.umd.js, dùng được khi offline),
// nếu thiếu thì thử lần lượt các CDN.
const DOCX_SOURCES = [
  'lib/docx.umd.js',
  'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js',
  'https://unpkg.com/docx@8.5.0/build/index.umd.js',
];
let docxLoadPromise = null;
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => (typeof docx !== 'undefined' && docx.Packer) ? resolve() : reject(new Error('Không nhận ra thư viện: ' + src));
    s.onerror = () => { s.remove(); reject(new Error('Không tải được: ' + src)); };
    document.head.appendChild(s);
  });
}
function ensureDocxLib() {
  if (typeof docx !== 'undefined' && docx.Packer) return Promise.resolve();
  if (!docxLoadPromise) {
    docxLoadPromise = (async () => {
      for (const src of DOCX_SOURCES) {
        try { await loadScriptOnce(src); return; } catch (e) { console.warn(e.message); }
      }
      throw new Error('docx-load-failed');
    })().catch(err => { docxLoadPromise = null; throw err; }); // cho phép thử lại lần sau
  }
  return docxLoadPromise;
}

$('#btnDownloadWord').addEventListener('click', async () => {
  const pages = $all('.doc-page', $('#commitmentContainer'));
  if (!pages.length) { toast('Chưa có bản cam kết nào để tải.', true); return; }
  toast('Đang tạo file Word...');
  try { await ensureDocxLib(); }
  catch (e) { toast('Không tải được thư viện docx. Hãy kiểm tra kết nối mạng hoặc đặt file lib/docx.umd.js cạnh index.html.', true); return; }
  let okCount = 0;
  for (let i = 0; i < pages.length; i++) {
    try {
      const doc = buildDocxFromPage(pages[i]);
      const blob = await docx.Packer.toBlob(doc);
      const ownerName = (state.commitmentDocs[i] && state.commitmentDocs[i].chuXe) || `BanCamKet_${i + 1}`;
      downloadBlob(blob, `BanCamKet_${sanitizeFilename(ownerName)}.docx`);
      okCount++;
      await new Promise(res => setTimeout(res, 500));
    } catch (err) {
      console.error(err);
      toast('Lỗi khi tạo file Word cho bản #' + (i + 1), true);
    }
  }
  // Đánh dấu "đã xuất bản cam kết" ngược về Sheet (nếu đang ở chế độ 2 chiều).
  if (okCount) await markExportedOnSheet();
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

// Tách nội dung inline của 1 node thành các "dòng", mỗi dòng gồm các đoạn {text,b,i,u,size}.
// Nhận biết <b>/<strong>, <i>/<em>, <u>; <br> hoặc <div>/<p> lồng nhau (do người dùng nhấn Enter
// khi chỉnh sửa) tạo dòng mới.
function docxInlineLines(node, base) {
  const lines = [[]];
  const cur = () => lines[lines.length - 1];
  const walk = (n, fmt) => {
    n.childNodes.forEach(ch => {
      if (ch.nodeType === 3) {
        const t = ch.nodeValue.replace(/[\s\u00a0]+/g, ' ');
        if (t) cur().push({ text: t, b: fmt.b, i: fmt.i, u: fmt.u, size: fmt.size });
      } else if (ch.nodeType === 1) {
        const tag = ch.tagName.toLowerCase();
        if (tag === 'br') { lines.push([]); return; }
        const f = { ...fmt };
        if (tag === 'b' || tag === 'strong') f.b = true;
        if (tag === 'i' || tag === 'em') f.i = true;
        if (tag === 'u') f.u = true;
        if (ch.classList.contains('nb')) f.b = false;
        if (ch.classList.contains('sub')) f.size = 20;
        const block = tag === 'div' || tag === 'p';
        if (block && cur().length) lines.push([]);
        walk(ch, f);
        if (block && cur().length) lines.push([]);
      }
    });
  };
  walk(node, base);
  // Cắt khoảng trắng đầu/cuối dòng, bỏ dòng rỗng ở hai đầu.
  lines.forEach(l => {
    if (l.length) { l[0].text = l[0].text.replace(/^\s+/, ''); l[l.length - 1].text = l[l.length - 1].text.replace(/\s+$/, ''); }
  });
  const clean = lines.map(l => l.filter(p => p.text));
  while (clean.length && !clean[0].length) clean.shift();
  while (clean.length && !clean[clean.length - 1].length) clean.pop();
  return clean;
}

function buildDocxFromPage(pageEl) {
  const D = docx;
  const { Document, Paragraph, TextRun, AlignmentType, Tab, TabStopType, LeaderType, BorderStyle, UnderlineType } = D;
  const W = DOC_TEXT_WIDTH;
  const children = [];

  const toRuns = (line, defSize) => line.map(p => new TextRun({
    text: p.text, bold: !!p.b, italics: !!p.i, size: p.size || defSize,
    underline: p.u ? { type: UnderlineType.SINGLE } : undefined,
  }));

  // Dựng các Paragraph từ 1 node HTML theo tuỳ chọn định dạng.
  const addBlock = (node, o) => {
    const lines = docxInlineLines(node, { b: !!o.bold, i: !!o.italics, u: false, size: o.size });
    lines.forEach((line, idx) => {
      const indent = {};
      if (o.firstLine && idx === 0) indent.firstLine = o.firstLine;
      if (o.left) indent.left = o.left;
      if (o.right) indent.right = o.right;
      children.push(new Paragraph({
        alignment: o.alignment,
        keepNext: !!o.keepNext,
        keepLines: true,
        indent,
        spacing: { before: idx === 0 ? (o.before || 0) : 0, after: idx === lines.length - 1 ? (o.after ?? 80) : 0 },
        children: toRuns(line, o.size),
      }));
    });
    return lines.length;
  };

  Array.from(pageEl.children).forEach(node => {
    const cl = node.classList;
    if (node.tagName.toLowerCase() === 'table') {
      children.push(buildDocxTable(node, D));
      children.push(new Paragraph({ spacing: { before: 0, after: 60 }, children: [] }));
      return;
    }
    if (cl.contains('doc-rule')) { // đường kẻ ngắn dưới trích yếu
      const side = Math.round((W - 2268) / 2); // 40mm
      children.push(new Paragraph({
        indent: { left: side, right: side },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: '000000' } },
        spacing: { before: 0, after: 200 }, children: [],
      }));
      return;
    }
    if (cl.contains('doc-fline')) { // dòng điền: nhãn + giá trị (gạch chân) + đường chấm chấm tới hết dòng
      const fields = Array.from(node.querySelectorAll('.f')).map(f => ({
        label: (f.querySelector('.l')?.textContent || '').replace(/\s+/g, ' ').trim(),
        value: (f.querySelector('.v')?.textContent || '').replace(/\s+/g, ' ').trim(),
      }));
      const n = fields.length || 1;
      const runs = [];
      fields.forEach((f, k) => {
        runs.push(new TextRun({ text: (k ? ' ' : '') + f.label + ' ' }));
        if (f.value) runs.push(new TextRun({ text: f.value, underline: { type: UnderlineType.DOTTED } }));
        runs.push(new TextRun({ children: [new Tab()] }));
      });
      children.push(new Paragraph({
        spacing: { before: 0, after: 60 },
        tabStops: fields.map((_, k) => ({
          type: k === n - 1 ? TabStopType.RIGHT : TabStopType.LEFT,
          position: Math.round(W * (k + 1) / n), leader: LeaderType.DOT,
        })),
        children: runs,
      }));
      return;
    }
    if (cl.contains('doc-sign')) { // khối chữ ký: căn giữa trong khối 75mm nằm bên phải
      const left = W - 4250;
      const kids = Array.from(node.querySelectorAll('.doc-sign-block > div')).filter(c => !c.classList.contains('sign-space'));
      kids.forEach((c, idx) => addBlock(c, {
        alignment: AlignmentType.CENTER, left, keepNext: true, before: idx === 0 ? 240 : 0, after: 0,
        bold: c.classList.contains('doc-bold'), italics: c.classList.contains('doc-italic'),
      }));
      for (let k = 0; k < 4; k++) {
        children.push(new Paragraph({ keepNext: k < 3, spacing: { before: 0, after: 0 }, children: [] }));
      }
      return;
    }
    if (cl.contains('doc-quochieu')) { addBlock(node, { alignment: AlignmentType.CENTER, bold: true, after: 0 }); return; }
    if (cl.contains('doc-tieungu'))  { addBlock(node, { alignment: AlignmentType.CENTER, bold: true, size: 28, after: 0 }); return; }
    if (cl.contains('doc-title'))    { addBlock(node, { alignment: AlignmentType.CENTER, bold: true, size: 28, before: 360, after: 40 }); return; }
    if (cl.contains('doc-trichyeu')) { addBlock(node, { alignment: AlignmentType.CENTER, bold: true, after: 0, left: 1400, right: 1400 }); return; }
    if (cl.contains('doc-kinhgui'))  { addBlock(node, { alignment: AlignmentType.CENTER, bold: true, before: 120, after: 120 }); return; }
    if (cl.contains('doc-heading'))  { addBlock(node, { alignment: AlignmentType.JUSTIFIED, bold: true, before: 160, after: 60, keepNext: true }); return; }
    if (cl.contains('doc-p'))        { addBlock(node, { alignment: AlignmentType.JUSTIFIED, firstLine: 567, after: 80 }); return; }
    // Khối do người dùng tự thêm khi chỉnh sửa
    const added = addBlock(node, { alignment: AlignmentType.JUSTIFIED, after: 80 });
    if (!added && node.querySelector('br')) children.push(new Paragraph({ children: [] }));
  });

  return new Document({
    creator: 'Quản lý Phương tiện',
    title: 'Bản cam kết',
    styles: { default: { document: { run: { font: 'Times New Roman', size: 26 }, paragraph: { spacing: { line: 312 } } } } },
    sections: [{
      properties: { page: {
        size: { width: 11906, height: 16838 }, // A4
        margin: { top: 1134, bottom: 1134, left: 1701, right: 851 }, // 20 / 20 / 30 / 15 mm
      } },
      children,
    }],
  });
}

function buildDocxTable(tableEl, D) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, AlignmentType, WidthType, ShadingType, VerticalAlign, TableLayoutType, UnderlineType } = D;
  const colWidths = DOC_TABLE_COLS.map(c => c.w); // tổng = bề rộng vùng nội dung => không tràn trang
  const rows = Array.from(tableEl.querySelectorAll('tr')).map(tr => {
    const isHeader = tr.parentElement.tagName.toLowerCase() === 'thead';
    const cells = Array.from(tr.children).slice(0, colWidths.length).map((td, ci) => {
      const lines = docxInlineLines(td, { b: isHeader, i: false, u: false, size: 22 });
      const centered = isHeader || td.classList.contains('c');
      const paras = (lines.length ? lines : [[]]).map(line => new Paragraph({
        alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: 0, after: 0, line: 260 },
        children: line.map(p => new TextRun({
          text: p.text, bold: !!p.b, italics: !!p.i, size: p.size || 22,
          underline: p.u ? { type: UnderlineType.SINGLE } : undefined,
        })),
      }));
      return new TableCell({
        width: { size: colWidths[ci], type: WidthType.DXA },
        verticalAlign: isHeader ? VerticalAlign.CENTER : VerticalAlign.TOP,
        shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } : undefined,
        children: paras,
      });
    });
    return new TableRow({ cantSplit: true, tableHeader: isHeader, children: cells });
  });
  return new Table({
    width: { size: DOC_TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: colWidths,
    layout: TableLayoutType.FIXED,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    rows,
  });
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
