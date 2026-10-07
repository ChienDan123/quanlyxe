/* =========================================================================
   scan-review.js — SO SÁNH & XÁC NHẬN cập nhật từ phiếu scan
   Nạp SAU app.js, scan.js, scan-compare.js. Dùng ScanApp (DB, sự kiện) và các
   hàm toàn cục của app.js (state, FIELD_MAP, updateSingleRowFields, gasRequest...).

   Luồng:
     1. Mỗi tờ quét xong -> ScanApp phát 'sheetDone' -> tạo "mục" (item) cho TỪNG XE
        trên phiếu, lưu store scanItems (không chứa ảnh) + liên kết biển số ↔ phiếu
        (store plateLinks) để bảng chính hiện icon 📷 và lọc được.
        Với các tờ ĐÃ quét từ trước khi có module này: tự tạo mục khi mở màn so sánh.
     2. Màn "So sánh & xác nhận": trái = dữ liệu từ phiếu, phải = dữ liệu hiện có trên
        Sheet; mỗi trường khác/thiếu có quyết định: Cập nhật / Không / Để kiểm sau.
     3. "Áp dụng": ghi qua updateSingleRowFields() -> LOCAL-FIRST rồi đồng bộ NGẦM lên
        Google Sheet bằng hàng đợi sẵn có của app (không phá luồng cũ).
     4. Biển số KHÔNG có trong danh sách ("phiếu lạ") KHÔNG bao giờ được thêm vào dữ liệu
        xe chính => không làm tăng số xe cần rà soát; chỉ đẩy sang tab riêng "PhieuLa".
   ========================================================================= */
