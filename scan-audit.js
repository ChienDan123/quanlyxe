/* =========================================================================
   scan-audit.js — QUÉT LẠI TỰ ĐỘNG phiếu cũ bị sai/thiếu (R7)   [dấu nhận diện: QP:Q5-*]
   Nạp SAU scan-review.js, scan-recheck-ui.js, scan-lean.js; TRƯỚC layout.js.
   - Phát hiện (heuristic): số mặt > số ảnh lưu · số xe < STT lớn nhất/số xe khai · STT nhảy · JSON bị cắt/lỗi parse ·
     xe không có khung (phiếu nhiều mặt) · nhiều xe nhưng chỉ còn 2 ảnh · «không rõ» bị gán «chưa sang tên» (chỉ báo, tự sửa khi mở).
   - Chạy NGẦM, ưu tiên thấp: nhường khi người dùng đang quét / AI kiểm lại / mở bảng quét lại; tiến độ lưu bền (idbGet/idbSet), tải lại trang chạy tiếp.
   - Gộp bằng ScanReview.rescanMerge (khớp biển số → vị trí): KHÔNG ghi đè ô sửa tay / đã khóa / đã áp dụng lên Sheet; xe mới → mục mới.
   - Nguồn ảnh: (1) ảnh đã lưu đủ ≥3 mặt; (2) file gốc còn trong hàng đợi (scanQueue ':files'); (3) không có → «Cần nạp lại file gốc».
   - «Nạp lại file gốc»: nhận phiếu cũ theo hash mặt 1 (hoặc tên file + số trang) → quét đủ mặt → ghép vào CHÍNH phiếu cũ (giữ scanId).
   GIỚI HẠN (hiển thị trong giao diện): phiếu cũ chỉ còn ảnh 2 mặt thì KHÔNG thể tự quét đủ; chỉ nạp lại file PDF gốc mới quét đủ được.
   ========================================================================= */
