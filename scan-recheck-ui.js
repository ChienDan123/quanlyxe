/* =============================================================================
   scan-recheck-ui.js — Chip trạng thái AI kiểm lại (cạnh #scanBgChip) + bảng chi tiết.
   Phụ thuộc: window.ScanRecheck (scan-recheck.js), window.ScanApp.db, idbGet/idbSet (app.js),
              #scanBgChip (index.html). Tự chèn CSS + chip + <dialog> khi DOM sẵn sàng.
   ============================================================================= */
(function () {
  'use strict';
  const S  = window.ScanApp   || (typeof ScanApp   !== 'undefined' ? ScanApp   : null);
  const R  = window.ScanReview|| (typeof ScanReview!== 'undefined' ? ScanReview: null);
  if (!S) { console.warn('[AIRecheckUI] Thiếu ScanApp — bỏ qua.'); return; }

  const STATE_KEY = 'aiRecheckUiStateV1';
  const MAX_LOG = 10;
  const DONE_VISIBLE_MS = 30 * 60 * 1000;      // giữ chip "Hoàn tất" 30 phút sau khi xong

  const defaultState = () => ({
    status: 'idle', pausedReason: '', currentPlate: '', currentIndex: 0, total: 0, lan: 0,
    callCount: 0, lastGeminiCall: 0, lastHeartbeat: 0, startedAt: 0, finishedAt: 0,
    errorMsg: '', logLines: [], doneStats: { certain: 0, uncertain: 0, written: 0, errored: 0 },
  });
  let state = defaultState();
  let chipEl = null, dlgEl = null, hbTimer = null, saveTimer = 0, doneHideTimer = 0;

  const pad = n => String(n).padStart(2, '0');
  const nowStr = () => { const t = new Date(); return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`; };
  const fmtTs = (ts) => { if (!ts) return '—'; const d = new Date(ts);
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const agoStr = (ts) => { if (!ts) return '—'; const s = Math.round((Date.now()-ts)/1000);
    if (s < 60) return s + 's trước'; if (s < 3600) return Math.round(s/60) + ' phút trước'; return Math.round(s/3600) + ' giờ trước'; };

  async function loadState() {
    try {
      const v = (typeof idbGet === 'function') ? await idbGet(STATE_KEY) : null;
      if (v && typeof v === 'object') state = Object.assign(defaultState(), v);
      // Trang trước bị đóng khi đang chạy → coi như tạm dừng, không giả vờ đang sống
      if (state.status === 'running' || state.status === 'waiting') {
        state.status = 'paused'; state.pausedReason = 'trang đã được tải lại';
      }
      state.currentPlate = ''; state.currentIndex = 0;
    } catch (_) {}
  }
  function saveState() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => { saveTimer = 0;
      try { if (typeof idbSet === 'function') await idbSet(STATE_KEY, state); } catch (_) {}
    }, 200);
  }

  function merge(patch) {
    Object.assign(state, patch || {});
    saveState(); renderChip();
    if (dlgEl && !dlgEl.classList.contains('hidden') && dlgEl.open) renderDialog();
  }
  function log(line) {
    state.logLines = (state.logLines || []).concat([`${nowStr()} · ${line}`]).slice(-MAX_LOG);
    saveState();
    if (dlgEl && dlgEl.open) renderDialog();
  }

  function startHb() { if (!hbTimer) hbTimer = setInterval(() => {
    if (state.status === 'running' || state.status === 'waiting') { state.lastHeartbeat = Date.now(); renderChip(); if (dlgEl && dlgEl.open) renderDialog(); }
  }, 3000); }
  function stopHb() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }

  /* ---------- CSS ---------- */
  function injectCss() {
    if (document.getElementById('aiRecheckCss')) return;
    const st = document.createElement('style'); st.id = 'aiRecheckCss';
    st.textContent = `
.ai-chip{cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:12px;
  font-size:12px;border:1px solid transparent;line-height:1.4;white-space:nowrap;max-width:520px;overflow:hidden;text-overflow:ellipsis;}
.ai-chip:hover{filter:brightness(0.96);}
.ai-chip .ai-hb-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;animation:aiPulse 1.4s infinite;}
@keyframes aiPulse{0%,100%{opacity:1}50%{opacity:.25}}
.ai-chip.chip-run{background:#dcfce7;color:#166534;border-color:#86efac;}
.ai-chip.chip-wait{background:#fef9c3;color:#854d0e;border-color:#fde68a;}
.ai-chip.chip-pause{background:#ffedd5;color:#9a3412;border-color:#fdba74;}
.ai-chip.chip-err{background:#fee2e2;color:#991b1b;border-color:#fca5a5;}
.ai-chip.chip-done{background:#dbeafe;color:#1e40af;border-color:#93c5fd;}
.ai-chip.chip-idle{background:#f3f4f6;color:#4b5563;border-color:#e5e7eb;}
.ai-dlg{max-width:580px;width:92vw;border:1px solid #d1d5db;border-radius:10px;padding:0;box-shadow:0 8px 24px rgba(0,0,0,.2);}
.ai-dlg::backdrop{background:rgba(0,0,0,.35);}
.ai-dlg-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #e5e7eb;background:#f9fafb;}
.ai-dlg-head h3{margin:0;font-size:15px;}
.ai-dlg-body{padding:12px 14px;}
.ai-dlg-table{width:100%;border-collapse:collapse;font-size:13px;}
.ai-dlg-table th{text-align:left;font-weight:600;padding:5px 8px;background:#f9fafb;color:#374151;width:42%;border-bottom:1px solid #f3f4f6;}
.ai-dlg-table td{padding:5px 8px;border-bottom:1px solid #f3f4f6;word-break:break-word;}
.ai-dlg-loghead{font-size:12px;font-weight:600;margin:12px 0 4px;color:#374151;}
.ai-dlg-log{background:#0f172a;color:#e2e8f0;padding:8px;font-size:11.5px;max-height:200px;overflow:auto;border-radius:4px;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;}
.ai-dlg-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;padding-top:10px;border-top:1px solid #e5e7eb;}
.ai-dlg-actions button:disabled{opacity:.4;cursor:not-allowed;}
`;
    document.head.appendChild(st);
  }

  /* ---------- Chip ---------- */
  function ensureChip() {
    if (chipEl && chipEl.isConnected) return chipEl;
    const anchor = document.getElementById('scanBgChip');
    if (!anchor || !anchor.parentNode) return null;
    chipEl = document.createElement('button');
    chipEl.type = 'button'; chipEl.id = 'aiRecheckChip';
    chipEl.className = 'ai-chip chip-idle hidden';
    chipEl.addEventListener('click', openDialog);
    anchor.parentNode.insertBefore(chipEl, anchor.nextSibling);
    return chipEl;
  }
  function chipVisible() {
    if (state.status === 'running' || state.status === 'waiting' || state.status === 'paused' || state.status === 'error') return true;
    if (state.status === 'done' && state.finishedAt && Date.now() - state.finishedAt < DONE_VISIBLE_MS) return true;
    return false;
  }
  function renderChip() {
    const el = ensureChip(); if (!el) return;
    if (!chipVisible()) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.classList.remove('chip-idle','chip-run','chip-wait','chip-pause','chip-err','chip-done');
    let text = '';
    if (state.status === 'running') {
      el.classList.add('chip-run');
      text = `🤖 AI đang kiểm lại ${state.currentIndex || 0}/${state.total || 0}`
        + (state.currentPlate ? ` · ${state.currentPlate}` : '')
        + (state.lan ? ` · lần ${state.lan}` : '');
    } else if (state.status === 'waiting') {
      el.classList.add('chip-wait');
      text = `💤 AI chờ rảnh${state.pausedReason ? ' · ' + state.pausedReason : ''}`;
    } else if (state.status === 'paused') {
      el.classList.add('chip-pause');
      text = `⏸ Tạm dừng${state.pausedReason ? ' · ' + state.pausedReason : ''}`;
    } else if (state.status === 'error') {
      el.classList.add('chip-err');
      text = `⚠ Lỗi${state.errorMsg ? ': ' + String(state.errorMsg).slice(0, 60) : ''}`;
    } else if (state.status === 'done') {
      el.classList.add('chip-done');
      const ds = state.doneStats || {};
      text = `✔ Hoàn tất lần ${state.lan || '—'} · ${ds.certain||0} chắc chắn / ${ds.uncertain||0} nghi vấn`;
    } else {
      el.classList.add('chip-idle'); text = 'AI chưa có hoạt động';
    }
    const hb = (state.status === 'running' || state.status === 'waiting') ? '<span class="ai-hb-dot"></span>' : '';
    el.innerHTML = hb + '<span>' + escapeHtml(text) + '</span>';
    el.title = 'Bấm để xem chi tiết AI kiểm lại';
  }
  function escapeHtml(s) { return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  /* ---------- Dialog ---------- */
  function ensureDialog() {
    if (dlgEl && dlgEl.isConnected) return dlgEl;
    if (!document.body) return null;
    dlgEl = document.createElement('dialog');
    dlgEl.id = 'aiRecheckDlg'; dlgEl.className = 'ai-dlg hidden';
    dlgEl.innerHTML = `
      <div class="ai-dlg-head">
        <h3>🤖 AI kiểm lại — Chi tiết</h3>
        <button type="button" class="btn btn-ghost btn-sm" data-ai-close>✕</button>
      </div>
      <div class="ai-dlg-body">
        <table class="ai-dlg-table">
          <tr><th>Trạng thái</th><td data-ai-slot="status"></td></tr>
          <tr><th>Lần gọi Gemini gần nhất</th><td data-ai-slot="lastGemini"></td></tr>
          <tr><th>Biển số đang xử lý</th><td data-ai-slot="plate"></td></tr>
          <tr><th>Tiến độ</th><td data-ai-slot="progress"></td></tr>
          <tr><th>Số lần đã gọi Gemini</th><td data-ai-slot="callCount"></td></tr>
          <tr><th>Lần kiểm</th><td data-ai-slot="lan"></td></tr>
          <tr><th>Nhịp tim</th><td data-ai-slot="heartbeat"></td></tr>
          <tr><th>Bắt đầu / Kết thúc</th><td data-ai-slot="times"></td></tr>
        </table>
        <div class="ai-dlg-loghead">10 dòng nhật ký cuối</div>
        <pre class="ai-dlg-log" data-ai-slot="log"></pre>
        <div class="ai-dlg-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-ai-act="pause">⏸ Tạm dừng</button>
          <button type="button" class="btn btn-primary btn-sm" data-ai-act="resume">▶ Tiếp tục</button>
          <button type="button" class="btn btn-ghost btn-sm" data-ai-act="stop">✕ Dừng hẳn</button>
        </div>
      </div>`;
    document.body.appendChild(dlgEl);
    dlgEl.querySelector('[data-ai-close]').addEventListener('click', () => dlgEl.close());
    dlgEl.addEventListener('click', (e) => { if (e.target === dlgEl) dlgEl.close(); });
    dlgEl.querySelector('[data-ai-act="pause"]').addEventListener('click', () => {
      try { window.ScanRecheck && window.ScanRecheck.stop && window.ScanRecheck.stop(); } catch (_) {}
      merge({ status: 'paused', pausedReason: 'bạn bấm tạm dừng' }); log('Người dùng bấm Tạm dừng');
    });
    dlgEl.querySelector('[data-ai-act="resume"]').addEventListener('click', async () => {
      try {
        if (window.ScanRecheck && window.ScanRecheck.runRecheckQueue) {
          merge({ status: 'running', pausedReason: '', errorMsg: '' }); log('Người dùng bấm Tiếp tục');
          await window.ScanRecheck.runRecheckQueue({ onlyUnchecked: true });
        }
      } catch (e) { console.warn('[AIRecheckUI] resume', e); }
    });
    dlgEl.querySelector('[data-ai-act="stop"]').addEventListener('click', () => {
      if (!window.confirm('Dừng HẲN? Tiến độ đã lưu sẽ bị xoá — lần sau bấm nút sẽ kiểm lại từ đầu.')) return;
      try { window.ScanRecheck && window.ScanRecheck.stop && window.ScanRecheck.stop(); } catch (_) {}
      try { window.ScanRecheck && window.ScanRecheck.clearProgress && window.ScanRecheck.clearProgress(); } catch (_) {}
      stopHb();
      merge({ status: 'idle', pausedReason: '', currentPlate: '', currentIndex: 0, total: 0,
              errorMsg: '', logLines: [], doneStats: { certain: 0, uncertain: 0, written: 0, errored: 0 } });
      log('Người dùng bấm Dừng hẳn — đã xoá tiến độ.');
    });
    return dlgEl;
  }
  function openDialog() { const el = ensureDialog(); if (!el) return; renderDialog(); el.showModal(); }
  function renderDialog() {
    if (!dlgEl) return;
    const q = (k) => dlgEl.querySelector(`[data-ai-slot="${k}"]`);
    q('status').textContent = `${state.status}${state.pausedReason ? ' · ' + state.pausedReason : ''}${state.errorMsg ? ' — ' + state.errorMsg : ''}`;
    q('lastGemini').textContent = state.lastGeminiCall ? `${fmtTs(state.lastGeminiCall)} (${agoStr(state.lastGeminiCall)})` : '—';
    q('plate').textContent = state.currentPlate || '—';
    q('progress').textContent = state.total ? `${state.currentIndex || 0}/${state.total}` : '—';
    q('callCount').textContent = state.callCount || 0;
    q('lan').textContent = state.lan ? 'lần ' + state.lan : '—';
    q('heartbeat').textContent = state.lastHeartbeat ? agoStr(state.lastHeartbeat) : '—';
    q('times').textContent = `${state.startedAt ? fmtTs(state.startedAt) : '—'} / ${state.finishedAt ? fmtTs(state.finishedAt) : '—'}`;
    q('log').textContent = (state.logLines && state.logLines.length) ? state.logLines.slice().reverse().join('\n') : '(chưa có)';
    const btnPause = dlgEl.querySelector('[data-ai-act="pause"]');
    const btnResume = dlgEl.querySelector('[data-ai-act="resume"]');
    const btnStop = dlgEl.querySelector('[data-ai-act="stop"]');
    const running = state.status === 'running' || state.status === 'waiting';
    btnPause.disabled = !running;
    btnResume.disabled = running || state.status === 'done';
    btnStop.disabled = state.status === 'idle';
  }

  /* ---------- Public API ---------- */
  window.AIRecheckUI = {
    state: () => state,
    setState: (patch) => merge(patch || {}),
    log,
    begin: (info) => { startHb(); info = info || {};
      merge({ status: 'running', startedAt: Date.now(), finishedAt: 0, errorMsg: '',
              currentPlate: '', currentIndex: 0,
              lan: info.lan || 0, total: info.total || 0,
              doneStats: { certain: 0, uncertain: 0, written: 0, errored: 0 } });
      log('Bắt đầu kiểm lại lần ' + (info.lan || '?') + ' · tổng ' + (info.total || 0) + ' mục'); },
    tick: (info) => { startHb(); merge(Object.assign({ status: 'running' }, info || {})); },
    wait: (reason) => { startHb(); merge({ status: 'waiting', pausedReason: reason || '' }); },
    pause: (reason) => { stopHb(); merge({ status: 'paused', pausedReason: reason || '' }); log('Tạm dừng: ' + (reason || '')); },
    err: (msg) => { stopHb(); merge({ status: 'error', errorMsg: String(msg || '') }); log('Lỗi: ' + String(msg || '')); },
    finish: (stats) => { stopHb(); const s = stats || {};
      merge({ status: 'done', finishedAt: Date.now(), currentPlate: '', doneStats: s });
      log(`Hoàn tất: ${s.certain || 0} chắc chắn / ${s.uncertain || 0} nghi vấn`); },
    geminiCall: () => { merge({ lastGeminiCall: Date.now(), callCount: (state.callCount || 0) + 1 }); },
    reopenDialog: openDialog,
  };

  /* ---------- Bootstrap ---------- */
  async function init() {
    injectCss(); await loadState();
    ensureChip(); renderChip();
    const obs = new MutationObserver(() => { ensureChip(); renderChip(); });
    obs.observe(document.body, { childList: true, subtree: false });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
