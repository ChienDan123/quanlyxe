/* =========================================================================
   scan-relayout.js — RÀ PHIẾU CŨ + GHÉP LẠI NHIỀU PHIẾU CÙNG 1 FILE THÀNH 1 PHIẾU NHIỀU TRANG   [dấu nhận diện: NM:P6-*]
   Nạp SAU scan-audit.js (cần ScanApp, ScanReview, tuỳ chọn ScanDisk / ScanSync), TRƯỚC layout.js.
   Làm gì:
     • Phát hiện nhóm phiếu cũ CÙNG 1 FILE NGUỒN bị cắt thành nhiều phiếu liên tiếp (VD phiếu 9 trang bị cắt thành các «phiếu» 2 mặt).
       Bằng chứng «chắc»: (H) tên file «_N_mat» = đúng dải trang của các phiếu con; (S) STT của phiếu sau nối tiếp STT cuối phiếu trước.
       Bằng chứng «chưa chắc»: phiếu sau không có xe nào (trang điều khoản/chữ ký lẻ). Nhóm chưa chắc CHỈ chạy khi người dùng bật «gồm cả nhóm chưa chắc».
     • Ghép: lấy ảnh các trang từ IndexedDB → thư mục ổ D (ScanDisk.read) → Drive (ScanSync.ensureBlobs); thiếu ảnh → BỎ QUA kèm lý do.
       Quét lại bằng pipeline hiện có (S.analyzeSheet), rồi gộp vào PHIẾU ĐẦU của nhóm bằng ScanReview.rescanMerge:
       mục của các phiếu sau được chuyển (đổi trang) sang phiếu đầu TRƯỚC khi gộp → ô đã sửa tay / đã kiểm / đã khoá / đã áp dụng được GIỮ, chỉ thay phần máy đọc.
     • Phiếu sau bị đánh dấu rec.superseded = {by, at} (KHÔNG xoá cứng); toàn bộ mục trước khi ghép được lưu ở phiếu đầu (rec.relayoutUndo) → «↩ Hoàn tác».
     • Chạy NGẦM, ưu tiên thấp (priority 'low', nhường khi người dùng đang quét / AI kiểm lại / mở bảng quét lại), tiến độ lưu bền, tải lại trang tự chạy tiếp.
     • Thử khô: báo số nhóm sẽ ghép + ước tính số lần gọi Gemini + nhóm không đủ ảnh. Có Tạm dừng / Tiếp tục / Dừng.
   ========================================================================= */