const ScanAudit = (() => {
  'use strict';
  const S = window.ScanApp;
  if (!S) { console.warn('[ScanAudit] thiếu ScanApp'); return null; }
  const DB = S.db, ST_SCANS = DB.ST_SCANS, ST_QUEUE = DB.ST_QUEUE;
  const KEY = 'scanAuditStateV1', TICK_MS = 20000, RESCAN_EVERY_MS = 6 * 3600 * 1000, BLOCK_MS = 30 * 60 * 1000;
  const q = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const defState = () => ({ v: 1, queue: [], need: {}, done: {}, failed: {}, paused: false, lastScan: 0, blockUntil: 0, log: [], cur: '' });
  let st = defState(), running = false, timer = 0, saveT = 0, dlg = null;

  /*QP:Q5-2*/ async function load() {
    try { const v = (typeof idbGet === 'function') ? await idbGet(KEY) : null; if (v && typeof v === 'object') st = Object.assign(defState(), v); } catch (e) { /* bỏ qua */ }
    st.cur = '';
  }
  function save() {
    if (saveT) return;
    saveT = setTimeout(async () => { saveT = 0; try { if (typeof idbSet === 'function') await idbSet(KEY, st); } catch (e) { /* bỏ qua */ } }, 300);
  }
  const nowS = () => new Date().toLocaleTimeString('vi-VN');
  function log(m) { st.log = (st.log || []).concat([nowS() + ' · ' + m]).slice(-15); save(); render(); }

  /* ---------------- PHÁT HIỆN ---------------- */
  const plain = (s) => { let t = String(s || '').toLowerCase(); try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd'); } catch (e) { /* bỏ qua */ } return t.replace(/[^a-z0-9]+/g, ' ').trim(); };
  const looksKhongRo = (s) => { const t = plain(s); return /\b(khong|k0|kg|khg|ko|xo|kh0)\s+(ro|r0|biet)\b/.test(t) && (/\bnguoi\s+(su\s+dung|sd|mua)\b/.test(t) || /\bng\s+(sd|mua)\b/.test(t)); };
  const hasBox = (v) => { const y0 = Number(v.vungY0), x0 = Number(v.vungX0), y1 = Number(v.vungY1), x1 = Number(v.vungX1); return [y0, x0, y1, x1].every(Number.isFinite) && (y1 - y0) >= 15 && (x1 - x0) >= 30; };
  const haveImages = (r) => (r.frontBlob ? 1 : 0) + (r.backBlob ? 1 : 0) + (r.extraBlobs || []).filter(x => x && x.blob).length;
  function startPage(r) { const m = String(r.pagesDesc || '').match(/(\d+)/); return m ? parseInt(m[1], 10) : 1; }
  function expPages(r) { const m = String(r.pagesDesc || '').match(/(\d+)\s*[-–]\s*(\d+)/); return m ? Math.max(1, +m[2] - +m[1] + 1) : 0; }

  /*QP:Q5-3*/ function detect(rec) {
    const ex = rec.extracted || {}, vs = Array.isArray(ex.vehicles) ? ex.vehicles : [], doc = (Array.isArray(ex.docs) && ex.docs[0]) || {};
    const have = haveImages(rec), exp = expPages(rec), reasons = [];
    if (exp > have) reasons.push({ code: 'pages', text: 'Phiếu ' + exp + ' mặt nhưng chỉ lưu ' + have + ' ảnh' });
    const maxStt = vs.reduce((m, v) => Math.max(m, Number(v.stt) || 0), 0), target = Math.max(maxStt, Number(doc.declaredTotal) || 0);
    if (target > vs.length) reasons.push({ code: 'few', text: 'Chỉ đọc được ' + vs.length + ' xe, nhưng STT lớn nhất/số xe khai là ' + target });
    const withStt = vs.filter(v => Number(v.stt) > 0).length;
    if (withStt >= vs.length / 2 && maxStt > 1) {
      const set = new Set(vs.map(v => Number(v.stt))); let miss = 0; for (let i = 1; i <= maxStt; i++) if (!set.has(i)) miss++;
      if (miss) reasons.push({ code: 'gap', text: 'Thiếu ' + miss + ' STT trong dãy 1–' + maxStt });
    }
    if (Array.isArray(doc.missingStt) && doc.missingStt.length && !reasons.some(x => x.code === 'gap')) reasons.push({ code: 'gap', text: 'Thiếu STT: ' + doc.missingStt.slice(0, 8).join(', ') });
    if (typeof rec.geminiRaw === 'string' && rec.geminiRaw && rec.geminiRaw.indexOf('---CHUNK') < 0) {
      try { JSON.parse(rec.geminiRaw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()); } catch (e) { reasons.push({ code: 'parse', text: 'JSON Gemini bị cắt/lỗi parse' }); }
    }
    if (have > 2 && !ex.boxPerPage && vs.some(v => !hasBox(v))) reasons.push({ code: 'nobox', text: 'Phiếu nhiều mặt nhưng xe chưa có khung theo trang' });
    if (vs.length >= 8 && have <= 2 && !ex.boxPerPage) reasons.push({ code: 'many2', text: vs.length + ' xe nhưng chỉ còn ' + have + ' ảnh — có thể còn mặt khác' });
    const stBad = vs.filter(v => (v.tinhTrang === 'da_ban_chua_sang_ten' || v.statusCode === 'ban_chua_sang_ten') && looksKhongRo((v.tinhTrangGhiTrenPhieu || '') + ' ' + (v.statusRaw || '') + ' ' + (v.ghiChu || ''))).length;
    const fixLocal = stBad > 0 ? ('Có ' + stBad + ' xe «không rõ người sử dụng» đang mang mã «chưa sang tên» (tự sửa khi mở phiếu, không cần quét lại)') : '';
    return { reasons, needGemini: reasons.length > 0, have, exp, fixLocal };
  }

  async function allRecs() {
    const db = await DB.openDb(), out = [];
    await new Promise((res, rej) => {
      const rq = db.transaction(ST_SCANS, 'readonly').objectStore(ST_SCANS).openCursor();
      rq.onsuccess = () => { const c = rq.result; if (!c) { res(); return; } const r = c.value; if (r && r.status === 'done' && !r.isTest && r.extracted && (r.frontBlob || !r.cloud)) out.push(r); c.continue(); };
      rq.onerror = () => rej(rq.error);
    });
    return out;
  }
  async function queueFiles() {   // tên file → File[] (từ scanQueue ':files'); chỉ PDF
    const map = new Map();
    try {
      const all = await DB.dbGetAll(ST_QUEUE);
      for (const m of all.filter(r => r.kind === 'meta' && r.type === 'pdf')) {
        const f = all.find(r => r.id === m.id + ':files');
        if (f && f.files && f.files[0]) map.set(m.name, f.files[0]);
      }
    } catch (e) { /* bỏ qua */ }
    return map;
  }
  /*QP:Q5-4*/ async function scanAll() {
    const recs = await allRecs(), files = await queueFiles(), queue = [], need = {};
    for (const rec of recs) {
      const d = detect(rec); if (!d.needGemini) continue;
      if (st.done[rec.id] || (st.failed[rec.id] && st.failed[rec.id].n >= 2)) continue;
      const codes = d.reasons.map(x => x.code), onlyCheap = codes.every(c => c === 'parse' || c === 'nobox');
      if (d.have >= 3 || onlyCheap || files.has(rec.fileName)) queue.push(rec.id);
      else need[rec.id] = { fileName: rec.fileName || '', pagesDesc: rec.pagesDesc || '', start: startPage(rec), hash: rec.frontHash || '', reasons: d.reasons.map(x => x.text), label: rec.sheetLabel || '' };
    }
    st.queue = queue; st.need = need; st.lastScan = Date.now(); save(); render();
    return { queue: queue.length, need: Object.keys(need).length, total: recs.length };
  }

  /* ---------------- QUÉT 1 PHIẾU ---------------- */
  const b64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
  const prep = async (blob, mime) => ({ blob, mime: mime || blob.type || 'image/jpeg', base64: await b64(blob) });
  const keep = (p) => ({ blob: p.blob, mime: p.mime });

  // Render toàn bộ nhóm trang bắt đầu ở trang `start` của PDF (nhóm do AI chia, cửa sổ tối đa 30 trang)
  async function renderSheetFromPdf(file, start, onSay) {
    const doc = await S.openPdf(file), n = doc.numPages, st0 = await S.settings.loadSettings();
    start = Math.min(Math.max(1, start), n);
    const end = Math.min(n, start + 29), low = [];
    for (let no = start; no <= end; no++) low.push(await S.renderPdfPage(doc, no, 800, file.name, S.MAX_IMG_BYTES));
    onSay && onSay('Chia nhóm trang (' + low.length + ' trang)…');
    const seg = await S.autoSegmentPages(low), g = (seg && seg.groups && seg.groups[0]) || { startPage: 1, endPage: 1 };
    const last = Math.max(1, Math.min(low.length, g.endPage || 1)), nums = [];
    for (let no = start; no < start + last; no++) nums.push(no);
    const cap = S.pageBytesCap(nums.length), pages = [];
    for (const no of nums) pages.push(await S.renderPdfPage(doc, no, st0.maxEdgePx, file.name, cap));
    return { pages, nums };
  }

  /*QP:Q5-5*/ async function processOne(id, via) {   // via: {file, start} khi nạp lại file gốc
    const rec = await DB.dbGet(ST_SCANS, id); if (!rec || rec.status !== 'done') return { skip: true };
    const d = detect(rec); if (!d.needGemini && !via) return { skip: true };
    let pages, opts = {}, how = 'ảnh đã lưu';
    const say = (m) => { st.cur = m; render(); };
    if (via) {
      how = 'file gốc'; const r = await renderSheetFromPdf(via.file, via.start || startPage(rec), say);
      pages = r.pages; opts = { extraBlobs: pages.slice(2).map(keep), pagesDesc: 'tr.' + r.nums[0] + (r.nums.length > 1 ? '-' + r.nums[r.nums.length - 1] : ''), pageCount: pages.length };
      if (pages[1]) { opts.backBlob = pages[1].blob; opts.backMime = pages[1].mime; }
    } else if (d.have >= 3 || d.reasons.every(x => x.code === 'parse' || x.code === 'nobox')) {
      pages = [await prep(rec.frontBlob, rec.frontMime)];
      if (rec.backBlob) pages.push(await prep(rec.backBlob, rec.backMime));
      for (const x of (rec.extraBlobs || [])) if (x && x.blob) pages.push(await prep(x.blob, x.mime));
    } else {
      const f = (await queueFiles()).get(rec.fileName); if (!f) return { needFile: true };
      how = 'file trong hàng đợi'; const r = await renderSheetFromPdf(f, startPage(rec), say);
      pages = r.pages; opts = { extraBlobs: pages.slice(2).map(keep), pagesDesc: 'tr.' + r.nums[0] + (r.nums.length > 1 ? '-' + r.nums[r.nums.length - 1] : ''), pageCount: pages.length };
      if (pages[1]) { opts.backBlob = pages[1].blob; opts.backMime = pages[1].mime; }
    }
    say('Gemini đọc ' + pages.length + ' trang…');
    const res = await S.analyzeSheet({ pages, onStatus: (m) => say(m), priority: via ? undefined : 'low' });
    if (!window.ScanReview || !ScanReview.rescanMerge) throw new Error('Thiếu ScanReview.rescanMerge');
    const out = await ScanReview.rescanMerge(id, res, opts);
    return { out, how, pages: pages.length };
  }

  const userBusy = () => {
    if (S.isBusy && S.isBusy()) return 'bạn đang quét phiếu';
    const rm = q('#rvRescanModal'); if (rm && !rm.classList.contains('hidden')) return 'bạn đang xem bảng quét lại';
    const a = window.AIRecheckUI && AIRecheckUI.state && AIRecheckUI.state();
    if (a && (a.status === 'running' || a.status === 'waiting')) return 'AI đang kiểm lại';
    if (navigator.onLine === false) return 'mất mạng';
    return '';
  };

  async function tick() {
    if (running || st.paused || Date.now() < (st.blockUntil || 0) || userBusy()) return;
    try {
      const keys = await S.keys.listKeys(); if (!keys.some(k => k.enabled && k.status !== 'invalid')) return;
      if (!st.queue.length && Date.now() - (st.lastScan || 0) > RESCAN_EVERY_MS) { const r = await scanAll(); log('Rà soát ' + r.total + ' phiếu: ' + r.queue + ' cần quét lại, ' + r.need + ' cần nạp lại file gốc.'); }
      const id = st.queue[0]; if (!id) return;
      running = true; render();
      try {
        const r = await processOne(id);
        st.queue = st.queue.filter(x => x !== id);
        if (r && r.needFile) { const rec = await DB.dbGet(ST_SCANS, id); const d = rec ? detect(rec) : { reasons: [] }; if (rec) st.need[id] = { fileName: rec.fileName || '', pagesDesc: rec.pagesDesc || '', start: startPage(rec), hash: rec.frontHash || '', reasons: d.reasons.map(x => x.text), label: rec.sheetLabel || '' }; }
        else if (r && r.out) { st.done[id] = { at: Date.now(), how: r.how, out: r.out }; log('✔ Quét lại (' + r.how + ', ' + r.pages + ' trang): ' + r.out.vehicles + ' xe · +' + r.out.added + ' mới · ' + r.out.changed + ' ô đổi · ' + r.out.proposals + ' đề xuất chờ xem.'); }
        else st.done[id] = { at: Date.now(), how: 'bỏ qua' };
      } catch (e) {
        const kind = e && e.kind;
        if (kind === 'quota' || kind === 'nokey' || kind === 'nomodel') { st.blockUntil = Date.now() + BLOCK_MS; log('Tạm nghỉ 30 phút: ' + (e.message || kind)); }
        else if (kind === 'cancelled') { /* giữ nguyên hàng đợi */ }
        else { const f = st.failed[id] || { n: 0 }; f.n++; f.msg = String(e && e.message || e).slice(0, 160); st.failed[id] = f; if (f.n >= 2) st.queue = st.queue.filter(x => x !== id); log('✘ Lỗi quét lại: ' + f.msg); }
      } finally { running = false; st.cur = ''; save(); render(); }
    } catch (e) { running = false; console.warn('[ScanAudit] tick', e); }
  }

  /* ---------------- NẠP LẠI FILE GỐC ---------------- */
  /*QP:Q5-6*/ async function reloadFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) { alert('Chỉ nạp lại được file PDF gốc.'); return; }
    const ids = Object.keys(st.need); if (!ids.length) { log('Không có phiếu nào đang chờ nạp lại file gốc.'); return; }
    const st0 = await S.settings.loadSettings(); let okN = 0;
    for (const file of files) {
      let doc; try { doc = await S.openPdf(file); } catch (e) { log('Không mở được ' + file.name + ': ' + (e.message || e)); continue; }
      const cache = new Map(), hashOf = async (no) => { if (!cache.has(no)) { const p = await S.renderPdfPage(doc, no, st0.maxEdgePx, file.name, S.MAX_IMG_BYTES); cache.set(no, await S.sha256Hex(p.blob)); } return cache.get(no); };
      let full = null;   // bảng hash toàn bộ trang (chỉ dựng khi cần)
      for (const id of ids.slice()) {
        const nd = st.need[id]; if (!nd) continue;
        let start = 0, by = '';
        if (nd.fileName === file.name && nd.start <= doc.numPages) {
          if (nd.hash && await hashOf(nd.start) === nd.hash) { start = nd.start; by = 'hash mặt 1'; }
          else if (nd.hash) { if (!full) { full = new Map(); for (let no = 1; no <= doc.numPages; no++) full.set(await hashOf(no), no); log('Đã băm ' + doc.numPages + ' trang của ' + file.name); } if (full.has(nd.hash)) { start = full.get(nd.hash); by = 'hash mặt 1'; } }
          if (!start && confirm('Phiếu «' + (nd.label || nd.fileName) + '» (' + nd.pagesDesc + '): hash mặt 1 KHÔNG khớp (có thể do đổi cài đặt kích thước ảnh).\nVẫn ghép theo tên file + số trang ' + nd.start + '?')) { start = nd.start; by = 'tên file + số trang (đã xác nhận)'; }
        } else if (nd.hash) {
          if (!full) { full = new Map(); for (let no = 1; no <= doc.numPages; no++) full.set(await hashOf(no), no); log('Đã băm ' + doc.numPages + ' trang của ' + file.name); }
          if (full.has(nd.hash)) { start = full.get(nd.hash); by = 'hash mặt 1 (khác tên file)'; }
        }
        if (!start) continue;
        log('Nhận ra phiếu cũ «' + (nd.label || nd.fileName) + '» theo ' + by + ' → trang ' + start + '. Đang quét lại đủ mặt…');
        try {
          const r = await processOne(id, { file, start });
          if (r && r.out) { st.done[id] = { at: Date.now(), how: 'nạp lại file gốc', out: r.out }; delete st.need[id]; st.queue = st.queue.filter(x => x !== id); okN++; log('✔ Đã ghép vào CHÍNH phiếu cũ (' + r.pages + ' mặt): ' + r.out.vehicles + ' xe · +' + r.out.added + ' mới · ' + r.out.changed + ' ô đổi · ' + r.out.proposals + ' đề xuất.'); }
        } catch (e) { log('✘ ' + (e.message || e)); if (e && (e.kind === 'quota' || e.kind === 'nokey')) return; }
        save(); render();
      }
    }
    log(okN ? 'Xong: ghép ' + okN + ' phiếu.' : 'Không nhận ra phiếu cũ nào trong file đã chọn (kiểm tra đúng file gốc).');
  }

  /* ---------------- GIAO DIỆN ---------------- */
  function ensureChip() {
    let c = q('#scanAuditChip'); if (c && c.isConnected) return c;
    const a = q('#aiRecheckChip') || q('#scanBgChip'); if (!a || !a.parentNode) return null;
    c = document.createElement('button'); c.type = 'button'; c.id = 'scanAuditChip'; c.className = 'ai-chip chip-idle hidden';
    c.addEventListener('click', openDlg); a.parentNode.insertBefore(c, a.nextSibling); return c;
  }
  function ensureDlg() {
    if (dlg && dlg.isConnected) return dlg;
    dlg = document.createElement('dialog'); dlg.id = 'scanAuditDlg'; dlg.className = 'ai-dlg';
    dlg.innerHTML = `<div class="ai-dlg-head"><h3>🔧 Quét lại phiếu cũ sai/thiếu</h3><button type="button" class="btn btn-ghost btn-sm" data-au="close">✕</button></div>
<div class="ai-dlg-body"><div class="hint" style="margin-bottom:6px">Hệ thống tự rà phiếu đã quét và quét lại NGẦM (nhường khi bạn đang quét). Ô bạn đã sửa tay / khóa / đã áp dụng lên Sheet được giữ nguyên; thay đổi quan trọng nằm trong bộ lọc «chưa chắc chắn».<br><b>Giới hạn:</b> phiếu cũ chỉ còn ảnh 2 mặt thì không thể tự quét đủ — cần «Nạp lại file gốc».</div>
<div id="auStatus" class="hint"></div><div id="auNeed"></div>
<div class="ai-dlg-loghead">Nhật ký</div><pre class="ai-dlg-log" id="auLog"></pre>
<div class="ai-dlg-actions"><input type="file" id="auFile" accept="application/pdf,.pdf" multiple style="display:none">
<button type="button" class="btn btn-secondary btn-sm" data-au="reload">📂 Nạp lại file gốc…</button>
<button type="button" class="btn btn-ghost btn-sm" data-au="scan">🔍 Rà soát ngay</button>
<button type="button" class="btn btn-ghost btn-sm" data-au="toggle"></button></div></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', async (e) => {
      if (e.target === dlg) { dlg.close(); return; }
      const b = e.target.closest('[data-au]'); if (!b) return; const a = b.dataset.au;
      if (a === 'close') dlg.close();
      else if (a === 'reload') q('#auFile').click();
      else if (a === 'scan') { const r = await scanAll(); log('Rà soát ' + r.total + ' phiếu: ' + r.queue + ' cần quét lại, ' + r.need + ' cần nạp lại file gốc.'); }
      else if (a === 'toggle') { st.paused = !st.paused; save(); render(); }
    });
    dlg.querySelector('#auFile').addEventListener('change', async (e) => { const fs = e.target.files; await reloadFiles(fs); e.target.value = ''; });
    return dlg;
  }
  function openDlg() { ensureDlg().showModal(); render(); }
  function render() {
    const nNeed = Object.keys(st.need).length, nQ = st.queue.length, c = ensureChip();
    if (c) {
      const show = running || nQ || nNeed;
      c.classList.toggle('hidden', !show);
      c.classList.remove('chip-idle', 'chip-run', 'chip-wait', 'chip-pause');
      c.classList.add(running ? 'chip-run' : (st.paused ? 'chip-pause' : (nNeed && !nQ ? 'chip-wait' : 'chip-idle')));
      c.textContent = running ? '🔧 Đang quét lại phiếu cũ' + (st.cur ? ' · ' + st.cur.slice(0, 40) : '') : ('🔧 Phiếu cũ: ' + nQ + ' chờ quét lại' + (nNeed ? ' · ' + nNeed + ' cần nạp file gốc' : '') + (st.paused ? ' (tạm dừng)' : ''));
      c.title = 'Bấm để xem chi tiết';
    }
    if (!dlg || !dlg.open) return;
    q('#auStatus').innerHTML = `Đang chờ quét lại: <b>${nQ}</b> · Cần nạp lại file gốc: <b>${nNeed}</b> · Đã xử lý: <b>${Object.keys(st.done).length}</b> · Lỗi: <b>${Object.keys(st.failed).length}</b>${st.blockUntil > Date.now() ? ' · <span class="error-text">tạm nghỉ đến ' + new Date(st.blockUntil).toLocaleTimeString('vi-VN') + '</span>' : ''}${running ? '<br>⏳ ' + esc(st.cur) : ''}`;
    q('#auNeed').innerHTML = nNeed ? '<div class="ai-dlg-loghead">Cần nạp lại file gốc</div>' + Object.values(st.need).slice(0, 40).map(n => `<div class="hint">• <b>${esc(n.label || n.fileName)}</b> (${esc(n.pagesDesc)}) — ${esc(n.reasons.join('; '))}</div>`).join('') : '';
    q('#auLog').textContent = (st.log || []).slice().reverse().join('\n') || '(chưa có)';
    q('[data-au="toggle"]').textContent = st.paused ? '▶ Tiếp tục chạy ngầm' : '⏸ Tạm dừng chạy ngầm';
  }

  (async () => {
    await load();
    const boot = () => { render(); setTimeout(() => { tick(); timer = setInterval(tick, TICK_MS); }, 15000); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  })();

  return { detect, scanAll, tick, reloadFiles, state: () => st, open: openDlg };
})();
window.ScanAudit = ScanAudit;
