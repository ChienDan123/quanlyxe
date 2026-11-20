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

  /* ---- Shim: lấy dependencies từ các module khác (scan-recheck chạy trong IIFE riêng, không kế thừa scope) ---- */
  const S  = window.ScanApp    || (typeof ScanApp    !== 'undefined' ? ScanApp    : null);
  const R  = window.ScanReview || (typeof ScanReview !== 'undefined' ? ScanReview : null);
  const DB = S && S.db;
  const ST_SCANS = DB && DB.ST_SCANS;
  const ST_ITEMS = DB && DB.ST_ITEMS;
  const computeView       = R && R.computeView;
  const applyFoundItem    = R && R.applyFoundItem;
  const applyViews        = R && R.applyViews;
  const saveItem          = R && R.saveItem;
  const normItem          = R && R.normItem;
  const goToItem          = R && R.goToItem;
  const setFocus          = R && R.setFocus;
  const renderReview      = R && R.renderReview;
  const record            = R && R.record;
  const clone             = R && R.clone;
  const markFieldsChecked = R && R.markFieldsChecked;
  // updateSingleRowFields: KHÔNG capture — resolve động để wrapUpdateRow (scan-review-av.js, nạp sau) có tác dụng
  const getUpdateSingleRowFields = () => window.updateSingleRowFields;
  const toast = (m, err) => { try { (window.toast || console.log)(m, !!err); } catch (_) { console.log(m); } };
  const refreshMainTable = () => { try { if (typeof window.renderTable === 'function') window.renderTable(); } catch (_) {} };

  // Nếu thiếu module/hàm — báo rõ rồi thoát, KHÔNG chạy trong tình trạng thiếu
  if (!S || !DB || !ST_ITEMS) { console.error('[scan-recheck] Thiếu ScanApp / DB.'); return; }
  const _missing = [];
  if (!computeView)       _missing.push('computeView');
  if (!applyFoundItem)    _missing.push('applyFoundItem');
  if (!saveItem)          _missing.push('saveItem');
  if (!normItem)          _missing.push('normItem');
  if (!goToItem)          _missing.push('goToItem');
  if (!clone)             _missing.push('clone');
  if (_missing.length) {
    console.error('[scan-recheck] scan-review.js chưa export: ' + _missing.join(', ') + ' — xem khối return cuối scan-review.js (Fix #4 bên dưới).');
    return;
  }

  const THRESH_CONFIDENT = 90;                  // ngưỡng «chắc chắn» cho trường (phiếu thường)
  const PROGRESS_KEY = 'scanRecheckProgress_v1';
  /* #3 — Phiếu lạ (không có bên Sheet để so): quy tắc CHẶT HƠN */
  const ORPHAN_TRUST_MIN = 92;                  // ngưỡng tin cậy các trường khác (chủ xe, CCCD, SĐT, tình trạng)
  const ORPHAN_PLATE_MIN_READS = 2;             // phải đọc nhất quán ≥ 2 lần độc lập
  // Kiểm dạng biển VN (đơn giản): có cả chữ + số, dài 6–10 ký tự sau khi chuẩn hoá
  function _isVnPlate(p) { return !!p && /[A-Z]/.test(p) && /\d/.test(p) && p.length >= 6 && p.length <= 10; }

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

    // #3: phiếu lạ không có bên Sheet để so — đổi prompt cho phù hợp
    const isOrphanPrompt = !v.found;
    const promptText =
      (isOrphanPrompt
        ? 'Bạn là người đối chiếu phiếu giấy với DỮ LIỆU ĐÃ ĐỌC TRƯỚC ĐÓ (phiếu lạ — chưa có trong Google Sheet). Ảnh đính kèm là phiếu thu thập / biên bản / cam kết của xe. '
        : 'Bạn là người đối chiếu phiếu giấy với Google Sheet. Ảnh đính kèm là phiếu thu thập / biên bản / cam kết của xe. ') +
      'Với mỗi trường trong danh sách bên dưới, hãy:\n' +
      ' (1) đọc giá trị TRÊN ẢNH → imageValue (giữ nguyên dấu tiếng Việt, chữ số);\n' +
      ' (2) đọc LẠI MỘT LẦN ĐỘC LẬP → imageValue2 (phải khớp imageValue nếu bạn chắc chắn; nếu không đọc rõ → để trống và thêm key vào truongKhongRo);\n' +
      ' (3) so sánh với scanValue (máy đọc lần trước) → matchesScan (true/false);\n' +
      ' (4) so sánh với sheetValue (Google Sheet hiện tại) → matchesSheet (true/false);\n' +
      ' (5) confidence 0–100 (độ tin cậy của bạn về imageValue);\n' +
      ' (6) reason ngắn; (7) regionHint nếu ảnh có vùng cụ thể.\n' +
      'Lưu ý: điền đủ mọi key trong danh sách; không đọc được thì vẫn trả key đó với imageValue="" và thêm vào truongKhongRo. ' +
      'Trả về JSON đúng schema.\n\n'
      + (isOrphanPrompt ? 'LƯU Ý PHIẾU LẠ: sheetValue luôn rỗng (chưa có trong Sheet). Hãy đọc ảnh 2 lần thật cẩn thận (imageValue + imageValue2) cho BIỂN SỐ và các trường quan trọng; nếu 2 lần đọc lệch → để imageValue2 trống và thêm key vào truongKhongRo (coi như nghi vấn).\n\n' : '')
      + 'Danh sách trường:\n' + JSON.stringify(fields, null, 2);

    parts.push({ text: promptText });

    const r = await S.geminiGenerate({ parts, schema: AI_CMP_SCHEMA, priority: (opts && opts.priority) || 'low', onStatus: (m) => { if (opts && opts.onStatus) opts.onStatus(m); } });
    let data;
    try { data = JSON.parse(r.text); } catch (e) { throw new Error('Gemini trả về JSON không hợp lệ: ' + (r.text || '').slice(0, 120)); }
    return Object.assign({ fields: [], truongKhongRo: [], notes: '', _model: r.model, _ms: r.ms, _keys: fields.map(f => f.key) }, data, { _keys: fields.map(f => f.key) });
  }

  /* ---------- HÀM MỚI: aiApplyCertain — chắc chắn ghi như người dùng, nghi vấn đánh dấu ---------- */
  async function aiApplyCertain(it, cmp, lan) {
    cmp = cmp || {};
    it.recheck = it.recheck || {}; it.recheck.uncertain = it.recheck.uncertain || {}; it.recheck.locked = it.recheck.locked || {};
    it.decisions = it.decisions || {}; it.source = it.source || {}; it.edits = it.edits || {};
    const before = clone(it);
    const locked = it.recheck.locked;
    const sent = new Set(cmp._keys || []);
    const khongRo = new Set((cmp.truongKhongRo || []).map(String));
    const SAFE_FREE = {
      chuXe: (s) => (s.length >= 2 && s.length <= 80 && !/\d/.test(s)) ? s : '',
      cccd: (s) => { const d = s.replace(/\D/g, ''); return (d.length === 9 || d.length === 11 || d.length === 12) ? d : ''; },
      soDienThoai: (s) => { const d = s.replace(/\D/g, ''); return (d.length >= 9 && d.length <= 11) ? d : ''; },
    };
    const certain = [], uncertain = [], returned = new Set();
    // Phiếu lạ: quy tắc CHẶT hơn — kiểm biển trước
    const vCheck = computeView(it);
    const isOrphan = !vCheck.found;
    let orphanPlateIssue = '';
    if (isOrphan) {
      const plateVal = String(it.bienSo || '').trim();
      if (!plateVal) orphanPlateIssue = 'chưa có biển số';
      else if (!_isVnPlate(plateVal)) orphanPlateIssue = 'biển không đúng dạng VN (' + plateVal + ')';
      else {
        // (a) đọc nhất quán ≥ ORPHAN_PLATE_MIN_READS lần độc lập (imageValue + imageValue2) và khớp biển đang lưu
        if (!locked.bienSo) {
          const pf = (cmp.fields || []).find(f => f && f.key === 'bienSo');
          const k1 = pf ? _normKey(pf.imageValue).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
          const k2 = pf ? _normKey(pf.imageValue2).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
          const mine = plateVal.toUpperCase().replace(/[^A-Z0-9]/g, '');
          const reads = [k1, k2].filter(Boolean);
          if (!pf) orphanPlateIssue = 'AI không đọc lại biển số';
          else if (reads.length < ORPHAN_PLATE_MIN_READS || k1 !== k2) orphanPlateIssue = 'biển số đọc chưa nhất quán 2 lần (' + (k1 || '?') + ' / ' + (k2 || '?') + ')';
          else if (k1 !== mine) orphanPlateIssue = 'AI đọc biển «' + k1 + '» khác biển đang lưu «' + mine + '»';
          else if ((Number(pf.confidence) || 0) < ORPHAN_TRUST_MIN) orphanPlateIssue = 'độ tin cậy biển số thấp (' + (Number(pf.confidence) || 0) + ')';
        }
        // (b) KHÔNG gần giống (Levenshtein ≤ 2 / 1 ký tự dễ nhầm) biển đã có trong DS
        if (!orphanPlateIssue) {
          const fn = (R && R.findSimilarPlates) || (window.ScanReviewAI && window.ScanReviewAI.findSimilarPlates)
                  || (R && R.findPlateCandidates) || (window.ScanReviewAI && window.ScanReviewAI.findPlateCandidates);
          const cands = typeof fn === 'function' ? fn(plateVal) : [];
          if (cands.length) orphanPlateIssue = 'gần giống biển đã có trong DS: ' + cands.map(c => c.k).slice(0, 3).join(', ');
        }
      }
    }
    // Duyệt từng trường
    for (const f of (cmp.fields || [])) {
      if (!f || !f.key || locked[f.key] || (sent.size && !sent.has(f.key))) continue;
      returned.add(f.key);
      const iv = String(f.imageValue || '').trim();
      const twoReads = iv !== '' && _normKey(iv) === _normKey(f.imageValue2);
      const conf = Number(f.confidence) || 0;
      const trust = isOrphan ? ORPHAN_TRUST_MIN : THRESH_CONFIDENT;
      let ok = twoReads && conf >= trust && !khongRo.has(f.key), mode = '';
      if (ok) {
        if (isOrphan) {
          // Phiếu lạ: chỉ chấp nhận giá trị đọc từ ảnh (không có Sheet để so)
          if (SAFE_FREE[f.key]) { const clean = SAFE_FREE[f.key](iv); if (clean) { mode = 'edit'; f._clean = clean; } }
          // Trường meta / trường tự do khác: giữ nguyên giá trị đã đọc (không ghi đè vì không có nguồn chuẩn)
          else mode = 'keep';
        } else {
          if (f.matchesSheet) mode = 'sheet';
          else if (f.matchesScan) mode = 'scan';
          else if (SAFE_FREE[f.key]) { const clean = SAFE_FREE[f.key](iv); if (clean) { mode = 'edit'; f._clean = clean; } }
          if (!mode) ok = false;
        }
      }
      // Phiếu lạ: nếu biển có vấn đề (gần giống / sai dạng / trống) → coi NHƯ nghi vấn cho MỌI trường
      if (isOrphan && orphanPlateIssue && f.key === 'bienSo') {
        // Biển là trường đặc biệt — nếu có issue thì đưa vào uncertain
        uncertain.push(Object.assign({}, f, { reason: orphanPlateIssue }));
        continue;
      }
      if (ok) { f._mode = mode; certain.push(f); } else uncertain.push(f);
    }
    // Phiếu lạ + biển có vấn đề → CHẶN toàn bộ (không ghi), đẩy mọi trường sang uncertain
    if (isOrphan && orphanPlateIssue) {
      const seen = new Set(uncertain.map(f => f.key));
      for (const f of (cmp.fields || [])) {
        if (!seen.has(f.key) && !locked[f.key]) {
          uncertain.push(Object.assign({}, f, { reason: 'biển số: ' + orphanPlateIssue }));
          seen.add(f.key);
        }
      }
    }
    sent.forEach(k => { if (!returned.has(k) && !locked[k]) uncertain.push({ key: k, imageValue: '', matchesScan: false, matchesSheet: false, confidence: 0, reason: 'AI không trả kết quả cho trường này' }); });

    it.recheck.lan = lan; it.recheck.lastAt = Date.now();
    if (it.recheck.status === 'error') delete it.recheck.status;
    delete it.recheck.lastError; delete it.recheck.uncertain._error;

    // 1) NGHI VẤN
    for (const f of uncertain) {
      it.recheck.uncertain[f.key] = {
        imageValue: String(f.imageValue || ''), matchesScan: !!f.matchesScan, matchesSheet: !!f.matchesSheet,
        confidence: Number(f.confidence) || 0, reason: String(f.reason || ''), lan, at: Date.now(),
      };
      it.decisions[f.key] = 'later';
    }

    // 2) CHẮC CHẮN
    let wrote = 0, rowId = null, rowBefore = null, rowAfter = null, orphanPushed = 0;
    if (certain.length && !(isOrphan && orphanPlateIssue)) {
      const certainKeys = [];
      for (const f of certain) {
        const k = f.key; certainKeys.push(k);
        if (f._mode === 'sheet') { it.source[k] = 'sheet'; it.decisions[k] = 'skip'; }
        else if (f._mode === 'scan') { it.source[k] = 'scan'; it.decisions[k] = 'apply'; }
        else if (f._mode === 'edit') { it.edits[k] = f._clean; it.source[k] = 'scan'; it.decisions[k] = 'apply'; }
        else if (f._mode === 'keep') { /* phiếu lạ: giữ nguyên giá trị đọc — không đổi */ }
        it.recheck.locked[k] = { by: 'ai', at: Date.now(), confidence: Number(f.confidence) || 0, lan };
        delete it.recheck.uncertain[k];
      }
      if (typeof markFieldsChecked === 'function') markFieldsChecked(it, certainKeys);
      else certainKeys.forEach(k => { it.fieldChecked = it.fieldChecked || {}; it.fieldChecked[k] = true; });
      await saveItem(it);

      const d = new Date(), p2 = n => String(n).padStart(2, '0');
      const aiTag = `AI kiểm lần ${lan}: xác định đúng (${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()})`;
      const v2 = computeView(it);
      if (v2.found && v2.row) {
        // Đường cũ: phiếu thường → applyFoundItem
        const ks = v2.fields.map(f => f.spec.key);
        rowId = v2.row._rowId;
        rowBefore = R.rowSnap ? R.rowSnap(v2.row, ks) : null;
        const r = await applyFoundItem(v2, certainKeys, { aiTag });
        wrote = (r && r.writes) || 0;
        rowAfter = R.rowSnap ? R.rowSnap(v2.row, ks) : null;
      } else if (isOrphan) {
        // #3: phiếu lạ CHẮC CHẮN → đi đúng cơ chế orphan-apply hiện có (applyOrphanItems → pushOrphans → scanOrphanUpsert_)
        it.orphanDecision = 'apply';
        it.orphanPushed = false; it.orphanSheet = it.orphanSheet || false;
        it.orphanExtraMsg = ''; it.pushError = '';
        it.imgChecked = true;
        it.aiTag = aiTag;             // applyOrphanItems đưa dấu này vào «Kết quả đối chiếu phiếu» ngay lần ghi đầu
        const v3 = computeView(it);   // dựng lại sau khi đổi orphanDecision
        const or = await (R.applyOrphanItems ? R.applyOrphanItems([v3]) : Promise.resolve({ failed: 1, error: 'thiếu hàm applyOrphanItems (scan-review.js chưa export)' }));
        if (or && or.pushed) {
          orphanPushed = or.pushed; wrote = or.pushed;
          // thêm tag AI vào Ghi chú — dùng đúng stripAiTag hiện có để không cộng dồn
          try {
            it.aiTag = aiTag;
            if (!String(it.result || '').includes(aiTag)) it.result = (R.stripAiTag ? R.stripAiTag(it.result) : String(it.result || '')) + ' · ' + aiTag;
            await saveItem(it);
            // Ghi tag AI + trạng thái kết quả lên dòng vừa tạo (nếu có rowId)
            const vAfter = computeView(it);
            if (vAfter.found && vAfter.row) {
              const _usf = getUpdateSingleRowFields();
              if (typeof _usf === 'function') await _usf(vAfter.row, {
                kiemPhieu: 'Đã kiểm', ketQuaPhieu: it.result,
              });
            }
          } catch (e) { console.warn('[recheck] không ghi được tag AI cho phiếu lạ:', e); }
        } else if (or && or.failed) {
          // Ghi lỗi → giữ ở nghi vấn
          uncertain.push({ key: '_orphan_push', imageValue: '', matchesScan: false, matchesSheet: false,
            confidence: 0, reason: 'Chưa ghi được phiếu lạ: ' + (or.error || '?') });
          it.recheck.status = 'error'; it.recheck.errLan = lan;
          it.recheck.lastError = { error: 'Chưa ghi được phiếu lạ: ' + (or.error || '?'), lan, at: Date.now() };
          await saveItem(it);
          try { const UI = window.AIRecheckUI; UI && UI.log && UI.log('Lỗi ghi phiếu lạ ' + (it.bienSoRaw || it.id) + ': ' + String(or.error || '?').slice(0, 100)); } catch (_) {}
        }
      }
    } else if (!uncertain.length) {
      await saveItem(it);
      try {
        const _v = computeView(it);
        if (_v.found && _v.row) {
          const _usf = getUpdateSingleRowFields();
          if (typeof _usf === 'function') await _usf(_v.row, {
            kiemPhieu: it.review === 'da_kiem' ? 'Đã kiểm' : 'Chưa kiểm',
            ketQuaPhieu: it.result || '',
          });
        }
      } catch (e) { console.warn('[recheck] không ghi được AV cho mục không có trường thay đổi:', e); }
    }
    if (uncertain.length) await _writeUncertainMeta(it, lan, uncertain);

    try { if (typeof record === 'function') record(`AI kiểm lần ${lan} – ${it.bienSoRaw || 'xe'}${isOrphan ? ' (phiếu lạ)' : ''}`, [{ id: it.id, before, after: clone(it), rowId, rowBefore, rowAfter }]); } catch (_) {}
    return { certain: certain.length, uncertain: uncertain.length, wrote, orphanPushed, orphanPlateIssue };
  }

  // Ghi meta "AI kiểm lần n: còn nghi vấn" lên cột Kết quả đối chiếu phiếu — KHÔNG đụng dữ liệu trường
  async function _writeUncertainMeta(it, lan, uncertain) {
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const tag = `AI kiểm lần ${lan}: còn nghi vấn (${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()})`;
    // Cập nhật bộ nhớ trước — nếu lỗi Sheet thì dữ liệu local vẫn có (gỡ dấu AI cũ để không cộng dồn)
    const _base = (R && R.stripAiTag) ? R.stripAiTag(it.result) : String(it.result || '').replace(/(?:\s*[|·]\s*)?AI kiểm lần \d+: (?:xác định đúng|còn nghi vấn)(?: \(\d{1,2}\/\d{1,2}\/\d{4}\))?/g, '').trim();
    it.result = (_base ? _base + ' · ' : '') + tag;
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
      const _usf = getUpdateSingleRowFields();
      if (typeof _usf === 'function') await _usf(v.row, meta);
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

  /* ---- Tiến độ lưu BỀN trong IndexedDB (store kv của app.js: idbGet/idbSet) ---- */
  const _uiDo = (fn, a, b) => { try { const U = window.AIRecheckUI; if (U && typeof U[fn] === 'function') U[fn](a, b); } catch (_) {} };
  const PROG_IDB_KEY = 'aiRecheckProgressV2';
  async function _idbGetProg() { try { return (typeof idbGet === 'function') ? ((await idbGet(PROG_IDB_KEY)) || null) : _loadProgress(); } catch (_) { return null; } }
  async function _idbSetProg(p) { try { if (typeof idbSet === 'function') await idbSet(PROG_IDB_KEY, p); else _saveProgress(p); } catch (_) {} }
  async function _idbClearProg() { try { if (typeof idbSet === 'function') await idbSet(PROG_IDB_KEY, null); } catch (_) {} _clearProgress(); }

  // Vẽ lại màn So sánh theo dữ liệu mới trong DB (AI ghi vào DB, R.items trong scan-review.js là bản cũ)
  let _lastUi = 0;
  async function refreshReviewUi(force) {
    const modal = document.getElementById('scanReviewModal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (!force && Date.now() - _lastUi < 4000) return;
    _lastUi = Date.now();
    try { if (R && R.reloadItems) await R.reloadItems(); if (typeof renderReview === 'function') renderReview(); } catch (_) {}
  }

  // Kiểm lại 1 mục (nút «🔁 Kiểm lại» trên thẻ): luôn đọc bản mới nhất từ DB
  async function recheckOne(itemId) {
    const it = await DB.dbGet(ST_ITEMS, itemId); if (!it) throw new Error('Không tìm thấy mục');
    const base = normItem(it);
    const lan = ((base.recheck && base.recheck.lan) || 0) + 1;
    const cmp = await aiCompareItem(base, { priority: 'normal' });
    const cur = normItem((await DB.dbGet(ST_ITEMS, itemId)) || base);
    const r = await aiApplyCertain(cur, cmp, lan);
    await refreshReviewUi(true); refreshMainTable();
    return Object.assign({ lan }, r);
  }

  // Mở lại web / có mạng lại → chạy tiếp tiến độ dang dở (không chạy nếu người dùng đã bấm dừng)
  async function resumeIfPending() {
    if (window._aiRecheckRunning) return;
    const prog = await _idbGetProg();
    if (!prog || !prog.lan || prog.paused) return;
    if (prog.retryAt && Date.now() < prog.retryAt) { _uiDo('queued', 'chờ thử lại lúc ' + new Date(prog.retryAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }), prog); return; }
    if (navigator.onLine === false) { _uiDo('queued', 'đang mất mạng — chờ có mạng', prog); return; }
    if (S.isBusy && S.isBusy()) { _uiDo('queued', 'chờ bạn quét xong phiếu', prog); return; }
    await runRecheckQueue({ onlyUnchecked: prog.onlyUnchecked !== false });
  }

  async function _runRecheckQueueInner(opts) {
    opts = opts || {};
    const say = (m) => {
      try { const el = document.getElementById('rvFooterSummary'); if (el) el.textContent = '🤖 ' + m; } catch (_) {}
      if (opts.onStatus) opts.onStatus(m);
    };
    // Nhường người dùng: hàng đợi quét đang chạy, hoặc đang mở bảng «Quét lại phiếu»
    const userBusy = () => {
      try {
        if (S.isBusy && S.isBusy()) return true;
        const m = document.getElementById('rvRescanModal');
        if (m && !m.classList.contains('hidden')) return true;
      } catch (_) {}
      return false;
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const UI = window.AIRecheckUI;
    let prog = null;
    try {
      say('Nạp danh sách mục…');
      const all = (await DB.dbGetAll(ST_ITEMS)).map(normItem);
      prog = await _idbGetProg();
      if (!prog || !prog.lan) {
        let maxLan = 0; all.forEach(x => { maxLan = Math.max(maxLan, (x.recheck && x.recheck.lan) || 0); });
        prog = { lan: maxLan + 1, startedAt: Date.now(), done: 0, certain: 0, unc: 0, onlyUnchecked: opts.onlyUnchecked !== false };
      }
      prog.paused = false; prog.retryAt = 0;
      const need = (x) => {
        if (prog.onlyUnchecked !== false && x.review === 'da_kiem') return false;
        const r = x.recheck || {};
        if (r.status === 'manual') return false;                       // tôn trọng «Đã kiểm thủ công»
        if ((Number(r.lan) || 0) >= prog.lan) return false;           // mục đã kiểm trong lượt này → không gửi lại (resume an toàn)
        if ((Number(r.errLan) || 0) >= prog.lan) return false;
        const v = computeView(x);
        const locked = r.locked || {};
        // #3: phiếu lạ VẪN cho chạy AI — nhưng chỉ khi chưa ghi thành công vào Sheet, và biển số đã có
        if (!v.found) {
          if (!x.bienSo) return false;                                // chưa có biển → chưa ghi được
          if (x.orphanSheet && x.orphanDecision === 'apply' && x.orphanExtraSig === (R.orphanSig ? R.orphanSig(x) : x.orphanExtraSig)) return false; // đã ghi đủ → không gửi lại
          return v.fields.some(f => !f.spec.meta && !locked[f.spec.key]);
        }
        return v.fields.some(f => !f.spec.meta && !locked[f.spec.key]);
      };
      const ids = all.filter(need).map(x => x.id);
      prog.total = (prog.done || 0) + ids.length;
      await _idbSetProg(prog);
      if (!ids.length) { await _idbClearProg(); say('Không còn mục nào cần kiểm.'); _uiDo('finishEmpty'); return; }

      try { UI && UI.begin && UI.begin({ lan: prog.lan, total: prog.total }); } catch (_) {}

      let stopped = false;
      for (let i = 0; i < ids.length; i++) {
        while (userBusy() && !window._aiRecheckAbort) {
          say(`Tạm dừng: người dùng đang bận (${prog.done}/${prog.total})…`);
          const _rm = document.getElementById('rvRescanModal');
          const _why = (S.isBusy && S.isBusy()) ? 'bạn đang quét phiếu' : (_rm && !_rm.classList.contains('hidden') ? 'bạn đang đọc ảnh / quét lại' : 'bạn đang bận');
          try { UI && UI.wait && UI.wait(_why); } catch (_) {}
          await sleep(1500);
        }
        if (window._aiRecheckAbort) {
          stopped = true; prog.paused = true;
          say('Đã dừng theo yêu cầu — bấm lại nút để chạy tiếp.');
          try { UI && UI.pause && UI.pause('bạn bấm tạm dừng'); } catch (_) {}
          break;
        }

        const raw = await DB.dbGet(ST_ITEMS, ids[i]); if (!raw) continue;
        const it = normItem(raw);
        if (!need(it)) continue;                                       // người dùng vừa xác nhận / khóa xong
        if (navigator.onLine === false) {
          stopped = true; prog.paused = true; prog.retryAt = Date.now() + 10 * 60000;
          say('Tạm dừng: mất mạng — sẽ thử lại sau 10 phút.');
          try { UI && UI.pause && UI.pause('mất mạng'); } catch (_) {}
          break;
        }
        try { UI && UI.tick && UI.tick({
          status: 'running',
          currentPlate: String(it.bienSoRaw || '(không biển)'),
          currentIndex: prog.done + 1, total: prog.total, lan: prog.lan,
        }); } catch (_) {}
        try {
          say(`Đang kiểm ${it.bienSoRaw || '(không biển)'} (${prog.done + 1}/${prog.total}) — lần ${prog.lan}…`);
          _uiDo('calling', String(it.bienSoRaw || ''));
          const cmp = await aiCompareItem(it, { onStatus: say, priority: 'low' });
          _uiDo('called', String(it.bienSoRaw || ''));
          const cur = normItem((await DB.dbGet(ST_ITEMS, it.id)) || it);   // bản mới nhất (người dùng có thể đã sửa trong lúc chờ Gemini)
          const r = await aiApplyCertain(cur, cmp, prog.lan);
          prog.certain += r.certain; prog.unc += r.uncertain;
        } catch (e) {
          const kind = e && e.kind;
          if (kind === 'quota' || kind === 'nokey' || kind === 'nomodel' || kind === 'cancelled') {   // lỗi hạ tầng: dừng, tự thử lại sau
            stopped = true; prog.retryAt = Date.now() + 10 * 60000;
            const reason = (kind === 'quota') ? 'hết quota key'
                         : (kind === 'nokey') ? 'chưa có API key'
                         : (kind === 'nomodel') ? 'model quá tải / không khả dụng'
                         : 'bị huỷ';
            say('Tạm dừng: ' + (e.message || e));
            try {
              if (kind === 'nokey' || kind === 'nomodel') UI && UI.error && UI.error(String(e.message || reason).slice(0, 140));
              else UI && UI.pause && UI.pause(reason);
            } catch (_) {}
            break;
          }
          console.error('[recheck] lỗi', it.id, e);
          try { UI && UI.log && UI.log('Lỗi ' + (it.bienSoRaw || it.id) + ': ' + String((e && e.message) || e).slice(0, 120)); } catch (_) {}
          try {
            const cur = normItem((await DB.dbGet(ST_ITEMS, it.id)) || it);
            cur.recheck.status = 'error'; cur.recheck.errLan = prog.lan;
            cur.recheck.lastError = { error: String((e && e.message) || e), lan: prog.lan, at: Date.now() };
            await saveItem(cur);
          } catch (_) {}
        }
        prog.done = (prog.done || 0) + 1;
        await _idbSetProg(prog);
        await refreshReviewUi(false);
        if (S.yieldToUi) await S.yieldToUi(); else await sleep(30);
      }
      if (!stopped) {
        await _idbClearProg();
        say(`Hoàn tất lần ${prog.lan}: ${prog.certain} trường chắc chắn đã ghi · ${prog.unc} trường nghi vấn.`);
        try { UI && UI.finish && UI.finish({ certain: prog.certain || 0, uncertain: prog.unc || 0,
          written: prog.certain || 0, errored: 0 }); } catch (_) {}
      } else if (window._aiRecheckHard) {
        await _idbClearProg(); _uiDo('stopped');
      } else await _idbSetProg(prog);
      await refreshReviewUi(true); refreshMainTable();
    } catch (e) {
      console.error('[recheck] lỗi hệ thống', e);
      try { if (prog) await _idbSetProg(Object.assign(prog, { paused: true })); } catch (_) {}
      _uiDo('error', String((e && e.message) || e).slice(0, 140));
    } finally {
      window._aiRecheckRunning = false;
      window._aiRecheckAbort = false;
      window._aiRecheckHard = false;
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
  function ScanReviewAVFilter(it) {
    if (!it) return true;
    // Chỉ áp dụng khi #rvAvFilter KHÁC 'all' — 'all' = KHÔNG lọc gì thêm (đúng yêu cầu #4)
    const el = document.getElementById('rvAvFilter');
    const mode = el ? String(el.value || 'all') : 'all';
    if (!mode || mode === 'all') return true;
    const cls = (window.ScanReviewAI && window.ScanReviewAI.aiClass) ? window.ScanReviewAI.aiClass(it) : 'chua_kiem_lai';
    switch (mode) {
      case 'uncertain':      return cls === 'nghi_van';
      case 'certain':        return cls === 'dung' || cls === 'da_ghi';
      case 'locked':         return cls === 'khoa_thu_cong';
      case 'none':           return cls !== 'nghi_van';
      case 'chua_kiem_lai':  return cls === 'chua_kiem_lai';
      case 'dung':           return cls === 'dung';
      case 'da_ghi':         return cls === 'da_ghi';
      case 'nghi_van':       return cls === 'nghi_van';
      case 'loi':            return cls === 'loi';
      case 'khoa_thu_cong':  return cls === 'khoa_thu_cong';
      default: return true;
    }
  }
  window.ScanReviewAVFilter = ScanReviewAVFilter;

  /* ---------- HÀM MỚI: goToNextUncertain — nút «Kiểm thủ công mục nghi vấn» ---------- */
  /* ---- KIỂM THỦ CÔNG MỤC NGHI VẤN: mở đúng thẻ + ảnh, chỉ hiện trường nghi vấn, xác nhận xong → khóa → tự nhảy tiếp ---- */
  const MANUAL = { on: false, id: null, keys: new Set() };
  const _aiClassOf = (it) => (window.ScanReviewAI && window.ScanReviewAI.aiClass) ? window.ScanReviewAI.aiClass(it) : 'nghi_van';
  const uncKeys = (it) => Object.keys((it.recheck && it.recheck.uncertain) || {}).filter(k => !k.startsWith('_'));
  (function manualCss() {
    if (document.getElementById('rvManualCss')) return;
    const st = document.createElement('style'); st.id = 'rvManualCss';
    st.textContent = '.rv-card.rv-manual .rv-row.rv-unc-hide{display:none!important}.rv-unc-ok{margin-top:4px}';
    document.head.appendChild(st);
  })();
  function applyManualView() {
    document.querySelectorAll('#rvList .rv-card').forEach(card => {
      const mine = MANUAL.on && card.dataset.id === MANUAL.id;
      card.classList.toggle('rv-manual', mine);
      card.querySelectorAll('.rv-row[data-field]').forEach(row => {
        const key = row.dataset.field, isUnc = MANUAL.keys.has(key);
        row.classList.toggle('rv-unc-hide', mine && !isUnc);
        // Dòng «Khớp» không có nút chọn nguồn → thêm nút xác nhận để người dùng vẫn khóa được trường nghi vấn
        if (mine && isUnc && !row.querySelector('.rv-pick') && !row.querySelector('[data-rvunc-ok]')) {
          const f = row.querySelector('.rv-field');
          if (f) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-secondary btn-sm rv-unc-ok'; b.dataset.rvuncOk = key; b.textContent = '🔒 Xác nhận trường này đúng'; f.appendChild(b); }
        }
      });
    });
  }
  let _manObs = null;
  function ensureManualObserver() {
    const list = document.getElementById('rvList'); if (!list || _manObs) return;
    let raf = 0;
    _manObs = new MutationObserver(() => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; applyManualView(); }); });
    _manObs.observe(list, { childList: true, subtree: true });
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-rvunc-ok]'); if (!b) return;
    e.preventDefault();
    const card = b.closest('.rv-card'); if (!card) return;
    const key = b.dataset.rvuncOk;
    if (!window.confirm('Bạn xác nhận đã đối chiếu với ảnh và giá trị trường này đúng như hiện tại?\n(Trường sẽ bị KHÓA — AI không đọc lại.)')) return;
    const raw = await DB.dbGet(ST_ITEMS, card.dataset.id); if (!raw) return;
    const it = normItem(raw);
    if (R.lockUser) R.lockUser(it, [key]);
    else { delete it.recheck.uncertain[key]; it.recheck.locked[key] = { by: 'user', at: Date.now() }; }
    if (typeof markFieldsChecked === 'function') markFieldsChecked(it, [key]);
    await saveItem(it);
    await refreshReviewUi(true);
  });
  // Người dùng xác nhận xong (mọi đường: nút nguồn / cả xe / nút trên) → hết trường nghi vấn thì tự nhảy xe kế
  let _advT = 0;
  S.on('itemsChanged', () => {
    if (!MANUAL.on || !MANUAL.id) return;
    clearTimeout(_advT);
    _advT = setTimeout(async () => {
      try {
        const raw = await DB.dbGet(ST_ITEMS, MANUAL.id);
        if (!raw) { await goToNextUncertain(); return; }
        const keys = uncKeys(normItem(raw));
        if (!keys.length) { toast('🔒 Đã xác nhận xong các trường nghi vấn của xe — chuyển sang xe kế tiếp.'); await goToNextUncertain(); }
        else { MANUAL.keys = new Set(keys); applyManualView(); }
      } catch (_) {}
    }, 700);
  });
  async function goToNextUncertain() {
    let list = [];
    try { list = (await DB.dbGetAll(ST_ITEMS)).map(normItem); } catch (_) { list = []; }
    list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const pos = MANUAL.id ? list.findIndex(x => x.id === MANUAL.id) : -1;
    const ordered = list.slice(pos + 1).concat(list.slice(0, pos + 1))
      .filter(x => uncKeys(x).length && _aiClassOf(x) === 'nghi_van');   // cùng định nghĩa «nghi vấn» với bộ lọc / số đếm / chip
    if (!ordered.length) {
      MANUAL.on = false; MANUAL.id = null; MANUAL.keys = new Set(); applyManualView();
      toast('✅ Hoàn tất: không còn mục nghi vấn.'); return;
    }
    const it = ordered[0], keys = uncKeys(it);
    MANUAL.on = true; MANUAL.id = it.id; MANUAL.keys = new Set(keys);
    try {
      // Đặt giá trị RỒI phát sự kiện: handler trong scan-review.js mới cập nhật R.filter / R.checker / R.search / R.page
      // (trước đây chỉ gán .value → ô chọn hiện «Tất cả» nhưng R.filter vẫn là «Cần xem xét» → thẻ nghi vấn bị ẩn)
      const fEl = document.getElementById('rvFilter'); if (fEl && fEl.value !== 'all') { fEl.value = 'all'; fEl.dispatchEvent(new Event('change')); }
      const cEl = document.getElementById('rvChecker'); if (cEl && cEl.value !== '') { cEl.value = ''; cEl.dispatchEvent(new Event('change')); }
      const sEl = document.getElementById('rvSearch'); if (sEl && sEl.value !== '') { sEl.value = ''; sEl.dispatchEvent(new Event('input')); }
      const avEl = document.getElementById('rvAvFilter'); if (avEl && avEl.value !== 'all') { avEl.value = 'all'; avEl.dispatchEvent(new Event('change')); }
    } catch (_) {}
    await refreshReviewUi(true);
    await goToItem(it.id, true);                                       // mở thẻ + khung ảnh đúng phiếu/vùng xe
    ensureManualObserver(); applyManualView();
    setTimeout(() => {
      try {
        const row = document.querySelector(`.rv-card[data-id="${CSS.escape(it.id)}"] .rv-row[data-field="${CSS.escape(keys[0])}"]`);
        if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (_) {}
    }, 300);
  }

  /* ---------- HÀM MỚI: bindRecheckUI — gắn sự kiện cho nút/bộ lọc mới ---------- */
  function bindRecheckUI() {
    // #rvAvFilter đã được bindReviewUI (scan-review.js) xử lý — không gắn trùng
    const btnNext = document.getElementById('btnNextUncertain');
    if (btnNext && !btnNext._rvBound) { btnNext._rvBound = true; btnNext.addEventListener('click', goToNextUncertain); }
    // #btnRecheckAll: capture + stopImmediatePropagation → chỉ logic mới chạy. Đang chạy ngầm thì bấm = hỏi dừng.
    const btnAll = document.getElementById('btnRecheckAll');
    if (btnAll && !btnAll._rvBound) {
      btnAll._rvBound = true;
      btnAll.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (window._aiRecheckRunning) { _uiDo('open'); return; }       // đang chạy → mở bảng trạng thái (Tạm dừng / Dừng hẳn nằm trong đó)
        _idbGetProg().then(pr => { if (pr && pr.lan) return resumeRecheck(); return recheckAllUnchecked(); }).catch(() => {});
      }, true);
    }
    ensureManualObserver();
  }

  /* ---------- Điều khiển cho bảng trạng thái (scan-ai-status.js) ---------- */
  function pauseRecheck() { if (window._aiRecheckRunning) window._aiRecheckAbort = true; }
  async function resumeRecheck() {
    if (window._aiRecheckRunning) return;
    const pr = await _idbGetProg();
    if (!pr || !pr.lan) return recheckAllUnchecked();
    pr.paused = false; pr.retryAt = 0; await _idbSetProg(pr);
    await runRecheckQueue({ onlyUnchecked: pr.onlyUnchecked !== false });
  }
  async function stopRecheckHard() {
    if (window._aiRecheckRunning) { window._aiRecheckHard = true; window._aiRecheckAbort = true; return; }
    await _idbClearProg(); _uiDo('stopped');
  }
  async function getRecheckProgress() { return _idbGetProg(); }

  /* ---------- Auto-bind khi DOM sẵn sàng ---------- */
  if (document.readyState !== 'loading') bindRecheckUI();
  else document.addEventListener('DOMContentLoaded', bindRecheckUI);

  /* ---------- Export ---------- */
  window.ScanRecheck = {
    THRESH_CONFIDENT,
    aiCompareItem, aiApplyCertain, runRecheckQueue, recheckAllUnchecked,
    recheckOne, resumeIfPending,
    ScanReviewAVFilter, goToNextUncertain, bindRecheckUI,
    stop: () => { window._aiRecheckAbort = true; },
    pause: pauseRecheck, resume: resumeRecheck, stopHard: stopRecheckHard, getProgress: getRecheckProgress,
    clearProgress: () => { _idbClearProg(); },
  };
  // Mở lại web: chạy tiếp tiến độ dang dở (nếu có) sau khi hệ thống ổn định, rồi kiểm tra định kỳ
  setTimeout(() => { resumeIfPending().catch(() => {}); }, 25000);
  setInterval(() => { resumeIfPending().catch(() => {}); }, 10 * 60000);
})();