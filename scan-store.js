/* =========================================================================
   scan-store.js — CÀI ĐẶT NƠI LƯU ẢNH + KHO KHÓA GEMINI DÙNG CHUNG + QUẢN LÝ KHO ẢNH
   1) Cài đặt: chọn nơi lưu online (Apps Script đang nối Sheet / Apps Script RIÊNG / chỉ trên máy), kiểm tra kết nối.
   2) Kho khóa: đẩy các Gemini key lên Drive ĐÃ MÃ HÓA bằng mật khẩu (AES-GCM, PBKDF2) để máy khác lấy về. Apps Script chỉ thấy bản mã.
   3) Kho ảnh: liệt kê phiếu (máy này + online), kiểm tra thiếu/mồ côi, sửa, xóa phiếu / xóa mặt 2 thừa / xóa cả danh sách theo nguồn.
   Nạp SAU scan-sync.js và scan-files.js.
   ========================================================================= */
const ScanStore = (() => {
  'use strict';
  const S = ScanApp, DB = S.db, Y = ScanSync;
  const ST_SCANS = DB.ST_SCANS, ST_ITEMS = DB.ST_ITEMS;
  const q = (sel) => document.querySelector(sel);
  const esc = (v) => escapeHtml(String(v == null ? '' : v));
  const fmtSize = (b) => !b ? '—' : (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const fmtTime = (t) => t ? new Date(t).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '';

  /* ====================================================================== */
  /* 1. CÀI ĐẶT NƠI LƯU                                                      */
  /* ====================================================================== */
  const setMsg = (id, html, isErr) => { const el = q(id); if (!el) return; el.innerHTML = html; el.classList.toggle('error-text', !!isErr); };

  const pickedMode = () => (document.querySelector('input[name="scanStoreMode"]:checked') || {}).value || 'gas';
  // Chỉ hiện/ẩn ô nhập URL theo lựa chọn ĐANG CHỌN trên màn hình (gọi mỗi khi bấm đổi radio).
  // LỖI CŨ: hàm này vừa gán lại radio theo cấu hình đã lưu vừa được gắn vào sự kiện 'change' -> bấm «Apps Script RIÊNG» bị ép về lựa chọn cũ.
  function toggleUrlRow() {
    const m = pickedMode();
    q('#scanStoreUrl2Row').classList.toggle('hidden', m !== 'gas2');
    const g = q('#scanStoreGuide'); if (g) g.classList.toggle('hidden', m !== 'gas2');
  }
  // Nạp cấu hình ĐÃ LƯU lên màn hình — chỉ gọi lúc khởi tạo / khi mở hộp thoại, KHÔNG gắn vào sự kiện change.
  function loadSettingsUi() {
    const c = Y.config();
    document.querySelectorAll('input[name="scanStoreMode"]').forEach(r => { r.disabled = false; r.checked = r.value === c.mode; });
    const u2 = q('#scanStoreUrl2'); if (u2) { u2.value = c.url2 || ''; u2.disabled = false; u2.readOnly = false; }
    const af = q('#scanStoreAutoFree'); if (af) af.checked = !!c.autoFree;
    const ai = q('#scanStoreAutoImages'); if (ai) ai.checked = !!c.autoImages;
    const nn = q('#scanStoreImgNet'); if (nn) nn.value = c.imgNet === 'any' ? 'any' : 'wifi';
    const lm = q('#scanStoreLimit'); if (lm) {
      const v = String(c.prefetchLimit == null ? 300 : c.prefetchLimit);
      if (![...lm.options].some(o => o.value === v)) lm.add(new Option(v + ' phiếu mới nhất', v));   // giá trị lạ (từ scan-config.json) vẫn hiển thị đúng
      lm.value = v;
    }
    toggleUrlRow(); refreshFreeInfo(); refreshPrefetchInfo();
  }

  // Đổi nơi lưu: các phiếu đã lên nơi cũ KHÔNG tự sang nơi mới -> nếu người dùng đồng ý thì xóa cờ "đã lên" để lần đồng bộ sau đẩy lại toàn bộ
  async function resetCloudFlags() {
    const db = await DB.openDb(), ids = [];
    await new Promise((res, rej) => {
      const req = db.transaction(ST_SCANS, 'readonly').objectStore(ST_SCANS).openCursor();
      req.onsuccess = () => { const c = req.result; if (!c) { res(); return; } const r = c.value; if (r.status === 'done' && !r.isTest && r.frontBlob && r.cloud) ids.push(r.id); c.continue(); };
      req.onerror = () => rej(req.error);
    });
    for (const id of ids) { const r = await DB.dbGet(ST_SCANS, id); if (r) { r.cloud = {}; await DB.dbPut(ST_SCANS, r); } }
    return ids.length;
  }

  async function saveSettings() {
    const mode = pickedMode(), url2 = (q('#scanStoreUrl2').value || '').trim(), autoFree = !!(q('#scanStoreAutoFree') || {}).checked;
    const autoImages = !!(q('#scanStoreAutoImages') || {}).checked, imgNet = (q('#scanStoreImgNet') || {}).value === 'any' ? 'any' : 'wifi';
    const lim = parseInt((q('#scanStoreLimit') || {}).value, 10), prefetchLimit = Number.isFinite(lim) && lim >= 0 ? lim : 300;
    if (mode === 'gas2' && !Y.validUrl(url2)) { setMsg('#scanStoreMsg', '❌ URL chưa đúng dạng <code>https://script.google.com/macros/s/…/exec</code> (phải kết thúc bằng <code>/exec</code>)', true); return; }
    const before = Y.config(), oldKey = before.mode + '|' + (before.mode === 'gas2' ? before.url2 : '');
    const newKey = mode + '|' + (mode === 'gas2' ? url2 : '');
    // «Tự xóa ảnh trên máy» và «Tự tải ảnh về máy» ngược nhau -> không cho bật cùng lúc
    if (autoFree && autoImages) { setMsg('#scanStoreMsg', '❌ Không bật cùng lúc «Tự xóa ảnh trên máy» và «Tự tải ảnh về máy» — hãy chọn 1 trong 2.', true); return; }
    Y.setConfig({ mode, url2, autoFree, autoImages, imgNet, prefetchLimit });
    if (window.ScanHub) ScanHub.pushNow();   // nơi lưu mới được đẩy lên «hub» -> máy / tab khác tự nhận, khỏi cài lại
    let msg = '✅ Đã lưu cách lưu trữ' + (mode !== 'off' ? ' (tự đồng bộ sang các máy khác).' : '.');
    // Đổi nơi lưu -> TỰ đẩy lại toàn bộ ảnh đang có trên máy sang nơi mới (không hỏi; ảnh ở nơi cũ không bị xóa)
    if (oldKey !== newKey && mode !== 'off') { const n = await resetCloudFlags(); msg += ` Đang tự đẩy ${n} phiếu sang nơi mới (chạy ngầm, không cần chờ).`; }
    else if (mode !== 'off') msg += ' Ảnh chưa lên Drive sẽ tự được đẩy lên.';
    setMsg('#scanStoreMsg', msg); Y.refreshStatus(); if (mode !== 'off') Y.run();
  }
  async function testSettings() {
    // Dùng đúng lựa chọn đang hiện trên màn hình (chưa cần bấm Lưu) — truyền thẳng vào testConnection, không đụng cấu hình đã lưu
    const mode = pickedMode(), url2 = (q('#scanStoreUrl2').value || '').trim();
    setMsg('#scanStoreMsg', '⏳ Đang kiểm tra…');
    const r = await Y.testConnection({ mode, url2 });
    setMsg('#scanStoreMsg', r.ok ? `✅ Kết nối được. Đang có ${r.count} phiếu online. Nhớ bấm «Lưu» để dùng.` : '❌ ' + esc(r.error) + (/Apps Script chưa hỗ trợ|scan|Action/i.test(r.error) ? '<br>Gợi ý: kiểm tra đã dán ĐÚNG file Apps Script và Triển khai → Phiên bản mới (xem hướng dẫn bên dưới).' : ''), !r.ok);
  }

  /* ---- Giải phóng bộ nhớ máy (xóa ảnh đã lên Drive) ---- */
  async function refreshFreeInfo() {
    const el = q('#scanFreeInfo'); if (!el) return;
    try { const i = await Y.localImageBytes(); el.textContent = i.n ? `Có thể giải phóng khoảng ${fmtSize(i.bytes)} (${i.n} phiếu đã lên Drive).` : 'Chưa có phiếu nào đã lên Drive còn ảnh trên máy.'; } catch (e) { el.textContent = ''; }
  }
  async function freeNow() {
    if (!Y.online()) { setMsg('#scanFreeMsg', '❌ Cần kết nối nơi lưu online để xác nhận ảnh đã lên Drive.', true); return; }
    setMsg('#scanFreeMsg', '⏳ Đang đối chiếu với Drive…');
    try {
      await Y.syncNow();                                          // đẩy nốt phần còn thiếu trước
      const dry = await Y.freeLocal({ dryRun: true });
      if (!dry.n) { setMsg('#scanFreeMsg', `Không có phiếu nào đủ điều kiện xóa${dry.skipped ? ` (${dry.skipped} phiếu chưa xác nhận được trên Drive — giữ lại cho an toàn)` : ''}.`); return; }
      if (!confirm(`Xóa ảnh trên máy của ${dry.n} phiếu (giải phóng ~${fmtSize(dry.bytes)})?\n\n• Chỉ xóa phiếu đã xác nhận có đủ ảnh trên Drive.\n• Dữ liệu đối chiếu vẫn giữ; mở xem lại sẽ tự tải ảnh từ Drive (cần mạng).`)) { setMsg('#scanFreeMsg', 'Đã hủy.'); return; }
      const r = await Y.freeLocal();
      setMsg('#scanFreeMsg', `✅ Đã giải phóng ~${fmtSize(r.bytes)} (${r.n} phiếu).${r.skipped ? ` Giữ lại ${r.skipped} phiếu chưa xác nhận được.` : ''}`);
    } catch (e) { setMsg('#scanFreeMsg', '❌ ' + esc(e.message || e), true); }
    refreshFreeInfo();
  }

  /* ---- Khối giao diện chèn bằng JS (hướng dẫn từng bước + giải phóng bộ nhớ) — không cần sửa index.html ---- */
  function injectSettingsExtras() {
    const btns = q('#btnScanStoreTest') && q('#btnScanStoreTest').parentElement;
    const host = btns || q('#scanStoreMsg');
    if (!host || q('#scanStoreGuide')) return;
    const guide = document.createElement('details');
    guide.id = 'scanStoreGuide'; guide.className = 'ss-guide'; guide.open = true;
    guide.innerHTML = `<summary>📖 Hướng dẫn tạo «Apps Script RIÊNG» (làm 1 lần, khoảng 5 phút)</summary>
<ol>
<li><b>Đăng nhập Google bằng tài khoản có nhiều dung lượng Drive</b> (ảnh sẽ nằm trong Drive của tài khoản này).</li>
<li>Mở <a href="https://script.google.com" target="_blank" rel="noopener">script.google.com</a> → bấm <b>Dự án mới</b> (New project).</li>
<li>Xóa hết đoạn code mẫu <code>function myFunction() {}</code>.</li>
<li>Lấy mã: bấm nút <button type="button" class="btn btn-ghost btn-sm" id="btnCopyGs">📋 Sao chép mã Apps Script</button> rồi <b>dán (Ctrl+V)</b> vào khung code. <span class="hint">(Nếu nút báo lỗi: mở file <code>AppsScript_StorageOnly.gs</code> trong repo, chọn tất cả, sao chép.)</span></li>
<li>Bấm biểu tượng 💾 <b>Lưu</b> (hoặc Ctrl+S), đặt tên dự án tùy ý, ví dụ «LuuAnhPhieu».</li>
<li><b>Cấp quyền:</b> ở thanh trên, chọn hàm <code>authorizeOnce</code> trong ô danh sách → bấm <b>Chạy</b> (Run) → <b>Xem lại quyền</b> → chọn tài khoản → <b>Nâng cao</b> → <b>Đi tới … (không an toàn)</b> → <b>Cho phép</b>. <span class="hint">(Google hiện cảnh báo vì script do chính bạn viết, chưa qua kiểm duyệt — bình thường.)</span></li>
<li>Bấm <b>Triển khai</b> (Deploy) → <b>Tùy chọn triển khai mới</b> → bánh răng ⚙ chọn <b>Ứng dụng web</b>. Đặt <b>Thực thi với tư cách: Tôi</b> · <b>Ai có quyền truy cập: Bất kỳ ai</b> → <b>Triển khai</b>.</li>
<li>Sao chép <b>URL ứng dụng web</b> (kết thúc bằng <code>/exec</code>).</li>
<li>Quay lại đây: chọn <b>«Apps Script RIÊNG»</b> ở trên, <b>dán URL</b> vào ô → bấm <b>Kiểm tra kết nối</b> (phải hiện ✅) → bấm <b>Lưu</b>. Ảnh cũ trên máy sẽ <b>tự động</b> được đẩy lên.</li>
</ol>
<p class="hint">• Ảnh nằm trong thư mục <b>QuanLyXe_PhieuScan</b> trên Drive của tài khoản chủ script, ở chế độ riêng tư.<br>
• Sau này nếu sửa code Apps Script: Triển khai → <b>Quản lý bản triển khai</b> → ✏ → Phiên bản: <b>Phiên bản mới</b> → Triển khai (URL giữ nguyên).<br>
• Tên nút trên giao diện Google có thể khác đôi chút tùy ngôn ngữ/phiên bản.</p>`;
    host.insertAdjacentElement('beforebegin', guide);

    const free = document.createElement('div');
    free.className = 'ss-free';
    free.innerHTML = `<label class="ss-check"><input type="checkbox" id="scanStoreAutoFree"> Tự động xóa ảnh trên máy sau khi đã lưu lên Drive thành công <span class="hint">(giữ lại phiếu mới quét trong 1 giờ; mở xem lại sẽ tự tải từ Drive)</span></label>
<div class="sv-actions"><button type="button" class="btn btn-ghost btn-sm" id="btnFreeLocal">🧹 Giải phóng bộ nhớ máy ngay</button><span class="hint" id="scanFreeInfo"></span></div>
<div class="hint" id="scanFreeMsg"></div>`;
    host.insertAdjacentElement('afterend', free);
    q('#btnFreeLocal').addEventListener('click', freeNow);
    q('#btnCopyGs').addEventListener('click', copyGs);
    injectImageAndLinkExtras(free);
  }
  // Sao chép mã Apps Script riêng vào clipboard (file nằm cùng repo GitHub Pages)
  async function copyGs() {
    try {
      const res = await fetch(new URL('AppsScript_StorageOnly.gs', document.baseURI).href, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const txt = await res.text();
      await navigator.clipboard.writeText(txt);
      toast('Đã sao chép mã Apps Script — sang trang Apps Script và dán (Ctrl+V).');
    } catch (e) { toast('Không tự sao chép được. Hãy mở file AppsScript_StorageOnly.gs trong repo và sao chép thủ công.', true); }
  }

  /* ---- Kiểm soát TẢI ẢNH về máy + LINK THIẾT LẬP cho máy khác (chèn bằng JS, không cần sửa index.html) ---- */
  const BLOCK_TXT = {
    off: 'Đang TẮT tự tải ảnh: ảnh chỉ tải khi bạn mở xem phiếu hoặc bấm «Tải ảnh về máy ngay». Dữ liệu nhẹ (biển số, đối chiếu) vẫn luôn tự đồng bộ.',
    autoFree: 'Đang bật «Tự xóa ảnh trên máy» nên không tự tải ảnh.', offline: 'Chưa kết nối nơi lưu online.',
    saveData: 'Trình duyệt đang bật «Tiết kiệm dữ liệu» nên tạm không tự tải ảnh.', notWifi: 'Đang không dùng Wi-Fi (hoặc không xác định được) nên tạm chưa tự tải ảnh.',
  };
  function injectImageAndLinkExtras(free) {
    if (q('#scanStoreAutoImages')) return;
    const imgs = document.createElement('div'); imgs.className = 'ss-free ss-imgs';
    imgs.innerHTML = `<b>🖼 Tải ảnh về máy này</b>
<label class="ss-check"><input type="checkbox" id="scanStoreAutoImages"> Tự động tải ảnh về máy (chạy ngầm) <span class="hint">— mặc định TẮT, nên để tắt trên điện thoại. Nhớ bấm «Lưu» sau khi đổi.</span></label>
<div class="sv-actions">
  <label>Mạng: <select id="scanStoreImgNet"><option value="wifi">Chỉ khi dùng Wi-Fi</option><option value="any">Cả 4G/5G (tốn data)</option></select></label>
  <label>Tải sẵn: <select id="scanStoreLimit"><option value="50">50 phiếu mới nhất</option><option value="100">100 phiếu mới nhất</option><option value="300">300 phiếu mới nhất</option><option value="1000">1000 phiếu mới nhất</option><option value="0">Tất cả</option></select></label>
</div>
<div class="sv-actions"><button type="button" class="btn btn-ghost btn-sm" id="btnPrefetchNow">⬇ Tải ảnh về máy ngay</button><button type="button" class="btn btn-ghost btn-sm hidden" id="btnPrefetchStop">⏹ Dừng</button><span class="hint" id="scanPrefetchInfo"></span></div>
<div class="hint" id="scanPrefetchMsg"></div>`;
    free.insertAdjacentElement('beforebegin', imgs);
    const link = document.createElement('div'); link.className = 'ss-free ss-link';
    link.innerHTML = `<b>🔗 Dùng trên máy / trình duyệt / tab ẩn danh khác</b>
<div class="hint">Thường KHÔNG cần: máy mới chỉ việc mở trang, cấu hình tự đồng bộ qua Apps Script chính. Link này dự phòng khi máy mới không nối được Apps Script chính.</div>
<label class="ss-check"><input type="checkbox" id="scanLinkPass"> Kèm mật khẩu kho khóa Gemini <span class="hint">— link sẽ CHỨA mật khẩu: chỉ gửi cho chính mình (tin nhắn đã lưu), không đăng công khai.</span></label>
<div class="sv-actions"><button type="button" class="btn btn-ghost btn-sm" id="btnMakeLink">🔗 Tạo link thiết lập</button><button type="button" class="btn btn-ghost btn-sm hidden" id="btnCopyLink">📋 Sao chép link</button></div>
<input type="text" id="scanLinkOut" class="hidden" readonly>
<div class="hint" id="scanLinkMsg"></div>`;
    free.insertAdjacentElement('afterend', link);
    // «Tự tải ảnh» và «Tự xóa ảnh» loại trừ nhau: bật cái này thì bỏ tick cái kia
    const ai = q('#scanStoreAutoImages'), af = q('#scanStoreAutoFree');
    ai.addEventListener('change', () => { if (ai.checked && af) af.checked = false; });
    if (af) af.addEventListener('change', () => { if (af.checked) ai.checked = false; });
    q('#btnPrefetchNow').addEventListener('click', prefetchNow);
    q('#btnPrefetchStop').addEventListener('click', () => { Y.stopPrefetch(); setMsg('#scanPrefetchMsg', '⏳ Đang dừng…'); });
    q('#btnMakeLink').addEventListener('click', makeLink);
    q('#btnCopyLink').addEventListener('click', copyLink);
  }
  async function refreshPrefetchInfo() {
    const el = q('#scanPrefetchInfo'); if (!el) return;
    try {
      const n = await Y.pendingImageCount(), why = Y.prefetchState().blocked;
      el.textContent = (n ? `${n} phiếu chưa có ảnh trên máy này. ` : 'Máy này đã có đủ ảnh. ') + (why && n ? (BLOCK_TXT[why] || '') : '');
    } catch (e) { el.textContent = ''; }
  }
  let pfTimer = null;
  function showPrefetch() {
    const s = Y.prefetchState(); if (!s.busy) return;
    setMsg('#scanPrefetchMsg', `⏳ Đang tải ảnh… ${s.done}/${s.total} phiếu · ${fmtSize(s.bytes)}`);
  }
  function pollPrefetch(on) {
    clearInterval(pfTimer); pfTimer = null;
    const b = q('#btnPrefetchStop'); if (b) b.classList.toggle('hidden', !on);
    if (on) pfTimer = setInterval(showPrefetch, 700);
  }
  // Tải ảnh CHỦ ĐỘNG: báo trước số phiếu + dung lượng ước tính, người dùng đồng ý mới tải
  async function prefetchNow() {
    if (!Y.online()) { setMsg('#scanPrefetchMsg', '❌ Cần kết nối nơi lưu online trước.', true); return; }
    if (Y.prefetchState().busy) { pollPrefetch(true); showPrefetch(); return; }
    setMsg('#scanPrefetchMsg', '⏳ Đang tính dung lượng cần tải…');
    try {
      const p = await Y.pendingImages();
      if (!p.n) { setMsg('#scanPrefetchMsg', '✅ Máy này đã có đủ ảnh.'); return; }
      const sz = p.known ? ` (khoảng ${fmtSize(p.bytes)})` : '';
      if (!confirm(`Tải ảnh của ${p.n} phiếu về máy này${sz}?\n\n• Tốn dung lượng bộ nhớ và data mạng — trên điện thoại nên dùng Wi-Fi.\n• Có thể bấm «Dừng» bất cứ lúc nào; ảnh đã tải được giữ lại.`)) { setMsg('#scanPrefetchMsg', 'Đã hủy.'); return; }
      pollPrefetch(true);
      await Y.prefetchImages({ force: true });
      const s = Y.prefetchState();
      setMsg('#scanPrefetchMsg', s.note === 'stopped' ? `⏹ Đã dừng — đã tải ${s.done}/${s.total} phiếu (${fmtSize(s.bytes)}).` : `✅ Đã tải ảnh của ${s.total} phiếu (${fmtSize(s.bytes)}).`);
    } catch (e) { setMsg('#scanPrefetchMsg', '❌ ' + esc(e.message || e), true); }
    finally { pollPrefetch(false); refreshPrefetchInfo(); refreshFreeInfo(); }
  }
  // Link thiết lập cho máy khác (mật khẩu nếu kèm chỉ nằm trong phần #…, không gửi lên server và bị xóa khỏi thanh địa chỉ khi mở)
  function makeLink() {
    try {
      const withPass = !!q('#scanLinkPass').checked; let pass = '';
      if (withPass) {
        pass = customPass() || vaultPass();       // đang dùng mật khẩu mặc định thì KHÔNG cần kèm — máy kia tự dùng mật khẩu mặc định
        if (pass && pass.length < 6) throw new Error('Mật khẩu riêng phải từ 6 ký tự.');
      }
      const r = Y.makeSetupLink(withPass, pass), out = q('#scanLinkOut');
      out.value = r.link; out.classList.remove('hidden'); q('#btnCopyLink').classList.remove('hidden');
      setMsg('#scanLinkMsg', r.withPass ? '✅ Đã tạo link (CÓ kèm mật khẩu). Mở link này 1 lần trên máy mới là xong.' : '✅ Đã tạo link. Mở trên máy mới; khóa Gemini tự lấy về (mật khẩu mặc định) hoặc nhập mật khẩu riêng nếu bạn đã đặt.');
    } catch (e) { setMsg('#scanLinkMsg', '❌ ' + esc(e.message || e), true); }
  }
  async function copyLink() {
    const out = q('#scanLinkOut');
    try { await navigator.clipboard.writeText(out.value); toast('Đã sao chép link thiết lập.'); }
    catch (e) { out.select(); toast('Không tự sao chép được — hãy bôi đen link và sao chép thủ công.', true); }
  }

  /* ====================================================================== */
  /* 2. KHO KHÓA GEMINI (mã hóa bằng mật khẩu — Apps Script chỉ thấy bản mã) */
  /* ====================================================================== */
  const VAULT = { scanId: '_vault', kind: 'keys' };
  const b64 = (u8) => { let s = ''; u8.forEach(c => { s += String.fromCharCode(c); }); return btoa(s); };
  const unb64 = (t) => Uint8Array.from(atob(t), c => c.charCodeAt(0));
  async function deriveKey(pass, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  /* Mật khẩu: MẶC ĐỊNH dùng chung «Md1234500@» -> key TỰ đồng bộ, không phải nhập gì. Muốn kín hơn: nhập mật khẩu RIÊNG (≥ 6 ký tự) ở ô bên dưới.
     LƯU Ý: mật khẩu mặc định nằm trong mã nguồn công khai nên chỉ là lớp che — ai có URL Apps Script vẫn giải mã được. Dùng mật khẩu riêng nếu cần an toàn thật. */
  const DEFAULT_PASS = 'Md1234500@';
  const PASS_KEY = 'vehicleScanVaultPassV1', FP_KEY = 'vehicleScanVaultFpV1', SEEN_KEY = 'vehicleScanVaultSeenV1';
  const customPass = () => { try { return localStorage.getItem(PASS_KEY) || ''; } catch (e) { return ''; } };
  const effPass = (typed) => typed || customPass() || DEFAULT_PASS;
  const vaultPass = () => (q('#scanVaultPass') ? q('#scanVaultPass').value : '').trim();
  const sigOf = (arr) => arr.map(k => k.key + '|' + (k.enabled !== false)).sort().join('\n');

  // Lấy + giải mã kho khóa trên Drive. { exists:false } nếu chưa có; sai mật khẩu -> ném lỗi code 'BADPASS'.
  async function vaultFetch(pass) {
    let r;
    try { r = await Y.call({ action: 'scanTextGet', ...VAULT }); }
    catch (e) { if (/Chưa có trên Drive/i.test(String(e.message || e))) return { exists: false }; throw e; }
    const box = JSON.parse(r.text);
    let plain;
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await deriveKey(pass, unb64(box.salt)), unb64(box.data)); }
    catch (e) { const err = new Error('Sai mật khẩu hoặc dữ liệu kho khóa bị hỏng.'); err.code = 'BADPASS'; throw err; }
    return { exists: true, keys: JSON.parse(new TextDecoder().decode(plain)).keys || [], updated: r.updated || 0 };
  }
  // Thêm vào máy này các key còn thiếu; trả số key mới
  async function addMissingKeys(incoming) {
    const have = new Set((await S.keys.listKeys()).map(k => k.key)); let added = 0;
    for (const k of incoming) { if (!k.key || have.has(k.key)) continue; const rec = await S.keys.addKey(k.label, k.key); if (k.enabled === false) await S.keys.patchKey(rec.id, { enabled: false }); have.add(k.key); added++; }
    if (added) S.keys.refreshUi();
    return added;
  }
  // Bản online MỚI hơn và máy này không sửa gì -> bật/tắt key theo bản online
  async function applyRemoteFlags(remote) {
    const want = new Map(remote.map(k => [k.key, k.enabled !== false])); let n = 0;
    for (const k of await S.keys.listKeys()) {
      if (want.has(k.key) && (k.enabled !== false) !== want.get(k.key)) { await S.keys.patchKey(k.id, { enabled: want.get(k.key) }); n++; }
    }
    if (n) S.keys.refreshUi();
    return n;
  }
  const localKeyList = async () => (await S.keys.listKeys()).map(k => ({ label: k.label, key: k.key, enabled: k.enabled }));
  async function vaultPutRemote(pass, keys) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(pass, salt), new TextEncoder().encode(JSON.stringify({ keys, at: Date.now() })));
    const r = await Y.call({ action: 'scanPut', scanId: VAULT.scanId, kind: VAULT.kind, mime: 'application/json', plates: '', text: JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(enc)) }) });
    return r.updated || Date.now();
  }
  // ĐỒNG BỘ 2 CHIỀU: lấy key mới từ Drive (không mất key của máy khác) → bên nào đổi SAU thì thắng (trạng thái bật/tắt) → đẩy bản đầy đủ nếu khác.
  // Sai mật khẩu -> dừng ngay, KHÔNG ghi đè kho. (Xóa key ở 1 máy không lan sang máy khác — cố ý, để không mất key.)
  async function vaultSync(pass) {
    const got = await vaultFetch(pass);
    const localChanged = (await vaultFingerprint()) !== localStorage.getItem(FP_KEY), seen = Number(localStorage.getItem(SEEN_KEY) || 0);
    let added = 0, flags = 0;
    if (got.exists) {
      added = await addMissingKeys(got.keys);
      if (!localChanged && got.updated > seen) flags = await applyRemoteFlags(got.keys);
    }
    const keys = await localKeyList();
    let pushed = 0, updated = got.updated || 0;
    if (keys.length && (!got.exists || sigOf(keys) !== sigOf(got.keys))) { updated = await vaultPutRemote(pass, keys); pushed = keys.length; }
    try { localStorage.setItem(FP_KEY, await vaultFingerprint()); localStorage.setItem(SEEN_KEY, String(updated)); } catch (e) { /* bỏ qua */ }
    return { added, flags, pushed, total: keys.length };
  }
  const vaultReady = (msgId) => {
    if (!window.crypto || !crypto.subtle) { setMsg(msgId, '❌ Trình duyệt không hỗ trợ mã hóa (cần HTTPS).', true); return false; }
    if (!Y.online()) { setMsg(msgId, '❌ Chưa kết nối nơi lưu online (xem mục Lưu trữ phía trên).', true); return false; }
    return true;
  };
  // Mật khẩu riêng thì nhớ trên máy này để tự đồng bộ tiếp; mật khẩu mặc định thì không cần nhớ
  function rememberVault(pass) {
    try { if (!pass || pass === DEFAULT_PASS) localStorage.removeItem(PASS_KEY); else localStorage.setItem(PASS_KEY, pass); } catch (e) { /* bỏ qua */ }
    refreshVaultState();
  }
  function refreshVaultState() {
    const el = q('#scanVaultState'); if (!el) return;
    el.textContent = customPass() ? '🔒 Đang dùng MẬT KHẨU RIÊNG (nhớ trên máy này) — key tự đồng bộ.' : '🔓 Đang dùng mật khẩu mặc định — key TỰ đồng bộ giữa các máy, không cần nhập gì.';
  }
  async function vaultPush() {
    if (!vaultReady('#scanVaultMsg')) return;
    const typed = vaultPass(); if (typed && typed.length < 6) { setMsg('#scanVaultMsg', '❌ Mật khẩu riêng tối thiểu 6 ký tự (hoặc để trống để dùng mật khẩu mặc định).', true); return; }
    const pass = effPass(typed);
    try {
      const r = await vaultSync(pass);
      if (!r.total) { setMsg('#scanVaultMsg', '❌ Máy này chưa có key nào để đẩy lên.', true); return; }
      rememberVault(pass);
      setMsg('#scanVaultMsg', `✅ Kho khóa đã đồng bộ (${r.total} key${r.pushed ? ', đã đẩy lên' : ''}${r.added ? `, lấy về ${r.added} key mới` : ''}).${typed ? ' Nhớ mật khẩu riêng — quên là KHÔNG khôi phục được.' : ''}`);
    } catch (e) { setMsg('#scanVaultMsg', '❌ ' + esc(e.message || e), true); }
  }
  async function vaultPull() {
    if (!vaultReady('#scanVaultMsg')) return;
    const pass = effPass(vaultPass());
    try {
      const got = await vaultFetch(pass);
      if (!got.exists) throw new Error('Chưa có kho khóa trên Drive — hãy đẩy key lên từ máy đã có key.');
      const added = await addMissingKeys(got.keys);
      rememberVault(pass); try { localStorage.setItem(FP_KEY, await vaultFingerprint()); localStorage.setItem(SEEN_KEY, String(got.updated)); } catch (e) { /* bỏ qua */ }
      setMsg('#scanVaultMsg', `✅ Đã lấy về ${added} key mới (bỏ qua ${got.keys.length - added} key đã có).`);
    } catch (e) { setMsg('#scanVaultMsg', '❌ ' + esc(e.message || e), true); }
  }
  // Kho cũ đặt mật khẩu riêng mà không nhớ -> ghi đè bằng key của MÁY NÀY + mật khẩu mặc định
  async function vaultReset() {
    if (!vaultReady('#scanVaultMsg')) return;
    const keys = await localKeyList(); if (!keys.length) { setMsg('#scanVaultMsg', '❌ Máy này chưa có key nào — hãy làm việc này trên máy đang có key.', true); return; }
    if (!confirm(`Ghi đè kho khóa trên Drive bằng ${keys.length} key của MÁY NÀY, dùng mật khẩu mặc định?\n\nKey chỉ có ở máy khác (chưa về máy này) sẽ không còn trong kho.`)) return;
    try {
      const updated = await vaultPutRemote(DEFAULT_PASS, keys); rememberVault('');
      localStorage.setItem(FP_KEY, await vaultFingerprint()); localStorage.setItem(SEEN_KEY, String(updated));
      setMsg('#scanVaultMsg', `✅ Đã đặt lại kho khóa (${keys.length} key, mật khẩu mặc định). Các máy khác sẽ tự lấy về.`);
    } catch (e) { setMsg('#scanVaultMsg', '❌ ' + esc(e.message || e), true); }
  }

  // Dấu vân tay danh sách key (SHA-256) để biết key có đổi hay chưa mà không lưu key ra chỗ khác
  async function vaultFingerprint() {
    const list = (await S.keys.listKeys()).map(k => k.key + '|' + (k.enabled !== false)).sort().join('\n');
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(list));
    return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  // TỰ ĐỘNG chạy ngầm trên mọi máy (không cần bật gì): key đổi -> đồng bộ ngay; ngoài ra 3 phút kiểm tra thay đổi từ máy khác 1 lần
  let vaultAutoBusy = false, vaultLastCheck = 0, vaultWarned = false;
  const tabLock = (fn) => (navigator.locks && navigator.locks.request) ? navigator.locks.request('scanVaultSync', { ifAvailable: true }, (l) => l ? fn() : undefined) : fn();
  async function vaultAuto(force) {
    if (vaultAutoBusy || !window.crypto || !crypto.subtle || !Y.online() || !S.keys) return;
    vaultAutoBusy = true;
    try {
      await Y.whenReady();                                   // chờ nhận xong cấu hình (nơi lưu) từ hub rồi mới đồng bộ key
      if (force !== true && (await vaultFingerprint()) === localStorage.getItem(FP_KEY) && Date.now() - vaultLastCheck < 180000) return;
      await tabLock(async () => { await vaultSync(effPass()); });
      vaultLastCheck = Date.now(); vaultWarned = false;
    } catch (e) {
      if (e && e.code === 'BADPASS') {
        vaultLastCheck = Date.now();
        if (!vaultWarned) { vaultWarned = true; setMsg('#scanVaultMsg', '⚠ Kho khóa trên Drive đang dùng MẬT KHẨU RIÊNG. Nhập mật khẩu đó vào ô bên dưới rồi bấm «Lấy key về máy này» (hoặc «Đặt lại bằng mật khẩu mặc định» trên máy đang có key).', true); try { toast('Kho khóa Gemini cần mật khẩu riêng — xem Cài đặt → Kho khóa.', true); } catch (x) { /* bỏ qua */ } }
      } else console.warn('[scan-store] tự đồng bộ key:', e.message || e);   // lỗi mạng/Drive: 30 giây sau tự thử lại
    } finally { vaultAutoBusy = false; }
  }
  function injectVaultExtras() {
    const pw = q('#scanVaultPass'); if (!pw || q('#btnVaultReset')) return;
    pw.placeholder = 'Mật khẩu riêng (bỏ trống = dùng mật khẩu mặc định, tự đồng bộ)';
    const btn = document.createElement('button'); btn.type = 'button'; btn.id = 'btnVaultReset'; btn.className = 'btn btn-ghost btn-sm'; btn.textContent = '♻ Đặt lại bằng mật khẩu mặc định';
    btn.addEventListener('click', vaultReset); q('#btnVaultPull').insertAdjacentElement('afterend', btn);
    const st = document.createElement('div'); st.id = 'scanVaultState'; st.className = 'hint'; (q('#scanVaultMsg') || pw).insertAdjacentElement('beforebegin', st);
    refreshVaultState();
  }

  /* ====================================================================== */
  /* 3. QUẢN LÝ KHO ẢNH                                                      */
  /* ====================================================================== */
  const K = { rows: [], inv: null, invError: '', filter: 'all', search: '', limit: 50, sel: new Set(), busy: false };

  // Đọc nhẹ danh sách phiếu trên máy (cursor; chỉ lấy dung lượng blob, không nạp ảnh)
  async function loadLocal() {
    const db = await DB.openDb(), out = new Map();
    await new Promise((res, rej) => {
      const req = db.transaction(ST_SCANS, 'readonly').objectStore(ST_SCANS).openCursor();
      req.onsuccess = () => {
        const c = req.result; if (!c) { res(); return; }
        const r = c.value;
        if (r.status === 'done' && !r.isTest) out.set(r.id, {
          id: r.id, timestamp: r.timestamp, source: r.sheetLabel || r.fileName || '', local: true, cloud: r.cloud || {},
          frontSize: r.frontBlob ? r.frontBlob.size : 0, backSize: r.backBlob ? r.backBlob.size : 0,
          hasFrontBlob: !!r.frontBlob, hasBackBlob: !!r.backBlob, backBlank: !!r.backBlank, plates: [],
        });
        c.continue();
      };
      req.onerror = () => rej(req.error);
    });
    const items = (await DB.dbGetAll(ST_ITEMS)) || [];
    items.forEach(it => { const row = out.get(it.scanId); if (row) { const p = it.bienSoRaw || it.bienSo; if (p && !row.plates.includes(p)) row.plates.push(p); } });
    return out;
  }
  async function loadInventory() {
    K.inv = null; K.invError = '';
    if (!Y.online()) { K.invError = Y.config().mode === 'off' ? 'Đang tắt lưu online.' : 'Chưa kết nối nơi lưu online.'; return; }
    try {
      const r = await Y.call({ action: 'scanInventory' }), by = new Map();
      (r.files || []).forEach(f => { const e = by.get(f.scanId) || { id: f.scanId, plates: '', updated: 0 }; e[f.kind] = f; e.updated = Math.max(e.updated, f.updated || 0); if (f.plates) e.plates = f.plates; by.set(f.scanId, e); });
      K.inv = { by, gone: new Set(r.gone || []), totalSize: (r.files || []).reduce((n, f) => n + (f.size || 0), 0), files: (r.files || []).length };
    } catch (e) { K.invError = String((e && e.message) || e); }
  }

  // Gộp máy này + online thành danh sách dòng, gắn trạng thái
  function buildRows(local) {
    const rows = [], seen = new Set(), inv = K.inv;
    const mk = (id, l, o) => {
      const row = { id, local: !!l, online: !!o, timestamp: (l && l.timestamp) || (o && o.updated) || 0, source: l ? l.source : '', plates: l ? l.plates : [],
        platesText: l ? l.plates.join(', ') : (o ? o.plates : ''), frontSize: l ? l.frontSize : 0, backSize: l ? l.backSize : 0,
        onFront: o ? (o.front ? o.front.size : 0) : 0, onBack: o ? (o.back ? o.back.size : 0) : 0, hasBack: false, status: 'ok', note: '' };
      row.hasBack = l ? (l.hasBackBlob || !!l.cloud.backId) : !!(o && o.back);
      if (!l && o) { row.status = o.meta ? 'onlineonly' : 'orphan'; row.note = o.meta ? 'Chỉ có trên Drive — bấm «Đồng bộ ngay» để lấy về máy' : 'File ảnh không có phiếu đi kèm (mồ côi)'; }
      else if (!inv) { row.status = (l.cloud.frontId ? 'unknown' : 'localonly'); row.note = l.cloud.frontId ? 'Chưa kiểm tra online' : (Y.config().mode === 'off' ? 'Chỉ lưu trên máy' : 'Chưa lên Drive'); }
      else if (!o) { row.status = l.cloud.frontId || l.cloud.metaAt ? 'missing' : 'localonly'; row.note = row.status === 'missing' ? 'Đã đánh dấu lưu online nhưng Drive không còn file' : 'Chưa lên Drive (sẽ tự đẩy)'; }
      else if (!o.meta || !o.front || (row.hasBack && !o.back)) { row.status = 'missing'; row.note = !o.meta ? 'Thiếu file dữ liệu (meta) trên Drive' : !o.front ? 'Thiếu ảnh mặt 1 trên Drive' : 'Thiếu ảnh mặt 2 trên Drive'; }
      if (row.status === 'missing' && l && !l.hasFrontBlob) row.note += ' · máy này cũng không còn ảnh gốc → không sửa được';
      return row;
    };
    for (const [id, l] of local) { seen.add(id); rows.push(mk(id, l, inv && inv.by.get(id))); }
    if (inv) for (const [id, o] of inv.by) if (!seen.has(id) && !inv.gone.has(id)) rows.push(mk(id, null, o));
    rows.sort((a, b) => b.timestamp - a.timestamp);
    return rows;
  }

  const STATUS_CHIP = {
    ok: ['✅ Đồng bộ', 'ok'], localonly: ['⬆ Chưa lên Drive', 'warn'], missing: ['⚠ Thiếu trên Drive', 'err'], onlineonly: ['📱 Chỉ trên Drive', 'info'],
    orphan: ['🗑 File mồ côi', 'err'], unknown: ['❔ Chưa kiểm tra', 'info'],
  };
  function visibleRows() {
    const t = K.search.trim().toLowerCase();
    return K.rows.filter(r => {
      if (K.filter === 'problem' && !['missing', 'orphan'].includes(r.status)) return false;
      if (K.filter === 'localonly' && r.status !== 'localonly') return false;
      if (K.filter === 'onlineonly' && !['onlineonly', 'orphan'].includes(r.status)) return false;
      if (K.filter === 'noback' && r.hasBack) return false;
      return !t || (r.id + ' ' + r.platesText + ' ' + r.source).toLowerCase().includes(t);
    });
  }
  function render() {
    const vis = visibleRows(), shown = vis.slice(0, K.limit);
    const local = K.rows.filter(r => r.local), localSize = local.reduce((n, r) => n + r.frontSize + r.backSize, 0);
    const problems = K.rows.filter(r => ['missing', 'orphan'].includes(r.status)).length;
    q('#ssSummary').innerHTML = `📱 Máy này: <b>${local.length}</b> phiếu · ${fmtSize(localSize)} &nbsp;|&nbsp; ` + (K.inv
      ? `☁️ Online: <b>${K.inv.by.size}</b> phiếu · ${K.inv.files} file · ${fmtSize(K.inv.totalSize)} (Drive miễn phí 15 GB dùng chung với Gmail/Ảnh)` : `☁️ Online: <span class="error-text">${esc(K.invError || 'chưa tải')}</span>`)
      + (problems ? ` &nbsp;|&nbsp; <b class="error-text">${problems} phiếu có vấn đề</b>` : '');
    q('#ssBody').innerHTML = shown.length ? shown.map(r => {
      const [lab, cls] = STATUS_CHIP[r.status] || ['', ''];
      return `<tr data-id="${esc(r.id)}"><td><input type="checkbox" data-sel ${K.sel.has(r.id) ? 'checked' : ''}></td>`
        + `<td><code>${esc(r.id.slice(0, 8))}</code><div class="hint">${esc(fmtTime(r.timestamp))}</div></td>`
        + `<td class="ss-plates">${esc(r.platesText) || '<span class="hint">(chưa có)</span>'}<div class="hint">${esc(r.source)}</div></td>`
        + `<td>${r.hasBack ? 'Có' : '<span class="hint">Không</span>'}</td>`
        + `<td>${esc(fmtSize(r.local ? r.frontSize + r.backSize : r.onFront + r.onBack))}</td>`
        + `<td><span class="ss-chip ss-${cls}" title="${esc(r.note)}">${lab}</span>${r.note ? `<div class="hint">${esc(r.note)}</div>` : ''}</td>`
        + `<td class="ss-actions">${r.local ? '<button type="button" class="btn btn-ghost btn-sm" data-act="view" title="Xem ảnh">👁</button><button type="button" class="btn btn-ghost btn-sm" data-act="pdf" title="Tải PDF đầy đủ">⬇</button>' : ''}`
        + `${r.hasBack ? '<button type="button" class="btn btn-ghost btn-sm" data-act="delback" title="Xóa ảnh mặt 2 (trang thừa), giữ mặt 1">🗑 Mặt 2</button>' : ''}`
        + `<button type="button" class="btn btn-ghost btn-sm" data-act="del" title="Xóa cả phiếu (máy này + Drive)">🗑 Phiếu</button></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="hint" style="text-align:center;padding:18px">Không có phiếu nào khớp bộ lọc.</td></tr>';
    q('#ssMore').innerHTML = vis.length > shown.length ? `<button type="button" class="btn btn-ghost btn-sm" data-act="more">Hiện thêm (${vis.length - shown.length} phiếu nữa)</button>` : `<span class="hint">${vis.length} phiếu</span>`;
    q('#ssDelSel').textContent = K.sel.size ? `🗑 Xóa ${K.sel.size} phiếu đã chọn` : '🗑 Xóa các phiếu đã chọn';
    q('#ssDelSel').disabled = !K.sel.size;
    const chkAll = q('#ssSelAll'); if (chkAll) chkAll.checked = !!shown.length && shown.every(r => K.sel.has(r.id));
  }

  async function reload() {
    if (K.busy) return; K.busy = true; q('#ssSummary').textContent = '⏳ Đang kiểm tra kho ảnh…';
    try { const local = await loadLocal(); await loadInventory(); K.rows = buildRows(local); K.sel = new Set([...K.sel].filter(id => K.rows.some(r => r.id === id))); }
    catch (e) { toast('Không đọc được kho ảnh: ' + (e.message || e), true); }
    finally { K.busy = false; render(); }
  }

  /* ---- Xóa ---- */
  const hasOnline = (id) => !!(K.inv && K.inv.by.has(id));
  // Xóa cả phiếu: Drive (vào thùng rác + ghi dấu «gone» cho máy khác) rồi máy này. Có bản online mà đang offline thì KHÔNG xóa (tránh máy khác đẩy lại)
  async function removeScan(id) {
    const rec = await DB.dbGet(ST_SCANS, id), flagged = rec && rec.cloud && (rec.cloud.frontId || rec.cloud.backId || rec.cloud.metaAt);
    if (flagged || hasOnline(id)) {
      if (!Y.online()) throw new Error('Phiếu ' + id.slice(0, 8) + ' đang lưu online — cần kết nối để xóa cả bản online.');
      await Y.call({ action: 'scanDelete', scanId: id }); Y.markGone(id);
    }
    if (rec) await ScanReview.purgeScanLocal(id);
  }
  // Xóa riêng mặt 2 (trang thừa): giữ mặt 1; cập nhật lại meta để máy khác biết
  async function removeBack(id) {
    const rec = await DB.dbGet(ST_SCANS, id), onl = (rec && rec.cloud && rec.cloud.backId) || (K.inv && K.inv.by.get(id) && K.inv.by.get(id).back);
    if (onl) { if (!Y.online()) throw new Error('Mặt 2 đang lưu online — cần kết nối để xóa.'); await Y.call({ action: 'scanDelete', scanId: id, kinds: ['back'] }); }
    if (!rec) return;
    rec.backBlob = null; rec.backMime = ''; rec.backBlank = false; if (rec.cloud) delete rec.cloud.backId;
    await DB.dbPut(ST_SCANS, rec); Y.touch(id);
  }
  // File mồ côi chỉ có trên Drive (không có bản ghi trên máy này): xóa thẳng trên Drive
  async function removeOnlineOnly(id) { await Y.call({ action: 'scanDelete', scanId: id, kinds: ['front', 'back', 'meta'] }); Y.markGone(id); }

  async function bulkDelete(ids) {
    let ok = 0, fail = '';
    for (const id of ids) {
      try { const r = K.rows.find(x => x.id === id); if (r && !r.local) await removeOnlineOnly(id); else await removeScan(id); ok++; }
      catch (e) { fail = e.message || String(e); break; }
    }
    ids.forEach(id => K.sel.delete(id));
    toast(fail ? `Đã xóa ${ok}/${ids.length} phiếu. Dừng vì: ${fail}` : `Đã xóa ${ok} phiếu.`, !!fail);
    await reload();
  }
  // Sửa các phiếu «thiếu trên Drive» mà máy này còn ảnh gốc: xóa cờ rồi đẩy lại
  async function repair() {
    const fixable = K.rows.filter(r => r.status === 'missing' && r.local && r.frontSize > 0), lost = K.rows.filter(r => r.status === 'missing').length - fixable.length;
    if (!fixable.length) { toast(lost ? `${lost} phiếu thiếu nhưng máy này không còn ảnh gốc — hãy xóa các phiếu đó.` : 'Không có phiếu nào cần sửa.', !!lost); return; }
    for (const r of fixable) { const rec = await DB.dbGet(ST_SCANS, r.id); if (rec) { rec.cloud = {}; await DB.dbPut(ST_SCANS, rec); Y.touch(r.id); } }
    toast(`Đang đẩy lại ${fixable.length} phiếu lên Drive…`); await Y.run(); await reload();
    if (lost) toast(`${lost} phiếu không sửa được (không còn ảnh gốc) — nên xóa.`, true);
  }

  function bind() {
    q('#ssSearch').addEventListener('input', (e) => { K.search = e.target.value; K.limit = 50; render(); });
    q('#ssFilter').addEventListener('change', (e) => { K.filter = e.target.value; K.limit = 50; render(); });
    q('#ssReload').addEventListener('click', reload);
    q('#ssSync').addEventListener('click', async () => { toast('Đang đồng bộ…'); await Y.syncNow(); await reload(); });
    q('#ssRepair').addEventListener('click', repair);
    q('#ssDelSel').addEventListener('click', async () => {
      const ids = [...K.sel]; if (!ids.length) return;
      if (confirm(`Xóa ${ids.length} phiếu đã chọn?\n\n• Ảnh + dữ liệu đối chiếu trên máy này và trên Drive sẽ bị xóa (Drive: vào thùng rác ~30 ngày).\n• Dữ liệu xe trên Sheet KHÔNG bị đụng tới.`)) await bulkDelete(ids);
    });
    q('#ssSelAll').addEventListener('change', (e) => { visibleRows().slice(0, K.limit).forEach(r => e.target.checked ? K.sel.add(r.id) : K.sel.delete(r.id)); render(); });
    q('#ssSelFilter').addEventListener('click', () => { visibleRows().forEach(r => K.sel.add(r.id)); render(); toast(`Đã chọn ${K.sel.size} phiếu theo bộ lọc hiện tại.`); });
    q('#scanStoreModal').addEventListener('click', async (e) => {
      const more = e.target.closest('[data-act="more"]'); if (more) { K.limit += 50; render(); return; }
      const tr = e.target.closest('tr[data-id]'); if (!tr) return;
      const id = tr.dataset.id, row = K.rows.find(r => r.id === id), act = (e.target.closest('[data-act]') || {}).dataset;
      if (e.target.matches('[data-sel]')) { e.target.checked ? K.sel.add(id) : K.sel.delete(id); render(); return; }
      if (!act || !act.act) return;
      try {
        if (act.act === 'view') ScanReview.openViewer({ scanId: id });
        else if (act.act === 'pdf') ScanFiles.download(id, 'pdf');
        else if (act.act === 'delback') { if (confirm('Xóa ảnh MẶT 2 của phiếu ' + id.slice(0, 8) + '? (giữ nguyên mặt 1)')) { await removeBack(id); toast('Đã xóa mặt 2.'); await reload(); } }
        else if (act.act === 'del') {
          if (confirm(`Xóa cả phiếu ${id.slice(0, 8)}${row && row.platesText ? ' (' + row.platesText + ')' : ''}?\nẢnh + dữ liệu đối chiếu trên máy này và trên Drive sẽ bị xóa. Dữ liệu xe trên Sheet không bị đụng tới.`)) {
            if (row && !row.local) await removeOnlineOnly(id); else await removeScan(id);
            toast('Đã xóa phiếu.'); await reload();
          }
        }
      } catch (err) { toast(err.message || String(err), true); }
    });
    // Cài đặt nơi lưu + kho khóa
    document.querySelectorAll('input[name="scanStoreMode"]').forEach(r => r.addEventListener('change', toggleUrlRow));   // KHÔNG gọi loadSettingsUi ở đây (sẽ ghi đè lựa chọn)
    q('#btnScanStoreSave').addEventListener('click', saveSettings);
    q('#btnScanStoreTest').addEventListener('click', testSettings);
    q('#btnVaultPush').addEventListener('click', vaultPush);
    q('#btnVaultPull').addEventListener('click', vaultPull);
    document.querySelectorAll('[data-open-scanstore]').forEach(b => b.addEventListener('click', open));
    injectSettingsExtras(); injectVaultExtras(); loadSettingsUi();
  }

  async function open() { K.limit = 50; openModal('scanStoreModal'); loadSettingsUi(); await reload(); }
  bind();
  setInterval(vaultAuto, 30000); setTimeout(vaultAuto, 3000);   // chạy ngầm; lỗi thì 30 giây sau tự thử lại
  document.addEventListener('visibilitychange', () => { if (!document.hidden) vaultAuto(true); });   // quay lại tab -> lấy thay đổi mới ngay
  return { open, reload, removeScan, removeBack };
})();
window.ScanStore = ScanStore;
