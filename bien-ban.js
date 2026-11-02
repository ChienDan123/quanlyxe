/* =========================================================================
   bien-ban.js — BIÊN BẢN LÀM VIỆC (A4 NGANG, 1 biên bản / 1 chủ xe)
   Nạp SAU app.js + thu-hoi*.js (dùng escapeHtml, toast, state, ensureDocxLib…).

   ĐÃ SỬA:
   - Hiển thị: bỏ class «doc-page» (style.css ép khổ dọc 210x297) → nay luôn 297x210mm.
   - Word: lỗi P(TextRun) làm đoạn rỗng → nay có chữ; bảng dựng thẳng từ cấu trúc cột
     (không đoán theo vị trí ô); A4 ngang đúng hướng; nhiều biên bản = 1 file Word, mỗi
     biên bản 1 section ngang.
   - In/PDF: @page A4 landscape, tiêu đề bảng lặp lại khi sang trang.
   - Chọn nhanh cán bộ (thêm mới / xóa), ngày giờ lập; đổi không làm mất phần đã sửa tay.
   ========================================================================= */
(function () {
  'use strict';
  if (window.BienBan) return;

  /* ------------------------------ 1. MẪU ------------------------------ */
  const TPL_KEY = 'vehicleBienBanTplV1';
  const OFFICER_KEY = 'vehicleBienBanOfficerListV1';
  const LAST_OFFICER_KEY = 'vehicleBienBanLastOfficerV1';
  const DOC_TPL_KEY = 'vehicleBienBanDocV2';
  const ADD_NEW = '__add_new__';

  const DEFAULT_TEMPLATE = {
    coQuanCapTren: 'CA THÀNH PHỐ ĐÀ NẴNG',
    coQuan: 'CÔNG AN XÃ CHIÊN ĐÀN',
    quocHieu1: 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',
    quocHieu2: 'Độc lập - Tự do - Hạnh phúc',
    diaDiem: 'Công an xã Chiên Đàn',
    goiY: [
      'Đối với phương tiện đang sở hữu đã hết hạn đăng kiểm vẫn còn sử dụng, tôi cam kết sẽ thực hiện các thủ tục đăng kiểm phương tiện theo quy định.',
      'Đối với phương tiện xe hết niên hạn sử dụng, tôi cam kết sẽ thực hiện thủ tục thu hồi đăng ký, biển số; đối với đăng ký/biển số/ đăng ký và biển số đã mất, phương tiện thuộc diện thu hồi sẽ không sử dụng vào mục đích khác.',
      'Đối với phương tiện đang sử dụng chưa sang tên (biển số: …), tôi cam kết sẽ thực hiện các thủ tục đăng ký sang tên theo quy định của pháp luật (trường hợp phát hiện có phương tiện mua chưa sang tên đăng ở nhà).'
    ],
    loiCamKet: 'Tôi xin chịu hoàn toàn trách nhiệm trước pháp luật về kê khai và cam kết dưới đây.'
  };
  const DEFAULT_OFFICERS = ['Cán bộ Công an xã Chiên Đàn'];

  const say = (m, err) => { try { (window.toast || console.warn)(m, !!err); } catch (e) { console.warn(m); } };
  const esc = (s) => (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function loadTemplate() {
    try { const raw = localStorage.getItem(TPL_KEY); return raw ? Object.assign({}, DEFAULT_TEMPLATE, JSON.parse(raw)) : Object.assign({}, DEFAULT_TEMPLATE); }
    catch (e) { return Object.assign({}, DEFAULT_TEMPLATE); }
  }
  function saveTemplate(tpl) { try { localStorage.setItem(TPL_KEY, JSON.stringify(tpl)); } catch (e) { /* bỏ qua */ } }
  function loadOfficerList() {
    try { const raw = JSON.parse(localStorage.getItem(OFFICER_KEY) || 'null'); return Array.isArray(raw) && raw.length ? raw : DEFAULT_OFFICERS.slice(); }
    catch (e) { return DEFAULT_OFFICERS.slice(); }
  }
  function saveOfficerList(list) { try { localStorage.setItem(OFFICER_KEY, JSON.stringify(list)); } catch (e) { /* bỏ qua */ } }
  function addOfficerToList(name) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const list = loadOfficerList();
    if (!list.includes(clean)) { list.push(clean); saveOfficerList(list); }
    return clean;
  }

  /* ------------------------------ 2. CỘT BẢNG ------------------------------ */
  const TT_CHU_XE = [
    { key: 'coMat', label: 'Có mặt tại địa bàn' },
    { key: 'daMat', label: 'Đã mất' },
    { key: 'khongConODiaPhuong', label: 'Không còn ở địa phương' },
    { key: 'coQuanGiaiThe', label: 'Cơ quan, doanh nghiệp đã giải thể' }
  ];
  const TT_XE_CO = [
    { key: 'chinhChuQuanLy', label: 'Chính chủ đang quản lý, sử dụng' },
    { key: 'chinhChuKhongSD', label: 'Chính chủ nhưng không còn sử dụng' },
    { key: 'daMuaChuaSangTen', label: 'Đã mua nhưng chưa sang tên' }
  ];
  const TT_XE_KHONG = [
    { key: 'daBanKhongBiet', label: 'Đã bán, không biết người sử dụng' },
    { key: 'daMat2', label: 'Đã mất' },
    { key: 'daBanPheLieu', label: 'Đã bán phế liệu' }
  ];
  const TT_DANG_KY = [
    { key: 'coDKBS', label: 'Có ĐK+BS' },
    { key: 'chiCoDKX', label: 'Chỉ có ĐKX' },
    { key: 'chiCoBS', label: 'Chỉ có BS' },
    { key: 'khongCoDKBS', label: 'Không có ĐK&BS' }
  ];
  const CHECK_GROUPS = [TT_CHU_XE, TT_XE_CO, TT_XE_KHONG, TT_DANG_KY];
  const CHECK_KEYS = [].concat(TT_CHU_XE, TT_XE_CO, TT_XE_KHONG, TT_DANG_KY).map(f => f.key); // 14 ô

  /* ------------------------------ 3. STATE ------------------------------ */
  const BB = {
    docs: [],
    template: loadTemplate(),
    officer: (function () { try { return localStorage.getItem(LAST_OFFICER_KEY) || ''; } catch (e) { return ''; } })(),
    date: '',   // yyyy-mm-dd
    time: ''    // hh:mm
  };
  const cellState = {};
  try { Object.assign(cellState, JSON.parse(localStorage.getItem(DOC_TPL_KEY) || '{}')); } catch (e) { /* bỏ qua */ }
  const persistCells = () => { try { localStorage.setItem(DOC_TPL_KEY, JSON.stringify(cellState)); } catch (e) { /* bỏ qua */ } };

  function suggestChecks(v) {
    const out = {};
    const s = String(v.trangThaiXe || '').toLowerCase();
    if (/(còn sử dụng|đang sử dụng|đang hoạt động)/.test(s)) out.chinhChuQuanLy = true;
    else if (/(bán không rõ|đã bán, không biết|bán không rõ người sử dụng)/.test(s)) out.daBanKhongBiet = true;
    else if (/(đã bán|chuyển nhượng|mua chưa sang tên)/.test(s)) out.daMuaChuaSangTen = true;
    else if (/(mất cắp|bị mất)/.test(s)) out.daMat2 = true;
    else if (/phế liệu/.test(s)) out.daBanPheLieu = true;
    const dk = String(v.trangThaiDK || '').toLowerCase();
    if (/mất|thu hồi/.test(dk)) out.khongCoDKBS = true; else out.coDKBS = true;
    return out;
  }

  /* ------------------------------ 4. DỰNG DOC ------------------------------ */
  function buildDocs() {
    const rows = (state && state.rawData && state.exportSelected) ? state.rawData.filter(r => state.exportSelected.has(r._rowId)) : [];
    if (!rows.length) { say('Vui lòng chọn ít nhất 1 xe (checkbox) để tạo Biên bản.', true); return false; }
    const groups = new Map();
    rows.forEach(row => {
      const key = (typeof getEffectiveOwnerKey === 'function') ? getEffectiveOwnerKey(row) : (row.cccd || ('name:' + row.chuXe));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    BB.docs = Array.from(groups.entries()).map(([key, vehicles]) => {
      const canonical = state.rawData.find(r => (r.cccd || '').trim() === key) || vehicles[0];
      return {
        ownerKey: key,
        chuXe: canonical.chuXe || '',
        cccd: canonical.cccd || '',
        diaChi: Array.from(new Set(vehicles.map(v => v.diaChi).filter(Boolean))).join(' | '),
        sdt: Array.from(new Set(vehicles.map(v => v.soDienThoai).filter(Boolean))).join(' | '),
        vehicles: vehicles.map((v, idx) => ({
          rowId: v._rowId, bienSo: v.bienSo || '', loaiXe: v.loaiXe || '', trangThaiXe: v.trangThaiXe || '',
          idx, checks: Object.assign({}, suggestChecks(v), cellState[key + '|' + (v.bienSo || idx)] || {})
        }))
      };
    });
    return true;
  }

  /* ------------------------------ 5. CSS (A4 NGANG) ------------------------------ */
  // CSS dùng chung cho màn hình + iframe in. KHÔNG dùng class «doc-page» (style.css ép khổ dọc).
  const BB_CSS = [
    '.doc-bienban{box-sizing:border-box;background:#fff;color:#000;width:297mm;min-height:210mm;margin:0 auto 20px;',
    'padding:15mm 20mm;box-shadow:0 2px 10px rgba(0,0,0,.15);font-family:"Times New Roman",Times,serif;font-size:12pt;line-height:1.3;}',
    '.doc-bienban *{box-sizing:border-box;}',
    '.doc-bienban:focus{outline:2px dashed #1e5fbf;outline-offset:4px;}',
    '.doc-bienban .bb-header{display:flex;justify-content:space-between;text-align:center;gap:8mm;margin-bottom:4pt;}',
    '.doc-bienban .bb-header-left,.doc-bienban .bb-header-right{flex:1;min-width:0;}',
    '.doc-bienban .bb-bold{font-weight:700;}',
    '.doc-bienban .bb-underline{text-decoration:underline;text-underline-offset:2px;}',
    '.doc-bienban .bb-title{margin:10pt 0 8pt;text-align:center;font-weight:700;font-size:15pt;letter-spacing:.5px;}',
    '.doc-bienban .bb-line{margin:2pt 0;text-align:justify;}',
    '.doc-bienban .bb-fill{display:inline-block;min-width:30mm;border-bottom:1px dotted #000;padding:0 2mm;}',
    '.doc-bienban .bb-heading{margin:5pt 0 2pt;font-weight:700;}',
    '.doc-bienban .bb-subheading{margin:6pt 0 2pt;font-weight:700;text-align:justify;}',
    '.doc-bienban .bb-italic{font-style:italic;}',
    '.doc-bienban .bb-bullet{margin:1pt 0 1pt 6pt;text-align:justify;}',
    '.doc-bienban .bb-sign{display:flex;justify-content:space-between;margin-top:10pt;gap:4mm;break-inside:avoid;page-break-inside:avoid;}',
    '.doc-bienban .bb-sign-col{flex:1 1 0;text-align:center;min-width:0;}',
    '.doc-bienban .bb-sign-space{height:20mm;}',
    'table.bb-table{width:100%;table-layout:fixed;border-collapse:collapse;margin:4pt 0 6pt;font-size:9pt;line-height:1.2;}',
    'table.bb-table th,table.bb-table td{border:1px solid #000;padding:1.2mm 1mm;vertical-align:middle;text-align:center;overflow-wrap:break-word;word-break:break-word;}',
    'table.bb-table th{background:#f0f0f0;font-weight:700;font-size:8.5pt;}',
    'table.bb-table td.bb-check{cursor:pointer;font-weight:700;user-select:none;min-width:6mm;}',
    'table.bb-table td.bb-check:hover{background:#fff3cd;}',
    'table.bb-table td.bb-check.checked{background:#cfe8ff;color:#003a80;}',
    'table.bb-table thead{display:table-header-group;}',
    'table.bb-table tr{break-inside:avoid;page-break-inside:avoid;}'
  ].join('');

  // Chỉ áp cho màn hình (modal) — ép khổ ngang, chống style.css ghi đè.
  const SCREEN_CSS = [
    '#bienBanContainer{width:max-content;min-width:297mm;margin:0 auto;}',
    '#bienBanContainer .doc-bienban{width:297mm !important;min-width:297mm !important;max-width:none !important;min-height:210mm !important;flex:none !important;}'
  ].join('');

  (function injectCss() {
    if (document.getElementById('bienBanDocCss')) return;
    const st = document.createElement('style');
    st.id = 'bienBanDocCss';
    st.textContent = BB_CSS + SCREEN_CSS;
    document.head.appendChild(st);
  })();

  /* ------------------------------ 6. RENDER ------------------------------ */
  function whenText() {
    let h = 'hồi …… giờ', d = 'ngày …… tháng …… năm ………';
    if (BB.time && /^\d{1,2}:\d{2}$/.test(BB.time)) {
      const p = BB.time.split(':'); h = 'hồi ' + p[0].padStart(2, '0') + ' giờ ' + p[1] + ' phút';
    }
    if (BB.date && /^\d{4}-\d{2}-\d{2}$/.test(BB.date)) {
      const p = BB.date.split('-'); d = 'ngày ' + p[2] + ' tháng ' + p[1] + ' năm ' + p[0];
    }
    return h + ', ' + d + ',';
  }
  const officerText = () => BB.officer || '..............................';

  function buildDocPage(doc, docIdx) {
    const wrapper = document.createElement('div');
    wrapper.className = 'doc-bienban';              // KHÔNG thêm 'doc-page'
    wrapper.contentEditable = 'true';
    wrapper.spellcheck = false;
    wrapper.dataset.docIndex = docIdx;
    const tpl = BB.template;

    const cellHtml = (v, vIdx, key) => {
      const on = !!((v.checks || {})[key]);
      return '<td class="bb-check' + (on ? ' checked' : '') + '" contenteditable="false" data-doc="' + docIdx + '" data-v="' + vIdx + '" data-key="' + key + '">' + (on ? 'X' : '') + '</td>';
    };
    const rows = doc.vehicles.map((v, i) =>
      '<tr><td>' + (i + 1) + '</td><td><b>' + esc(v.bienSo) + '</b></td><td>' + esc(v.loaiXe) + '</td>' +
      CHECK_KEYS.map(k => cellHtml(v, i, k)).join('') + '</tr>').join('');

    wrapper.innerHTML =
      '<div class="bb-header">' +
        '<div class="bb-header-left"><div class="bb-bold">' + esc(tpl.coQuanCapTren) + '</div><div class="bb-bold bb-underline">' + esc(tpl.coQuan) + '</div></div>' +
        '<div class="bb-header-right"><div class="bb-bold">' + esc(tpl.quocHieu1) + '</div><div class="bb-bold bb-underline">' + esc(tpl.quocHieu2) + '</div></div>' +
      '</div>' +
      '<div class="bb-title">BIÊN BẢN LÀM VIỆC</div>' +
      '<div class="bb-line">Hôm nay, <span data-role="when">' + esc(whenText()) + '</span> tại <span class="bb-fill">' + esc(tpl.diaDiem) + '</span></div>' +
      '<div class="bb-heading">Chúng tôi gồm:</div>' +
      '<div class="bb-line">- Đ/c: <span class="bb-fill" data-role="officer">' + esc(officerText()) + '</span>, cán bộ Công an <span class="bb-fill">' + esc(tpl.coQuan) + '</span></div>' +
      '<div class="bb-heading">Đã làm việc với:</div>' +
      '<div class="bb-line">- Ông/bà: <span class="bb-fill">' + esc(doc.chuXe) + '</span>, CCCD: <span class="bb-fill">' + esc(doc.cccd) + '</span>, SĐT: <span class="bb-fill">' + esc(doc.sdt) + '</span>, HKTT: <span class="bb-fill">' + esc(doc.diaChi) + '</span>, Chỗ ở hiện nay: <span class="bb-fill">..............................</span></div>' +
      '<div class="bb-line">- Ông/bà: <span class="bb-fill">..............................</span>, CCCD: <span class="bb-fill">....................</span>, SĐT: <span class="bb-fill">....................</span>; đại diện gia đình của chủ xe hoặc người đang quản lý sử dụng xe (trường hợp không có chủ xe tại địa bàn)</div>' +
      '<div class="bb-heading">Nội dung làm việc:</div>' +
      '<div class="bb-subheading">1. Cùng xác nhận các thông tin sau (đánh dấu X để xác nhận tình trạng)</div>' +
      '<table class="bb-table" contenteditable="false"><colgroup>' +
        '<col style="width:4%"><col style="width:11%"><col style="width:10%">' +
        '<col style="width:6.5%"><col style="width:6.5%"><col style="width:6.5%"><col style="width:6.5%">' +
        '<col style="width:5.5%"><col style="width:5.5%"><col style="width:5.5%"><col style="width:5.5%"><col style="width:5.5%"><col style="width:5.5%">' +
        '<col style="width:4%"><col style="width:4%"><col style="width:4%"><col style="width:4%">' +
      '</colgroup><thead>' +
        '<tr><th rowspan="3">STT</th><th rowspan="3">Biển số</th><th rowspan="3">Loại xe (ghi ô tô/mô tô)</th>' +
          '<th colspan="4">Tình trạng chủ xe</th><th colspan="6">Tình trạng của xe</th><th colspan="4">Tình trạng đăng ký, biển số xe</th></tr>' +
        '<tr>' + TT_CHU_XE.map(f => '<th rowspan="2">' + esc(f.label) + '</th>').join('') +
          '<th colspan="3">Có phương tiện tại địa bàn</th><th colspan="3">Không có phương tiện tại địa bàn</th>' +
          TT_DANG_KY.map(f => '<th rowspan="2">' + esc(f.label) + '</th>').join('') + '</tr>' +
        '<tr>' + TT_XE_CO.concat(TT_XE_KHONG).map(f => '<th>' + esc(f.label) + '</th>').join('') + '</tr>' +
      '</thead><tbody>' + rows + '</tbody></table>' +
      '<div class="bb-subheading">2. Cam kết của chủ xe hoặc đại diện gia đình <i>(TH không tìm được chủ xe)</i></div>' +
      '<div class="bb-italic">Gợi ý:</div>' +
      tpl.goiY.map(s => '<div class="bb-bullet">- ' + esc(s) + '</div>').join('') +
      '<div class="bb-line" style="margin-top:5pt;">' + esc(tpl.loiCamKet) + '</div>' +
      '<div class="bb-sign">' +
        '<div class="bb-sign-col"><div class="bb-bold">NGƯỜI LẬP BIÊN BẢN</div><div class="bb-italic">(Ký ghi rõ họ, tên)</div><div class="bb-sign-space"></div></div>' +
        '<div class="bb-sign-col"><div class="bb-bold">CHỦ XE/ĐẠI DIỆN HỘ GĐ/ĐẠI DIỆN CHÍNH QUYỀN</div><div class="bb-italic">(Ký, ghi rõ họ, tên)</div><div class="bb-sign-space"></div></div>' +
      '</div>';
    return wrapper;
  }

  let _scrollIdx = 0;
  function updateCounter() {
    const c = document.getElementById('bbCounter');
    if (c) c.textContent = BB.docs.length ? ((_scrollIdx + 1) + ' / ' + BB.docs.length + ' biên bản') : '0 biên bản';
  }
  function renderAll() {
    const container = document.getElementById('bienBanContainer');
    if (!container) return;
    container.innerHTML = '';
    BB.docs.forEach((doc, idx) => container.appendChild(buildDocPage(doc, idx)));
    updateCounter();
  }
  // Cập nhật cán bộ / thời gian TẠI CHỖ (không dựng lại → không mất phần người dùng đã sửa tay)
  function refreshOfficerAndWhen() {
    document.querySelectorAll('#bienBanContainer [data-role="officer"]').forEach(el => { el.textContent = officerText(); });
    document.querySelectorAll('#bienBanContainer [data-role="when"]').forEach(el => { el.textContent = whenText(); });
  }

  /* ------------------------------ 7. TICK Ô ------------------------------ */
  function toggleCheck(docIdx, vIdx, key) {
    const doc = BB.docs[docIdx]; if (!doc) return;
    const v = doc.vehicles[vIdx]; if (!v) return;
    v.checks = v.checks || {};
    v.checks[key] = !v.checks[key];
    const group = CHECK_GROUPS.find(g => g.some(f => f.key === key)) || TT_DANG_KY;
    group.forEach(f => { if (f.key !== key) v.checks[f.key] = false; });
    cellState[doc.ownerKey + '|' + (v.bienSo || vIdx)] = Object.assign({}, v.checks);
    persistCells();
    group.forEach(f => {
      const c = document.querySelector('.doc-bienban[data-doc-index="' + docIdx + '"] td.bb-check[data-v="' + vIdx + '"][data-key="' + f.key + '"]');
      if (c) { c.classList.toggle('checked', !!v.checks[f.key]); c.textContent = v.checks[f.key] ? 'X' : ''; }
    });
  }

  /* ------------------------------ 8. MODAL + UI ------------------------------ */
  function ensureModal() {
    let md = document.getElementById('bienBanOverlay');
    if (md) return md;
    md = document.createElement('div');
    md.id = 'bienBanOverlay'; md.className = 'modal-overlay hidden';
    md.innerHTML =
      '<div class="modal modal-xl" style="max-width:95vw;">' +
        '<div class="modal-header"><h2>📝 Biên bản làm việc (A4 ngang)</h2>' +
          '<div class="commitment-nav"><button type="button" id="btnPrevBB" class="btn btn-ghost">‹ Trước</button>' +
          '<span id="bbCounter">1 / 1</span><button type="button" id="btnNextBB" class="btn btn-ghost">Sau ›</button></div>' +
          '<button type="button" class="modal-close" data-close="bienBanOverlay">✕</button></div>' +
        '<div class="modal-body commitment-body" style="overflow:auto;background:#e0e0e0;padding:10px;">' +
          '<div class="bb-toolbar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;background:#fff;padding:8px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.1);position:sticky;left:0;">' +
            '<label class="hint" style="margin:0;">Cán bộ thực hiện:</label>' +
            '<select id="bbOfficerSelect" class="row-inline-select" style="min-width:220px;"></select>' +
            '<button type="button" id="btnBBDelOfficer" class="btn btn-ghost btn-sm" title="Xóa tên đang chọn khỏi danh sách">✕ Xóa tên</button>' +
            '<label class="hint" style="margin:0 0 0 8px;">Ngày:</label><input type="date" id="bbDate" class="row-inline-select">' +
            '<label class="hint" style="margin:0;">Giờ:</label><input type="time" id="bbTime" class="row-inline-select">' +
            '<span class="hint" style="margin-left:auto;">Bấm ô trong bảng để đánh dấu X (mỗi nhóm 1 ô). Bấm vào chữ để sửa trực tiếp.</span>' +
          '</div>' +
          '<div id="bienBanContainer"></div>' +
        '</div>' +
        '<div class="modal-footer"><span class="hint">Nội dung bên trên là bản sẽ in / tải — sửa xong mới bấm tải.</span>' +
          '<div class="footer-btns"><button type="button" id="btnPrintBB" class="btn btn-secondary">🖨️ In / Xuất PDF</button>' +
          '<button type="button" id="btnDownloadWordBB" class="btn btn-primary">⬇️ Tải về (Word)</button></div></div>' +
      '</div>';
    document.body.appendChild(md);

    md.addEventListener('click', (e) => {
      const b = e.target.closest('[data-close]');
      if (b) { md.classList.add('hidden'); return; }
      if (e.target.id === 'bienBanOverlay') { md.classList.add('hidden'); return; }
      const cell = e.target.closest('td.bb-check');
      if (cell) { e.preventDefault(); toggleCheck(parseInt(cell.dataset.doc, 10), parseInt(cell.dataset.v, 10), cell.dataset.key); }
    });
    document.getElementById('bbOfficerSelect').addEventListener('change', (e) => {
      const val = e.target.value;
      if (val === ADD_NEW) {
        const added = addOfficerToList(window.prompt('Nhập tên cán bộ mới:'));
        if (!added) { e.target.value = BB.officer || ''; return; }
        BB.officer = added;
      } else { BB.officer = val; }
      try { localStorage.setItem(LAST_OFFICER_KEY, BB.officer); } catch (err) { /* bỏ qua */ }
      buildOfficerSelect();
      refreshOfficerAndWhen();
    });
    document.getElementById('btnBBDelOfficer').addEventListener('click', () => {
      if (!BB.officer) return;
      if (!window.confirm('Xóa «' + BB.officer + '» khỏi danh sách cán bộ?')) return;
      saveOfficerList(loadOfficerList().filter(n => n !== BB.officer));
      BB.officer = '';
      try { localStorage.removeItem(LAST_OFFICER_KEY); } catch (err) { /* bỏ qua */ }
      buildOfficerSelect(); refreshOfficerAndWhen();
    });
    document.getElementById('bbDate').addEventListener('change', (e) => { BB.date = e.target.value; refreshOfficerAndWhen(); });
    document.getElementById('bbTime').addEventListener('change', (e) => { BB.time = e.target.value; refreshOfficerAndWhen(); });
    document.getElementById('btnPrevBB').addEventListener('click', () => scrollDoc(-1));
    document.getElementById('btnNextBB').addEventListener('click', () => scrollDoc(1));
    document.getElementById('btnPrintBB').addEventListener('click', printDocs);
    document.getElementById('btnDownloadWordBB').addEventListener('click', downloadWord);
    return md;
  }

  function buildOfficerSelect() {
    const sel = document.getElementById('bbOfficerSelect'); if (!sel) return;
    const list = loadOfficerList();
    if (BB.officer && !list.includes(BB.officer)) list.push(BB.officer);
    sel.innerHTML = '<option value="">— Chọn cán bộ —</option>' +
      list.map(n => '<option value="' + esc(n) + '"' + (BB.officer === n ? ' selected' : '') + '>' + esc(n) + '</option>').join('') +
      '<option value="' + ADD_NEW + '">+ Thêm người mới...</option>';
    sel.value = BB.officer || '';
  }

  function scrollDoc(delta) {
    const pages = document.querySelectorAll('#bienBanContainer .doc-bienban');
    if (!pages.length) return;
    _scrollIdx = Math.max(0, Math.min(pages.length - 1, _scrollIdx + delta));
    pages[_scrollIdx].scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'center' });
    updateCounter();
  }

  /* ------------------------------ 9. IN / PDF ------------------------------ */
  function printDocs() {
    const pages = document.querySelectorAll('#bienBanContainer .doc-bienban');
    if (!pages.length) { say('Chưa có biên bản nào để in.', true); return; }
    const body = Array.from(pages).map(p => {
      const c = p.cloneNode(true);
      c.removeAttribute('contenteditable');
      c.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
      return c.outerHTML;
    }).join('');
    const printCss =
      '@page{size:A4 landscape;margin:15mm;}' +
      'html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
      '.doc-bienban{width:auto !important;min-width:0 !important;min-height:0 !important;margin:0 !important;padding:0 !important;box-shadow:none !important;break-after:page;page-break-after:always;}' +
      '.doc-bienban:last-child{break-after:auto;page-break-after:auto;}' +
      'table.bb-table td.bb-check.checked{background:#fff !important;color:#000 !important;}' +
      'table.bb-table td.bb-check:hover{background:transparent !important;}';
    const html = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Biên bản làm việc</title>' +
      '<style>' + BB_CSS + printCss + '</style></head><body>' + body + '</body></html>';
    const old = document.getElementById('bienBanPrintFrame');
    if (old) old.remove();
    const iframe = document.createElement('iframe');
    iframe.id = 'bienBanPrintFrame';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;left:-99999px;top:0;border:0;width:297mm;height:210mm;';
    iframe.onload = () => {
      const w = iframe.contentWindow;
      const go = () => { w.onafterprint = () => setTimeout(() => iframe.remove(), 500); w.focus(); w.print(); };
      if (w.document.fonts && w.document.fonts.ready) w.document.fonts.ready.then(() => setTimeout(go, 50)); else setTimeout(go, 100);
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  }

  /* ------------------------------ 10. XUẤT WORD ------------------------------ */
  // Bề rộng cột (DXA). Tổng 14560 ≤ vùng in A4 ngang (16838 - 2×1134 = 14570).
  const COLS = [580, 1600, 1460, 950, 950, 950, 950, 800, 800, 800, 800, 800, 800, 580, 580, 580, 580];
  const TABLE_W = COLS.reduce((a, b) => a + b, 0);
  const sumW = (c, n) => COLS.slice(c, c + n).reduce((a, b) => a + b, 0);

  function downloadWord() {
    const pages = document.querySelectorAll('#bienBanContainer .doc-bienban');
    if (!pages.length) { say('Chưa có biên bản nào để tải.', true); return; }
    if (typeof ensureDocxLib !== 'function') { say('Không tìm thấy thư viện xuất Word.', true); return; }
    ensureDocxLib().then(async () => {
      try {
        const D = window.docx;
        const sections = Array.from(pages).map(p => buildSection(p, D));
        const doc = new D.Document({
          creator: 'Quản lý Phương tiện', title: 'Biên bản làm việc',
          styles: { default: { document: { run: { font: 'Times New Roman', size: 24 }, paragraph: { spacing: { line: 276 } } } } },
          sections
        });
        const blob = await D.Packer.toBlob(doc);
        const owner = pages.length === 1 ? ((BB.docs[0] && BB.docs[0].chuXe) || 'BienBan') : (pages.length + '_chu_xe');
        const safe = (typeof sanitizeFilename === 'function') ? sanitizeFilename(owner) : String(owner).replace(/[^\w-]+/g, '_');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'BienBanLamViec_' + safe + '.docx';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      } catch (err) {
        console.error(err);
        say('Lỗi khi tạo file Word: ' + (err.message || err), true);
      }
    }).catch(err => say('Không tải được thư viện Word: ' + (err.message || err), true));
  }

  function buildSection(pageEl, D) {
    const { Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, VerticalAlign, ShadingType, UnderlineType, PageOrientation } = D;
    const CENTER = AlignmentType.CENTER, JUSTIFY = AlignmentType.JUSTIFIED, LEFT = AlignmentType.LEFT;
    const NOB = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const noBorders = { top: NOB, bottom: NOB, left: NOB, right: NOB, insideHorizontal: NOB, insideVertical: NOB };
    const noCellBorders = { top: NOB, bottom: NOB, left: NOB, right: NOB };

    const T = (text, o) => new TextRun(Object.assign({ text: text || '' }, o || {}));
    // content: chuỗi | 1 TextRun | mảng TextRun  (lỗi cũ: bọc TextRun vào TextRun → rỗng)
    const P = (content, opt) => {
      let runs;
      if (Array.isArray(content)) runs = content;
      else if (content == null || typeof content === 'string') runs = [T(content || '')];
      else runs = [content];
      return new Paragraph(Object.assign({ alignment: LEFT, spacing: { before: 0, after: 40 }, children: runs }, opt || {}));
    };
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    const children = [];

    Array.from(pageEl.children).forEach(el => {
      const cl = el.classList;
      if (cl.contains('bb-header')) {
        const L = Array.from(el.querySelector('.bb-header-left').children).map(x => clean(x.textContent));
        const Rr = Array.from(el.querySelector('.bb-header-right').children).map(x => clean(x.textContent));
        const n = Math.max(L.length, Rr.length);
        const half = Math.floor(TABLE_W / 2);
        const mk = (txt, last) => new TableCell({
          borders: noCellBorders, width: { size: half, type: WidthType.DXA },
          children: [P(T(txt, { bold: true, underline: last ? { type: UnderlineType.SINGLE } : undefined }), { alignment: CENTER })]
        });
        const rows = [];
        for (let i = 0; i < n; i++) rows.push(new TableRow({ children: [mk(L[i] || '', i === L.length - 1), mk(Rr[i] || '', i === Rr.length - 1)] }));
        children.push(new Table({ width: { size: half * 2, type: WidthType.DXA }, columnWidths: [half, half], borders: noBorders, rows }));
      } else if (cl.contains('bb-title')) {
        children.push(P(T(clean(el.textContent) || 'BIÊN BẢN LÀM VIỆC', { bold: true, size: 30 }), { alignment: CENTER, spacing: { before: 200, after: 160 } }));
      } else if (el.tagName === 'TABLE') {
        children.push(buildVehicleTable(el, D, P, T));
        children.push(P('', { spacing: { before: 0, after: 20 } }));
      } else if (cl.contains('bb-sign')) {
        const half = Math.floor(TABLE_W / 2);
        const cells = Array.from(el.querySelectorAll('.bb-sign-col')).map(col => {
          const ps = Array.from(col.children).filter(x => !x.classList.contains('bb-sign-space')).map(x =>
            P(T(clean(x.textContent), { bold: x.classList.contains('bb-bold'), italics: x.classList.contains('bb-italic') }), { alignment: CENTER }));
          ps.push(P(''), P(''), P(''), P(''));
          return new TableCell({ borders: noCellBorders, width: { size: half, type: WidthType.DXA }, children: ps });
        });
        children.push(P('', { spacing: { before: 120, after: 120 } }));
        children.push(new Table({ width: { size: half * 2, type: WidthType.DXA }, columnWidths: [half, half], borders: noBorders, rows: [new TableRow({ cantSplit: true, children: cells })] }));
      } else {
        const txt = clean(el.textContent);
        if (!txt) return;
        if (cl.contains('bb-heading') || cl.contains('bb-subheading')) children.push(P(T(txt, { bold: true }), { spacing: { before: 100, after: 40 }, alignment: cl.contains('bb-subheading') ? JUSTIFY : LEFT }));
        else if (cl.contains('bb-italic')) children.push(P(T(txt, { italics: true }), { spacing: { before: 40, after: 40 } }));
        else if (cl.contains('bb-bullet')) children.push(P(T(txt), { alignment: JUSTIFY, indent: { left: 400 }, spacing: { before: 0, after: 40 } }));
        else children.push(P(T(txt), { alignment: JUSTIFY }));   // bb-line + dòng người dùng thêm
      }
    });

    return {
      properties: {
        page: {
          // docx tự HOÁN ĐỔI rộng/cao khi orientation = LANDSCAPE → truyền kích thước DỌC
          size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
          margin: { top: 850, bottom: 850, left: 1134, right: 1134 }
        }
      },
      children
    };
  }

  function buildVehicleTable(tblEl, D, P, T) {
    const { Table, TableRow, TableCell, WidthType, VerticalAlign, ShadingType, AlignmentType } = D;
    const CENTER = AlignmentType.CENTER;
    const H = (text, c, cs, rs) => new TableCell({
      columnSpan: cs > 1 ? cs : undefined, rowSpan: rs > 1 ? rs : undefined,
      width: { size: sumW(c, cs || 1), type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      shading: { type: ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' },
      children: [P(T(text, { bold: true, size: 16 }), { alignment: CENTER, spacing: { before: 30, after: 30 } })]
    });
    const hdr = (cells) => new TableRow({ cantSplit: true, tableHeader: true, children: cells });

    const r1 = hdr([
      H('STT', 0, 1, 3), H('Biển số', 1, 1, 3), H('Loại xe (ghi ô tô/mô tô)', 2, 1, 3),
      H('Tình trạng chủ xe', 3, 4, 1), H('Tình trạng của xe', 7, 6, 1), H('Tình trạng đăng ký, biển số xe', 13, 4, 1)
    ]);
    const r2 = hdr([
      H(TT_CHU_XE[0].label, 3, 1, 2), H(TT_CHU_XE[1].label, 4, 1, 2), H(TT_CHU_XE[2].label, 5, 1, 2), H(TT_CHU_XE[3].label, 6, 1, 2),
      H('Có phương tiện tại địa bàn', 7, 3, 1), H('Không có phương tiện tại địa bàn', 10, 3, 1),
      H(TT_DANG_KY[0].label, 13, 1, 2), H(TT_DANG_KY[1].label, 14, 1, 2), H(TT_DANG_KY[2].label, 15, 1, 2), H(TT_DANG_KY[3].label, 16, 1, 2)
    ]);
    const r3 = hdr(TT_XE_CO.concat(TT_XE_KHONG).map((f, i) => H(f.label, 7 + i, 1, 1)));

    const body = Array.from(tblEl.querySelectorAll('tbody tr')).map(tr => {
      const tds = Array.from(tr.children);
      const cells = tds.slice(0, COLS.length).map((td, ci) => {
        const isCheck = td.classList.contains('bb-check');
        const txt = isCheck ? (td.classList.contains('checked') ? 'X' : '') : String(td.textContent || '').replace(/\s+/g, ' ').trim();
        return new TableCell({
          width: { size: COLS[ci], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
          children: [P(T(txt, { bold: isCheck || ci === 1, size: 18 }), { alignment: CENTER, spacing: { before: 40, after: 40 } })]
        });
      });
      return new TableRow({ cantSplit: true, children: cells });
    });

    return new Table({ width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: COLS, rows: [r1, r2, r3].concat(body) });
  }

  /* ------------------------------ 11. NÚT + MỞ ------------------------------ */
  function openBienBan(preselectRowId) {
    if (!state || !state.rawData || !state.rawData.length) { say('Chưa có dữ liệu để tạo biên bản.', true); return; }
    if (preselectRowId && state.exportSelected && state.exportSelected.size === 0) state.exportSelected.add(preselectRowId);
    if (!buildDocs()) return;
    ensureModal();
    BB.template = loadTemplate();
    document.getElementById('bienBanOverlay').classList.remove('hidden');
    buildOfficerSelect();
    document.getElementById('bbDate').value = BB.date || '';
    document.getElementById('bbTime').value = BB.time || '';
    _scrollIdx = 0;
    renderAll();
  }

  function injectToolbarBtn() {
    const btnThuHoi = document.getElementById('btnThuHoi');
    if (!btnThuHoi || document.getElementById('btnCreateBienBan')) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'btnCreateBienBan'; btn.className = 'btn btn-secondary';
    btn.title = 'Tạo biên bản làm việc cho các xe đã tích chọn (cùng chủ xe = 1 biên bản)';
    btn.textContent = '📝 Biên bản làm việc';
    btn.addEventListener('click', () => openBienBan());
    btnThuHoi.insertAdjacentElement('afterend', btn);
  }
  function injectDetailBtns() {
    const body = document.getElementById('detailBody'); if (!body) return;
    body.querySelectorAll('.owner-card-actions').forEach(card => {
      if (card.querySelector('[data-role="bb-open"]')) return;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.dataset.role = 'bb-open';
      btn.className = 'btn btn-secondary btn-sm';
      btn.textContent = '📝 Biên bản (xe này)';
      btn.title = 'Tạo biên bản làm việc cho xe đang xem (dùng đúng danh sách đã tích chọn)';
      btn.addEventListener('click', () => {
        const id = (typeof currentDetailRow !== 'undefined' && currentDetailRow) ? currentDetailRow._rowId : null;
        openBienBan(id);
      });
      card.appendChild(btn);
    });
  }
  function injectSettingsSection() {
    const modal = document.getElementById('settingsModal'); if (!modal) return;
    const body = modal.querySelector('.modal-body'); if (!body) return;
    if (body.querySelector('#bbSettings')) return;
    const div = document.createElement('div');
    div.id = 'bbSettings';
    div.innerHTML =
      '<div class="section-title">📝 Mẫu Biên bản làm việc</div>' +
      '<p class="hint">Bố cục theo file mẫu «BIÊN BẢN LÀM VIỆC LÀM SẠCH DỮ LIỆU ĐKX» (A4 ngang). Chỉnh các trường bên dưới, lưu lại để dùng cho lần tạo sau.</p>' +
      '<label class="hint-label">Cơ quan cấp trên</label><input id="bbTplCapTren" class="tpl-input" type="text">' +
      '<label class="hint-label">Cơ quan ban hành</label><input id="bbTplCoQuan" class="tpl-input" type="text">' +
      '<label class="hint-label">Quốc hiệu 1</label><input id="bbTplQH1" class="tpl-input" type="text">' +
      '<label class="hint-label">Quốc hiệu 2 (khẩu hiệu)</label><input id="bbTplQH2" class="tpl-input" type="text">' +
      '<label class="hint-label">Địa điểm (điền vào «tại …»)</label><input id="bbTplDiaDiem" class="tpl-input" type="text">' +
      '<label class="hint-label">Các gợi ý cam kết (mỗi dòng 1 gợi ý)</label><textarea id="bbTplGoiY" class="tpl-textarea" rows="5"></textarea>' +
      '<label class="hint-label">Lời cam kết cuối</label><textarea id="bbTplLoiCamKet" class="tpl-textarea" rows="2"></textarea>' +
      '<div style="margin-top:8px;display:flex;gap:6px;">' +
        '<button type="button" class="btn btn-ghost btn-sm" id="btnBBTplReset">↺ Khôi phục mặc định</button>' +
        '<button type="button" class="btn btn-primary btn-sm" id="btnBBTplSave">💾 Lưu mẫu Biên bản</button></div>' +
      '<div id="bbTplMsg" class="hint" style="margin-top:4px;"></div>';
    body.appendChild(div);

    const fill = () => {
      const t = BB.template;
      div.querySelector('#bbTplCapTren').value = t.coQuanCapTren;
      div.querySelector('#bbTplCoQuan').value = t.coQuan;
      div.querySelector('#bbTplQH1').value = t.quocHieu1;
      div.querySelector('#bbTplQH2').value = t.quocHieu2;
      div.querySelector('#bbTplDiaDiem').value = t.diaDiem;
      div.querySelector('#bbTplGoiY').value = t.goiY.join('\n');
      div.querySelector('#bbTplLoiCamKet').value = t.loiCamKet;
    };
    BB.template = loadTemplate();
    fill();
    div.querySelector('#btnBBTplReset').addEventListener('click', () => {
      BB.template = Object.assign({}, DEFAULT_TEMPLATE); fill();
      div.querySelector('#bbTplMsg').textContent = 'Đã khôi phục mẫu mặc định (chưa lưu).';
    });
    div.querySelector('#btnBBTplSave').addEventListener('click', () => {
      const v = (id) => div.querySelector(id).value.trim();
      const tpl = {
        coQuanCapTren: v('#bbTplCapTren') || DEFAULT_TEMPLATE.coQuanCapTren,
        coQuan: v('#bbTplCoQuan') || DEFAULT_TEMPLATE.coQuan,
        quocHieu1: v('#bbTplQH1') || DEFAULT_TEMPLATE.quocHieu1,
        quocHieu2: v('#bbTplQH2') || DEFAULT_TEMPLATE.quocHieu2,
        diaDiem: v('#bbTplDiaDiem') || DEFAULT_TEMPLATE.diaDiem,
        goiY: div.querySelector('#bbTplGoiY').value.split('\n').map(s => s.trim()).filter(Boolean),
        loiCamKet: v('#bbTplLoiCamKet') || DEFAULT_TEMPLATE.loiCamKet
      };
      BB.template = tpl; saveTemplate(tpl);
      div.querySelector('#bbTplMsg').textContent = '✅ Đã lưu mẫu Biên bản trên trình duyệt.';
    });
  }

  /* ------------------------------ 12. KHỞI TẠO ------------------------------ */
  function init() {
    injectToolbarBtn();
    const body = document.getElementById('detailBody');
    if (body) {
      let raf = 0;
      new MutationObserver(() => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; injectDetailBtns(); }); })
        .observe(body, { childList: true, subtree: true });
      injectDetailBtns();
    }
    const btnSettings = document.getElementById('btnSettings');
    if (btnSettings) btnSettings.addEventListener('click', () => setTimeout(injectSettingsSection, 0));
    const sm = document.getElementById('settingsModal');
    if (sm && !sm.classList.contains('hidden')) injectSettingsSection();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.BienBan = { open: openBienBan, state: BB };
})();
