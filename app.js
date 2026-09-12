/* =========================================================================
   QUẢN LÝ PHƯƠNG TIỆN & BẢN CAM KẾT — app.js
   Toàn bộ logic: đọc Google Sheet (CSV), bộ lọc cascade multi-select,
   bảng dữ liệu có phân trang, panel chi tiết chủ xe, và tạo Bản cam kết
   (in/PDF + tải Word) dựa theo mẫu BanCamKet_TieuMuc1.2.docx
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

const FILTER_FIELDS = ['bienSo', 'cccd', 'chuXe', 'diaChi', 'trangThaiXe'];
const FILTER_LABELS = {
  bienSo: 'Biển số', cccd: 'Số CCCD/MST', chuXe: 'Chủ phương tiện',
  diaChi: 'Địa chỉ / Phường-Xã', trangThaiXe: 'Trạng thái xe'
};

const NOTES_KEY = 'vehicleNotesV1';
const LAST_URL_KEY = 'vehicleLastSheetCsvUrl';

/* ---------------------------- 2. STATE TOÀN CỤC --------------------------- */
const state = {
  rawData: [],
  filters: Object.fromEntries(FILTER_FIELDS.map(f => [f, new Set()])),
  msUI: Object.fromEntries(FILTER_FIELDS.map(f => [f, { search: '', open: false }])),
  page: 1,
  pageSize: 50,
  exportSelected: new Set(),
  lastCsvUrl: null,
  commitmentDocs: [],
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
function uniq(arr) { return Array.from(new Set(arr.filter(v => v && v.trim() !== ''))); }

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

/* ---------------------------- 4. KẾT NỐI GOOGLE SHEET ---------------------- */
function buildCsvUrl(rawUrl, gid) {
  let url = (rawUrl || '').trim();
  if (!url) return null;

  // Đã là URL CSV trực tiếp
  if (/output=csv/i.test(url) || /\.csv($|\?)/i.test(url)) {
    if (gid && !/[?&]gid=/i.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'gid=' + encodeURIComponent(gid);
    }
    return url;
  }

  // Dạng "Xuất bản lên web": .../d/e/2PACX-.../pubhtml hoặc /pub
  const pubMatch = url.match(/\/spreadsheets\/d\/e\/([^/]+)\//);
  if (pubMatch) {
    const pubId = pubMatch[1];
    let out = `https://docs.google.com/spreadsheets/d/e/${pubId}/pub?output=csv`;
    if (gid) out += '&gid=' + encodeURIComponent(gid);
    return out;
  }

  // URL sheet thông thường: .../spreadsheets/d/ID/edit#gid=123
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

  // Không nhận diện được — thử dùng nguyên trạng
  return url;
}

function fetchAndLoad(csvUrl, { silent = false } = {}) {
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
      localStorage.setItem(LAST_URL_KEY, csvUrl);
      closeModal('connectModal');
      toast(`Đã tải ${state.rawData.length} bản ghi từ Google Sheet.`);
    },
    error: (err) => {
      const msg = 'Lỗi tải dữ liệu: ' + (err && err.message ? err.message : 'không xác định') +
        '. Kiểm tra sheet đã "Xuất bản lên web" hoặc chia sẻ "Bất kỳ ai có link" chưa.';
      if (!silent) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
      toast('Lỗi tải dữ liệu từ Google Sheet.', true);
    }
  });
}

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

$('#btnConnect').addEventListener('click', () => {
  $('#sheetUrlInput').value = localStorage.getItem(LAST_URL_KEY) || '';
  openModal('connectModal');
});
$('#btnDoConnect').addEventListener('click', () => {
  const url = $('#sheetUrlInput').value.trim();
  const gid = $('#sheetGidInput').value.trim();
  const errEl = $('#connectError');
  if (!url) { errEl.textContent = 'Vui lòng nhập URL.'; errEl.classList.remove('hidden'); return; }
  const csvUrl = buildCsvUrl(url, gid);
  fetchAndLoad(csvUrl);
});
$('#btnReload').addEventListener('click', () => {
  const url = state.lastCsvUrl || localStorage.getItem(LAST_URL_KEY);
  if (!url) { toast('Chưa kết nối Google Sheet nào.', true); return; }
  fetchAndLoad(url, { silent: true });
});