const ScanReview = (() => {
  'use strict';
  const S = ScanApp, DB = S.db, C = ScanCompare;
  const ST_ITEMS = DB.ST_ITEMS, ST_LINKS = DB.ST_LINKS, ST_SCANS = DB.ST_SCANS;
  const norm = C.normPlate;
  const hdr = (key) => (FIELD_MAP.find(f => f.key === key) || {}).header || key;

  /* ------------------------------------------------------------------ */
  /* 1. LIÊN KẾT BIỂN SỐ ↔ PHIẾU (nạp RAM để bảng chính tra cứu tức thì) */
  /* ------------------------------------------------------------------ */
  // bienSo chuẩn hóa -> { bienSo, scanIds[], review:'da_kiem'|'chua_kiem', orphan, result }
  const linkMap = new Map();
  let _renderTimer = null;
  // Vẽ lại bảng chính (gộp nhiều lần gọi, tránh vẽ liên tục khi đang quét ngầm)
  function refreshMainTable() {
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(() => { if (typeof renderTable === 'function' && state.rawData.length) renderTable(); }, 1200);
  }
  async function loadLinks() {
    try { (await DB.dbGetAll(ST_LINKS)).forEach(l => linkMap.set(l.bienSo, l)); } catch (e) { console.warn('Không nạp được plateLinks', e); }
  }
  async function itemsByIndex(index, value) {
    return (await DB.tx(ST_ITEMS, 'readonly', os => os.index(index).getAll(value))) || [];
  }
  // Tính lại liên kết của 1 biển từ các mục của nó (1 biển có thể xuất hiện trên nhiều phiếu)
  async function recomputeLink(plate) {
    if (!plate) return;
    const items = await itemsByIndex('bienSo', plate);
    if (!items.length) { linkMap.delete(plate); await DB.dbDelete(ST_LINKS, plate); return; }
    items.sort((a, b) => a.createdAt - b.createdAt);
    const link = {
      bienSo: plate,
      scanIds: [...new Set(items.map(i => i.scanId))],
      review: items.every(i => i.review === 'da_kiem') ? 'da_kiem' : 'chua_kiem',
      orphan: items.every(i => !!i.orphan),
      result: items[items.length - 1].result || '',
      updatedAt: Date.now(),
    };
    linkMap.set(plate, link);
    await DB.dbPut(ST_LINKS, link);
  }

  /* ------------------------------------------------------------------ */
  /* 2. TẠO MỤC SO SÁNH TỪ KẾT QUẢ GEMINI                                */
  /* ------------------------------------------------------------------ */
  // Các trường được so sánh/cập nhật (khóa trùng FIELD_MAP của app.js)
  const SPECS = [
    { key: 'chuXe', label: 'Chủ phương tiện', cmp: C.cmpName },
    { key: 'cccd', label: 'Số CCCD/MST', cmp: C.cmpCccd },
    { key: 'soDienThoai', label: 'Số điện thoại', cmp: C.cmpPhone },
    { key: 'ghiChu', label: 'Ghi chú', cmp: C.cmpNote },
    { key: 'tinhTrangCamKet', label: 'Tình trạng cam kết', cmp: C.cmpCommit },
    // Người thực hiện: trường "meta" — không làm xe bị tính là "có khác biệt", chỉ ghi kèm khi áp dụng.
    { key: 'nguoiThucHien', label: 'Người thực hiện', cmp: C.cmpAssignee, meta: true },
  ];
  const NOTEWORTHY = (code) => code && !['khong_ro', 'dang_hoat_dong'].includes(code);

  // Dữ liệu của 1 xe trên phiếu (thông tin chủ hộ dùng chung cho mọi xe cùng phiếu)
  function buildScanData(ex, v) {
    const code = v.tinhTrang || 'khong_ro';
    const label = S.TINH_TRANG_LABEL[code] || code;
    const notes = [];
    if (NOTEWORTHY(code)) notes.push(label);           // VD: "Đã bán chưa sang tên", "Mất cắp"
    if (v.ghiChu) notes.push(v.ghiChu);
    if (ex.ghiChu) notes.push(ex.ghiChu);              // ghi chú tay + ghi chú mặt 2
    return {
      chuXe: ex.chuHo || '', cccd: ex.cccd || '', soDienThoai: ex.sdt || '',
      ghiChu: notes.join('; '),
      tinhTrangCamKet: (ex.loaiPhieu === 'ban_cam_ket' && ex.backHasContent) ? 'Đã ký cam kết' : '',
      tinhTrangCode: code, tinhTrangLabel: label, tinhTrangGoc: v.tinhTrangGhiTrenPhieu || '',
      loaiXe: v.loaiXe || '', loaiPhieu: ex.loaiPhieu || '',
    };
  }

  // Tạo (nếu chưa có) các mục cho 1 tờ. KHÔNG ghi đè mục đã có (giữ quyết định của người dùng).
  async function createItemsForScan(scanId, extracted, label) {
    const vehicles = (extracted && extracted.vehicles) || [];
    const seen = new Set();
    const touched = [];
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const plate = norm(v.bienSo);                    // '' nếu máy không đọc được biển
      const key = plate || ('#' + i);
      if (seen.has(key)) continue; seen.add(key);
      const id = scanId + '|' + key;
      if (await DB.dbGet(ST_ITEMS, id)) continue;
      const it = {
        id, scanId, bienSo: plate, bienSoRaw: v.bienSo || '', sheetLabel: label || '',
        scanData: buildScanData(extracted, v),
        orphan: false, decisions: {}, applied: {}, review: 'chua_kiem', done: false, dirty: false,
        orphanDecision: null, orphanPushed: false, pushError: '', result: '',
        edits: {}, sheetEdits: {}, fixed: {}, imgChecked: false, // chỉnh sửa tay bên phiếu / bên Sheet + tick "Đã kiểm với ảnh"
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      await DB.dbPut(ST_ITEMS, it);
      touched.push(plate);
    }
    for (const p of touched) await recomputeLink(p);
    if (touched.length) refreshMainTable();
  }

  // Các tờ đã quét TRƯỚC khi có module này (không có mục) -> tạo mục bù (duyệt bằng cursor, mỗi lần 1 bản ghi)
  async function backfillItems(onProgress) {
    const have = new Set((await DB.dbGetAll(ST_ITEMS)).map(i => i.scanId));
    const db = await DB.openDb();
    const todo = [];
    await new Promise((resolve, reject) => {
      const req = db.transaction(ST_SCANS, 'readonly').objectStore(ST_SCANS).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const r = cur.value;
        if (r.status === 'done' && !r.isTest && r.extracted && !have.has(r.id))
          todo.push({ id: r.id, ex: r.extracted, label: r.sheetLabel || ((r.fileName || '') + (r.pagesDesc ? ' · ' + r.pagesDesc : '')) });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    let n = 0;
    for (const t of todo) { await createItemsForScan(t.id, t.ex, t.label); if (onProgress) onProgress(++n, todo.length); }
    return todo.length;
  }

  S.on('sheetDone', async (d) => { await createItemsForScan(d.scanId, d.extracted, d.label); });
  // Quét xong toàn bộ -> chuyển sang bước SO SÁNH & XÁC NHẬN. Nếu cửa sổ Quét phiếu đang mở thì
  // mở thẳng màn so sánh; nếu người dùng đang làm việc khác thì chỉ báo nhẹ (không cướp màn hình).
  S.on('queueFinished', async () => {
    refreshMainTable();
    const scanOpen = !$('#scanModal').classList.contains('hidden');
    if (scanOpen) { closeModal('scanModal'); open(); }
    else toast('📷 Quét xong! Bấm «So sánh phiếu» ở đầu trang để xem và xác nhận cập nhật.');
    const b = $('#btnScanOpenReview'); if (b) { b.classList.add('pulse'); setTimeout(() => b.classList.remove('pulse'), 8000); }
  });

  /* ------------------------------------------------------------------ */
  /* 3. TÍNH TOÁN "KHUNG NHÌN" SO SÁNH CHO 1 MỤC                          */
  /* ------------------------------------------------------------------ */
  // Trạng thái màn hình (khai báo sớm vì computeView/preview đều dùng)
  const R = {
    items: [], filter: 'review', search: '', page: 1, pageSize: 12, busy: false, listIds: [],
    // Khung ảnh phiếu đặt cạnh bảng so sánh (vừa xem ảnh vừa đối chiếu)
    pane: { open: false, id: null, loadedId: null, mode: 'both', zoom: 100, urls: [], token: 0 },
  };
  // Tùy chọn của người dùng (nhớ trên máy): người thực hiện mặc định, ghi dấu 📷, xác nhận nhanh = áp dụng luôn
  const PREF_KEY = 'vehicleScanPrefsV1';
  const prefs = { assignee: '', tag: true, quick: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* bỏ qua */ }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* bỏ qua */ } };

  const ADD_NEW = (typeof ASSIGNEE_ADD_NEW_VALUE !== 'undefined') ? ASSIGNEE_ADD_NEW_VALUE : '__add_new__';
  const assigneeList = () => { try { return typeof loadAssigneeList === 'function' ? loadAssigneeList() : []; } catch (e) { return []; } };
  // Nhãn NGẮN dùng trong dấu nguồn "📷Phiếu dd/mm: CCCD, SĐT" (Người thực hiện không lấy từ phiếu nên không có)
  const TAG_LABEL = { chuXe: 'Chủ xe', cccd: 'CCCD', soDienThoai: 'SĐT', ghiChu: 'Ghi chú', tinhTrangCamKet: 'Cam kết' };
  const isActionable = (st) => st === 'fill' || st === 'diff' || st === 'sheetedit';
  const SIGNED = (typeof COMMITMENT_OPTIONS !== 'undefined' && COMMITMENT_OPTIONS[0]) || 'Đã ký cam kết';

  // Mục cũ (tạo trước bản này) thiếu các trường mới -> bổ sung mặc định
  function normItem(it) {
    it.edits = it.edits || {}; it.sheetEdits = it.sheetEdits || {}; it.fixed = it.fixed || {};
    it.decisions = it.decisions || {}; it.applied = it.applied || {}; it.imgChecked = !!it.imgChecked;
    return it;
  }

  let _idxCache = { ref: null, len: -1, map: null };
  function dsIndex() {
    const rows = state.rawData || [];
    if (_idxCache.ref === rows && _idxCache.len === rows.length) return _idxCache.map;
    const map = new Map();
    for (const r of rows) {
      const k = norm(r.bienSo);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    _idxCache = { ref: rows, len: rows.length, map };
    return map;
  }

  // Giá trị "bên phiếu" của 1 trường: ưu tiên giá trị người dùng đã SỬA TAY; Người thực hiện lấy mặc định ở thanh công cụ.
  function scanValue(it, key) {
    if (it.edits && key in it.edits) return it.edits[key];
    if (key === 'nguoiThucHien') return prefs.assignee || '';
    return it.scanData[key] || '';
  }

  // So sánh luôn dùng dữ liệu HIỆN TẠI của Sheet + giá trị phiếu SAU KHI chỉnh sửa
  // => sửa tay xong mà khớp Sheet thì trường tự chuyển thành "khớp" (đối chiếu/cập nhật bình thường).
  function computeView(it) {
    normItem(it);
    const rows = it.bienSo ? (dsIndex().get(it.bienSo) || []) : [];
    const row = rows[0] || null;
    const v = { it, row, rowCount: rows.length, found: !!row, fields: [], actionable: 0, later: 0 };
    if (!row) return v;
    for (const spec of SPECS) {
      const key = spec.key;
      const sv = scanValue(it, key), dsv = row[key] || '';
      const c = spec.cmp(sv, dsv);
      let dec = it.decisions[key] || null;                              // quyết định người dùng đã chọn (nếu có)
      // Người dùng đã sửa giá trị bên Sheet (khác giá trị gốc) -> trường này là "sửa Sheet"
      const sheetEdit = (key in it.sheetEdits && it.sheetEdits[key] !== dsv) ? it.sheetEdits[key] : null;
      if (dec === 'sheetfix' && sheetEdit === null) dec = null;
      let state_ = c.state, note = c.note || '', decision = null;
      if (sheetEdit !== null) { state_ = 'sheetedit'; note = 'Bạn đã sửa giá trị Sheet tại chỗ'; decision = dec || 'sheetfix'; }
      else if (state_ === 'fill' || state_ === 'diff') {
        decision = dec || c.defaultDecision || (state_ === 'fill' ? 'apply' : 'later');
        // Biển trùng nhiều dòng trên Sheet -> không chắc dòng nào: mặc định để kiểm sau (trừ trường meta)
        if (v.rowCount > 1 && !dec && !spec.meta) decision = 'later';
      } else if (state_ === 'same' && key in it.edits) note = 'Sau khi chỉnh sửa, dữ liệu phiếu đã KHỚP Google Sheet';
      if (spec.meta && decision === 'later') decision = 'skip';          // trường meta không có "để kiểm sau"
      if (isActionable(state_)) { if (!spec.meta) { v.actionable++; if (decision === 'later') v.later++; } }
      // Giá trị sẽ ghi vào Sheet theo quyết định hiện tại
      let writeVal;
      if (decision === 'sheetfix') writeVal = sheetEdit;
      else if (decision === 'apply') writeVal = c.newVal != null ? c.newVal : (state_ === 'sheetedit' && sv ? sv : undefined);
      v.fields.push({ spec, scanVal: sv, dsVal: dsv, state: state_, newVal: c.newVal, note, decision, writeVal,
        edited: key in it.edits, sheetEdit });
    }
    return v;
  }
  const viewCategory = (v) => !v.found ? 'orphan' : (v.actionable ? 'diff' : 'match');
  const willWrite = (f) => (f.decision === 'apply' || f.decision === 'sheetfix') && f.writeVal != null;
  // Các trường lấy TỪ PHIẾU (không tính meta/sửa Sheet) sẽ ghi -> dùng cho dấu nguồn
  const plannedFromScan = (v) => v.fields.filter(f => !f.spec.meta && f.decision === 'apply' && f.writeVal != null).map(f => f.spec.key);

  /* ---- DẤU NGUỒN: "📷Phiếu 07/10: CCCD, SĐT" nối vào Ghi chú để sau này biết dữ liệu lấy từ phiếu thu thập ---- */
  function withSourceTag(note, keys) {
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const date = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
    const labels = [...new Set(keys.map(k => TAG_LABEL[k] || k))];
    const base = String(note || '').trim();
    const re = new RegExp('📷Phiếu ' + date + ': ([^|]*)');
    const m = base.match(re);
    if (m) { // cùng ngày đã có dấu -> gộp thêm trường, không nhân đôi
      const all = [...new Set([...m[1].split(',').map(x => x.trim()).filter(Boolean), ...labels])];
      return base.replace(re, (s0) => `📷Phiếu ${date}: ${all.join(', ')}` + (/\s$/.test(s0) ? ' ' : ''));
    }
    return (base ? base + ' | ' : '') + `📷Phiếu ${date}: ${labels.join(', ')}`;
  }

  // Chuỗi mô tả ghi vào cột "Kết quả đối chiếu phiếu" của Sheet
  function buildResultText(v, plannedKeys) {
    const it = v.it, parts = [];
    const lab = (k) => TAG_LABEL[k] || k;
    if (it.scanData.tinhTrangCode !== 'khong_ro') parts.push(it.scanData.tinhTrangLabel);
    if (!v.found) parts.push('Chưa có trong DS');
    else {
      const applied = [...new Set([...Object.keys(it.applied || {}).filter(k => TAG_LABEL[k]), ...(plannedKeys || [])])];
      const keep = v.fields.filter(f => !f.spec.meta && f.decision === 'skip').map(f => lab(f.spec.key));
      const pend = v.fields.filter(f => f.decision === 'later').map(f => `${f.spec.label}: phiếu "${f.scanVal}" ≠ Sheet "${f.dsVal || 'trống'}"`);
      if (applied.length) parts.push('Đã cập nhật từ phiếu: ' + applied.map(lab).join(', '));
      if (keep.length) parts.push('Sheet đúng: ' + keep.join(', '));
      if (pend.length) parts.push('Cần kiểm: ' + pend.join('; '));
      if (!applied.length && !keep.length && !pend.length) parts.push('Khớp DS');
    }
    if (it.imgChecked) parts.push('✔ đã kiểm với ảnh');
    return parts.join(' · ').slice(0, 400);
  }

  /* ------------------------------------------------------------------ */
  /* 4. ÁP DỤNG                                                           */
  /* ------------------------------------------------------------------ */
  async function saveItem(it) { it.updatedAt = Date.now(); await DB.dbPut(ST_ITEMS, it); }

  // Áp dụng 1 mục có trên DS. onlyKeys (tùy chọn) = chỉ áp dụng các trường này (áp dụng RIÊNG LẺ từng trường).
  async function applyFoundItem(v, onlyKeys) {
    const it = v.it, row = v.row;
    const toWrite = {}, wrote = [], fromScan = [];
    for (const f of v.fields) {
      if (onlyKeys && !onlyKeys.includes(f.spec.key)) continue;
      if (!willWrite(f)) continue;
      toWrite[f.spec.key] = f.writeVal; wrote.push(f.spec.key);
      if (f.decision === 'sheetfix') it.fixed[f.spec.key] = true;       // sửa tay giá trị Sheet khi kiểm
      else { it.applied[f.spec.key] = true; if (!f.spec.meta) fromScan.push(f.spec.key); }
    }
    // DẤU NGUỒN: chỉ nối vào Ghi chú (không làm bẩn CCCD/SĐT/Chủ xe) khi thật sự có trường lấy từ phiếu
    if (prefs.tag && fromScan.length) toWrite.ghiChu = withSourceTag(('ghiChu' in toWrite) ? toWrite.ghiChu : row.ghiChu, fromScan);
    // Còn trường chưa giải quyết? ('later' hoặc đã chọn ghi nhưng chưa áp dụng vì chỉ áp dụng 1 phần)
    const unresolved = v.fields.filter(f => !f.spec.meta && (f.decision === 'later' || (willWrite(f) && !wrote.includes(f.spec.key))));
    it.review = unresolved.length ? 'chua_kiem' : 'da_kiem';
    it.dirty = unresolved.some(f => f.decision !== 'later');            // còn mục đã chọn ghi mà chưa ghi -> vẫn "chờ áp dụng"
    it.result = buildResultText(v, fromScan);
    // Metadata luôn ghi (kể cả "để kiểm sau") -> phần \"ghi vào cột trống tương ứng, tạo cột mới nếu cần\":
    // updateRow_() trong Apps Script tự tạo cột chưa có.
    const meta = {
      phieuScan: `Có — ${it.sheetLabel} (mã ${it.scanId.slice(0, 8)})`,
      kiemPhieu: it.review === 'da_kiem' ? 'Đã kiểm' : 'Chưa kiểm',
      ketQuaPhieu: it.result,
    };
    // updateSingleRowFields = local-first + hàng đợi đồng bộ ngầm sẵn có của app
    await updateSingleRowFields(row, { ...toWrite, ...meta });
    it.done = true; it.orphan = false;
    await saveItem(it);
    await recomputeLink(it.bienSo);
    return { writes: wrote.length };
  }

  // Đẩy các phiếu lạ lên tab riêng "PhieuLa" (cần patch Apps Script — xem AppsScript_ScanPatch.gs)
  async function pushOrphans(items) {
    if (!items.length) return { ok: true, n: 0 };
    if (!isWriteConnected()) return { ok: false, error: 'Chưa kết nối Apps Script 2 chiều.' };
    const rows = items.map(it => ({
      thoiGian: new Date().toLocaleString('vi-VN'), bienSo: it.bienSoRaw || it.bienSo,
      chuHo: it.scanData.chuXe, cccd: it.scanData.cccd, sdt: it.scanData.soDienThoai,
      tinhTrang: it.scanData.tinhTrangLabel, ghiChu: it.scanData.ghiChu, nguon: it.sheetLabel,
      maPhieu: it.scanId.slice(0, 8), kiem: it.review === 'da_kiem' ? 'Đã kiểm' : 'Chưa kiểm',
      nguoiThucHien: scanValue(it, 'nguoiThucHien'),
    }));
    try {
      const res = await gasRequest(state.gasUrl, { action: 'appendScanOrphans', rows });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'Apps Script chưa hỗ trợ action appendScanOrphans (xem AppsScript_ScanPatch.gs).' };
      return { ok: true, n: rows.length };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  async function applyOrphanItems(vs) {
    const toPush = [];
    for (const v of vs) {
      const it = v.it, dec = it.orphanDecision || 'later';
      it.orphan = true;
      it.result = [it.scanData.tinhTrangCode !== 'khong_ro' ? it.scanData.tinhTrangLabel : '', 'Chưa có trong DS'].filter(Boolean).join(' · ');
      if (dec === 'apply' && it.bienSo && !it.orphanPushed) toPush.push(it);
      // 'skip' = đã xem và quyết định không ghi => coi là đã kiểm; 'later' = để kiểm sau
      it.review = (dec === 'later' || (dec === 'apply' && !it.orphanPushed)) ? 'chua_kiem' : 'da_kiem';
    }
    if (toPush.length) {
      const r = await pushOrphans(toPush);
      toPush.forEach(it => { if (r.ok) { it.orphanPushed = true; it.review = 'da_kiem'; it.pushError = ''; } else { it.pushError = r.error; it.review = 'chua_kiem'; } });
      if (!r.ok) toast('Chưa ghi được phiếu lạ lên Sheet: ' + r.error, true);
    }
    for (const v of vs) { v.it.done = true; v.it.dirty = false; await saveItem(v.it); await recomputeLink(v.it.bienSo); }
  }

  /* ------------------------------------------------------------------ */
  /* 5. MÀN HÌNH SO SÁNH                                                  */
  /* ------------------------------------------------------------------ */
  const DEC_LABEL = { apply: '✅ Lấy từ phiếu', skip: '📋 Giữ Sheet (Sheet đúng)', later: '🕓 Để kiểm sau', sheetfix: '✏️ Ghi giá trị Sheet đã sửa' };
  const CAT_LABEL = { match: 'Khớp hoàn toàn', diff: 'Có khác biệt', orphan: 'Phiếu lạ (chưa có trong DS)' };

  // Ô chọn Người thực hiện mặc định trên thanh công cụ (dùng chung danh sách với bảng chính)
  function buildAssigneeSelect() {
    const sel = $('#rvAssignee'), list = assigneeList();
    if (prefs.assignee && !list.includes(prefs.assignee)) list.unshift(prefs.assignee);
    sel.innerHTML = '<option value="">— Chưa chọn —</option>' + list.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('') + `<option value="${ADD_NEW}">+ Thêm người mới...</option>`;
    sel.value = prefs.assignee || '';
  }

  async function open() {
    openModal('scanReviewModal');
    $('#rvList').innerHTML = '<p class="hint">Đang nạp dữ liệu…</p>';
    $('#rvChkTag').checked = !!prefs.tag; $('#rvChkQuick').checked = !!prefs.quick;
    buildAssigneeSelect();
    const warn = $('#rvWarn');
    const msgs = [];
    if (!state.rawData.length) msgs.push('⚠️ <b>Chưa tải danh sách xe</b> từ Google Sheet — chưa so sánh được. Hãy kết nối Sheet rồi mở lại màn này.');
    else if (!isWriteConnected()) msgs.push('ℹ️ Đang ở chế độ <b>chỉ đọc</b>: cập nhật chỉ lưu trên máy này, <b>chưa lên Google Sheet</b>. Kết nối Apps Script (2 chiều) để đồng bộ.');
    warn.innerHTML = msgs.join('<br>'); warn.classList.toggle('hidden', !msgs.length);
    try {
      const n = await backfillItems((i, t) => { $('#rvList').innerHTML = `<p class="hint">Đang tạo mục so sánh cho các tờ đã quét trước đó… ${i}/${t}</p>`; });
      if (n) toast(`Đã nạp ${n} tờ quét trước đó vào màn so sánh.`);
      R.items = (await DB.dbGetAll(ST_ITEMS)).map(normItem);
    } catch (e) { $('#rvList').innerHTML = '<p class="error-text">Lỗi đọc dữ liệu: ' + escapeHtml(e.message) + '</p>'; return; }
    R.page = 1;
    renderReview();
  }

  const matchesSearch = (v) => {
    if (!R.search) return true;
    const q = C.flat(R.search);
    return C.flat((v.it.bienSoRaw || '') + (v.it.scanData.chuXe || '') + (v.row ? v.row.chuXe : '')).includes(q);
  };
  function passesFilter(v) {
    const cat = viewCategory(v), it = v.it;
    switch (R.filter) {
      case 'review': return (cat !== 'match' && (!it.done || it.dirty || it.review === 'chua_kiem')) || (cat === 'match' && !it.done);
      case 'match': return cat === 'match';
      case 'diff': return cat === 'diff';
      case 'orphan': return cat === 'orphan';
      case 'da_kiem': return it.review === 'da_kiem';
      case 'chua_kiem': return it.review === 'chua_kiem';
      case 'img_chua': return !it.imgChecked;   // tiến độ kiểm với ảnh: còn phải làm
      case 'img_da': return !!it.imgChecked;    // đã tick "Đã kiểm với ảnh"
      default: return true;
    }
  }

  /* ---- Ô chỉnh sửa tại chỗ (cả bên phiếu lẫn bên Sheet) ---- */
  function optionsFor(key, cur) {
    let list = null;
    if (key === 'nguoiThucHien') list = assigneeList();
    else if (key === 'tinhTrangCamKet' && typeof COMMITMENT_OPTIONS !== 'undefined') list = COMMITMENT_OPTIONS.slice();
    if (!list) return null;
    if (cur && !list.includes(cur)) list.unshift(cur);
    return list;
  }
  function editorHtml(it, f, side) {
    const key = f.spec.key;
    const val = side === 'scan' ? f.scanVal : (f.sheetEdit != null ? f.sheetEdit : f.dsVal);
    const attrs = `data-act="${side === 'scan' ? 'edit-scan' : 'edit-sheet'}" data-id="${escapeHtml(it.id)}" data-field="${key}"`;
    const list = optionsFor(key, val);
    if (list) {
      return `<select class="row-inline-select rv-edit" ${attrs}><option value="">${key === 'nguoiThucHien' ? '— Chưa chọn —' : '— Chưa cập nhật —'}</option>` +
        list.map(o => `<option value="${escapeHtml(o)}" ${o === val ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('') +
        (key === 'nguoiThucHien' ? `<option value="${ADD_NEW}">+ Thêm người mới...</option>` : '') + '</select>';
    }
    if (key === 'ghiChu') return `<textarea class="rv-edit" rows="2" ${attrs}>${escapeHtml(val)}</textarea>`;
    return `<input type="text" class="rv-edit" ${attrs} value="${escapeHtml(val)}">`;
  }

  function fieldRowHtml(it, f, v) {
    const key = f.spec.key, col = hdr(key), id = escapeHtml(it.id);
    const actionable = isActionable(f.state);
    const leftCls = f.state === 'diff' ? 'diff' : (f.state === 'fill' ? 'fill' : (f.state === 'same' ? 'same' : (f.state === 'sheetedit' ? 'fill' : '')));
    let dec = '';
    const revert = (f.edited || f.sheetEdit != null) ? `<button type="button" class="rv-revert" data-act="revert" data-id="${id}" data-field="${key}" title="Hoàn tác chỉnh sửa trường này">↺</button>` : '';
    if (f.state === 'empty') dec = `<span class="hint">${key === 'nguoiThucHien' ? 'Chọn người thực hiện bên trái để ghi.' : 'Phiếu không có giá trị — nhập/chọn bên trái nếu nhìn ảnh thấy.'}</span>`;
    else if (f.state === 'same') dec = '<span class="rv-same">✔ Khớp</span>' + (f.note ? `<div class="hint">${escapeHtml(f.note)}</div>` : '');
    else {
      const opts = ['apply', 'skip'].concat(f.spec.meta ? [] : ['later']).concat(f.sheetEdit != null ? ['sheetfix'] : []);
      const tagNote = (!f.spec.meta && prefs.tag && f.decision === 'apply') ? ' + dấu 📷 trong «Ghi Chú»' : '';
      let target = '→ không ghi gì';
      if (f.decision === 'apply') target = f.writeVal != null ? `→ ghi vào cột «${escapeHtml(col)}»: <b>${escapeHtml(f.writeVal)}</b>${tagNote}` : '→ (chưa có giá trị để ghi)';
      else if (f.decision === 'sheetfix') target = `→ ghi giá trị Sheet đã sửa vào cột «${escapeHtml(col)}»: <b>${escapeHtml(f.writeVal || '')}</b>`;
      else if (f.decision === 'later') target = '→ chỉ ghi cảnh báo vào cột «Kết quả đối chiếu phiếu»';
      else if (f.decision === 'skip') target = '→ giữ nguyên Google Sheet';
      dec = `<select class="row-inline-select rv-dec rv-dec-${f.decision}" data-act="decide" data-id="${id}" data-field="${key}">` +
        opts.map(k => `<option value="${k}" ${f.decision === k ? 'selected' : ''}>${DEC_LABEL[k]}</option>`).join('') + '</select>' +
        (f.note ? `<div class="hint">${escapeHtml(f.note)}</div>` : '') +
        `<div class="rv-target ${willWrite(f) ? 'on' : ''}">${target}</div>` +
        (willWrite(f) ? `<button type="button" class="btn btn-ghost btn-sm" data-act="apply-field" data-id="${id}" data-field="${key}" title="Chỉ ghi trường này, các trường khác giữ nguyên">⚡ Áp dụng riêng trường này</button>` : '');
    }
    return `<div class="rv-row ${f.spec.meta ? 'rv-meta' : ''}"><div class="rv-field">${escapeHtml(f.spec.label)}<div class="hint">cột «${escapeHtml(col)}»</div></div>
      <div class="rv-cell left ${leftCls} ${f.edited ? 'edited' : ''}">${editorHtml(it, f, 'scan')}${revert}</div>
      <div class="rv-cell right ${f.sheetEdit != null ? 'edited' : ''}">${editorHtml(it, f, 'sheet')}</div>
      <div class="rv-dec-cell">${dec}</div></div>`;
  }

  // Thanh: tick "Đã kiểm với ảnh" + 2 nút xác nhận nhanh (+ nút ký cam kết). Dùng cho cả thẻ lẫn khung ảnh.
  function quickBarHtml(it, found) {
    const id = escapeHtml(it.id);
    return `<label class="rv-tick" title="Đánh dấu tiến độ: đã đối chiếu với ảnh phiếu (lưu ngay, làm dở có thể tiếp tục sau)"><input type="checkbox" data-act="tick-img" data-id="${id}" ${it.imgChecked ? 'checked' : ''}> Đã kiểm với ảnh</label>` +
      (found ? ` <button type="button" class="btn btn-secondary btn-sm" data-act="quick-sheet" data-id="${id}" title="Mọi trường khác biệt: giữ nguyên Sheet">✅ Google Sheet đúng</button>
      <button type="button" class="btn btn-primary btn-sm" data-act="quick-scan" data-id="${id}" title="Mọi trường khác biệt: lấy giá trị từ phiếu (đã chỉnh sửa nếu có)">✅ Dữ liệu từ phiếu scan đúng</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="quick-sign" data-id="${id}" title="Đặt Tình trạng cam kết = ${escapeHtml(SIGNED)}">✍️ Phiếu đã ký cam kết</button>` : '');
  }

  function cardHtml(v) {
    const it = v.it, cat = viewCategory(v);
    const plate = it.bienSoRaw || '(không đọc được biển số)';
    const badges = [`<span class="rv-badge ${cat}">${CAT_LABEL[cat]}${cat === 'diff' ? ` (${v.actionable})` : ''}</span>`,
      `<span class="rv-badge ${it.review}">${it.review === 'da_kiem' ? '✔ Đã kiểm' : '○ Chưa kiểm'}</span>`];
    if (it.imgChecked) badges.push('<span class="rv-badge applied">🖼 Đã kiểm với ảnh</span>');
    if (v.rowCount > 1) badges.push(`<span class="rv-badge warn" title="Có ${v.rowCount} dòng cùng biển trên Sheet; chỉ cập nhật dòng đầu">⚠ ${v.rowCount} dòng trùng biển</span>`);
    if (it.done && !it.dirty) badges.push('<span class="rv-badge applied">Đã áp dụng</span>');
    let body;
    if (cat === 'orphan') {
      const d = it.scanData;
      const dec = it.orphanDecision || 'later';
      body = `<div class="rv-row rv-orphan-row"><div class="rv-field">Dữ liệu trên phiếu</div>
        <div class="rv-cell left fill">${escapeHtml(d.chuXe) || '—'} · CCCD ${escapeHtml(d.cccd) || '—'} · SĐT ${escapeHtml(d.soDienThoai) || '—'}<br>Tình trạng: <b>${escapeHtml(d.tinhTrangLabel)}</b>${d.ghiChu ? '<br>Ghi chú: ' + escapeHtml(d.ghiChu) : ''}</div>
        <div class="rv-cell right"><b>Không có trong danh sách xe.</b><div class="hint">Không gán sang biển gần giống. Sẽ KHÔNG thêm vào dữ liệu xe chính nên không tăng số xe cần rà soát.</div></div>
        <div class="rv-dec-cell">${it.bienSo ? `<select class="row-inline-select rv-dec rv-dec-${dec}" data-act="decide-orphan" data-id="${escapeHtml(it.id)}">` +
          [['apply', '📥 Ghi vào tab "PhieuLa"'], ['skip', '⏭ Không ghi'], ['later', '🕓 Để kiểm sau']].map(([k, l]) => `<option value="${k}" ${dec === k ? 'selected' : ''}>${l}</option>`).join('') + '</select>' : '<span class="hint">Không đọc được biển — chỉ lưu local</span>'}
          ${it.pushError ? `<div class="error-text">${escapeHtml(it.pushError)}</div>` : ''}${it.orphanPushed ? '<div class="rv-same">✔ Đã ghi lên tab PhieuLa</div>' : ''}</div></div>`;
    } else {
      body = v.fields.map(f => fieldRowHtml(it, f, v)).join('');
    }
    const focus = R.pane.open && R.pane.id === it.id ? ' rv-focus' : '';
    return `<div class="rv-card rv-${cat}${focus}" data-id="${escapeHtml(it.id)}">
      <div class="rv-card-head">
        <b class="rv-plate">${escapeHtml(plate)}</b> ${badges.join(' ')}
        <span class="hint rv-src">${escapeHtml(it.sheetLabel)}${it.scanData.tinhTrangGoc ? ' · trên phiếu: “' + escapeHtml(it.scanData.tinhTrangGoc) + '”' : ''}</span>
        <span class="rv-card-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="view" data-id="${escapeHtml(it.id)}" title="Mở ảnh phiếu cạnh bảng so sánh để vừa xem vừa sửa">📷 Xem ảnh phiếu</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="apply-one" data-id="${escapeHtml(it.id)}" ${!state.rawData.length ? 'disabled' : ''}>✅ Áp dụng xe này</button>
        </span>
      </div>
      <div class="rv-quick">${quickBarHtml(it, v.found)}</div>
      <div class="rv-split"><div class="rv-split-head"><div></div><div class="left">📷 Dữ liệu từ phiếu scan <span class="hint">(sửa được)</span></div><div class="right">📋 Hiện có trên Google Sheet <span class="hint">(sửa được)</span></div><div>Quyết định · sẽ ghi vào đâu</div></div>${body}</div>
      ${v.found ? `<div class="hint rv-result">Kết quả đối chiếu sẽ ghi: <i>${escapeHtml(buildResultText(v, plannedFromScan(v)))}</i></div>` : ''}
    </div>`;
  }

  function renderStats(views) {
    const cnt = { match: 0, diff: 0, orphan: 0, da: 0, chua: 0, img: 0 };
    views.forEach(v => { cnt[viewCategory(v)]++; if (v.it.review === 'da_kiem') cnt.da++; else cnt.chua++; if (v.it.imgChecked) cnt.img++; });
    const withScan = new Set(R.items.filter(i => i.bienSo && dsIndex().has(i.bienSo)).map(i => i.bienSo));
    const dsNoScan = (state.rawData || []).filter(r => !withScan.has(norm(r.bienSo))).length;
    $('#rvStats').innerHTML = `<b>${views.length}</b> xe trên phiếu · khớp hoàn toàn <b>${cnt.match}</b> · có khác biệt <b>${cnt.diff}</b> · phiếu lạ <b class="${cnt.orphan ? 'scan-warn' : ''}">${cnt.orphan}</b> · đã kiểm <b>${cnt.da}</b> · chưa kiểm <b>${cnt.chua}</b> · 🖼 đã kiểm với ảnh <b>${cnt.img}/${views.length}</b> · DS chưa có phiếu <b>${dsNoScan}</b>`;
  }

  function renderReview() {
    const views = R.items.map(computeView);
    renderStats(views);
    // --- danh sách ---
    const list = views.filter(v => passesFilter(v) && matchesSearch(v));
    R.listIds = list.map(v => v.it.id);
    const pages = Math.max(1, Math.ceil(list.length / R.pageSize));
    if (R.page > pages) R.page = pages;
    const slice = list.slice((R.page - 1) * R.pageSize, R.page * R.pageSize);
    // Khung ảnh đang mở mà mục đang xem vừa biến khỏi danh sách (vd. đã áp dụng xong) -> tự chuyển sang mục kế tiếp
    if (R.pane.open && !R.listIds.includes(R.pane.id)) {
      const next = slice[0];
      if (next) R.pane.id = next.it.id; else { R.pane.open = false; }
    }
    $('#rvList').innerHTML = slice.length ? slice.map(cardHtml).join('') : '<p class="hint">Không có mục nào trong bộ lọc này.</p>';
    $('#rvPager').innerHTML = pages > 1
      ? `<button type="button" class="btn btn-ghost btn-sm" data-act="page" data-p="${R.page - 1}" ${R.page <= 1 ? 'disabled' : ''}>‹ Trước</button> Trang ${R.page}/${pages} (${list.length} mục) <button type="button" class="btn btn-ghost btn-sm" data-act="page" data-p="${R.page + 1}" ${R.page >= pages ? 'disabled' : ''}>Sau ›</button>`
      : `${list.length} mục`;
    renderFooter(views);
    renderPane(false);
  }

  // Tóm tắt toàn bộ phần SẼ ghi + bản xem trước chi tiết từng thay đổi
  function pendingViews(views) { return views.filter(v => !v.it.done || v.it.dirty); }
  function renderFooter(views) {
    const todo = pendingViews(views || R.items.map(computeView));
    let fApply = 0, fFix = 0, fLater = 0, fSkip = 0, xeApply = 0, orphanPush = 0;
    const lines = [];
    for (const v of todo) {
      const P = escapeHtml(v.it.bienSoRaw);
      if (!v.found) {
        if ((v.it.orphanDecision) === 'apply' && v.it.bienSo) { orphanPush++; lines.push(`<li><b>${P}</b> (phiếu lạ) → thêm 1 dòng vào tab <b>PhieuLa</b></li>`); }
        continue;
      }
      let has = false;
      v.fields.forEach(f => {
        if (willWrite(f)) {
          has = true; if (f.decision === 'sheetfix') fFix++; else fApply++;
          lines.push(`<li><b>${P}</b> · cột «${escapeHtml(hdr(f.spec.key))}»${f.decision === 'sheetfix' ? ' (sửa Sheet)' : ''}: <del>${escapeHtml(f.dsVal || 'trống')}</del> → <ins>${escapeHtml(f.writeVal || '')}</ins></li>`);
        } else if (f.decision === 'later') fLater++; else if (f.decision === 'skip' && !f.spec.meta) fSkip++;
      });
      if (has) xeApply++;
      const planned = plannedFromScan(v);
      if (prefs.tag && planned.length) lines.push(`<li><b>${P}</b> · cột «Ghi Chú»: thêm dấu nguồn <ins>📷Phiếu dd/mm: ${escapeHtml(planned.map(k => TAG_LABEL[k] || k).join(', '))}</ins></li>`);
      lines.push(`<li class="rv-meta-line"><b>${P}</b> · cột «Phiếu scan», «Kiểm phiếu», «Kết quả đối chiếu phiếu» (luôn ghi)</li>`);
    }
    $('#rvFooterSummary').innerHTML = `Chờ áp dụng: <b>${todo.length}</b> mục · sẽ cập nhật <b>${fApply}</b> trường từ phiếu${fFix ? ` + <b>${fFix}</b> trường Sheet sửa tay` : ''} (${xeApply} xe) · để kiểm sau <b>${fLater}</b> · giữ Sheet <b>${fSkip}</b>` + (orphanPush ? ` · phiếu lạ ghi tab riêng <b>${orphanPush}</b>` : '');
    $('#rvPreview').innerHTML = lines.length ? '<ul class="rv-preview-list">' + lines.slice(0, 400).join('') + (lines.length > 400 ? `<li>… và ${lines.length - 400} dòng nữa</li>` : '') + '</ul>' : '<p class="hint">Chưa có thay đổi nào chờ ghi.</p>';
    $('#btnRvApplyAll').disabled = R.busy || !todo.length || !state.rawData.length;
    $('#btnRvApplyAll').textContent = `✅ Áp dụng tất cả (${todo.length} mục)`;
  }

  async function applyViews(vs, label, onlyKeys) {
    R.busy = true; renderFooter();
    let ok = 0, writes = 0;
    const orphans = vs.filter(v => !v.found);
    const founds = vs.filter(v => v.found);
    try {
      for (const v of founds) {
        const r = await applyFoundItem(v, onlyKeys);
        writes += r.writes; ok++;
        if (ok % 10 === 0) { $('#rvFooterSummary').textContent = `${label}… ${ok}/${founds.length}`; await S.yieldToUi(); } // chạy ngầm, nhường UI
      }
      if (orphans.length) await applyOrphanItems(orphans);
    } finally { R.busy = false; }
    R.items = (await DB.dbGetAll(ST_ITEMS)).map(normItem);
    toast(`Đã áp dụng ${ok + orphans.length} mục (${writes} trường cập nhật). ` + (isWriteConnected() ? 'Đang đồng bộ ngầm lên Google Sheet…' : 'Mới lưu trên máy (chưa kết nối ghi Sheet).'));
    renderReview();
    refreshMainTable();
  }

  /* ---- Chỉnh sửa tại chỗ: vẽ lại thẻ SAU một nhịp ngắn ----
     (vẽ lại ngay sẽ làm mất cú click vào nút nằm cùng thẻ: ô nhập mất focus -> "change" chạy giữa mousedown và mouseup) */
  const _rrTimers = new Map();
  function scheduleRerender(it, delay = 250) {
    clearTimeout(_rrTimers.get(it.id));
    _rrTimers.set(it.id, setTimeout(() => rerenderCard(it), delay));
  }
  function rerenderCard(it) {
    const card = document.querySelector(`.rv-card[data-id="${CSS.escape(it.id)}"]`);
    if (card) {
      // Giữ focus ở ô đang nhập (nếu có) sau khi vẽ lại
      const a = document.activeElement;
      const keep = (a && a.dataset && a.dataset.act && a.dataset.id === it.id && a.dataset.field) ? `[data-act="${a.dataset.act}"][data-field="${a.dataset.field}"]` : null;
      card.outerHTML = cardHtml(computeView(it));
      if (keep) { const n = document.querySelector(`.rv-card[data-id="${CSS.escape(it.id)}"] ${keep}`); if (n) n.focus(); }
    }
    renderFooter(); renderStats(R.items.map(computeView)); refreshPaneActions();
  }
  async function persistEdit(it) { it.dirty = it.dirty || it.done; await saveItem(it); }

  // Sửa giá trị BÊN PHIẾU (đọc ảnh thấy khác máy đọc)
  async function onEditScan(it, key, raw) {
    let val = String(raw || '').trim();
    if (val === ADD_NEW) { // chọn "+ Thêm người mới..." ở ô Người thực hiện
      const added = typeof addAssigneeToList === 'function' ? addAssigneeToList(window.prompt('Nhập tên Người thực hiện mới:')) : '';
      val = added || '';
    }
    const base = key === 'nguoiThucHien' ? (prefs.assignee || '') : (it.scanData[key] || '');
    if (val === base) delete it.edits[key]; else it.edits[key] = val;
    // Sửa xong: còn khác Sheet -> mặc định "Lấy từ phiếu" (người dùng đã chủ động sửa); đã khớp -> bỏ quyết định cũ
    const f = computeView(it).fields.find(x => x.spec.key === key);
    if (f && isActionable(f.state) && (key in it.edits)) it.decisions[key] = 'apply'; else if (f && !isActionable(f.state)) delete it.decisions[key];
    await persistEdit(it); scheduleRerender(it, val === ADD_NEW ? 0 : 250);
  }
  // Sửa giá trị BÊN SHEET ngay tại chỗ (Sheet gõ sai) -> ghi giá trị đã sửa lên Sheet khi áp dụng
  async function onEditSheet(it, key, raw) {
    const v = computeView(it); if (!v.row) return;
    const val = String(raw || '').trim(), orig = v.row[key] || '';
    if (val === orig) { delete it.sheetEdits[key]; if (it.decisions[key] === 'sheetfix') delete it.decisions[key]; }
    else { it.sheetEdits[key] = val; it.decisions[key] = 'sheetfix'; }
    await persistEdit(it); scheduleRerender(it);
  }

  // XÁC NHẬN NHANH: đặt quyết định cho MỌI trường đang khác/thiếu chỉ bằng 1 cú bấm
  //  mode 'sheet' = Google Sheet đúng (giữ Sheet; trường người dùng đã sửa Sheet vẫn được ghi)
  //  mode 'scan'  = Dữ liệu từ phiếu scan đúng (lấy giá trị phiếu, gồm cả chỗ đã chỉnh sửa)
  async function quickConfirm(it, mode) {
    const v = computeView(it);
    if (!v.found) return;
    for (const f of v.fields) {
      if (f.spec.meta || !isActionable(f.state)) continue;
      if (mode === 'sheet') it.decisions[f.spec.key] = (f.state === 'sheetedit') ? 'sheetfix' : 'skip';
      else { delete it.sheetEdits[f.spec.key]; it.decisions[f.spec.key] = 'apply'; }
    }
    it.imgChecked = true;                    // xác nhận nhanh nghĩa là người dùng đã đối chiếu xong với ảnh
    it.dirty = true; await saveItem(it);
    if (prefs.quick && isWriteConnectedOrLocal()) await applyViews([computeView(it)], 'Đang áp dụng');
    else rerenderCard(it);
  }
  const isWriteConnectedOrLocal = () => state.rawData.length > 0; // local-first: vẫn áp dụng được khi chưa nối Sheet 2 chiều

  // Đặt "Tình trạng cam kết = Đã ký cam kết" khi nhìn ảnh thấy phiếu đã ký (máy chưa chắc nên cần người xác nhận)
  async function quickSign(it) {
    it.edits.tinhTrangCamKet = SIGNED;
    const f = computeView(it).fields.find(x => x.spec.key === 'tinhTrangCamKet');
    if (f && isActionable(f.state)) it.decisions.tinhTrangCamKet = 'apply'; else delete it.decisions.tinhTrangCamKet;
    it.dirty = it.dirty || it.done; await saveItem(it); rerenderCard(it);
    toast(f && f.state === 'same' ? 'Tình trạng cam kết trên Sheet đã là «' + SIGNED + '».' : 'Đã chọn «' + SIGNED + '» — bấm Áp dụng để ghi.');
  }

  /* ---- KHUNG ẢNH PHIẾU cạnh bảng so sánh ---- */
  const revoke = (u) => URL.revokeObjectURL(u);
  function pageBlock(label, blob, mime, urls) {
    if (!blob) return `<div class="rv-pg"><div class="rv-pg-label">${label}</div><div class="sv-empty">Không có ${escapeHtml(label.toLowerCase())}.</div></div>`;
    const url = URL.createObjectURL(blob); urls.push(url);
    const media = mime === 'application/pdf' ? `<iframe class="rv-pg-pdf" src="${url}" title="${escapeHtml(label)}"></iframe>` : `<img class="rv-pg-img" src="${url}" alt="${escapeHtml(label)}" title="Bấm để phóng to / thu nhỏ">`;
    return `<div class="rv-pg"><div class="rv-pg-label">${label} <a class="btn btn-ghost btn-sm" href="${url}" target="_blank" rel="noopener">↗ Mở tab mới</a></div>${media}</div>`;
  }
  function refreshPaneActions() {
    if (!R.pane.open) return;
    const it = R.items.find(i => i.id === R.pane.id); if (!it) return;
    $('#rvImgActions').innerHTML = quickBarHtml(it, !!(it.bienSo && dsIndex().has(it.bienSo)));
  }
  function applyPaneView() {
    const body = $('#rvImgBody'), p = R.pane;
    body.dataset.mode = p.mode; body.style.setProperty('--z', p.zoom);
    document.querySelectorAll('#rvImgPane [data-pane^="side"], #rvImgPane [data-pane="both"]').forEach(b => b.classList.toggle('btn-primary', b.dataset.pane === (p.mode === 'both' ? 'both' : p.mode)));
  }
  async function renderPane(force) {
    const p = R.pane;
    $('#rvImgPane').classList.toggle('hidden', !p.open);
    $('#rvWork').classList.toggle('with-pane', p.open);
    if (!p.open) { p.urls.forEach(revoke); p.urls = []; p.loadedId = null; return; }
    const it = R.items.find(i => i.id === p.id); if (!it) return;
    refreshPaneActions();
    if (!force && p.loadedId === it.id) return;
    const token = ++p.token;
    const rec = await DB.dbGet(ST_SCANS, it.scanId);
    if (token !== p.token) return;                      // người dùng đã chuyển sang mục khác trong lúc nạp
    p.urls.forEach(revoke); p.urls = []; p.loadedId = it.id;
    $('#rvImgTitle').textContent = '📷 ' + (it.bienSoRaw || '(không đọc được biển)');
    if (!rec) { $('#rvImgInfo').textContent = 'Không tìm thấy ảnh phiếu trong máy này (có thể đã xóa hoặc quét ở máy khác).'; $('#rvImgBody').innerHTML = ''; return; }
    $('#rvImgInfo').innerHTML = `Nguồn: <b>${escapeHtml(rec.sheetLabel || rec.fileName || '')}</b> · quét ${new Date(rec.timestamp).toLocaleString('vi-VN')} · mã ${escapeHtml(rec.id.slice(0, 8))}`;
    $('#rvImgBody').innerHTML = pageBlock('Mặt 1', rec.frontBlob, rec.frontMime, p.urls) +
      (rec.backBlob ? pageBlock('Mặt 2 (xác nhận / chữ ký)', rec.backBlob, rec.backMime, p.urls) : '<div class="rv-pg"><div class="rv-pg-label">Mặt 2</div><div class="sv-empty">Phiếu không có mặt 2.</div></div>');
    applyPaneView();
  }
  async function setFocus(id, scroll) {
    R.pane.open = true; R.pane.id = id;
    document.querySelectorAll('.rv-card.rv-focus').forEach(c => c.classList.remove('rv-focus'));
    const card = document.querySelector(`.rv-card[data-id="${CSS.escape(id)}"]`);
    if (card) { card.classList.add('rv-focus'); if (scroll) card.scrollIntoView({ block: 'nearest' }); }
    await renderPane(false);
  }
  function closePane() { R.pane.open = false; document.querySelectorAll('.rv-card.rv-focus').forEach(c => c.classList.remove('rv-focus')); renderPane(false); }
  // Mục trước / sau trong danh sách đang lọc (tự sang trang nếu cần) — duyệt phiếu liên tục
  function stepFocus(d) {
    const i = R.listIds.indexOf(R.pane.id), j = i + d;
    if (i < 0 || j < 0 || j >= R.listIds.length) return;
    const page = Math.floor(j / R.pageSize) + 1;
    if (page !== R.page) { R.page = page; R.pane.id = R.listIds[j]; renderReview(); setFocus(R.listIds[j], true); }
    else setFocus(R.listIds[j], true);
  }

  function bindReviewUI() {
    $('#btnScanOpenReview').addEventListener('click', open);
    $('#rvFilter').addEventListener('change', (e) => { R.filter = e.target.value; R.page = 1; renderReview(); });
    $('#rvSearch').addEventListener('input', (e) => { R.search = e.target.value.trim(); R.page = 1; renderReview(); });
    // Thanh công cụ: người thực hiện mặc định + 2 tùy chọn
    $('#rvAssignee').addEventListener('change', (e) => {
      let val = e.target.value;
      if (val === ADD_NEW) val = (typeof addAssigneeToList === 'function' && addAssigneeToList(window.prompt('Nhập tên Người thực hiện mới:'))) || '';
      prefs.assignee = val; savePrefs(); buildAssigneeSelect(); renderReview();
    });
    $('#rvChkTag').addEventListener('change', (e) => { prefs.tag = e.target.checked; savePrefs(); renderReview(); });
    $('#rvChkQuick').addEventListener('change', (e) => { prefs.quick = e.target.checked; savePrefs(); });
    $('#btnRvApplyAll').addEventListener('click', async () => {
      const todo = pendingViews(R.items.map(computeView));
      if (!todo.length) return;
      if (!isWriteConnected() && !confirm('Chưa kết nối Apps Script 2 chiều: thay đổi chỉ lưu trên máy này. Vẫn áp dụng?')) return;
      if (!confirm(`Áp dụng ${todo.length} mục theo các lựa chọn hiện tại?\nMục "Để kiểm sau" sẽ không sửa dữ liệu, chỉ ghi cảnh báo vào cột kết quả.`)) return;
      await applyViews(todo, 'Đang áp dụng');
    });
    $('#rvPager').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act="page"]'); if (!b) return;
      R.page = parseInt(b.dataset.p, 10); renderReview(); $('#rvList').scrollIntoView({ block: 'start' });
    });
    const work = $('#rvWork');
    // --- thay đổi giá trị: quyết định, sửa tay 2 bên, tick kiểm ảnh ---
    work.addEventListener('change', async (e) => {
      const el = e.target.closest('[data-act]'); if (!el) return;
      const it = R.items.find(i => i.id === el.dataset.id); if (!it) return;
      const act = el.dataset.act;
      if (act === 'decide') { it.decisions[el.dataset.field] = el.value; await persistEdit(it); rerenderCard(it); }
      else if (act === 'decide-orphan') { it.orphanDecision = el.value; await persistEdit(it); rerenderCard(it); }
      else if (act === 'edit-scan') await onEditScan(it, el.dataset.field, el.value);
      else if (act === 'edit-sheet') await onEditSheet(it, el.dataset.field, el.value);
      else if (act === 'tick-img') { // tiến độ kiểm với ảnh: lưu NGAY để làm dở có thể tiếp tục sau (không đụng Sheet)
        it.imgChecked = el.checked; it.imgCheckedAt = el.checked ? Date.now() : null;
        await saveItem(it);
        if (R.filter === 'img_chua' || R.filter === 'img_da') renderReview(); else rerenderCard(it);
      }
    });
    // --- bấm nút ---
    work.addEventListener('click', async (e) => {
      const pb = e.target.closest('[data-pane]');
      if (pb) {
        const a = pb.dataset.pane, p = R.pane;
        if (a === 'close') closePane();
        else if (a === 'prev') stepFocus(-1);
        else if (a === 'next') stepFocus(1);
        else if (a === 'side1' || a === 'side2' || a === 'both') { p.mode = a === 'both' ? 'both' : a; applyPaneView(); }
        else if (a === 'zoomin') { p.zoom = Math.min(300, p.zoom + 25); applyPaneView(); }
        else if (a === 'zoomout') { p.zoom = Math.max(50, p.zoom - 25); applyPaneView(); }
        else if (a === 'zoomfit') { p.zoom = 100; applyPaneView(); }
        return;
      }
      if (e.target.classList && e.target.classList.contains('rv-pg-img')) { // bấm ảnh: phóng to / vừa khung
        R.pane.zoom = R.pane.zoom > 100 ? 100 : 200; applyPaneView(); return;
      }
      // Khung ảnh đang mở: bấm vào thẻ khác -> ảnh chuyển theo thẻ đó
      const card = e.target.closest('.rv-card');
      if (card && R.pane.open && card.dataset.id !== R.pane.id) setFocus(card.dataset.id, false);
      const b = e.target.closest('[data-act]'); if (!b || ['SELECT', 'INPUT', 'TEXTAREA'].includes(b.tagName)) return;
      const it = R.items.find(i => i.id === b.dataset.id); if (!it) return;
      const act = b.dataset.act;
      if (act === 'view') { R.pane.zoom = 100; await setFocus(it.id, true); }
      else if (act === 'apply-one') {
        if (!isWriteConnected() && !confirm('Chưa kết nối ghi Sheet: chỉ lưu trên máy. Vẫn áp dụng?')) return;
        await applyViews([computeView(it)], 'Đang áp dụng');
      } else if (act === 'apply-field') {
        // Áp dụng RIÊNG 1 trường (các trường khác giữ nguyên, vẫn chờ quyết định)
        await applyViews([computeView(it)], 'Đang áp dụng', [b.dataset.field]);
      } else if (act === 'quick-sheet') await quickConfirm(it, 'sheet');
      else if (act === 'quick-scan') await quickConfirm(it, 'scan');
      else if (act === 'quick-sign') await quickSign(it);
      else if (act === 'revert') { // hoàn tác chỉnh sửa của 1 trường
        delete it.edits[b.dataset.field]; delete it.sheetEdits[b.dataset.field]; delete it.decisions[b.dataset.field];
        await persistEdit(it); rerenderCard(it);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 6. XEM ẢNH PHIẾU (mặt 1 + mặt 2 = trọn 1 phiếu, đến chữ ký xác nhận) */
  /* ------------------------------------------------------------------ */
  const V = { ids: [], idx: 0, plate: '', urls: [] };
  const revokeUrls = () => { V.urls.forEach(u => URL.revokeObjectURL(u)); V.urls = []; };
  function pageHtml(blob, mime, title) {
    if (!blob) return '<div class="sv-empty">Không có mặt này.</div>';
    const url = URL.createObjectURL(blob); V.urls.push(url);
    const dl = `<a class="btn btn-ghost btn-sm" href="${url}" download="${escapeHtml(title)}.${mime === 'application/pdf' ? 'pdf' : 'jpg'}">⬇ Tải</a>`;
    return (mime === 'application/pdf'
      ? `<iframe class="sv-frame" src="${url}" title="${escapeHtml(title)}"></iframe>`
      : `<img class="sv-img" src="${url}" alt="${escapeHtml(title)}" title="Bấm để phóng to / thu nhỏ">`) + `<div class="sv-dl">${dl}</div>`;
  }
  async function showViewerIdx(i) {
    revokeUrls(); V.idx = i;
    const rec = await DB.dbGet(ST_SCANS, V.ids[i]);
    if (!rec) { $('#svInfo').textContent = 'Không tìm thấy ảnh phiếu trong máy này (có thể đã xóa).'; $('#svFront').innerHTML = ''; $('#svBack').innerHTML = ''; return; }
    const items = await itemsByIndex('scanId', rec.id);
    const plates = items.map(it => {
      const cur = it.bienSo && it.bienSo === V.plate;
      return `<span class="scan-plate ${cur ? 'ok' : ''}">${escapeHtml(it.bienSoRaw || '(?)')}</span>`;
    }).join(' ');
    $('#svTabs').innerHTML = V.ids.length > 1
      ? V.ids.map((id, k) => `<button type="button" class="btn ${k === i ? 'btn-primary' : 'btn-ghost'} btn-sm" data-sv="${k}">Phiếu ${k + 1}</button>`).join(' ') : '';
    $('#svInfo').innerHTML = `Nguồn: <b>${escapeHtml(rec.sheetLabel || rec.fileName || '')}</b> · quét lúc ${new Date(rec.timestamp).toLocaleString('vi-VN')} · mã ${escapeHtml(rec.id.slice(0, 8))}` +
      `<br>Phiếu này gồm ${items.length} xe (cùng mở ra ảnh này): ${plates}`;
    $('#svFront').innerHTML = pageHtml(rec.frontBlob, rec.frontMime, 'phieu-mat1-' + rec.id.slice(0, 8));
    $('#svBack').innerHTML = rec.backBlob
      ? pageHtml(rec.backBlob, rec.backMime, 'phieu-mat2-' + rec.id.slice(0, 8)) + (rec.backBlank ? '<div class="hint">Mặt 2 gần như trống.</div>' : '')
      : '<div class="sv-empty">Phiếu không có mặt 2.</div>';
  }
  async function openViewer({ plate, scanId }) {
    const link = plate ? linkMap.get(plate) : null;
    const ids = scanId ? [scanId, ...(link ? link.scanIds.filter(x => x !== scanId) : [])] : (link ? link.scanIds.slice() : []);
    if (!ids.length) { toast('Xe này chưa có phiếu scan lưu trên máy này.', true); return; }
    V.ids = ids; V.plate = plate || '';
    $('#svTitle').textContent = '📷 Phiếu scan' + (plate ? ' — ' + plate : '');
    openModal('scanViewerModal');
    await showViewerIdx(0);
  }
  function bindViewerUI() {
    $('#svTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-sv]'); if (b) showViewerIdx(parseInt(b.dataset.sv, 10)); });
    $('#scanViewerModal').addEventListener('click', (e) => { if (e.target.classList.contains('sv-img')) e.target.classList.toggle('zoom'); });
    // Dọn URL ảnh khi đóng (nút ✕ hoặc click nền — app.js đã xử lý đóng, ta chỉ thu dọn)
    $('#scanViewerModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target.id === 'scanViewerModal') setTimeout(revokeUrls, 300); });
  }

  /* ------------------------------------------------------------------ */
  /* 7. LỌC + ICON TRÊN BẢNG CHÍNH (qua window.ScanHooks, app.js gọi vào)  */
  /* ------------------------------------------------------------------ */
  const FILTER_KEY = 'vehicleScanFilterV1';
  const filter = { hasScan: false, review: '' };
  try { Object.assign(filter, JSON.parse(localStorage.getItem(FILTER_KEY) || '{}')); } catch (e) { /* bỏ qua */ }
  const saveFilter = () => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(filter)); } catch (e) { /* bỏ qua */ } };

  // Trạng thái "Kiểm phiếu" của 1 xe: ưu tiên dữ liệu local; nếu không có (máy khác) dùng cột trên Sheet
  function reviewOf(row) {
    const l = linkMap.get(norm(row.bienSo));
    if (l && !l.orphan) return l.review;
    const k = (row.kiemPhieu || '').trim();
    return k === 'Đã kiểm' ? 'da_kiem' : (k === 'Chưa kiểm' ? 'chua_kiem' : '');
  }
  function hasScanOf(row) {
    const l = linkMap.get(norm(row.bienSo));
    return !!(l && !l.orphan) || !!(row.phieuScan || '').trim();
  }
  window.ScanHooks = {
    // Lọc: được getFiltered() của app.js gọi cho từng dòng
    // Số điều kiện lọc phiếu đang bật (layout.js dùng để hiện huy hiệu khi khối lọc thu gọn)
    activeCount() { return (filter.hasScan || filter.review) ? 1 : 0; },
    rowPassesFilter(row) {
      if (!filter.hasScan && !filter.review) return true;
      if (!hasScanOf(row)) return false;
      return !filter.review || reviewOf(row) === filter.review;
    },
    // Icon 📷 cạnh biển số (bảng chính + bảng mini trong panel chi tiết)
    badgeHtml(row) {
      const l = linkMap.get(norm(row.bienSo));
      if (l && !l.orphan) {
        const ok = l.review === 'da_kiem';
        return ` <button type="button" class="scan-badge-btn ${ok ? 'ok' : 'pending'}" data-role="scan-view" data-rowid="${row._rowId}" title="${ok ? 'Đã kiểm' : 'Chưa kiểm'} — bấm để xem phiếu scan${l.result ? ': ' + escapeHtml(l.result) : ''}">📷</button>`;
      }
      if ((row.phieuScan || '').trim()) return ` <span class="scan-badge-btn remote" title="Có phiếu scan (${escapeHtml(row.phieuScan)}) — ảnh lưu ở máy khác">📷</span>`;
      return '';
    },
    // Nút "Xem phiếu scan" trong thẻ chủ xe của panel chi tiết
    detailButtonHtml(row) {
      const l = linkMap.get(norm(row.bienSo));
      if (!l || l.orphan) return '';
      return `<button type="button" class="btn btn-secondary btn-sm" data-role="scan-view" data-rowid="${row._rowId}">📷 Xem phiếu scan (${escapeHtml(row.bienSo)})</button>`;
    },
  };

  function syncFilterUI() {
    $('#chkHasScan').checked = !!(filter.hasScan || filter.review);
    $('#selScanReview').value = filter.review || '';
  }
  function bindFilterUI() {
    syncFilterUI();
    const apply = () => { saveFilter(); syncFilterUI(); state.page = 1; renderTable(); };
    $('#chkHasScan').addEventListener('change', (e) => { filter.hasScan = e.target.checked; if (!e.target.checked) filter.review = ''; apply(); });
    $('#selScanReview').addEventListener('change', (e) => { filter.review = e.target.value; if (filter.review) filter.hasScan = true; apply(); });
    // "Xóa bộ lọc" của app.js cũng reset bộ lọc phiếu (listener của app.js chạy trước, ta vẽ lại sau)
    $('#btnClearFilters').addEventListener('click', () => { filter.hasScan = false; filter.review = ''; saveFilter(); syncFilterUI(); renderTable(); });
  }
  // Click icon 📷 / nút "Xem phiếu scan": bắt ở pha capture để KHÔNG kích hoạt mở panel chi tiết của dòng
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-role="scan-view"]');
    if (!b) return;
    e.stopPropagation(); e.preventDefault();
    const row = state.rawData.find(r => r._rowId === b.dataset.rowid);
    if (row) openViewer({ plate: norm(row.bienSo) });
  }, true);

  /* ------------------------------------------------------------------ */
  async function init() {
    await loadLinks();
    bindReviewUI(); bindViewerUI(); bindFilterUI();
    // Chip "Đang quét…" trên thanh đầu trang: bấm để mở lại cửa sổ Quét phiếu
    const chip = $('#scanBgChip'); if (chip) chip.addEventListener('click', () => openModal('scanModal'));
    if (linkMap.size) refreshMainTable(); // dữ liệu xe có thể đã vẽ trước khi nạp liên kết -> vẽ lại để hiện icon
  }
  init();

  return { open, openViewer, linkMap, computeView, createItemsForScan, backfillItems };
})();
window.ScanReview = ScanReview;
