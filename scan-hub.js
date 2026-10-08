/* =========================================================================
   scan-hub.js — ĐỒNG BỘ CẤU HÌNH ĐA THIẾT BỊ: cài đặt 1 lần, mọi máy / tab / ẩn danh dùng giống nhau
   Vấn đề cũ: «Nơi lưu ảnh» (Apps Script riêng) chỉ nằm trong localStorage của TỪNG trình duyệt, nên máy mới mặc định về Apps Script chính
   → nhìn sang Drive khác → không thấy ảnh, không lấy được kho khóa Gemini.
   Giải pháp: dùng Apps Script CHÍNH (DEFAULT_GAS_URL — máy nào cũng biết sẵn, không cần cấu hình) làm «HUB»:
   lưu 1 file nhỏ «_cfg» (JSON) trên Drive, gồm 3 phần, mỗi phần có mốc thời gian riêng:
     • storage : nơi lưu ảnh (gas / gas2 + URL)         • prefs : tùy chọn màn so sánh phiếu (người thực hiện, ghi dấu 📷…)
     • gem     : Model / Timeout / Số lần chờ quota Gemini
   Xung đột: phần nào đổi SAU thì đè phần đổi trước (last-write-wins theo từng phần).
   KHÔNG đồng bộ (cố ý): chế độ «Chỉ lưu trên máy này» (off) và các tùy chọn tải/xóa ảnh (autoImages, autoFree, Wi-Fi) — mỗi máy tự chọn (điện thoại ≠ máy tính).
   Cần: Apps Script CHÍNH đã dán PHẦN 2 của AppsScript_ScanPatch.gs (scanPut / scanTextGet). Nạp SAU scan-sync.js, TRƯỚC scan-store.js.
   ========================================================================= */