const ScanRelayout = (() => {
  'use strict';
  const S = window.ScanApp;
  if (!S) { console.warn('[ScanRelayout] thiếu ScanApp'); return null; }
  const DB = S.db, ST_SCANS = DB.ST_SCANS, ST_ITEMS = DB.ST_ITEMS;
  const KEY = 'scanRelayoutStateV1', TICK_MS = 20000, NEXT_MS = 3000, BLOCK_MS = 30 * 60 * 1000, MAX_PAGES = 40;
  const q = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const defState = () => ({ v: 1, active: false, paused: false, includeWeak: false, groups: {}, failed: {}, blockUntil: 0, report: null, log: [], cur: '' });
  let st = defState(), running = false, saveT = 0, dlg = null, tickT = 0, cache = { at: 0, groups: null };

  /*NM:P6-1*/ // lưu tiến độ bền (cùng cách scan-audit.js: idbGet/idbSet toàn cục, dự phòng localStorage)
  async function load() {
    let v = null;
    try { if (typeof idbGet === 'function') v = await idbGet(KEY); } catch (e) { /* bỏ qua */ }
    if (!v) { try { v = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* bỏ qua */ } }
    if (v && typeof v === 'object') st = Object.assign(defState(), v);
    st.cur = '';
  }
  function save() {
    if (saveT) return;
    saveT = setTimeout(async () => {
      saveT = 0;
      try { if (typeof idbSet === 'function') { await idbSet(KEY, st); return; } } catch (e) { /* thử localStorage */ }
      try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* bỏ qua */ }
    }, 300);
  }
  const nowS = () => new Date().toLocaleTimeString('vi-VN');
  function log(m) { st.log = (st.log || []).concat([nowS() + ' · ' + m]).slice(-20); save(); render(); }

  /* ---------------- PHÁT HIỆN NHÓM (hàm THUẦN — kiểm thử được) ---------------- */
  /*NM:P6-2*/
  function rangeOf(r) {
    const d = String(r.pagesDesc || '');
    let m = /tr\.\s*(\d+)\s*[-–]\s*(\d+)/.exec(d);
    if (m) return { a: +m[1], b: +m[2] };
    m = /tr\.\s*(\d+)/.exec(d);
    return m ? { a: +m[1], b: +m[1] } : null;
  }
  const hintOf = (name) => { const m = /_(\d{1,3})_?m[aặ]t/i.exec(String(name || '')); return m ? parseInt(m[1], 10) : 0; };
  const sttsOf = (r) => ((r.extracted && Array.isArray(r.extracted.vehicles)) ? r.extracted.vehicles : []).map(v => Number(v.stt)).filter(n => Number.isFinite(n) && n > 0);
  const nVeh = (r) => (r.extracted && Array.isArray(r.extracted.vehicles)) ? r.extracted.vehicles.length : 0;
  function linkKind(p, c) {
    const sp = sttsOf(p), sc = sttsOf(c);
    if (sp.length && sc.length && Math.min.apply(null, sc) === Math.max.apply(null, sp) + 1) return 'stt';
    if (!nVeh(c) && nVeh(p)) return 'tail';
    return '';
  }
  function mkGroup(fileName, items, strong, why, hint) {
    const ids = items.map(x => x.r.id);
    return { key: fileName + '|' + ids.map(i => i.slice(0, 8)).join(','), fileName, ids, total: items[items.length - 1].rg.b - items[0].rg.a + 1, start: items[0].rg.a, strong, why, hint: hint || 0 };
  }
  function groupRecs(recs) {
    const by = new Map();
    for (const r of recs) {
      const rg = rangeOf(r);
      if (!rg || / \+ /.test(r.fileName || '')) continue;   // chỉ PDF (nhóm ảnh rời có tên «a + b» bỏ qua)
      const k = r.fileName || '';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ r, rg });
    }
    const out = [];
    for (const [fileName, arr] of by) {
      arr.sort((x, y) => x.rg.a - y.rg.a || x.rg.b - y.rg.b);
      const hint = hintOf(fileName);
      const contiguous = arr.every((x, i) => i === 0 || x.rg.a === arr[i - 1].rg.b + 1);
      if (hint > 1 && arr.length >= 2 && contiguous && arr[0].rg.a === 1 && arr[arr.length - 1].rg.b === hint) {
        out.push(mkGroup(fileName, arr, true, 'Tên file gợi ý ' + hint + ' mặt = đúng dải trang của ' + arr.length + ' phiếu con', hint));
        continue;
      }
      let run = { items: [arr[0]], weak: false, why: [] };
      const flush = () => { if (run.items.length >= 2) out.push(mkGroup(fileName, run.items, !run.weak, run.why.join('; '), hint)); };
      for (let i = 1; i < arr.length; i++) {
        const p = arr[i - 1], c = arr[i];
        const k = c.rg.a === p.rg.b + 1 ? linkKind(p.r, c.r) : '';
        if (k) { run.items.push(c); if (k === 'tail') run.weak = true; run.why.push(k === 'stt' ? 'STT nối tiếp (' + (i) + '→' + (i + 1) + ')' : 'phiếu ' + (i + 1) + ' không có xe (trang cuối lẻ)'); }
        else { flush(); run = { items: [c], weak: false, why: [] }; }
      }
      flush();
    }
    return out;
  }
  async function allRecs() {
    const db = await DB.openDb(), out = [];
    await new Promise((res, rej) => {
      const rq = db.transaction(ST_SCANS, 'readonly').objectStore(ST_SCANS).openCursor();
      rq.onsuccess = () => { const c = rq.result; if (!c) { res(); return; } const r = c.value; if (r && r.status === 'done' && !r.isTest && !r.superseded && r.extracted) out.push(r); c.continue(); };
      rq.onerror = () => rej(rq.error);
    });
    return out;
  }
  async function findGroups(force) {
    if (!force && cache.groups && Date.now() - cache.at < 60000) return cache.groups;
    const gs = groupRecs(await allRecs());
    cache = { at: Date.now(), groups: gs };
    return gs;
  }

  /* ---------------- LẤY ẢNH CÁC TRANG CỦA 1 PHIẾU ---------------- */
  /*NM:P6-3*/ // IndexedDB → thư mục ổ D (ScanDisk.read) → Drive (ScanSync.ensureBlobs). Thiếu → {err}
  const expectedOf = (r) => Math.max(1, Number(r.pageCount) || Number(r.pages) || ((rangeOf(r) && (rangeOf(r).b - rangeOf(r).a + 1)) || 1));
  const localPages = (r) => {
    const p = [];
    if (r.frontBlob) p.push({ blob: r.frontBlob, mime: r.frontMime || r.frontBlob.type });
    if (r.backBlob) p.push({ blob: r.backBlob, mime: r.backMime || r.backBlob.type });
    (r.extraBlobs || []).forEach(x => { if (x && x.blob) p.push({ blob: x.blob, mime: x.mime || x.blob.type }); });
    return p;
  };
  const sideOf = (i) => i === 0 ? 'front' : i === 1 ? 'back' : 'p' + (i + 1);
  async function pagesOf(rec) {
    const n = expectedOf(rec);
    let pages = localPages(rec);
    if (pages.length >= n) return { pages: pages.slice(0, n) };
    if (window.ScanDisk && ScanDisk.ready && ScanDisk.ready()) {
      const out = [];
      for (let i = 0; i < n; i++) {
        let it = (i === 0 && rec.frontBlob) ? { blob: rec.frontBlob, mime: rec.frontMime } : (i === 1 && rec.backBlob) ? { blob: rec.backBlob, mime: rec.backMime } : (i >= 2 && rec.extraBlobs && rec.extraBlobs[i - 2] && rec.extraBlobs[i - 2].blob) ? rec.extraBlobs[i - 2] : null;
        if (!it) { try { const f = await ScanDisk.read(rec.id, sideOf(i)); if (f && f.size) it = { blob: f, mime: f.type || 'image/jpeg' }; } catch (e) { /* bỏ qua */ } }
        if (!it) { out.length = 0; break; }
        out.push({ blob: it.blob, mime: it.mime || it.blob.type || 'image/jpeg' });
      }
      if (out.length >= n) return { pages: out };
    }
    if (window.ScanSync && ScanSync.ensureBlobs && rec.cloud) {
      try { const r2 = await ScanSync.ensureBlobs(rec); if (r2) { pages = localPages(r2); if (pages.length >= n) return { pages: pages.slice(0, n) }; } } catch (e) { /* bỏ qua */ }
    }
    return { err: 'Phiếu ' + rec.id.slice(0, 8) + ' chỉ lấy được ' + pages.length + '/' + n + ' ảnh (không có ở máy / thư mục ổ D / Drive)' };
  }
  function avail(rec) {
    const n = expectedOf(rec), have = localPages(rec).length;
    if (have >= n) return 'local';
    if ((window.ScanDisk && ScanDisk.ready && ScanDisk.ready()) || rec.cloud) return 'maybe';
    return 'none';
  }

  /* ---------------- THỬ KHÔ ---------------- */
  /*NM:P6-4*/
  async function dryRun() {
    const groups = await findGroups(true), recs = await allRecs(), byId = new Map(recs.map(r => [r.id, r]));
    const rows = groups.map(g => {
      const av = g.ids.map(id => avail(byId.get(id) || {})), worst = av.includes('none') ? 'none' : (av.includes('maybe') ? 'maybe' : 'local');
      return { key: g.key, fileName: g.fileName, phieu: g.ids.length, total: g.total, strong: g.strong, why: g.why, avail: worst };
    });
    const doable = rows.filter(r => r.avail !== 'none' && r.total <= MAX_PAGES && (r.strong || st.includeWeak) && !(st.groups[r.key] && ['done', 'undone'].includes(st.groups[r.key].status)));
    const calls = doable.reduce((n, r) => n + Math.ceil(r.total / 3) + 1, 0);   // mỗi khúc 3 trang + 1 lượt đối soát STT thiếu
    st.report = { at: Date.now(), strong: rows.filter(r => r.strong).length, weak: rows.filter(r => !r.strong).length, doable: doable.length, calls, noImg: rows.filter(r => r.avail === 'none').length, tooBig: rows.filter(r => r.total > MAX_PAGES).length, rows: rows.slice(0, 60) };
    save(); render();
    log('Thử khô: ' + rows.length + ' nhóm nghi sai (' + st.report.strong + ' chắc, ' + st.report.weak + ' chưa chắc); sẽ ghép ' + doable.length + ' nhóm, ước tính ~' + calls + ' lần gọi Gemini.');
    return st.report;
  }

  /* ---------------- GHÉP 1 NHÓM ---------------- */
  /*NM:P6-5*/
  const b64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
  const prep = async (p) => ({ blob: p.blob, mime: p.mime || p.blob.type || 'image/jpeg', base64: await b64(p.blob) });
  const itemsOf = async (scanId) => (await DB.tx(ST_ITEMS, 'readonly', os => os.index('scanId').getAll(scanId))) || [];
  async function restoreItems(targetId, backup) {
    for (const it of await itemsOf(targetId)) await DB.dbDelete(ST_ITEMS, it.id);
    for (const it of backup) await DB.dbPut(ST_ITEMS, it);
  }
  const rolesOf = (vs, n) => {
    const tp = Array.from(new Set(vs.map(v => Number(v.page) || 1))).sort((a, b) => a - b), last = tp.length ? tp[tp.length - 1] : 0, out = [];
    for (let p = 1; p <= n; p++) { const r = []; if (p === 1) r.push('dau_phieu'); if (tp.includes(p)) r.push('bang_xe'); if (p === n && n > 1) r.push('chu_ky'); if (!r.length) r.push(p > last ? 'dieu_khoan' : 'trang'); out.push({ n: p, roles: r }); }
    return { roles: out, tablePages: tp };
  };
  async function mergeGroup(g, say) {
    const recs = [];
    for (const id of g.ids) {
      const r = await DB.dbGet(ST_SCANS, id);
      if (!r || r.status !== 'done' || r.superseded) return { skip: 'Phiếu ' + id.slice(0, 8) + ' đã đổi hoặc không còn — rà lại' };
      recs.push(r);
    }
    if (!window.ScanReview || !ScanReview.rescanMerge) throw new Error('Thiếu ScanReview.rescanMerge');
    const target = recs[0], all = [], offsets = [];
    for (const r of recs) {
      const pg = await pagesOf(r);
      if (pg.err) return { skip: pg.err };
      offsets.push(all.length); all.push.apply(all, pg.pages);
    }
    if (all.length > MAX_PAGES) return { skip: 'Nhóm ' + all.length + ' trang (> ' + MAX_PAGES + ') — cần người xem' };
    say('Chuẩn bị ' + all.length + ' trang…');
    const pages = []; for (const p of all) pages.push(await prep(p));
    say('Gemini đọc ' + pages.length + ' trang…');
    const res = await S.analyzeSheet({ pages, onStatus: (m) => say(m), priority: 'low' });   // ưu tiên thấp
    // sao lưu TOÀN BỘ mục của cả nhóm (hoàn tác + khôi phục khi lỗi)
    const backup = []; for (const r of recs) (await itemsOf(r.id)).forEach(it => backup.push(JSON.parse(JSON.stringify(it))));
    const before = { pages: target.pages, pageCount: target.pageCount, pagesHash: target.pagesHash, pageHashes: target.pageHashes, pagesDesc: target.pagesDesc, layout: target.layout, extraLen: (target.extraBlobs || []).length, hadBack: !!target.backBlob };
    const have = new Set((await itemsOf(target.id)).map(i => i.id));
    let out;
    try {
      for (let i = 1; i < recs.length; i++) {   // chuyển mục của phiếu sau sang phiếu đầu (đổi trang) — rescanMerge sẽ ghép theo biển số và GIỮ dữ liệu người dùng
        const off = offsets[i];
        for (const it of await itemsOf(recs[i].id)) {
          const pos = String(it.id).indexOf('|'), sfx = pos >= 0 ? String(it.id).slice(pos + 1) : (it.bienSo || ('#stt-' + it.stt));
          let nid = target.id + '|' + sfx; if (have.has(nid)) nid += '~r' + i;
          have.add(nid);
          const n2 = Object.assign({}, it, { id: nid, scanId: target.id, page: (Number(it.page) || 1) + off, pageNo: (Number(it.pageNo) || Number(it.page) || 1) + off });
          if (n2.boxOv && n2.boxOv.page) n2.boxOv = Object.assign({}, n2.boxOv, { page: Number(n2.boxOv.page) + off });
          await DB.dbPut(ST_ITEMS, n2); await DB.dbDelete(ST_ITEMS, it.id);
        }
      }
      const opts = { extraBlobs: pages.slice(2).map(p => ({ blob: p.blob, mime: p.mime })), pagesDesc: 'tr.' + g.start + '-' + (g.start + pages.length - 1), pageCount: pages.length };
      if (pages[1]) { opts.backBlob = pages[1].blob; opts.backMime = pages[1].mime; }
      out = await ScanReview.rescanMerge(target.id, res, opts);
    } catch (e) {
      try { await restoreItems(target.id, backup); } catch (x) { console.warn('[ScanRelayout] khôi phục mục lỗi', x); }
      throw e;
    }
    // hoàn tất: băm cả bộ + bố cục + đánh dấu phiếu bị thay thế
    const hashes = []; for (const p of pages) hashes.push((await S.sha256Hex(p.blob)) || '');
    const rec = await DB.dbGet(ST_SCANS, target.id);
    const vs = (res.extracted && Array.isArray(res.extracted.vehicles)) ? res.extracted.vehicles : [], ro = rolesOf(vs, pages.length);
    rec.pagesHash = await S.sha256Hex(new Blob([hashes.join('|')])); rec.pageHashes = hashes; rec.pageCount = pages.length; rec.pages = pages.length;
    rec.layout = { auto: true, conf: g.strong ? 0.85 : 0.5, pages: ro.roles, tablePages: ro.tablePages, hintFromName: g.hint || 0, inferred: true, relayout: true, issues: g.strong ? [] : ['Nhóm ghép chưa chắc chắn — cần người xem'] };
    rec.relayout = { at: Date.now(), from: g.ids.slice(), offsets };
    rec.relayoutUndo = { at: Date.now(), from: g.ids.slice(), items: backup, before };
    await DB.dbPut(ST_SCANS, rec);
    for (let i = 1; i < recs.length; i++) { const r = await DB.dbGet(ST_SCANS, recs[i].id); if (r) { r.superseded = { by: target.id, at: Date.now() }; await DB.dbPut(ST_SCANS, r); } }
    if (window.ScanDisk && ScanDisk.writeRec) { try { Promise.resolve(ScanDisk.writeRec(rec)).catch(() => {}); } catch (e) { /* bỏ qua */ } }
    if (window.ScanSync && ScanSync.touch) { try { ScanSync.touch(target.id); } catch (e) { /* bỏ qua */ } }
    if (ScanReview.afterRemoteMerge) { try { await ScanReview.afterRemoteMerge(Array.from(new Set(backup.map(i => i.bienSo).filter(Boolean))), []); } catch (e) { /* bỏ qua */ } }
    return { out, target: target.id, pages: pages.length };
  }

  /*NM:P6-6*/ // HOÀN TÁC: đưa mục + phiếu về trước khi ghép (mục sửa SAU khi ghép sẽ mất — hỏi xác nhận ở giao diện)
  async function undo(targetId) {
    const t = await DB.dbGet(ST_SCANS, targetId);
    if (!t || !t.relayoutUndo) throw new Error('Phiếu này không có bản hoàn tác.');
    const u = t.relayoutUndo;
    await restoreItems(targetId, u.items);
    for (const id of u.from.slice(1)) { const r = await DB.dbGet(ST_SCANS, id); if (r) { delete r.superseded; await DB.dbPut(ST_SCANS, r); } }
    const b = u.before || {};
    ['pages', 'pageCount', 'pagesHash', 'pageHashes', 'pagesDesc', 'layout'].forEach(k => { if (b[k] === undefined) delete t[k]; else t[k] = b[k]; });
    if (t.prevExtracted) t.extracted = t.prevExtracted;
    t.extraBlobs = (t.extraBlobs || []).slice(0, b.extraLen || 0);
    if (!b.hadBack) { t.backBlob = null; t.backMime = null; }
    delete t.relayout; delete t.relayoutUndo;
    await DB.dbPut(ST_SCANS, t);
    Object.keys(st.groups).forEach(k => { if (st.groups[k].target === targetId) st.groups[k] = { status: 'undone', at: Date.now() }; });
    cache = { at: 0, groups: null };
    if (window.ScanSync && ScanSync.touch) { try { ScanSync.touch(targetId); } catch (e) { /* bỏ qua */ } }
    if (ScanReview.afterRemoteMerge) { try { await ScanReview.afterRemoteMerge(Array.from(new Set(u.items.map(i => i.bienSo).filter(Boolean))), []); } catch (e) { /* bỏ qua */ } }
    save(); render(); log('↩ Đã hoàn tác ghép phiếu ' + targetId.slice(0, 8) + '.');
  }

  /* ---------------- VÒNG CHẠY NGẦM ---------------- */
  /*NM:P6-7*/
  const userBusy = () => {
    if (S.isBusy && S.isBusy()) return 'bạn đang quét phiếu';
    const rm = q('#rvRescanModal'); if (rm && !rm.classList.contains('hidden')) return 'bạn đang xem bảng quét lại';
    const a = window.AIRecheckUI && AIRecheckUI.state && AIRecheckUI.state();
    if (a && (a.status === 'running' || a.status === 'waiting')) return 'AI đang kiểm lại';
    if (navigator.onLine === false) return 'mất mạng';
    return '';
  };
  const schedule = (ms) => { clearTimeout(tickT); tickT = setTimeout(tick, ms); };
  async function runOne(g) {
    running = true; render();
    const say = (m) => { st.cur = String(m || '').slice(0, 60); render(); };
    try {
      const r = await mergeGroup(g, say);
      if (r.skip) { st.groups[g.key] = { status: 'skip', reason: r.skip, at: Date.now() }; log('⏭ Bỏ qua «' + g.fileName + '» (' + g.total + ' trang): ' + r.skip); }
      else { st.groups[g.key] = { status: 'done', target: r.target, at: Date.now(), out: r.out }; log('✔ Ghép «' + g.fileName + '» thành 1 phiếu ' + r.pages + ' trang: ' + r.out.vehicles + ' xe · +' + r.out.added + ' mới · ' + r.out.changed + ' ô đổi · ' + r.out.proposals + ' đề xuất chờ xem.'); }
      cache = { at: 0, groups: null };
    } catch (e) {
      const kind = e && e.kind;
      if (kind === 'quota' || kind === 'nokey' || kind === 'nomodel') { st.blockUntil = Date.now() + BLOCK_MS; log('Tạm nghỉ 30 phút: ' + (e.message || kind)); }
      else if (kind === 'cancelled') { /* giữ nguyên, thử lại sau */ }
      else { const f = st.failed[g.key] || { n: 0 }; f.n++; f.msg = String((e && e.message) || e).slice(0, 160); st.failed[g.key] = f; if (f.n >= 2) st.groups[g.key] = { status: 'fail', reason: f.msg, at: Date.now() }; log('✘ Lỗi ghép «' + g.fileName + '»: ' + f.msg); }
    } finally { running = false; st.cur = ''; save(); render(); }
  }
  async function tick() {
    if (running || !st.active || st.paused) { if (st.active) schedule(TICK_MS); return; }
    if (Date.now() < (st.blockUntil || 0) || userBusy()) { schedule(TICK_MS); return; }
    try {
      const keys = await S.keys.listKeys();
      if (!keys.some(k => k.enabled && k.status !== 'invalid')) { schedule(TICK_MS); return; }
      const gs = await findGroups();
      const g = gs.find(x => !st.groups[x.key] && (x.strong || st.includeWeak));
      if (!g) { st.active = false; save(); log('Xong: không còn nhóm nào cần ghép.'); return; }
      await runOne(g);
      if (st.active) schedule(NEXT_MS);
    } catch (e) { console.warn('[ScanRelayout] tick', e); if (st.active) schedule(TICK_MS); }
  }
  const start = () => { st.active = true; st.paused = false; st.blockUntil = 0; save(); render(); log('Bắt đầu ghép ngầm (ưu tiên thấp).'); schedule(1000); };
  const pause = () => { st.paused = !st.paused; save(); render(); if (!st.paused) schedule(1000); };
  const stop = () => { st.active = false; st.paused = false; save(); render(); log('Đã dừng.'); };

  /* ---------------- GIAO DIỆN ---------------- */
  /*NM:P6-8*/
  function ensureDlg() {
    if (dlg && dlg.isConnected) return dlg;
    dlg = document.createElement('dialog'); dlg.id = 'scanRelayoutDlg'; dlg.className = 'ai-dlg';
    dlg.innerHTML = `<div class="ai-dlg-head"><h3>🧩 Rà phiếu cũ — ghép lại phiếu bị cắt</h3><button type="button" class="btn btn-ghost btn-sm" data-rl="close">✕</button></div>
<div class="ai-dlg-body"><div class="hint" style="margin-bottom:6px">Tìm các phiếu CÙNG 1 FILE bị cắt thành nhiều phiếu 2 mặt, ghép lại thành 1 phiếu nhiều trang rồi quét lại bằng pipeline mới. Ô bạn đã sửa tay / đã kiểm / khoá / đã áp dụng được GIỮ; phiếu cũ không bị xoá (đánh dấu «thay thế», hoàn tác được). Chạy ngầm, ưu tiên thấp.</div>
<label class="ss-check"><input type="checkbox" id="rlWeak"> Gồm cả nhóm CHƯA CHẮC CHẮN (mặc định chỉ nhóm có bằng chứng rõ)</label>
<div id="rlStatus" class="hint"></div><div id="rlReport"></div>
<div class="ai-dlg-loghead">Nhật ký</div><pre class="ai-dlg-log" id="rlLog"></pre>
<div class="ai-dlg-actions"><button type="button" class="btn btn-ghost btn-sm" data-rl="dry">🧪 Thử khô</button><button type="button" class="btn btn-secondary btn-sm" data-rl="start">▶ Bắt đầu ghép</button><button type="button" class="btn btn-ghost btn-sm" data-rl="pause"></button><button type="button" class="btn btn-ghost btn-sm" data-rl="stop">⏹ Dừng</button></div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#rlWeak').addEventListener('change', (e) => { st.includeWeak = !!e.target.checked; save(); render(); });
    dlg.addEventListener('click', async (e) => {
      if (e.target === dlg) { dlg.close(); return; }
      const b = e.target.closest('[data-rl]'); if (!b) return; const a = b.dataset.rl;
      try {
        if (a === 'close') dlg.close();
        else if (a === 'dry') { b.disabled = true; try { await dryRun(); } finally { b.disabled = false; } }
        else if (a === 'start') start();
        else if (a === 'pause') pause();
        else if (a === 'stop') stop();
        else if (a === 'undo') { if (confirm('Hoàn tác ghép phiếu này?\n\nMục sẽ về đúng trạng thái TRƯỚC khi ghép; phần bạn sửa SAU khi ghép sẽ mất.')) await undo(b.dataset.id); }
        else if (a === 'one') { const g = (await findGroups(true)).find(x => x.key === b.dataset.key); if (g && !running) { delete st.groups[g.key]; await runOne(g); } else if (running) alert('Đang có nhóm khác chạy — thử lại sau.'); }
      } catch (err) { alert('Lỗi: ' + (err.message || err)); }
    });
    return dlg;
  }
  function openDlg() { ensureDlg().showModal(); render(); }
  function render() {
    const doneN = Object.values(st.groups).filter(g => g.status === 'done').length, skipN = Object.values(st.groups).filter(g => g.status === 'skip').length, failN = Object.values(st.groups).filter(g => g.status === 'fail').length;
    const btn = q('#btnRelayoutOpen'); if (btn) btn.textContent = '🧩 Rà phiếu cũ (ghép lại)' + (st.active ? (running ? ' · đang chạy' : st.paused ? ' · tạm dừng' : ' · chờ lượt') : '');
    if (!dlg || !dlg.open) return;
    q('#rlWeak').checked = !!st.includeWeak;
    q('#rlStatus').innerHTML = `${st.active ? (st.paused ? '⏸ Tạm dừng' : running ? '⏳ Đang ghép: ' + esc(st.cur) : '🕓 Đang chờ lượt') : '⏹ Chưa chạy'} · Đã ghép: <b>${doneN}</b> · Bỏ qua: <b>${skipN}</b> · Lỗi: <b>${failN}</b>${st.blockUntil > Date.now() ? ' · <span class="error-text">tạm nghỉ đến ' + new Date(st.blockUntil).toLocaleTimeString('vi-VN') + '</span>' : ''}`;
    const rp = st.report, AV = { local: '✅ đủ ảnh', maybe: '☁ cần tải ảnh', none: '❌ thiếu ảnh' };
    const done = Object.entries(st.groups).filter(([, g]) => g.status === 'done' && g.target);
    q('#rlReport').innerHTML = (rp ? `<div class="hint"><b>Thử khô (${new Date(rp.at).toLocaleTimeString('vi-VN')}):</b> ${rp.strong} nhóm chắc · ${rp.weak} nhóm chưa chắc · sẽ ghép <b>${rp.doable}</b> nhóm · ước tính <b>~${rp.calls}</b> lần gọi Gemini · ${rp.noImg} nhóm thiếu ảnh · ${rp.tooBig} nhóm quá ${MAX_PAGES} trang.</div>`
      + rp.rows.map(r => `<div class="hint">• <b>${esc(r.fileName)}</b> — ${r.phieu} phiếu → ${r.total} trang · ${r.strong ? 'chắc' : 'chưa chắc'} · ${AV[r.avail]}<br><span style="opacity:.8">${esc(r.why)}</span>${r.strong ? '' : ` <button type="button" class="btn btn-ghost btn-sm" data-rl="one" data-key="${esc(r.key)}">Ghép nhóm này</button>`}</div>`).join('') : '')
      + (done.length ? '<div class="ai-dlg-loghead">Đã ghép</div>' + done.map(([k, g]) => `<div class="hint">• ${esc(k.split('|')[0])} → phiếu ${esc(g.target.slice(0, 8))} <button type="button" class="btn btn-ghost btn-sm" data-rl="undo" data-id="${esc(g.target)}">↩ Hoàn tác</button></div>`).join('') : '');
    q('#rlLog').textContent = (st.log || []).slice().reverse().join('\n') || '(chưa có)';
    q('[data-rl="pause"]').textContent = st.paused ? '▶ Tiếp tục' : '⏸ Tạm dừng';
  }
  function injectUi() {
    if (q('#btnRelayoutOpen')) return;
    const anchor = q('#scanLeanSize') || q('#scanStoreMsg') || q('.ss-imgs'); if (!anchor) return;
    const box = document.createElement('div'); box.className = 'ss-free';
    box.innerHTML = '<b>🧩 Phiếu cũ bị cắt sai</b><div class="hint">Ghép lại các phiếu cùng 1 file bị chia thành nhiều phiếu 2 mặt (VD phiếu 9 trang).</div><div class="sv-actions"><button type="button" class="btn btn-secondary btn-sm" id="btnRelayoutOpen">🧩 Rà phiếu cũ (ghép lại)</button></div>';
    anchor.insertAdjacentElement('afterend', box);
    q('#btnRelayoutOpen').addEventListener('click', openDlg);
    render();
  }

  (async () => {
    await load();
    const boot = () => { injectUi(); setTimeout(injectUi, 1500); setTimeout(injectUi, 4000); document.querySelectorAll('[data-open-scanstore], #btnSettings').forEach(b => b.addEventListener('click', () => setTimeout(injectUi, 400))); if (st.active) schedule(20000); };   // tải lại trang → tự chạy tiếp
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  })();

  return { groupRecs, findGroups, dryRun, start, pause, stop, undo, open: openDlg, state: () => st };
})();
window.ScanRelayout = ScanRelayout;
