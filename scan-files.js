/* =========================================================================
   scan-files.js — ĐẶT TÊN & TẢI FILE ẢNH / PHIẾU
   - Tên file luôn ghi RÕ BIỂN SỐ (phiếu có nhiều biển -> ghi TẤT CẢ), vd:
        51F-123.45_59A1-678.90_20261007_mat1.jpg   (mặt 1)
        51F-123.45_59A1-678.90_20261007_mat2.jpg   (mặt 2)
        51F-123.45_59A1-678.90_20261007_phieu.pdf  (PDF ĐẦY ĐỦ: mặt 1 + mặt 2 trong 1 file)
   - Ảnh chỉ nằm trên Drive (máy khác) sẽ được tải về tự động qua ScanSync.ensureBlobs trước khi xuất.
   Nạp SAU scan-review.js (dùng ScanApp, ScanSync). Không đụng DOM ngoài toast().
   ========================================================================= */
const ScanFiles = (() => {
  'use strict';
  const S = ScanApp, DB = S.db;
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const SIDE_SUFFIX = { front: 'mat1', back: 'mat2', pdf: 'phieu' };
  const MAX_PLATE_PART = 180;        // giới hạn phần biển số trong tên file (hệ điều hành giới hạn ~255 ký tự)

  // Bỏ ký tự cấm trong tên file + khoảng trắng; GIỮ dấu gạch/chấm của biển số để dễ đọc
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, '').trim();
  const ymd = (ts) => { const d = new Date(ts || Date.now()), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };

  // Mọi biển số của phiếu: lấy từ các mục so sánh (đã gồm biển người dùng sửa tay), không có thì lấy theo dữ liệu máy đọc
  async function platesOf(rec) {
    let items = [];
    try { items = (await DB.tx(DB.ST_ITEMS, 'readonly', os => os.index('scanId').getAll(rec.id))) || []; } catch (e) { /* bỏ qua */ }
    let plates = items.map(i => i.bienSoRaw || i.bienSo);
    if (!plates.some(Boolean) && rec.extracted) plates = (rec.extracted.bienSoRaw && rec.extracted.bienSoRaw.length ? rec.extracted.bienSoRaw : rec.extracted.bienSo) || [];
    return [...new Set(plates.map(safe).filter(Boolean))];
  }

  // Tên (không đuôi) — side: 'front' | 'back' | 'pdf'
  function stem(rec, plates, side) {
    const list = (plates && plates.length ? plates : ['KhongRoBienSo']).map(safe);
    let part = '', used = 0;
    for (const p of list) {
      const next = part ? part + '_' + p : p;
      if (next.length > MAX_PLATE_PART && used) break;   // quá dài: cắt bớt rồi ghi «+N biển»
      part = next; used++;
    }
    if (used < list.length) part += `_va${list.length - used}bienkhac`;
    return `${part}_${ymd(rec.timestamp)}_${SIDE_SUFFIX[side] || side}`;
  }
  const extOf = (mime) => EXT[mime] || 'jpg';
  const fileName = (rec, plates, side, mime) => `${stem(rec, plates, side)}.${side === 'pdf' ? 'pdf' : extOf(mime)}`;

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---- Ghép PDF đầy đủ (mặt 1 + mặt 2) bằng pdf-lib, nạp theo yêu cầu: ưu tiên lib/pdf-lib.min.js, dự phòng CDN ---- */
  let _pdfLib = null;
  function ensurePdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (_pdfLib) return _pdfLib;
    const load = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Không nạp được ' + src)); document.head.appendChild(s); });
    _pdfLib = load('lib/pdf-lib.min.js').catch(() => load('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'))
      .then(() => window.PDFLib).catch((e) => { _pdfLib = null; throw new Error('Không nạp được thư viện tạo PDF (cần mạng lần đầu): ' + e.message); });
    return _pdfLib;
  }
  // Ảnh định dạng khác JPEG/PNG (vd. webp) -> đổi sang PNG để nhúng vào PDF
  async function toPngBytes(blob) {
    const bmp = await createImageBitmap(blob), cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height; cv.getContext('2d').drawImage(bmp, 0, 0);
    return new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/png'))).arrayBuffer());
  }
  async function buildPdf(rec) {
    const lib = await ensurePdfLib(), doc = await lib.PDFDocument.create();
    for (const side of ['front', 'back']) {
      const blob = rec[side + 'Blob']; if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50;                     // "%P" = PDF gốc
      if (isPdf) { const src = await lib.PDFDocument.load(bytes); (await doc.copyPages(src, src.getPageIndices())).forEach(p => doc.addPage(p)); continue; }
      const isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8, isPng = bytes[0] === 0x89 && bytes[1] === 0x50;   // nhận diện theo nội dung, không tin mime
      const img = isJpg ? await doc.embedJpg(bytes) : isPng ? await doc.embedPng(bytes) : await doc.embedPng(await toPngBytes(blob));
      const A4 = img.width > img.height ? [841.89, 595.28] : [595.28, 841.89];   // ảnh ngang -> trang ngang
      const page = doc.addPage(A4), k = Math.min(A4[0] / img.width, A4[1] / img.height), w = img.width * k, h = img.height * k;
      page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
    }
    if (!doc.getPageCount()) throw new Error('Phiếu không có ảnh để tạo PDF.');
    return new Blob([await doc.save()], { type: 'application/pdf' });
  }

  // kind: 'pdf' (đầy đủ 2 mặt) | 'front' | 'back'
  async function download(scanId, kind) {
    try {
      let rec = await DB.dbGet(DB.ST_SCANS, scanId);
      if (!rec) { toast('Không tìm thấy phiếu trên máy này.', true); return; }
      if (window.ScanSync) rec = await ScanSync.ensureBlobs(rec);
      const plates = await platesOf(rec);
      if (kind === 'pdf') {
        toast('Đang tạo PDF đầy đủ…');
        saveBlob(await buildPdf(rec), fileName(rec, plates, 'pdf'));
      } else {
        const blob = rec[kind + 'Blob'];
        if (!blob) { toast(rec._cloudMsg || (kind === 'back' ? 'Phiếu không có mặt 2.' : 'Không có ảnh mặt này.'), true); return; }
        saveBlob(blob, fileName(rec, plates, kind, rec[kind + 'Mime'] || blob.type));
      }
    } catch (e) { toast('Không tải được: ' + (e.message || e), true); }
  }

  return { platesOf, stem, fileName, download, buildPdf, saveBlob };
})();
window.ScanFiles = ScanFiles;
