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

   ĐA THIẾT BỊ (bản mới):
     • CẤU HÌNH 1 LẦN: máy mới tự nhận URL lưu trữ từ (a) «link thiết lập» dạng  ...#scancfg=…  (tạo ở Cài đặt → Lưu trữ) hoặc
       (b) file scan-config.json đặt cạnh index.html trong repo. Nhờ đó máy mới kết nối được Drive → lấy được ảnh + kho khóa Gemini.
     • TẢI THÔNG MINH: dữ liệu NHẸ (meta: biển số, đối chiếu) kéo trước; ẢNH NẶNG chỉ tải khi người dùng BẬT «Tự động tải ảnh»
       hoặc bấm «Tải ảnh về máy ngay» (mặc định TẮT — tiết kiệm data / bộ nhớ điện thoại). Có tùy chọn «chỉ Wi-Fi» + số phiếu mới nhất.
     • ĐỒNG BỘ 2 CHIỀU: kéo định kỳ (tăng dần, rất nhẹ) + GỘP bản online TRƯỚC khi ghi đè → từng mục có updatedAt mới hơn thì thắng (last-write-wins theo mục).
     • XEM ẢNH NHANH: 2 mặt tải song song; tải nền dùng scanGetBatch (nhiều ảnh / 1 request); ảnh đã tải được nhớ trong máy.
   ========================================================================= */
