/* =========================================================================
   scan-sheet.js — ĐỒNG BỘ DỮ LIỆU «📷 TỪ PHIẾU SCAN» → SHEET «Dulieuscan» (qua Apps Script)
   • Mỗi xe trên mỗi phiếu = 1 dòng (khóa: Mã phiếu + Mã mục). Phiếu mới quét, phiếu được chỉnh sửa / đối chiếu / đổi người thực hiện… đều tự cập nhật.
   • Cách hoạt động (không cần sửa scan-review.js / scan-sync.js):
       1) Nghe sự kiện sheetDone của scan.js (phiếu vừa quét xong);
       2) Bọc ScanApp.db.dbPut / dbDelete / tx: mọi lần ghi vào phiếu, mục so sánh, liên kết biển số -> lên lịch đồng bộ sau ~2,5 giây;
       3) Lưới an toàn: mỗi 60 giây + khi quay lại tab + khi có mạng lại + lúc mở web -> so sánh «dấu vân tay» từng phiếu, CHỈ gửi phiếu có thay đổi.
   • Việc chưa gửi được (mất mạng, Apps Script chưa cập nhật) tự gửi lại sau; dấu vân tay lưu trong localStorage nên mở lại web không gửi lại việc đã xong.
   • Chỉ gửi chữ (không gửi ảnh). Chỉ ghi tab «Dulieuscan» — việc đó do AppsScript_Dulieuscan.gs bảo đảm.
   Nạp SAU scan.js (nên đặt sau scan-disk.js / scan-rotate.js).
   ========================================================================= */
