/* =========================================================================
   scan-review-av.js — patch cho module So sánh phiếu scan. Nạp SAU scan-review.js.
   KHÔNG sửa file gốc. Gồm:
   1) Cột AV «Trạng thái xe chưa kiểm» (sheet Tong hop): Chưa kiểm / Đã kiểm (+ chi tiết),
      ghi đúng dòng xe (theo biển số). CHỈ gửi TIÊU ĐỀ CỘT lên Sheet (không tạo cột rác).
   2) Nút «🔁 Kiểm lại» (từng phiếu + «Kiểm lại tất cả chưa kiểm»): gửi lại ẢNH PHIẾU + dữ liệu
      OCR cho Gemini, chạy NGẦM, lần lượt, LƯU tiến độ, ƯU TIÊN THẤP.
      Đúng → giữ. Nghi sai + tin cậy ≥ 70% + định dạng hợp lệ → sửa vào mục scan + ghi chú.
      Mục đã tick «đã kiểm» thì KHÔNG bị sửa.
   3) Bộ lọc «⚠ Chưa chắc chắn», nút «✔ Đã kiểm thủ công».
   4) Phiếu lạ: «✔ Đã kiểm đúng biển số» + gợi ý khớp theo TÊN CHỦ.
   5) Ô «✔ đã kiểm mục này» từng mục (không áp toàn xe); thu gọn / mở rộng.
   6) Tự động đồng bộ ngầm cột AV cho dữ liệu cũ + tự xếp hàng kiểm lại phiếu chưa kiểm.
   ========================================================================= */
