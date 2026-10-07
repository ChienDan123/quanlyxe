/* =========================================================================
   scan-sync.js — LƯU ẢNH / PDF PHIẾU + TRẠNG THÁI ĐỐI CHIẾU ONLINE (Google Drive qua Apps Script)
   Mục tiêu: mở web từ MÁY KHÁC vẫn xem được ảnh phiếu và làm tiếp phần đang dở.
   Mô hình (local-first, giống hàng đợi đồng bộ Sheet của app):
     • Mọi thứ vẫn lưu IndexedDB trước; việc đẩy lên Drive chạy NGẦM, lỗi mạng tự thử lại sau.
     • ĐẨY: ảnh mặt 1/mặt 2 (mỗi file 1 lần) + file «meta» JSON của phiếu (dữ liệu đọc được + các mục so sánh:
       quyết định, giá trị đã sửa tay, tick kiểm ảnh…). Meta được đẩy lại (gộp 4 giây) mỗi khi mục của phiếu đổi.
     • KÉO: máy khác lấy danh sách phiếu online, tạo bản ghi phiếu (CHƯA có ảnh) + mục so sánh; ẢNH chỉ tải khi mở xem
       (ensureBlobs) rồi nhớ trong máy. Xung đột: mục nào có updatedAt MỚI hơn thì thắng (từng mục, không phải cả phiếu).
   Nơi lưu chọn ở Cài đặt (scan-store.js): 'gas' = Apps Script đang nối Sheet · 'gas2' = Apps Script RIÊNG chỉ để lưu ảnh · 'off' = chỉ trên máy.
   Cần đã dán phần 2 + 3 của AppsScript_ScanPatch.gs. Nạp SAU scan-review.js.
   ========================================================================= */
