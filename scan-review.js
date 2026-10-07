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
  // Ghi nhận: so sánh luôn dùng dữ liệu HIỆN TẠI của Sheet -> trường đã cập nhật tự thành "khớp".
  function computeView(it) {
    const rows = it.bienSo ? (dsIndex().get(it.bienSo) || []) : [];
    const row = rows[0] || null;
    const v = { it, row, rowCount: rows.length, found: !!row, fields: [], actionable: 0, later: 0 };
    if (!row) return v;
    for (const spec of SPECS) {
      const sv = it.scanData[spec.key] || '', dsv = row[spec.key] || '';
      const c = spec.cmp(sv, dsv);
      let decision = null;
      if (c.state === 'fill' || c.state === 'diff') {
        decision = (it.decisions && it.decisions[spec.key]) || c.defaultDecision || (c.state === 'fill' ? 'apply' : 'later');
        // Biển trùng nhiều dòng trên Sheet -> không chắc dòng nào: mặc định để kiểm sau
        if (v.rowCount > 1 && !(it.decisions && it.decisions[spec.key])) decision = 'later';
        v.actionable++;
        if (decision === 'later') v.later++;
      }
      v.fields.push({ spec, scanVal: sv, dsVal: dsv, state: c.state, newVal: c.newVal, note: c.note || '', decision });
    }
    return v;
  }
  // Chuỗi mô tả ghi vào cột "Kết quả đối chiếu phiếu" của Sheet
  function buildResultText(v) {
    const it = v.it, parts = [];
    if (it.scanData.tinhTrangCode !== 'khong_ro') parts.push(it.scanData.tinhTrangLabel);
    if (!v.found) parts.push('Chưa có trong DS');
    else if (!v.actionable) parts.push(v.fields.some(f => f.decision === 'applied') ? 'Đã cập nhật từ phiếu' : 'Khớp DS');
    else {
      const pend = v.fields.filter(f => f.decision === 'later').map(f => `${f.spec.label}: phiếu "${f.scanVal}" ≠ Sheet "${f.dsVal || 'trống'}"`);
      parts.push(pend.length ? 'Cần kiểm: ' + pend.join('; ') : 'Đã đối chiếu');
    }
    return parts.join(' · ').slice(0, 400);
  }
  const viewCategory = (v) => !v.found ? 'orphan' : (v.actionable ? 'diff' : 'match');

  /* ------------------------------------------------------------------ */
  /* 4. ÁP DỤNG                                                           */
  /* ------------------------------------------------------------------ */
  async function saveItem(it) { it.updatedAt = Date.now(); await DB.dbPut(ST_ITEMS, it); }

  // Áp dụng 1 mục có trên DS. Trả về { writes: số trường ghi }.
  async function applyFoundItem(v) {
    const it = v.it, row = v.row;
    const toWrite = {};
    for (const f of v.fields) {
      if (f.decision === 'apply' && f.newVal != null) { toWrite[f.spec.key] = f.newVal; it.applied[f.spec.key] = true; }
    }
    const pendingLater = v.fields.some(f => f.decision === 'later');
    it.review = pendingLater ? 'chua_kiem' : 'da_kiem';
    // Tính "kết quả" SAU khi coi các trường 'apply' đã xong (để chuỗi kết quả không nhắc lại chúng)
    const after = { ...v, actionable: v.actionable, fields: v.fields.map(f => f.decision === 'apply' ? { ...f, decision: 'applied' } : f) };
    after.actionable = after.fields.filter(f => f.decision === 'later' || f.decision === 'skip').length;
    it.result = buildResultText(after);
    // Metadata luôn ghi (kể cả mục "để kiểm sau") -> chính là phần "ghi vào cột trống tương ứng, tạo cột mới nếu cần":
    // updateRow_() trong Apps Script tự tạo cột chưa có.
    const meta = {
      phieuScan: `Có — ${it.sheetLabel} (mã ${it.scanId.slice(0, 8)})`,
      kiemPhieu: it.review === 'da_kiem' ? 'Đã kiểm' : 'Chưa kiểm',
      ketQuaPhieu: it.result,
    };
    // updateSingleRowFields = local-first + hàng đợi đồng bộ ngầm sẵn có của app
    await updateSingleRowFields(row, { ...toWrite, ...meta });
    it.done = true; it.dirty = false; it.orphan = false;
    await saveItem(it);
    await recomputeLink(it.bienSo);
    return { writes: Object.keys(toWrite).length };
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
  const R = { items: [], filter: 'review', search: '', page: 1, pageSize: 12, busy: false };
  const DEC_LABEL = { apply: '✅ Cập nhật', skip: '⏭ Không cập nhật', later: '🕓 Để kiểm sau' };
  const CAT_LABEL = { match: 'Khớp hoàn toàn', diff: 'Có khác biệt', orphan: 'Phiếu lạ (chưa có trong DS)' };

  async function open() {
    openModal('scanReviewModal');
    $('#rvList').innerHTML = '<p class="hint">Đang nạp dữ liệu…</p>';
    const warn = $('#rvWarn');
    const msgs = [];
    if (!state.rawData.length) msgs.push('⚠️ <b>Chưa tải danh sách xe</b> từ Google Sheet — chưa so sánh được. Hãy kết nối Sheet rồi mở lại màn này.');
    else if (!isWriteConnected()) msgs.push('ℹ️ Đang ở chế độ <b>chỉ đọc</b>: cập nhật chỉ lưu trên máy này, <b>chưa lên Google Sheet</b>. Kết nối Apps Script (2 chiều) để đồng bộ.');
    warn.innerHTML = msgs.join('<br>'); warn.classList.toggle('hidden', !msgs.length);
    try {
      const n = await backfillItems((i, t) => { $('#rvList').innerHTML = `<p class="hint">Đang tạo mục so sánh cho các tờ đã quét trước đó… ${i}/${t}</p>`; });
      if (n) toast(`Đã nạp ${n} tờ quét trước đó vào màn so sánh.`);
      R.items = await DB.dbGetAll(ST_ITEMS);
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
      default: return true;
    }
  }

  function fieldRowHtml(it, f, v) {
    const actionable = f.state === 'fill' || f.state === 'diff';
    const col = hdr(f.spec.key);
    let leftCls = '', right = '', dec = '';
    if (f.state === 'empty') { right = '<span class="hint">—</span>'; dec = '<span class="hint">Phiếu không có</span>'; }
    else if (f.state === 'same') { leftCls = 'same'; dec = '<span class="rv-same">✔ Khớp</span>' + (f.note ? `<div class="hint">${escapeHtml(f.note)}</div>` : ''); }
    else {
      leftCls = f.state === 'diff' ? 'diff' : 'fill';
      dec = `<select class="row-inline-select rv-dec rv-dec-${f.decision}" data-act="decide" data-id="${escapeHtml(it.id)}" data-field="${f.spec.key}">` +
        ['apply', 'skip', 'later'].map(k => `<option value="${k}" ${f.decision === k ? 'selected' : ''}>${DEC_LABEL[k]}</option>`).join('') + '</select>' +
        (f.note ? `<div class="hint">${escapeHtml(f.note)}</div>` : '') +
        `<div class="rv-target ${f.decision === 'apply' ? 'on' : ''}">${f.decision === 'apply'
          ? `→ ghi vào cột «${escapeHtml(col)}»: <b>${escapeHtml(f.newVal || '')}</b>`
          : (f.decision === 'later' ? `→ chỉ ghi cảnh báo vào cột «Kết quả đối chiếu phiếu»` : '→ không ghi gì')}</div>`;
    }
    const dsCell = f.dsVal ? escapeHtml(f.dsVal) : '<span class="hint">(trống)</span>';
    return `<div class="rv-row"><div class="rv-field">${escapeHtml(f.spec.label)}<div class="hint">cột «${escapeHtml(col)}»</div></div>
      <div class="rv-cell left ${leftCls}">${f.scanVal ? escapeHtml(f.scanVal) : '<span class="hint">—</span>'}</div>
      <div class="rv-cell right">${f.state === 'empty' ? right : dsCell}</div>
      <div class="rv-dec-cell">${dec}</div></div>`;
  }

  function cardHtml(v) {
    const it = v.it, cat = viewCategory(v);
    const plate = it.bienSoRaw || '(không đọc được biển số)';
    const badges = [`<span class="rv-badge ${cat}">${CAT_LABEL[cat]}${cat === 'diff' ? ` (${v.actionable})` : ''}</span>`,
      `<span class="rv-badge ${it.review}">${it.review === 'da_kiem' ? '✔ Đã kiểm' : '○ Chưa kiểm'}</span>`];
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
    return `<div class="rv-card rv-${cat}" data-id="${escapeHtml(it.id)}">
      <div class="rv-card-head">
        <b class="rv-plate">${escapeHtml(plate)}</b> ${badges.join(' ')}
        <span class="hint rv-src">${escapeHtml(it.sheetLabel)}${it.scanData.tinhTrangGoc ? ' · trên phiếu: “' + escapeHtml(it.scanData.tinhTrangGoc) + '”' : ''}</span>
        <span class="rv-card-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="view" data-id="${escapeHtml(it.id)}">📷 Xem ảnh phiếu</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="apply-one" data-id="${escapeHtml(it.id)}" ${!state.rawData.length ? 'disabled' : ''}>✅ Áp dụng xe này</button>
        </span>
      </div>
      <div class="rv-split"><div class="rv-split-head"><div></div><div class="left">📷 Dữ liệu từ phiếu scan</div><div class="right">📋 Hiện có trên Google Sheet</div><div>Quyết định · sẽ ghi vào đâu</div></div>${body}</div>
      ${v.found ? `<div class="hint rv-result">Kết quả đối chiếu sẽ ghi: <i>${escapeHtml(buildResultText(v))}</i></div>` : ''}
    </div>`;
  }

  function renderReview() {
    const views = R.items.map(computeView);
    // --- thống kê ---
    const cnt = { match: 0, diff: 0, orphan: 0, da: 0, chua: 0 };
    views.forEach(v => { cnt[viewCategory(v)]++; if (v.it.review === 'da_kiem') cnt.da++; else cnt.chua++; });
    const withScan = new Set(R.items.filter(i => i.bienSo && dsIndex().has(i.bienSo)).map(i => i.bienSo));
    const dsNoScan = (state.rawData || []).filter(r => !withScan.has(norm(r.bienSo))).length;
    $('#rvStats').innerHTML = `<b>${views.length}</b> xe trên phiếu · khớp hoàn toàn <b>${cnt.match}</b> · có khác biệt <b>${cnt.diff}</b> · phiếu lạ <b class="${cnt.orphan ? 'scan-warn' : ''}">${cnt.orphan}</b> · đã kiểm <b>${cnt.da}</b> · chưa kiểm <b>${cnt.chua}</b> · DS chưa có phiếu <b>${dsNoScan}</b>`;
    // --- danh sách ---
    const list = views.filter(v => passesFilter(v) && matchesSearch(v));
    const pages = Math.max(1, Math.ceil(list.length / R.pageSize));
    if (R.page > pages) R.page = pages;
    const slice = list.slice((R.page - 1) * R.pageSize, R.page * R.pageSize);
    $('#rvList').innerHTML = slice.length ? slice.map(cardHtml).join('') : '<p class="hint">Không có mục nào trong bộ lọc này.</p>';
    $('#rvPager').innerHTML = pages > 1
      ? `<button type="button" class="btn btn-ghost btn-sm" data-act="page" data-p="${R.page - 1}" ${R.page <= 1 ? 'disabled' : ''}>‹ Trước</button> Trang ${R.page}/${pages} (${list.length} mục) <button type="button" class="btn btn-ghost btn-sm" data-act="page" data-p="${R.page + 1}" ${R.page >= pages ? 'disabled' : ''}>Sau ›</button>`
      : `${list.length} mục`;
    renderFooter(views);
  }

  // Tóm tắt toàn bộ phần SẼ ghi + bản xem trước chi tiết từng thay đổi
  function pendingViews(views) { return views.filter(v => !v.it.done || v.it.dirty); }
  function renderFooter(views) {
    const todo = pendingViews(views || R.items.map(computeView));
    let fApply = 0, fLater = 0, fSkip = 0, xeApply = 0, orphanPush = 0;
    const lines = [];
    for (const v of todo) {
      if (!v.found) {
        if ((v.it.orphanDecision) === 'apply' && v.it.bienSo) { orphanPush++; lines.push(`<li><b>${escapeHtml(v.it.bienSoRaw)}</b> (phiếu lạ) → thêm 1 dòng vào tab <b>PhieuLa</b></li>`); }
        continue;
      }
      let has = false;
      v.fields.forEach(f => {
        if (f.decision === 'apply') { fApply++; has = true; lines.push(`<li><b>${escapeHtml(v.it.bienSoRaw)}</b> · cột «${escapeHtml(hdr(f.spec.key))}»: <del>${escapeHtml(f.dsVal || 'trống')}</del> → <ins>${escapeHtml(f.newVal || '')}</ins></li>`); }
        else if (f.decision === 'later') fLater++; else if (f.decision === 'skip') fSkip++;
      });
      if (has) xeApply++;
      lines.push(`<li class="rv-meta-line"><b>${escapeHtml(v.it.bienSoRaw)}</b> · cột «Phiếu scan», «Kiểm phiếu», «Kết quả đối chiếu phiếu» (luôn ghi)</li>`);
    }
    $('#rvFooterSummary').innerHTML = `Chờ áp dụng: <b>${todo.length}</b> mục · sẽ cập nhật <b>${fApply}</b> trường (${xeApply} xe) · để kiểm sau <b>${fLater}</b> · không cập nhật <b>${fSkip}</b>` + (orphanPush ? ` · phiếu lạ ghi tab riêng <b>${orphanPush}</b>` : '');
    $('#rvPreview').innerHTML = lines.length ? '<ul class="rv-preview-list">' + lines.slice(0, 400).join('') + (lines.length > 400 ? `<li>… và ${lines.length - 400} dòng nữa</li>` : '') + '</ul>' : '<p class="hint">Chưa có thay đổi nào chờ ghi.</p>';
    $('#btnRvApplyAll').disabled = R.busy || !todo.length || !state.rawData.length;
    $('#btnRvApplyAll').textContent = `✅ Áp dụng tất cả (${todo.length} mục)`;
  }

  async function applyViews(vs, label) {
    R.busy = true; renderFooter();
    let ok = 0, writes = 0;
    const orphans = vs.filter(v => !v.found);
    const founds = vs.filter(v => v.found);
    try {
      for (const v of founds) {
        const r = await applyFoundItem(v);
        writes += r.writes; ok++;
        if (ok % 10 === 0) { $('#rvFooterSummary').textContent = `${label}… ${ok}/${founds.length}`; await S.yieldToUi(); } // chạy ngầm, nhường UI
      }
      if (orphans.length) await applyOrphanItems(orphans);
    } finally { R.busy = false; }
    R.items = await DB.dbGetAll(ST_ITEMS);
    toast(`Đã áp dụng ${ok + orphans.length} mục (${writes} trường cập nhật). ` + (isWriteConnected() ? 'Đang đồng bộ ngầm lên Google Sheet…' : 'Mới lưu trên máy (chưa kết nối ghi Sheet).'));
    renderReview();
    refreshMainTable();
  }

  function bindReviewUI() {
    $('#btnScanOpenReview').addEventListener('click', open);
    $('#rvFilter').addEventListener('change', (e) => { R.filter = e.target.value; R.page = 1; renderReview(); });
    $('#rvSearch').addEventListener('input', (e) => { R.search = e.target.value.trim(); R.page = 1; renderReview(); });
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
    $('#rvList').addEventListener('change', async (e) => {
      const el = e.target.closest('[data-act]'); if (!el) return;
      const it = R.items.find(i => i.id === el.dataset.id); if (!it) return;
      if (el.dataset.act === 'decide') it.decisions[el.dataset.field] = el.value;
      else if (el.dataset.act === 'decide-orphan') it.orphanDecision = el.value;
      else return;
      it.dirty = it.done; await saveItem(it); // sửa quyết định sau khi đã áp dụng -> đánh dấu cần áp dụng lại
      const card = el.closest('.rv-card');
      card.outerHTML = cardHtml(computeView(it));
      renderFooter();
    });
    $('#rvList').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
      const it = R.items.find(i => i.id === b.dataset.id); if (!it) return;
      if (b.dataset.act === 'view') openViewer({ scanId: it.scanId, plate: it.bienSo });
      else if (b.dataset.act === 'apply-one') {
        if (!isWriteConnected() && !confirm('Chưa kết nối ghi Sheet: chỉ lưu trên máy. Vẫn áp dụng?')) return;
        await applyViews([computeView(it)], 'Đang áp dụng');
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
