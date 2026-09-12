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
];
// Cột dùng để khớp dòng khi ghi ngược về Sheet, theo thứ tự ưu tiên.
const MATCH_KEY_PRIORITY = ['maId', 'motoId', 'bienSo'];
// Tên cột trên Sheet dùng để đánh dấu đã xuất bản cam kết (tự tạo nếu Sheet chưa có).
const EXPORT_FLAG_HEADER = 'Ngày xuất cam kết';

const FILTER_FIELDS = ['bienSo', 'cccd', 'chuXe', 'diaChi', 'trangThaiXe'];
const FILTER_LABELS = {
  bienSo: 'Biển số', cccd: 'Số CCCD/MST', chuXe: 'Chủ phương tiện',
  diaChi: 'Địa chỉ / Phường-Xã', trangThaiXe: 'Trạng thái xe'
};

const NOTES_KEY = 'vehicleNotesV1';
const LAST_URL_KEY = 'vehicleLastSheetCsvUrl';
const GAS_URL_KEY = 'vehicleGasUrl';
const MODE_KEY = 'vehicleConnectMode'; // 'gas' | 'csv'
const TEMPLATE_KEY = 'vehicleCommitmentTemplateV1';

const DEFAULT_TEMPLATE = {
  kinhGui: 'Kính gửi: Công an xã/phường .....................................',
  diaDanh: '.......',
  mucI:
`Tôi đã bán/chuyển nhượng/cho/tặng (chuyển quyền sở hữu) các phương tiện có biển số nêu trên cho người khác.
Hiện nay tôi không xác định được thông tin (họ tên, địa chỉ, số điện thoại) của người đã mua hoặc người đang quản lý, sử dụng phương tiện nêu trên.
Tôi xin cam kết kể từ thời điểm chuyển quyền sở hữu phương tiện nêu trên, tôi không còn quyền liên quan đến việc quản lý, sử dụng phương tiện; mọi trách nhiệm phát sinh liên quan đến phương tiện sau thời điểm chuyển quyền sở hữu không thuộc trách nhiệm của tôi.`,
  mucII:
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
function uniq(arr) { return Array.from(new Set(arr.filter(v => v && v.trim() !== ''))); }

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

document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) closeModal(closeBtn.dataset.close);
  if (e.target.classList.contains('modal-overlay')) e.target.classList.add('hidden');
});

function escapeHtml(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  $('#gasUrlInput').value = localStorage.getItem(GAS_URL_KEY) || '';
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

// Ghi một hoặc nhiều trường của 1 dòng ngược về Google Sheet (yêu cầu chế độ 'gas').
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

/* ---------------------------- 5. XỬ LÝ DỮ LIỆU ĐỌC VÀO ---------------------- */
function processRows(rows) {
  const sampleHeaders = Object.keys(rows[0] || {});
  const headerToKey = {};
  sampleHeaders.forEach(h => {
    const norm = normalizeHeader(h);
    const match = FIELD_MAP.find(f => normalizeHeader(f.header) === norm);
    if (match) headerToKey[h] = match.key;
  });

  state.rawData = rows.map((r, i) => {
    const obj = { _rowId: 'r' + i };
    FIELD_MAP.forEach(f => { obj[f.key] = ''; });
    Object.keys(r).forEach(h => {
      const key = headerToKey[h];
      if (key) obj[key] = (r[h] || '').toString().trim();
    });
    return obj;
  }).filter(r => r.bienSo || r.soKhung || r.chuXe || r.cccd);

  state.filters = Object.fromEntries(FILTER_FIELDS.map(f => [f, new Set()]));
  state.exportSelected = new Set();
  state.page = 1;
  refreshAll();
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
      } else {
        if (!set.has(row[key])) return false;
      }
    }
    return true;
  });
}

