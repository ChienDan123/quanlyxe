/* =========================================================================
   thu-hoi-ui.js — Giao diện "Giấy khai thu hồi đăng ký xe, biển số xe"
   -------------------------------------------------------------------------
   Luồng: bấm nút -> hộp thoại hiện thông tin điền sẵn từ dữ liệu xe -> người dùng
   xem lại / sửa -> xem trước (canvas, đúng toạ độ PDF) -> xuất PDF hoặc IN TRỰC TIẾP.
   Có thêm phần "In bồi lần 2": TÍCH CHỌN các mục đưa vào file in bồi (kể cả mục đã
   xoá khỏi bản lần 1 — giá trị cũ được nhớ lại), + Mã hồ sơ, ngày tháng năm.
   Đồng bộ ngược về Google Sheet (qua updateSingleRowFields của app.js):
     - sửa Địa chỉ trên form  -> ghi cột «Phường/Xã mới»;
     - sửa Số CCCD trên form  -> ghi thêm vào «Ghi Chú»:
                                 "sửa CCCD từ [CŨ] sang [MỚI] khi in thu hồi";
     (chỉ ghi khi người dùng Xuất / In / Sao chép — không ghi theo từng phím gõ).
   Chuyển sang cổng dichvucong: nút «Sao chép → Dịch vụ công» + bookmarklet
   (nguồn: dvc-fill.js) vì trình duyệt không cho điều khiển tab khác trực tiếp.
   Dùng các hàm/biến toàn cục của app.js: state, toast, openModal, escapeHtml,
   downloadBlob, sanitizeFilename, stripDiacritics, updateSingleRowFields, renderTable...
   Lõi tạo PDF: thu-hoi.js (window.ThuHoi).
   ========================================================================= */
