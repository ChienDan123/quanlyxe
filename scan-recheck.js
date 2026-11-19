/* =============================================================================
   scan-recheck.js — AI đối chiếu ảnh phiếu ↔ Google Sheet (Gemini), khoá trường,
   đánh dấu nghi vấn, chạy ngầm ưu tiên thấp, lưu tiến độ.
   Phụ thuộc (đã có, phải là GLOBAL hoặc trên window.S):
     computeView, applyViews, applyFoundItem, saveItem, normItem, goToItem,
     setFocus, renderReview, record, refreshMainTable, clone, toast, DB, ST_SCANS, ST_ITEMS, S, R, $
   Và S.geminiGenerate (phải được export ở return cuối scan.js)
   ============================================================================= */
(function () {
  'use strict';

  const THRESH_CONFIDENT = 90;                  // ngưỡng «chắc chắn» cho trường
  const PROGRESS_KEY = 'scanRecheckProgress_v1';

  /* ---------- Schema Gemini: đọc ảnh + đối chiếu từng trường ---------- */
  const AI_CMP_SCHEMA = {
    type: 'OBJECT',
    properties: {
      fields: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            key: { type: 'STRING' },
            imageValue: { type: 'STRING' },      // giá trị đọc được TRÊN ẢNH (lần 1)
            imageValue2: { type: 'STRING' },     // đọc LẠI độc lập (lần 2) — phải khớp imageValue nếu chắc chắn
            matchesScan: { type: 'BOOLEAN' },    // khớp «📷 TỪ PHIẾU SCAN» (máy đọc lần trước)
            matchesSheet: { type: 'BOOLEAN' },   // khớp «📋 GOOGLE SHEET»
            confidence: { type: 'INTEGER' },     // 0..100
            reason: { type: 'STRING' },
            regionHint: { type: 'STRING' },
          },
          required: ['key', 'imageValue', 'imageValue2', 'matchesScan', 'matchesSheet', 'confidence', 'reason'],
        },
      },
      truongKhongRo: { type: 'ARRAY', items: { type: 'STRING' } },   // key không đọc rõ
      notes: { type: 'STRING' },
    },
    required: ['fields'],
  };

  /* ---------- Helpers ---------- */
  function _blobToB64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ''); const i = s.indexOf(','); res(i >= 0 ? s.slice(i + 1) : s); };
      fr.onerror = () => rej(fr.error || new Error('FileReader'));
      fr.readAsDataURL(blob);
    });
  }
  const _normStr = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  const _normKey = (s) => String(s == null ? '' : s).replace(/\s+/g, '').trim();

  function _saveProgress(p) { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (_) {} }
  function _loadProgress() { try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null'); } catch (_) { return null; } }
  function _clearProgress() { try { localStorage.removeItem(PROGRESS_KEY); } catch (_) {} }

  /* ---------- HÀM MỚI: aiCompareItem — lõi so sánh ảnh ↔ Sheet ---------- */
  async function aiCompareItem(it, opts) {
    if (typeof S === 'undefined' || typeof S.geminiGenerate !== 'function') {
      throw new Error('Thiếu S.geminiGenerate — kiểm tra khối return của scan.js');
    }
    // 1) Nạp phiếu (ảnh)
    let rec = await DB.dbGet(ST_SCANS, it.scanId);
    if (rec && window.ScanSync && !rec.frontBlob && rec.cloud) rec = await ScanSync.ensureBlobs(rec);
    if (!rec || !rec.frontBlob) throw new Error('Không tìm thấy ảnh phiếu trong máy này để kiểm lại.');

    // 2) Dựng parts: ảnh + prompt
    const parts = [];
    parts.push({ inlineData: { mimeType: rec.frontMime || 'image/jpeg', data: await _blobToB64(rec.frontBlob) } });
    if (rec.backBlob) parts.push({ inlineData: { mimeType: rec.backMime || 'image/jpeg', data: await _blobToB64(rec.backBlob) } });
    for (const x of (rec.extraBlobs || [])) {
      if (x && x.blob) parts.push({ inlineData: { mimeType: x.mime || 'image/jpeg', data: await _blobToB64(x.blob) } });
    }

    // 3) Danh sách trường cần so (BỎ trường meta, BỎ trường đã KHÓA)
    const locked = (it.recheck && it.recheck.locked) || {};
    const v = computeView(it);
    const fields = v.fields
      .filter(f => !f.spec.meta && !locked[f.spec.key])
      .map(f => ({ key: f.spec.key, label: f.spec.label, scanValue: String(f.scanVal == null ? '' : f.scanVal), sheetValue: String(f.dsVal == null ? '' : f.dsVal) }));
    if (!fields.length) return { fields: [], truongKhongRo: [] };

    const promptText =
      'Bạn là người đối chiếu phiếu giấy với Google Sheet. Ảnh đính kèm là phiếu thu thập / biên bản / cam kết của xe. ' +
      'Với mỗi trường trong danh sách bên dưới, hãy:\n' +
      ' (1) đọc giá trị TRÊN ẢNH → imageValue (giữ nguyên dấu tiếng Việt, chữ số);\n' +
      ' (2) đọc LẠI MỘT LẦN ĐỘC LẬP → imageValue2 (phải khớp imageValue nếu bạn chắc chắn; nếu không đọc rõ → để trống và thêm key vào truongKhongRo);\n' +
      ' (3) so sánh với scanValue (máy đọc lần trước) → matchesScan (true/false);\n' +
      ' (4) so sánh với sheetValue (Google Sheet hiện tại) → matchesSheet (true/false);\n' +
      ' (5) confidence 0–100 (độ tin cậy của bạn về imageValue);\n' +
      ' (6) reason ngắn; (7) regionHint nếu ảnh có vùng cụ thể.\n' +
      'Lưu ý: điền đủ mọi key trong danh sách; không đọc được thì vẫn trả key đó với imageValue="" và thêm vào truongKhongRo. ' +
      'Trả về JSON đúng schema.\n\nDanh sách trường:\n' + JSON.stringify(fields, null, 2);

    parts.push({ text: promptText });

    const r = await S.geminiGenerate({ parts, schema: AI_CMP_SCHEMA, onStatus: (m) => { if (opts && opts.onStatus) opts.onStatus(m); } });
    let data;
    try { data = JSON.parse(r.text); } catch (e) { throw new Error('Gemini trả về JSON không hợp lệ: ' + (r.text || '').slice(0, 120)); }
    return Object.assign({ fields: [], truongKhongRo: [], notes: '', _model: r.model, _ms: r.ms }, data);
  }

  /* ---------- HÀM MỚI: aiApplyCertain — chắc chắn ghi như người dùng, nghi vấn đánh dấu ---------- */
  async function aiApplyCertain(it, cmp, lan) {
    const locked = (it.recheck && it.recheck.locked) || {};
    const khongRo = new Set((cmp.truongKhongRo || []).map(String));
    const certain = [], uncertain = [];

    for (const f of (cmp.fields || [])) {
      if (!f || !f.key || locked[f.key]) continue;
      const twoReadsMatch = _normKey(f.imageValue) === _normKey(f.imageValue2) && _normKey(f.imageValue) !== '';
      const conf = Number(f.confidence) || 0;
      const ok = twoReadsMatch && conf >= THRESH_CONFIDENT && !khongRo.has(f.key) && String(f.imageValue || '').trim() !== '';
      (ok ? certain : uncertain).push(f);
    }

    // Luôn đảm bảo có khung recheck
    it.recheck = it.recheck || { uncertain: {}, locked: {}, lan: 0 };
    it.recheck.uncertain = it.recheck.uncertain || {};
    it.recheck.locked = it.recheck.locked || {};
    it.recheck.lan = lan;

    // 1) Đánh dấu NGHI VẤN cho từng trường (không tự ghi)
    for (const f of uncertain) {
      it.recheck.uncertain[f.key] = {
        imageValue: String(f.imageValue || ''),
        matchesScan: !!f.matchesScan,
        matchesSheet: !!f.matchesSheet,
        confidence: Number(f.confidence) || 0,
        reason: String(f.reason || ''),
        lan, at: Date.now(),
      };
    }

    // 2) CHẮC CHẮN → áp dụng đúng đường người dùng (set source/decision + markFieldsChecked + applyFoundItem)
    let result = { certain: 0, uncertain: uncertain.length, wrote: 0 };
    if (certain.length) {
      const before = clone(it);
      const certainKeys = [];
      for (const f of certain) {
        certainKeys.push(f.key);
        if (f.matchesSheet) {
          // Ảnh khớp Sheet → GIỮ SHEET
          it.source[f.key] = 'sheet';
          it.decisions[f.key] = 'skip';
        } else {
          // Ảnh ≠ Sheet → lấy giá trị TRÊN ẢNH (ép vào it.edits để scanValue trả lại đúng giá trị)
          it.edits = it.edits || {};
          if (!(f.key in it.edits)) it.edits[f.key] = String(f.imageValue || '').trim();
          it.source[f.key] = 'scan';
          it.decisions[f.key] = 'apply';
        }
        // Khóa: AI tuyệt đối không đọc lại/sửa
        it.recheck.locked[f.key] = { by: 'ai', at: Date.now(), confidence: Number(f.confidence) || 0, lan };
        delete it.recheck.uncertain[f.key];
      }
      // Tick «đã đối chiếu ảnh» cho các trường chắc chắn + tự bật imgChecked nếu đủ
      if (typeof markFieldsChecked === 'function') markFieldsChecked(it, certainKeys);
      else certainKeys.forEach(k => { it.fieldChecked = it.fieldChecked || {}; it.fieldChecked[k] = true; });

      await saveItem(it);

      // Ghi qua ĐÚNG hàm người dùng — applyFoundItem xử lý opts.aiTag (đã có sẵn trong bundle)
      const tagDate = (() => { const d = new Date(), p2 = n => String(n).padStart(2, '0'); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`; })();
      const aiTag = `AI kiểm lần ${lan}: xác định đúng (${tagDate})`;
      const v2 = computeView(it);
      const r = await applyFoundItem(v2, certainKeys, { aiTag });
      result.wrote = (r && r.writes) || 0;
      result.certain = certain.length;
      // Ghi lịch sử để người dùng hoàn tác được (như thao tác tay)
      try { if (typeof record === 'function') record(`AI kiểm lần ${lan} – ${it.bienSoRaw || 'xe'}`, [{ id: it.id, before, after: clone(it) }]); } catch (_) {}
    } else {
      // Không có trường chắc chắn → chỉ lưu trạng thái nghi vấn
      await saveItem(it);
    }

    // Ghi cờ "còn nghi vấn" LÊN SHEET (cột Kết quả đối chiếu phiếu) + cục bộ
    if (uncertain.length) await _writeUncertainMeta(it, lan, uncertain);
    return result;
  }

  // Ghi meta "AI kiểm lần n: còn nghi vấn" lên cột Kết quả đối chiếu phiếu — KHÔNG đụng dữ liệu trường
  async function _writeUncertainMeta(it, lan, uncertain) {
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const tag = `AI kiểm lần ${lan}: còn nghi vấn (${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()})`;
    // Cập nhật bộ nhớ trước — nếu lỗi Sheet thì dữ liệu local vẫn có
    it.result = (it.result ? it.result + ' · ' : '') + tag;
    it.aiTag = tag;
    it.aiUncertain = uncertain.map(f => f.key);
    await saveItem(it);
    // Ghi lên cột «Kết quả đối chiếu phiếu» nếu có kết nối Sheet + đúng dòng
    try {
      const v = computeView(it);
      if (!v.found || !v.row) return;
      const meta = {
        ketQuaPhieu: it.result,
        kiemPhieu: it.review === 'da_kiem' ? 'Đã kiểm' : 'Chưa kiểm',
      };
      if (typeof updateSingleRowFields === 'function') await updateSingleRowFields(v.row, meta);
    } catch (e) { console.warn('[recheck] không ghi được meta nghi vấn lên Sheet:', e); }
  }

  /* ---------- HÀM MỚI: runRecheckQueue — chạy ngầm, ưu tiên thấp, lưu tiến độ ---------- */
  async function runRecheckQueue(opts) {
    if (window._aiRecheckRunning) { toast('AI đang kiểm lại — vui lòng chờ.', true); return; }
    // Khóa liên tab (giống scan.js runQueue): chỉ 1 tab chạy — tránh 2 tab gọi Gemini trùng cho cùng mục
    if (navigator.locks && navigator.locks.request) {
      let ran = false;
      await navigator.locks.request('scanRecheckRun', { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        ran = true;
        window._aiRecheckRunning = true;
        try { await _runRecheckQueueInner(opts); }
        finally { window._aiRecheckRunning = false; window._aiRecheckAbort = false; }
      });
      if (!ran) toast('Một tab khác đang chạy kiểm lại AI — hãy dùng tab đó.', true);
      return;
    }
    window._aiRecheckRunning = true;
    try { await _runRecheckQueueInner(opts); }
    finally { window._aiRecheckRunning = false; window._aiRecheckAbort = false; }
  }

  async function _runRecheckQueueInner(opts) {
(Hết phần đổi. Dòng } finally { window._aiRecheckRunning = false; window._aiRecheckAbort = false; } cuối hàm cũ giữ nguyên — nó giờ là cuối _runRecheckQueueInner.)
    const say = (m) => {
      try { const el = document.getElementById('rvFooterSummary'); if (el) el.textContent = '🤖 ' + m; } catch (_) {}
      if (opts && opts.onStatus) opts.onStatus(m);
    };
    const isUserBusy = () => {
      try {
        if (typeof window.isScanBusy === 'function' && window.isScanBusy()) return true;
        if (window.S && typeof S.userQueueBusy === 'function' && S.userQueueBusy()) return true;
        if (window.state && window.state.scanBusy) return true;
      } catch (_) {}
      return false;
    };

    try {
      say('Nạp danh sách mục…');
      const all = (await DB.dbGetAll(ST_ITEMS)).map(normItem);
      const onlyUnchecked = !opts || opts.onlyUnchecked !== false;
      const todo = all.filter(it => {
        if (onlyUnchecked && it.review === 'da_kiem') return false;
        const locked = (it.recheck && it.recheck.locked) || {};
        const v = computeView(it);
        return v.fields.some(f => !f.spec.meta && !locked[f.spec.key]);
      });
      if (!todo.length) { say('Không còn mục nào cần kiểm.'); return; }

      let maxLan = 0;
      for (const it of all) maxLan = Math.max(maxLan, (it.recheck && it.recheck.lan) || 0);
      const prog = _loadProgress() || { next: 0, lan: maxLan + 1, total: todo.length, startedAt: Date.now() };
      prog.total = todo.length;
      _saveProgress(prog);

      let certainN = 0, uncN = 0;
      for (let i = prog.next || 0; i < todo.length; i++) {
        // Tạm dừng khi người dùng có việc
        while (isUserBusy()) {
          say(`Tạm dừng: người dùng đang bận (${i + 1}/${todo.length})…`);
          await new Promise(r => setTimeout(r, 1500));
          if (window._aiRecheckAbort) { say('Đã dừng theo yêu cầu.'); return; }
        }
        if (window._aiRecheckAbort) { say('Đã dừng theo yêu cầu.'); return; }

        const it = todo[i];
        try {
          say(`Đang kiểm ${it.bienSoRaw || '(không biển)'} (${i + 1}/${todo.length}) — lần ${prog.lan}…`);
          const cmp = await aiCompareItem(it, { onStatus: say });
          const r = await aiApplyCertain(it, cmp, prog.lan);
          certainN += r.certain; uncN += r.uncertain;
          prog.next = i + 1;
          _saveProgress(prog);
          // Nhường UI
          if (typeof S !== 'undefined' && S.yieldToUi) await S.yieldToUi(); else await new Promise(r => setTimeout(r, 30));
        } catch (e) {
          console.error('[recheck] lỗi', it.id, e);
          it.recheck = it.recheck || { uncertain: {}, locked: {}, lan: 0 };
          it.recheck.uncertain = it.recheck.uncertain || {};
          it.recheck.uncertain._error = { error: String(e && e.message || e), lan: prog.lan, at: Date.now() };
          try { await saveItem(it); } catch (_) {}
          prog.next = i + 1; _saveProgress(prog);
        }
      }

      _clearProgress();
      say(`Hoàn tất lần ${prog.lan}: ${certainN} trường chắc chắn đã ghi · ${uncN} trường nghi vấn.`);
      if (typeof renderReview === 'function') renderReview();
      if (typeof refreshMainTable === 'function') refreshMainTable();
    } finally {
      window._aiRecheckRunning = false;
      window._aiRecheckAbort = false;
    }
  }

  /* ---------- HÀM MỚI: recheckAllUnchecked — thay nút «🔁 Kiểm lại tất cả chưa kiểm» ---------- */
  async function recheckAllUnchecked() {
    if (!confirm('Bắt đầu KIỂM LẠI bằng AI cho các mục chưa kiểm?\n\n• Mỗi mục: gửi ẢNH các mặt của đúng phiếu + dữ liệu Sheet + dữ liệu đã đọc lần trước cho Gemini.\n• Trường chắc chắn (đọc 2 lần khớp + tin cậy ≥ ' + THRESH_CONFIDENT + ') → tự ghi như thao tác tay, đóng dấu «AI kiểm lần n: xác định đúng».\n• Trường nghi vấn → đánh dấu riêng để bạn kiểm thủ công.\n• Trường đã khoá (bạn xác nhận) → AI không đụng tới.\n\nChạy ngầm ưu tiên thấp; mở lại web sẽ chạy tiếp.')) return;
    await runRecheckQueue({ onlyUnchecked: true });
  }

  /* ---------- HÀM MỚI: ScanReviewAVFilter — bộ lọc #rvAvFilter (passesFilter đã gọi) ---------- */
  // QUAN TRỌNG: passesFilter trong scan-review.js đã gọi window.ScanReviewAVFilter.
  // scan-review-av.js (nếu đã tồn tại) có thể cũng định nghĩa hàm này → phải CHUỖI (chain), không ghi đè.
  const _origAVFilter = (typeof window.ScanReviewAVFilter === 'function') ? window.ScanReviewAVFilter : null;
  function ScanReviewAVFilter(it) {
    if (!it) return true;
    // 1) Bộ lọc cũ của scan-review-av.js chạy TRƯỚC
    if (_origAVFilter) { try { if (!_origAVFilter(it)) return false; } catch (_) {} }
    // 2) Bộ lọc AI mới — chỉ can thiệp khi #rvAvFilter ở chế độ AI (tên option ta thêm)
    const el = document.getElementById('rvAvFilter');
    const mode = el ? String(el.value || 'all') : 'all';
    if (!mode || mode === 'all') return true;
    const unc = (it.recheck && it.recheck.uncertain) || {};
    const lock = (it.recheck && it.recheck.locked) || {};
    const hasUnc = Object.keys(unc).some(k => !k.startsWith('_'));
    const hasLock = Object.keys(lock).length > 0;
    // Value khớp <select id="rvAvFilter"> trong index.html: all | uncertain | certain | locked | none
    if (mode === 'uncertain') return hasUnc;
    if (mode === 'locked')    return hasLock;
    if (mode === 'certain')   return !hasUnc && hasLock;
    if (mode === 'none')      return !hasUnc;
    return true;
  }
  window.ScanReviewAVFilter = ScanReviewAVFilter;
Lý do: đổi giá trị option từ uncertain/locked/certain/none → ai_uncertain/ai_locked/ai_certain/ai_none để không đụng các value mà scan-review-av.js có thể đã dùng. Tương ứng sửa snippet index.html bên dưới.

  /* ---------- HÀM MỚI: goToNextUncertain — nút «Kiểm thủ công mục nghi vấn» ---------- */
  async function goToNextUncertain() {
    const list = (R && R.items) || [];
    for (const it of list) {
      const unc = (it.recheck && it.recheck.uncertain) || {};
      const keys = Object.keys(unc).filter(k => !k.startsWith('_'));
      if (!keys.length) continue;
      // Ép bộ lọc về trạng thái thấy mục này
      try {
        if (R) { R.filter = 'all'; R.checker = ''; R.search = ''; R.page = 1; }
        const fEl = document.getElementById('rvFilter'); if (fEl) fEl.value = 'all';
        const cEl = document.getElementById('rvChecker'); if (cEl) cEl.value = '';
        const sEl = document.getElementById('rvSearch'); if (sEl) sEl.value = '';
        const avEl = document.getElementById('rvAvFilter'); if (avEl) avEl.value = 'uncertain';
      } catch (_) {}
      if (typeof renderReview === 'function') renderReview();
      await goToItem(it.id, true);
      // Cuộn tới trường nghi vấn đầu tiên
      setTimeout(() => {
        try {
          const field = document.querySelector(`.rv-card[data-id="${CSS.escape(it.id)}"] .rv-row[data-field="${CSS.escape(keys[0])}"]`);
          if (field) field.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch (_) {}
      }, 250);
      return;
    }
    toast('Đã hết mục nghi vấn.');
  }

  /* ---------- HÀM MỚI: bindRecheckUI — gắn sự kiện cho nút/bộ lọc mới ---------- */
  function bindRecheckUI() {
    const av = document.getElementById('rvAvFilter');
    if (av && !av._rvBound) {
      av._rvBound = true;
      av.addEventListener('change', () => { try { if (R) R.page = 1; } catch (_) {} if (typeof renderReview === 'function') renderReview(); });
    }
    const btnNext = document.getElementById('btnNextUncertain');
    if (btnNext && !btnNext._rvBound) { btnNext._rvBound = true; btnNext.addEventListener('click', goToNextUncertain); }
    // #btnRecheckAll: dùng capture + stopImmediatePropagation để chắc chắn chỉ NEW logic chạy,
    // kể cả khi scan-review-av.js (nạp sau) cũng có listener trên document.
    const btnAll = document.getElementById('btnRecheckAll');
    if (btnAll && !btnAll._rvBound) {
      btnAll._rvBound = true;
      btnAll.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        recheckAllUnchecked();
      }, true);   // capture
    }
  }

  /* ---------- Auto-bind khi DOM sẵn sàng ---------- */
  if (document.readyState !== 'loading') bindRecheckUI();
  else document.addEventListener('DOMContentLoaded', bindRecheckUI);

  /* ---------- Export ---------- */
  window.ScanRecheck = {
    THRESH_CONFIDENT,
    aiCompareItem, aiApplyCertain, runRecheckQueue, recheckAllUnchecked,
    ScanReviewAVFilter, goToNextUncertain, bindRecheckUI,
  };
})();
