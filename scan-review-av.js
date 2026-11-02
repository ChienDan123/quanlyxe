/* =========================================================================
   scan-review-av.js — patch cho module So sánh phiếu scan. Nạp SAU scan-review.js.
   KHÔNG sửa file gốc. Gồm:
   1) Cột AV «Trạng thái xe chưa kiểm» (sheet Tong hop): Chưa kiểm / Đã kiểm (+ chi tiết),
      ghi đúng dòng xe (theo biển số) mỗi khi đổi trạng thái / kiểm lại / kiểm thủ công.
   2) Nút «🔁 Kiểm lại» (từng phiếu + «Kiểm lại tất cả chưa kiểm»): gửi lại dữ liệu OCR cho
      Gemini (không đọc lại ảnh), chạy NGẦM, lần lượt, LƯU tiến độ (tự chạy tiếp khi mở lại),
      ƯU TIÊN THẤP (đang quét / đồng bộ / đang thao tác thì tạm chờ).
      Đúng → giữ nguyên. Nghi sai + tin cậy ≥ 70% + định dạng hợp lệ → sửa vào mục scan
      (edits) + ghi chú «🔁 Kiểm lại…». Mục đã tick «đã kiểm» thì KHÔNG bị sửa.
   3) Bộ lọc «⚠ Chưa chắc chắn», nút «✔ Đã kiểm thủ công».
   4) Phiếu lạ: «✔ Đã kiểm đúng biển số» (chỉ trường Biển số).
   5) Từng mục trên thẻ có ô «✔ đã kiểm mục này» (không áp toàn xe); thu gọn / mở rộng
      từng thẻ hoặc tất cả.
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
      '.rv-card-actions .recheck-status{font-size:11px;color:#555;margin-left:6px;}';
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

  // Giá trị ghi vào cột AV: bắt đầu bằng «Chưa kiểm» hoặc «Đã kiểm» (dễ lọc trên Sheet)
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

  // Tự ghi AV mỗi khi chỗ khác cập nhật Trạng thái xe / kiểm phiếu
  (function wrapUpdateRow() {
    const orig = window.updateSingleRowFields;
    if (typeof orig !== 'function' || orig._avWrapped) return;
    const wrapped = async function (row, updates) {
      const relevant = ['trangThaiXe', 'kiemPhieu', 'phieuScan', 'ketQuaPhieu', 'nguoiKiemPhieu']
        .some(k => updates && Object.prototype.hasOwnProperty.call(updates, k));
      if (relevant && row && row.bienSo && !Object.prototype.hasOwnProperty.call(updates, AV_KEY)) {
        try {
          const items = await itemsByPlate(S.normalizeBienSo(row.bienSo));
          const it = items.find(x => x.scanData || x.recheck);
          if (it) {
            const v = computeAV(it);
            updates = Object.assign({}, updates, { [AV_KEY]: v, [AV_HEADER]: v });
          }
        } catch (e) { console.warn('[scan-review-av] chuẩn bị AV', e); }
      }
      return orig.call(this, row, updates);
    };
    wrapped._avWrapped = true;
    window.updateSingleRowFields = wrapped;
    console.log('[scan-review-av] đã wrap updateSingleRowFields để tự ghi AV');
  })();

  // Ghi AV ngay cho đúng dòng xe (sau kiểm lại / kiểm thủ công)
  async function pushAV(item) {
    try {
      if (typeof window.updateSingleRowFields !== 'function') return;
      if (typeof state === 'undefined' || !state || !state.rawData) return;
      const plate = item.bienSo || S.normalizeBienSo(item.bienSoRaw || (item.scanData && item.scanData.bienSo) || '');
      if (!plate) return;
      const row = state.rawData.find(r => r.bienSo && S.normalizeBienSo(r.bienSo) === plate);
      if (!row) return;                       // phiếu lạ: chưa có dòng xe
      const v = computeAV(item);
      await window.updateSingleRowFields(row, { [AV_KEY]: v, [AV_HEADER]: v });
    } catch (e) { console.warn('[scan-review-av] pushAV', e); }
  }

  /* =================== 2. HÀNG ĐỢI «KIỂM LẠI» =================== */
  const QUEUE_KEY = 'scanReviewRecheckQueueV1';
  const STAT_KEY = 'scanReviewRecheckStatV1';
  const CONF_MIN = 70;
  const RECHECK = { queue: [], running: false, paused: false, waiting: false, current: null, done: 0, error: 0, total: 0 };

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

  function buildPrompt(item) {
    const d = item.scanData || {};
    return [
      'Bạn là công cụ KIỂM LẠI (re-check) dữ liệu OCR của một phiếu giấy Việt Nam về phương tiện.',
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
      'NHIỆM VỤ: Chỉ dựa trên các quy tắc định dạng phổ biến ở Việt Nam, xác định:',
      '(a) Trường nào KHẲNG ĐỊNH ĐÚNG (không nghi vấn)?',
      '(b) Trường nào có NGHI VẤN (sai định dạng, khó tin, khác thường)? Nếu chắc chắn giá trị đúng hơn thì điền "goiY" là giá trị đề xuất; nếu không chắc thì để trống.',
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

  // Chỉ tự sửa các trường có thể kiểm định dạng; giá trị đề xuất phải hợp lệ mới áp dụng
  const APPLY = {
    bienSo: (v) => { const s = String(v).toUpperCase().replace(/\s+/g, ''); return /^\d{2}[A-Z][A-Z0-9]?-\d{3,5}(\.\d{2})?$/.test(s) ? s : ''; },
    cccd: (v) => { const s = String(v).replace(/\D/g, ''); return (s.length === 11 || s.length === 12) ? s : ''; },
    soDienThoai: (v) => { const s = String(v).replace(/\D/g, ''); return (s.length >= 9 && s.length <= 11) ? s : ''; },
    chuXe: (v) => { const s = String(v).replace(/\s+/g, ' ').trim(); return (s.length >= 2 && s.length <= 80 && !/\d/.test(s)) ? s : ''; },
    loaiXe: (v) => { const s = String(v).replace(/\s+/g, ' ').trim(); return (s.length >= 1 && s.length <= 60) ? s : ''; }
  };

  async function recheckOne(item) {
    const r = await S.geminiGenerate({
      parts: [{ text: buildPrompt(item) }],
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
      if (!key || !APPLY[key]) continue;                              // chỉ trường kiểm được định dạng
      if (confirmed.has(key)) continue;                               // đúng → giữ
      if (fresh.fieldChecked && fresh.fieldChecked[key]) continue;    // đã tick kiểm mục này → không đụng
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
      status: 'done', lastAt: Date.now(), tinCay: conf,
      nghiVan: nghi, xacNhanDung: Array.from(confirmed), changes,
      note: changes.length ? 'Đã sửa ' + changes.length + ' trường, còn ' + nghi.length + ' nghi vấn' : 'Không có thay đổi'
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

  function enqueue(jobs) {
    const have = new Set(RECHECK.queue.map(j => j.itemId));
    let added = 0;
    for (const j of jobs) { if (have.has(j.itemId)) continue; RECHECK.queue.push(j); have.add(j.itemId); added++; }
    if (!added) return 0;
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
        const job = RECHECK.queue[0];            // giữ trong hàng đợi tới khi xong → đóng tab vẫn không mất
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
    const btn = card.querySelector('[data-av-act="plate-check"]');
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
    mk('recheck', '🔁 Kiểm lại', 'Gửi lại dữ liệu đã đọc cho Gemini kiểm lại (chạy ngầm, ưu tiên thấp)');
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
    if (t.closest && t.closest('.rv-av-fc')) { e.stopPropagation(); return; }   // ô kiểm từng mục: không để card xử lý

    const b = t.closest && t.closest('[data-av-act]'); if (!b) return;
    const act = b.dataset.avAct;

    if (act === 'toggle-pause') { RECHECK.paused = !RECHECK.paused; if (!RECHECK.paused) runQueue(); updateProgress(); return; }
    if (act === 'clear-queue') { RECHECK.queue = []; RECHECK.paused = true; saveQueue(); updateProgress(); return; }

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
        '• Dữ liệu OCR đã đọc được gửi lại cho Gemini xác nhận / nghi vấn (KHÔNG đọc lại ảnh).\n' +
        '• Chạy NGẦM, có thanh tiến độ, ưu tiên thấp — tiếp tục dùng web bình thường.')) return;
      b.disabled = true; b.textContent = '⏳ Đang xếp hàng…';
      enqueue([{ itemId: it.id, scanId: it.scanId, startedAt: Date.now() }]);
      return;
    }
    if (act === 'recheck-all') {
      const items = (await DB.dbGetAll(DB.ST_ITEMS)) || [];
      const todo = items.filter(i => {
        const d = i.scanData || {};
        const r = i.recheck || {};
        return (d.bienSo || d.chuXe || d.cccd) && i.review !== 'da_kiem' && r.status !== 'manual' && r.status !== 'done';
      });
      if (!todo.length) { say('Không có phiếu chưa kiểm nào cần kiểm lại.'); return; }
      if (!window.confirm('Kiểm lại ' + todo.length + ' phiếu CHƯA KIỂM bằng Gemini?\n\nChạy ngầm, lần lượt, ưu tiên thấp; có thể tạm dừng / dừng hẳn ở khung tiến độ góc phải.')) return;
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

  // Tick «đã kiểm mục này» — chỉ lưu vào fieldChecked của phiếu, không đụng trạng thái toàn xe
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
    if (!active) { cards.forEach(c => { if (c.style.display === 'none' && c.dataset.avHidden) { c.style.display = ''; delete c.dataset.avHidden; } }); return; }
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
    mk('recheck-all', '🔁 Kiểm lại tất cả chưa kiểm', 'Xếp hàng kiểm lại bằng Gemini cho mọi phiếu chưa kiểm (chạy ngầm, ưu tiên thấp)');
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

  /* =================== 10. KHỞI ĐỘNG LẠI HÀNG ĐỢI + API =================== */
  loadQueue();
  if (RECHECK.queue.length) {
    console.log('[scan-review-av] tự chạy tiếp', RECHECK.queue.length, 'job kiểm lại');
    updateProgress();
    setTimeout(() => runQueue(), 4000);
  }

  window.ScanReviewAV = {
    recheck: async function (itemId) {
      const it = await DB.dbGet(DB.ST_ITEMS, itemId); if (!it) throw new Error('Không tìm thấy mục');
      enqueue([{ itemId, scanId: it.scanId, startedAt: Date.now() }]);
    },
    recheckAllPending: async function () {
      const items = (await DB.dbGetAll(DB.ST_ITEMS)) || [];
      const todo = items.filter(i => {
        const d = i.scanData || {}; const r = i.recheck || {};
        return (d.bienSo || d.chuXe || d.cccd) && i.review !== 'da_kiem' && r.status !== 'manual' && r.status !== 'done';
      });
      return enqueue(todo.map(i => ({ itemId: i.id, scanId: i.scanId, startedAt: Date.now() })));
    },
    pause: () => { RECHECK.paused = true; updateProgress(); },
    resume: () => { RECHECK.paused = false; runQueue(); updateProgress(); },
    progress: () => ({ queue: RECHECK.queue.length, done: RECHECK.done, error: RECHECK.error, total: RECHECK.total, running: RECHECK.running, paused: RECHECK.paused, waiting: RECHECK.waiting }),
    computeAV: computeAV,
    pushAV: pushAV,
    AV_HEADER: AV_HEADER, AV_KEY: AV_KEY
  };

  console.log('[scan-review-av] đã nạp: cột AV + Kiểm lại + tick từng mục + lọc chưa chắc chắn + phiếu lạ');
})();
