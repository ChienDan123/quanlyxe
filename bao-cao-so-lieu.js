/* =========================================================================
   bao-cao-so-lieu.js (MỚI) — Báo cáo số liệu theo mẫu «Báo_cáo_hàng_ngày_kết_quả_LSDL.xlsx».
   Nạp SAU app.js (thêm <script src="bao-cao-so-lieu.js"></script> vào index.html).
   GIẢ ĐỊNH (chưa có file xlsx): tiêu đề tầng 4–5 và các ô nhóm C–I dựng theo mô tả; ánh xạ dữ liệu
   chỉ dùng cột «Chuyên đề» (theo từ khóa) + «Trạng thái xe» chứa «thu hồi». Ô khác để TRỐNG, không bịa số.
   ========================================================================= */
(function () {
  'use strict';
  if (window.__baoCaoSoLieuLoaded) return; window.__baoCaoSoLieuLoaded = true;

  const NCOL = 48;                                   // A..AV
  const colName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const NOTES_TEMPLATE = ['Ghi chú:'];               // DÁN nguyên văn các ghi chú 1–3 của file mẫu vào mảng này
  // Nhóm báo cáo: cột «Tổng», cột «Tổng thu hồi», regex từ khóa Chuyên đề (đã bỏ dấu, viết thường)
  const GROUPS = [
    { tot: 11, rev: 17, re: /het nien han/ },
    { tot: 23, rev: 29, re: /kiem dinh/ },
    { tot: 36, rev: 42, re: /nhan hieu|20 nam/ },
  ];

  /* ---- dựng mô hình bảng (dùng chung cho HTML và Excel) ---- */
  function build() {
    const M = {}, merges = [];
    const put = (r, c, v, f) => { M[r + ',' + c] = { v, f }; };
    const mg = (r1, c1, r2, c2) => merges.push([r1, c1, r2, c2]);
    const vm = (c, t) => { put(4, c, t); mg(4, c, 5, c); };
    put(1, 1, 'KẾT QUẢ CÔNG TÁC LÀM SẠCH DỮ LIỆU ĐĂNG KÝ XE'); mg(1, 1, 1, 47);
    put(3, 1, 'STT'); mg(3, 1, 5, 1); put(3, 2, 'TÊN ĐƠN VỊ'); mg(3, 2, 5, 2);
    [[3, 5, 'Hướng dẫn cài đặt VNeTraffic'], [6, 7, 'Rà soát xe một chủ nhiều phương tiện'], [8, 9, 'Chuyển nhượng quá 30 ngày']].forEach(([a, b, t]) => {
      put(3, a, t); mg(3, a, 3, b); for (let c = a; c <= b; c++) vm(c, 'Cột ' + colName(c));
    });
    const grp = (c0, title, extra) => {
      put(3, c0, title); mg(3, c0, 3, c0 + 11 + (extra ? 1 : 0));
      vm(c0, 'Trong ngày'); vm(c0 + 1, 'Tổng');
      put(4, c0 + 2, 'Hiện trạng tại địa bàn'); mg(4, c0 + 2, 4, c0 + 5);
      ['Có chủ, có xe', 'Có chủ, không xe', 'Không chủ, có xe', 'Không chủ, không xe'].forEach((t, i) => put(5, c0 + 2 + i, t));
      vm(c0 + 6, 'Thu hồi trong ngày'); vm(c0 + 7, 'Tổng thu hồi');
      put(4, c0 + 8, 'Kết quả thu hồi'); mg(4, c0 + 8, 4, c0 + 11);
      ['Thu được ĐK & BS', 'Chỉ thu ĐK', 'Chỉ thu BS', 'Không thu được'].forEach((t, i) => put(5, c0 + 8 + i, t));
      if (extra) vm(c0 + 12, 'Đã đăng kiểm lại');
    };
    grp(10, 'Xe hết niên hạn'); grp(22, 'Ô tô chưa kiểm định từ 30/6/2024', true); grp(35, 'Nhãn hiệu không còn tồn tại hoặc đăng ký trên 20 năm');
    put(3, 47, 'Cập nhật lại trạng thái trên hệ thống ĐKX'); mg(3, 47, 5, 47);
    put(3, 48, 'KẾT QUẢ LSDL CHUNG'); mg(3, 48, 5, 48);

    // ---- dữ liệu: dòng 6 «Có phiếu scan», dòng 7 «Không phiếu» ----
    const cnt = [{}, {}];
    for (const r of (typeof state !== 'undefined' && state.rawData) || []) {
      const has = !!(String(r.phieuScan || '').trim() || (window.ScanHooks && String(window.ScanHooks.badgeHtml(r) || '').trim()));
      const d = cnt[has ? 0 : 1];
      const cds = String(r.chuyenDe || '').split(CHUYENDE_SPLIT_RE).map(s => stripDiacritics(s).toLowerCase().trim()).filter(Boolean);
      const thuHoi = stripDiacritics(r.trangThaiXe || '').toLowerCase().includes('thu hoi');
      GROUPS.forEach(g => {
        if (!cds.some(x => g.re.test(x))) return;
        d[g.tot] = (d[g.tot] || 0) + 1;
        if (thuHoi) d[g.rev] = (d[g.rev] || 0) + 1;
      });
    }
    GROUPS.forEach(g => [g.tot, g.rev].forEach(c => { [0, 1].forEach(i => { cnt[i][c] = cnt[i][c] || 0; }); }));   // có quy tắc -> 0 là số thật
    ['Có phiếu scan', 'Không phiếu'].forEach((name, i) => { put(6 + i, 1, i + 1); put(6 + i, 2, name); for (const c in cnt[i]) put(6 + i, +c, cnt[i][c]); });
    put(8, 1, 'TỔNG'); mg(8, 1, 8, 2);
    const val = (r, c) => { const x = M[r + ',' + c]; return x && typeof x.v === 'number' ? x.v : 0; };
    for (let c = 3; c <= 47; c++) put(8, c, val(6, c) + val(7, c), 'SUM(' + colName(c) + '6:' + colName(c) + '7)');
    [6, 7, 8].forEach(r => put(r, 48, [7, 11, 23, 36].reduce((s, c) => s + val(r, c), 0), 'SUM(G' + r + ',K' + r + ',W' + r + ',AJ' + r + ')'));
    // ô trống (không có nguồn) để liệt kê
    const filled = new Set(GROUPS.flatMap(g => [g.tot, g.rev]));
    const blanks = []; let s = null;
    for (let c = 3; c <= 48; c++) {
      const isB = c <= 47 && !filled.has(c);
      if (isB && s == null) s = c;
      if ((!isB || c === 48) && s != null) { const e = c - 1; blanks.push(s === e ? colName(s) : colName(s) + '–' + colName(e)); s = null; }
    }
    const notes = NOTES_TEMPLATE.slice();
    notes.push('Ô để trống (chưa có nguồn dữ liệu đáng tin trên web): cột ' + blanks.join(', ') + '. Cột «Tổng»/«Tổng thu hồi» tính từ Chuyên đề (từ khóa) và Trạng thái xe chứa «thu hồi» — cần xác nhận quy tắc.');
    return { M, merges, notes };
  }

  /* ---- HTML ---- */
  function renderHtml(model) {
    const { M, merges } = model, skip = new Set(), span = {};
    merges.forEach(([r1, c1, r2, c2]) => { span[r1 + ',' + c1] = [r2 - r1 + 1, c2 - c1 + 1]; for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) skip.add(r + ',' + c); });
    let h = '<table style="border-collapse:collapse;font-size:12px;min-width:2400px">';
    for (let r = 1; r <= 8; r++) {
      if (r === 2) continue;
      h += '<tr>';
      for (let c = 1; c <= NCOL; c++) {
        const k = r + ',' + c; if (skip.has(k)) continue;
        const sp = span[k], x = M[k], head = r <= 5, bold = head || r === 8;
        h += '<td' + (sp ? ' rowspan="' + sp[0] + '" colspan="' + sp[1] + '"' : '') + ' style="border:1px solid #888;padding:3px 5px;text-align:center;vertical-align:middle;' +
          (bold ? 'font-weight:700;' : '') + (head ? 'background:#d9e1f2;' : '') + (r === 1 ? 'font-size:15px;' : '') + '">' + (x && x.v !== '' && x.v != null ? String(x.v).replace(/</g, '&lt;') : '') + '</td>';
      }
      h += '</tr>';
    }
    return h + '</table><p class="hint" style="margin-top:8px">' + model.notes.map(n => String(n).replace(/</g, '&lt;')).join('<br>') + '</p>';
  }

  /* ---- Excel ---- */
  async function exportXlsx() {
    const lib = await c08LoadLib();
    if (!lib) { toast('Không tải được thư viện Excel.', true); return; }
    const X = lib.XLSX, model = build(), { M, merges } = model, ws = {};
    const thin = { style: 'thin', color: { rgb: '000000' } }, bd = { top: thin, bottom: thin, left: thin, right: thin };
    const sty = (r) => !lib.styled ? undefined : (r === 1 ? { font: { bold: true, sz: 14 }, alignment: { horizontal: 'center', vertical: 'center' } }
      : { font: { bold: r <= 5 || r === 8 }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: bd, fill: r <= 5 ? { fgColor: { rgb: 'D9E1F2' } } : undefined });
    for (let r = 1; r <= 8; r++) for (let c = 1; c <= NCOL; c++) {
      const x = M[r + ',' + c], cell = {};
      if (x && x.f) { cell.t = 'n'; cell.f = x.f; cell.v = x.v; }
      else if (x && typeof x.v === 'number') { cell.t = 'n'; cell.v = x.v; }
      else { cell.t = 's'; cell.v = x && x.v != null ? String(x.v) : ''; }
      const s = sty(r); if (s) cell.s = s;
      ws[X.utils.encode_cell({ r: r - 1, c: c - 1 })] = cell;
    }
    model.notes.forEach((n, i) => { ws[X.utils.encode_cell({ r: 9 + i, c: 0 })] = { t: 's', v: String(n) }; });
    ws['!ref'] = 'A1:' + colName(NCOL) + (9 + model.notes.length);
    ws['!merges'] = merges.map(m => ({ s: { r: m[0] - 1, c: m[1] - 1 }, e: { r: m[2] - 1, c: m[3] - 1 } }));
    ws['!cols'] = Array.from({ length: NCOL }, (_, i) => ({ wch: i === 1 ? 18 : (i === 0 ? 6 : 13) }));
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Báo cáo');
    const d = (document.getElementById('bcDate') || {}).value || new Date().toISOString().slice(0, 10);
    X.writeFile(wb, 'Bao_cao_so_lieu_' + d + '.xlsx');
  }

  /* ---- hộp thoại + nút ---- */
  function openDialog() {
    let m = document.getElementById('bcModal');
    if (!m) {
      m = document.createElement('div'); m.id = 'bcModal'; m.className = 'modal-overlay hidden'; m.style.zIndex = 10070;
      m.innerHTML = '<div class="modal modal-xl"><div class="modal-header"><h2>📊 Báo cáo số liệu</h2><button type="button" class="modal-close" data-bc="close">✕</button></div>' +
        '<div class="modal-body"><label class="hint">Ngày báo cáo (đặt tên file; các cột «trong ngày» chưa có nguồn nên để trống): <input type="date" id="bcDate"></label>' +
        '<div id="bcBody" style="overflow:auto;max-height:60vh;margin-top:8px"></div></div>' +
        '<div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 16px"><button type="button" class="btn btn-secondary" data-bc="close">Đóng</button>' +
        '<button type="button" class="btn btn-primary" data-bc="xlsx">⬇ Xuất Excel</button></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-bc]'); if (!b) return;
        if (b.dataset.bc === 'close') m.classList.add('hidden'); else exportXlsx();
      });
      m.querySelector('#bcDate').value = new Date().toISOString().slice(0, 10);
    }
    if (!(state.rawData || []).length) toast('Chưa tải danh sách xe — bảng sẽ chưa có số liệu.', true);
    m.querySelector('#bcBody').innerHTML = renderHtml(build());
    m.classList.remove('hidden');
  }
  function injectBtn() {
    if (document.getElementById('btnBaoCaoSoLieu')) return true;
    const a = document.getElementById('btnCreateBienBan') || document.getElementById('btnThuHoi') || document.getElementById('btnSettings');
    if (!a) return false;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'btnBaoCaoSoLieu'; b.className = 'btn btn-secondary'; b.textContent = '📊 Báo cáo số liệu';
    b.title = 'Xem / xuất Excel báo cáo kết quả làm sạch dữ liệu (Có phiếu scan / Không phiếu)';
    b.addEventListener('click', openDialog);
    a.insertAdjacentElement('afterend', b); return true;
  }
  let tries = 0;
  const iv = setInterval(() => { if (injectBtn() || ++tries > 20) clearInterval(iv); }, 500);
})();