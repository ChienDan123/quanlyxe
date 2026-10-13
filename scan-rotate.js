/* =========================================================================
   scan-rotate.js — XOAY ẢNH PHIẾU SCAN (thủ công từng mặt + tự nhận hướng cho phiếu cũ) và LƯU LẠI
   Cách làm (khớp với cách scan.js đã làm khi quét): xoay THẬT ảnh bằng canvas rồi ghi đè frontBlob / backBlob trong IndexedDB.
   Nhờ vậy mọi nơi dùng ảnh (khung ảnh so sánh, viewer, PDF 2 mặt, tải ảnh) đều đúng hướng, mở lại không bị xoay lại sai.
     • Mặt 1 / mặt 2 xoay ĐỘC LẬP (rotate(scanId, 1|2, deg)).
     • Vùng xe trên mặt 1 (vungY0/X0/Y1/X1, hệ 0–1000 do Gemini trả) được quy đổi theo góc xoay -> bấm ảnh ↔ xe vẫn đúng.
     • Đồng bộ đa thiết bị: đặt rec.imgDirty (scan-sync.js đẩy lại ảnh) + rec.imgRev[mặt] (máy khác thấy mốc mới hơn thì bỏ ảnh cũ, tải lại bản đã xoay).
     • rec.rotChecked = true: phiếu đã được kiểm tra hướng (quét bằng bản mới tự đặt; phiếu cũ được đặt sau khi tự nhận hướng) -> không kiểm tra lại.
   Tự nhận hướng phiếu CŨ: gửi bản thu nhỏ (~1000px) cho Gemini (dùng lại chuỗi model dự phòng + xoay key) — mỗi phiếu chỉ 1 lần, có thể tắt.
   Nạp SAU scan.js và scan-sync.js (scan-review.js chỉ gọi lúc chạy nên thứ tự với nó không quan trọng).
   ========================================================================= */