const ScanHub = (() => {
  'use strict';
  const Y = ScanSync;
  const PTR = { scanId: '_cfg', kind: 'keys' };       // file «_cfg__keys» trong thư mục QuanLyXe_PhieuScan (không phải phiếu, scanList/scanInventory bỏ qua)
  const LS = 'vehicleScanHubV1';                       // trạng thái đồng bộ của máy này (mốc thời gian từng phần)
  const PREF_KEY = 'vehicleScanPrefsV1';               // trùng PREF_KEY trong scan-review.js
  const ASK_KEY = 'vehicleScanImgAskV1';               // đã hỏi «tải ảnh về máy?» chưa
  const GEM_IDS = { model: 'geminiModel', timeout: 'geminiTimeout', maxWait: 'geminiMaxWait' };
  const TICK_MS = 180000;                              // kiểm tra thay đổi từ máy khác mỗi 3 phút (1 request rất nhẹ)
  const H = { busy: false, again: false, error: '', lastOk: 0 };
  let applying = false;                                // đang tự điền ô nhập từ hub -> không coi là người dùng sửa
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const loadL = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } };
  const saveL = (o) => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) { /* bỏ qua */ } };
  const msgOf = (e) => String((e && e.message) || e);

  // URL hub = Apps Script chính (đang nối Sheet): ưu tiên cái đã kết nối, rồi cái đã nhớ, cuối cùng là mặc định trong app.js
  function hubUrl() {
    try { if (typeof state !== 'undefined' && state.gasUrl) return state.gasUrl; } catch (e) { /* bỏ qua */ }
    try { const u = localStorage.getItem('vehicleGasUrl'); if (u) return u; } catch (e) { /* bỏ qua */ }
    return (typeof DEFAULT_GAS_URL !== 'undefined') ? DEFAULT_GAS_URL : '';
  }

  /* ---- Cài đặt Gemini: đọc/ghi qua ô nhập trên màn Cài đặt (scan.js tự lưu khi nhận sự kiện change) ---- */
  function readGem() {
    const o = {};
    for (const k of Object.keys(GEM_IDS)) { const el = document.getElementById(GEM_IDS[k]); if (!el || el.value === '') return null; o[k] = el.value; }
    return o;
  }
  function applyGem(g) {
    applying = true;
    try {
      for (const k of Object.keys(GEM_IDS)) {
        const el = document.getElementById(GEM_IDS[k]);
        if (!el || g[k] == null || el.value === String(g[k])) continue;
        el.value = g[k]; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } finally { applying = false; }
  }
  // Chỉ sự kiện của NGƯỜI DÙNG (isTrusted) mới tính là «sửa»; sự kiện do code phát ra (applyGem) hay scan.js tự điền thì bỏ qua
  function bindGemWatch() {
    Object.values(GEM_IDS).forEach(id => {
      const el = document.getElementById(id); if (!el) return;
      el.addEventListener('change', (e) => { if (applying || !e.isTrusted) return; const L = loadL(); L.gemAt = Date.now(); saveL(L); setTimeout(pushNow, 1500); });
    });
  }

  /* ---- 1 lượt đồng bộ: lấy _cfg → áp phần mới hơn về máy → đẩy phần máy này mới hơn lên ---- */
  async function tick() {
    if (H.busy) { H.again = true; return; }
    const url = hubUrl(); if (!url || !Y.validUrl(url)) return;
    H.busy = true;
    try {
      let remote = null;
      try { remote = JSON.parse((await Y.callUrl(url, { action: 'scanTextGet', ...PTR })).text); }
      catch (e) { if (!/Chưa có trên Drive/i.test(msgOf(e))) throw e; }     // chưa có file = lần đầu, bình thường
      remote = remote || {};
      const doc = { v: 1, storage: remote.storage, prefs: remote.prefs, gem: remote.gem };
      const L = loadL(), applied = []; let push = false;

      // (1) NƠI LƯU ẢNH. «off» là riêng từng máy nên không đồng bộ. Chỉ máy do NGƯỜI DÙNG đã chọn (hoặc cấu hình cũ có sẵn từ trước) mới được đẩy lên.
      const c = Y.config(), ci = Y.cfgInfo(), rs = doc.storage;
      if (c.mode !== 'off') {
        const differs = rs && (rs.mode !== c.mode || (rs.mode === 'gas2' && rs.url2 !== c.url2));
        if (rs && rs.at > ci.at && differs && (rs.mode === 'gas' || Y.validUrl(rs.url2))) {
          Y.setConfig({ mode: rs.mode, url2: rs.mode === 'gas2' ? rs.url2 : c.url2, at: rs.at, src: 'hub' });   // bản online mới hơn -> máy này theo
          applied.push('nơi lưu ảnh');
        } else if ((ci.src === 'user' || ci.legacy) && (!rs || ci.at > rs.at)) {                              // bản máy này mới hơn (hoặc hub chưa có) -> đẩy lên
          const at = ci.at || Date.now(); if (!ci.at) Y.markConfigAt(at);
          doc.storage = { mode: c.mode, url2: c.mode === 'gas2' ? c.url2 : '', at }; push = true;
        }
      }

      // (2) Tùy chọn màn so sánh phiếu (so bằng chuỗi JSON; lần đầu thấy dữ liệu cũ của máy: nếu hub đã có thì hub thắng, chưa có thì đẩy lên)
      const raw = localStorage.getItem(PREF_KEY);
      if (raw != null && raw !== L.prefsSeen) { L.prefsAt = (L.prefsSeen === undefined && remote.prefs) ? 0 : Date.now(); L.prefsSeen = raw; }
      if (remote.prefs && remote.prefs.at > (L.prefsAt || 0)) {
        if (remote.prefs.raw !== raw) {
          try { localStorage.setItem(PREF_KEY, remote.prefs.raw); } catch (e) { /* bỏ qua */ }
          if (window.ScanReview && ScanReview.reloadPrefs) ScanReview.reloadPrefs();
          applied.push('tùy chọn so sánh phiếu');
        }
        L.prefsSeen = remote.prefs.raw; L.prefsAt = remote.prefs.at;
      } else if (raw != null && (L.prefsAt || 0) > ((remote.prefs && remote.prefs.at) || 0)) { doc.prefs = { raw, at: L.prefsAt }; push = true; }

      // (3) Cài đặt Gemini (model / timeout / chờ quota)
      const gem = readGem();
      if (gem) {
        if (!remote.gem && L.gemAt === undefined) L.gemAt = Date.now();                   // hub chưa có gì -> lấy giá trị hiện tại của máy này làm gốc
        if (remote.gem && remote.gem.at > (L.gemAt || 0)) { applyGem(remote.gem.val); L.gemAt = remote.gem.at; applied.push('cài đặt Gemini'); }
        else if ((L.gemAt || 0) > ((remote.gem && remote.gem.at) || 0)) { doc.gem = { val: gem, at: L.gemAt }; push = true; }
      }

      if (push) await Y.callUrl(url, { action: 'scanPut', ...PTR, mime: 'application/json', plates: '', text: JSON.stringify(doc) });
      saveL(L);
      H.error = ''; H.lastOk = Date.now();
      if (applied.length) { try { toast('Đã nhận cài đặt từ thiết bị khác: ' + applied.join(', ') + '.'); } catch (e) { /* bỏ qua */ } Y.run(); }
    } catch (e) {
      H.error = msgOf(e).slice(0, 140); console.warn('[scan-hub]', e);
    } finally {
      H.busy = false; showInfo();
      if (H.again) { H.again = false; setTimeout(tick, 500); }
    }
  }
  const pushNow = () => tick();

  function showInfo() {
    const el = document.getElementById('scanHubInfo'); if (!el) return;
    el.classList.toggle('error-text', !!H.error);
    el.textContent = H.error ? `⚠ Chưa đồng bộ được cấu hình giữa các máy: ${H.error} (Apps Script CHÍNH cần dán PHẦN 2 của AppsScript_ScanPatch.gs rồi Deploy bản mới).`
      : (H.lastOk ? '🔄 Cấu hình (nơi lưu, cài đặt Gemini, tùy chọn) tự đồng bộ giữa các máy — lần cuối ' + new Date(H.lastOk).toLocaleTimeString('vi-VN') + '.' : '');
  }
  function injectInfo() {
    const anchor = document.getElementById('scanStoreMsg'); if (!anchor || document.getElementById('scanHubInfo')) return;
    const d = document.createElement('div'); d.id = 'scanHubInfo'; d.className = 'hint'; anchor.insertAdjacentElement('afterend', d);
  }

  /* ---- Lần đầu trên máy mới: hỏi MỘT lần có tải ảnh về máy không (mặc định KHÔNG — người dùng phải chủ động cho phép) ---- */
  const fmt = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  async function maybeAskImages() {
    try {
      if (localStorage.getItem(ASK_KEY) || document.getElementById('scanImgAsk') || !Y.online()) return;
      const c = Y.config(); if (c.autoImages || c.autoFree) { localStorage.setItem(ASK_KEY, '1'); return; }
      if (!(await Y.pendingImageCount())) return;                   // máy đã có đủ ảnh (vd. máy gốc) -> khỏi hỏi
      const p = await Y.pendingImages(), sz = p.known ? ` (khoảng ${fmt(p.bytes)})` : '';
      const box = document.createElement('div'); box.id = 'scanImgAsk'; box.className = 'ss-ask';
      box.innerHTML = `<div><b>🖼 Máy này chưa có ảnh của ${p.n} phiếu${sz}.</b> Dữ liệu nhẹ (biển số, đối chiếu) đã tải xong và dùng được ngay. Có tải luôn ảnh về máy không? <span class="hint">Chọn «Chỉ khi xem» nếu là điện thoại / máy yếu — có thể đổi lại ở Cài đặt.</span></div>
<div class="sv-actions"><button type="button" class="btn btn-primary btn-sm" data-a="now">⬇ Tải ngay</button><button type="button" class="btn btn-secondary btn-sm" data-a="auto">🔁 Tự tải ngầm (Wi-Fi)</button><button type="button" class="btn btn-ghost btn-sm" data-a="view">Chỉ khi xem</button><button type="button" class="btn btn-ghost btn-sm" data-a="later">✕</button></div><div class="hint" data-msg></div>`;
      document.body.appendChild(box);
      box.addEventListener('click', async (e) => {
        const a = e.target.closest('[data-a]'); if (!a) return; const act = a.dataset.a;
        if (act === 'later') { box.remove(); return; }                // đóng tạm, lần mở sau hỏi lại
        try { localStorage.setItem(ASK_KEY, '1'); } catch (x) { /* bỏ qua */ }
        if (act === 'view') { box.remove(); return; }
        if (act === 'auto') { Y.setConfig({ autoImages: true, imgNet: 'wifi', autoFree: false }); Y.run(); box.remove(); try { toast('Sẽ tự tải ảnh ngầm khi có Wi-Fi.'); } catch (x) { /* bỏ qua */ } return; }
        const m = box.querySelector('[data-msg]'); box.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const t = setInterval(() => { const s = Y.prefetchState(); if (s.busy) m.textContent = `⏳ Đang tải ảnh… ${s.done}/${s.total} phiếu`; }, 700);
        try { await Y.prefetchImages({ force: true }); m.textContent = '✅ Đã tải xong.'; setTimeout(() => box.remove(), 2500); }
        catch (x) { m.textContent = '❌ ' + msgOf(x); box.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
        finally { clearInterval(t); }
      });
    } catch (e) { console.warn('[scan-hub] hỏi tải ảnh lỗi', e); }
  }

  /* ---- Khởi tạo ---- */
  injectInfo(); bindGemWatch();
  // Cổng chờ: lần đồng bộ ảnh đầu tiên đợi nhận xong cấu hình chung (tối đa 8 giây, không chặn nếu mạng chậm)
  Y.addGate(Promise.race([tick(), sleep(8000)]));
  setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('online', tick);
  setTimeout(maybeAskImages, 8000); setInterval(maybeAskImages, 30000);   // dừng hỏi khi đã trả lời (ASK_KEY)
  return { pushNow, tick, status: () => ({ ...H }) };
})();
window.ScanHub = ScanHub;