/* ---------------------------- 5. BỘ LỌC CASCADE ---------------------------- */
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

function escapeHtml(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function refreshFilterUIs() { FILTER_FIELDS.forEach(renderMultiSelect); }

// Event delegation cho toàn bộ filter bar
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
  // giữ focus + con trỏ ở cuối sau khi render lại
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
  // đóng dropdown khi click ra ngoài
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

/* ---------------------------- 6. BẢNG DỮ LIỆU ------------------------------ */
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

// click dòng -> mở panel chi tiết ; click checkbox -> chọn xuất (không mở panel)
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

/* ---------------------------- 7. PANEL CHI TIẾT CHỦ XE --------------------- */
function loadNotesStore() {
  try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch (e) { return {}; }
}
function saveNoteFor(ownerKey, data) {
  const store = loadNotesStore();
  store[ownerKey] = { ...data, updatedAt: new Date().toISOString() };
  localStorage.setItem(NOTES_KEY, JSON.stringify(store));
}

function openDetailPanel(rowId) {
  const row = state.rawData.find(r => r._rowId === rowId);
  if (!row) return;
  const cccd = row.cccd;
  const chuXe = row.chuXe;
  const ownerKey = cccd || ('name:' + normalizeName(chuXe));

  const sameCccd = cccd ? state.rawData.filter(r => r.cccd === cccd) : [row];
  const phones = uniq(sameCccd.map(r => r.soDienThoai)).join(' | ') || '—';
  const addr = uniq(sameCccd.map(r => r.diaChi)).join(' | ') || '—';

  const nameNorm = normalizeName(chuXe);
  const sameNameDiffCccd = nameNorm
    ? state.rawData.filter(r => normalizeName(r.chuXe) === nameNorm && (r.cccd || '') !== (cccd || ''))
    : [];

  const notesStore = loadNotesStore();
  const existingNote = notesStore[ownerKey] || { status: '', text: '' };

  const bodyHtml = `
    <div class="owner-card">
      <div class="row"><b>Họ và tên:</b> ${escapeHtml(chuXe) || '—'}</div>
      <div class="row"><b>Số CCCD/MST:</b> ${escapeHtml(cccd) || '—'}</div>
      <div class="row"><b>Địa chỉ:</b> ${escapeHtml(addr)}</div>
      <div class="row"><b>Số điện thoại:</b> ${escapeHtml(phones)}</div>
    </div>

    <div class="section-title">I. Danh sách xe cùng chủ (cùng Số CCCD)
      <span class="tag-count">${sameCccd.length}</span>
    </div>
    <table class="mini-table">
      <thead><tr><th>Biển số</th><th>Số khung</th><th>Số máy</th><th>Nhãn hiệu</th><th>Loại xe</th><th>Trạng thái</th><th>Ngày ĐK</th></tr></thead>
      <tbody>
        ${sameCccd.map(r => `<tr>
          <td>${escapeHtml(r.bienSo)}</td><td>${escapeHtml(r.soKhung)}</td><td>${escapeHtml(r.soMay)}</td>
          <td>${escapeHtml(r.nhanHieu)}</td><td>${escapeHtml(r.loaiXe)}</td><td>${escapeHtml(r.trangThaiXe)}</td>
          <td>${escapeHtml(r.ngayDangKy)}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <div class="section-title">II. Xe của người trùng họ tên nhưng khác Số CCCD
      <span class="tag-count">${sameNameDiffCccd.length}</span>
    </div>
    ${sameNameDiffCccd.length ? `
    <table class="mini-table">
      <thead><tr><th>Biển số</th><th>CCCD khác</th><th>Địa chỉ</th><th>Loại xe</th><th>Trạng thái</th></tr></thead>
      <tbody>
        ${sameNameDiffCccd.map(r => `<tr class="diff-cccd">
          <td>${escapeHtml(r.bienSo)}</td><td>${escapeHtml(r.cccd) || '—'}</td>
          <td>${escapeHtml(r.diaChi)}</td><td>${escapeHtml(r.loaiXe)}</td><td>${escapeHtml(r.trangThaiXe)}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : `<p class="hint">Không tìm thấy trường hợp trùng tên khác CCCD.</p>`}

    <div class="section-title">Trạng thái / Ghi chú (lưu tạm)</div>
    <div class="note-box">
      <select id="noteStatusSelect">
        <option value="">— Chọn trạng thái —</option>
        <option value="Đã liên hệ">Đã liên hệ</option>
        <option value="Đã xác minh">Đã xác minh</option>
        <option value="Đã ký cam kết">Đã ký cam kết</option>
        <option value="Chưa liên hệ được">Chưa liên hệ được</option>
        <option value="Cần xác minh thêm">Cần xác minh thêm</option>
      </select>
      <textarea id="noteTextArea" placeholder="Ghi chú thêm...">${escapeHtml(existingNote.text)}</textarea>
    </div>
  `;
  $('#detailBody').innerHTML = bodyHtml;
  $('#noteStatusSelect').value = existingNote.status || '';

  const saveNote = () => {
    saveNoteFor(ownerKey, {
      status: $('#noteStatusSelect').value,
      text: $('#noteTextArea').value
    });
    toast('Đã lưu ghi chú.');
  };
  $('#noteStatusSelect').addEventListener('change', saveNote);
  $('#noteTextArea').addEventListener('blur', saveNote);

  openModal('detailOverlay');
}

/* ---------------------------- 8. TẠO BẢN CAM KẾT --------------------------- */
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

function buildDocPageElement(doc, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc-page';
  wrapper.contentEditable = 'true';
  wrapper.dataset.docIndex = index;

  const soldPlates = doc.vehicles
    .filter(v => /bán|chuyển nhượng|cho|tặng/i.test(v.trangThaiXe || ''))
    .map(v => v.bienSo).filter(Boolean).join(', ');

  const rowsHtml = doc.vehicles.map((v, i) => `
    <tr>
      <td style="text-align:center;">${i + 1}</td>
      <td>${escapeHtml(v.bienSo)}</td>
      <td>${escapeHtml(v.loaiXe)}${v.nhanHieu ? ' - ' + escapeHtml(v.nhanHieu) : ''}</td>
      <td class="fill" contenteditable="true"></td>
      <td>${escapeHtml(v.soKhung)}${v.soMay ? ' - ' + escapeHtml(v.soMay) : ''}</td>
      <td>${escapeHtml(v.trangThaiXe) || '<span class="fill" contenteditable="true"></span>'}</td>
      <td>${escapeHtml(v.ghiChu) || '<span class="fill" contenteditable="true"></span>'}</td>
    </tr>
  `).join('');

  wrapper.innerHTML = `
    <div class="doc-center doc-bold">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
    <div class="doc-center doc-bold">Độc lập - Tự do - Hạnh phúc</div>
    <div class="doc-center doc-title">BẢN CAM KẾT</div>
    <div class="doc-center doc-italic">(Về việc kê khai, xác nhận tình trạng phương tiện và cam kết trách nhiệm đối với phương tiện đứng tên sở hữu)</div>

    <div class="doc-field-line">Kính gửi: Công an xã/phường <span class="fill" contenteditable="true">.....................................</span></div>

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
          <th>STT</th><th>Biển số</th><th>Loại xe, nhãn hiệu, số loại</th>
          <th>GCNĐKX số; cấp ngày</th><th>Số khung; số máy</th>
          <th>Tình trạng xe<br><span style="font-weight:400;">(còn sử dụng/đã bán)</span></th><th>Ghi chú</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="doc-field-line">Nay tôi làm Bản cam kết này để kê khai, xác nhận tình trạng phương tiện nêu trên và cam đoan, chịu trách nhiệm về các nội dung sau đây (đối chiếu theo tình trạng từng xe đã kê khai tại cột "Tình trạng xe" nêu trên):</div>

    <div class="doc-field-line doc-bold">I. Đối với phương tiện đã bán/chuyển nhượng/cho/tặng nhưng không xác định được thông tin người mua/người đang sử dụng xe</div>
    <div class="doc-field-line">1. Tôi đã bán/chuyển nhượng/cho/tặng (chuyển quyền sở hữu) các phương tiện có biển số: <span class="fill" contenteditable="true">${escapeHtml(soldPlates)}</span> nêu trên cho người khác.</div>
    <div class="doc-field-line">2. Hiện nay tôi không xác định được thông tin (họ tên, địa chỉ, số điện thoại) của người đã mua hoặc người đang quản lý, sử dụng phương tiện nêu trên.</div>
    <div class="doc-field-line">3. Tôi xin cam kết kể từ thời điểm chuyển quyền sở hữu phương tiện nêu trên, tôi không còn quyền liên quan đến việc quản lý, sử dụng phương tiện; mọi trách nhiệm phát sinh liên quan đến phương tiện sau thời điểm chuyển quyền sở hữu không thuộc trách nhiệm của tôi.</div>

    <div class="doc-field-line doc-bold">II. Đối với phương tiện còn đang sử dụng (ngoài những phương tiện ở mục I):</div>
    <div class="doc-field-line">1. Tôi xin xác nhận phương tiện nêu trên hiện vẫn thuộc quyền sở hữu và do tôi trực tiếp quản lý, sử dụng; chưa thực hiện việc bán, chuyển nhượng, cho, tặng phương tiện cho bất kỳ tổ chức, cá nhân nào khác.</div>
    <div class="doc-field-line">2. Tôi cam kết tiếp tục quản lý, sử dụng phương tiện đúng quy định của pháp luật về giao thông đường bộ và các quy định có liên quan.</div>
    <div class="doc-field-line">3. Trường hợp sau này có thay đổi về tình trạng sở hữu, sử dụng phương tiện (bán, chuyển nhượng, cho, tặng, hư hỏng không còn sử dụng, bị mất...), tôi cam kết sẽ chủ động thông báo và thực hiện đầy đủ thủ tục đăng ký sang tên hoặc thu hồi đăng ký, biển số xe theo đúng quy định của pháp luật.</div>

    <div class="doc-field-line">Tôi cam đoan những nội dung kê khai, cam kết nêu trên là hoàn toàn đúng sự thật. Nếu có nội dung nào không đúng sự thật, tôi xin hoàn toàn chịu trách nhiệm trước pháp luật.</div>

    <div class="doc-signature">
      <div class="doc-signature-block">
        <div class="doc-italic">......., ngày ..... tháng ..... năm ..........</div>
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

/* ---------------------------- 9. TẢI VỀ WORD (.docx) ----------------------- */
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
      await new Promise(res => setTimeout(res, 350)); // tránh trình duyệt chặn tải nhiều file liên tiếp
    } catch (err) {
      console.error(err);
      toast('Lỗi khi tạo file Word cho bản #' + (i + 1), true);
    }
  }
});

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
  const { Document, Paragraph, TextRun, Table, TableRow, TableCell, AlignmentType, WidthType, ShadingType, HeadingLevel } = docx;
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
  const colWidth = Math.floor(totalWidth / numCols);
  const colWidths = Array(numCols).fill(colWidth);

  const docxRows = rows.map(tr => {
    const isHeader = tr.parentElement.tagName.toLowerCase() === 'thead';
    const cells = Array.from(tr.children).map(td => new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } : undefined,
      children: [new Paragraph({
        alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [new TextRun({ text: td.textContent.replace(/\s+/g, ' ').trim(), bold: isHeader })]
      })]
    }));
    return new TableRow({ children: cells });
  });

  return new Table({ columnWidths: colWidths, width: { size: totalWidth, type: WidthType.DXA }, rows: docxRows });
}

/* ---------------------------- 10. KHỞI ĐỘNG ------------------------------- */
function refreshAll() {
  updateRecordCount();
  refreshFilterUIs();
  renderTable();
}

// Tự động thử tải lại sheet đã dùng lần trước (nếu có)
(function init() {
  refreshAll();
  const lastUrl = localStorage.getItem(LAST_URL_KEY);
  if (lastUrl) fetchAndLoad(lastUrl, { silent: true });
})();
