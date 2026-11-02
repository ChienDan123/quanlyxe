/* =========================================================================
   scan-review-av.js — BỔ SUNG (patch) cho module So sánh phiếu scan.
   Nạp SAU scan-review.js. KHÔNG sửa file gốc. Bổ sung 3 tính năng:

   1. CỘT AV «Trạng thái xe chưa kiểm» — tự đăng ký vào FIELD_MAP và tự tính
      giá trị mỗi khi updateSingleRowFields() ghi Trạng thái xe.

   2. NÚT «🔁 Kiểm lại» — gửi lại dữ liệu OCR đã trích xuất cho Gemini (không
      đọc lại ảnh), chạy NGẦM, lưu tiến độ ở localStorage, ƯU TIÊN THẤP.
      Trường khẳng định đúng → giữ nguyên; trường nghi vấn & tin cậy ≥ 70%
      → sửa vào edits + thêm ghi chú. Bộ lọc «⚠ Chưa chắc chắn».
      Nút «✔ Đã kiểm thủ công».

   3. PHIẾU LẠ — nút «✔ Đã kiểm đúng biển số» (chỉ đánh dấu riêng Biển số).
   ========================================================================= */
(function () {
  'use strict';
  if (window.ScanReviewAV) return;

  const S  = window.ScanApp;
  const R  = window.ScanReview;
  const DB = S && S.db;
  if (!DB || !R) { console.warn('[scan-review-av] thiếu ScanApp / ScanReview — bỏ qua patch'); return; }

  /* =================== 1. CỘT AV «TRẠNG THÁI XE CHƯA KIỂM» =================== */
  const AV_KEY = 'trangThaiXeChuaKiem';
  const AV_HEADER = 'Trạng thái xe chưa kiểm';

  (function ensureAvField() {
    try {
      if (typeof FIELD_MAP === 'undefined' || !Array.isArray(FIELD_MAP)) return;
      if (FIELD_MAP.some(f => f.key === AV_KEY)) return;
      const tpl = FIELD_MAP.find(f => f.key === 'ketQuaPhieu') || FIELD_MAP.find(f => f.key === 'kiemPhieu');
      if (!tpl) return;
      FIELD_MAP.push({ key: AV_KEY, header: AV_HEADER });
      console.log('[scan-review-av] đã đăng ký cột AV: ' + AV_HEADER);
    } catch (e) { console.warn('[scan-review-av] FIELD_MAP', e); }
  })();

  function computeAV(item) {
    if (!item) return '';
    const r = item.recheck || {};
    const hasScanData = !!(item.scanData && (item.scanData.bienSo || item.scanData.chuXe || item.scanData.cccd));
    if (!r.status || r.status === 'pending') {
      if (!hasScanData) return '⚠ Chưa có dữ liệu phiếu';
      return '⚠ Chưa kiểm lại (có dữ liệu phiếu)';
    }
    if (r.status === 'error')   return '❌ Lỗi kiểm lại';
    if (r.status === 'manual')  return '✔ Đã kiểm thủ công';
    if (r.status === 'done') {
      const nv = (r.nghiVan || []).length;
      if (nv > 0) return `⚠ Có ${nv} nghi vấn — cần xem`;
      return '✅ Đã kiểm lại — không nghi vấn';
    }
    return '';
  }

  (function wrapUpdateRow() {
    const orig = window.updateSingleRowFields;
    if (typeof orig !== 'function' || orig._avWrapped) return;
    window.updateSingleRowFields = async function (row, updates) {
      const relevant = ['trangThaiXe', 'kiemPhieu', 'phieuScan', 'ketQuaPhieu', 'nguoiKiemPhieu']
        .some(k => Object.prototype.hasOwnProperty.call(updates, k));
      if (relevant && row && row.bienSo) {
        try {
          const plate = S.normalizeBienSo(row.bienSo);
          const items = (await DB.tx(DB.ST_ITEMS, 'readonly',
            os => os.index('bienSo').getAll(plate)).catch(() => [])) || [];
          const it = items.find(x => x.scanData || x.recheck);
          if (it && !Object.prototype.hasOwnProperty.call(updates, AV_HEADER)) {
            updates = Object.assign({}, updates, { [AV_HEADER]: computeAV(it) });
          }
        } catch (e) { console.warn('[scan-review-av] chuẩn bị AV', e); }
      }
      return orig.call(this, row, updates);
    };
    window.updateSingleRowFields._avWrapped = true;
    console.log('[scan-review-av] đã wrap updateSingleRowFields để tự ghi AV');
  })();

  /* =================== 2. HÀNG ĐỢI «KIỂM LẠI» BẰNG GEMINI =================== */
  const QUEUE_KEY = 'scanReviewRecheckQueueV1';
  const RECHECK = { queue: [], running: false, paused: false, current: null, done: 0, error: 0, total: 0 };
  const loadQueue = () => {
    try { RECHECK.queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') || []; }
    catch (e) { RECHECK.queue = []; }
  };
  const saveQueue = () => {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(RECHECK.queue)); } catch (e) { /* bỏ qua */ }
  };

  function shouldYield() {
    if (RECHECK.paused) return true;
    try {
      const chip = document.getElementById('scanBgChip');
      if (chip && !chip.classList.contains('hidden')) return true;
    } catch (e) { /* bỏ qua */ }
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
    return `Bạn là công cụ KIỂM LẠI (re-check) dữ liệu OCR của một phiếu giấy Việt Nam về phương tiện.

DỮ LIỆU LẦN ĐỌC ĐẦU (có thể có lỗi do OCR):
- Biển số: ${item.bienSoRaw || d.bienSo || ''}
- Chủ xe / Tên trong ĐKX: ${d.chuXe || ''}
- CCCD: ${d.cccd || ''}
- Số điện thoại: ${d.soDienThoai || ''}
- Tình trạng (mã): ${d.tinhTrangCode || ''} (nhãn: ${d.tinhTrangLabel || ''})
- Ghi chú: ${d.ghiChu || ''}
- Loại xe: ${d.loaiXe || ''}
- Trạng thái cam kết: ${d.tinhTrangCamKet || ''}

NHIỆM VỤ: Chỉ dựa trên các quy tắc định dạng phổ biến ở Việt Nam, hãy xác định:
(a) Trường nào KHẲNG ĐỊNH ĐÚNG (không nghi vấn)?
(b) Trường nào có NGHI VẤN (sai định dạng, khó tin, khác thường)?

Quy tắc tham khảo:
- Biển số VN: 2 số + 1-2 chữ cái + dấu gạch + 4-5 chữ số. VD 92A-12345, 92N2-0582.
- CCCD VN: 12 chữ số (hoặc 11 nếu bị mất số 0 đầu do Excel).
- Số điện thoại: 10-11 chữ số, có thể bắt đầu 0.
- Tên người: viết hoa chữ đầu các từ, có dấu tiếng Việt.
- Ghi chú / cam kết: không nghi vấn trừ khi có ký tự rõ ràng là rác.

TRẢ VỀ DUY NHẤT JSON đúng schema:
{
  "tinCay": 0..100,
  "nghiVan": [ {"truong":"bienSo|chuXe|cccd|soDienThoai|tinhTrang|ghiChu|loaiXe","lyDo":"…","goiY":"…"} ],
  "xacNhanDung": [ "chuXe", "cccd", ... ]
}

CHỈ TRẢ VỀ JSON, KHÔNG GIẢI THÍCH.`;
  }

  async function recheckOne(item) {
    const r = await S.geminiGenerate({
      parts: [{ text: buildPrompt(item) }],
      schema: RECHECK_SCHEMA,
      onStatus: (msg) => {
        try {
          const el = document.querySelector(`.rv-card[data-id="${CSS.escape(item.id)}"] .recheck-status`);
          if (el) el.textContent = '🔁 ' + msg;
        } catch (e) { /* bỏ qua */ }
      }
    });
    const txt = String(r.text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(txt);

    const conf = Number(parsed.tinCay) || 0;
    const changes = [];
    item.edits = item.edits || {};
    item.scanData = item.scanData || {};
    for (const nv of (parsed.nghiVan || [])) {
      const key = nv.truong;
      const newVal = String(nv.goiY || '').trim();
      if (!key || !newVal) continue;
      const prevVal = String((item.edits[key] !== undefined ? item.edits[key] : item.scanData[key]) || '').trim();
      if (conf >= 70 && newVal !== prevVal) {
        changes.push({ key, from: prevVal, to: newVal, reason: nv.lyDo || '', confidence: conf });
        item.edits[key] = newVal;
      }
    }
    if (changes.length) {
      const d = new Date(), date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      const note = `🔁 Kiểm lại ${date}: ` +
        changes.map(c => `${c.key}: ${c.from || '(trống)'} → ${c.to} (${c.reason})`).join('; ');
      const cur = item.edits.ghiChu !== undefined ? item.edits.ghiChu : (item.scanData.ghiChu || '');
      item.edits.ghiChu = (cur ? cur + ' | ' : '') + note;
      item.dirty = true;
      item.review = 'chua_kiem';
    }
    item.recheck = {
      status: 'done', lastAt: Date.now(),
      tinCay: conf,
      nghiVan: parsed.nghiVan || [],
      xacNhanDung: parsed.xacNhanDung || [],
      changes,
      note: changes.length ? `Đã sửa ${changes.length} trường, còn ${(parsed.nghiVan || []).length} nghi vấn` : 'Không có thay đổi',
    };
    item.updatedAt = Date.now();
    await DB.dbPut(DB.ST_ITEMS, item);
    if (changes.length) {
      try { S.emit('itemsChanged', { scanId: item.scanId }); } catch (e) { /* bỏ qua */ }
    }
  }

  async function runQueue() {
    if (RECHECK.running || !RECHECK.queue.length) return;
    RECHECK.running = true;
    RECHECK.total = RECHECK.queue.length;
    RECHECK.done = 0; RECHECK.error = 0;
    updateProgress();
    try {
      while (RECHECK.queue.length && !RECHECK.paused) {
        if (shouldYield()) { await new Promise(r => setTimeout(r, 2000)); continue; }
        const job = RECHECK.queue.shift();
        saveQueue();
        let item = null;
        try { item = await DB.dbGet(DB.ST_ITEMS, job.itemId); } catch (e) { /* bỏ qua */ }
        if (!item) { RECHECK.done++; updateProgress(); continue; }
        RECHECK.current = item;
        try { await recheckOne(item); RECHECK.done++; }
        catch (err) {
          RECHECK.error++;
          item.recheck = Object.assign(item.recheck || {}, { status: 'error', lastAt: Date.now(), note: 'Lỗi: ' + (err.message || err) });
          try { await DB.dbPut(DB.ST_ITEMS, item); } catch (e) { /* bỏ qua */ }
        }
        RECHECK.current = null;
        updateProgress();
        await new Promise(r => setTimeout(r, 500));
      }
    } finally {
      RECHECK.running = false;
      updateProgress();
      try {
        const modal = document.getElementById('scanReviewModal');
        if (modal && !modal.classList.contains('hidden')) {
          const items = (await DB.dbGetAll(DB.ST_ITEMS)) || [];
          refreshCardsFromItems(items);
        }
      } catch (e) { /* bỏ qua */ }
    }
  }

  function refreshCardsFromItems(items) {
    const list = document.getElementById('rvList'); if (!list) return;
    const byId = new Map((items || []).map(i => [i.id, i]));
    list.querySelectorAll('.rv-card').forEach(card => {
      const it = byId.get(card.dataset.id); if (!it) return;
      const st = card.querySelector('.recheck-status');
      if (st) { st.textContent = computeAV(it); st.title = (it.recheck && it.recheck.note) || ''; }
    });
  }

  function updateProgress() {
    let el = document.getElementById('rv-av-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rv-av-progress';
      el.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:99999;background:#fff;' +
        'padding:8px 12px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:12px;display:none;';
      document.body.appendChild(el);
    }
    if (!RECHECK.running && !RECHECK.queue.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const total = RECHECK.total || (RECHECK.queue.length + RECHECK.done + RECHECK.error);
    const pct = total ? Math.round((RECHECK.done + RECHECK.error) / total * 100) : 0;
    el.innerHTML = `<b>🔁 Kiểm lại:</b> ${RECHECK.done + RECHECK.error}/${total} (${pct}%)` +
      (RECHECK.error ? ` · <span style="color:#b00">${RECHECK.error} lỗi</span>` : '') +
      (RECHECK.paused ? ' · <i>tạm dừng</i>' : '') +
      ` <button type="button" class="btn btn-ghost btn-sm" data-av-act="toggle-pause" style="margin-left:6px;">${RECHECK.paused ? '▶ Tiếp tục' : '⏸ Tạm dừng'}</button>` +
      ` <button type="button" class="btn btn-ghost btn-sm" data-av-act="clear-queue">⏹ Dừng hẳn</button>`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-av-act]'); if (!b) return;
    if (b.dataset.avAct === 'toggle-pause') { RECHECK.paused = !RECHECK.paused; if (!RECHECK.paused) runQueue(); updateProgress(); }
    if (b.dataset.avAct === 'clear-queue') { RECHECK.queue = []; RECHECK.paused = true; saveQueue(); updateProgress(); }
  }, true);

  loadQueue();
  if (RECHECK.queue.length) {
    console.log('[scan-review-av] tự chạy tiếp', RECHECK.queue.length, 'job kiểm lại');
    setTimeout(() => runQueue(), 4000);
  }

  /* =================== 3. UI: NÚT KIỂM LẠI / ĐÃ KIỂM THỦ CÔNG =================== */
  function injectActions(cardEl) {
    const id = cardEl.dataset.id; if (!id) return;
    const head = cardEl.querySelector('.rv-card-head'); if (!head) return;
    let actions = head.querySelector('.rv-card-actions');
    if (!actions) { actions = document.createElement('span'); actions.className = 'rv-card-actions'; head.appendChild(actions); }
    if (actions.querySelector('[data-av-act="recheck"]')) return;

    const reBtn = document.createElement('button');
    reBtn.type = 'button';
    reBtn.className = 'btn btn-ghost btn-sm';
    reBtn.dataset.avAct = 'recheck'; reBtn.dataset.id = id;
    reBtn.title = 'Gửi lại dữ liệu đã đọc cho Gemini kiểm lại (chạy ngầm, ưu tiên thấp)';
    reBtn.textContent = '🔁 Kiểm lại';
    actions.appendChild(reBtn);

    const mBtn = document.createElement('button');
    mBtn.type = 'button';
    mBtn.className = 'btn btn-ghost btn-sm';
    mBtn.dataset.avAct = 'manual-check'; mBtn.dataset.id = id;
    mBtn.title = 'Đánh dấu đã kiểm thủ công (không dùng Gemini) — cột AV sẽ ghi «Đã kiểm thủ công»';
    mBtn.textContent = '✔ Đã kiểm thủ công';
    actions.appendChild(mBtn);

    const st = document.createElement('span');
    st.className = 'recheck-status';
    st.style.cssText = 'font-size:11px;color:#555;margin-left:6px;';
    actions.appendChild(st);
    (async () => {
      try {
        const it = await DB.dbGet(DB.ST_ITEMS, id);
        if (it) { st.textContent = computeAV(it); st.title = (it.recheck && it.recheck.note) || ''; }
      } catch (e) { /* bỏ qua */ }
    })();
  }

  /* =================== 4. TICK RIÊNG «ĐÃ KIỂM ĐÚNG BIỂN SỐ» (PHIẾU LẠ) =================== */
  function injectOrphanPlateCheck(cardEl) {
    if (!cardEl.classList.contains('rv-orphan')) return;
    const fields = cardEl.querySelectorAll('.rv-row .rv-field');
    let plateField = null;
    for (const f of fields) {
      const b = f.querySelector('b');
      if (b && /biển số/i.test(b.textContent)) { plateField = f; break; }
    }
    if (!plateField || plateField.querySelector('[data-av-act="plate-check"]')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.style.marginTop = '4px';
    btn.dataset.avAct = 'plate-check';
    btn.dataset.id = cardEl.dataset.id;
    btn.title = 'Chỉ đánh dấu đã kiểm đúng trường BIỂN SỐ của phiếu lạ này — không áp dụng cho toàn xe.';
    btn.textContent = '✔ Đã kiểm đúng biển số';
    plateField.appendChild(btn);

    (async () => {
      try {
        const it = await DB.dbGet(DB.ST_ITEMS, cardEl.dataset.id);
        if (it && it.fieldChecked && it.fieldChecked['bienSo']) {
          btn.textContent = '✅ Đã kiểm biển số';
          btn.disabled = true;
        }
      } catch (e) { /* bỏ qua */ }
    })();
  }

  /* =================== 5. XỬ LÝ CLICK NÚT =================== */
  document.addEventListener('click', async (e) => {
    const recheckBtn = e.target.closest('[data-av-act="recheck"]');
    const manualBtn  = e.target.closest('[data-av-act="manual-check"]');
    const plateBtn   = e.target.closest('[data-av-act="plate-check"]');

    if (recheckBtn) {
      e.preventDefault(); e.stopPropagation();
      const id = recheckBtn.dataset.id;
      const it = await DB.dbGet(DB.ST_ITEMS, id); if (!it) return;
      if (!window.confirm(`Kiểm lại mục «${it.bienSoRaw || it.bienSo || '(chưa có biển)'}» bằng Gemini?\n\n` +
        `• Dữ liệu OCR đã đọc sẽ được gửi lại cho Gemini xác nhận / nghi vấn (KHÔNG đọc lại ảnh).\n` +
        `• Chạy NGẦM, có thanh tiến độ — tiếp tục dùng web bình thường được.`)) return;
      RECHECK.queue.push({ itemId: id, scanId: it.scanId, startedAt: Date.now() });
      saveQueue();
      recheckBtn.disabled = true; recheckBtn.textContent = '⏳ Đang xếp hàng…';
      updateProgress(); runQueue();
      return;
    }
    if (manualBtn) {
      e.preventDefault(); e.stopPropagation();
      const id = manualBtn.dataset.id;
      const it = await DB.dbGet(DB.ST_ITEMS, id); if (!it) return;
      it.recheck = Object.assign(it.recheck || {}, { status: 'manual', lastAt: Date.now(), note: 'Đã kiểm thủ công bởi người dùng' });
      it.updatedAt = Date.now();
      await DB.dbPut(DB.ST_ITEMS, it);
      manualBtn.textContent = '✅ Đã đánh dấu'; manualBtn.disabled = true;
      const st = manualBtn.parentElement.querySelector('.recheck-status');
      if (st) st.textContent = computeAV(it);
      window.alert('Đã đánh dấu kiểm thủ công. Cột AV sẽ ghi «✔ Đã kiểm thủ công» khi áp dụng hoặc khi cập nhật lại trạng thái xe.');
      return;
    }
    if (plateBtn) {
      e.preventDefault(); e.stopPropagation();
      const id = plateBtn.dataset.id;
      const it = await DB.dbGet(DB.ST_ITEMS, id); if (!it) return;
      it.fieldChecked = it.fieldChecked || {};
      it.fieldChecked['bienSo'] = true;
      it.updatedAt = Date.now();
      await DB.dbPut(DB.ST_ITEMS, it);
      plateBtn.textContent = '✅ Đã kiểm biển số'; plateBtn.disabled = true;
      window.alert('Đã đánh dấu «đã kiểm đúng biển số» — CHỈ áp dụng cho trường Biển số của phiếu lạ này (không đánh dấu toàn xe).');
      return;
    }
  }, true);

  /* =================== 6. BỘ LỌC MỚI «CHƯA CHẮC CHẮN» =================== */
  function addUncertainFilterOption() {
    const sel = document.getElementById('rvFilter');
    if (!sel || sel.querySelector('option[value="av_uncertain"]')) return;
    const opt = document.createElement('option');
    opt.value = 'av_uncertain';
    opt.textContent = '⚠ Chưa chắc chắn (kiểm lại có nghi vấn / chưa kiểm)';
    sel.appendChild(opt);
  }
  async function applyUncertainFilter() {
    const sel = document.getElementById('rvFilter');
    const list = document.getElementById('rvList');
    if (!sel || !list) return;
    const active = sel.value === 'av_uncertain';
    const cards = list.querySelectorAll('.rv-card');
    for (const card of cards) {
      if (!active) { card.style.display = ''; continue; }
      let it = null;
      try { it = await DB.dbGet(DB.ST_ITEMS, card.dataset.id); } catch (e) { /* bỏ qua */ }
      if (!it) { card.style.display = ''; continue; }
      const r = it.recheck || {};
      const uncertain = (r.status !== 'done' && r.status !== 'manual') || ((r.nghiVan || []).length > 0);
      card.style.display = uncertain ? '' : 'none';
    }
  }
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'rvFilter') {
      setTimeout(applyUncertainFilter, 150);
    }
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('#btnScanOpenReview');
    if (b) setTimeout(() => {
      const sel = document.getElementById('rvFilter');
      if (sel && sel.value === 'av_uncertain') applyUncertainFilter();
    }, 800);
  }, true);

  /* =================== 7. OBSERVER CHÈN NÚT VÀO CARD =================== */
  (function setupObserver() {
    const list = document.getElementById('rvList');
    if (!list) { setTimeout(setupObserver, 500); return; }
    const scan = () => {
      list.querySelectorAll('.rv-card').forEach(card => {
        injectActions(card);
        injectOrphanPlateCheck(card);
      });
    };
    scan();
    new MutationObserver(scan).observe(list, { childList: true, subtree: true });
    const sel = document.getElementById('rvFilter');
    if (sel) new MutationObserver(addUncertainFilterOption).observe(sel, { childList: true });
    addUncertainFilterOption();
  })();

  /* =================== 8. API CÔNG KHAI =================== */
  window.ScanReviewAV = {
    recheck: async function (itemId) {
      const it = await DB.dbGet(DB.ST_ITEMS, itemId); if (!it) throw new Error('Không tìm thấy mục');
      RECHECK.queue.push({ itemId, scanId: it.scanId, startedAt: Date.now() });
      saveQueue(); runQueue();
    },
    recheckAllPending: async function () {
      const items = (await DB.dbGetAll(DB.ST_ITEMS)) || [];
      const todo = items.filter(i => !i.recheck || i.recheck.status === 'pending');
      for (const it of todo) RECHECK.queue.push({ itemId: it.id, scanId: it.scanId, startedAt: Date.now() });
      saveQueue(); runQueue();
      return todo.length;
    },
    pause: () => { RECHECK.paused = true; updateProgress(); },
    resume: () => { RECHECK.paused = false; runQueue(); updateProgress(); },
    progress: () => ({ queue: RECHECK.queue.length, done: RECHECK.done, error: RECHECK.error, total: RECHECK.total, running: RECHECK.running, paused: RECHECK.paused }),
    computeAV: computeAV,
    AV_HEADER: AV_HEADER, AV_KEY: AV_KEY,
  };

  console.log('[scan-review-av] đã nạp: cột AV + Kiểm lại + tick riêng biển số phiếu lạ');
})();