const ScanRotate = (() => {
  'use strict';
  const S = ScanApp, DB = S.db, ST_SCANS = DB.ST_SCANS;
  const AUTO_KEY = 'vehicleScanAutoOrientV1';          // '0' = tắt tự nhận hướng (mặc định bật)
  const SIDE = (page) => (page === 2 || page === 'back') ? 'back' : 'front';
  const isPdf = (m) => m === 'application/pdf';
  const msgOf = (e) => String((e && e.message) || e);
  const tried = new Set();                              // phiếu đã thử tự nhận hướng trong phiên này (lỗi mạng không lặp vô hạn)

  const normDeg = (n) => { n = Math.round(Number(n) || 0); n = ((n % 360) + 360) % 360; return [0, 90, 180, 270].includes(n) ? n : (Math.round(n / 90) * 90) % 360; };
  const autoOn = () => { try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch (e) { return true; } };
  const setAuto = (on) => { try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (e) { /* bỏ qua */ } };

  /* ---------------- XOAY ẢNH BẰNG CANVAS ---------------- */
  // deg: 90 / 180 / 270 THEO CHIỀU KIM ĐỒNG HỒ (cùng quy ước huongMat1/2 của scan.js)
  async function rotateBlob(blob, deg, quality) {
    const bmp = await createImageBitmap(blob);
    const w0 = bmp.width, h0 = bmp.height, swap = deg === 90 || deg === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? h0 : w0; canvas.height = swap ? w0 : h0;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (deg === 90) ctx.translate(h0, 0); else if (deg === 180) ctx.translate(w0, h0); else if (deg === 270) ctx.translate(0, w0);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality || 0.92));
    canvas.width = canvas.height = 0;
    if (!out) throw new Error('Không xuất được ảnh sau khi xoay (canvas.toBlob rỗng)');
    return out;
  }

  // Quy đổi 1 điểm (x, y) hệ 0–1000 khi ảnh xoay `deg` độ thuận chiều kim đồng hồ
  function rotPoint(x, y, deg) {
    if (deg === 90) return [1000 - y, x];
    if (deg === 180) return [1000 - x, 1000 - y];
    if (deg === 270) return [y, 1000 - x];
    return [x, y];
  }
  // Quy đổi khung xe (vungX0/Y0/X1/Y1) của từng xe; xe không có vùng giữ nguyên. Trả mảng MỚI (không sửa mảng cũ).
  function rotateVehicles(vehicles, deg) {
    return (vehicles || []).map((v) => {
      const x0 = Number(v.vungX0), y0 = Number(v.vungY0), x1 = Number(v.vungX1), y1 = Number(v.vungY1);
      if (![x0, y0, x1, y1].every(Number.isFinite)) return v;
      const a = rotPoint(x0, y0, deg), b = rotPoint(x1, y1, deg);
      return { ...v, vungX0: Math.round(Math.min(a[0], b[0])), vungX1: Math.round(Math.max(a[0], b[0])), vungY0: Math.round(Math.min(a[1], b[1])), vungY1: Math.round(Math.max(a[1], b[1])) };
    });
  }

  /* ---------------- XOAY THỦ CÔNG (từng mặt, độc lập) ---------------- */
  // Hàng đợi theo phiếu: bấm xoay liên tiếp thì làm lần lượt, không ghi đè nhau
  const chains = new Map();
  function rotate(scanId, page, deg) {
    const prev = chains.get(scanId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => rotateNow(scanId, page, deg));
    chains.set(scanId, next);
    next.catch(() => {}).then(() => { if (chains.get(scanId) === next) chains.delete(scanId); });
    return next;
  }
  async function rotateNow(scanId, page, deg) {
    deg = normDeg(deg); if (!deg) return null;
    const side = SIDE(page);
    let rec = await DB.dbGet(ST_SCANS, scanId);
    if (!rec) throw new Error('Không tìm thấy phiếu trên máy này.');
    if (!rec[side + 'Blob'] && window.ScanSync && rec.cloud) rec = await ScanSync.ensureBlobs(rec);   // phiếu từ máy khác: tải ảnh về trước
    const src = rec[side + 'Blob'];
    if (!src) throw new Error('Chưa có ảnh ' + (side === 'front' ? 'mặt 1' : 'mặt 2') + ' trên máy này.');
    if (isPdf(rec[side + 'Mime'] || src.type)) throw new Error('File PDF không xoay được (chỉ xoay ảnh).');
    const out = await rotateBlob(src, deg);
    // Đọc lại bản ghi MỚI NHẤT rồi mới ghi (trong lúc xoay, đồng bộ có thể đã cập nhật phiếu)
    const cur = await DB.dbGet(ST_SCANS, scanId);
    if (!cur) return null;
    cur[side + 'Blob'] = out; cur[side + 'Mime'] = 'image/jpeg';
    if (side === 'front' && cur.extracted && Array.isArray(cur.extracted.vehicles)) cur.extracted = { ...cur.extracted, vehicles: rotateVehicles(cur.extracted.vehicles, deg) };
    cur.rot = { ...(cur.rot || {}), [side]: ((((cur.rot && cur.rot[side]) || 0) + deg) % 360) };   // tổng góc đã xoay thêm (chỉ để tham khảo)
    cur.rotChecked = true;                                                                          // người dùng đã chỉnh -> khỏi tự nhận hướng nữa
    cur.imgRev = { ...(cur.imgRev || {}), [side]: Date.now() };                                     // máy khác thấy mốc mới hơn -> tải lại ảnh
    cur.imgDirty = { ...(cur.imgDirty || {}), [side]: true };                                       // scan-sync đẩy lại ảnh này lên Drive
    await DB.dbPut(ST_SCANS, cur);
    if (window.ScanDisk && ScanDisk.writeRec) { try { Promise.resolve(ScanDisk.writeRec(cur)).catch(() => {}); } catch (e) { /* bỏ qua */ } }
    if (window.ScanSync) ScanSync.touch(scanId);
    return cur;
  }

  // Đánh dấu «đã kiểm tra hướng» (không đổi ảnh) + đẩy meta để máy khác khỏi kiểm tra lại
  async function markChecked(scanId) {
    const cur = await DB.dbGet(ST_SCANS, scanId); if (!cur || cur.rotChecked) return;
    cur.rotChecked = true; await DB.dbPut(ST_SCANS, cur);
    if (window.ScanSync) ScanSync.touch(scanId);
  }

  /* ---------------- TỰ NHẬN HƯỚNG (phiếu cũ chưa kiểm tra) ---------------- */
  const needsAuto = (rec) => !!(rec && autoOn() && !rec.rotChecked && rec.frontBlob && !isPdf(rec.frontMime) && !tried.has(rec.id));
  const ORIENT_SCHEMA = { type: 'OBJECT', properties: { huongMat1: { type: 'INTEGER' }, huongMat2: { type: 'INTEGER' } }, required: ['huongMat1', 'huongMat2'] };
  const ORIENT_PROMPT = (hasBack) => `Đây là ảnh scan/chụp phiếu giấy tiếng Việt (có chữ in). CHỈ xác định HƯỚNG của ảnh, không đọc nội dung.
huongMat1${hasBack ? ' và huongMat2' : ''} = số độ cần xoay ảnh THEO CHIỀU KIM ĐỒNG HỒ để chữ in đứng thẳng, đọc xuôi từ trái sang phải: 0 (ảnh đã đúng chiều), 90 (đầu phiếu đang nằm bên TRÁI ảnh), 180 (ảnh bị lộn ngược), 270 (đầu phiếu đang nằm bên PHẢI ảnh). Ảnh gần như trắng / không có chữ -> 0.${hasBack ? '' : ' Không có mặt 2 -> huongMat2 = 0.'}`;

  // Bản thu nhỏ để gửi Gemini (nhẹ, nhanh): cạnh dài ≤ 1000px
  async function thumb(blob) {
    const bmp = await createImageBitmap(blob), k = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const url = c.toDataURL('image/jpeg', 0.75); c.width = c.height = 0;
    return { mime: 'image/jpeg', base64: url.slice(url.indexOf(',') + 1) };
  }

  const inflightAuto = new Map();
  // Trả { changed, dF, dB } hoặc { skipped } / { error }. KHÔNG ném lỗi (chạy nền, không được làm hỏng màn so sánh).
  function autoOrient(scanId) {
    if (inflightAuto.has(scanId)) return inflightAuto.get(scanId);
    const p = (async () => {
      const rec = await DB.dbGet(ST_SCANS, scanId);
      if (!needsAuto(rec)) return { skipped: true };
      tried.add(scanId);
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 60000);   // không treo quá 1 phút khi các model đang quá tải
      try {
        const f = await thumb(rec.frontBlob), hasBack = !!(rec.backBlob && !isPdf(rec.backMime));
        const b = hasBack ? await thumb(rec.backBlob) : null;
        const parts = [{ text: ORIENT_PROMPT(hasBack) }, { text: 'MẶT 1:' }, { inlineData: { mimeType: f.mime, data: f.base64 } }];
        if (b) parts.push({ text: 'MẶT 2:' }, { inlineData: { mimeType: b.mime, data: b.base64 } });
        const r = await S.geminiGenerate({ parts, schema: ORIENT_SCHEMA, signal: ctrl.signal });
        const j = JSON.parse(String(r.text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim());
        const dF = normDeg(j.huongMat1), dB = hasBack ? normDeg(j.huongMat2) : 0;
        if (dF) await rotate(scanId, 1, dF);
        if (dB) await rotate(scanId, 2, dB);
        await markChecked(scanId);                      // đã hỏi xong (kể cả 0°) -> lưu để lần sau không hỏi lại
        return { changed: !!(dF || dB), dF, dB };
      } catch (e) {
        console.warn('[scan-rotate] tự nhận hướng lỗi', scanId, e);
        return { error: msgOf(e) };                     // chưa đánh dấu đã kiểm -> lần mở sau (phiên sau) thử lại
      } finally { clearTimeout(timer); }
    })().finally(() => inflightAuto.delete(scanId));
    inflightAuto.set(scanId, p);
    return p;
  }

  /* ---------------- GIAO DIỆN DÙNG CHUNG ---------------- */
  // 3 nút xoay cho 1 mặt; scan-review.js gắn vào nhãn từng mặt. data-rot = «mặt:độ»
  const buttonsHtml = (page) => `<span class="rv-rot" role="group" aria-label="Xoay ảnh">`
    + `<button type="button" class="btn btn-ghost btn-sm" data-rot="${page}:270" title="Xoay trái 90°">↺ 90°</button>`
    + `<button type="button" class="btn btn-ghost btn-sm" data-rot="${page}:90" title="Xoay phải 90°">↻ 90°</button>`
    + `<button type="button" class="btn btn-ghost btn-sm" data-rot="${page}:180" title="Lật ngược 180°">⟲ 180°</button></span>`;

  function bindAutoToggle() {
    const el = document.getElementById('rvAutoOrient'); if (!el || el._bound) return;
    el._bound = true; el.checked = autoOn();
    el.addEventListener('change', () => setAuto(el.checked));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindAutoToggle); else bindAutoToggle();

  return { rotate, autoOrient, needsAuto, buttonsHtml, autoOn, setAuto, rotateVehicles, rotateBlob, normDeg };
})();
window.ScanRotate = ScanRotate;