(function () {
  'use strict';
  const TH = window.ThuHoi;
  if (!TH) return;
  const $q = (s, r = document) => r.querySelector(s);
  const BUILD = '20261026b';                       // đổi cùng số ?v= trong index.html để tránh cache

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

  // "Địa chỉ" của chủ xe. Thứ tự ưu tiên:
  //   0) cột «Phường/Xã mới» (row.phuongXaMoi) — ƯU TIÊN SỐ 1, lấy NGUYÊN VĂN (form và Sheet luôn khớp nhau);
  //   1) window.ThuHoiConfig.pickAddress(row) -> { text, source } nếu có cấu hình riêng;
  //   2) cột có tên kiểu «Địa chỉ mới nhất / hiện tại / hiện nay / Nơi ở hiện tại» (row._extra);
  //   3) Địa chỉ đăng ký (cột cũ) — phương án cuối, chỉ lấy phần THÔN.
  // fromMoi = true khi lấy từ cột Phường/Xã mới (dùng nguyên văn, không cắt lấy thôn).
  function pickLatestAddress(row) {
    const moi = norm(row.phuongXaMoi);
    if (moi) return { text: moi, source: 'cột «Phường/Xã mới»', fromMoi: true };
    if (typeof cfg().pickAddress === 'function') { const r = cfg().pickAddress(row); if (r && r.text) return r; }
    const pat = /(dia chi (moi nhat|hien tai|hien nay|moi))|(noi o hien (tai|nay))|(noi cu tru)/;
    const extra = row._extra || {};
    for (const h of Object.keys(extra)) {
      if (pat.test(stripDiacritics(h)) && norm(extra[h])) return { text: norm(extra[h]), source: 'cột «' + h + '»' };
    }
    return { text: norm(row.diaChi), source: 'Địa chỉ đăng ký (cột «Phường/Xã mới» đang trống)' };
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
  // 3 lý do thu hồi — đúng nguyên văn (định nghĩa ở thu-hoi.js, dự phòng ở đây nếu thiếu).
  const REASONS = TH.REASONS || [
    'Xe hỏng không sử dụng được hoặc xe bị phá huỷ do nguyên nhân khách quan.',
    'Xe hết niên hạn sử dụng; xe không được phép lưu hành theo quy định của pháp luật.',
    'Xe bị mất cắp, chiếm đoạt không tìm được, chủ xe đề nghị thu hồi giấy chứng nhận đăng ký xe.',
  ];
  const DEFAULT_REASON = REASONS[0];

  function defaultsFromRow(row) {
    const name = norm(typeof stripNameSuffix === 'function' ? stripNameSuffix(row.chuXe) : row.chuXe);
    const phone = norm(String(row.soDienThoai || '').split(/[|,;\/]/)[0]);
    const addr = pickLatestAddress(row);
    const cccd = norm(row.cccd);
    return {
      d1: {
        diaDanh: 'Chiên Đàn', bienSo: norm(row.bienSo), mauBien: mauBienText(row.mauBien),
        chuXe: name.toLocaleUpperCase('vi'), diaChi: addr.fromMoi ? addr.text : thonFromAddress(addr.text), dienThoai: phone,
        cccd, loaiGiayTo: '', coQuanCap: /^\d{12}$/.test(cccd) ? 'Cục CSQLHC' : '', ngayCap: '',
        nguoiLamThuTuc: titleCase(name), soGiayTo: cccd, sdtNguoiLam: phone,
        coQuanNhan: 'CÔNG AN THÀNH PHỐ ĐÀ NẴNG', lyDo: DEFAULT_REASON,
        nhanHieu: norm(row.nhanHieu), soLoai: '',
        loaiXe: norm(typeof c08CleanLoaiXe === 'function' ? c08CleanLoaiXe(row.loaiXe) : row.loaiXe),
        soMay: norm(row.soMay), soKhung: norm(row.soKhung), namSX: '',
      },
      addrNote: 'Nguồn địa chỉ: ' + addr.source + (addr.text ? ' → «' + addr.text + '»' : '') +
        '. Sửa ở đây rồi Xuất/In sẽ tự lưu vào cột «Phường/Xã mới» trên Sheet.',
    };
  }
  function todayParts() { const d = new Date(); return { ngay: String(d.getDate()), thang: String(d.getMonth() + 1), nam: String(d.getFullYear()) }; }

  /* ---------------------------- 3. TRẠNG THÁI MỖI XE ------------------------- */
  // item = {
  //   row, d1 (dữ liệu bản lần 1), addrNote,
  //   boi  : giá trị người dùng GÕ ở khung in bồi (key -> text),
  //   sel  : tích chọn đưa vào in bồi (key -> bool); chưa đặt = mặc định (xem isSel),
  //   last : giá trị KHÔNG TRỐNG gần nhất của từng trường lần 1 (để nhớ lại khi bị xoá),
  //   orig : { cccd, diaChi } — giá trị gốc để biết người dùng có sửa hay không }
  let items = [], cur = 0, view = 'full';

  const boiVal = (it, k) => (it.boi[k] !== undefined ? it.boi[k] : (it.last[k] || ''));
  function isSel(it, k) {
    if (it.sel[k] !== undefined) return it.sel[k];
    if (k === 'maHoSo' || k === 'ngayThang') return true;   // luôn chọn sẵn; trống thì không in gì
    return !!norm(boiVal(it, k));                           // trường lần 1 để trống: chọn sẵn nếu có giá trị nhớ lại
  }
  // Giá trị "hiệu lực" của 1 trường: lần 1 nếu có, không thì giá trị đã chọn in bồi.
  function effValue(it, k) {
    const v = norm(it.d1[k]);
    if (v) return v;
    return isSel(it, k) ? norm(boiVal(it, k)) : '';
  }
  // Dữ liệu in bồi gửi vào lõi: chỉ các mục ĐƯỢC TÍCH CHỌN (và có giá trị).
  function effectiveBoi(it) {
    const d2 = {};
    if (isSel(it, 'maHoSo')) d2.maHoSo = boiVal(it, 'maHoSo');
    if (isSel(it, 'ngayThang')) { d2.ngay = boiVal(it, 'ngay'); d2.thang = boiVal(it, 'thang'); d2.nam = boiVal(it, 'nam'); }
    TH.FIELDS.forEach(f => {
      if (f.key === 'diaDanh' || norm(it.d1[f.key])) return;   // lần 1 đã in -> không in bồi lại
      if (isSel(it, f.key) && norm(boiVal(it, f.key))) d2[f.key] = boiVal(it, f.key);
    });
    return d2;
  }

  /* ---------------------------- 4. HỘP THOẠI --------------------------------- */
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
          <div id="thDvcHelp" class="th-help hidden"></div>
          <canvas id="thCanvas" class="th-canvas"></canvas>
        </div>
      </div>
      <div class="modal-footer th-footer">
        <span class="hint">Xem trước vẽ đúng toạ độ file PDF (Letter 612×792pt). Khi in: chọn tỉ lệ <b>100% / Kích thước thực</b>, không chọn «Vừa trang».</span>
        <div class="footer-btns th-btnrow">
          <b class="th-grp">Bản lần 1:</b>
          <button type="button" class="btn btn-primary" data-th-act="print" data-th-mode="full" data-th-all="0">🖨️ In trực tiếp</button>
          <button type="button" class="btn btn-secondary" data-th-act="pdf" data-th-mode="full" data-th-all="0">⬇️ Xuất PDF</button>
          <button type="button" class="btn btn-secondary th-multi" data-th-act="print" data-th-mode="full" data-th-all="1">🖨️ In tất cả</button>
          <button type="button" class="btn btn-ghost th-multi" data-th-act="pdf" data-th-mode="full" data-th-all="1">⬇️ PDF tất cả</button>
        </div>
        <div class="footer-btns th-btnrow">
          <b class="th-grp">In bồi lần 2:</b>
          <button type="button" class="btn btn-primary" data-th-act="print" data-th-mode="overlay" data-th-all="0">🖨️ In bồi trực tiếp</button>
          <button type="button" class="btn btn-secondary" data-th-act="pdf" data-th-mode="overlay" data-th-all="0">⬇️ File in bồi</button>
          <button type="button" class="btn btn-secondary th-multi" data-th-act="print" data-th-mode="overlay" data-th-all="1">🖨️ In bồi tất cả</button>
          <button type="button" class="btn btn-ghost th-multi" data-th-act="pdf" data-th-mode="overlay" data-th-all="1">⬇️ File in bồi tất cả</button>
        </div>
        <div class="footer-btns th-btnrow">
          <b class="th-grp">Cổng dịch vụ công:</b>
          <button type="button" class="btn btn-primary" data-th-act="dvc" data-th-mode="full" data-th-all="0">📋 Sao chép → Dịch vụ công</button>
          <button type="button" class="btn btn-ghost" id="thDvcHelpBtn">❓ Hướng dẫn / cài dấu trang</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(el);

    // Gõ / chọn trong form: cập nhật dữ liệu rồi vẽ lại. Dùng cả 'input' lẫn 'change' (select, checkbox).
    const onEdit = (e) => {
      const it = items[cur]; if (!it) return;
      const chk = e.target.closest('[data-sel]');
      if (chk) { it.sel[chk.dataset.sel] = chk.checked; scheduleDraw(); return; }
      const inp = e.target.closest('[data-k]'); if (!inp) return;
      const key = inp.dataset.k;
      if (inp.dataset.scope === 'boi') {
        it.boi[key] = inp.value;
        // Gõ giá trị vào ô in bồi -> tự tích chọn mục đó (xoá hết thì bỏ tích).
        if (key !== 'maHoSo' && !['ngay', 'thang', 'nam'].includes(key)) {
          it.sel[key] = !!norm(inp.value);
          const c = el.querySelector('[data-sel="' + key + '"]'); if (c) c.checked = it.sel[key];
        }
      } else {
        const old = it.d1[key];
        it.d1[key] = inp.value;
        // Nhớ giá trị không trống: ô chữ nhớ khi rời ô (change) để không nhớ nửa chừng lúc đang xoá từng ký tự.
        if ((e.type === 'change' || inp.tagName === 'SELECT') && norm(inp.value)) it.last[key] = inp.value;
        // Đổi CCCD: «Số giấy tờ» đang trùng CCCD cũ thì đi theo CCCD mới (tránh quên sửa).
        if (key === 'cccd' && e.type === 'input' && norm(it.d1.soGiayTo) === norm(old)) {
          it.d1.soGiayTo = inp.value;
          const sg = $q('#th_d1_soGiayTo'); if (sg) sg.value = inp.value;
        }
        refreshBoiPanel();          // trường lần 1 vừa trống/đầy -> cập nhật danh sách mục in bồi
      }
      scheduleDraw();
    };
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);

    el.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-th-view]');
      if (tab) { setView(tab.dataset.thView); return; }
      const all = e.target.closest('[data-th-boiall]');             // Chọn tất cả / Bỏ chọn tất cả (in bồi)
      if (all) {
        const it = items[cur], on = all.dataset.thBoiall === '1';
        el.querySelectorAll('#thBoi [data-sel]').forEach(c => { c.checked = on; it.sel[c.dataset.sel] = on; });
        scheduleDraw(); return;
      }
      const act = e.target.closest('[data-th-act]');
      if (act) runAction(act.dataset.thAct, act.dataset.thMode, act.dataset.thAll === '1');
    });
    $q('#thPrev').onclick = () => go(-1);
    $q('#thNext').onclick = () => go(1);
    $q('#thDvcHelpBtn').onclick = toggleDvcHelp;
  }

  function setView(v) {
    view = v;
    document.querySelectorAll('[data-th-view]').forEach(b => { b.className = 'btn btn-sm ' + (b.dataset.thView === view ? 'btn-primary' : 'btn-ghost'); });
    draw();
  }

  // Ô nhập (không kèm nhãn). «Lý do thu hồi» là ô CHỌN 3 lựa chọn nguyên văn (+ giá trị hiện có nếu khác).
  function controlHtml(f, v, scope) {
    const id = 'th_' + (scope || 'd1') + '_' + f.key;
    const common = `id="${id}" data-k="${f.key}" ${scope ? 'data-scope="' + scope + '"' : ''}`;
    if (f.key === 'lyDo') {
      const list = REASONS.slice();
      const curV = norm(v);
      if (curV && !list.includes(curV)) list.unshift(curV);          // giữ giá trị tuỳ chỉnh có sẵn
      const blank = `<option value="" ${curV ? '' : 'selected'}>— Để trống (in bồi lần 2) —</option>`;
      return `<select ${common} class="tpl-input">${blank}${list.map(r => `<option value="${escapeHtml(r)}" ${r === curV ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}</select>`;
    }
    return `<input ${common} type="text" class="tpl-input" value="${escapeHtml(v || '')}" placeholder="${escapeHtml(f.hint || '')}" autocomplete="off">`;
  }
  function inputHtml(f, v, scope) {
    return `<label class="hint-label" for="th_${scope || 'd1'}_${f.key}">${escapeHtml(f.label)}</label>` + controlHtml(f, v, scope);
  }
  // Dòng "tích chọn + ô nhập" của khung in bồi.
  function boiRowHtml(it, f) {
    return `<div class="th-boi-row"><label class="th-chk"><input type="checkbox" data-sel="${f.key}" ${isSel(it, f.key) ? 'checked' : ''}> ${escapeHtml(f.label)}</label>` +
      controlHtml(f, boiVal(it, f.key), 'boi') + '</div>';
  }

  function renderForm() {
    const it = items[cur];
    let html = `<p class="hint th-addr">${escapeHtml(it.addrNote)}</p>`;
    let group = '';
    TH.FIELDS.forEach(f => {
      if (f.group !== group) { group = f.group; html += `<div class="section-title">${escapeHtml(group)}</div>`; }
      html += inputHtml(f, it.d1[f.key]);
    });
    html += `<div class="section-title">🖨️ In bồi lần 2 — chọn mục đưa vào file in bồi</div>
      <p class="hint">Tích các mục muốn in bồi. Mục nào bạn <b>đã xoá</b> khỏi bản lần 1 sẽ hiện ở đây kèm giá trị cũ (sửa được). Mục còn đầy ở bản lần 1 đã được in nên không in bồi lại.</p>
      <div id="thBoi"></div>`;
    $q('#thForm').innerHTML = html;
    refreshBoiPanel(true);
    $q('#thCounter').textContent = (cur + 1) + ' / ' + items.length;
  }

  // Khung in bồi = Mã hồ sơ + ngày tháng năm + các trường lần 1 đang để trống (mỗi mục có ô tích chọn).
  let boiSig = '';
  function refreshBoiPanel(force) {
    const it = items[cur];
    const blanks = TH.FIELDS.filter(f => !norm(it.d1[f.key]) && f.key !== 'diaDanh');
    const sig = it.row._rowId + '|' + blanks.map(f => f.key).join(',');
    if (!force && sig === boiSig) return;
    boiSig = sig;
    const focusId = document.activeElement && document.activeElement.id;
    const maHoSo = TH.BOI_FIELDS.find(f => f.key === 'maHoSo');
    const parts = [
      `<div class="th-boi-tools"><button type="button" class="btn btn-ghost btn-sm" data-th-boiall="1">Chọn tất cả</button> <button type="button" class="btn btn-ghost btn-sm" data-th-boiall="0">Bỏ chọn tất cả</button></div>`,
      boiRowHtml(it, maHoSo),
      `<div class="th-boi-row"><label class="th-chk"><input type="checkbox" data-sel="ngayThang" ${isSel(it, 'ngayThang') ? 'checked' : ''}> Ngày ký (ngày – tháng – năm)</label>
         <div class="th-date3">${['ngay', 'thang', 'nam'].map(k => controlHtml({ key: k, hint: k }, boiVal(it, k), 'boi')).join('')}</div></div>`,
    ];
    if (blanks.length) {
      parts.push('<div class="hint-label" style="margin-top:8px">Trường lần 1 đang để trống — tích để in bồi:</div>');
      blanks.forEach(f => parts.push(boiRowHtml(it, f)));
    } else {
      parts.push('<p class="hint">Bản lần 1 đã đầy đủ các trường — chỉ cần in bồi Mã hồ sơ và ngày ký. Muốn in bồi thêm mục nào thì xoá mục đó ở form phía trên.</p>');
    }
    $q('#thBoi').innerHTML = parts.join('');
    if (focusId) { const e = document.getElementById(focusId); if (e) e.focus(); }
  }

  /* ---------------------------- 5. XEM TRƯỚC (canvas) ------------------------ */
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

  /* ---------------------------- 6. LƯU NGƯỢC LÊN SHEET ----------------------- */
  // Gọi trước khi Xuất / In / Sao chép. Chỉ ghi khi người dùng THỰC SỰ sửa so với giá trị gốc:
  //   - Địa chỉ khác bản gốc  -> cột «Phường/Xã mới»;
  //   - CCCD khác bản gốc     -> nối thêm vào «Ghi Chú» câu "sửa CCCD từ … sang … khi in thu hồi".
  // (Số CCCD gốc trong cột «Số CCCD/MST» KHÔNG bị đổi — chỉ để lại dấu vết ở Ghi chú.)
  // Giá trị rỗng không bao giờ được ghi (xoá ô để in bồi không làm mất dữ liệu trên Sheet).
  // Trả về mảng tên cột đã lưu (rỗng nếu không có gì đổi).
  const sameVal = (a, b) => String(a || '').replace(/\s+/g, '') === String(b || '').replace(/\s+/g, '');
  function commitToSheet(it) {
    const upd = {}, saved = [];
    const addr = effValue(it, 'diaChi');
    if (addr && !sameVal(addr, it.orig.diaChi)) { upd.phuongXaMoi = addr; saved.push('Phường/Xã mới'); }
    const cccdNew = effValue(it, 'cccd'), cccdOld = it.orig.cccd;
    if (cccdNew && !sameVal(cccdNew, cccdOld)) {
      const line = 'sửa CCCD từ ' + (cccdOld || '(trống)') + ' sang ' + cccdNew + ' khi in thu hồi';
      const oldNote = String(it.row.ghiChu || '').trim();
      upd.ghiChu = oldNote ? (oldNote.includes(line) ? oldNote : oldNote + '; ' + line) : line;
      saved.push('Ghi chú (CCCD)');
    }
    if (!saved.length) return [];
    if (typeof updateSingleRowFields !== 'function') { toast('Không tìm thấy hàm lưu Sheet (updateSingleRowFields).', true); return []; }
    updateSingleRowFields(it.row, upd);          // lưu cục bộ ngay + đẩy lên Sheet ngầm (hàng đợi có tự thử lại)
    if (upd.phuongXaMoi) it.orig.diaChi = addr;
    if (upd.ghiChu) it.orig.cccd = cccdNew;      // lần in sau so với CCCD mới, tránh ghi trùng
    return saved;
  }
  function commitAll(list) {
    const msgs = [];
    list.forEach(it => { const s = commitToSheet(it); if (s.length) msgs.push((list.length > 1 ? (it.d1.bienSo || '?') + ': ' : '') + s.join(', ')); });
    if (msgs.length) {
      toast('Đã lưu lên Sheet — ' + msgs.join(' | '));
      try { if (typeof renderTable === 'function') renderTable(); } catch (e) { /* bảng chính chưa sẵn sàng: bỏ qua */ }
    }
  }

  /* ---------------------------- 7. XUẤT / IN / SAO CHÉP ---------------------- */
  const ALL_ACTION_BTNS = '[data-th-act]';
  async function runAction(act, mode, all) {
    if (act === 'dvc') { return copyForDvc(); }
    const list = all ? items : [items[cur]];
    const btns = Array.from(document.querySelectorAll(ALL_ACTION_BTNS));
    btns.forEach(b => { b.disabled = true; });
    try {
      const c = await ensureCtx();
      if (mode === 'overlay') {
        const none = list.every(it => !Object.values(effectiveBoi(it)).some(v => norm(v)));
        if (none) { toast('Chưa chọn / nhập mục in bồi nào (Mã hồ sơ, ngày tháng năm…).', true); return; }
      }
      const bytes = await TH.createPdf(c.PDFLib, c.fontkit, c.fontBytes, list.map(it => ({ d1: it.d1, d2: effectiveBoi(it), mode })));
      commitAll(list);                                   // lưu địa chỉ / ghi chú CCCD lên Sheet
      if (act === 'print') { printBytes(bytes); return; }
      const base = list.length === 1 ? sanitizeFilename(list[0].d1.bienSo || list[0].d1.chuXe) : list.length + 'xe';
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), (mode === 'overlay' ? 'InBoi_GiayKhaiThuHoi_' : 'GiayKhaiThuHoi_') + base + '.pdf');
      toast('Đã xuất ' + (mode === 'overlay' ? 'file in bồi lần 2' : 'PDF') + ' (' + list.length + ' trang).');
    } catch (e) {
      console.error(e); toast('Lỗi: ' + (e && e.message ? e.message : e), true);
    } finally { btns.forEach(b => { b.disabled = false; }); }
  }

  // IN TRỰC TIẾP: nhúng PDF vào iframe ẩn rồi gọi print() — không cần tải file về.
  // Nếu trình duyệt không cho in từ iframe thì mở PDF ở tab mới để bấm Ctrl+P.
  function printBytes(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;border:0;opacity:.01;pointer-events:none;';
    let done = false;
    const cleanup = () => setTimeout(() => { fr.remove(); URL.revokeObjectURL(url); }, 120000);
    const fallback = () => {
      if (done) return; done = true;
      window.open(url, '_blank');
      toast('Chưa in tự động được — đã mở PDF ở tab mới, bấm Ctrl+P để in.', true);
    };
    const timer = setTimeout(fallback, 6000);
    fr.onload = () => {
      if (done) return; done = true; clearTimeout(timer);
      setTimeout(() => {                                   // chờ trình xem PDF dựng xong rồi mới in
        try { fr.contentWindow.focus(); fr.contentWindow.print(); toast('Đã gửi lệnh in. Nhớ chọn tỉ lệ 100% (Kích thước thực).'); }
        catch (e) { window.open(url, '_blank'); toast('Mở PDF ở tab mới — bấm Ctrl+P để in.', true); }
        cleanup();
      }, 700);
    };
    fr.src = url;
    document.body.appendChild(fr);
  }

  /* ---------------------------- 8. CỔNG DỊCH VỤ CÔNG ------------------------- */
  // Dữ liệu gửi sang bộ điền nhanh (dvc-fill.js). Khoá phải khớp SPEC trong dvc-fill.js.
  function dvcPayload(it) {
    const v = (k) => effValue(it, k);
    const lx = stripDiacritics(v('loaiXe'));
    const mau = /nền màu\s+([^\s,]+)/i.exec(it.d1.mauBien || '');
    return {
      app: 'quanlyxe', ver: 1,
      loaiPT: /(\bo to\b|\boto\b)/.test(lx) ? 'Ô tô' : 'Xe máy',      // cổng chỉ có 2 lựa chọn: Ô tô / Xe máy
      mauBien: mau ? mau[1] : '',                                    // trắng | vàng | xanh | đỏ
      bienSo: v('bienSo'), soMay: v('soMay'), soKhung: v('soKhung'),
      lyDo: v('lyDo'),
      cccd: v('cccd'), chuXe: v('chuXe'), loaiGiayTo: v('loaiGiayTo'),
      ngayCap: v('ngayCap'), noiCap: v('coQuanCap'),
      dienThoai: v('dienThoai'), diaChi: v('diaChi'),
      nhanHieu: v('nhanHieu'), soLoai: v('soLoai'), namSX: v('namSX'), loaiXe: v('loaiXe'),
    };
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* thử cách dự phòng */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove(); return ok;
  }
  async function copyForDvc() {
    const it = items[cur]; if (!it) return;
    const ok = await copyText('QLXE_THUHOI::' + JSON.stringify(dvcPayload(it)));
    if (!ok) { toast('Không sao chép được vào clipboard — hãy cho phép quyền clipboard cho trang.', true); return; }
    commitAll([it]);
    toast('Đã sao chép xe ' + (it.d1.bienSo || '') + '. Sang tab dichvucong → bấm dấu trang «Điền QLXE».');
  }

  // Đóng gói dvc-fill.js thành bookmarklet 1 dòng: bỏ chú thích khối, bỏ thụt đầu dòng, nối dòng bằng dấu cách.
  function toBookmarklet(src) {
    const min = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.trim()).filter(Boolean).join(' ');
    return 'javascript:' + encodeURIComponent(min);
  }
  let bmHref = '';
  async function toggleDvcHelp() {
    const box = $q('#thDvcHelp');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    box.innerHTML = '<b>Điền nhanh sang cổng dichvucong.bocongan.gov.vn</b><div class="hint">Đang tạo dấu trang…</div>';
    box.classList.remove('hidden');
    try {
      if (!bmHref) { const r = await fetch('dvc-fill.js?v=' + BUILD); if (!r.ok) throw new Error('HTTP ' + r.status); bmHref = toBookmarklet(await r.text()); }
    } catch (e) { box.innerHTML = '<b>Không tải được dvc-fill.js</b> (' + escapeHtml(e.message) + '). Kiểm tra file đã được đưa lên cùng thư mục với index.html.'; return; }
    box.innerHTML = `<b>Điền nhanh sang cổng dichvucong.bocongan.gov.vn</b>
      <ol>
        <li><u>Cài 1 lần:</u> kéo nút <a id="thBm" class="th-bm" href="#">⚡ Điền QLXE</a> lên thanh dấu trang (Ctrl+Shift+B để hiện thanh).
            Hoặc <button type="button" class="btn btn-ghost btn-sm" id="thBmCopy">sao chép mã</button> rồi tạo dấu trang mới, dán mã vào ô URL.</li>
        <li>Ở đây bấm <b>📋 Sao chép → Dịch vụ công</b> (xe đang xem).</li>
        <li>Sang tab dichvucong (trang «Thu hồi chứng nhận đăng ký xe…») → bấm dấu trang <b>Điền QLXE</b>. Lần đầu Chrome hỏi quyền đọc clipboard → <b>Cho phép</b>.</li>
        <li>Kiểm tra các ô, tự nhập <b>Mã bảo mật</b>, bấm <b>Tra cứu</b>.</li>
      </ol>
      <div class="hint">Bộ điền tìm ô theo <b>tên nhãn</b> (Biển số, Số khung, Lý do thu hồi, Mã định danh…) nên chịu được thay đổi nhỏ của trang; ô nào không điền được sẽ được liệt kê trong bảng kết quả.</div>`;
    const a = $q('#thBm'); a.href = bmHref;
    a.onclick = (e) => { e.preventDefault(); toast('Hãy KÉO nút này lên thanh dấu trang, đừng bấm ở đây.', true); };
    $q('#thBmCopy').onclick = async () => { const ok = await copyText(bmHref); toast(ok ? 'Đã sao chép mã dấu trang.' : 'Không sao chép được.', !ok); };
  }

  /* ---------------------------- 9. ĐIỀU HƯỚNG + MỞ --------------------------- */
  function go(d) { cur = Math.min(items.length - 1, Math.max(0, cur + d)); renderForm(); draw(); }

  async function open(rows) {
    if (!rows.length) { toast('Chưa có xe nào để lập Giấy khai thu hồi. Hãy tích chọn xe (checkbox) trước.', true); return; }
    ensureModal();
    const t = todayParts();
    items = rows.map(row => {
      const d = defaultsFromRow(row);
      const last = {}; Object.keys(d.d1).forEach(k => { if (norm(d.d1[k])) last[k] = d.d1[k]; });   // nhớ giá trị gốc để in bồi nếu bị xoá
      return {
        row, d1: d.d1, addrNote: d.addrNote,
        boi: { ngay: t.ngay, thang: t.thang, nam: t.nam }, sel: {}, last,
        orig: { cccd: norm(row.cccd), diaChi: norm(d.d1.diaChi) },
      };
    });
    cur = 0; view = 'full'; boiSig = '';
    const multi = items.length > 1;
    $q('#thPrev').style.visibility = $q('#thNext').style.visibility = multi ? 'visible' : 'hidden';
    document.querySelectorAll('#thuHoiModal .th-multi').forEach(b => { b.style.display = multi ? '' : 'none'; });
    $q('#thDvcHelp').classList.add('hidden');
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
