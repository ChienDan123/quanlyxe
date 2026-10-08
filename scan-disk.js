/* =========================================================================
   scan-disk.js — CHỌN THƯ MỤC LƯU ẢNH TRÊN MÁY TÍNH (ổ C / D / E / ổ ngoài…)
   Vì sao cần: trình duyệt tự giữ dữ liệu (IndexedDB) trong hồ sơ Chrome — thường ở ổ C và web KHÔNG đổi được chỗ đó.
   Cách làm: dùng File System Access API (Chrome / Edge trên máy tính): người dùng chọn 1 thư mục bất kỳ, web lưu ảnh phiếu vào đó dạng
   file thường «<mã phiếu>__front.jpg» / «__back.jpg» (xem được bằng Windows Explorer, sao lưu được).
     • Ảnh mới quét + ảnh tải từ Drive đều được lưu thêm vào thư mục.
     • Cần xem ảnh mà trình duyệt không còn → ĐỌC TỪ THƯ MỤC trước, KHÔNG tải lại từ Drive (scan-sync.js → fromDisk).
     • «Chuyển hẳn sang thư mục»: sau khi kiểm tra file đã ghi đúng dung lượng thì xóa bản trong trình duyệt (giải phóng ổ C) — chỉ làm với phiếu đã lưu online.
   Điện thoại / Firefox / Safari không hỗ trợ -> hiện thông báo, mọi thứ khác vẫn chạy bình thường. Nạp SAU scan-store.js.
   ========================================================================= */