(function () {
  'use strict';
  if (window.ScanReviewAV) return;

  const S = window.ScanApp;
  const R = window.ScanReview;
  const DB = S && S.db;
  if (!DB || !R) { console.warn('[scan-review-av] thiếu ScanApp / ScanReview — bỏ qua patch'); return; }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const say = (m, err) => { try { (window.toast || console.log)(m, !!err); } catch (e) { console.log(m); } };
  const esc = (s) => (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

  /* =================== 0. CSS =================== */
  (function injectCss() {
    if (document.getElementById('rvAvCss')) return;
    const st = document.createElement('style');
    st.id = 'rvAvCss';
    st.textContent =
      '.rv-av-fc{display:none;font-size:11px;margin-top:3px;color:#444;cursor:pointer;user-select:none;}' +
      '.rv-card.rv-av-open .rv-av-fc{display:block;}' +
      '.rv-av-fc input{margin-right:4px;vertical-align:middle;}' +
      '.rv-av-fc.on{color:#0a7a2f;font-weight:600;}' +
      '.rv-card-actions .recheck-status{font-size:11px;color:#555;margin-left:6px;}' +
      '.rv-av-owner-matches button{margin:2px 4px 2px 0;}';
    document.head.appendChild(st);
  })();

  /* =================== 1. CỘT AV =================== */
  const AV_KEY = 'trangThaiXeChuaKiem';
  const AV_HEADER = 'Trạng thái xe chưa kiểm';

  (function ensureAvField() {
    try {
      if (typeof FIELD_MAP === 'undefined' || !Array.isArray(FIELD_MAP)) return;
      if (FIELD_MAP.some(f => f.key === AV_KEY)) return;
      FIELD_MAP.push({ key: AV_KEY, header: AV_HEADER });
      console.log('[scan-review-av] đã đăng ký cột AV: ' + AV_HEADER);
    } catch (e) { console.warn('[scan-review-av] FIELD_MAP', e); }
  })();

  function computeAV(item) {
    if (!item) return '';
    const d = item.scanData || {};
    const hasScan = !!(d.bienSo || d.chuXe || d.cccd || item.bienSoRaw);
    if (!hasScan) return 'Chưa có dữ liệu phiếu';
    const r = item.recheck || {};
    const checked = item.review === 'da_kiem' || r.status === 'manual';
    const base = checked ? 'Đã kiểm' : 'Chưa kiểm';
    if (r.status === 'manual') return base + ' (thủ công)';
    if (r.status === 'error') return base + ' — lỗi kiểm lại';
    if (r.status === 'done') {
      const n = (r.nghiVan || []).length;
      return n ? base + ' — chưa chắc chắn (' + n + ' nghi vấn)' : base + ' — Gemini xác nhận đúng';
    }
    return base;
  }

  async function itemsByPlate(plate) {
    return (await DB.tx(DB.ST_ITEMS, 'readonly', os => os.index('bienSo').getAll(plate)).catch(() => [])) || [];
  }

  // Tự ghi AV mỗi khi chỗ khác cập nhật Trạng thái xe / kiểm phiếu (CHỈ khóa = tiêu đề cột)
  (function wrapUpdateRow() {
    const orig = window.updateSingleRowFields;
    if (typeof orig !== 'function' || orig._avWrapped) return;
    const wrapped = async function (row, updates) {
      const relevant = ['trangThaiXe', 'kiemPhieu', 'phieuScan', 'ketQuaPhieu', 'nguoiKiemPhieu']
        .some(k => updates && Object.prototype.hasOwnProperty.call(updates, k));
      if (relevant && row && row.bienSo && !Object.prototype.hasOwnProperty.call(updates, AV_HEADER)) {
        try {
          const items = await itemsByPlate(S.normalizeBienSo(row.bienSo));
          const it = items.find(x => x.scanData || x.recheck);
          if (it) {
            const v = computeAV(it);
            row[AV_KEY] = v;
            updates = Object.assign({}, updates, { [AV_HEADER]: v });
          }
        } catch (e) { console.warn('[scan-review-av] chuẩn bị AV', e); }
      }
      return orig.call(this, row, updates);
    };
    wrapped._avWrapped = true;
    window.updateSingleRowFields = wrapped;
    console.log('[scan-review-av] đã wrap updateSingleRowFields để tự ghi AV');
  })();

  // Ghi AV ngay cho đúng dòng xe
  async function pushAV(item) {
    try {
      if (typeof window.updateSingleRowFields !== 'function') return;
      if (typeof state === 'undefined' || !state || !state.rawData) return;
      const plate = item.bienSo || S.normalizeBienSo(item.bienSoRaw || (item.scanData && item.scanData.bienSo) || '');
      if (!plate) return;
      const row = state.rawData.find(r => r.bienSo && S.normalizeBienSo(r.bienSo) === plate);
      if (!row) return;                       // phiếu lạ: chưa có dòng xe
      const v = computeAV(item);
      row[AV_KEY] = v;
      await window.updateSingleRowFields(row, { [AV_HEADER]: v });
    } catch (e) { console.warn('[scan-review-av] pushAV', e); }
  }

  /* =================== 2. HÀNG ĐỢI «KIỂM LẠI» =================== */
  const QUEUE_KEY = 'scanReviewRecheckQueueV1';
  const STAT_KEY = 'scanReviewRecheckStatV1';
  const STOP_KEY = 'scanReviewRecheckStoppedV1';   // người dùng bấm «Dừng hẳn» → không tự xếp hàng lại
  const CONF_MIN = 70;
  const RECHECK = { queue: [], running: false, paused: false, waiting: false, current: null, done: 0, error: 0, total: 0 };
  const isStopped = () => { try { return localStorage.getItem(STOP_KEY) === '1'; } catch (e) { return false; } };
  const setStopped = (v) => { try { if (v) localStorage.setItem(STOP_KEY, '1'); else localStorage.removeItem(STOP_KEY); } catch (e) { /* bỏ qua */ } };

  function loadQueue() {
    try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); RECHECK.queue = Array.isArray(q) ? q : []; } catch (e) { RECHECK.queue = []; }
    try {
      const s = JSON.parse(localStorage.getItem(STAT_KEY) || 'null');
      if (s) { RECHECK.done = s.done || 0; RECHECK.error = s.error || 0; RECHECK.total = s.total || 0; }
    } catch (e) { /* bỏ qua */ }
    if (RECHECK.total < RECHECK.queue.length + RECHECK.done + RECHECK.error) RECHECK.total = RECHECK.queue.length + RECHECK.done + RECHECK.error;
  }
  function saveQueue() {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(RECHECK.queue));
      localStorage.setItem(STAT_KEY, JSON.stringify({ done: RECHECK.done, error: RECHECK.error, total: RECHECK.total }));
    } catch (e) { /* bỏ qua */ }
  }

  // Ưu tiên thấp: nhường khi người dùng thao tác / đang quét / đang đồng bộ
  let lastAct = 0;
  ['keydown', 'pointerdown', 'wheel'].forEach(ev => document.addEventListener(ev, (e) => {
    if (e.target && e.target.closest && e.target.closest('#rv-av-progress')) return;
    lastAct = Date.now();
  }, true));
  function shouldYield() {
    if (RECHECK.paused) return true;
    if (Date.now() - lastAct < 2500) return true;
    try { const chip = document.getElementById('scanBgChip'); if (chip && !chip.classList.contains('hidden')) return true; } catch (e) { /* bỏ qua */ }
    try {
      if (window.SyncQueueAPI && typeof SyncQueueAPI.list === 'function') {
        if (SyncQueueAPI.list().some(j => !j.blocked && j.current)) return true;
      }
    } catch (e) { /* bỏ qua */ }
    return false;
  }

  const RECHECK_SCHEMA = {
    type: 'OBJECT',
    properties: {
      tinCay: { type: 'INTEGER' },
      nghiVan: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { truong: { type: 'STRING' }, lyDo: { type: 'STRING' }, goiY: { type: 'STRING' } },
          required: ['truong', 'lyDo']
        }
      },
      xacNhanDung: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['tinCay', 'nghiVan', 'xacNhanDung']
  };

  function buildPrompt(item, noImage) {
    const d = item.scanData || {};
    const imageNote = noImage
      ? '⚠ KHÔNG CÓ ẢNH đính kèm (phiếu đã bị xóa hoặc chưa tải được). Chỉ kiểm tra ĐỊNH DẠNG dữ liệu dưới đây.'
      : '📷 ẢNH PHIẾU GỐC ĐÍNH KÈM Ở DƯỚI (MẶT 1, có thể có MẶT 2). Hãy ĐỌC LẠI ảnh, so với dữ liệu OCR lần đầu, tìm các trường SAI / KHÔNG ĐỌC ĐƯỢC.';
    return [
      'Bạn là công cụ KIỂM LẠI (re-check) dữ liệu OCR của một phiếu giấy Việt Nam về phương tiện.',
      '',
      imageNote,
      '',
      'DỮ LIỆU LẦN ĐỌC ĐẦU (có thể có lỗi do OCR):',
      '- Biển số: ' + (item.bienSoRaw || d.bienSo || ''),
      '- Chủ xe / Tên trong ĐKX: ' + (d.chuXe || ''),
      '- CCCD: ' + (d.cccd || ''),
      '- Số điện thoại: ' + (d.soDienThoai || ''),
      '- Tình trạng (mã): ' + (d.tinhTrangCode || '') + ' (nhãn: ' + (d.tinhTrangLabel || '') + ')',
      '- Ghi chú: ' + (d.ghiChu || ''),
      '- Loại xe: ' + (d.loaiXe || ''),
      '- Trạng thái cam kết: ' + (d.tinhTrangCamKet || ''),
      '',
      noImage
        ? 'NHIỆM VỤ: Chỉ dựa trên các QUY TẮC ĐỊNH DẠNG phổ biến ở Việt Nam, xác định:'
        : 'NHIỆM VỤ: ĐỐI CHIẾU ẢNH với dữ liệu trên, xác định:',
      '(a) Trường nào KHẲNG ĐỊNH ĐÚNG (không nghi vấn)?',
      '(b) Trường nào có NGHI VẤN (sai định dạng, khó tin, khác thường, hoặc ảnh đọc được khác)? Nếu CHẮC CHẮN giá trị đúng hơn (nhìn rõ trên ảnh, hoặc sai định dạng rõ) thì điền "goiY" là giá trị đề xuất; nếu không chắc thì để trống.',
      '',
      'Quy tắc tham khảo:',
      '- Biển số VN: 2 số + 1-2 chữ cái (có thể thêm 1 số) + dấu gạch + 4-5 chữ số. VD 92A-12345, 92N2-0582.',
      '- CCCD VN: 12 chữ số (hoặc 11 nếu bị mất số 0 đầu do Excel).',
      '- Số điện thoại: 10-11 chữ số, có thể bắt đầu 0.',
      '- Tên người: viết hoa chữ đầu các từ, có dấu tiếng Việt.',
      '- Ghi chú / cam kết: không nghi vấn trừ khi có ký tự rõ ràng là rác.',
      '',
      'TRẢ VỀ DUY NHẤT JSON đúng schema:',
      '{"tinCay":0..100,"nghiVan":[{"truong":"bienSo|chuXe|cccd|soDienThoai|tinhTrang|ghiChu|loaiXe","lyDo":"…","goiY":"…"}],"xacNhanDung":["chuXe","cccd"]}',
      'CHỈ TRẢ VỀ JSON, KHÔNG GIẢI THÍCH.'
    ].join('\n');
  }

  const APPLY = {
    bienSo: (v) => { const s = String(v).toUpperCase().replace(/\s+/g, ''); return /^\d{2}[A-Z][A-Z0-9]?-\d{3,5}(\.\d{2})?$/.test(s) ? s : ''; },
    cccd: (v) => { const s = String(v).replace(/\D/g, ''); return (s.length === 11 || s.length === 12) ? s : ''; },
    soDienThoai: (v) => { const s = String(v).replace(/\D/g, ''); return (s.length >= 9 && s.length <= 11) ? s : ''; },
    chuXe: (v) => { const s = String(v).replace(/\s+/g, ' ').trim(); return (s.length >= 2 && s.length <= 80 && !/\d/.test(s)) ? s : ''; },
    loaiXe: (v) => { const s = String(v).replace(/\s+/g, ' ').trim(); return (s.length >= 1 && s.length <= 60) ? s : ''; }
  };

  const RECHECK_MAX_B64 = 18 * 1024 * 1024;

  async function recheckOne(item) {
    // (1) Lấy ảnh gốc (ưu tiên trên máy; thiếu thì tải từ online)
    let rec = null;
    try { if (DB.ST_SCANS) rec = await DB.dbGet(DB.ST_SCANS, item.scanId); } catch (e) { rec = null; }
    if (rec && !rec.frontBlob && rec.cloud && window.ScanSync && typeof ScanSync.ensureBlobs === 'function') {
      try { rec = await ScanSync.ensureBlobs(rec); } catch (e) { console.warn('[scan-review-av] tải ảnh online lỗi', item.id, e); }
    }

    // (2) parts: prompt trước, ảnh sau
    const imageParts = [];
    let totalB64 = 0;
    const addImg = async (blob, mime, label) => {
      if (!blob) return;
      try {
        const b64 = await blobToBase64(blob);
        if (b64 && totalB64 + b64.length <= RECHECK_MAX_B64) {
          imageParts.push({ text: label });
          imageParts.push({ inlineData: { mimeType: mime || blob.type || 'image/jpeg', data: b64 } });
          totalB64 += b64.length;
        } else { console.warn('[scan-review-av] ảnh quá lớn / rỗng, bỏ qua', item.id, label); }
      } catch (e) { console.warn('[scan-review-av] đọc ảnh lỗi', item.id, label, e); }
    };
    if (rec) {
      await addImg(rec.frontBlob, rec.frontMime, 'MẶT 1:');
      await addImg(rec.backBlob, rec.backMime, 'MẶT 2 (nếu có):');
    }
    const hasImage = imageParts.length > 0;
    if (!hasImage) console.info('[scan-review-av] không có ảnh — kiểm lại chỉ dựa trên dữ liệu OCR', item.id);
    const parts = [{ text: buildPrompt(item, !hasImage) }].concat(imageParts);

    const r = await S.geminiGenerate({
      parts,
      schema: RECHECK_SCHEMA,
      onStatus: (msg) => {
        try {
          const el = document.querySelector('.rv-card[data-id="' + CSS.escape(item.id) + '"] .recheck-status');
          if (el) el.textContent = '🔁 ' + msg;
        } catch (e) { /* bỏ qua */ }
      }
    });
    const txt = String((r && r.text) || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(txt);

    // đọc lại bản mới nhất (người dùng có thể đã sửa trong lúc chờ Gemini)
    const fresh = (await DB.dbGet(DB.ST_ITEMS, item.id)) || item;
    fresh.edits = fresh.edits || {};
    fresh.scanData = fresh.scanData || {};

    const conf = Math.max(0, Math.min(100, Number(parsed.tinCay) || 0));
    const nghi = Array.isArray(parsed.nghiVan) ? parsed.nghiVan : [];
    const confirmed = new Set(Array.isArray(parsed.xacNhanDung) ? parsed.xacNhanDung : []);
    const changes = [];

    for (const nv of nghi) {
      const key = nv && nv.truong;
      if (!key || !APPLY[key]) continue;
      if (confirmed.has(key)) continue;                               // đúng → giữ
      if (fresh.fieldChecked && fresh.fieldChecked[key]) continue;    // đã tick kiểm mục → không đụng
      if (fresh.review === 'da_kiem') continue;                       // đã kiểm → không đụng
      const cand = APPLY[key](String(nv.goiY || ''));
      if (!cand) continue;
      const prev = String((fresh.edits[key] !== undefined ? fresh.edits[key] : fresh.scanData[key]) || '').trim();
      if (conf >= CONF_MIN && cand !== prev) {
        changes.push({ key, from: prev, to: cand, reason: nv.lyDo || '', confidence: conf });
        fresh.edits[key] = cand;
      }
    }
    if (changes.length) {
      const d = new Date();
      const date = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      const note = '🔁 Kiểm lại ' + date + ': ' + changes.map(c => c.key + ': ' + (c.from || '(trống)') + ' → ' + c.to + ' (' + c.reason + ')').join('; ');
      const cur = fresh.edits.ghiChu !== undefined ? fresh.edits.ghiChu : (fresh.scanData.ghiChu || '');
      fresh.edits.ghiChu = (cur ? cur + ' | ' : '') + note;
      fresh.dirty = true;
      fresh.review = 'chua_kiem';
    }
    fresh.recheck = {
      status: 'done', lastAt: Date.now(), tinCay: conf, hasImage,
      nghiVan: nghi, xacNhanDung: Array.from(confirmed), changes,
      note: (changes.length ? 'Đã sửa ' + changes.length + ' trường, còn ' + nghi.length + ' nghi vấn' : 'Không có thay đổi')
        + (hasImage ? '' : ' (không có ảnh — chỉ kiểm định dạng)')
    };
    fresh.updatedAt = Date.now();
    await DB.dbPut(DB.ST_ITEMS, fresh);
    if (changes.length) { try { S.emit('itemsChanged', { scanId: fresh.scanId }); } catch (e) { /* bỏ qua */ } }
    await pushAV(fresh);
  }

  async function markError(itemId, err) {
    try {
      const it = await DB.dbGet(DB.ST_ITEMS, itemId); if (!it) return;
      it.recheck = Object.assign(it.recheck || {}, { status: 'error', lastAt: Date.now(), note: 'Lỗi: ' + ((err && err.message) || err) });
      await DB.dbPut(DB.ST_ITEMS, it);
      await pushAV(it);
    } catch (e) { /* bỏ qua */ }
  }

  function enqueue(jobs, auto) {
    const have = new Set(RECHECK.queue.map(j => j.itemId));
    let added = 0;
    for (const j of jobs) { if (have.has(j.itemId)) continue; RECHECK.queue.push(j); have.add(j.itemId); added++; }
    if (!added) return 0;
    if (!auto) setStopped(false);                 // người dùng chủ động xếp hàng → bỏ cờ «dừng hẳn»
    if (!RECHECK.running && RECHECK.queue.length === added) { RECHECK.done = 0; RECHECK.error = 0; RECHECK.total = added; }
    else RECHECK.total += added;
    RECHECK.paused = false;
    saveQueue(); updateProgress(); runQueue();
    return added;
  }

  async function runQueue() {
    if (RECHECK.running || RECHECK.paused || !RECHECK.queue.length) return;
    RECHECK.running = true;
    updateProgress();
    try {
      while (RECHECK.queue.length && !RECHECK.paused) {
        if (shouldYield()) { RECHECK.waiting = true; updateProgress(); await sleep(2000); continue; }
        RECHECK.waiting = false;
        const job = RECHECK.queue[0];            // giữ trong hàng đợi tới khi xong
        let item = null;
        try { item = await DB.dbGet(DB.ST_ITEMS, job.itemId); } catch (e) { /* bỏ qua */ }
        if (item) {
          RECHECK.current = item;
          try { await recheckOne(item); RECHECK.done++; }
          catch (err) { RECHECK.error++; await markError(job.itemId, err); }
          RECHECK.current = null;
        } else { RECHECK.done++; }
        if (RECHECK.queue[0] === job) RECHECK.queue.shift();
        saveQueue(); updateProgress();
        await sleep(500);
      }
    } finally {
      RECHECK.running = false; RECHECK.waiting = false;
      saveQueue(); updateProgress();
      if (!RECHECK.queue.length && RECHECK.total) say('🔁 Kiểm lại xong: ' + RECHECK.done + ' phiếu' + (RECHECK.error ? ', ' + RECHECK.error + ' lỗi' : '') + '.', !!RECHECK.error);
      try {
        const modal = document.getElementById('scanReviewModal');
        if (modal && !modal.classList.contains('hidden')) refreshCardsFromItems((await DB.dbGetAll(DB.ST_ITEMS)) || []);
      } catch (e) { /* bỏ qua */ }
    }
  }

  function updateProgress() {
    let el = document.getElementById('rv-av-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rv-av-progress';
      el.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99999;background:#fff;padding:8px 12px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:12px;display:none;';
      document.body.appendChild(el);
    }
    if (!RECHECK.running && !RECHECK.queue.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const total = RECHECK.total || (RECHECK.queue.length + RECHECK.done + RECHECK.error);
    const fin = RECHECK.done + RECHECK.error;
    const pct = total ? Math.round(fin / total * 100) : 0;
    el.innerHTML = '<b>🔁 Kiểm lại:</b> ' + fin + '/' + total + ' (' + pct + '%)' +
      (RECHECK.error ? ' · <span style="color:#b00">' + RECHECK.error + ' lỗi</span>' : '') +
      (RECHECK.paused ? ' · <i>tạm dừng</i>' : (RECHECK.waiting ? ' · <i>chờ (đang dùng mục khác)</i>' : '')) +
      ' <button type="button" class="btn btn-ghost btn-sm" data-av-act="toggle-pause" style="margin-left:6px;">' + (RECHECK.paused ? '▶ Tiếp tục' : '⏸ Tạm dừng') + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-av-act="clear-queue">⏹ Dừng hẳn</button>';
  }

  /* =================== 3. TRẠNG THÁI THẺ / NÚT =================== */
  function refreshCardsFromItems(items) {
    const list = document.getElementById('rvList'); if (!list) return;
    const byId = new Map((items || []).map(i => [i.id, i]));
    const queued = new Set(RECHECK.queue.map(j => j.itemId));
    list.querySelectorAll('.rv-card').forEach(card => {
      const it = byId.get(card.dataset.id); if (!it) return;
      const st = card.querySelector('.recheck-status');
      if (st) { st.textContent = computeAV(it); st.title = (it.recheck && it.recheck.note) || ''; }
      const rb = card.querySelector('[data-av-act="recheck"]');
      if (rb) {
        const inQ = queued.has(it.id);
        rb.disabled = inQ; rb.textContent = inQ ? '⏳ Đang xếp hàng…' : '🔁 Kiểm lại';
      }
    });
  }

  /* =================== 4. MỞ RỘNG / THU GỌN CHỌN KIỂM TỪNG MỤC =================== */
  const EXPAND_KEY = 'scanReviewAVExpandV1';
  let globalOpen = true;
  try { const v = localStorage.getItem(EXPAND_KEY); if (v !== null) globalOpen = v === '1'; } catch (e) { /* bỏ qua */ }
  const cardOverride = new Map();

  function applyExpand(card) {
    const id = card.dataset.id;
    const open = cardOverride.has(id) ? cardOverride.get(id) : globalOpen;
    card.classList.toggle('rv-av-open', open);
    const b = card.querySelector('[data-av-act="toggle-fc"]');
    if (b) b.textContent = open ? '▾ Thu gọn chọn kiểm' : '▸ Chọn kiểm từng mục';
  }

  const LABEL_KEYS = [
    [/biển\s*số/i, 'bienSo'],
    [/cccd|cmnd|căn cước|mst/i, 'cccd'],
    [/sđt|điện thoại|số đt/i, 'soDienThoai'],
    [/chủ|họ tên|tên/i, 'chuXe'],
    [/ghi chú/i, 'ghiChu'],
    [/loại xe/i, 'loaiXe'],
    [/địa chỉ/i, 'diaChi'],
    [/tình trạng|trạng thái/i, 'tinhTrang']
  ];
  function fieldKey(label) {
    const t = String(label || '').trim();
    for (const [re, k] of LABEL_KEYS) if (re.test(t)) return k;
    return 'f_' + t.toLowerCase().replace(/[^a-z0-9à-ỹ]+/gi, '_').slice(0, 30);
  }

  function injectFieldChecks(card) {
    const id = card.dataset.id; if (!id) return;
    const seen = new Set();
    let added = false;
    card.querySelectorAll('.rv-field').forEach(f => {
      const b = f.querySelector('b'); if (!b) return;
      const key = fieldKey(b.textContent);
      if (seen.has(key)) return;
      seen.add(key);
      if (f.querySelector('.rv-av-fc')) return;
      const lab = document.createElement('label');
      lab.className = 'rv-av-fc'; lab.dataset.key = key; lab.dataset.id = id;
      lab.title = 'Chỉ đánh dấu riêng mục này — không áp dụng cho toàn xe';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.dataset.avFc = key;
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode('✔ đã kiểm mục này'));
      f.appendChild(lab);
      added = true;
    });
    applyExpand(card);
    if (added) syncFieldChecks(card);
  }

  async function syncFieldChecks(card) {
    try {
      const it = await DB.dbGet(DB.ST_ITEMS, card.dataset.id); if (!it) return;
      const fc = it.fieldChecked || {};
      card.querySelectorAll('.rv-av-fc').forEach(lab => {
        const on = !!fc[lab.dataset.key];
        const cb = lab.querySelector('input'); if (cb) cb.checked = on;
        lab.classList.toggle('on', on);
      });
      syncPlateBtn(card, !!fc.bienSo);
    } catch (e) { /* bỏ qua */ }
  }

  function syncPlateBtn(card, on) {
    const btn = card && card.querySelector && card.querySelector('[data-av-act="plate-check"]');
    if (!btn) return;
    btn.textContent = on ? '✅ Đã kiểm biển số (bấm để bỏ)' : '✔ Đã kiểm đúng biển số';
  }

  /* =================== 5. NÚT TRÊN THẺ =================== */
  function injectActions(cardEl) {
    const id = cardEl.dataset.id; if (!id) return;
    const head = cardEl.querySelector('.rv-card-head'); if (!head) return;
    let actions = head.querySelector('.rv-card-actions');
    if (!actions) { actions = document.createElement('span'); actions.className = 'rv-card-actions'; head.appendChild(actions); }
    if (actions.querySelector('[data-av-act="recheck"]')) return;

    const mk = (act, text, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-ghost btn-sm';
      b.dataset.avAct = act; b.dataset.id = id; b.title = title; b.textContent = text;
      actions.appendChild(b); return b;
    };
    mk('recheck', '🔁 Kiểm lại', 'Gửi lại ẢNH PHIẾU + dữ liệu OCR cho Gemini rà soát lại (chạy ngầm, ưu tiên thấp)');
    mk('manual-check', '✔ Đã kiểm thủ công', 'Đánh dấu đã kiểm thủ công (không dùng Gemini) — cột AV ghi «Đã kiểm (thủ công)»');
    mk('toggle-fc', '▾ Thu gọn chọn kiểm', 'Thu gọn / mở rộng ô «đã kiểm mục này» của thẻ này');
    const st = document.createElement('span');
    st.className = 'recheck-status';
    actions.appendChild(st);
    (async () => {
      try {
        const it = await DB.dbGet(DB.ST_ITEMS, id);
        if (it) { st.textContent = computeAV(it); st.title = (it.recheck && it.recheck.note) || ''; }
      } catch (e) { /* bỏ qua */ }
    })();
    applyExpand(cardEl);
  }

  /* =================== 6. PHIẾU LẠ: ĐÃ KIỂM ĐÚNG BIỂN SỐ =================== */
  function injectOrphanPlateCheck(cardEl) {
    if (!cardEl.classList.contains('rv-orphan')) return;
    let plateField = null;
    for (const f of cardEl.querySelectorAll('.rv-row .rv-field')) {
      const b = f.querySelector('b');
      if (b && /biển số/i.test(b.textContent)) { plateField = f; break; }
    }
    if (!plateField || plateField.querySelector('[data-av-act="plate-check"]')) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn-ghost btn-sm';
    btn.style.marginTop = '4px';
    btn.dataset.avAct = 'plate-check'; btn.dataset.id = cardEl.dataset.id;
    btn.title = 'Chỉ đánh dấu đã kiểm đúng trường BIỂN SỐ của phiếu lạ này — không áp dụng cho toàn xe.';
    btn.textContent = '✔ Đã kiểm đúng biển số';
    plateField.appendChild(btn);
    (async () => {
      try {
        const it = await DB.dbGet(DB.ST_ITEMS, cardEl.dataset.id);
        if (it && it.fieldChecked && it.fieldChecked.bienSo) syncPlateBtn(cardEl, true);
      } catch (e) { /* bỏ qua */ }
    })();
  }

  /* =================== 7. XỬ LÝ CLICK / CHANGE =================== */
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest && t.closest('.rv-av-fc')) { e.stopPropagation(); return; }

    const b = t.closest && t.closest('[data-av-act]'); if (!b) return;
    const act = b.dataset.avAct;

    if (act === 'toggle-pause') { RECHECK.paused = !RECHECK.paused; if (!RECHECK.paused) runQueue(); updateProgress(); return; }
    if (act === 'clear-queue') { RECHECK.queue = []; RECHECK.paused = true; setStopped(true); saveQueue(); updateProgress(); return; }

    e.preventDefault(); e.stopPropagation();

    if (act === 'toggle-fc') {
      const card = b.closest('.rv-card'); if (!card) return;
      const id = card.dataset.id;
      const cur = cardOverride.has(id) ? cardOverride.get(id) : globalOpen;
      cardOverride.set(id, !cur); applyExpand(card);
      return;
    }
    if (act === 'toggle-fc-all') {
      globalOpen = !globalOpen; cardOverride.clear();
      try { localStorage.setItem(EXPAND_KEY, globalOpen ? '1' : '0'); } catch (err) { /* bỏ qua */ }
      document.querySelectorAll('#rvList .rv-card').forEach(applyExpand);
      b.textContent = globalOpen ? '▾ Thu gọn chọn kiểm (tất cả)' : '▸ Mở rộng chọn kiểm (tất cả)';
      return;
    }
    if (act === 'recheck') {
      const it = await DB.dbGet(DB.ST_ITEMS, b.dataset.id); if (!it) return;
      if (!window.confirm('Kiểm lại mục «' + (it.bienSoRaw || it.bienSo || '(chưa có biển)') + '» bằng Gemini?\n\n' +
        '• GỬI LẠI ẢNH PHIẾU (mặt 1 + mặt 2) + dữ liệu OCR cho Gemini rà soát lại (máy khác chưa có ảnh thì tự tải từ Drive trước).\n' +
        '• Chạy NGẦM, có thanh tiến độ, ưu tiên thấp — tiếp tục dùng web bình thường.')) return;
      b.disabled = true; b.textContent = '⏳ Đang xếp hàng…';
      enqueue([{ itemId: it.id, scanId: it.scanId, startedAt: Date.now() }]);
      return;
    }
    if (act === 'recheck-all') {
      const items = (await DB.dbGetAll(DB.ST_ITEMS)) || [];
      const todo = items.filter(isPendingRecheck);
      if (!todo.length) { say('Không có phiếu chưa kiểm nào cần kiểm lại.'); return; }
      if (!window.confirm('Kiểm lại ' + todo.length + ' phiếu CHƯA KIỂM bằng Gemini?\n\nGỬI LẠI ẢNH PHIẾU (mặt 1 + mặt 2) + dữ liệu OCR cho Gemini rà soát; chạy ngầm, lần lượt, ưu tiên thấp; có thể tạm dừng / dừng hẳn ở khung tiến độ góc phải.')) return;
      const n = enqueue(todo.map(i => ({ itemId: i.id, scanId: i.scanId, startedAt: Date.now() })));
      say('Đã xếp hàng ' + n + ' phiếu kiểm lại.');
      refreshCardsFromItems(items);
      return;
    }
    if (act === 'manual-check') {
      const it = await DB.dbGet(DB.ST_ITEMS, b.dataset.id); if (!it) return;
      it.recheck = Object.assign(it.recheck || {}, { status: 'manual', lastAt: Date.now(), note: 'Đã kiểm thủ công bởi người dùng' });
      it.updatedAt = Date.now();
      await DB.dbPut(DB.ST_ITEMS, it);
      b.textContent = '✅ Đã đánh dấu'; b.disabled = true;
      const st = b.parentElement.querySelector('.recheck-status');
      if (st) st.textContent = computeAV(it);
      await pushAV(it);
      say('Đã đánh dấu kiểm thủ công — cột AV: ' + computeAV(it));
      return;
    }
    if (act === 'plate-check') {
      const it = await DB.dbGet(DB.ST_ITEMS, b.dataset.id); if (!it) return;
      it.fieldChecked = it.fieldChecked || {};
      if (it.fieldChecked.bienSo) delete it.fieldChecked.bienSo; else it.fieldChecked.bienSo = true;
      it.updatedAt = Date.now();
      await DB.dbPut(DB.ST_ITEMS, it);
      const card = b.closest('.rv-card');
      if (card) syncFieldChecks(card); else syncPlateBtn(b.parentElement, !!it.fieldChecked.bienSo);
      say(it.fieldChecked.bienSo ? 'Đã kiểm đúng BIỂN SỐ (chỉ riêng trường này, không áp toàn xe).' : 'Đã bỏ đánh dấu kiểm biển số.');
      return;
    }
  }, true);

  document.addEventListener('change', async (e) => {
    const cb = e.target && e.target.closest && e.target.closest('input[data-av-fc]');
    if (!cb) return;
    e.stopPropagation();
    const lab = cb.closest('.rv-av-fc'); if (!lab) return;
    const key = cb.dataset.avFc;
    try {
      const it = await DB.dbGet(DB.ST_ITEMS, lab.dataset.id); if (!it) return;
      it.fieldChecked = it.fieldChecked || {};
      if (cb.checked) it.fieldChecked[key] = true; else delete it.fieldChecked[key];
      it.updatedAt = Date.now();
      await DB.dbPut(DB.ST_ITEMS, it);
      lab.classList.toggle('on', cb.checked);
      const card = cb.closest('.rv-card');
      if (card && key === 'bienSo') syncPlateBtn(card, cb.checked);
    } catch (err) { console.warn('[scan-review-av] fieldChecked', err); cb.checked = !cb.checked; }
  }, true);

  // Phiếu cần kiểm lại: có dữ liệu, chưa kiểm, chưa kiểm lại xong / chưa đánh dấu thủ công
  function isPendingRecheck(i) {
    const d = i.scanData || {};
    const r = i.recheck || {};
    return !!(d.bienSo || d.chuXe || d.cccd) && i.review !== 'da_kiem' && r.status !== 'manual' && r.status !== 'done';
  }

  /* =================== 8. BỘ LỌC «CHƯA CHẮC CHẮN» =================== */
  function addUncertainFilterOption() {
    const sel = document.getElementById('rvFilter');
    if (!sel || sel.querySelector('option[value="av_uncertain"]')) return;
    const opt = document.createElement('option');
    opt.value = 'av_uncertain';
    opt.textContent = '⚠ Chưa chắc chắn (chưa kiểm lại / có nghi vấn)';
    sel.appendChild(opt);
  }
  let filterBusy = false;
  async function applyUncertainFilter() {
    const sel = document.getElementById('rvFilter');
    const list = document.getElementById('rvList');
    if (!sel || !list || filterBusy) return;
    const active = sel.value === 'av_uncertain';
    const cards = list.querySelectorAll('.rv-card');
    if (!active) { cards.forEach(c => { if (c.dataset.avHidden) { c.style.display = ''; delete c.dataset.avHidden; } }); return; }
    filterBusy = true;
    try {
      const items = (await DB.dbGetAll(DB.ST_ITEMS)) || [];
      const byId = new Map(items.map(i => [i.id, i]));
      cards.forEach(card => {
        const it = byId.get(card.dataset.id);
        if (!it) { card.style.display = ''; return; }
        const r = it.recheck || {};
        const uncertain = r.status !== 'manual' && ((r.status !== 'done') || (r.nghiVan || []).length > 0);
        if (uncertain) { card.style.display = ''; delete card.dataset.avHidden; }
        else { card.style.display = 'none'; card.dataset.avHidden = '1'; }
      });
    } catch (e) { /* bỏ qua */ }
    filterBusy = false;
  }
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'rvFilter') setTimeout(applyUncertainFilter, 150);
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#btnScanOpenReview');
    if (b) setTimeout(() => { addUncertainFilterOption(); applyUncertainFilter(); }, 800);
  }, true);

  /* =================== 9. THANH CÔNG CỤ + OBSERVER =================== */
  function ensureToolbar() {
    const tb = document.querySelector('#scanReviewModal .rv-toolbar'); if (!tb) return;
    if (tb.querySelector('[data-av-act="recheck-all"]')) return;
    const pager = tb.querySelector('#rvPager');
    const mk = (act, text, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-secondary btn-sm';
      b.dataset.avAct = act; b.textContent = text; b.title = title;
      tb.insertBefore(b, pager || null); return b;
    };
    mk('recheck-all', '🔁 Kiểm lại tất cả chưa kiểm', 'Gửi lại ẢNH PHIẾU + dữ liệu OCR cho Gemini rà soát cho mọi phiếu chưa kiểm (chạy ngầm, ưu tiên thấp)');
    mk('toggle-fc-all', globalOpen ? '▾ Thu gọn chọn kiểm (tất cả)' : '▸ Mở rộng chọn kiểm (tất cả)', 'Thu gọn / mở rộng ô «đã kiểm mục này» trên mọi thẻ');
  }

  (function setupObserver() {
    const list = document.getElementById('rvList');
    if (!list) { setTimeout(setupObserver, 500); return; }
    let raf = 0;
    const scan = () => {
      raf = 0;
      ensureToolbar();
      addUncertainFilterOption();
      list.querySelectorAll('.rv-card').forEach(card => {
        injectActions(card);
        injectFieldChecks(card);
        injectOrphanPlateCheck(card);
        injectOrphanOwnerMatches(card);
      });
      const sel = document.getElementById('rvFilter');
      if (sel && sel.value === 'av_uncertain') applyUncertainFilter();
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(scan); };
    scan();
    new MutationObserver(schedule).observe(list, { childList: true, subtree: true });
    const sel = document.getElementById('rvFilter');
    if (sel) new MutationObserver(addUncertainFilterOption).observe(sel, { childList: true });
    const tb = document.querySelector('#scanReviewModal .rv-toolbar');
    if (tb) new MutationObserver(schedule).observe(tb, { childList: true });
  })();

  /* =================== 10. KHỞI ĐỘNG LẠI HÀNG ĐỢI =================== */
  loadQueue();
  if (RECHECK.queue.length) {
    console.log('[scan-review-av] tự chạy tiếp', RECHECK.queue.length, 'job kiểm lại');
    updateProgress();
    setTimeout(() => runQueue(), 4000);
  }

  /* =================== 11. ĐỒNG BỘ NGẦM CỘT AV CHO DỮ LIỆU CŨ =================== */
  const AV_DONE_KEY = 'vehicleAvBackfillV1';
  function avMatchKeyForRow(row) {
    if (typeof matchKeyForRow === 'function') { try { return matchKeyForRow(row); } catch (e) { /* bỏ qua */ } }
    const order = [['maId', 'Mã ID'], ['motoId', 'MOTO_ID'], ['bienSo', 'Biển số']];
    for (const [k, h] of order) if (row && row[k] && String(row[k]).trim()) return { header: h, value: row[k] };
    return null;
  }
  async function backfillAV(opts) {
    const force = !!(opts && opts.force);
    if (typeof enqueueRowSync !== 'function') return 0;
    if (typeof state === 'undefined' || !state || !state.rawData || !state.rawData.length) return 0;
    if (typeof isWriteConnected === 'function' && !isWriteConnected()) return 0;
    let done = {};
    try { done = JSON.parse(localStorage.getItem(AV_DONE_KEY) || '{}') || {}; } catch (e) { done = {}; }
    let items = [];
    try { items = (await DB.dbGetAll(DB.ST_ITEMS)) || []; } catch (e) { return 0; }
    const seen = new Set();
    let n = 0;
    for (const it of items) {
      const plate = it.bienSo || S.normalizeBienSo(it.bienSoRaw || (it.scanData && it.scanData.bienSo) || '');
      if (!plate) continue;
      const row = state.rawData.find(r => r.bienSo && S.normalizeBienSo(r.bienSo) === plate);
      if (!row || seen.has(row._rowId)) continue;
      seen.add(row._rowId);
      const want = computeAV(it);
      if (!want || /^Chưa có dữ liệu/.test(want)) continue;
      const mk = avMatchKeyForRow(row);
      if (!mk) continue;
      const sig = mk.header + '=' + mk.value;
      const cur = String(row[AV_KEY] || row[AV_HEADER] || '').trim();
      if (!force && done[sig] === want && cur === want) continue;
      row[AV_KEY] = want;                                           // cập nhật hiển thị local
      try { enqueueRowSync(row, { [AV_HEADER]: want }); }           // CHỈ gửi tiêu đề cột → 1 cột AV duy nhất
      catch (e) { console.warn('[scan-review-av] enqueue AV', e); continue; }
      done[sig] = want;
      n++;
    }
    try { localStorage.setItem(AV_DONE_KEY, JSON.stringify(done)); } catch (e) { /* bỏ qua */ }
    if (n) console.info('[scan-review-av] đã đưa ' + n + ' giá trị AV vào hàng đợi đồng bộ');
    return n;
  }
  let _avBusy = false;
  async function autoBackfillAV() {
    if (_avBusy) return;
    if (typeof state === 'undefined' || !state || !state.rawData || !state.rawData.length) return;
    if (typeof isWriteConnected === 'function' && !isWriteConnected()) return;
    if (shouldYield()) return;
    _avBusy = true;
    try { await backfillAV(); }
    catch (e) { console.warn('[scan-review-av] backfill AV', e); }
    finally { _avBusy = false; }
  }

  /* =================== 12. TỰ ĐỘNG KIỂM LẠI PHIẾU CHƯA KIỂM =================== */
  let _autoRecheckBusy = false;
  async function autoRecheckPending() {
    if (_autoRecheckBusy) return;
    if (isStopped()) return;                                       // người dùng đã «Dừng hẳn»
    if (RECHECK.running || RECHECK.paused || RECHECK.queue.length) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (shouldYield()) return;
    let items = [];
    try { items = (await DB.dbGetAll(DB.ST_ITEMS)) || []; } catch (e) { return; }
    const todo = items.filter(isPendingRecheck);
    if (!todo.length) return;
    _autoRecheckBusy = true;
    try {
      const n = enqueue(todo.map(i => ({ itemId: i.id, scanId: i.scanId, startedAt: Date.now() })), true);
      if (n) console.info('[scan-review-av] tự xếp hàng kiểm lại ' + n + ' phiếu chưa kiểm');
    } finally { _autoRecheckBusy = false; }
  }

  /* =================== 13. GỢI Ý KHỚP PHIẾU LẠ THEO TÊN CHỦ XE =================== */
  const _flatName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  function _lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function nearPlatesOf(p) {
    const out = new Set();
    const key = S.normalizeBienSo(p || '');
    if (!key || key.length < 4 || typeof state === 'undefined' || !state || !state.rawData) return out;
    for (const r of state.rawData) {
      if (!r.bienSo) continue;
      const k = S.normalizeBienSo(r.bienSo);
      if (!k || k === key || k.length < 4) continue;
      if (k.includes(key) || key.includes(k)) { out.add(k); continue; }
      if (Math.abs(k.length - key.length) <= 1 && _lev(k, key) <= (key.length >= 7 ? 2 : 1)) out.add(k);
    }
    return out;
  }
  function findOwnerNameMatches(it) {
    if (!it || !it.scanData) return [];
    if (typeof state === 'undefined' || !state || !state.rawData || !state.rawData.length) return [];
    const target = _flatName(it.scanData.chuXe || '');
    if (!target) return [];
    const plateOfIt = it.bienSo || S.normalizeBienSo(it.bienSoRaw || '');
    return state.rawData.filter(r => {
      if (!r.bienSo) return false;
      if (S.normalizeBienSo(r.bienSo) === plateOfIt) return false;
      return _flatName(r.chuXe) === target;
    }).slice(0, 8);
  }

  // Cache kết quả theo thẻ (60s) để observer không truy vấn DB lặp lại mỗi lần DOM đổi
  const ownerCache = new Map();      // id -> { t, html }
  const ownerPending = new Set();
  function renderOwnerBox(curCard, html) {
    if (!html || curCard.querySelector('.rv-av-owner-matches')) return;
    const box = document.createElement('div');
    box.className = 'rv-av-owner-matches';
    box.style.cssText = 'margin:6px 0;padding:6px 10px;background:#fff8e1;border:1px solid #ffcc80;border-radius:4px;font-size:13px;line-height:1.5;';
    box.innerHTML = html;
    const head = curCard.querySelector('.rv-card-head');
    if (head && head.nextSibling) curCard.insertBefore(box, head.nextSibling);
    else curCard.insertBefore(box, curCard.firstChild);
  }
  function injectOrphanOwnerMatches(cardEl) {
    if (!cardEl || !cardEl.classList.contains('rv-orphan')) return;
    if (cardEl.querySelector('.rv-av-owner-matches')) return;
    const id = cardEl.dataset.id; if (!id) return;
    const c = ownerCache.get(id);
    if (c && Date.now() - c.t < 60000) { renderOwnerBox(cardEl, c.html); return; }
    if (ownerPending.has(id)) return;
    ownerPending.add(id);
    (async () => {
      try {
        const it = await DB.dbGet(DB.ST_ITEMS, id);
        let html = '';
        if (it) {
          const matches = findOwnerNameMatches(it);
          if (matches.length) {
            const near = nearPlatesOf(it.bienSo || '');
            html = '<b>👥 Phiếu lạ nhưng TRÙNG tên chủ phương tiện với xe đã có — bấm để gán:</b> ' +
              matches.map(r => {
                const high = near.has(S.normalizeBienSo(r.bienSo));
                return '<button type="button" class="btn btn-secondary btn-sm" data-act="pick-plate" data-id="' + esc(id) +
                  '" data-plate="' + esc(r.bienSo) + '" title="Gán phiếu này vào dòng đã có — biển ' + esc(r.bienSo) +
                  (r.chuXe ? ' · ' + esc(r.chuXe) : '') + (high ? ' (biển cũng gần giống → rất có thể là cùng xe)' : '') + '">' +
                  (high ? '🎯 ' : '') + esc(r.bienSo) + (r.cccd ? ' · CCCD ' + esc(r.cccd) : '') + '</button>';
              }).join(' ');
          }
        }
        ownerCache.set(id, { t: Date.now(), html });
        const curCard = document.querySelector('.rv-card[data-id="' + CSS.escape(id) + '"]');
        if (curCard) renderOwnerBox(curCard, html);
      } catch (e) { console.warn('[scan-review-av] owner match', e); }
      finally { ownerPending.delete(id); }
    })();
  }

  /* =================== 14. TỰ ĐỘNG CHẠY NGẦM =================== */
  setTimeout(() => { try { autoBackfillAV(); } catch (e) { /* bỏ qua */ } }, 8000);
  setInterval(() => { try { autoBackfillAV(); } catch (e) { /* bỏ qua */ } }, 5 * 60 * 1000);
  try { if (typeof S.on === 'function') S.on('queueFinished', () => setTimeout(() => { try { autoBackfillAV(); } catch (e) { /* bỏ qua */ } }, 3000)); } catch (e) { /* bỏ qua */ }
  try { if (typeof S.on === 'function') S.on('itemsChanged', () => setTimeout(() => { try { autoBackfillAV(); } catch (e) { /* bỏ qua */ } }, 2500)); } catch (e) { /* bỏ qua */ }

  setTimeout(() => { try { autoRecheckPending(); } catch (e) { /* bỏ qua */ } }, 60000);
  setInterval(() => {
    if (RECHECK.running || RECHECK.paused || RECHECK.queue.length) return;
    try { autoRecheckPending(); } catch (e) { /* bỏ qua */ }
  }, 30 * 60 * 1000);

  /* =================== 15. API CÔNG KHAI =================== */
  window.ScanReviewAV = {
    recheck: async function (itemId) {
      const it = await DB.dbGet(DB.ST_ITEMS, itemId); if (!it) throw new Error('Không tìm thấy mục');
      enqueue([{ itemId, scanId: it.scanId, startedAt: Date.now() }]);
    },
    recheckAllPending: async function () {
      const items = (await DB.dbGetAll(DB.ST_ITEMS)) || [];
      return enqueue(items.filter(isPendingRecheck).map(i => ({ itemId: i.id, scanId: i.scanId, startedAt: Date.now() })));
    },
    pause: () => { RECHECK.paused = true; updateProgress(); },
    resume: () => { RECHECK.paused = false; runQueue(); updateProgress(); },
    progress: () => ({ queue: RECHECK.queue.length, done: RECHECK.done, error: RECHECK.error, total: RECHECK.total, running: RECHECK.running, paused: RECHECK.paused, waiting: RECHECK.waiting }),
    computeAV: computeAV,
    pushAV: pushAV,
    backfillAV: backfillAV,
    AV_HEADER: AV_HEADER, AV_KEY: AV_KEY
  };

  console.log('[scan-review-av] đã nạp: cột AV + Kiểm lại (gửi ảnh, tự động) + tick từng mục + lọc chưa chắc chắn + phiếu lạ + gợi ý trùng tên chủ xe');
})();
