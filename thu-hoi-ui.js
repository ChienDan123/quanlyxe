/* =========================================================================
   thu-hoi-ui.js — Giao diện "Giấy khai thu hồi đăng ký xe, biển số xe"
   -------------------------------------------------------------------------
   Luồng: bấm nút -> hộp thoại hiện thông tin điền sẵn từ dữ liệu xe -> người dùng
   xem lại / sửa -> xem trước (canvas, đúng toạ độ PDF) -> xuất PDF.
   Có thêm phần "In bồi lần 2": nhập tay Mã hồ sơ, ngày tháng năm và các trường
   lần 1 để trống -> xuất file chỉ chứa chữ in bồi.
   Dùng các hàm/biến toàn cục của app.js: state, toast, openModal, escapeHtml,
   downloadBlob, sanitizeFilename, stripDiacritics, splitDiaChiThonXa, ...
   Lõi tạo PDF: thu-hoi.js (window.ThuHoi).
   ========================================================================= */
(function () {
  'use strict';
  const TH = window.ThuHoi;
  if (!TH) return;
  const $q = (s, r = document) => r.querySelector(s);

  /* ---------------------------- 1. NẠP THƯ VIỆN (lười) ---------------------- */
  const LIB_SRC = {
    pdf: ['lib/pdf-lib.min.js', 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'],
    fontkit: ['lib/fontkit.umd.min.js', 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js'],
  };
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res;
      s.onerror = () => { s.remove(); rej(new Error('Không tải được ' + src)); };
      document.head.appendChild(s);
    });
  }
  async function loadFirst(list, test) {
    if (test()) return;
    let last;
    for (const src of list) { try { await loadScript(src); if (test()) return; } catch (e) { last = e; } }
    throw last || new Error('Không nạp được thư viện');
  }
  let ctxPromise = null;
  // Trả về { PDFLib, fontkit, fontBytes, measure } — nạp 1 lần, dùng lại.
  function ensureCtx() {
    if (!ctxPromise) {
      ctxPromise = (async () => {
        await loadFirst(LIB_SRC.pdf, () => !!window.PDFLib);
        await loadFirst(LIB_SRC.fontkit, () => !!window.fontkit);
        const fk = window.fontkit.default || window.fontkit;
        const fontBytes = {};
        for (const k of Object.keys(TH.FONT_FILES)) {
          const r = await fetch('lib/fonts/' + TH.FONT_FILES[k]);
          if (!r.ok) throw new Error('Thiếu phông lib/fonts/' + TH.FONT_FILES[k]);
          fontBytes[k] = new Uint8Array(await r.arrayBuffer());
        }
        // Nạp phông cho canvas xem trước (cùng file phông với PDF).
        const faces = { r: ['normal', 'normal'], b: ['bold', 'normal'], i: ['normal', 'italic'], bi: ['bold', 'italic'] };
        for (const k of Object.keys(faces)) {
          const ff = new FontFace('THSerif', fontBytes[k].buffer.slice(0), { weight: faces[k][0], style: faces[k][1] });
          document.fonts.add(await ff.load());
        }
        return { PDFLib: window.PDFLib, fontkit: fk, fontBytes, measure: TH.makeMeasure(fk, fontBytes) };
      })().catch(e => { ctxPromise = null; throw e; });
    }
    return ctxPromise;
  }

  /* ---------------------------- 2. DỮ LIỆU MẶC ĐỊNH TỪ XE -------------------- */
  const cfg = () => window.ThuHoiConfig || {};
  const norm = (s) => TH.clean(s);
  const THON_PREFIX = /^(thôn|khối|tổ|khu|xóm|ấp|đội|bản|phố|đường|kiệt|hẻm|ngõ|số|\d)/i;

  // "Địa chỉ mới nhất" của chủ xe. Thứ tự ưu tiên (sửa ở đây hoặc ghi đè bằng
  // window.ThuHoiConfig.pickAddress(row) -> { text, source }):
  //   1) cột có tên kiểu «Địa chỉ mới nhất / hiện tại / hiện nay / Nơi ở hiện tại» (cột lạ trong row._extra);
  //   2) Địa chỉ đăng ký (cột cũ) — chỉ là phương án cuối, form sẽ ghi rõ nguồn để người dùng sửa.
  function pickLatestAddress(row) {
    if (typeof cfg().pickAddress === 'function') { const r = cfg().pickAddress(row); if (r && r.text) return r; }
    const pat = /(dia chi (moi nhat|hien tai|hien nay|moi))|(noi o hien (tai|nay))|(noi cu tru)/;
    const extra = row._extra || {};
    for (const h of Object.keys(extra)) {
      if (pat.test(stripDiacritics(h)) && norm(extra[h])) return { text: norm(extra[h]), source: 'cột «' + h + '»' };
    }
    return { text: norm(row.diaChi), source: 'Địa chỉ đăng ký (chưa tìm thấy cột địa chỉ mới nhất)' };
  }
  // Lấy THÔN từ địa chỉ: cụm đầu tiên nếu địa chỉ có ≥ 2 cụm (ngăn bởi dấu phẩy); thêm tiền tố «thôn» nếu thiếu.
  function thonFromAddress(addr) {
    const segs = String(addr || '').split(',').map(s => s.trim()).filter(Boolean);
    let t = segs.length > 1 ? segs[0] : (segs[0] && THON_PREFIX.test(segs[0]) ? segs[0] : '');
    if (t && !THON_PREFIX.test(t)) t = 'thôn ' + t;
    return t;
  }
  const titleCase = (s) => norm(s).toLocaleLowerCase('vi').split(' ').map(w => w.charAt(0).toLocaleUpperCase('vi') + w.slice(1)).join(' ');
  function mauBienText(m) {
    const n = stripDiacritics(m || '');
    if (/vang/.test(n)) return 'Nền màu vàng, chữ và số màu đen';
    if (/xanh/.test(n)) return 'Nền màu xanh, chữ và số màu trắng';
    if (/\bdo\b/.test(n)) return 'Nền màu đỏ, chữ và số màu trắng';
    return 'Nền màu trắng, chữ và số màu đen';
  }
  const DEFAULT_REASON = 'Xe hỏng không sử dụng được hoặc xe bị phá huỷ do nguyên nhân khách quan.';

  function defaultsFromRow(row) {
    const name = norm(typeof stripNameSuffix === 'function' ? stripNameSuffix(row.chuXe) : row.chuXe);
    const phone = norm(String(row.soDienThoai || '').split(/[|,;\/]/)[0]);
    const addr = pickLatestAddress(row);
    const cccd = norm(row.cccd);
    return {
      d1: {
        diaDanh: 'Chiên Đàn', bienSo: norm(row.bienSo), mauBien: mauBienText(row.mauBien),
        chuXe: name.toLocaleUpperCase('vi'), diaChi: thonFromAddress(addr.text), dienThoai: phone,
        cccd, loaiGiayTo: '', coQuanCap: /^\d{12}$/.test(cccd) ? 'Cục CSQLHC' : '', ngayCap: '',
        nguoiLamThuTuc: titleCase(name), soGiayTo: cccd, sdtNguoiLam: phone,
        coQuanNhan: 'CÔNG AN THÀNH PHỐ ĐÀ NẴNG', lyDo: DEFAULT_REASON,
        nhanHieu: norm(row.nhanHieu), soLoai: '',
        loaiXe: norm(typeof c08CleanLoaiXe === 'function' ? c08CleanLoaiXe(row.loaiXe) : row.loaiXe),
        soMay: norm(row.soMay), soKhung: norm(row.soKhung), namSX: '',
      },
      addrNote: 'Nguồn địa chỉ: ' + addr.source + (addr.text ? ' → «' + addr.text + '»' : ''),
    };
  }
  function todayParts() { const d = new Date(); return { ngay: String(d.getDate()), thang: String(d.getMonth() + 1), nam: String(d.getFullYear()) }; }

  /* ---------------------------- 3. HỘP THOẠI --------------------------------- */
  let items = [], cur = 0, view = 'full';   // items: [{ row, d1, boi, addrNote }]
  let rendering = false;

  function ensureModal() {
    if ($q('#thuHoiModal')) return;
    const el = document.createElement('div');
    el.id = 'thuHoiModal'; el.className = 'modal-overlay hidden';
    el.innerHTML = `
    <div class="modal modal-xl th-modal">
      <div class="modal-header">
        <h2>🗒️ Giấy khai thu hồi đăng ký xe, biển số xe</h2>
        <div class="commitment-nav">
          <button type="button" id="thPrev" class="btn btn-ghost">‹ Trước</button>
          <span id="thCounter">1 / 1</span>
          <button type="button" id="thNext" class="btn btn-ghost">Sau ›</button>
        </div>
        <button class="modal-close" data-close="thuHoiModal">✕</button>
      </div>
      <div class="modal-body th-body">
        <div class="th-form" id="thForm"></div>
        <div class="th-preview">
          <div class="th-tabs">
            <button type="button" class="btn btn-primary btn-sm" data-th-view="full">Bản in lần 1</button>
            <button type="button" class="btn btn-ghost btn-sm" data-th-view="boi">Bản in bồi lần 2 (chồng lên lần 1)</button>
          </div>
          <div id="thWarn" class="th-warn hidden"></div>
          <canvas id="thCanvas" class="th-canvas"></canvas>
        </div>
      </div>
      <div class="modal-footer">
        <span class="hint">Bản xem trước vẽ đúng toạ độ file PDF (A: Letter 612×792pt, Times New Roman).</span>
        <div class="footer-btns">
          <button type="button" id="thPdfOne" class="btn btn-primary">⬇️ Xuất PDF (xe này)</button>
          <button type="button" id="thPdfAll" class="btn btn-secondary">⬇️ Xuất PDF tất cả</button>
          <button type="button" id="thBoiOne" class="btn btn-secondary">🖨️ File in bồi lần 2 (xe này)</button>
          <button type="button" id="thBoiAll" class="btn btn-ghost">🖨️ In bồi tất cả</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(el);

    el.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-k]'); if (!inp) return;
      const it = items[cur]; if (!it) return;
      const key = inp.dataset.k;
      if (inp.dataset.scope === 'boi') it.boi[key] = inp.value; else it.d1[key] = inp.value;
      if (inp.dataset.scope !== 'boi') refreshBoiPanel();      // trường lần 1 vừa trống/đầy -> cập nhật danh sách trường in bồi
      scheduleDraw();
    });
    el.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-th-view]');
      if (tab) {
        view = tab.dataset.thView;
        el.querySelectorAll('[data-th-view]').forEach(b => { b.className = 'btn btn-sm ' + (b.dataset.thView === view ? 'btn-primary' : 'btn-ghost'); });
        draw();
      }
    });
    $q('#thPrev').onclick = () => go(-1);
    $q('#thNext').onclick = () => go(1);
    $q('#thPdfOne').onclick = () => exportPdf('full', false);
    $q('#thPdfAll').onclick = () => exportPdf('full', true);
    $q('#thBoiOne').onclick = () => exportPdf('overlay', false);
    $q('#thBoiAll').onclick = () => exportPdf('overlay', true);
  }

  function inputHtml(f, v, scope) {
    const id = 'th_' + (scope || 'd1') + '_' + f.key;
    const common = `id="${id}" data-k="${f.key}" ${scope ? 'data-scope="' + scope + '"' : ''}`;
    const ctl = f.multiline
      ? `<textarea ${common} rows="2" class="tpl-textarea">${escapeHtml(v || '')}</textarea>`
      : `<input ${common} type="text" class="tpl-input" value="${escapeHtml(v || '')}" placeholder="${escapeHtml(f.hint || '')}" autocomplete="off">`;
    return `<label class="hint-label" for="${id}">${escapeHtml(f.label)}</label>${ctl}`;
  }

  function renderForm() {
    const it = items[cur];
    let html = `<p class="hint th-addr">${escapeHtml(it.addrNote)}</p>`;
    let group = '';
    TH.FIELDS.forEach(f => {
      if (f.group !== group) { group = f.group; html += `<div class="section-title">${escapeHtml(group)}</div>`; }
      html += inputHtml(f, it.d1[f.key]);
    });
    html += `<div class="section-title">🖨️ In bồi lần 2 — thông tin điền tay</div>
      <p class="hint">Các chỗ <b>chừa trắng</b> ở bản lần 1: Mã hồ sơ, ngày ký, và mọi trường bạn để trống ở trên. Nhập vào đây để xuất file in bồi (chỉ chứa chữ, đúng vị trí).</p>
      <div id="thBoi"></div>`;
    $q('#thForm').innerHTML = html;
    refreshBoiPanel(true);
    $q('#thCounter').textContent = (cur + 1) + ' / ' + items.length;
  }

  // Danh sách ô in bồi = Mã hồ sơ + ngày/tháng/năm + các trường lần 1 đang để trống.
  let boiSig = '';
  function refreshBoiPanel(force) {
    const it = items[cur];
    const blanks = TH.FIELDS.filter(f => !norm(it.d1[f.key]) && f.key !== 'diaDanh');
    const sig = it.row._rowId + '|' + blanks.map(f => f.key).join(',');
    if (!force && sig === boiSig) return;
    boiSig = sig;
    const focusId = document.activeElement && document.activeElement.id;
    const parts = TH.BOI_FIELDS.map(f => inputHtml(f, it.boi[f.key], 'boi'));
    if (blanks.length) parts.push('<div class="hint-label" style="margin-top:8px">Trường lần 1 để trống — điền ở đây để in bồi:</div>');
    blanks.forEach(f => parts.push(inputHtml(f, it.boi[f.key], 'boi')));
    $q('#thBoi').innerHTML = parts.join('');
    if (focusId) { const e = document.getElementById(focusId); if (e) e.focus(); }
  }

  /* ---------------------------- 4. XEM TRƯỚC (canvas) ------------------------ */
  const SCALE = 1.4;
  let drawTimer = null;
  function scheduleDraw() { clearTimeout(drawTimer); drawTimer = setTimeout(draw, 120); }
  const FSTYLE = { r: '', b: 'bold ', i: 'italic ', bi: 'italic bold ' };

  async function draw() {
    const it = items[cur]; if (!it) return;
    let c; try { c = await ensureCtx(); } catch (e) { toast('Không nạp được thư viện PDF/phông: ' + e.message, true); return; }
    const res = TH.layout(c.measure, it.d1, effectiveBoi(it));
    const cv = $q('#thCanvas'), g = cv.getContext('2d');
    cv.width = TH.PAGE.w * SCALE; cv.height = TH.PAGE.h * SCALE;
    cv.style.width = '100%'; cv.style.maxWidth = (TH.PAGE.w * SCALE) + 'px';
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.textBaseline = 'alphabetic';
    const paint = (ops, color) => ops.forEach(o => {
      g.font = FSTYLE[o.f] + (o.z * SCALE) + 'px THSerif'; g.fillStyle = color; g.fillText(o.s, o.x * SCALE, o.y * SCALE);
    });
    paint(res.full, view === 'boi' ? 'rgba(0,0,0,.28)' : '#000');
    g.strokeStyle = view === 'boi' ? 'rgba(0,0,0,.28)' : '#000';
    res.rules.forEach(r => { g.lineWidth = r.w * SCALE; g.beginPath(); g.moveTo(r.x1 * SCALE, r.y * SCALE); g.lineTo(r.x2 * SCALE, r.y * SCALE); g.stroke(); });
    if (view === 'boi') paint(res.overlay, '#c00000');       // chữ in bồi tô đỏ để dễ nhận
    const w = $q('#thWarn');
    w.classList.toggle('hidden', !res.warnings.length);
    w.innerHTML = res.warnings.map(x => '⚠ ' + escapeHtml(x)).join('<br>');
  }

  /* ---------------------------- 5. XUẤT PDF ---------------------------------- */
  // Dữ liệu in bồi gửi vào lõi: chỉ giữ giá trị đã nhập (trường trống thì bỏ).
  function effectiveBoi(it) { return it.boi; }

  async function exportPdf(mode, all) {
    const list = all ? items : [items[cur]];
    const btns = ['#thPdfOne', '#thPdfAll', '#thBoiOne', '#thBoiAll'].map(s => $q(s));
    btns.forEach(b => { b.disabled = true; });
    try {
      const c = await ensureCtx();
      if (mode === 'overlay') {
        const noData = list.filter(it => !Object.keys(it.boi).some(k => norm(it.boi[k])));
        if (noData.length === list.length) { toast('Chưa nhập thông tin in bồi nào (Mã hồ sơ, ngày tháng năm…).', true); return; }
      }
      const bytes = await TH.createPdf(c.PDFLib, c.fontkit, c.fontBytes, list.map(it => ({ d1: it.d1, d2: it.boi, mode })));
      const base = list.length === 1 ? sanitizeFilename(list[0].d1.bienSo || list[0].d1.chuXe) : list.length + 'xe';
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), (mode === 'overlay' ? 'InBoi_GiayKhaiThuHoi_' : 'GiayKhaiThuHoi_') + base + '.pdf');
      toast('Đã xuất ' + (mode === 'overlay' ? 'file in bồi lần 2' : 'PDF') + ' (' + list.length + ' trang).');
    } catch (e) {
      console.error(e); toast('Lỗi xuất PDF: ' + (e && e.message ? e.message : e), true);
    } finally { btns.forEach(b => { b.disabled = false; }); }
  }

  /* ---------------------------- 6. ĐIỀU HƯỚNG + MỞ --------------------------- */
  function go(d) { cur = Math.min(items.length - 1, Math.max(0, cur + d)); renderForm(); draw(); }

  async function open(rows) {
    if (!rows.length) { toast('Chưa có xe nào để lập Giấy khai thu hồi. Hãy tích chọn xe (checkbox) trước.', true); return; }
    ensureModal();
    const t = todayParts();
    items = rows.map(row => { const d = defaultsFromRow(row); return { row, d1: d.d1, boi: { ngay: t.ngay, thang: t.thang, nam: t.nam }, addrNote: d.addrNote }; });
    cur = 0; view = 'full'; boiSig = '';
    $q('#thPrev').style.visibility = $q('#thNext').style.visibility = items.length > 1 ? 'visible' : 'hidden';
    $q('#thPdfAll').style.display = $q('#thBoiAll').style.display = items.length > 1 ? '' : 'none';
    document.querySelectorAll('[data-th-view]').forEach(b => { b.className = 'btn btn-sm ' + (b.dataset.thView === 'full' ? 'btn-primary' : 'btn-ghost'); });
    openModal('thuHoiModal');
    renderForm();
    draw();
  }

  // Nút ở thanh công cụ (các xe đã tích chọn) và nút trong panel chi tiết (xe đang xem).
  document.addEventListener('click', (e) => {
    if (e.target.closest('#btnThuHoi')) open(state.rawData.filter(r => state.exportSelected.has(r._rowId)));
    else if (e.target.closest('#btnThuHoiPanel') && typeof currentDetailRow !== 'undefined' && currentDetailRow) open([currentDetailRow]);
  });
  window.ThuHoiUI = { open, pickLatestAddress, thonFromAddress };
})();
