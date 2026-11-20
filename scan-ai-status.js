/* =========================================================================
   scan-ai-status.js — CHỈ BÁO TRẠNG THÁI «🔁 Kiểm lại tất cả chưa kiểm (AI)»
   Nạp SAU scan-recheck.js (và sau scan-review.js). Cung cấp window.AIRecheckUI
   mà scan-recheck.js gọi: begin / tick / wait / pause / queued / calling / called /
   log / error / finish / finishEmpty / stopped / open.

   Trạng thái: running ▶ · queued 💤 · paused ⏸ (kèm lý do) · error ⚠ · done ✔ · idle (ẩn)
   - Chip #aiRecheckChip đặt ngay sau #scanBgChip trên header; bấm → mở bảng chi tiết.
   - Nhãn trạng thái ngắn gắn vào nút #btnRecheckAll.
   - Trạng thái + nhật ký lưu bền (IndexedDB nếu có idbSet, không thì localStorage).
   - Heartbeat mỗi giây: giờ «cập nhật» chạy liên tục để biết web còn sống.
   ========================================================================= */
(function () {
  'use strict';
  if (window.AIRecheckUI) return;

  const KEY = 'aiRecheckStatusV1';
  const LOG_KEEP = 40, LOG_SHOW = 10;
  const STALE_RUNNING_MS = 90 * 1000;   // «đang chạy» mà không có nhịp tim quá lâu → web đã đóng giữa chừng

  const META = {
    running: { icon: '▶', cls: 'run', label: 'Đang chạy' },
    queued:  { icon: '💤', cls: 'que', label: 'Đang chờ rảnh' },
    paused:  { icon: '⏸', cls: 'pau', label: 'Tạm dừng' },
    error:   { icon: '⚠', cls: 'err', label: 'Lỗi' },
    done:    { icon: '✔', cls: 'don', label: 'Hoàn tất' },
    idle:    { icon: '', cls: 'idl', label: '' },
  };

  let st = {
    state: 'idle', reason: '', lan: 0, total: 0, index: 0, plate: '',
    lastCallAt: 0, calls: 0, heartbeatAt: 0, startedAt: 0, finishedAt: 0,
    summary: null, seen: true, log: [],
  };

  /* ---------- lưu bền ---------- */
  let _saveT = 0;
  async function persistNow() {
    try {
      const snap = JSON.parse(JSON.stringify(st));
      if (typeof idbSet === 'function') await idbSet(KEY, snap);
      else localStorage.setItem(KEY, JSON.stringify(snap));
    } catch (_) { /* bỏ qua */ }
  }
  function persist() { clearTimeout(_saveT); _saveT = setTimeout(persistNow, 400); }
  async function load() {
    try {
      let v = null;
      if (typeof idbGet === 'function') v = await idbGet(KEY);
      if (!v) { try { v = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { v = null; } }
      if (v && typeof v === 'object') {
        st = Object.assign(st, v);
        st.log = Array.isArray(st.log) ? st.log : [];
        // Đã đóng web lúc đang chạy: scan-recheck sẽ tự chạy tiếp sau ít chục giây → hiện «đang chờ»
        if (st.state === 'running' && Date.now() - (st.heartbeatAt || 0) > STALE_RUNNING_MS) {
          st.state = 'queued'; st.reason = 'web vừa mở lại — sẽ tự chạy tiếp phần dang dở';
        }
      }
    } catch (_) { /* bỏ qua */ }
    render();
  }

  /* ---------- tiện ích ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const hms = (t) => { if (!t) return '—'; const d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); };
  const ago = (t) => { if (!t) return '—'; const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + ' giây trước' : s < 3600 ? Math.floor(s / 60) + ' phút trước' : Math.floor(s / 3600) + ' giờ trước'; };
  function addLog(msg) {
    st.log.push({ at: Date.now(), msg: String(msg || '').slice(0, 220) });
    if (st.log.length > LOG_KEEP) st.log.splice(0, st.log.length - LOG_KEEP);
  }
  const lastLogMsg = () => (st.log.length ? st.log[st.log.length - 1].msg : '');

  function chipText() {
    switch (st.state) {
      case 'running': return `▶ 🤖 AI đang kiểm lại ${st.index || 0}/${st.total || 0}${st.plate ? ' · ' + st.plate : ''} · lần ${st.lan || '?'}`;
      case 'queued':  return `💤 AI kiểm lại: đang chờ rảnh${st.reason ? ' (' + st.reason + ')' : ''}`;
      case 'paused':  return `⏸ AI kiểm lại tạm dừng${st.reason ? ': ' + st.reason : ''}`;
      case 'error':   return `⚠ AI kiểm lại lỗi${st.reason ? ': ' + st.reason : ''}`;
      case 'done': {
        const s = st.summary || {};
        return `✔ AI kiểm xong lần ${st.lan || '?'}: ${s.dung || 0} đúng · ${s.da_ghi || 0} đã ghi · ${s.nghi_van || 0} nghi vấn · ${s.loi || 0} lỗi`;
      }
      default: return '';
    }
  }
  function btnSuffix() {
    switch (st.state) {
      case 'running': return `▶ ${st.index || 0}/${st.total || 0}`;
      case 'queued':  return '💤 chờ rảnh';
      case 'paused':  return '⏸ tạm dừng';
      case 'error':   return '⚠ lỗi';
      case 'done':    return '✔ xong';
      default: return '';
    }
  }

  /* ---------- CSS ---------- */
  (function css() {
    if (document.getElementById('aiStatusCss')) return;
    const el = document.createElement('style'); el.id = 'aiStatusCss';
    el.textContent =
      '#aiRecheckChip{display:none;align-items:center;gap:6px;max-width:46vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-size:12px;line-height:1.3;padding:3px 10px;border-radius:999px;border:1px solid currentColor;cursor:pointer;margin-left:6px;user-select:none;}' +
      '#aiRecheckChip.show{display:inline-flex;}' +
      '#aiRecheckChip .hb{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;flex:none;}' +
      '#aiRecheckChip.run .hb{animation:aiHb 1s ease-in-out infinite;}' +
      '@keyframes aiHb{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}' +
      '.ai-st-run{color:#1565c0}.ai-st-que{color:#6b7280}.ai-st-pau{color:#b26a00}.ai-st-err{color:#c62828}.ai-st-don{color:#1b7f3b}' +
      '#aiRecheckPanel{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);}' +
      '#aiRecheckPanel.show{display:flex;}' +
      '#aiRecheckPanel .box{background:var(--bg,#fff);color:var(--fg,#1f2328);width:min(560px,94vw);max-height:90vh;overflow:auto;border-radius:12px;padding:16px 18px;box-shadow:0 10px 40px rgba(0,0,0,.35);}' +
      '@media (prefers-color-scheme: dark){#aiRecheckPanel .box{background:var(--bg,#1e1f22);color:var(--fg,#e6e6e6);}}' +
      '#aiRecheckPanel h3{margin:0 0 8px;font-size:16px;display:flex;align-items:center;gap:8px;}' +
      '#aiRecheckPanel .kv{display:grid;grid-template-columns:150px 1fr;gap:4px 10px;font-size:13px;margin:8px 0;}' +
      '#aiRecheckPanel .kv b{opacity:.7;font-weight:600;}' +
      '#aiRecheckPanel .bar{height:8px;border-radius:6px;background:rgba(128,128,128,.25);overflow:hidden;margin:6px 0;}' +
      '#aiRecheckPanel .bar>i{display:block;height:100%;background:currentColor;}' +
      '#aiRecheckPanel .log{font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;background:rgba(128,128,128,.12);border-radius:8px;padding:8px 10px;max-height:210px;overflow:auto;}' +
      '#aiRecheckPanel .log div{white-space:pre-wrap;word-break:break-word;}' +
      '#aiRecheckPanel .acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;justify-content:flex-end;}' +
      '#aiRecheckPanel .acts button{cursor:pointer;}';
    document.head.appendChild(el);
  })();

  /* ---------- DOM ---------- */
  let chip = null, panel = null, hbDot = null;
  function ensureChip() {
    if (chip && document.body.contains(chip)) return chip;
    const anchor = document.getElementById('scanBgChip');
    chip = document.getElementById('aiRecheckChip');
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'aiRecheckChip'; chip.title = 'Bấm để xem chi tiết kiểm lại bằng AI'; chip.setAttribute('role', 'button');
      chip.innerHTML = '<span class="hb"></span><span class="tx"></span>';
      if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', chip);
      else { const h = document.querySelector('header') || document.body; h.appendChild(chip); }
      chip.addEventListener('click', openPanel);
    }
    return chip;
  }
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.getElementById('aiRecheckPanel');
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'aiRecheckPanel';
      panel.innerHTML = '<div class="box" role="dialog" aria-label="Kiểm lại bằng AI"></div>';
      document.body.appendChild(panel);
      panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(); });
      panel.addEventListener('click', onPanelClick);
    }
    return panel;
  }
  function openPanel() { ensurePanel().classList.add('show'); st.seen = true; persist(); renderPanel(); render(); }
  function closePanel() { if (panel) panel.classList.remove('show'); }
  async function onPanelClick(e) {
    const b = e.target.closest && e.target.closest('[data-ai-act]'); if (!b) return;
    const act = b.dataset.aiAct, RC = window.ScanRecheck || {};
    try {
      if (act === 'close') closePanel();
      else if (act === 'pause') { if (RC.pause) RC.pause(); addLog('Bạn bấm Tạm dừng — sẽ dừng sau mục đang xử lý.'); }
      else if (act === 'resume' || act === 'retry') { addLog(act === 'retry' ? 'Bạn bấm Thử lại.' : 'Bạn bấm Tiếp tục.'); st.state = 'queued'; st.reason = 'đang khởi động lại…'; render(); if (RC.resume) RC.resume(); }
      else if (act === 'stop') {
        if (!window.confirm('Dừng HẲN việc kiểm lại bằng AI?\n(Tiến độ dang dở sẽ bị xóa; kết quả đã ghi vẫn giữ nguyên.)')) return;
        addLog('Bạn bấm Dừng hẳn.'); if (RC.stopHard) await RC.stopHard();
      }
    } catch (x) { console.warn('[ai-status] thao tác', act, x); }
    persist(); render();
  }

  function renderPanel() {
    if (!panel || !panel.classList.contains('show')) return;
    const m = META[st.state] || META.idle, box = panel.querySelector('.box');
    const pct = st.total ? Math.min(100, Math.round(((st.index || 0) / st.total) * 100)) : 0;
    const alive = st.state === 'running' ? ` · nhịp tim ♥ ${hms(st.heartbeatAt)}` : '';
    const s = st.summary;
    const logs = st.log.slice(-LOG_SHOW).reverse().map(l => `<div>${hms(l.at)}  ${esc(l.msg)}</div>`).join('') || '<div>(chưa có nhật ký)</div>';
    const run = st.state === 'running', pau = st.state === 'paused', que = st.state === 'queued', err = st.state === 'error';
    box.innerHTML =
      `<h3 class="ai-st-${m.cls}">${m.icon} ${esc(m.label || 'Không có việc nào đang chạy')}${st.reason && (pau || err || que) ? ' — ' + esc(st.reason) : ''}</h3>` +
      `<div class="ai-st-${m.cls}"><div class="bar"><i style="width:${pct}%"></i></div></div>` +
      '<div class="kv">' +
        `<b>Tiến độ</b><span>${st.index || 0}/${st.total || 0} (${pct}%) · lần kiểm ${st.lan || '?'}</span>` +
        `<b>Đang xử lý</b><span>${esc(st.plate || '—')}</span>` +
        `<b>Gọi Gemini gần nhất</b><span>${hms(st.lastCallAt)}${st.lastCallAt ? ' (' + ago(st.lastCallAt) + ')' : ''}</span>` +
        `<b>Số lần đã gọi</b><span>${st.calls || 0}</span>` +
        `<b>Cập nhật</b><span>${hms(st.heartbeatAt)}${alive}</span>` +
        (st.startedAt ? `<b>Bắt đầu lúc</b><span>${hms(st.startedAt)}</span>` : '') +
        (s ? `<b>Kết quả</b><span>${s.dung || 0} chắc chắn đúng · ${s.da_ghi || 0} đã ghi · ${s.nghi_van || 0} còn nghi vấn · ${s.loi || 0} lỗi</span>` : '') +
      '</div>' +
      `<div><b style="font-size:12px;opacity:.7">${LOG_SHOW} dòng nhật ký cuối</b><div class="log">${logs}</div></div>` +
      '<div class="acts">' +
        (run ? '<button type="button" class="btn btn-secondary btn-sm" data-ai-act="pause">⏸ Tạm dừng</button>' : '') +
        ((pau || que) ? '<button type="button" class="btn btn-primary btn-sm" data-ai-act="resume">▶ Tiếp tục</button>' : '') +
        (err ? '<button type="button" class="btn btn-primary btn-sm" data-ai-act="retry">↻ Thử lại</button>' : '') +
        ((run || pau || que || err) ? '<button type="button" class="btn btn-ghost btn-sm" data-ai-act="stop">⏹ Dừng hẳn</button>' : '') +
        '<button type="button" class="btn btn-ghost btn-sm" data-ai-act="close">Đóng</button>' +
      '</div>';
  }

  function render() {
    const c = ensureChip(), m = META[st.state] || META.idle;
    // Tự ẩn khi không có việc và không có kết quả mới chưa xem
    const visible = st.state !== 'idle' && !(st.state === 'done' && st.seen);
    c.classList.toggle('show', visible);
    c.className = c.className.replace(/\bai-st-\w+\b|\b(run|que|pau|err|don|idl)\b/g, '').trim() + ' ai-st-' + m.cls + ' ' + m.cls;
    if (visible) c.classList.add('show');
    const tx = c.querySelector('.tx'); if (tx) tx.textContent = chipText();
    c.title = chipText() + ' — bấm để xem chi tiết';
    // Nhãn trên nút ở màn So sánh
    const btn = document.getElementById('btnRecheckAll');
    if (btn) {
      if (!btn.dataset.aiBase) btn.dataset.aiBase = btn.textContent.replace(/\s*[▶💤⏸⚠✔].*$/u, '').trim();
      const suf = btnSuffix();
      btn.textContent = suf ? `${btn.dataset.aiBase} · ${suf}` : btn.dataset.aiBase;
    }
    renderPanel();
  }

  /* ---------- Nhịp tim ---------- */
  let _lastPersistHb = 0;
  setInterval(() => {
    if (st.state === 'running') {
      st.heartbeatAt = Date.now();
      if (Date.now() - _lastPersistHb > 5000) { _lastPersistHb = Date.now(); persist(); }
      const tx = chip && chip.querySelector('.tx'); if (tx) tx.textContent = chipText();
    }
    renderPanel();
  }, 1000);

  /* ---------- API cho scan-recheck.js ---------- */
  async function summarize() {
    const out = { dung: 0, da_ghi: 0, nghi_van: 0, loi: 0, khoa_thu_cong: 0, chua_kiem_lai: 0 };
    try {
      const S = window.ScanApp || (typeof ScanApp !== 'undefined' ? ScanApp : null);
      const cls = window.ScanReviewAI && window.ScanReviewAI.aiClass;
      if (S && S.db && cls) {
        const norm = (window.ScanReview && window.ScanReview.normItem) || ((x) => x);
        (await S.db.dbGetAll(S.db.ST_ITEMS)).forEach(x => { const k = cls(norm(x)); if (k in out) out[k]++; });
      }
    } catch (_) { /* bỏ qua */ }
    return out;
  }
  const API = {
    begin(o) {
      o = o || {};
      st.state = 'running'; st.reason = ''; st.lan = o.lan || st.lan; st.total = o.total || 0; st.index = 0; st.plate = '';
      st.startedAt = Date.now(); st.heartbeatAt = Date.now(); st.summary = null; st.seen = false; st.calls = 0;
      addLog(`Bắt đầu kiểm lại lần ${st.lan}: ${st.total} mục.`); persist(); render();
    },
    tick(o) {
      o = o || {};
      st.state = 'running'; st.reason = ''; st.heartbeatAt = Date.now();
      if (o.currentPlate != null) st.plate = String(o.currentPlate);
      if (o.currentIndex != null) st.index = o.currentIndex;
      if (o.total != null) st.total = o.total;
      if (o.lan != null) st.lan = o.lan;
      persist(); render();
    },
    wait(reason) {
      if (st.state !== 'paused' || st.reason !== reason) addLog('Tạm dừng: ' + reason);
      st.state = 'paused'; st.reason = String(reason || ''); st.heartbeatAt = Date.now(); persist(); render();
    },
    pause(reason) { API.wait(reason); },
    queued(reason, prog) {
      if (window._aiRecheckRunning) return;
      if (prog) { st.lan = prog.lan || st.lan; st.total = prog.total || st.total; st.index = prog.done || st.index; }
      if (st.state !== 'queued' || st.reason !== reason) addLog('Đang chờ rảnh: ' + reason);
      st.state = 'queued'; st.reason = String(reason || ''); st.seen = false; persist(); render();
    },
    calling(plate) { st.plate = plate || st.plate; st.heartbeatAt = Date.now(); render(); },
    called(plate) { st.lastCallAt = Date.now(); st.calls = (st.calls || 0) + 1; st.heartbeatAt = Date.now(); addLog('Gemini trả lời: ' + (plate || '(không biển)')); persist(); render(); },
    log(msg) { addLog(msg); persist(); renderPanel(); },
    error(msg) { st.state = 'error'; st.reason = String(msg || 'không rõ'); st.seen = false; addLog('LỖI: ' + st.reason); persist(); render(); },
    async finish(o) {
      const s = await summarize();
      st.summary = s; st.state = 'done'; st.reason = ''; st.finishedAt = Date.now(); st.index = st.total; st.plate = ''; st.seen = false;
      addLog(`Hoàn tất lần ${st.lan}: ${s.dung} đúng · ${s.da_ghi} đã ghi · ${s.nghi_van} nghi vấn · ${s.loi} lỗi.`);
      persist(); render();
    },
    finishEmpty() { st.state = 'idle'; st.reason = ''; addLog('Không còn mục nào cần kiểm.'); persist(); render(); },
    stopped() { st.state = 'idle'; st.reason = ''; st.summary = null; addLog('Đã dừng hẳn.'); persist(); render(); },
    open: openPanel,
    close: closePanel,
    getState: () => JSON.parse(JSON.stringify(st)),
  };
  window.AIRecheckUI = API;

  // DOM có thể chưa sẵn sàng (#scanBgChip, nút So sánh được tạo muộn) → thử lại vài lần
  const boot = () => { load(); [800, 2500, 6000].forEach(ms => setTimeout(render, ms)); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  // Màn So sánh mở ra mới có nút #btnRecheckAll → cập nhật nhãn nút khi mở
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#btnScanOpenReview')) [300, 1200].forEach(ms => setTimeout(render, ms)); }, true);
})();
