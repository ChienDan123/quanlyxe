/* =========================================================================
   scan-lean.js — ĐO & DỌN DUNG LƯỢNG IndexedDB (nhận diện bằng mã IDB-LEAN:*)
   Nạp SAU scan-disk.js và scan-sync.js, TRƯỚC layout.js.
   P1: đo dung lượng (navigator.storage.estimate + phân rã store bằng cursor)
       + bảng điều khiển trong Cài đặt → Lưu trữ.
   P2..: dọn ảnh/queue/cache — mở rộng sau (chưa có ở P1).
   ========================================================================= */
const ScanLean = (() => {
  'use strict';
  const S = window.ScanApp, DB = S && S.db;
  const q = (sel) => document.querySelector(sel);
  const LS_KEY = 'scanLeanCfgV1';
  const DEF = { auto: false, thresholdMB: 500 };
  const MB = 1048576;
  const fmt = (b) => {
    if (!b || b < 1024) return '0 KB';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= MB) return (b / MB).toFixed(1) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function loadCfg() { try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) { return Object.assign({}, DEF); } }
  function saveCfg(c) { try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch (e) {} }

  /*IDB-LEAN:P1-2*/ // Kích thước thô 1 record — đủ để so sánh, không cần chính xác byte
  function blobSize(b) { return b && typeof b.size === 'number' ? b.size : 0; }
  function jsonSize(v) { try { const s = JSON.stringify(v); return s ? s.length * 2 : 0; } catch (e) { return 0; } }
  function sizeOfRecord(v) {
    if (v == null) return 0;
    if (typeof v === 'string') return v.length * 2;
    if (typeof v !== 'object') return 8;
    let n = 0, special = false;
    if ('frontBlob' in v || 'backBlob' in v || 'extraBlobs' in v) {
      special = true;
      n += blobSize(v.frontBlob) + blobSize(v.backBlob);
      if (Array.isArray(v.extraBlobs)) for (const b of v.extraBlobs) n += blobSize(b);
    }
    if (typeof v.geminiRaw === 'string') { special = true; n += v.geminiRaw.length * 2; }
    if (v.extracted) { special = true; n += typeof v.extracted === 'string' ? v.extracted.length * 2 : jsonSize(v.extracted); }
    if (Array.isArray(v.files)) { special = true; for (const f of v.files) n += blobSize(f); }
    if (Array.isArray(v.pages)) { special = true; for (const p of v.pages) n += blobSize(p); }
    if (v.blob) { special = true; n += blobSize(v.blob); }
    if (typeof v.rawData === 'string') { special = true; n += v.rawData.length * 2; }
    if (typeof v.value === 'string') { special = true; n += v.value.length * 2; }
    if (!special) n = jsonSize(v);
    return n;
  }

  /*IDB-LEAN:P1-3*/ // Đo 1 DB bằng cursor (không nạp cả DB vào RAM); categorize(name) -> 'scans'|'queue'|'cache'|'other'
  async function dbExists(name) {
    if (!indexedDB.databases) return true;
    try { const dbs = await indexedDB.databases(); return dbs.some(d => d.name === name); } catch (e) { return true; }
  }
  async function measureDb(dbName, categorize) {
    const mainName = (DB && DB.DB_NAME) || 'vehicleScanDBV1';
    let db = null, closeAfter = false;
    if (dbName === mainName && DB && DB.openDb) {
      try { db = await DB.openDb(); } catch (e) { return {}; }
    } else {
      if (!(await dbExists(dbName))) return {};
      db = await new Promise((resolve) => {
        let existed = true;
        const r = indexedDB.open(dbName);
        r.onupgradeneeded = () => { existed = false; try { r.transaction.abort(); } catch (e) {} };
        r.onsuccess = () => { if (!existed) { try { r.result.close(); } catch (e) {} resolve(null); } else resolve(r.result); };
        r.onerror = () => resolve(null);
      });
      if (!db) return {};
      closeAfter = true;
    }
    const names = Array.from(db.objectStoreNames || []);
    if (!names.length) { if (closeAfter) try { db.close(); } catch (e) {} return {}; }
    const out = {};
    await Promise.all(names.map((name) => new Promise((resolve) => {
      let t;
      try { t = db.transaction(name, 'readonly'); } catch (e) { resolve(); return; }
      const rq = t.objectStore(name).openCursor();
      let bytes = 0, count = 0;
      rq.onsuccess = () => {
        const cur = rq.result;
        if (!cur) {
          const cat = categorize(name);
          out[cat] = (out[cat] || 0) + bytes;
          out[cat + '_n'] = (out[cat + '_n'] || 0) + count;
          resolve();
          return;
        }
        try { bytes += sizeOfRecord(cur.value); } catch (e) {}
        count++;
        cur.continue();
      };
      rq.onerror = () => resolve();
    })));
    if (closeAfter) try { db.close(); } catch (e) {}
    return out;
  }

  /*IDB-LEAN:P1-4*/ // Đo tổng quan + phân rã 4 nhóm
  async function measure() {
    const out = { at: Date.now(), usage: 0, quota: 0, scans: 0, queue: 0, cache: 0, other: 0, scansN: 0, queueN: 0, cacheN: 0 };
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        out.usage = e.usage || 0; out.quota = e.quota || 0;
      }
    } catch (e) {}
    const ST_SCANS = (DB && DB.ST_SCANS) || 'scans';
    const ST_QUEUE = (DB && DB.ST_QUEUE) || 'scanQueue';
    const mainName = (DB && DB.DB_NAME) || 'vehicleScanDBV1';
    const categorize = (name) => {
      if (name === ST_SCANS || /^scans?$/i.test(name)) return 'scans';
      if (name === ST_QUEUE || /queue/i.test(name)) return 'queue';
      return 'other';
    };
    const main = await measureDb(mainName, categorize);
    out.scans = main.scans || 0; out.scansN = main.scans_n || 0;
    out.queue = main.queue || 0; out.queueN = main.queue_n || 0;
    out.other = main.other || 0;
    const cache = await measureDb('vehicleAppCacheV1', () => 'cache');
    out.cache = cache.cache || 0; out.cacheN = cache.cache_n || 0;
    const accounted = out.scans + out.queue + out.cache;
    if (out.usage > accounted) out.other = out.usage - accounted;
    return out;
  }

  /*IDB-LEAN:P1-5*/ // Render khối UI + gắn sự kiện
  function setMsg(html, err) { const el = q('#scanLeanMsg'); if (!el) return; el.innerHTML = html; el.classList.toggle('error-text', !!err); }
  function render(data) {
    const box = q('#scanLeanSizeBody'); if (!box) return;
    const cfg = loadCfg();
    const over = cfg.thresholdMB > 0 && data.usage > cfg.thresholdMB * MB;
    box.innerHTML = `
${over ? `<div style="margin:4px 0;padding:4px 8px;border-radius:8px;background:#fee;color:#c00;font-size:12px">⚠ IndexedDB ${fmt(data.usage)} vượt ngưỡng ${cfg.thresholdMB} MB — nên dọn.</div>` : ''}
<div style="margin:6px 0"><b>Tổng đã dùng:</b> ${fmt(data.usage)}${data.quota ? ` / ${fmt(data.quota)}` : ''}</div>
<div class="hint" style="line-height:1.6">
• Ảnh phiếu (scans): <b>${fmt(data.scans)}</b> · ${data.scansN} phiếu<br>
• File hàng đợi quét (:files): <b>${fmt(data.queue)}</b> · ${data.queueN} entry<br>
• Cache dữ liệu xe: <b>${fmt(data.cache)}</b> · ${data.cacheN} mục<br>
• Dữ liệu thô khác: <b>${fmt(data.other)}</b>
</div>
<div class="sv-actions" style="margin-top:4px">
  <button type="button" class="btn btn-ghost btn-sm" id="btnLeanMeasure">📏 Đo lại</button>
  <button type="button" class="btn btn-ghost btn-sm" id="btnLeanDry">🧪 Thử khô</button>
  <button type="button" class="btn btn-secondary btn-sm" id="btnLeanRun">🧹 Dọn ngay</button>
  <button type="button" class="btn btn-ghost btn-sm" id="btnLeanGrant">🔓 Cấp quyền thư mục</button>
</div>
<div style="margin-top:6px">
  <label class="ss-check"><input type="checkbox" id="scanLeanAuto" ${cfg.auto ? 'checked' : ''}> Dọn tự động khi vượt ngưỡng</label>
  <label style="margin-left:8px">Ngưỡng: <input type="number" id="scanLeanThreshold" min="0" step="50" value="${cfg.thresholdMB}" style="width:90px"> MB</label>
</div>`;
    q('#btnLeanMeasure').addEventListener('click', () => { doMeasure().catch(() => {}); });
    q('#btnLeanDry').addEventListener('click', () => { doDryRun().catch(() => {}); });
    q('#btnLeanRun').addEventListener('click', () => { doRun().catch(() => {}); });
    q('#btnLeanGrant').addEventListener('click', () => { grantPerm().catch(() => {}); });
    q('#scanLeanAuto').addEventListener('change', (e) => { const c = loadCfg(); c.auto = !!e.target.checked; saveCfg(c); });
    q('#scanLeanThreshold').addEventListener('change', (e) => { const c = loadCfg(); c.thresholdMB = Math.max(0, parseInt(e.target.value) || 0); saveCfg(c); render(data); });
  }

  async function doMeasure() {
    setMsg('⏳ Đang đo…');
    try {
      const data = await measure();
      render(data);
      setMsg(`✅ Đo xong lúc ${new Date(data.at).toLocaleTimeString('vi-VN')}`);
      const cfg = loadCfg(); cfg.lastMeasured = data.at; saveCfg(cfg);
    } catch (e) { setMsg('❌ ' + esc(e.message || e), true); }
  }
  async function doDryRun() {
    setMsg('⏳ Đang đối chiếu để ước tính…');
    try {
      let bytes = 0, n = 0, notes = [];
      if (window.ScanSync && ScanSync.freeLocal) {
        try { const d = await ScanSync.freeLocal({ dryRun: true }); if (d) { bytes += d.bytes || 0; n += d.n || 0; if (d.skipped) notes.push(`${d.skipped} phiếu chưa xác minh Drive`); } }
        catch (e) { notes.push('Drive: ' + (e.message || e)); }
      } else notes.push('Chưa nạp ScanSync');
      setMsg(`🧪 Dự kiến giải phóng <b>${fmt(bytes)}</b> từ ${n} phiếu đã xác minh trên Drive${notes.length ? ' · ' + esc(notes.join(' · ')) : ''}.<br><span class="hint">P2/P3/P4 sẽ bổ sung các nguồn khác (ảnh trên ổ D, file queue, cache).</span>`);
    } catch (e) { setMsg('❌ ' + esc(e.message || e), true); }
  }
  async function doRun() {
    if (!confirm('Dọn ngay?\n\n• Chỉ dọn phiếu ĐÃ xác minh đủ ảnh ở Drive.\n• Dữ liệu đối chiếu vẫn giữ.\n• Mở xem lại sẽ tải ảnh từ Drive.')) return;
    setMsg('⏳ Đang dọn…');
    try {
      let bytes = 0, n = 0;
      if (window.ScanSync && ScanSync.freeLocal) {
        try { const r = await ScanSync.freeLocal(); if (r) { bytes += r.bytes || 0; n += r.n || 0; } }
        catch (e) { setMsg('❌ ' + esc(e.message || e), true); return; }
      }
      setMsg(`✅ Đã giải phóng <b>${fmt(bytes)}</b> từ ${n} phiếu.`);
      await doMeasure();
    } catch (e) { setMsg('❌ ' + esc(e.message || e), true); }
  }
  async function grantPerm() {
    if (!window.ScanDisk) { setMsg('Chưa nạp scan-disk.js', true); return; }
    try {
      const hasHandle = typeof ScanDisk.ready === 'function' ? ScanDisk.ready() : false;
      if (!hasHandle) { if (ScanDisk.pick) await ScanDisk.pick(); }
      else { const b = q('#btnDiskGrant'); if (b && !b.disabled) b.click(); else if (ScanDisk.pick) await ScanDisk.pick(); }
      setMsg('Đã yêu cầu cấp quyền thư mục.');
    } catch (e) { setMsg('❌ ' + esc(e.message || e), true); }
  }

  /*IDB-LEAN:P1-6*/ // Inject khối UI vào Cài đặt → Lưu trữ
  function injectUi() {
    if (q('#scanLeanSize')) return;
    const anchor = q('#scanStoreMsg') || q('.ss-imgs');
    if (!anchor) return;
    const box = document.createElement('div');
    box.id = 'scanLeanSize';
    box.className = 'ss-free ss-lean';
    box.innerHTML = `<b>💾 Dung lượng trình duyệt (IndexedDB)</b>
<div class="hint">IndexedDB nằm trong hồ sơ trình duyệt (thường ở ổ C) — web <b>KHÔNG đổi được chỗ lưu</b>; chỉ <b>giảm được bằng cách dọn</b> (đẩy ảnh/file sang ổ D hoặc Drive rồi xóa bản trong IndexedDB).</div>
<div id="scanLeanSizeBody"><div class="hint">Bấm «Đo lại» để xem dung lượng.</div></div>
<div class="hint" id="scanLeanMsg"></div>`;
    anchor.insertAdjacentElement('afterend', box);
    setTimeout(() => { doMeasure().catch(() => {}); }, 300);
  }

  return { injectUi, measure, doMeasure };
})();
window.ScanLean = ScanLean;