const ScanSync = (() => {
  'use strict';
  const S = ScanApp, DB = S.db, ST_SCANS = DB.ST_SCANS, ST_ITEMS = DB.ST_ITEMS;
  const MAX_B64 = 18e6;                 // ảnh sau nén ≤ ~3,5MB nên base64 hiếm khi vượt; chặn file quá lớn để khỏi treo request
  const RETRY_MS = 60000;               // gặp lỗi: nghỉ 1 phút rồi thử lại
  const PULL_EVERY = 120000;            // kéo thay đổi từ Drive mỗi 2 phút (tăng dần nên rất nhẹ) — để tab/máy khác thấy nhau
  const PASS_KEY = 'vehicleScanVaultPassV1';   // mật khẩu kho khóa (trùng với scan-store.js) — link thiết lập có thể kèm
  const Y = { busy: false, pulled: false, pullAt: 0, since: 0, fullAt: 0, batchOk: true, errUntil: 0, lastError: '', touched: new Set(), timer: null, cur: '', phase: '', gone: new Set() };
  // Trạng thái tải ẢNH NỀN (prefetch): dirty = có phiếu mới cần xem lại; checkedAt/errUntil để không quét liên tục
  const P = { busy: false, stop: false, done: 0, total: 0, bytes: 0, note: '', error: '', dirty: true, checkedAt: 0, errUntil: 0 };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // MỐC «since» được NHỚ TRÊN MÁY: mở lại trang chỉ hỏi Drive các phiếu đổi sau mốc (rất nhanh) thay vì liệt kê lại cả kho.
  // Cứ 24 giờ (hoặc khi đổi nơi lưu / bấm «Đồng bộ ngay») lại liệt kê ĐỦ 1 lần để bắt phiếu sót.
  const SINCE_KEY = 'vehicleScanSinceV1', FULL_LIST_EVERY = 24 * 3600e3;
  function resetPull(full) {
    Y.pulled = false; Y.since = 0;
    if (full) { Y.fullAt = 0; try { localStorage.removeItem(SINCE_KEY); } catch (e) { /* bỏ qua */ } }
  }
  function loadSince() {
    try { const j = JSON.parse(localStorage.getItem(SINCE_KEY) || 'null'); if (j && j.url === storeUrl() && j.since > 0 && j.fullAt && Date.now() - j.fullAt < FULL_LIST_EVERY) return j; } catch (e) { /* bỏ qua */ }
    return null;
  }
  function saveSince() { try { localStorage.setItem(SINCE_KEY, JSON.stringify({ url: storeUrl(), since: Y.since, fullAt: Y.fullAt })); } catch (e) { /* bỏ qua */ } }
  // Đếm phiếu trên máy; lỗi -> 0 (an toàn: sẽ liệt kê đủ)
  const countScans = async () => { try { return (await DB.tx(ST_SCANS, 'readonly', os => os.count())) || 0; } catch (e) { return 0; } };

  /* ---- NƠI LƯU ẢNH (chọn ở Cài đặt): nhớ trên máy; ảnh luôn lưu IndexedDB trước, "nơi lưu online" chỉ là bản sao dùng chung ---- */
  const STORE_KEY = 'vehicleScanStoreV1';
  // autoFree: tự xóa ảnh trên máy sau khi đã lên Drive (mặc định TẮT)
  // autoImages: tự tải ẢNH về máy chạy ngầm (mặc định TẮT — người dùng phải chủ động bật); imgNet: 'wifi' | 'any'; prefetchLimit: số phiếu mới nhất tải sẵn (0 = tất cả)
  // src: cấu hình đến từ đâu — 'user' (tự chỉnh ở Cài đặt) | 'link' (link thiết lập) | 'file' (scan-config.json) | '' (mặc định). 'file' chỉ được ghi đè nếu người dùng chưa tự chỉnh.
  const cfg = { mode: 'gas', url2: '', autoFree: false, autoImages: false, imgNet: 'wifi', prefetchLimit: 300, src: '' };
  let hadLocal = false;
  try { const raw = localStorage.getItem(STORE_KEY); if (raw) { hadLocal = true; Object.assign(cfg, JSON.parse(raw)); } } catch (e) { /* bỏ qua */ }
  const validUrl = (u) => /^https:\/\/script\.google(usercontent)?\.com\/.+\/exec/.test(String(u || '').trim());
  function setConfig(c) {
    Object.assign(cfg, c, { src: (c && c.src) || 'user' });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* bỏ qua */ }
    // đổi nơi lưu -> danh sách «đã xóa» của nơi cũ không còn đúng, kéo lại TOÀN BỘ (since = 0) từ nơi mới
    resetPull(true); Y.errUntil = 0; Y.lastError = ''; Y.gone = new Set(); P.dirty = true; P.errUntil = 0;
    refreshStatus();
  }
  // URL Apps Script dùng để lưu ảnh: 'gas' = cái đang nối Sheet; 'gas2' = cái riêng; 'off' = không dùng
  const urlOf = (c) => c.mode === 'gas2' ? String(c.url2 || '').trim() : (c.mode === 'gas' ? ((typeof state !== 'undefined' && state.gasUrl) || '') : '');
  const onlineOf = (c) => c.mode === 'gas2' ? validUrl(c.url2) : (c.mode === 'gas' && typeof isWriteConnected === 'function' && isWriteConnected());
  const storeUrl = () => urlOf(cfg);
  const online = () => onlineOf(cfg);
  async function callWith(c, payload) {
    const r = await gasRequest(urlOf(c), payload);
    if (!r || r.ok === false) throw new Error((r && r.error) || 'Apps Script chưa hỗ trợ lưu ảnh online (dán đúng file Apps Script rồi Deploy → Phiên bản mới).');
    return r;
  }
  const call = (payload) => callWith(cfg, payload);
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
    let total = 0, up = 0, withImg = 0;
    try { await forEachScan(r => { if (r.status === 'done' && !r.isTest) { total++; if (r.cloud && r.cloud.frontId) up++; if (r.frontBlob) withImg++; } return null; }); } catch (e) { /* bỏ qua */ }
    let msg;
    const imgTxt = total ? ` · 🖼 ${withImg}/${total} có ảnh trên máy` : '';
    if (cfg.mode === 'off') msg = total ? `💾 ${total} phiếu chỉ lưu trên máy này (đã tắt lưu online)` : '';
    else if (!online()) msg = total ? `☁️ ${up}/${total} phiếu đã lưu online · ${cfg.mode === 'gas2' ? 'chưa nhập URL Apps Script lưu ảnh' : 'chưa kết nối Apps Script 2 chiều'}` : '';
    else if (Y.busy) msg = `☁️ ${Y.phase || 'Đang đồng bộ ảnh' + (Y.cur ? ' (' + Y.cur + ')' : '')}… ${up}/${total}`;
    else if (P.busy) msg = `🖼 Đang tải ảnh về máy… ${P.done}/${P.total} phiếu`;
    else if (Y.lastError) msg = `⚠ Lỗi lưu online: ${Y.lastError}`;
    else msg = total ? `☁️ ${up}/${total} phiếu đã lưu online${imgTxt}` : '';
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
  // GỘP TRƯỚC KHI GHI ĐÈ (last-write-wins theo từng mục): nếu meta online MỚI hơn bản ta đã biết (máy/tab khác vừa sửa)
  // thì kéo về gộp trước, để lần ghi sau không làm mất thay đổi của máy kia. Lỗi/Apps Script cũ -> bỏ qua, vẫn đẩy bình thường.
  async function mergeRemoteFirst(scanId, rec) {
    if (!rec.cloud || !rec.cloud.metaAt) return false;      // phiếu mới tinh chưa từng lên Drive -> không có gì để gộp
    try {
      const r = await call({ action: 'scanMetaBatch', ids: [scanId] });
      const up = r.updated && r.updated[scanId], txt = r.metas && r.metas[scanId];
      if (txt && up && up > (rec.cloud.metaAt || 0)) {
        const plates = await mergeMeta(JSON.parse(txt), up);
        if (window.ScanReview && ScanReview.afterRemoteMerge) await ScanReview.afterRemoteMerge(plates);
        return true;
      }
    } catch (e) { console.warn('[scan-sync] gộp trước khi ghi lỗi (bỏ qua)', scanId, e); }
    return false;
  }
  // Đẩy 1 phiếu: ảnh chưa lên thì lên trước, rồi ghi meta (luôn ghi để mang trạng thái đối chiếu mới nhất)
  async function pushScan(scanId) {
    let rec = await DB.dbGet(ST_SCANS, scanId);
    if (!rec || rec.status !== 'done' || rec.isTest) return;
    if (Y.gone.has(scanId)) return;           // đã bị xóa online (ở máy khác) -> KHÔNG đẩy lại, tránh "sống dậy"
    if (await mergeRemoteFirst(scanId, rec)) { rec = await DB.dbGet(ST_SCANS, scanId); if (!rec) return; }
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

  // Chạy 1 lượt: kéo dữ liệu NHẸ (lần đầu + định kỳ) -> đẩy mọi phiếu còn thiếu ảnh + các phiếu có thay đổi -> (nếu được phép) tải ảnh nền
  // Web Locks: các tab cùng trình duyệt dùng chung IndexedDB nên chỉ cần 1 tab làm việc đồng bộ. wait=true: chờ tới lượt (thao tác thủ công).
  const withLock = (name, fn, wait) => (navigator.locks && navigator.locks.request)
    ? navigator.locks.request(name, wait ? {} : { ifAvailable: true }, (l) => l ? fn() : undefined) : fn();
  function run(wait) { return withLock('scanSync.run', runOnce, wait === true); }
  async function runOnce() {
    await ready;                                              // chờ nạp xong cấu hình từ link / scan-config.json
    if (Y.busy || !online() || Date.now() < Y.errUntil) { refreshStatus(); return; }
    Y.busy = true; refreshStatus();
    let cur = '';
    try {
      if (!Y.pulled || Date.now() - Y.pullAt > PULL_EVERY) { await pull(); Y.pulled = true; Y.pullAt = Date.now(); }
      (await forEachScan(r => (hasBlobs(r) && !blobsUp(r)) ? r.id : null)).forEach(id => Y.touched.add(id));
      while (Y.touched.size) {
        cur = Y.touched.values().next().value; Y.cur = String(cur).slice(0, 8); Y.phase = '';
        await pushScan(cur); Y.touched.delete(cur); refreshStatus();
      }
      Y.lastError = ''; Y.errUntil = 0;
      // Tự xóa ảnh trên máy (nếu bật): chỉ phiếu đã lên Drive + kiểm tra khớp dung lượng, và giữ lại phiếu mới quét trong 1 giờ
      if (cfg.autoFree) { try { await freeLocal({ keepRecentMs: 3600e3 }); } catch (e) { console.warn('[scan-sync] tự giải phóng lỗi', e); } }
    } catch (e) {
      Y.lastError = String((e && e.message) || e).slice(0, 160); Y.errUntil = Date.now() + RETRY_MS;
      console.warn('[scan-sync]', e);
    } finally { Y.busy = false; Y.cur = ''; Y.phase = ''; refreshStatus(); }
    // ẢNH NẶNG tải SAU CÙNG và chạy nền (không giữ khóa Y.busy -> không chặn việc kéo/đẩy dữ liệu nhẹ). Chỉ chạy khi người dùng đã bật.
    if (!Y.lastError) prefetchImages().catch(e => console.warn('[scan-sync] tải ảnh nền lỗi', e));
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
    // Lần đầu/đổi nơi lưu: since = 0 (liệt kê hết). Các lần sau chỉ hỏi phiếu đổi SAU mốc đã biết (Apps Script mới hỗ trợ; bản cũ bỏ qua tham số, vẫn đúng).
    Y.phase = 'Đang lấy danh sách phiếu'; refreshStatus();
    let since = 0;
    if (Y.since > 0 && Y.fullAt && Date.now() - Y.fullAt < FULL_LIST_EVERY) since = Y.since;           // đang chạy: tăng dần
    else if (!Y.pulled) { const sv = loadSince(); if (sv && await countScans() > 0) { since = sv.since; Y.fullAt = sv.fullAt; } }   // MỞ LẠI TRANG: dùng mốc đã nhớ (máy còn dữ liệu)
    const lst = await call({ action: 'scanList', since });
    const list = lst.list, gone = lst.gone;
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
    // Dữ liệu NHẸ (meta) kéo trước: 2 nhóm × 15 phiếu chạy song song; ghi IndexedDB tuần tự
    for (let i = 0; i < need.length; i += 30) {
      const group = need.slice(i, i + 30), halves = [group.slice(0, 15), group.slice(15)].filter(h => h.length);
      Y.phase = `Đang tải dữ liệu phiếu ${Math.min(i + 30, need.length)}/${need.length}`; refreshStatus();
      const res = await Promise.all(halves.map(h => call({ action: 'scanMetaBatch', ids: h.map(x => x.scanId) })));
      halves.forEach(() => { /* giữ thứ tự */ });
      for (let k = 0; k < halves.length; k++) {
        const metas = res[k].metas;
        for (const x of halves[k]) {
          if (!metas || !metas[x.scanId]) continue;
          try { plates.push(...await mergeMeta(JSON.parse(metas[x.scanId]), x.updated)); } catch (e) { console.warn('[scan-sync] meta lỗi', x.scanId, e); }
        }
      }
    }
    if (need.length && window.ScanReview && ScanReview.afterRemoteMerge) await ScanReview.afterRemoteMerge(plates);
    if (lst.serverNow) {
      Y.since = Math.max(0, lst.serverNow - 120000);
      if (!lst.incremental) Y.fullAt = Date.now();                    // lượt này server đã liệt kê ĐỦ
      saveSince();
    }   // lùi 2 phút phòng lệch giờ; mốc lấy theo đồng hồ SERVER
    if (need.length) P.dirty = true;                                    // có phiếu mới -> xem lại danh sách ảnh cần tải
    Y.phase = '';
    return need.length;
  }

  /* ---------------- TẢI ẢNH (khi mở xem + tải nền) ---------------- */
  const inflight = new Map();

  // Tải các file ảnh. pairs = [{id, side}]. parallel=true: mỗi file 1 request, chạy SONG SONG (xem ảnh: nhanh nhất cho 1–2 file);
  // parallel=false: gộp scanGetBatch (tải nền nhiều phiếu: ít request hơn). Apps Script cũ chưa có scanGetBatch -> tự lùi về từng file.
  // Trả { map: Map('id|side' -> {blob, mime}), error: thông báo lỗi đầu tiên (nếu có file không tải được) }
  async function fetchFiles(pairs, parallel) {
    const map = new Map(); let error = '', rest = pairs.slice();
    if (!parallel && Y.batchOk && pairs.length > 1) {
      try {
        while (rest.length) {
          const r = await call({ action: 'scanGetBatch', items: rest.map(p => ({ scanId: p.id, kind: p.side })) });
          const files = r.files || []; if (!files.length) break;
          const seen = new Set();
          for (const f of files) {
            seen.add(f.scanId + '|' + f.kind);
            if (f.ok && f.b64) map.set(f.scanId + '|' + f.kind, { blob: await b64ToBlob(f.b64, f.mime), mime: f.mime });
            else if (!error) error = f.error || 'Không tải được ảnh';
          }
          rest = rest.filter(p => !seen.has(p.id + '|' + p.side));     // phần server chưa kịp xử lý (vượt giới hạn dung lượng 1 lượt) -> xin tiếp
        }
        return { map, error };
      } catch (e) { if (/không hỗ trợ/i.test(String((e && e.message) || e))) Y.batchOk = false; else throw e; }
    }
    const res = await Promise.allSettled(rest.map(p => call({ action: 'scanGet', scanId: p.id, kind: p.side })));
    for (let i = 0; i < rest.length; i++) {
      const x = res[i];
      if (x.status === 'fulfilled') map.set(rest[i].id + '|' + rest[i].side, { blob: await b64ToBlob(x.value.b64, x.value.mime), mime: x.value.mime });
      else if (!error) error = String((x.reason && x.reason.message) || x.reason);
    }
    return { map, error };
  }
  // Ghi ảnh vào bản ghi MỚI NHẤT trong IndexedDB (đọc lại trước khi ghi để không đè thay đổi khác; phiếu đã bị xóa thì bỏ qua)
  async function storeBlobs(id, got) {
    const rec = await DB.dbGet(ST_SCANS, id); if (!rec || Y.gone.has(id)) return null;
    for (const side of ['front', 'back']) {
      const g = got[side];
      if (g && !rec[side + 'Blob']) { rec[side + 'Blob'] = g.blob; rec[side + 'Mime'] = g.mime || rec[side + 'Mime']; }
    }
    if (rec.cloud) delete rec.cloud.imgTry;
    await DB.dbPut(ST_SCANS, rec); return rec;
  }
  // Bản ghi chưa có ảnh nhưng đã lưu online -> tải về, nhớ trong IndexedDB. Lỗi thì gắn rec._cloudMsg để giao diện báo.
  // BẢN MỚI: 2 mặt tải song song (trước đây tuần tự → chậm gấp đôi); lần xem sau đọc thẳng từ máy (tức thì).
  function ensureBlobs(rec) {
    if (!rec || !rec.cloud) return Promise.resolve(rec);
    if (inflight.has(rec.id)) return inflight.get(rec.id);
    const p = (async () => {
      rec._cloudMsg = '';
      const need = ['front', 'back'].filter(sd => !rec[sd + 'Blob'] && rec.cloud[sd + 'Id']);
      if (!need.length) return rec;
      if (!online()) { rec._cloudMsg = 'Ảnh phiếu đang lưu online — cần kết nối Apps Script (2 chiều) để tải về máy này.'; return rec; }
      try {
        const { map, error } = await fetchFiles(need.map(sd => ({ id: rec.id, side: sd })), true);
        const got = {};
        need.forEach(sd => { const g = map.get(rec.id + '|' + sd); if (g) { got[sd] = g; rec[sd + 'Blob'] = g.blob; rec[sd + 'Mime'] = g.mime || rec[sd + 'Mime']; } });
        if (got.front || got.back) await storeBlobs(rec.id, got);
        if (need.some(sd => !got[sd])) rec._cloudMsg = 'Không tải được ảnh từ online: ' + (error || 'không rõ lỗi');
      } catch (e) { rec._cloudMsg = 'Không tải được ảnh từ online: ' + (e.message || e); }
      return rec;
    })().finally(() => inflight.delete(rec.id));
    inflight.set(rec.id, p);
    return p;
  }

  /* ---------------- TẢI ẢNH NỀN (do NGƯỜI DÙNG cho phép) ---------------- */
  const isMobileUa = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  // Trả '' nếu ĐƯỢC tự tải ảnh; ngược lại trả lý do chặn. Mặc định tắt (cfg.autoImages = false).
  function imagesBlockedReason() {
    if (!cfg.autoImages) return 'off';
    if (cfg.autoFree) return 'autoFree';                    // «tự xóa ảnh» và «tự tải ảnh» ngược nhau -> không chạy cùng lúc
    if (cfg.mode === 'off' || !online()) return 'offline';
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c && c.saveData) return 'saveData';                 // người dùng bật «Tiết kiệm dữ liệu» của trình duyệt
    if (cfg.imgNet === 'wifi') {
      const t = c && c.type;                                // chỉ Android Chrome cho biết loại mạng; iOS/Firefox thì không
      if (t === 'none') return 'offline';
      if (!(t === 'wifi' || t === 'ethernet') && (t || isMobileUa())) return 'notWifi';   // di động / không xác định được trên điện thoại -> chặn cho an toàn
    }
    return '';
  }
  // Danh sách phiếu đã lưu online nhưng thiếu ảnh trên máy, MỚI NHẤT trước. ignoreTry: bỏ qua dấu «vừa thử lỗi».
  async function pendingImageIds(limit, ignoreTry) {
    const rows = await forEachScan(r => {
      if (r.status !== 'done' || r.isTest || !r.cloud || Y.gone.has(r.id)) return null;
      if (!((r.cloud.frontId && !r.frontBlob) || (r.cloud.backId && !r.backBlob))) return null;
      if (!ignoreTry && r.cloud.imgTry && Date.now() - r.cloud.imgTry < 6 * 3600e3) return null;   // file lỗi/mất trên Drive: 6 giờ sau mới thử lại
      return { id: r.id, t: new Date(r.timestamp).getTime() || 0 };
    });
    rows.sort((a, b) => b.t - a.t);
    return (limit > 0 ? rows.slice(0, limit) : rows).map(x => x.id);
  }
  // Số phiếu thiếu ảnh + dung lượng ước tính trên Drive (để hỏi người dùng trước khi tải thủ công)
  async function pendingImages() {
    const ids = await pendingImageIds(0, true);
    let bytes = 0, known = false;
    if (ids.length && online()) {
      try {
        const inv = await call({ action: 'scanInventory' }), set = new Set(ids);
        (inv.files || []).forEach(f => { if (set.has(f.scanId) && (f.kind === 'front' || f.kind === 'back')) bytes += f.size || 0; });
        known = true;
      } catch (e) { /* không ước tính được thì thôi */ }
    }
    return { n: ids.length, bytes, known };
  }
  async function markTry(id) { const rec = await DB.dbGet(ST_SCANS, id); if (rec && rec.cloud) { rec.cloud.imgTry = Date.now(); await DB.dbPut(ST_SCANS, rec); } }
  // Tải ảnh về máy, mới nhất trước, mỗi lượt 3 phiếu (gộp 1 request). opts.force = người dùng bấm «Tải ngay» (bỏ qua cài đặt tự động/Wi-Fi).
  function prefetchImages(opts) {
    // «Tải ngay» do người dùng bấm thì chạy luôn; tải tự động chỉ chạy ở 1 tab (tránh 2 tab cùng tải 1 ảnh)
    return (opts && opts.force) ? prefetchOnce(opts) : withLock('scanSync.prefetch', () => prefetchOnce(opts)).then(r => r || P);
  }
  async function prefetchOnce(opts) {
    opts = opts || {};
    if (P.busy) return P;
    if (!opts.force) {
      if (imagesBlockedReason()) { P.note = imagesBlockedReason(); return P; }
      if (Date.now() < P.errUntil) return P;
      if (!P.dirty && Date.now() - P.checkedAt < 300000) return P;           // không quét lại danh sách quá dày
    } else if (!online()) throw new Error('Cần kết nối nơi lưu online để tải ảnh về máy.');
    P.busy = true; P.stop = false; P.done = 0; P.total = 0; P.bytes = 0; P.note = ''; P.error = ''; P.checkedAt = Date.now(); P.dirty = false;
    try {
      const ids = await pendingImageIds(opts.force ? 0 : cfg.prefetchLimit, !!opts.force);
      P.total = ids.length; refreshStatus();
      for (let i = 0; i < ids.length; i += 3) {
        if (P.stop) { P.note = 'stopped'; break; }
        if (!opts.force && imagesBlockedReason()) { P.note = 'paused'; P.dirty = true; break; }   // đổi mạng / tắt tùy chọn giữa chừng -> dừng
        const chunk = ids.slice(i, i + 3).filter(id => !inflight.has(id) && !Y.gone.has(id));   // phiếu đang được mở xem thì thôi
        const recs = (await Promise.all(chunk.map(id => DB.dbGet(ST_SCANS, id)))).filter(Boolean), pairs = [];
        recs.forEach(r => ['front', 'back'].forEach(sd => { if (!r[sd + 'Blob'] && r.cloud && r.cloud[sd + 'Id']) pairs.push({ id: r.id, side: sd }); }));
        if (pairs.length) {
          const { map } = await fetchFiles(pairs, false);
          for (const id of chunk) {
            const got = {};
            ['front', 'back'].forEach(sd => { const g = map.get(id + '|' + sd); if (g) { got[sd] = g; P.bytes += g.blob.size; } });
            if (got.front || got.back) await storeBlobs(id, got);
          }
          for (const id of new Set(pairs.filter(p => !map.has(p.id + '|' + p.side)).map(p => p.id))) await markTry(id);   // file mất/lỗi: đánh dấu để khỏi thử lại liên tục
        }
        P.done = Math.min(ids.length, i + 3); refreshStatus();
        await sleep(250);                                        // nhả CPU/mạng cho giao diện, đỡ nóng máy điện thoại
      }
      if (!P.note) P.note = 'done';
    } catch (e) {
      P.error = String((e && e.message) || e).slice(0, 160); P.note = 'error'; P.errUntil = Date.now() + RETRY_MS; P.dirty = true;
      if (opts.force) throw e;
    } finally { P.busy = false; refreshStatus(); }
    return P;
  }
  const prefetchState = () => ({ busy: P.busy, done: P.done, total: P.total, bytes: P.bytes, note: P.note, error: P.error, blocked: imagesBlockedReason() });

  /* ---------------- KHỞI TẠO ---------------- */
  async function manual() {
    if (!online()) { toast('Cần kết nối Apps Script (2 chiều) để lưu / lấy ảnh online.', true); return; }
    Y.errUntil = 0; resetPull(true); P.dirty = true; await run(true);
    toast(Y.lastError ? 'Lỗi lưu online: ' + Y.lastError : 'Đã đồng bộ ảnh & trạng thái phiếu với Google Drive.', !!Y.lastError);
  }
  const syncNow = async () => { Y.errUntil = 0; resetPull(true); P.dirty = true; await run(true); return !Y.lastError; };
  // Thử kết nối nơi lưu (dùng ở Cài đặt). override = lựa chọn đang hiện trên màn hình (chưa Lưu) -> không đụng cấu hình thật
  async function testConnection(override) {
    const c = Object.assign({}, cfg, override || {});
    if (c.mode === 'off') return { ok: false, error: 'Đang chọn «Chỉ lưu trên máy này».' };
    if (!onlineOf(c)) return { ok: false, error: c.mode === 'gas2' ? 'URL chưa đúng dạng https://script.google.com/macros/s/…/exec' : 'Chưa kết nối Google Sheet bằng Apps Script 2 chiều.' };
    try { const r = await callWith(c, { action: 'scanList' }); return { ok: true, count: (r.list || []).length }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  /* ---------------- GIẢI PHÓNG BỘ NHỚ MÁY SAU KHI ĐÃ LÊN DRIVE ---------------- */
  // Xóa ảnh (blob) trên máy của các phiếu ĐÃ LÊN DRIVE. An toàn 3 lớp: (1) hỏi lại Drive bằng scanInventory, ảnh + meta phải có thật và dung lượng khớp;
  // (2) bỏ qua phiếu còn thay đổi chưa đẩy; (3) dữ liệu đối chiếu vẫn giữ trên máy — chỉ bỏ ảnh. Mở xem lại sẽ tự tải từ Drive (ensureBlobs).
  // opts: { dryRun, keepRecentMs } -> trả { n phiếu, bytes giải phóng, skipped phiếu bỏ qua }
  async function freeLocal(opts) {
    opts = opts || {};
    if (!online()) throw new Error('Cần kết nối nơi lưu online để xác nhận ảnh đã lên Drive.');
    const inv = await call({ action: 'scanInventory' }), size = new Map();
    (inv.files || []).forEach(f => size.set(f.scanId + '|' + f.kind, f.size || 0));
    const ids = await forEachScan(r => (r.status === 'done' && !r.isTest && (r.frontBlob || r.backBlob) && r.cloud && r.cloud.frontId) ? r.id : null);   // gồm cả ảnh đã tải về từ máy khác (frontId = 'remote'): vẫn được kiểm tra dung lượng với Drive bên dưới
    let n = 0, bytes = 0, skipped = 0;
    for (const id of ids) {
      const rec = await DB.dbGet(ST_SCANS, id); if (!rec) continue;
      const t = new Date(rec.timestamp).getTime();
      const tooNew = opts.keepRecentMs && isFinite(t) && Date.now() - t < opts.keepRecentMs;
      const sides = ['front', 'back'].filter(sd => rec[sd + 'Blob']);
      // mỗi mặt đang có ảnh phải: có id thật trên Drive + file tồn tại + dung lượng online ≥ 98% bản trên máy
      const good = !tooNew && !Y.touched.has(id) && size.has(id + '|meta') && sides.every(sd => {
        const cid = rec.cloud[sd + 'Id'], on = size.get(id + '|' + sd) || 0;
        return cid && on > 0 && on >= rec[sd + 'Blob'].size * 0.98;
      });
      if (!good) { skipped++; continue; }
      if (!opts.dryRun) {
        sides.forEach(sd => { bytes += rec[sd + 'Blob'].size; rec[sd + 'Blob'] = null; });
        await DB.dbPut(ST_SCANS, rec);
      } else sides.forEach(sd => { bytes += rec[sd + 'Blob'].size; });
      n++;
    }
    refreshStatus();
    return { n, bytes, skipped };
  }
  // Dung lượng ảnh còn trên máy của phiếu ĐÃ lên Drive (để hiện «có thể giải phóng ~X MB»)
  async function localImageBytes() {
    let b = 0, n = 0;
    await forEachScan(r => { if (r.status === 'done' && !r.isTest && r.cloud && r.cloud.frontId && (r.frontBlob || r.backBlob)) { n++; b += (r.frontBlob ? r.frontBlob.size : 0) + (r.backBlob ? r.backBlob.size : 0); } return null; });
    return { n, bytes: b };
  }

  /* ---------------- CẤU HÌNH 1 LẦN CHO MỌI MÁY ---------------- */
  // Vì sao cần: URL Apps Script chỉ nằm trong localStorage của TỪNG trình duyệt, nên máy/profile mới không kết nối được Drive
  // (→ không có ảnh, không lấy được kho khóa Gemini). Hai cách để máy mới tự nhận cấu hình:
  //  (a) «Link thiết lập» ...#scancfg=<base64url JSON {u: url, p?: mật khẩu kho khóa}>: mở link 1 lần là xong, phần #… không gửi lên server và bị xóa khỏi thanh địa chỉ.
  //  (b) File scan-config.json cạnh index.html: {"url": "https://script.google.com/macros/s/…/exec"} — chỉ áp cho máy CHƯA tự chỉnh Cài đặt.
  const toast_ = (m, e) => setTimeout(() => { try { if (typeof toast === 'function') toast(m, !!e); } catch (x) { /* bỏ qua */ } }, 1500);
  function importFromHash() {
    const m = /[#&]scancfg=([^&]+)/.exec(location.hash || ''); if (!m) return;
    try {
      const raw = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
      const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0))));
      if (!validUrl(j.u)) throw new Error('URL trong link không hợp lệ');
      setConfig({ mode: 'gas2', url2: String(j.u).trim(), src: 'link' });
      if (typeof j.p === 'string' && j.p.length >= 6) { try { localStorage.setItem(PASS_KEY, j.p); } catch (e) { /* bỏ qua */ } }   // kèm mật khẩu -> kho khóa Gemini tự khôi phục
      toast_('Đã nạp cấu hình lưu trữ từ link thiết lập' + (j.p ? ' (kèm mật khẩu kho khóa)' : '') + '. Ảnh & dữ liệu sẽ tự đồng bộ.');
    } catch (e) { console.warn('[scan-sync] link thiết lập lỗi', e); toast_('Link thiết lập không hợp lệ.', true); }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* bỏ qua */ }   // xóa phần #… (có thể chứa mật khẩu) khỏi thanh địa chỉ
  }
  async function loadRemoteConfig() {
    if (cfg.src === 'user' || cfg.src === 'link') return;       // người dùng tự chọn / đã dùng link -> không ghi đè
    if (hadLocal && !cfg.src) return;                           // cấu hình cũ có sẵn từ trước (không rõ nguồn) -> coi như của người dùng
    try {
      const res = await fetch(new URL('scan-config.json', document.baseURI).href, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json(); if (!validUrl(j.url)) return;
      const next = { mode: 'gas2', url2: String(j.url).trim() };
      if (typeof j.autoImages === 'boolean') next.autoImages = j.autoImages;
      if (j.imgNet === 'wifi' || j.imgNet === 'any') next.imgNet = j.imgNet;
      if (Number.isFinite(j.prefetchLimit)) next.prefetchLimit = Math.max(0, j.prefetchLimit | 0);
      if (Object.keys(next).every(k => cfg[k] === next[k]) && cfg.src === 'file') return;   // không đổi -> khỏi reset đồng bộ
      const first = !cfg.src; setConfig({ ...next, src: 'file' });
      if (first) toast_('Đã nạp cấu hình lưu trữ từ scan-config.json — ảnh & dữ liệu sẽ tự đồng bộ.');
    } catch (e) { /* không có file / lỗi mạng: bỏ qua, dùng cấu hình trên máy */ }
  }
  // Tạo link thiết lập cho máy khác (dùng URL đang dùng; withPass: kèm mật khẩu kho khóa đang ghi nhớ — chỉ gửi cho chính mình!)
  function makeSetupLink(withPass, passOverride) {
    const u = urlOf(cfg).trim(); if (!validUrl(u)) throw new Error('Chưa có URL Apps Script hợp lệ để chia sẻ.');
    const o = { u }; if (withPass) { const p = passOverride || localStorage.getItem(PASS_KEY); if (p) o.p = p; }
    const b = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { link: location.href.split('#')[0] + '#scancfg=' + b, withPass: !!o.p };
  }
  importFromHash();                                              // đồng bộ, chạy NGAY khi nạp (trước mọi lần đồng bộ)
  const ready = loadRemoteConfig();
  // Tab khác (cùng trình duyệt) vừa đổi Cài đặt lưu trữ -> nạp lại cấu hình ở tab này, khỏi phải F5
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE_KEY || !e.newValue) return;
    try { Object.assign(cfg, JSON.parse(e.newValue)); resetPull(true); Y.errUntil = 0; Y.lastError = ''; Y.gone = new Set(); P.dirty = true; P.errUntil = 0; refreshStatus(); run(); } catch (x) { /* bỏ qua */ }
  });

  S.on('sheetDone', (d) => touch(d.scanId));          // phiếu vừa quét xong -> lên Drive
  S.on('itemsChanged', (d) => touch(d.scanId));       // đối chiếu / chỉnh sửa -> cập nhật meta
  S.on('queueFinished', () => run());
  const btn = document.getElementById('btnScanCloud'); if (btn) btn.addEventListener('click', manual);
  // Tự tiếp tục việc dang dở: có mạng trở lại / quay lại tab / mở lại trang -> bỏ thời gian chờ lỗi và chạy ngay
  const resume = () => { Y.errUntil = 0; P.errUntil = 0; run(); };   // quay lại tab -> run() sẽ kéo thay đổi mới nếu đã quá PULL_EVERY
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* bỏ qua */ }   // tránh trình duyệt tự dọn IndexedDB khi đầy bộ nhớ
  setInterval(run, 20000);                            // kết nối Sheet có thể xong SAU khi trang nạp -> kiểm tra định kỳ
  setTimeout(run, 3000);

  return { run, pull, touch, freeLocal, localImageBytes, ensureBlobs, refreshStatus, call, online, config: () => ({ ...cfg }), setConfig, validUrl, syncNow, testConnection, isGone: (id) => Y.gone.has(id), markGone: (id) => Y.gone.add(id),
    prefetchImages, pendingImages, pendingImageCount: async () => (await pendingImageIds(0, true)).length, prefetchState, stopPrefetch: () => { P.stop = true; }, makeSetupLink };
})();
window.ScanSync = ScanSync;