const ScanSheet = (() => {
  'use strict';
  const S = ScanApp, DB = S.db, ST_SCANS = DB.ST_SCANS, ST_ITEMS = DB.ST_ITEMS, ST_LINKS = DB.ST_LINKS;
  const ON_KEY = 'scanSheetSyncOn', SIG_KEY = 'scanSheetSigV1', DEL_KEY = 'scanSheetDelV1';
  const BATCH = 8;                       // số phiếu / 1 request
  const q = (sel) => document.querySelector(sel);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } };
  const isOn = () => lsGet(ON_KEY, true) !== false;

  let sigs = lsGet(SIG_KEY, {}), pendingDel = lsGet(DEL_KEY, []);
  const st = { busy: false, again: false, lastOk: 0, err: '', pending: 0, msg: '' };
  let timer = null;

  /* ---------------- Chuẩn hóa giá trị ---------------- */
  const str = (v) => v == null ? '' : typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.map(str).filter(Boolean).join(' / ') : typeof v === 'object' ? '' : String(v);
  const pick = (o, keys) => { if (!o) return ''; for (const k of keys) { const s = str(o[k]); if (s !== '') return s; } return ''; };
  const yesNo = (v, yes, no) => v === true ? yes : v === false ? no : str(v);
  const pad = (n) => String(n).padStart(2, '0');
  const fmtT = (t) => { if (!t) return ''; const d = new Date(t); return isNaN(d) ? '' : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const jsonSafe = (o) => { try { const s = JSON.stringify(o, (k, v) => (typeof Blob !== 'undefined' && v instanceof Blob) ? undefined : v); return !s || s === '{}' ? '' : s.length > 40000 ? s.slice(0, 40000) + '…(cắt bớt)' : s; } catch (e) { return ''; } };
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ':' + s.length; };
  const label = (t) => (S.TINH_TRANG_LABEL && S.TINH_TRANG_LABEL[t]) || t || '';
  const nb = (s) => { try { return S.normalizeBienSo(s) || ''; } catch (e) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); } };

  /* ---------------- Dựng các dòng của 1 phiếu ---------------- */
  // rec: bản ghi phiếu (đã bỏ ảnh) · items: các mục so sánh (ST_ITEMS) của phiếu · linkMap: bienSo -> bản ghi plateLinks
  function buildRows(rec, items, linkMap) {
    const ex = rec.extracted || {}, vehicles = Array.isArray(ex.vehicles) ? ex.vehicles : [];
    const common = {
      'Mã phiếu': rec.id, 'Thời gian quét': fmtT(rec.timestamp), 'Nguồn phiếu': str(rec.sheetLabel || rec.fileName || rec.source),
      'Loại phiếu': str(ex.loaiPhieu), 'Ghi chú chung của phiếu': str(ex.ghiChu), 'Mặt 2 có nội dung': yesNo(!!ex.backHasContent, 'Có', 'Không'),
      'Trường không rõ': str(ex.truongKhongRo), 'Biển khớp danh sách': str(rec.matchedBienSo),
      'Dữ liệu từ phiếu (JSON)': jsonSafe({ extracted: ex, model: rec.model, keyLabel: rec.keyLabel, backBlank: rec.backBlank, rot: rec.rot }),
    };
    const rows = [];
    const findVeh = (plate) => { const k = nb(plate); return k ? vehicles.find(v => nb(v.bienSo) === k) || null : null; };
    if (items.length) {
      items.forEach((it, i) => {
        const plateRaw = pick(it, ['bienSoRaw', 'bienSo']), v = findVeh(plateRaw) || findVeh(it.bienSo), link = linkMap.get(it.bienSo) || linkMap.get(nb(plateRaw)) || null;
        const kiem = pick(it, ['daKiem', 'kiem', 'checked', 'status', 'trangThai', 'state']) || pick(link, ['status', 'trangThai', 'kiem', 'state']);
        rows.push(Object.assign({}, common, {
          'Mã mục': str(it.id) || `${rec.id}#${i}`,
          'Biển số': str(it.bienSo) || nb(plateRaw), 'Biển số đọc trên phiếu': plateRaw,
          'Chủ xe': pick(it, ['chuXe', 'chuHo', 'hoTen', 'ten']) || str(ex.chuHo),
          'CCCD': pick(it, ['cccd']) || str(ex.cccd), 'SĐT': pick(it, ['sdt', 'phone']) || str(ex.sdt),
          'Tình trạng phương tiện': pick(it, ['tinhTrang', 'tinhTrangPhieu']) || (v ? label(v.tinhTrang) : ''),
          'Tình trạng ghi trên phiếu': v ? str(v.tinhTrangGhiTrenPhieu) : '',
          'Ghi chú': pick(it, ['ghiChu', 'note']) || (v ? str(v.ghiChu) : ''),
          'Trạng thái kiểm': kiem === 'true' ? 'Đã kiểm' : kiem === 'false' ? 'Chưa kiểm' : kiem,
          'Người thực hiện': pick(it, ['nguoiThucHien', 'assignee', 'nguoiKiem']),
          'Tình trạng cam kết': pick(it, ['tinhTrangCamKet', 'camKet', 'commit']),
          'Trạng thái xe (đối chiếu)': pick(it, ['trangThaiXe', 'statusXe']),
          'Kết quả đối chiếu (JSON)': jsonSafe({ fields: it.fields, cmp: it.cmp, compare: it.compare, decisions: it.decisions, decision: it.decision, match: rec.match, link }),
          'Dữ liệu mục (JSON)': jsonSafe(it),
        }));
      });
      return rows;
    }
    // Chưa có mục so sánh (vừa quét xong) -> mỗi xe đọc được trên phiếu = 1 dòng; không có xe nào -> 1 dòng trống biển
    const list = vehicles.length ? vehicles : [null];
    list.forEach((v, i) => rows.push(Object.assign({}, common, {
      'Mã mục': `${rec.id}#${i}`,
      'Biển số': v ? nb(v.bienSo) : '', 'Biển số đọc trên phiếu': v ? str(v.bienSo) : '',
      'Chủ xe': str(ex.chuHo), 'CCCD': str(ex.cccd), 'SĐT': str(ex.sdt),
      'Tình trạng phương tiện': v ? label(v.tinhTrang) : '', 'Tình trạng ghi trên phiếu': v ? str(v.tinhTrangGhiTrenPhieu) : '',
      'Ghi chú': v ? str(v.ghiChu) : '', 'Trạng thái kiểm': 'Chưa kiểm',
      'Dữ liệu mục (JSON)': jsonSafe(v),
    })));
    return rows;
  }

  /* ---------------- Đọc dữ liệu cục bộ (không giữ ảnh trong bộ nhớ) ---------------- */
  async function loadAll() {
    const db = await DB.openDb(), recs = [];
    await new Promise((res, rej) => {
      const req = db.transaction(ST_SCANS, 'readonly').objectStore(ST_SCANS).openCursor();
      req.onsuccess = () => {
        const c = req.result; if (!c) { res(); return; }
        const r = c.value;
        if (r.status === 'done' && !r.isTest) { const { frontBlob, backBlob, extraBlobs, geminiRaw, ...rest } = r; recs.push(rest); }
        c.continue();
      };
      req.onerror = () => rej(req.error);
    });
    const byScan = new Map(), links = new Map();
    try { ((await DB.dbGetAll(ST_ITEMS)) || []).forEach(it => { if (!byScan.has(it.scanId)) byScan.set(it.scanId, []); byScan.get(it.scanId).push(it); }); } catch (e) { /* chưa có store */ }
    try { ((await DB.dbGetAll(ST_LINKS)) || []).forEach(l => { if (l && l.bienSo) links.set(l.bienSo, l); }); } catch (e) { /* bỏ qua */ }
    byScan.forEach(arr => arr.sort((a, b) => String(a.id).localeCompare(String(b.id))));
    return { recs, byScan, links };
  }

  /* ---------------- Gửi lên Apps Script ---------------- */
  const gasUrl = () => (typeof state !== 'undefined' && state && state.mode === 'gas' && state.gasUrl) || '';
  async function send(payload) {
    const r = (typeof gasWriteRequest === 'function') ? await gasWriteRequest(payload) : await gasRequest(gasUrl(), payload);
    if (!r || r.ok === false) {
      const m = String((r && r.error) || 'Không có phản hồi từ Apps Script');
      if (/unknown (post |get )?action|action không hỗ trợ|không hỗ trợ:/i.test(m)) throw new Error('Apps Script CHƯA cập nhật bản có «Dulieuscan» — dán AppsScript_Dulieuscan.gs + Ma_lenh_luu_anh.gs rồi Triển khai «Phiên bản mới».');
      throw new Error(m);
    }
    return r;
  }

  async function run(force) {
    clearTimeout(timer); timer = null;
    if (!isOn()) { render(); return; }
    if (st.busy) { st.again = true; return; }
    if (!gasUrl()) { st.msg = 'Chưa kết nối Apps Script (đồng bộ 2 chiều) — sẽ tự gửi khi kết nối.'; render(); return; }
    st.busy = true; st.err = ''; st.msg = ''; render();
    try {
      while (pendingDel.length) {                                  // phiếu bị xóa trên web -> đánh dấu trong sheet
        const ids = pendingDel.slice(0, 50);
        await send({ action: 'scanSheetDelete', scanIds: ids });
        pendingDel = pendingDel.filter(x => !ids.includes(x)); ids.forEach(id => { delete sigs[id]; });
        lsSet(DEL_KEY, pendingDel); lsSet(SIG_KEY, sigs);
      }
      const { recs, byScan, links } = await loadAll(), todo = [];
      for (const rec of recs) {
        const rows = buildRows(rec, byScan.get(rec.id) || [], links), sig = hash(JSON.stringify(rows));
        if (force || sigs[rec.id] !== sig) todo.push({ scanId: rec.id, rows, sig });
      }
      st.pending = todo.length; render();
      for (let i = 0; i < todo.length; i += BATCH) {
        const part = todo.slice(i, i + BATCH);
        await send({ action: 'scanSheetUpsert', scans: part.map(p => ({ scanId: p.scanId, rows: p.rows })) });
        part.forEach(p => { sigs[p.scanId] = p.sig; }); lsSet(SIG_KEY, sigs);
        st.pending = todo.length - i - part.length; render();
      }
      st.lastOk = Date.now();
    } catch (e) { st.err = String((e && e.message) || e); console.warn('[scan-sheet]', e); }
    finally {
      st.busy = false; render();
      if (st.again) { st.again = false; schedule(1500); } else if (st.err) schedule(90000);   // lỗi -> thử lại sau 90 giây
    }
  }
  function schedule(ms) { if (!isOn()) return; clearTimeout(timer); timer = setTimeout(() => run(false), ms == null ? 2500 : ms); }

  /* ---------------- Móc vào thay đổi dữ liệu ---------------- */
  S.on('sheetDone', () => schedule(1500));
  const watched = (store) => store === ST_SCANS || store === ST_ITEMS || store === ST_LINKS;
  const o = { dbPut: DB.dbPut, dbDelete: DB.dbDelete, tx: DB.tx };
  DB.dbPut = async function (store) { const r = await o.dbPut.apply(this, arguments); if (watched(store)) schedule(); return r; };
  DB.dbDelete = async function (store, id) {
    if (store === ST_SCANS && id != null && !pendingDel.includes(id)) { pendingDel.push(id); lsSet(DEL_KEY, pendingDel); }
    const r = await o.dbDelete.apply(this, arguments); if (watched(store)) schedule(); return r;
  };
  DB.tx = function (store, mode) { const p = o.tx.apply(this, arguments); if (mode === 'readwrite' && watched(store)) Promise.resolve(p).then(() => schedule(), () => {}); return p; };

  setInterval(() => { if (!document.hidden) schedule(300); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(1000); });
  window.addEventListener('online', () => schedule(1000));
  setTimeout(() => schedule(100), 6000);                                   // sau khi web nạp xong + kết nối Apps Script

  /* ---------------- Giao diện nhỏ trong Cài đặt → Lưu trữ ---------------- */
  function render() {
    const el = q('#scanSheetState'); if (!el) return;
    const n = Object.keys(sigs).length;
    let t;
    if (!isOn()) t = '⏸ Đang tắt.';
    else if (st.busy) t = `⏳ Đang đồng bộ${st.pending ? ` (còn ${st.pending} phiếu)` : ''}…`;
    else if (st.err) t = '❌ ' + st.err;
    else if (st.msg) t = '⚠ ' + st.msg;
    else t = `✅ ${n} phiếu đã có trong sheet «Dulieuscan»${st.lastOk ? ' · lần gần nhất ' + fmtT(st.lastOk) : ''}.`;
    el.textContent = t; el.classList.toggle('error-text', !!st.err);
  }
  function injectUi() {
    if (q('#scanSheetState')) return true;
    const anchor = q('#scanDiskState') ? q('#scanDiskState').parentElement : (q('.ss-imgs') || q('#scanStoreMsg')); if (!anchor) return false;
    const box = document.createElement('div'); box.className = 'ss-disk';
    box.innerHTML = `<b>📄 Đồng bộ dữ liệu «Từ phiếu scan» sang sheet «Dulieuscan»</b>
<div class="hint">Mỗi xe trên mỗi phiếu = 1 dòng. Phiếu mới quét và mọi chỉnh sửa / đối chiếu sau đó tự cập nhật. Không đụng các sheet khác. Cần kết nối Apps Script (đồng bộ 2 chiều).</div>
<label class="hint"><input type="checkbox" id="scanSheetOn"> Bật đồng bộ sang Dulieuscan</label>
<div id="scanSheetState" class="hint"></div>
<div class="sv-actions"><button type="button" class="btn btn-secondary btn-sm" id="btnScanSheetNow">🔄 Đồng bộ ngay</button><button type="button" class="btn btn-ghost btn-sm" id="btnScanSheetAll">📤 Gửi lại toàn bộ phiếu</button></div>`;
    anchor.insertAdjacentElement('beforebegin', box);
    const on = q('#scanSheetOn'); on.checked = isOn();
    on.addEventListener('change', () => { lsSet(ON_KEY, on.checked); if (on.checked) schedule(200); render(); });
    q('#btnScanSheetNow').addEventListener('click', () => run(false));
    q('#btnScanSheetAll').addEventListener('click', () => { if (confirm('Gửi lại TOÀN BỘ phiếu sang sheet Dulieuscan?\n(Chỉ cập nhật dòng theo Mã phiếu + Mã mục, không tạo dòng trùng.)')) run(true); });
    render(); return true;
  }
  const tryInject = () => { if (!injectUi()) setTimeout(tryInject, 2000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryInject); else tryInject();
  document.querySelectorAll('[data-open-scanstore], #btnSettings').forEach(b => b.addEventListener('click', () => setTimeout(() => { injectUi(); render(); }, 300)));

  return { run, schedule, buildRows, syncNow: () => run(false), resendAll: () => run(true) };
})();
window.ScanSheet = ScanSheet;
