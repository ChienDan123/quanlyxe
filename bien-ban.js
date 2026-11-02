/* =========================================================================
   bien-ban.js — Tạo BIÊN BẢN LÀM VIỆC (tương tự Bản cam kết).
   Map bố cục theo file mẫu «BIÊN BẢN LÀM VIỆC LÀM SẠCH DỮ LIỆU ĐKX.Chuan.docx».
   Nạp SAU app.js + thu-hoi*.js (dùng escapeHtml, toast, state, ensureDocxLib…).
   Tự chèn:
     - Nút «📝 Biên bản làm việc» vào thanh toolbar chính (cạnh «Giấy khai thu hồi»).
     - Nút «📝 Biên bản (xe này)» vào thẻ chủ xe trong panel Chi tiết (MutationObserver).
     - Khối «📝 Mẫu Biên bản» trong modal Cài đặt.
     - Modal xem trước / in / tải Word cho từng biên bản.
   LƯU Ý: biến cục bộ của module tên là BB (không đặt tên «state» để khỏi che
   mất biến state toàn cục của app.js).
   ========================================================================= */
(function () {
  'use strict';
  if (window.BienBan) return;

  /* ------------------------------ 1. MẪU ------------------------------ */
  const TPL_KEY = 'vehicleBienBanTplV1';
  const OFFICER_KEY = 'vehicleBienBanOfficerListV1';
  const DOC_TPL_KEY = 'vehicleBienBanDocV1';
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

  function loadTemplate() {
    try { const raw = localStorage.getItem(TPL_KEY); return raw ? { ...DEFAULT_TEMPLATE, ...JSON.parse(raw) } : { ...DEFAULT_TEMPLATE }; }
    catch (e) { return { ...DEFAULT_TEMPLATE }; }
  }
  function saveTemplate(tpl) { try { localStorage.setItem(TPL_KEY, JSON.stringify(tpl)); } catch (e) { /* bỏ qua */ } }
  function loadOfficerList() {
    try { const raw = JSON.parse(localStorage.getItem(OFFICER_KEY) || 'null'); return Array.isArray(raw) && raw.length ? raw : [...DEFAULT_OFFICERS]; }
    catch (e) { return [...DEFAULT_OFFICERS]; }
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

  /* ------------------------------ 3. STATE CỤC BỘ (BB) ------------------------------ */
  const BB = {
    docs: [],
    template: loadTemplate(),
    officer: '',
    currentIdx: 0,
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
    // `state` ở đây là biến toàn cục của app.js
    const rows = (state && state.rawData && state.exportSelected) ? state.rawData.filter(r => state.exportSelected.has(r._rowId)) : [];
    if (!rows.length) { (window.toast || console.warn)('Vui lòng chọn ít nhất 1 xe (checkbox) để tạo Biên bản.', true); return false; }
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
        diaChi: [...new Set(vehicles.map(v => v.diaChi).filter(Boolean))].join(' | '),
        sdt: [...new Set(vehicles.map(v => v.soDienThoai).filter(Boolean))].join(' | '),
        vehicles: vehicles.map((v, idx) => ({
          rowId: v._rowId, bienSo: v.bienSo || '', loaiXe: v.loaiXe || '', trangThaiXe: v.trangThaiXe || '',
          idx, checks: { ...suggestChecks(v), ...(cellState[key + '|' + idx] || {}) }
        }))
      };
    });
    BB.currentIdx = 0;
    return true;
  }

  /* ------------------------------ 5. CSS ------------------------------ */
  const BB_CSS = `
.doc-bienban{box-sizing:border-box;background:#fff;color:#000;width:210mm;min-height:297mm;margin:0 auto 20px;
  padding:20mm 15mm 18mm 30mm;box-shadow:0 2px 10px rgba(0,0,0,.15);
  font-family:'Times New Roman',Times,serif;font-size:13pt;line-height:1.35;}
.doc-bienban *{box-sizing:border-box;}
.doc-bienban:focus{outline:2px dashed #1e5fbf;outline-offset:4px;}
.doc-bienban .bb-header{display:flex;justify-content:space-between;text-align:center;gap:8mm;margin-bottom:6pt;}
.doc-bienban .bb-header-left,.doc-bienban .bb-header-right{flex:1;min-width:0;}
.doc-bienban .bb-bold{font-weight:700;}
.doc-bienban .bb-underline{text-decoration:underline;text-underline-offset:2px;}
.doc-bienban .bb-title{margin:14pt 0 10pt;text-align:center;font-weight:700;font-size:16pt;letter-spacing:.5px;}
.doc-bienban .bb-line{margin:3pt 0;text-align:justify;}
.doc-bienban .bb-fill{display:inline-block;min-width:40mm;border-bottom:1px dotted #000;padding:0 2mm;}
.doc-bienban .bb-heading{margin:6pt 0 3pt;font-weight:700;}
.doc-bienban .bb-subheading{margin:8pt 0 3pt;font-weight:700;text-align:justify;}
.doc-bienban .bb-italic{font-style:italic;}
.doc-bienban .bb-bullet{margin:2pt 0 2pt 6pt;text-align:justify;}
.doc-bienban .bb-sign{display:flex;justify-content:space-between;margin-top:14pt;gap:4mm;break-inside:avoid;page-break-inside:avoid;}
.doc-bienban .bb-sign-col{flex:1 1 0;text-align:center;min-width:0;}
.doc-bienban .bb-sign-space{height:22mm;}
table.bb-table{width:100%;table-layout:fixed;border-collapse:collapse;margin:6pt 0 8pt;font-size:9pt;line-height:1.2;}
table.bb-table th,table.bb-table td{border:1px solid #000;padding:1mm 1mm;vertical-align:middle;text-align:center;overflow-wrap:break-word;word-break:break-word;}
table.bb-table th{background:#f0f0f0;font-weight:700;font-size:8.5pt;}
table.bb-table td.ctr{text-align:center;}
table.bb-table td.bb-check{cursor:pointer;font-weight:700;user-select:none;min-width:6mm;}
table.bb-table td.bb-check:hover{background:#fff3cd;}
table.bb-table td.bb-check.checked{background:#cfe8ff;color:#003a80;}
table.bb-table thead{display:table-header-group;}
table.bb-table tr{break-inside:avoid;page-break-inside:avoid;}
`;
  (function injectCss() {
    if (document.getElementById('bienBanDocCss')) return;
    const st = document.createElement('style');
    st.id = 'bienBanDocCss';
    st.textContent = BB_CSS;
    document.head.appendChild(st);
  })();

  /* ------------------------------ 6. RENDER ------------------------------ */
  function buildDocPage(doc, docIdx) {
    const wrapper = document.createElement('div');
    wrapper.className = 'doc-page doc-bienban';
    wrapper.contentEditable = 'true';
    wrapper.dataset.docIndex = docIdx;
    const tpl = BB.template;

    const cellHtml = (v, vIdx, key) => {
      const on = !!((v.checks || {})[key]);
      return `<td class="bb-check ${on ? 'checked' : ''}" data-act="toggle-check" data-doc="${docIdx}" data-v="${vIdx}" data-key="${key}">${on ? 'X' : ''}</td>`;
    };
    const rows = doc.vehicles.map((v, i) => `
      <tr>
        <td class="ctr">${i + 1}</td>
        <td class="ctr"><b>${escapeHtml(v.bienSo)}</b></td>
        <td>${escapeHtml(v.loaiXe)}</td>
        ${TT_CHU_XE.map(f => cellHtml(v, i, f.key)).join('')}
        ${TT_XE_CO.map(f => cellHtml(v, i, f.key)).join('')}
        ${TT_XE_KHONG.map(f => cellHtml(v, i, f.key)).join('')}
        ${TT_DANG_KY.map(f => cellHtml(v, i, f.key)).join('')}
      </tr>`).join('');

    wrapper.innerHTML = `
      <div class="bb-header">
        <div class="bb-header-left"><div class="bb-bold">${escapeHtml(tpl.coQuanCapTren)}</div><div class="bb-bold bb-underline">${escapeHtml(tpl.coQuan)}</div></div>
        <div class="bb-header-right"><div class="bb-bold">${escapeHtml(tpl.quocHieu1)}</div><div class="bb-bold bb-underline">${escapeHtml(tpl.quocHieu2)}</div></div>
      </div>
      <div class="bb-title">BIÊN BẢN LÀM VIỆC</div>
      <div class="bb-line">Hôm nay, hồi …… giờ, ngày …… tháng …… năm ………, tại <span class="bb-fill">${escapeHtml(tpl.diaDiem)}</span></div>
      <div class="bb-heading">Chúng tôi gồm:</div>
      <div class="bb-line">- Đ/c: <span class="bb-fill">${escapeHtml(BB.officer || '..............................')}</span>, cán bộ Công an <span class="bb-fill">${escapeHtml(tpl.coQuan)}</span></div>
      <div class="bb-heading">Đã làm việc với:</div>
      <div class="bb-line">- Ông/bà: <span class="bb-fill">${escapeHtml(doc.chuXe)}</span>, CCCD: <span class="bb-fill">${escapeHtml(doc.cccd)}</span>, SĐT: <span class="bb-fill">${escapeHtml(doc.sdt)}</span>, HKTT: <span class="bb-fill">${escapeHtml(doc.diaChi)}</span>, Chỗ ở hiện nay: <span class="bb-fill">..............................</span></div>
      <div class="bb-line">- Ông/bà: <span class="bb-fill">..............................</span>, CCCD: <span class="bb-fill">....................</span>, SĐT: <span class="bb-fill">....................</span>; đại diện gia đình của chủ xe hoặc người đang quản lý sử dụng xe (trường hợp không có chủ xe tại địa bàn)</div>
      <div class="bb-heading">Nội dung làm việc:</div>
      <div class="bb-subheading">1. Cùng xác nhận các thông tin sau (đánh dấu X để xác nhận tình trạng)</div>
      <table class="bb-table">
        <colgroup>
          <col style="width:4%"><col style="width:12%"><col style="width:9%">
          <col style="width:5.5%"><col style="width:5.5%"><col style="width:5.5%"><col style="width:5.5%">
          <col style="width:4%"><col style="width:4%"><col style="width:4%">
          <col style="width:4%"><col style="width:4%"><col style="width:4%">
          <col style="width:5.5%"><col style="width:5.5%"><col style="width:5.5%"><col style="width:5.5%">
        </colgroup>
        <thead>
          <tr>
            <th rowspan="3">STT</th><th rowspan="3">Biển số</th><th rowspan="3">Loại xe (ghi ô tô/mô tô)</th>
            <th colspan="4">Tình trạng chủ xe</th><th colspan="6">Tình trạng của xe</th><th colspan="4">Tình trạng đăng ký, biển số xe</th>
          </tr>
          <tr>
            <th rowspan="2">Có mặt tại địa bàn</th><th rowspan="2">Đã mất</th><th rowspan="2">Không còn ở địa phương</th><th rowspan="2">Cơ quan, doanh nghiệp đã giải thể</th>
            <th colspan="3">Có phương tiện tại địa bàn</th><th colspan="3">Không có phương tiện tại địa bàn</th>
            <th rowspan="2">Có ĐK+BS</th><th rowspan="2">Chỉ có ĐKX</th><th rowspan="2">Chỉ có BS</th><th rowspan="2">Không có ĐK&amp;BS</th>
          </tr>
          <tr>
            <th>Chính chủ đang quản lý, sử dụng</th><th>Chính chủ nhưng không còn sử dụng</th><th>Đã mua nhưng chưa sang tên</th>
            <th>Đã bán, không biết người sử dụng</th><th>Đã mất</th><th>Đã bán phế liệu</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="bb-subheading">2. Cam kết của chủ xe hoặc đại diện gia đình <i>(TH không tìm được chủ xe)</i></div>
      <div class="bb-italic">Gợi ý:</div>
      ${tpl.goiY.map(s => `<div class="bb-bullet">- ${escapeHtml(s)}</div>`).join('')}
      <div class="bb-line" style="margin-top:6pt;">${escapeHtml(tpl.loiCamKet)}</div>
      <div class="bb-sign">
        <div class="bb-sign-col"><div class="bb-bold">NGƯỜI LẬP BIÊN BẢN</div><div class="bb-italic">(Ký ghi rõ họ, tên)</div><div class="bb-sign-space"></div></div>
        <div class="bb-sign-col"><div class="bb-bold">CHỦ XE/ĐẠI DIỆN HỘ GĐ/ĐẠI DIỆN CHÍNH QUYỀN</div><div class="bb-italic">(Ký, ghi rõ họ, tên)</div><div class="bb-sign-space"></div></div>
      </div>`;
    return wrapper;
  }

  function renderAll() {
    const container = document.getElementById('bienBanContainer');
    if (!container) return;
    container.innerHTML = '';
    BB.docs.forEach((doc, idx) => container.appendChild(buildDocPage(doc, idx)));
    const counter = document.getElementById('bbCounter');
    if (counter) counter.textContent = `${BB.docs.length} biên bản`;
  }

  /* ------------------------------ 7. TICK Ô ------------------------------ */
  function toggleCheck(docIdx, vIdx, key) {
    const doc = BB.docs[docIdx]; if (!doc) return;
    const v = doc.vehicles[vIdx]; if (!v) return;
    v.checks = v.checks || {};
    v.checks[key] = !v.checks[key];
    const group = TT_CHU_XE.find(f => f.key === key) ? TT_CHU_XE
      : TT_XE_CO.find(f => f.key === key) ? TT_XE_CO
      : TT_XE_KHONG.find(f => f.key === key) ? TT_XE_KHONG
      : TT_DANG_KY;
    group.forEach(f => { if (f.key !== key) v.checks[f.key] = false; });
    cellState[doc.ownerKey + '|' + vIdx] = { ...v.checks };
    persistCells();
    // Vẽ lại cả nhóm để các ô bị bỏ tick cũng cập nhật
    group.forEach(f => {
      const c = document.querySelector(`.doc-bienban[data-doc-index="${docIdx}"] td.bb-check[data-v="${vIdx}"][data-key="${f.key}"]`);
      if (c) { c.classList.toggle('checked', !!v.checks[f.key]); c.textContent = v.checks[f.key] ? 'X' : ''; }
    });
  }

  /* ------------------------------ 8. MODAL + UI ------------------------------ */
  function ensureModal() {
    let md = document.getElementById('bienBanOverlay');
    if (md) return md;
    md = document.createElement('div');
    md.id = 'bienBanOverlay'; md.className = 'modal-overlay hidden';
    md.innerHTML = `
      <div class="modal modal-lg">
        <div class="modal-header">
          <h2>📝 Biên bản làm việc</h2>
          <div class="commitment-nav">
            <button type="button" id="btnPrevBB" class="btn btn-ghost">‹ Trước</button>
            <span id="bbCounter">1 / 1</span>
            <button type="button" id="btnNextBB" class="btn btn-ghost">Sau ›</button>
          </div>
          <button type="button" class="modal-close" data-close="bienBanOverlay">✕</button>
        </div>
        <div class="modal-body commitment-body">
          <div class="bb-toolbar" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px;">
            <label class="hint" style="margin:0;">Cán bộ thực hiện:</label>
            <select id="bbOfficerSelect" class="row-inline-select" style="min-width:220px;"></select>
            <span class="hint" style="margin-left:auto;">Bấm vào ô trong bảng để đánh dấu X (mỗi nhóm chỉ chọn 1).</span>
          </div>
          <div id="bienBanContainer"></div>
        </div>
        <div class="modal-footer">
          <span class="hint">Có thể sửa trực tiếp nội dung bên trên trước khi in / tải.</span>
          <div class="footer-btns">
            <button type="button" id="btnPrintBB" class="btn btn-secondary">🖨️ In / Xuất PDF</button>
            <button type="button" id="btnDownloadWordBB" class="btn btn-primary">⬇️ Tải về (Word)</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(md);
    md.addEventListener('click', (e) => {
      const b = e.target.closest('[data-close]'); if (b) { md.classList.add('hidden'); return; }
      if (e.target.id === 'bienBanOverlay') { md.classList.add('hidden'); return; }
      const cell = e.target.closest('td.bb-check');
      if (cell) {
        e.preventDefault();
        toggleCheck(parseInt(cell.dataset.doc, 10), parseInt(cell.dataset.v, 10), cell.dataset.key);
      }
    });
    document.getElementById('bbOfficerSelect').addEventListener('change', (e) => {
      const val = e.target.value;
      if (val === ADD_NEW) {
        const name = window.prompt('Nhập tên cán bộ mới:');
        const added = addOfficerToList(name);
        if (!added) { e.target.value = BB.officer || ''; return; }
        BB.officer = added;
        buildOfficerSelect();
      } else {
        BB.officer = val;
      }
      renderAll();
    });
    document.getElementById('btnPrevBB').addEventListener('click', () => scrollDoc(-1));
    document.getElementById('btnNextBB').addEventListener('click', () => scrollDoc(1));
    document.getElementById('btnPrintBB').addEventListener('click', printDocs);
    document.getElementById('btnDownloadWordBB').addEventListener('click', downloadWord);
    return md;
  }
  function buildOfficerSelect() {
    const sel = document.getElementById('bbOfficerSelect');
    if (!sel) return;
    const list = loadOfficerList();
    sel.innerHTML = '<option value="">— Chọn cán bộ —</option>' +
      list.map(n => `<option value="${escapeHtml(n)}" ${BB.officer === n ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('') +
      `<option value="${ADD_NEW}">+ Thêm người mới...</option>`;
    if (BB.officer) sel.value = BB.officer;
  }
  let _scrollIdx = 0;
  function scrollDoc(delta) {
    const pages = document.querySelectorAll('#bienBanContainer .doc-bienban');
    if (!pages.length) return;
    _scrollIdx = Math.max(0, Math.min(pages.length - 1, _scrollIdx + delta));
    pages[_scrollIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ------------------------------ 9. XUẤT PDF ------------------------------ */
  function printDocs() {
    const pages = document.querySelectorAll('#bienBanContainer .doc-bienban');
    if (!pages.length) { (window.toast || console.warn)('Chưa có biên bản nào để in.', true); return; }
    const body = Array.from(pages).map(p => {
      const c = p.cloneNode(true);
      c.removeAttribute('contenteditable');
      c.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
      return c.outerHTML;
    }).join('');
    const printCss = `@page{size:A4;margin:20mm 15mm 18mm 30mm;}
      html,body{margin:0;padding:0;background:#fff;}
      .doc-bienban{width:auto;min-height:0;margin:0;padding:0;box-shadow:none;break-after:page;page-break-after:always;}
      .doc-bienban:last-child{break-after:auto;page-break-after:auto;}`;
    const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Biên bản làm việc</title>` +
      `<style>${BB_CSS}${printCss}</style></head><body>${body}</body></html>`;
    const old = document.getElementById('bienBanPrintFrame');
    if (old) old.remove();
    const iframe = document.createElement('iframe');
    iframe.id = 'bienBanPrintFrame';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;left:-99999px;top:0;border:0;width:210mm;height:297mm;';
    iframe.onload = () => {
      const w = iframe.contentWindow;
      const go = () => { w.onafterprint = () => setTimeout(() => iframe.remove(), 500); w.focus(); w.print(); };
      if (w.document.fonts && w.document.fonts.ready) w.document.fonts.ready.then(() => setTimeout(go, 50)); else setTimeout(go, 100);
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  }

  /* ------------------------------ 10. XUẤT WORD ------------------------------ */
  function downloadWord() {
    const pages = document.querySelectorAll('#bienBanContainer .doc-bienban');
    if (!pages.length) { (window.toast || console.warn)('Chưa có biên bản nào để tải.', true); return; }
    if (typeof ensureDocxLib !== 'function') { (window.toast || console.warn)('Không tìm thấy thư viện xuất Word.', true); return; }
    ensureDocxLib().then(async () => {
      for (let i = 0; i < pages.length; i++) {
        try {
          const doc = buildDocx(pages[i]);
          const blob = await window.docx.Packer.toBlob(doc);
          const owner = (BB.docs[i] && BB.docs[i].chuXe) || ('BienBan_' + (i + 1));
          const safe = (typeof sanitizeFilename === 'function') ? sanitizeFilename(owner) : owner.replace(/[^\w\-]+/g, '_');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = `BienBanLamViec_${safe}.docx`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          await new Promise(r => setTimeout(r, 400));
        } catch (err) {
          console.error(err);
          (window.toast || console.warn)('Lỗi khi tạo file Word cho biên bản #' + (i + 1), true);
        }
      }
    }).catch(err => (window.toast || console.warn)('Không tải được thư viện Word: ' + (err.message || err), true));
  }

  function buildDocx(pageEl) {
    const D = window.docx;
    const { Document, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle, VerticalAlign, ShadingType, UnderlineType } = D;
    const children = [];
    const P = (runs, opt) => new Paragraph(Object.assign({ alignment: AlignmentType.LEFT, spacing: { before: 0, after: 40 }, children: Array.isArray(runs) ? runs : [new TextRun(runs || '')] }, opt || {}));
    const T = (text, o) => new TextRun(Object.assign({ text: text || '' }, o || {}));
    const center = AlignmentType.CENTER, justify = AlignmentType.JUSTIFIED;
    const noBorders = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } };

    const headerL = pageEl.querySelector('.bb-header-left'), headerR = pageEl.querySelector('.bb-header-right');
    const title = pageEl.querySelector('.bb-title')?.textContent || 'BIÊN BẢN LÀM VIỆC';
    const lines = Array.from(pageEl.querySelectorAll('.bb-line, .bb-heading, .bb-subheading, .bb-italic, .bb-bullet'))
      .filter(el => !el.closest('.bb-sign'))
      .map(el => ({ cls: el.className, text: el.textContent || '' }));

    const hL = Array.from(headerL?.children || []).map(el => el.textContent || '');
    const hR = Array.from(headerR?.children || []).map(el => el.textContent || '');
    const maxH = Math.max(hL.length, hR.length);
    const headerRows = [];
    for (let i = 0; i < maxH; i++) headerRows.push(new TableRow({
      children: [
        new TableCell({ children: [P(T(hL[i] || '', { bold: true, underline: i === hL.length - 1 ? { type: UnderlineType.SINGLE } : undefined }), { alignment: center })] }),
        new TableCell({ children: [P(T(hR[i] || '', { bold: true, underline: i === hR.length - 1 ? { type: UnderlineType.SINGLE } : undefined }), { alignment: center })] })
      ]
    }));
    children.push(new Table({ width: { size: 9000, type: WidthType.DXA }, borders: noBorders, rows: headerRows }));
    children.push(P(T(title, { bold: true, size: 30 }), { alignment: center, spacing: { before: 200, after: 160 } }));

    // Nội dung: chèn bảng xe đúng vị trí (sau tiêu đề mục 1)
    let tableInserted = false;
    const insertTable = () => {
      if (tableInserted) return; tableInserted = true;
      const tblEl = pageEl.querySelector('table.bb-table');
      if (!tblEl) return;
      const rows = Array.from(tblEl.querySelectorAll('tr')).map(tr => {
        const isHead = tr.parentElement.tagName.toLowerCase() === 'thead';
        const cells = Array.from(tr.children).map(td => {
          const isCheck = td.classList.contains('bb-check');
          const on = td.classList.contains('checked');
          const txt = isCheck ? (on ? 'X' : '') : (td.textContent || '').trim();
          return new TableCell({
            columnSpan: parseInt(td.getAttribute('colspan') || '1', 10),
            rowSpan: parseInt(td.getAttribute('rowspan') || '1', 10),
            shading: isHead ? { type: ShadingType.CLEAR, fill: 'F0F0F0', color: 'auto' } : undefined,
            verticalAlign: VerticalAlign.CENTER,
            children: [P(T(txt, { bold: isHead || isCheck || !!td.querySelector('b'), size: 16 }), { alignment: center })]
          });
        });
        return new TableRow({ cantSplit: true, tableHeader: isHead, children: cells });
      });
      children.push(new Table({ width: { size: 9350, type: WidthType.DXA }, rows }));
    };
    lines.forEach(l => {
      const txt = l.text.replace(/\s+/g, ' ').trim();
      if (!txt) return;
      if (/^2\./.test(txt) && l.cls.includes('bb-subheading')) insertTable();
      if (l.cls.includes('bb-heading') || l.cls.includes('bb-subheading')) children.push(P(T(txt, { bold: true }), { spacing: { before: 100, after: 40 } }));
      else if (l.cls.includes('bb-italic')) children.push(P(T(txt, { italics: true }), { spacing: { before: 40, after: 40 } }));
      else if (l.cls.includes('bb-bullet')) children.push(P(T(txt), { indent: { left: 400 }, spacing: { before: 0, after: 40 } }));
      else children.push(P(T(txt), { alignment: justify }));
    });
    insertTable();

    const signCols = Array.from(pageEl.querySelectorAll('.bb-sign-col'));
    if (signCols.length) {
      const signCells = signCols.map(col => {
        const sl = Array.from(col.children).filter(el => !el.classList.contains('bb-sign-space')).map(el =>
          P(T((el.textContent || '').trim(), { bold: el.classList.contains('bb-bold'), italics: el.classList.contains('bb-italic') }), { alignment: center, spacing: { before: 0, after: 40 } }));
        sl.push(P('', {}), P('', {}), P('', {}), P('', {}));
        return new TableCell({ children: sl });
      });
      children.push(P('', { spacing: { before: 200, after: 200 } }));
      children.push(new Table({ width: { size: 9000, type: WidthType.DXA }, borders: noBorders, rows: [new TableRow({ children: signCells })] }));
    }

    return new Document({
      creator: 'Quản lý Phương tiện', title: 'Biên bản làm việc',
      styles: { default: { document: { run: { font: 'Times New Roman', size: 26 }, paragraph: { spacing: { line: 312 } } } } },
      sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1701, right: 851 } } }, children }]
    });
  }

  /* ------------------------------ 11. NÚT + MỞ ------------------------------ */
  function openBienBan(preselectRowId) {
    if (!state || !state.rawData || !state.rawData.length) { (window.toast || console.warn)('Chưa có dữ liệu để tạo biên bản.', true); return; }
    if (preselectRowId && state.exportSelected && state.exportSelected.size === 0) state.exportSelected.add(preselectRowId);
    if (!buildDocs()) return;
    ensureModal();
    document.getElementById('bienBanOverlay').classList.remove('hidden');
    buildOfficerSelect();
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
    div.innerHTML = `
      <div class="section-title">📝 Mẫu Biên bản làm việc</div>
      <p class="hint">Bố cục theo file mẫu «BIÊN BẢN LÀM VIỆC LÀM SẠCH DỮ LIỆU ĐKX». Chỉnh sửa các trường bên dưới, lưu lại để dùng cho các lần tạo sau.</p>
      <label class="hint-label">Cơ quan cấp trên</label><input id="bbTplCapTren" class="tpl-input" type="text">
      <label class="hint-label">Cơ quan ban hành</label><input id="bbTplCoQuan" class="tpl-input" type="text">
      <label class="hint-label">Quốc hiệu 1</label><input id="bbTplQH1" class="tpl-input" type="text">
      <label class="hint-label">Quốc hiệu 2 (khẩu hiệu)</label><input id="bbTplQH2" class="tpl-input" type="text">
      <label class="hint-label">Địa điểm (điền vào «tại …»)</label><input id="bbTplDiaDiem" class="tpl-input" type="text">
      <label class="hint-label">Các gợi ý cam kết (mỗi dòng 1 gợi ý)</label>
      <textarea id="bbTplGoiY" class="tpl-textarea" rows="5"></textarea>
      <label class="hint-label">Lời cam kết cuối</label>
      <textarea id="bbTplLoiCamKet" class="tpl-textarea" rows="2"></textarea>
      <div style="margin-top:8px;display:flex;gap:6px;">
        <button type="button" class="btn btn-ghost btn-sm" id="btnBBTplReset">↺ Khôi phục mặc định</button>
        <button type="button" class="btn btn-primary btn-sm" id="btnBBTplSave">💾 Lưu mẫu Biên bản</button>
      </div>
      <div id="bbTplMsg" class="hint" style="margin-top:4px;"></div>`;
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
    fill();
    div.querySelector('#btnBBTplReset').addEventListener('click', () => { BB.template = { ...DEFAULT_TEMPLATE }; fill(); div.querySelector('#bbTplMsg').textContent = 'Đã khôi phục mẫu mặc định (chưa lưu).'; });
    div.querySelector('#btnBBTplSave').addEventListener('click', () => {
      const tpl = {
        coQuanCapTren: div.querySelector('#bbTplCapTren').value.trim() || DEFAULT_TEMPLATE.coQuanCapTren,
        coQuan: div.querySelector('#bbTplCoQuan').value.trim() || DEFAULT_TEMPLATE.coQuan,
        quocHieu1: div.querySelector('#bbTplQH1').value.trim() || DEFAULT_TEMPLATE.quocHieu1,
        quocHieu2: div.querySelector('#bbTplQH2').value.trim() || DEFAULT_TEMPLATE.quocHieu2,
        diaDiem: div.querySelector('#bbTplDiaDiem').value.trim() || DEFAULT_TEMPLATE.diaDiem,
        goiY: div.querySelector('#bbTplGoiY').value.split('\n').map(s => s.trim()).filter(Boolean),
        loiCamKet: div.querySelector('#bbTplLoiCamKet').value.trim() || DEFAULT_TEMPLATE.loiCamKet,
      };
      BB.template = tpl;
      saveTemplate(tpl);
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