const ScanSync = (() => {
  'use strict';
  const S = ScanApp, DB = S.db, ST_SCANS = DB.ST_SCANS, ST_ITEMS = DB.ST_ITEMS;
  const MAX_B64 = 18e6;                 // ảnh sau nén ≤ ~3,5MB nên base64 hiếm khi vượt; chặn file quá lớn để khỏi treo request
  const RETRY_MS = 60000;               // gặp lỗi: nghỉ 1 phút rồi thử lại
  const Y = { busy: false, pulled: false, errUntil: 0, lastError: '', touched: new Set(), timer: null, cur: '', gone: new Set() };

  /* ---- NƠI LƯU ẢNH (chọn ở Cài đặt): nhớ trên máy; ảnh luôn lưu IndexedDB trước, "nơi lưu online" chỉ là bản sao dùng chung ---- */
  const STORE_KEY = 'vehicleScanStoreV1';
  const cfg = { mode: 'gas', url2: '' };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (e) { /* bỏ qua */ }
  const validUrl = (u) => /^https:\/\/script\.google(usercontent)?\.com\/.+\/exec/.test(String(u || '').trim());
  function setConfig(c) {
    Object.assign(cfg, c);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* bỏ qua */ }
    Y.errUntil = 0; Y.pulled = false; Y.lastError = ''; refreshStatus();
  }
  // URL Apps Script dùng để lưu ảnh: 'gas' = cái đang nối Sheet; 'gas2' = cái riêng; 'off' = không dùng
  const storeUrl = () => cfg.mode === 'gas2' ? String(cfg.url2 || '').trim() : (cfg.mode === 'gas' ? ((typeof state !== 'undefined' && state.gasUrl) || '') : '');
  const online = () => cfg.mode === 'gas2' ? validUrl(cfg.url2) : (cfg.mode === 'gas' && typeof isWriteConnected === 'function' && isWriteConnected());
  async function call(payload) {
    const r = await gasRequest(storeUrl(), payload);
    if (!r || r.ok === false) throw new Error((r && r.error) || 'Apps Script chưa hỗ trợ lưu ảnh online (dán phần 2 + 3 của AppsScript_ScanPatch.gs và Deploy lại).');
    return r;
  }
  const blobToB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
  const b64ToBlob = async (b64, mime) => (await fetch(`data:${mime || 'application/octet-stream'};base64,${b64}`)).blob();
  const itemsOf = async (scanId) => (await DB.tx(ST_ITEMS, 'readonly', os => os.index('scanId').getAll(scanId))) || [];

  // Duyệt từng bản ghi phiếu bằng cursor (không nạp cả đống ảnh vào RAM); fn trả về giá trị != null thì được gom lại
  async function forEachScan(fn) {
    const db = await DB.openDb(), out = [];
    await new Promise((resolve, reject) => {
      const req = db.transaction(ST_SCANS, 'readonly').objectStore(ST_SCANS).openCursor();
      req.onsuccess = () => { const c = req.result; if (!c) { resolve(); return; } const x = fn(c.value); if (x != null) out.push(x); c.continue(); };
      req.onerror = () => reject(req.error);
    });
    return out;
  }
  const hasBlobs = (r) => r.status === 'done' && !r.isTest && !!r.frontBlob;
  const blobsUp = (r) => !!(r.cloud && r.cloud.frontId && (!r.backBlob || r.cloud.backId));

  /* ---------------- TRẠNG THÁI HIỂN THỊ ---------------- */
  async function refreshStatus() {
    const el = document.getElementById('scanCloudStatus'); if (!el) return;
    let total = 0, up = 0;
    try { await forEachScan(r => { if (r.status === 'done' && !r.isTest) { total++; if (r.cloud && r.cloud.frontId) up++; } return null; }); } catch (e) { /* bỏ qua */ }
    let msg;
    if (cfg.mode === 'off') msg = total ? `💾 ${total} phiếu chỉ lưu trên máy này (đã tắt lưu online)` : '';
    else if (!online()) msg = total ? `☁️ ${up}/${total} phiếu đã lưu online · ${cfg.mode === 'gas2' ? 'chưa nhập URL Apps Script lưu ảnh' : 'chưa kết nối Apps Script 2 chiều'}` : '';
    else if (Y.busy) msg = `☁️ Đang đồng bộ ảnh${Y.cur ? ' (' + Y.cur + ')' : ''}… ${up}/${total}`;
    else if (Y.lastError) msg = `⚠ Lỗi lưu online: ${Y.lastError}`;
    else msg = total ? `☁️ ${up}/${total} phiếu đã lưu online` : '';
    el.textContent = msg; el.classList.toggle('error-text', !!Y.lastError && online());
  }

  /* ---------------- ĐẨY LÊN ---------------- */
  function metaOf(rec, items) {
    return {
      v: 1, scanId: rec.id, timestamp: rec.timestamp, fileName: rec.fileName, pagesDesc: rec.pagesDesc, sheetLabel: rec.sheetLabel || '',
      frontMime: rec.frontMime, backMime: rec.backMime, frontHash: rec.frontHash, backBlank: !!rec.backBlank,
      hasFront: !!(rec.cloud && rec.cloud.frontId), hasBack: !!(rec.cloud && rec.cloud.backId),
      matchedBienSo: rec.matchedBienSo || [], extracted: rec.extracted, items,
    };
  }
  // Đẩy 1 phiếu: ảnh chưa lên thì lên trước, rồi ghi meta (luôn ghi để mang trạng thái đối chiếu mới nhất)
  async function pushScan(scanId) {
    const rec = await DB.dbGet(ST_SCANS, scanId);
    if (!rec || rec.status !== 'done' || rec.isTest) return;
    if (Y.gone.has(scanId)) return;           // đã bị xóa online (ở máy khác) -> KHÔNG đẩy lại, tránh "sống dậy"
    const items = await itemsOf(scanId);
    const plates = items.map(i => i.bienSoRaw || i.bienSo).filter(Boolean).join(', ');
    rec.cloud = rec.cloud || {};
    for (const side of ['front', 'back']) {
      const blob = rec[side + 'Blob'];
      if (!blob || rec.cloud[side + 'Id']) continue;
      const b64 = await blobToB64(blob);
      if (b64.length > MAX_B64) throw new Error('Ảnh quá lớn để lưu online (' + Math.round(b64.length / 1e6) + 'MB).');
      const r = await call({ action: 'scanPut', scanId, kind: side, mime: rec[side + 'Mime'] || blob.type, b64, plates });
      rec.cloud[side + 'Id'] = r.fileId;
      await DB.dbPut(ST_SCANS, rec);          // lưu ngay từng bước: đứt mạng giữa chừng lần sau chỉ làm tiếp phần còn thiếu
    }
    const r = await call({ action: 'scanPut', scanId, kind: 'meta', mime: 'application/json', text: JSON.stringify(metaOf(rec, items)), plates });
    rec.cloud.metaAt = r.updated;             // nhớ mốc để lần kéo sau không tải lại chính bản mình vừa đẩy
    await DB.dbPut(ST_SCANS, rec);
  }

  // Chạy 1 lượt: kéo lần đầu -> đẩy mọi phiếu còn thiếu ảnh + các phiếu có thay đổi
  async function run() {
    if (Y.busy || !online() || Date.now() < Y.errUntil) { refreshStatus(); return; }
    Y.busy = true; refreshStatus();
    let cur = '';
    try {
      if (!Y.pulled) { await pull(); Y.pulled = true; }
      (await forEachScan(r => (hasBlobs(r) && !blobsUp(r)) ? r.id : null)).forEach(id => Y.touched.add(id));
      while (Y.touched.size) {
        cur = Y.touched.values().next().value; Y.cur = String(cur).slice(0, 8);
        await pushScan(cur); Y.touched.delete(cur); refreshStatus();
      }
      Y.lastError = ''; Y.errUntil = 0;
    } catch (e) {
      Y.lastError = String((e && e.message) || e).slice(0, 160); Y.errUntil = Date.now() + RETRY_MS;
      console.warn('[scan-sync]', e);
    } finally { Y.busy = false; Y.cur = ''; refreshStatus(); }
  }
  // Mục của phiếu vừa đổi -> gộp thay đổi rồi đẩy meta sau 4 giây
  function touch(scanId) { if (!scanId) return; Y.touched.add(scanId); clearTimeout(Y.timer); Y.timer = setTimeout(run, 4000); }

  /* ---------------- KÉO VỀ ---------------- */
  async function mergeMeta(m, updated) {
    let rec = await DB.dbGet(ST_SCANS, m.scanId);
    if (!rec) {   // phiếu mới từ máy khác: tạo bản ghi chưa có ảnh (ảnh tải khi mở xem)
      rec = { id: m.scanId, timestamp: m.timestamp, source: 'cloud', isTest: false, fileName: m.fileName, pagesDesc: m.pagesDesc, sheetLabel: m.sheetLabel,
        frontBlob: null, backBlob: null, frontMime: m.frontMime, backMime: m.backMime, frontHash: m.frontHash, backBlank: !!m.backBlank,
        status: 'done', matchedBienSo: m.matchedBienSo || [], extracted: m.extracted, cloud: {} };
    }
    rec.cloud = rec.cloud || {};
    if (m.hasFront && !rec.cloud.frontId) rec.cloud.frontId = 'remote';
    if (m.hasBack && !rec.cloud.backId) rec.cloud.backId = 'remote';
    if (!m.hasBack && rec.cloud.backId === 'remote') delete rec.cloud.backId;     // mặt 2 đã xóa ở máy khác (ô giữ chỗ chưa tải)
    rec.cloud.metaAt = updated;
    await DB.dbPut(ST_SCANS, rec);
    // Gộp từng mục: bản nào updatedAt mới hơn thì thắng
    const local = new Map((await itemsOf(m.scanId)).map(i => [i.id, i]));
    const plates = [];
    let pushBack = false;
    for (const ri of (m.items || [])) {
      const li = local.get(ri.id);
      if (!li || (ri.updatedAt || 0) > (li.updatedAt || 0)) {
        if (li) plates.push(li.bienSo);
        await DB.dbPut(ST_ITEMS, ri); plates.push(ri.bienSo);
      } else if ((li.updatedAt || 0) > (ri.updatedAt || 0)) pushBack = true;      // bản máy này mới hơn -> đẩy lại sau
      local.delete(ri.id);
    }
    if (local.size) pushBack = true;                                            // máy này có mục mà bản online chưa có
    if (pushBack) Y.touched.add(m.scanId);
    return plates.filter(Boolean);
  }
  async function pull() {
    const { list, gone } = await call({ action: 'scanList' });
    Y.gone = new Set(gone || []);
    // Phiếu đã xóa ở máy khác -> dọn bản trên máy này (ảnh + mục so sánh + liên kết biển số)
    if (Y.gone.size && window.ScanReview && ScanReview.purgeScanLocal) {
      const mine = await forEachScan(r => Y.gone.has(r.id) ? r.id : null);
      for (const id of mine) { try { await ScanReview.purgeScanLocal(id); Y.touched.delete(id); } catch (e) { console.warn('[scan-sync] dọn phiếu đã xóa lỗi', id, e); } }
    }
    const known = new Map();
    await forEachScan(r => { known.set(r.id, (r.cloud && r.cloud.metaAt) || 0); return null; });
    const need = (list || []).filter(x => !Y.gone.has(x.scanId) && x.updated > (known.get(x.scanId) || 0));
    const plates = [];
    for (let i = 0; i < need.length; i += 15) {
      const batch = need.slice(i, i + 15), { metas } = await call({ action: 'scanMetaBatch', ids: batch.map(x => x.scanId) });
      for (const x of batch) {
        if (!metas || !metas[x.scanId]) continue;
        try { plates.push(...await mergeMeta(JSON.parse(metas[x.scanId]), x.updated)); } catch (e) { console.warn('[scan-sync] meta lỗi', x.scanId, e); }
      }
    }
    if (need.length && window.ScanReview && ScanReview.afterRemoteMerge) await ScanReview.afterRemoteMerge(plates);
    return need.length;
  }

  /* ---------------- TẢI ẢNH KHI MỞ XEM ---------------- */
  const inflight = new Map();
  // Bản ghi chưa có ảnh nhưng đã lưu online -> tải về, nhớ trong IndexedDB. Lỗi thì gắn rec._cloudMsg để giao diện báo.
  function ensureBlobs(rec) {
    if (!rec || !rec.cloud) return Promise.resolve(rec);
    if (inflight.has(rec.id)) return inflight.get(rec.id);
    const p = (async () => {
      rec._cloudMsg = '';
      let changed = false;
      for (const side of ['front', 'back']) {
        if (rec[side + 'Blob'] || !rec.cloud[side + 'Id']) continue;
        if (!online()) { rec._cloudMsg = 'Ảnh phiếu đang lưu online — cần kết nối Apps Script (2 chiều) để tải về máy này.'; continue; }
        try {
          const r = await call({ action: 'scanGet', scanId: rec.id, kind: side });
          rec[side + 'Blob'] = await b64ToBlob(r.b64, r.mime); rec[side + 'Mime'] = r.mime || rec[side + 'Mime']; changed = true;
        } catch (e) { rec._cloudMsg = 'Không tải được ảnh từ online: ' + (e.message || e); }
      }
      if (changed) { const copy = { ...rec }; delete copy._cloudMsg; await DB.dbPut(ST_SCANS, copy); }
      return rec;
    })().finally(() => inflight.delete(rec.id));
    inflight.set(rec.id, p);
    return p;
  }

  /* ---------------- KHỞI TẠO ---------------- */
  async function manual() {
    if (!online()) { toast('Cần kết nối Apps Script (2 chiều) để lưu / lấy ảnh online.', true); return; }
    Y.errUntil = 0; Y.pulled = false; await run();
    toast(Y.lastError ? 'Lỗi lưu online: ' + Y.lastError : 'Đã đồng bộ ảnh & trạng thái phiếu với Google Drive.', !!Y.lastError);
  }
  const syncNow = async () => { Y.errUntil = 0; Y.pulled = false; await run(); return !Y.lastError; };
  // Thử kết nối nơi lưu đang chọn (dùng ở Cài đặt): trả { ok, count } hoặc { ok:false, error }
  async function testConnection() {
    if (cfg.mode === 'off') return { ok: false, error: 'Đang chọn «Chỉ lưu trên máy này».' };
    if (!online()) return { ok: false, error: cfg.mode === 'gas2' ? 'URL chưa đúng dạng https://script.google.com/macros/s/…/exec' : 'Chưa kết nối Google Sheet bằng Apps Script 2 chiều.' };
    try { const r = await call({ action: 'scanList' }); return { ok: true, count: (r.list || []).length }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  S.on('sheetDone', (d) => touch(d.scanId));          // phiếu vừa quét xong -> lên Drive
  S.on('itemsChanged', (d) => touch(d.scanId));       // đối chiếu / chỉnh sửa -> cập nhật meta
  S.on('queueFinished', () => run());
  const btn = document.getElementById('btnScanCloud'); if (btn) btn.addEventListener('click', manual);
  setInterval(run, 20000);                            // kết nối Sheet có thể xong SAU khi trang nạp -> kiểm tra định kỳ
  setTimeout(run, 3000);

  return { run, pull, touch, ensureBlobs, refreshStatus, call, online, config: () => ({ ...cfg }), setConfig, validUrl, syncNow, testConnection, isGone: (id) => Y.gone.has(id), markGone: (id) => Y.gone.add(id) };
})();
window.ScanSync = ScanSync;