const ScanDisk = (() => {
  'use strict';
  const S = ScanApp, DB = S.db, ST_SCANS = DB.ST_SCANS;
  const supported = typeof window.showDirectoryPicker === 'function';
  const D = { handle: null, perm: 'none', busy: false };
  const q = (sel) => document.querySelector(sel);
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const EXTS = ['jpg', 'png', 'webp', 'pdf'];
  const safe = (id) => String(id).replace(/[^\w\-]/g, '');                 // cùng cách đặt tên với Drive
  const fmt = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

  /* ---- Nhớ thư mục đã chọn (handle lưu được trong IndexedDB) ---- */
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('scanDiskV1', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const hop = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const rq = fn(db.transaction('h', mode).objectStore('h')); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); };
  const hGet = () => hop('readonly', os => os.get('dir'));
  const hPut = (h) => hop('readwrite', os => os.put(h, 'dir'));
  const hDel = () => hop('readwrite', os => os.delete('dir'));

  // Quyền ghi thư mục: sau khi tắt trình duyệt Chrome hỏi lại 1 lần. ask=true chỉ có tác dụng khi đang trong thao tác bấm chuột của người dùng.
  async function perm(ask) {
    if (!D.handle) return false;
    const o = { mode: 'readwrite' };
    let p = 'prompt';
    try { p = await D.handle.queryPermission(o); if (p !== 'granted' && ask) p = await D.handle.requestPermission(o); } catch (e) { /* ngoài thao tác người dùng -> bỏ qua */ }
    D.perm = p; return p === 'granted';
  }
  const ready = () => !!D.handle;

  /* ---- Ghi / đọc 1 ảnh ---- */
  async function write(id, side, blob) {
    if (!blob || !D.handle || !(await perm(false))) return false;
    try {
      const name = `${safe(id)}__${side}.${EXT[blob.type] || 'jpg'}`;
      // file đã có đúng dung lượng -> không ghi lại (không làm lại việc đã xong)
      try { const old = await (await D.handle.getFileHandle(name)).getFile(); if (old.size === blob.size) return true; } catch (e) { /* chưa có */ }
      const w = await (await D.handle.getFileHandle(name, { create: true })).createWritable();
      await w.write(blob); await w.close(); return true;
    } catch (e) { console.warn('[scan-disk] ghi lỗi', e); return false; }
  }
  async function read(id, side) {
    if (!D.handle || !(await perm(true))) return null;
    for (const ext of EXTS) { try { return await (await D.handle.getFileHandle(`${safe(id)}__${side}.${ext}`)).getFile(); } catch (e) { /* thử đuôi khác */ } }
    return null;
  }
  // Ghi cả 2 mặt của 1 bản ghi phiếu (chạy ngầm, lỗi thì bỏ qua)
  function writeRec(rec) {
    if (!rec || !D.handle) return Promise.resolve();
    return Promise.all(['front', 'back'].map(sd => write(rec.id, sd, rec[sd + 'Blob']))).then(() => refreshUi()).catch(() => {});
  }
  // Phiếu vừa quét xong -> lưu ảnh vào thư mục ngay
  S.on('sheetDone', async (d) => { try { if (D.handle) writeRec(await DB.dbGet(ST_SCANS, d.scanId)); } catch (e) { /* bỏ qua */ } });

  /* ---- Sao chép / chuyển toàn bộ ảnh đang có trong trình duyệt ---- */
  async function localIds() {
    const db = await DB.openDb(), ids = [];
    await new Promise((res, rej) => {
      const req = db.transaction(ST_SCANS, 'readonly').objectStore(ST_SCANS).openCursor();
      req.onsuccess = () => { const c = req.result; if (!c) { res(); return; } const r = c.value; if (r.status === 'done' && !r.isTest && (r.frontBlob || r.backBlob)) ids.push(r.id); c.continue(); };
      req.onerror = () => rej(req.error);
    });
    return ids;
  }
  // move=true: ghi xong + kiểm tra đúng dung lượng thì xóa bản trong trình duyệt. Chỉ với phiếu ĐÃ lưu online (còn đường tải lại nếu thư mục bị mất).
  async function exportAll(move, onProgress) {
    if (!(await perm(true))) throw new Error('Chưa có quyền ghi thư mục — bấm «Cấp quyền» rồi thử lại.');
    const ids = await localIds(); let done = 0, moved = 0, failed = 0;
    for (const id of ids) {
      const rec = await DB.dbGet(ST_SCANS, id); if (!rec) continue;
      let ok = true;
      for (const sd of ['front', 'back']) {
        const b = rec[sd + 'Blob']; if (!b) continue;
        if (!(await write(id, sd, b))) { ok = false; break; }
        try { const f = await (await D.handle.getFileHandle(`${safe(id)}__${sd}.${EXT[b.type] || 'jpg'}`)).getFile(); if (f.size !== b.size) ok = false; } catch (e) { ok = false; }
      }
      if (!ok) failed++;
      else if (move && rec.cloud && rec.cloud.frontId) {          // đã lên Drive -> an toàn để bỏ bản trong trình duyệt
        const fresh = await DB.dbGet(ST_SCANS, id);
        if (fresh) { fresh.frontBlob = null; fresh.backBlob = null; await DB.dbPut(ST_SCANS, fresh); moved++; }
      }
      done++; if (onProgress) onProgress(done, ids.length);
    }
    return { total: ids.length, moved, failed };
  }
  async function countFiles() { let n = 0; try { for await (const [name] of D.handle.entries()) if (/__(front|back)\./.test(name)) n++; } catch (e) { return -1; } return n; }

  /* ---- Giao diện (chèn bằng JS vào Cài đặt → Lưu trữ) ---- */
  const setMsg = (html, err) => { const el = q('#scanDiskMsg'); if (el) { el.innerHTML = html; el.classList.toggle('error-text', !!err); } };
  async function refreshUi() {
    const st = q('#scanDiskState'); if (!st) return;
    const has = !!D.handle;
    ['#btnDiskGrant', '#btnDiskCopy', '#btnDiskMove', '#btnDiskForget'].forEach(id => { const b = q(id); if (b) b.disabled = !has; });
    if (!supported) { st.textContent = '⚠ Trình duyệt này không hỗ trợ chọn thư mục. Dùng Chrome hoặc Edge trên máy tính (điện thoại không hỗ trợ).'; q('#btnDiskPick').disabled = true; return; }
    if (!has) { st.textContent = 'Chưa chọn thư mục — ảnh đang nằm trong bộ nhớ trình duyệt (thường ổ C).'; return; }
    const ok = await perm(false);
    st.textContent = ok ? `✅ Đang lưu ảnh vào thư mục «${D.handle.name}» · ${await countFiles()} file ảnh.` : `⏸ Thư mục «${D.handle.name}» cần được cấp quyền lại (bấm «Cấp quyền» — Chrome hỏi lại sau mỗi lần mở trình duyệt).`;
  }
  async function pick() {
    try {
      const h = await window.showDirectoryPicker({ id: 'quanlyxe-scan', mode: 'readwrite' });
      D.handle = h; await hPut(h); await perm(true); await refreshUi();
      setMsg('✅ Đã chọn thư mục. Ảnh mới sẽ tự lưu vào đó. Bấm «Sao chép ảnh hiện có» để đưa cả ảnh cũ sang.');
    } catch (e) { if (e && e.name !== 'AbortError') setMsg('❌ ' + (e.message || e), true); }
  }
  async function run(move) {
    if (D.busy) return; D.busy = true;
    if (move && !confirm('Chuyển ảnh sang thư mục?\n\n• Ảnh của phiếu ĐÃ lưu online sẽ được xóa khỏi bộ nhớ trình duyệt (giải phóng ổ C) sau khi kiểm tra đã ghi đúng vào thư mục.\n• Khi xem lại, web đọc từ thư mục này (không tải lại Drive).\n• Đừng xóa / đổi tên file trong thư mục; nếu lỡ mất, web vẫn tải lại được từ Drive.')) { D.busy = false; return; }
    try {
      const r = await exportAll(!!move, (d, t) => setMsg(`⏳ Đang ghi ${d}/${t} phiếu…`));
      setMsg(`✅ Xong: ${r.total - r.failed}/${r.total} phiếu đã có trong thư mục${move ? `, đã giải phóng ảnh của ${r.moved} phiếu trong trình duyệt` : ''}.${r.failed ? ` ${r.failed} phiếu ghi lỗi (giữ nguyên trong trình duyệt).` : ''}`, !!r.failed);
    } catch (e) { setMsg('❌ ' + (e.message || e), true); }
    finally { D.busy = false; refreshUi(); if (window.ScanSync) ScanSync.refreshStatus(); }
  }
  async function forget() { if (!confirm('Bỏ chọn thư mục? (File ảnh trong thư mục vẫn còn nguyên, chỉ là web không dùng nữa.)')) return; D.handle = null; D.perm = 'none'; await hDel().catch(() => {}); refreshUi(); setMsg('Đã bỏ chọn thư mục.'); }

  function injectUi() {
    if (q('#scanDiskState')) return;
    const anchor = q('.ss-imgs') || q('#scanStoreMsg'); if (!anchor) return;
    const box = document.createElement('div'); box.className = 'ss-disk';
    box.innerHTML = `<b>📁 Thư mục lưu ảnh trên máy tính (đổi ổ C → D / E / ổ ngoài…)</b>
<div class="hint">Trình duyệt tự giữ dữ liệu trong hồ sơ Chrome (thường ổ C) và web không đổi được chỗ đó. Muốn ảnh nằm ở ổ khác: bấm «Chọn thư mục…» rồi chọn 1 thư mục tùy ý (vd. <code>D:\\AnhPhieuScan</code>). Ảnh sẽ được lưu thành file thường, và khi xem lại web đọc từ đây — <b>không tải lại từ Drive</b>. Chỉ Chrome / Edge trên máy tính.</div>
<div id="scanDiskState" class="hint"></div>
<div class="sv-actions"><button type="button" class="btn btn-secondary btn-sm" id="btnDiskPick">📁 Chọn thư mục…</button><button type="button" class="btn btn-ghost btn-sm" id="btnDiskGrant">🔓 Cấp quyền</button><button type="button" class="btn btn-ghost btn-sm" id="btnDiskCopy">📋 Sao chép ảnh hiện có vào thư mục</button><button type="button" class="btn btn-ghost btn-sm" id="btnDiskMove">🚚 Chuyển hẳn sang thư mục (giải phóng ổ C)</button><button type="button" class="btn btn-ghost btn-sm" id="btnDiskForget">✕ Bỏ chọn</button></div>
<div id="scanDiskMsg" class="hint"></div>`;
    anchor.insertAdjacentElement('beforebegin', box);
    q('#btnDiskPick').addEventListener('click', pick);
    q('#btnDiskGrant').addEventListener('click', async () => { await perm(true); await refreshUi(); });
    q('#btnDiskCopy').addEventListener('click', () => run(false));
    q('#btnDiskMove').addEventListener('click', () => run(true));
    q('#btnDiskForget').addEventListener('click', forget);
  }

  (async () => { try { if (supported) D.handle = await hGet() || null; } catch (e) { /* bỏ qua */ } injectUi(); refreshUi(); })();
  document.querySelectorAll('[data-open-scanstore], #btnSettings').forEach(b => b.addEventListener('click', () => setTimeout(refreshUi, 300)));
  return { ready, read, write, writeRec, pick, exportAll, supported };
})();
window.ScanDisk = ScanDisk;
