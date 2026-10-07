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

  function syncSettingsUi() {
    const c = Y.config();
    document.querySelectorAll('input[name="scanStoreMode"]').forEach(r => { r.checked = r.value === c.mode; });
    const u2 = q('#scanStoreUrl2'); if (u2) u2.value = c.url2 || '';
    q('#scanStoreUrl2Row').classList.toggle('hidden', pickedMode() !== 'gas2');
  }
  const pickedMode = () => (document.querySelector('input[name="scanStoreMode"]:checked') || {}).value || 'gas';

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
    const mode = pickedMode(), url2 = (q('#scanStoreUrl2').value || '').trim();
    if (mode === 'gas2' && !Y.validUrl(url2)) { setMsg('#scanStoreMsg', '❌ URL chưa đúng dạng <code>https://script.google.com/macros/s/…/exec</code>', true); return; }
    const before = Y.config(), oldKey = before.mode + '|' + (before.mode === 'gas2' ? before.url2 : '');
    const newKey = mode + '|' + (mode === 'gas2' ? url2 : '');
    Y.setConfig({ mode, url2 });
    let msg = '✅ Đã lưu cách lưu trữ.';
    if (oldKey !== newKey && mode !== 'off') {
      if (confirm('Bạn vừa đổi nơi lưu ảnh.\n\nĐẩy lại TOÀN BỘ ảnh đang có trên máy này sang nơi mới? (nên chọn OK; ảnh ở nơi cũ không bị xóa)')) {
        const n = await resetCloudFlags(); msg += ` Sẽ đẩy lại ${n} phiếu sang nơi mới.`;
      }
    }
    setMsg('#scanStoreMsg', msg); Y.refreshStatus(); if (mode !== 'off') Y.run();
  }
  async function testSettings() {
    // Dùng đúng lựa chọn đang hiện trên màn hình (chưa cần bấm Lưu)
    const mode = pickedMode(), url2 = (q('#scanStoreUrl2').value || '').trim(), prev = Y.config();
    Y.setConfig({ mode, url2 }); setMsg('#scanStoreMsg', '⏳ Đang kiểm tra…');
    const r = await Y.testConnection();
    Y.setConfig(prev);                 // khôi phục: chỉ nút «Lưu» mới đổi cấu hình thật
    setMsg('#scanStoreMsg', r.ok ? `✅ Kết nối được. Đang có ${r.count} phiếu online.` : '❌ ' + esc(r.error) + (/Apps Script chưa hỗ trợ|scan/i.test(r.error) ? '<br>Gợi ý: dán PHẦN 2 + 3 trong AppsScript_ScanPatch.gs rồi Deploy → New version.' : ''), !r.ok);
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
  const vaultPass = () => (q('#scanVaultPass').value || '').trim();

  async function vaultPush() {
    if (!window.crypto || !crypto.subtle) { setMsg('#scanVaultMsg', '❌ Trình duyệt không hỗ trợ mã hóa (cần HTTPS).', true); return; }
    const pass = vaultPass(); if (pass.length < 6) { setMsg('#scanVaultMsg', '❌ Mật khẩu tối thiểu 6 ký tự.', true); return; }
    if (!Y.online()) { setMsg('#scanVaultMsg', '❌ Chưa kết nối nơi lưu online (xem mục Lưu trữ phía trên).', true); return; }
    const keys = (await S.keys.listKeys()).map(k => ({ label: k.label, key: k.key, enabled: k.enabled }));
    if (!keys.length) { setMsg('#scanVaultMsg', '❌ Máy này chưa có key nào để đẩy lên.', true); return; }
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(pass, salt), new TextEncoder().encode(JSON.stringify({ keys })));
      await Y.call({ action: 'scanPut', scanId: VAULT.scanId, kind: VAULT.kind, mime: 'application/json', plates: '', text: JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(enc)) }) });
      setMsg('#scanVaultMsg', `✅ Đã đẩy ${keys.length} key lên (đã mã hóa). Nhớ mật khẩu — quên là KHÔNG khôi phục được.`);
    } catch (e) { setMsg('#scanVaultMsg', '❌ ' + esc(e.message || e), true); }
  }
  async function vaultPull() {
    if (!window.crypto || !crypto.subtle) { setMsg('#scanVaultMsg', '❌ Trình duyệt không hỗ trợ mã hóa (cần HTTPS).', true); return; }
    const pass = vaultPass(); if (!pass) { setMsg('#scanVaultMsg', '❌ Nhập mật khẩu đã dùng khi đẩy key lên.', true); return; }
    if (!Y.online()) { setMsg('#scanVaultMsg', '❌ Chưa kết nối nơi lưu online.', true); return; }
    try {
      const r = await Y.call({ action: 'scanTextGet', ...VAULT }), box = JSON.parse(r.text);
      let plain;
      try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await deriveKey(pass, unb64(box.salt)), unb64(box.data)); }
      catch (e) { throw new Error('Sai mật khẩu hoặc dữ liệu kho khóa bị hỏng.'); }
      const incoming = JSON.parse(new TextDecoder().decode(plain)).keys || [], have = new Set((await S.keys.listKeys()).map(k => k.key));
      let added = 0;
      for (const k of incoming) { if (!k.key || have.has(k.key)) continue; const rec = await S.keys.addKey(k.label, k.key); if (k.enabled === false) await S.keys.patchKey(rec.id, { enabled: false }); added++; }
      S.keys.refreshUi();
      setMsg('#scanVaultMsg', `✅ Đã lấy về ${added} key mới (bỏ qua ${incoming.length - added} key đã có).`);
    } catch (e) { setMsg('#scanVaultMsg', '❌ ' + esc(e.message || e), true); }
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
    document.querySelectorAll('input[name="scanStoreMode"]').forEach(r => r.addEventListener('change', syncSettingsUi));
    q('#btnScanStoreSave').addEventListener('click', saveSettings);
    q('#btnScanStoreTest').addEventListener('click', testSettings);
    q('#btnVaultPush').addEventListener('click', vaultPush);
    q('#btnVaultPull').addEventListener('click', vaultPull);
    document.querySelectorAll('[data-open-scanstore]').forEach(b => b.addEventListener('click', open));
    syncSettingsUi();
  }

  async function open() { K.limit = 50; openModal('scanStoreModal'); await reload(); }
  bind();
  return { open, reload, removeScan, removeBack };
})();
window.ScanStore = ScanStore;