function getOptionsFor(field) {
  const data = getFiltered(field);
  const set = new Set();
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

function renderMultiSelect(field) {
  const container = $(`.ms-control[data-field="${field}"]`);
  if (!container) return;
  const ui = state.msUI[field];
  const selected = state.filters[field];
  const allOptions = getOptionsFor(field);
  const searchLower = ui.search.trim().toLowerCase();
  const visibleOptions = searchLower
    ? allOptions.filter(o => o.toLowerCase().includes(searchLower))
    : allOptions;

  const chipsHtml = Array.from(selected).map(v => `
    <span class="ms-chip" data-value="${escapeHtml(v)}">
      ${escapeHtml(v)}<span class="x" data-remove="${escapeHtml(v)}">✕</span>
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
            <input type="checkbox" ${selected.has(o) ? 'checked' : ''}> ${escapeHtml(o)}
          </div>`).join('');
    }
    dropdownHtml = `<div class="ms-dropdown">${optsHtml}</div>`;
  }

  container.innerHTML = `
    <div class="ms-input-box">
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
  state.msUI[field].open = true;
  refreshFilterUIs();
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
  const matches = getOptionsFor(field).filter(o => o.toLowerCase().includes(search));
  matches.forEach(m => state.filters[field].add(m));
  state.msUI[field].search = '';
  state.page = 1;
  refreshFilterUIs();
  renderTable();
});
filterBar.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  const option = e.target.closest('.ms-option');
  const control = e.target.closest('.ms-control');
  if (!control) return;
  const field = control.dataset.field;

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
  state.page = 1;
  refreshFilterUIs(); renderTable();
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

function renderTable() {
  const filtered = getFiltered(null);
  $('#filteredCount').textContent = `${filtered.length} / ${state.rawData.length} dòng`;

  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);

  const tbody = $('#tableBody');
  if (!pageRows.length) {
    tbody.innerHTML = `<tr><td colspan="14" class="empty-state">Không có dòng nào khớp bộ lọc.</td></tr>`;
  } else {
    tbody.innerHTML = pageRows.map(row => `
      <tr data-rowid="${row._rowId}" class="${state.exportSelected.has(row._rowId) ? 'selected-row' : ''}">
        <td class="col-chk"><input type="checkbox" data-role="row-chk" ${state.exportSelected.has(row._rowId) ? 'checked' : ''}></td>
        <td>${escapeHtml(row.stt)}</td>
        <td>${escapeHtml(row.bienSo)}</td>
        <td>${escapeHtml(row.soKhung)}</td>
        <td>${escapeHtml(row.soMay)}</td>
        <td>${escapeHtml(row.nhanHieu)}</td>
        <td>${escapeHtml(row.loaiXe)}</td>
        <td>${escapeHtml(row.chuXe)}</td>
        <td>${escapeHtml(row.cccd)}</td>
        <td>${escapeHtml(row.diaChi)}</td>
        <td>${escapeHtml(row.phuongXaMoi)}</td>
        <td>${escapeHtml(row.trangThaiXe)}</td>
        <td>${escapeHtml(row.ngayDangKy)}</td>
        <td>${escapeHtml(row.soDienThoai)}</td>
      </tr>
    `).join('');
  }

  renderPagination(totalPages, filtered.length);
  updateSelectedCount();
  updateSelectAllPageCheckbox(pageRows);
}

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
}
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
  openDetailPanel(rowId);
});

/* ---------------------------- 8. GHI CHÚ / TRẠNG THÁI CỤC BỘ ---------------- */
function loadNotesStore() {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch (e) { return {}; }
}
function saveNoteFor(ownerKey, data) {
  const store = loadNotesStore();
  store[ownerKey] = { ...data, updatedAt: new Date().toISOString() };
  localStorage.setItem(NOTES_KEY, JSON.stringify(store));
}

/* ---------------------------- 9. FUZZY MATCHING (4 MỤC) -------------------- */
const NAME_FUZZY_MAX_DIST = 2;
const NUMBER_FUZZY_MAX_DIST = 2;

function vehicleKey(v) { return v.motoId || v.maId || v._rowId; }

// Tính 4 mục đối chiếu cho một chủ xe, dựa trên xe hiện đang xem (`vehicle`).
function computeOwnerSections(vehicle) {
  const all = state.rawData;
  const cccd = (vehicle.cccd || '').trim();
  const nameNorm = normalizeName(vehicle.chuXe);
  const nameStripped = stripDiacritics(vehicle.chuXe);

  // Mục I: tất cả xe cùng Số CCCD (xe chính thức của người đó).
  const sectionI = cccd
    ? all.filter(v => (v.cccd || '').trim() === cccd)
    : [vehicle];

  // Mục II: xe của người trùng họ tên chính xác nhưng khác Số CCCD.
  const sectionII = nameNorm
    ? all.filter(v => normalizeName(v.chuXe) === nameNorm && (v.cccd || '').trim() !== cccd)
    : [];

  // Mục III: xe của người có họ tên gần đúng (fuzzy — sai dấu/chữ lót/chính tả nhẹ),
  // loại trừ những xe đã thuộc Mục I hoặc Mục II.
  const usedAfterII = new Set([...sectionI, ...sectionII].map(vehicleKey));
  const sectionIII = nameStripped ? all.filter(v => {
    if (usedAfterII.has(vehicleKey(v))) return false;
    const vStripped = stripDiacritics(v.chuXe);
    if (!vStripped) return false;
    if (Math.abs(vStripped.length - nameStripped.length) > NAME_FUZZY_MAX_DIST) return false;
    const dist = levenshtein(vStripped, nameStripped);
    return dist > 0 && dist <= NAME_FUZZY_MAX_DIST;
  }) : [];

  // Mục IV: xe có Số khung hoặc Số máy gần đúng (sai 1–2 ký tự) với các xe
  // trong danh sách (Mục I) của người này, loại trừ Mục I–III.
  const usedAfterIII = new Set([...sectionI, ...sectionII, ...sectionIII].map(vehicleKey));
  const ownNumbers = uniq(sectionI.flatMap(v => [
    (v.soKhung || '').trim().toUpperCase(),
    (v.soMay || '').trim().toUpperCase()
  ]));
  const sectionIV = ownNumbers.length ? all.filter(v => {
    if (usedAfterIII.has(vehicleKey(v))) return false;
    const sk = (v.soKhung || '').trim().toUpperCase();
    const sm = (v.soMay || '').trim().toUpperCase();
    return ownNumbers.some(own => {
      if (sk && Math.abs(sk.length - own.length) <= NUMBER_FUZZY_MAX_DIST) {
        const d = levenshtein(sk, own);
        if (d > 0 && d <= NUMBER_FUZZY_MAX_DIST) return true;
      }
      if (sm && Math.abs(sm.length - own.length) <= NUMBER_FUZZY_MAX_DIST) {
        const d = levenshtein(sm, own);
        if (d > 0 && d <= NUMBER_FUZZY_MAX_DIST) return true;
      }
      return false;
    });
  }) : [];

  return { sectionI, sectionII, sectionIII, sectionIV };
}

/* ---------------------------- 10. PANEL CHI TIẾT CHỦ XE --------------------- */
function openDetailPanel(rowId) {
  const row = state.rawData.find(r => r._rowId === rowId);
  if (!row) return;
  renderDetailPanelFor(row);
  openModal('detailOverlay');
}

function renderDetailPanelFor(row) {
  const cccd = row.cccd;
  const chuXe = row.chuXe;
  const ownerKey = cccd || ('name:' + normalizeName(chuXe));

  const { sectionI, sectionII, sectionIII, sectionIV } = computeOwnerSections(row);
  const phones = uniq(sectionI.map(r => r.soDienThoai)).join(' | ') || '—';
  const addr = uniq(sectionI.map(r => r.diaChi)).join(' | ') || '—';

  const notesStore = loadNotesStore();
  const existingNote = notesStore[ownerKey] || { status: '', text: '' };

  const miniTable = (rows, extraCols, extraCellsFn, cssClass) => rows.length ? `
    <table class="mini-table">
      <thead><tr>
        <th class="col-chk-mini"></th>
        <th>Biển số</th><th>Chủ xe</th><th>Số CCCD</th><th>Số khung</th><th>Số máy</th>
        <th>Loại xe</th><th>Trạng thái</th>${extraCols || ''}
      </tr></thead>
      <tbody>
        ${rows.map(r => `<tr data-rowid="${r._rowId}" class="${cssClass || ''}">
          <td class="col-chk-mini"><input type="checkbox" data-role="mini-chk" data-rowid="${r._rowId}" ${state.exportSelected.has(r._rowId) ? 'checked' : ''}></td>
          <td>${escapeHtml(r.bienSo)}</td><td>${escapeHtml(r.chuXe)}</td><td>${escapeHtml(r.cccd) || '—'}</td>
          <td>${escapeHtml(r.soKhung)}</td><td>${escapeHtml(r.soMay)}</td>
          <td>${escapeHtml(r.loaiXe)}</td><td>${escapeHtml(r.trangThaiXe)}</td>
          ${extraCellsFn ? extraCellsFn(r) : ''}
        </tr>`).join('')}
      </tbody>
    </table>` : `<p class="hint">Không tìm thấy trường hợp phù hợp.</p>`;

  const bodyHtml = `
    <div class="owner-card">
      <div class="row"><b>Họ và tên:</b> ${escapeHtml(chuXe) || '—'}</div>
      <div class="row"><b>Số CCCD/MST:</b> ${escapeHtml(cccd) || '—'}</div>
      <div class="row"><b>Địa chỉ:</b> ${escapeHtml(addr)}</div>
      <div class="row"><b>Số điện thoại:</b> ${escapeHtml(phones)}</div>
    </div>

    <div class="section-title">I. Xe cùng Số CCCD (xe chính thức) <span class="tag-count">${sectionI.length}</span></div>
    ${miniTable(sectionI)}

    <div class="section-title">II. Xe của người trùng họ tên, khác Số CCCD <span class="tag-count">${sectionII.length}</span></div>
    <div class="section-desc">Có thể là cùng một người kê khai CCCD khác nhau, hoặc trùng tên ngẫu nhiên — cần đối chiếu thêm.</div>
    ${miniTable(sectionII, null, null, 'diff-cccd')}

    <div class="section-title">III. Xe của người có họ tên gần đúng (nghi sai dấu/chính tả) <span class="tag-count">${sectionIII.length}</span></div>
    <div class="section-desc">So khớp gần đúng (bỏ dấu, cho phép lệch tối đa ${NAME_FUZZY_MAX_DIST} ký tự) với "${escapeHtml(chuXe)}".</div>
    ${miniTable(sectionIII, null, null, 'fuzzy-name')}

    <div class="section-title">IV. Xe có Số khung/Số máy gần đúng với xe của người này <span class="tag-count">${sectionIV.length}</span></div>
    <div class="section-desc">Số khung/số máy lệch tối đa ${NUMBER_FUZZY_MAX_DIST} ký tự so với các xe ở Mục I — nghi ngờ nhập liệu sai hoặc trùng khung/máy.</div>
    ${miniTable(sectionIV, null, null, 'fuzzy-number')}

    <div class="section-title">Cập nhật Trạng thái xe / Ghi chú</div>
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
      <div class="sync-row">
        <button id="btnSaveNoteLocal" class="btn btn-ghost btn-sm">💾 Lưu tạm (trình duyệt)</button>
        <button id="btnSaveNoteSheet" class="btn btn-primary btn-sm" ${state.mode !== 'gas' ? 'disabled title="Cần kết nối chế độ Apps Script (2 chiều)"' : ''}>⬆️ Lưu về Google Sheet</button>
      </div>
      <div class="sync-note">${state.mode === 'gas' ? 'Đã kết nối 2 chiều — có thể ghi trực tiếp về Sheet.' : 'Đang ở chế độ chỉ đọc (CSV) — chỉ lưu tạm trên trình duyệt này. Kết nối Apps Script để ghi về Sheet.'}</div>
    </div>
  `;
  $('#detailBody').innerHTML = bodyHtml;
  $('#noteStatusSelect').value = '';

  const doSaveLocal = () => {
    saveNoteFor(ownerKey, {
      status: $('#noteStatusSelect').value || row.trangThaiXe,
      text: $('#noteTextArea').value
    });
    toast('Đã lưu ghi chú tạm trên trình duyệt.');
  };
  $('#btnSaveNoteLocal').addEventListener('click', doSaveLocal);

  const btnSheet = $('#btnSaveNoteSheet');
  if (btnSheet) {
    btnSheet.addEventListener('click', async () => {
      const updates = { 'Ghi Chú': $('#noteTextArea').value };
      const statusVal = $('#noteStatusSelect').value;
      if (statusVal) updates['Trạng thái xe'] = statusVal;
      btnSheet.disabled = true; btnSheet.textContent = 'Đang lưu...';
      const res = await updateRowOnSheet(row, updates);
      btnSheet.disabled = false; btnSheet.textContent = '⬆️ Lưu về Google Sheet';
      if (res && res.ok) {
        row.ghiChu = updates['Ghi Chú'];
        if (statusVal) row.trangThaiXe = statusVal;
        doSaveLocal();
        renderTable();
        toast('Đã ghi về Google Sheet.');
      } else {
        toast('Lỗi ghi về Sheet: ' + ((res && res.error) || 'không xác định'), true);
      }
    });
  }

  // Click vào 1 dòng trong mục I-IV => chuyển panel sang xem chi tiết của xe đó.
  $('#detailBody').querySelectorAll('.mini-table tbody tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="mini-chk"]')) return;
      const targetRow = state.rawData.find(r => r._rowId === tr.dataset.rowid);
      if (targetRow) renderDetailPanelFor(targetRow);
    });
  });
  $('#detailBody').querySelectorAll('[data-role="mini-chk"]').forEach(chk => {
    chk.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = chk.dataset.rowid;
      if (chk.checked) state.exportSelected.add(id); else state.exportSelected.delete(id);
      updateSelectedCount();
      renderTable();
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

$('#btnSaveTemplate').addEventListener('click', async () => {
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
  if (state.mode === 'gas' && state.gasUrl) {
    const res = await gasRequest(state.gasUrl, { action: 'saveSettings', template: tpl }).catch(e => ({ ok: false, error: String(e) }));
    if (res && res.ok) toast('Đã đồng bộ mẫu về Google Sheet.');
    else toast('Lưu tạm thành công, nhưng đồng bộ Sheet thất bại: ' + ((res && res.error) || ''), true);
  }
  closeModal('settingsModal');
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
$('#btnCreateCommitment').addEventListener('click', () => {
  const selectedRows = state.rawData.filter(r => state.exportSelected.has(r._rowId));
  if (!selectedRows.length) { toast('Vui lòng chọn ít nhất 1 xe (checkbox) để xuất Bản cam kết.', true); return; }

  const groups = new Map();
  selectedRows.forEach(row => {
    const ownerKey = row.cccd || ('name:' + normalizeName(row.chuXe));
    if (!groups.has(ownerKey)) {
      groups.set(ownerKey, {
        chuXe: row.chuXe, cccd: row.cccd,
        diaChi: uniq(selectedRows.filter(r => (r.cccd || ('name:' + normalizeName(r.chuXe))) === ownerKey).map(r => r.diaChi)).join(' | '),
        phones: uniq(selectedRows.filter(r => (r.cccd || ('name:' + normalizeName(r.chuXe))) === ownerKey).map(r => r.soDienThoai)).join(' | '),
        vehicles: []
      });
    }
    groups.get(ownerKey).vehicles.push(row);
  });

  state.commitmentDocs = Array.from(groups.values());
  renderAllCommitmentDocs();
  openModal('commitmentOverlay');
});

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

    <div class="doc-field-line doc-bold">II. Đối với phương tiện còn đang sử dụng (ngoài những phương tiện ở mục I):</div>
    ${multilineToFieldLines(tpl.mucII)}

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

async function markExportedOnSheet() {
  if (state.mode !== 'gas' || !state.gasUrl) return;
  const today = new Date().toLocaleDateString('vi-VN');
  const allExportedRows = state.commitmentDocs.flatMap(d => d.vehicles);
  let okCount = 0, failCount = 0;
  for (const row of allExportedRows) {
    const res = await updateRowOnSheet(row, { [EXPORT_FLAG_HEADER]: today });
    if (res && res.ok) okCount++; else failCount++;
  }
  if (okCount) toast(`Đã đánh dấu "${EXPORT_FLAG_HEADER}" cho ${okCount} xe trên Google Sheet.` + (failCount ? ` (${failCount} xe lỗi)` : ''));
  else if (failCount) toast('Không thể đánh dấu ngày xuất trên Sheet (kiểm tra kết nối Apps Script).', true);
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

/* ---------------------------- 14. KHỞI ĐỘNG ------------------------------- */
function refreshAll() {
  updateRecordCount();
  refreshFilterUIs();
  renderTable();
  updateModeBadge();
}

(function init() {
  refreshAll();
  const preferGas = (localStorage.getItem(MODE_KEY) || 'gas') === 'gas';
  const gasUrl = localStorage.getItem(GAS_URL_KEY);
  const csvUrl = localStorage.getItem(LAST_URL_KEY);
  if (preferGas && gasUrl) {
    connectViaAppsScript(gasUrl, { silent: true });
  } else if (csvUrl) {
    connectViaCsv(csvUrl, { silent: true });
  } else if (gasUrl) {
    connectViaAppsScript(gasUrl, { silent: true });
  }
})();
