/* =========================================================================
   QUÉT PHIẾU HÀNG LOẠT — scan.js  (SPRINT 1)
   Nạp SAU app.js (dùng lại các hàm toàn cục: $, $all, toast, openModal,
   closeModal, escapeHtml).

   Sprint 1 gồm:
     1. Schema IndexedDB riêng cho module quét (scans / apiKeys / settings).
     2. Quản lý nhiều API key Gemini (thêm/xóa/bật-tắt/kiểm tra) trong Cài đặt.
     3. Hàm gọi Gemini có XOAY KEY + cooldown + chờ quota + phân loại lỗi.
     4. Form thử 1 phiếu (mặt 1 + mặt 2 tuỳ chọn) -> Gemini -> JSON -> panel debug.

   ---- CHỌN CSDL: IndexedDB (API gốc, KHÔNG dùng Dexie) ----
   Lý do: miễn phí, offline, lưu được Blob ảnh trực tiếp (không cần base64),
   đủ cho vài nghìn tờ. Dùng API gốc thay vì Dexie để không thêm phụ thuộc CDN
   và đồng bộ với cách app.js đang dùng IndexedDB (openIdb). DB tách riêng
   ('vehicleScanDBV1') khỏi cache dữ liệu xe ('vehicleAppCacheV1') để lỗi/nâng
   cấp schema của module này không ảnh hưởng dữ liệu cũ.
   Không dùng localStorage cho ảnh/key vì quota ~5MB.

   Bảo mật: API key CHỈ nằm trong IndexedDB của trình duyệt này, không có
   trong mã nguồn nên không bị commit lên GitHub. Key gửi qua header
   x-goog-api-key (không nằm trên URL nên không lọt vào log/lịch sử).
   ========================================================================= */

const ScanApp = (() => {
  'use strict';

  /* ---------------------------- 1. SCHEMA INDEXEDDB ---------------------------- */
  const DB_NAME = 'vehicleScanDBV1';
  const DB_VERSION = 1;
  const ST_SCANS = 'scans';       // 1 record / 1 tờ vật lý
  const ST_KEYS = 'apiKeys';      // danh sách key Gemini
  const ST_SETTINGS = 'settings'; // cấu hình module (model, timeout...)

  /* Schema record (ghi chú cho các sprint sau):
     scans: {
       id, timestamp,
       source: 'manual-test' | 'batch',
       isTest: boolean,
       frontBlob, backBlob?,          // Blob ảnh (đã nén) hoặc PDF gốc
       frontMime, backMime,
       frontHash,                     // SHA-256 mặt 1 -> chống quét trùng
       backBlank: boolean,            // mặt 2 trống (Sprint 4)
       status: 'pending'|'analyzing'|'done'|'error',
       error?: string,
       geminiRaw,                     // text JSON thô Gemini trả về
       model, keyLabel,
       extracted: { loaiPhieu, bienSo[], chuHo, cccd, sdt, tinhTrang[], ghiChu,
                    vehicles[], backHasContent, ... },
       matchedBienSo: string[]        // Sprint 2-3: biển khớp DS xe
     }
     apiKeys: { id, label, key, enabled, status:'ok'|'invalid', lastUsed,
                errorCount, cooldownUntil, lastError, createdAt }
     settings: { name:'main', model, timeoutSec, maxWaitRounds, maxEdgePx } */
  let _dbPromise = null;
  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('Trình duyệt không hỗ trợ IndexedDB')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ST_SCANS)) {
          const s = db.createObjectStore(ST_SCANS, { keyPath: 'id' });
          s.createIndex('timestamp', 'timestamp');
          s.createIndex('status', 'status');
          s.createIndex('frontHash', 'frontHash');
        }
        if (!db.objectStoreNames.contains(ST_KEYS)) db.createObjectStore(ST_KEYS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(ST_SETTINGS)) db.createObjectStore(ST_SETTINGS, { keyPath: 'name' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Không mở được IndexedDB'));
    });
    return _dbPromise;
  }
  // Bọc 1 request IDB thành Promise
  async function tx(store, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      let result;
      const r = fn(os);
      if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const dbGetAll = (store) => tx(store, 'readonly', os => os.getAll());
  const dbGet = (store, key) => tx(store, 'readonly', os => os.get(key));
  const dbPut = (store, val) => tx(store, 'readwrite', os => os.put(val));
  const dbDelete = (store, key) => tx(store, 'readwrite', os => os.delete(key));
  const dbCount = (store) => tx(store, 'readonly', os => os.count());

  /* ---------------------------- 2. TIỆN ÍCH ---------------------------- */
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Chuẩn hóa biển số: UPPERCASE, bỏ khoảng trắng / chấm / gạch (Sprint 3 sẽ dùng để khớp).
  function normalizeBienSo(s) {
    return String(s || '').toUpperCase().replace(/[\s.\-_]/g, '');
  }
  // Chuẩn hóa CCCD: chỉ giữ chữ số. (Pad 0 đầu về 12 số + so tiền tố: Sprint 3.)
  function normalizeCccd(s) {
    return String(s || '').replace(/\D/g, '');
  }

  async function sha256Hex(blob) {
    try {
      if (!(window.crypto && crypto.subtle)) return null;
      const buf = await blob.arrayBuffer();
      const h = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return null; }
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // Nén ảnh: giảm cạnh dài về <= maxEdge, xuất JPEG. Phiếu scan A4 300dpi có thể
  // rất nặng (5-10MB); nén còn ~300-600KB mà chữ vẫn đọc rõ -> nhanh + tiết kiệm.
  // PDF: giữ nguyên (Gemini đọc trực tiếp application/pdf).
  async function prepareFile(file, maxEdge) {
    const mime = file.type || '';
    if (mime === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      return { blob: file, mime: 'application/pdf', base64: await blobToBase64(file), name: file.name, original: file.size };
    }
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) {
      throw new Error(`Định dạng "${mime || file.name}" chưa hỗ trợ (dùng JPG/PNG/WebP/PDF).`);
    }
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // nền trắng cho PNG trong suốt
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
    return { blob, mime: 'image/jpeg', base64: await blobToBase64(blob), name: file.name, original: file.size, w, h };
  }

  /* ---------------------------- 3. CÀI ĐẶT MODULE ---------------------------- */
  const DEFAULT_SETTINGS = {
    name: 'main',
    model: 'gemini-2.5-flash', // sửa được trong Cài đặt (tên model Gemini thay đổi theo thời gian)
    timeoutSec: 90,
    maxWaitRounds: 4,          // số lần chờ khi MỌI key đang cooldown, rồi mới báo lỗi
    maxEdgePx: 2000,
  };
  async function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...((await dbGet(ST_SETTINGS, 'main')) || {}) }; }
    catch (e) { return { ...DEFAULT_SETTINGS }; }
  }
  async function saveSettings(s) { await dbPut(ST_SETTINGS, { ...DEFAULT_SETTINGS, ...s, name: 'main' }); }

  /* ---------------------------- 4. QUẢN LÝ API KEY ---------------------------- */
  const listKeys = async () => (await dbGetAll(ST_KEYS)).sort((a, b) => a.createdAt - b.createdAt);
  async function addKey(label, key) {
    const rec = { id: uid(), label: label || 'Key', key: key.trim(), enabled: true, status: 'ok',
      lastUsed: 0, errorCount: 0, cooldownUntil: 0, lastError: '', createdAt: Date.now() };
    await dbPut(ST_KEYS, rec);
    return rec;
  }
  async function patchKey(id, patch) {
    const k = await dbGet(ST_KEYS, id);
    if (!k) return null;
    Object.assign(k, patch);
    await dbPut(ST_KEYS, k);
    notifyKeysChanged();
    return k;
  }
  const removeKey = (id) => dbDelete(ST_KEYS, id);

  let _onKeysChanged = null;
  function notifyKeysChanged() { if (_onKeysChanged) _onKeysChanged(); }

  /* ---------------------------- 5. GỌI GEMINI + XOAY KEY ---------------------------- */
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

  // Lỗi có phân loại để vòng xoay quyết định: đổi key / chờ / dừng hẳn.
  class GeminiError extends Error {
    constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
  }
  // kind:
  //  'quota'     429 hết quota          -> cooldown key (lũy thừa), thử key khác
  //  'invalid'   key sai / bị khóa      -> loại key khỏi vòng, báo đỏ
  //  'transient' 5xx / mạng / timeout   -> cooldown ngắn, thử key khác
  //  'fatal'     lỗi do yêu cầu (model sai, JSON schema sai...) -> dừng, KHÔNG phạt key
  //  'blocked'   Gemini chặn nội dung   -> dừng (không do key)
  //  'parse'     trả về không phải JSON hợp lệ
  //  'cancelled' người dùng hủy

  function classifyHttp(status, bodyText) {
    let msg = bodyText, retrySec = 0, errStatus = '';
    try {
      const j = JSON.parse(bodyText);
      msg = (j.error && j.error.message) || bodyText;
      errStatus = (j.error && j.error.status) || '';
      // Gemini trả gợi ý chờ bao lâu trong details (RetryInfo.retryDelay = "23s")
      const info = ((j.error && j.error.details) || []).find(d => d.retryDelay);
      if (info) retrySec = parseFloat(info.retryDelay) || 0;
    } catch (e) { /* body không phải JSON */ }
    msg = String(msg || '').slice(0, 300);
    if (status === 429 || errStatus === 'RESOURCE_EXHAUSTED') return new GeminiError('quota', `429 hết quota: ${msg}`, { retrySec });
    if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|API key expired/i.test(msg))
      return new GeminiError('invalid', `Key không hợp lệ/bị từ chối (${status}): ${msg}`);
    if (status === 404) return new GeminiError('fatal', `Model không tồn tại hoặc không hỗ trợ (404): ${msg}`);
    if (status === 400) return new GeminiError('fatal', `Yêu cầu bị từ chối (400): ${msg}`);
    if (status >= 500) return new GeminiError('transient', `Lỗi máy chủ Gemini (${status}): ${msg}`);
    return new GeminiError('fatal', `HTTP ${status}: ${msg}`);
  }

  // Gọi Gemini bằng 1 key cụ thể. Ném GeminiError nếu thất bại.
  async function requestOnce(keyRec, model, body, timeoutMs, userSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    const onUserAbort = () => ctrl.abort('user');
    if (userSignal) {
      if (userSignal.aborted) { clearTimeout(timer); throw new GeminiError('cancelled', 'Đã hủy'); }
      userSignal.addEventListener('abort', onUserAbort, { once: true });
    }
    try {
      const res = await fetch(`${GEMINI_BASE}${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyRec.key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw classifyHttp(res.status, text);
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new GeminiError('transient', 'Phản hồi Gemini không phải JSON'); }
      return data;
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      if (e && e.name === 'AbortError') {
        if (ctrl.signal.reason === 'user') throw new GeminiError('cancelled', 'Đã hủy');
        throw new GeminiError('transient', `Quá thời gian chờ (${Math.round(timeoutMs / 1000)}s)`);
      }
      // TypeError: Failed to fetch -> mất mạng / CORS / bị chặn
      throw new GeminiError('transient', 'Lỗi mạng: ' + (e && e.message ? e.message : e));
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
    }
  }

  // Ghi kết quả của 1 lần gọi vào record key (cooldown / loại key / reset lỗi).
  async function recordKeyResult(keyRec, err) {
    if (!err) {
      await patchKey(keyRec.id, { lastUsed: Date.now(), errorCount: 0, cooldownUntil: 0, lastError: '', status: 'ok' });
      return;
    }
    const n = (keyRec.errorCount || 0) + 1;
    if (err.kind === 'invalid') {
      await patchKey(keyRec.id, { status: 'invalid', errorCount: n, lastError: err.message, lastUsed: Date.now() });
    } else if (err.kind === 'quota') {
      // Cooldown lũy thừa: 60s, 120s, 240s... tối đa 15 phút; nếu Gemini gợi ý
      // retryDelay dài hơn thì lấy giá trị đó.
      const backoff = Math.min(60000 * Math.pow(2, n - 1), 15 * 60000);
      const wait = Math.max(backoff, (err.retrySec || 0) * 1000);
      await patchKey(keyRec.id, { errorCount: n, cooldownUntil: Date.now() + wait, lastError: err.message, lastUsed: Date.now() });
    } else if (err.kind === 'transient') {
      const wait = Math.min(15000 * Math.pow(2, Math.min(n - 1, 3)), 5 * 60000); // 15s..2 phút
      await patchKey(keyRec.id, { errorCount: n, cooldownUntil: Date.now() + wait, lastError: err.message, lastUsed: Date.now() });
    }
    // fatal / blocked / parse / cancelled: lỗi do yêu cầu, KHÔNG phạt key.
  }

  // Chờ có đếm ngược, hủy được.
  async function waitWithCountdown(ms, onTick, signal) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (signal && signal.aborted) throw new GeminiError('cancelled', 'Đã hủy');
      if (onTick) onTick(Math.ceil((end - Date.now()) / 1000));
      await sleep(Math.min(1000, end - Date.now()));
    }
  }

  /* XOAY KEY — thuật toán:
     1. Lấy các key: bật + chưa 'invalid'. Không còn key nào -> lỗi NO_KEY.
     2. Trong số đó chọn key KHÔNG cooldown, dùng lâu nhất (lastUsed nhỏ nhất)
        => xoay vòng đều, không dồn quota vào 1 key.
     3. Gọi. Lỗi quota/transient -> key vào cooldown, vòng lặp tự chọn key kế.
        Lỗi invalid -> loại key. Lỗi fatal -> dừng ngay.
     4. Nếu MỌI key đang cooldown -> chờ đến lúc key sớm nhất hồi (tối thiểu 5s),
        báo UI "Đang chờ quota…", tối đa maxWaitRounds lần rồi mới bỏ cuộc.
     Chạy TUẦN TỰ (mỗi lần 1 request) theo đúng yêu cầu, không song song. */
  async function geminiGenerate({ parts, schema, onStatus, signal, systemInstruction }) {
    const st = await loadSettings();
    const say = (m, level) => { if (onStatus) onStatus(m, level || 'info'); };
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0 },
    };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (schema) {
      body.generationConfig.responseMimeType = 'application/json';
      body.generationConfig.responseSchema = schema;
    }
    let waitRound = 0;
    for (;;) {
      if (signal && signal.aborted) throw new GeminiError('cancelled', 'Đã hủy');
      const usable = (await listKeys()).filter(k => k.enabled && k.status !== 'invalid');
      if (!usable.length) throw new GeminiError('nokey', 'Chưa có API key Gemini nào dùng được. Thêm key trong ⚙️ Cài đặt.');
      const now = Date.now();
      const ready = usable.filter(k => (k.cooldownUntil || 0) <= now).sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
      if (!ready.length) {
        if (waitRound >= st.maxWaitRounds) throw new GeminiError('quota', `Mọi key đều hết quota/đang lỗi sau ${waitRound} lần chờ.`);
        const soonest = Math.min(...usable.map(k => k.cooldownUntil || 0));
        const wait = Math.max(5000, soonest - now);
        waitRound++;
        await waitWithCountdown(wait, (s) => say(`Đang chờ quota… thử lại sau ${s}s (lần chờ ${waitRound}/${st.maxWaitRounds})`, 'warn'), signal);
        continue;
      }
      const key = ready[0];
      say(`Gọi ${st.model} bằng "${key.label}"…`);
      const t0 = performance.now();
      try {
        const data = await requestOnce(key, st.model, body, st.timeoutSec * 1000, signal);
        const cand = data.candidates && data.candidates[0];
        const block = data.promptFeedback && data.promptFeedback.blockReason;
        if (block) throw new GeminiError('blocked', `Gemini chặn nội dung: ${block}`);
        const txt = cand && cand.content && cand.content.parts
          ? cand.content.parts.map(p => p.text || '').join('') : '';
        if (!txt.trim()) throw new GeminiError('parse', `Gemini trả rỗng (finishReason=${cand && cand.finishReason})`);
        await recordKeyResult(key, null);
        return {
          text: txt, usage: data.usageMetadata || null, finishReason: cand && cand.finishReason,
          model: st.model, keyId: key.id, keyLabel: key.label, ms: Math.round(performance.now() - t0),
        };
      } catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        await recordKeyResult(key, e);
        if (e.kind === 'cancelled' || e.kind === 'fatal' || e.kind === 'blocked' || e.kind === 'parse') throw e;
        if (e.kind === 'invalid') say(`Key "${key.label}" KHÔNG HỢP LỆ — đã loại khỏi vòng. ${e.message}`, 'error');
        else say(`Key "${key.label}": ${e.message} → đổi key`, 'warn');
        // quota / transient / invalid: quay lại đầu vòng, chọn key khác
      }
    }
  }

  /* ---------------------------- 6. PROMPT + JSON SCHEMA ---------------------------- */
  const TINH_TRANG = ['dang_hoat_dong', 'da_ban_chua_sang_ten', 'mat_cap', 'het_nien_han', 'mua_chua_sang_ten', 'khac', 'khong_ro'];
  const TINH_TRANG_LABEL = {
    dang_hoat_dong: 'Đang hoạt động', da_ban_chua_sang_ten: 'Đã bán chưa sang tên', mat_cap: 'Mất cắp',
    het_nien_han: 'Hết niên hạn', mua_chua_sang_ten: 'Mua chưa sang tên', khac: 'Khác', khong_ro: 'Không rõ',
  };
  const S = 'STRING';
  const SCAN_SCHEMA = {
    type: 'OBJECT',
    properties: {
      loaiPhieu: { type: S, enum: ['phieu_thu_thap', 'ban_cam_ket', 'khac'] },
      danhSachXe: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            bienSo: { type: S },
            loaiXe: { type: S },
            tinhTrang: { type: S, enum: TINH_TRANG },
            tinhTrangGhiTrenPhieu: { type: S },
            ghiChu: { type: S },
          },
          required: ['bienSo', 'tinhTrang'],
        },
      },
      chuHo: { type: S },
      cccd: { type: S },
      sdt: { type: S },
      ghiChuTay: { type: S },
      backHasContent: { type: 'BOOLEAN' },
      backNote: { type: S },
      truongKhongRo: { type: 'ARRAY', items: { type: S } },
    },
    required: ['loaiPhieu', 'danhSachXe', 'chuHo', 'cccd', 'sdt', 'ghiChuTay', 'backHasContent'],
  };

  function buildPrompt(hasBack) {
    return `Bạn là công cụ OCR chuyên đọc phiếu giấy tiếng Việt về phương tiện (xe máy/ô tô) do cán bộ cơ sở thu thập. Hãy đọc ảnh và trả về DUY NHẤT một JSON đúng schema đã cho.

QUY TẮC:
1. loaiPhieu: "phieu_thu_thap" (phiếu thu thập thông tin xe), "ban_cam_ket" (bản cam kết), hoặc "khac".
2. danhSachXe: MỖI xe trên phiếu là 1 phần tử (thường 1–3 xe). Với mỗi xe:
   - bienSo: chép ĐÚNG như viết trên phiếu (VD "92N2-0582"), không tự sửa/đoán. Nếu không đọc được thì để "".
   - loaiXe: nếu có (VD xe máy, ô tô), không có thì "".
   - tinhTrang: chọn 1 giá trị: dang_hoat_dong | da_ban_chua_sang_ten | mat_cap | het_nien_han | mua_chua_sang_ten | khac | khong_ro. Căn cứ ô được tích/gạch hoặc chữ ghi tay cạnh xe đó.
   - tinhTrangGhiTrenPhieu: chép nguyên văn dòng/ô tình trạng viết trên phiếu cho xe đó.
   - ghiChu: ghi chú riêng của xe đó (nếu có).
3. chuHo: họ tên chủ hộ/chủ xe, giữ nguyên dấu tiếng Việt.
4. cccd: số CCCD/CMND/MST, CHỈ gồm chữ số đúng như trên phiếu. Nếu thiếu số hoặc mờ, chép phần đọc được — KHÔNG tự thêm số.
5. sdt: số điện thoại, chỉ chữ số.
6. ghiChuTay: toàn bộ chữ viết tay/ghi chú thêm không thuộc ô in sẵn. Không có thì "".
7. truongKhongRo: liệt kê tên trường (VD "cccd", "bienSo xe 2") mà chữ mờ/khó đọc, để con người kiểm tra lại.
8. TUYỆT ĐỐI không bịa dữ liệu. Chỗ không có/không đọc được -> chuỗi rỗng.
${hasBack
  ? `9. Có 2 ảnh: MẶT 1 (thông tin chính) và MẶT 2. backHasContent = true nếu mặt 2 có chữ/chữ ký/dấu/ghi chú đáng kể; = false nếu trống hoặc gần như trắng. Nếu true, tóm tắt ngắn vào backNote (VD "có chữ ký người kê khai"). Thông tin xe/chủ hộ vẫn lấy chủ yếu từ mặt 1.`
  : `9. Chỉ có 1 ảnh (mặt 1). Đặt backHasContent = false.`}`;
  }

  // Dựng parts cho request từ ảnh đã chuẩn bị (prepareFile)
  function buildParts(front, back) {
    const parts = [{ text: buildPrompt(!!back) }];
    parts.push({ text: 'MẶT 1:' });
    parts.push({ inlineData: { mimeType: front.mime, data: front.base64 } });
    if (back) {
      parts.push({ text: 'MẶT 2:' });
      parts.push({ inlineData: { mimeType: back.mime, data: back.base64 } });
    }
    return parts;
  }

  // Parse JSON Gemini trả về (phòng khi có ```json fence dù đã yêu cầu mimeType JSON)
  function parseJsonLoose(txt) {
    const clean = String(txt).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(clean); }
    catch (e) { throw new GeminiError('parse', 'Không parse được JSON từ Gemini: ' + e.message, { raw: txt }); }
  }

  // Chuyển JSON Gemini -> object `extracted` theo schema IndexedDB
  function toExtracted(j) {
    const xe = Array.isArray(j.danhSachXe) ? j.danhSachXe : [];
    return {
      loaiPhieu: j.loaiPhieu || 'khac',
      bienSo: xe.map(v => normalizeBienSo(v.bienSo)).filter(Boolean),
      bienSoRaw: xe.map(v => v.bienSo || ''),
      vehicles: xe,
      chuHo: (j.chuHo || '').trim(),
      cccd: normalizeCccd(j.cccd),
      sdt: normalizeCccd(j.sdt),
      tinhTrang: xe.map(v => v.tinhTrang || 'khong_ro'),
      ghiChu: [j.ghiChuTay, j.backNote].filter(Boolean).join(' | '),
      backHasContent: !!j.backHasContent,
      truongKhongRo: j.truongKhongRo || [],
    };
  }

  // Phân tích 1 tờ: trả { extracted, geminiRaw, meta }. Dùng lại cho batch ở Sprint 2.
  async function analyzeSheet({ front, back, onStatus, signal }) {
    const r = await geminiGenerate({ parts: buildParts(front, back), schema: SCAN_SCHEMA, onStatus, signal });
    const json = parseJsonLoose(r.text);
    return { json, extracted: toExtracted(json), geminiRaw: r.text, meta: r };
  }

  // Kiểm tra 1 key còn sống không (gọi 1 câu ngắn, không schema)
  async function testKey(id) {
    const k = await dbGet(ST_KEYS, id);
    if (!k) throw new Error('Không tìm thấy key');
    const st = await loadSettings();
    try {
      await requestOnce(k, st.model, { contents: [{ role: 'user', parts: [{ text: 'Trả lời đúng 1 từ: OK' }] }] }, 30000);
      await recordKeyResult(k, null);
      return { ok: true, message: 'Key hoạt động tốt' };
    } catch (e) {
      if (e instanceof GeminiError) await recordKeyResult(k, e);
      return { ok: false, message: e.message, kind: e.kind };
    }
  }

  /* ---------------------------- 7. UI: CÀI ĐẶT (KEY + THÔNG SỐ) ---------------------------- */
  const maskKey = (k) => k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-4) : '••••';

  function keyStatusChip(k) {
    const now = Date.now();
    if (k.status === 'invalid') return '<span class="scan-chip scan-chip-err" title="' + escapeHtml(k.lastError) + '">❌ Không hợp lệ</span>';
    if (!k.enabled) return '<span class="scan-chip scan-chip-off">⏸ Tắt</span>';
    if ((k.cooldownUntil || 0) > now) {
      const s = Math.ceil((k.cooldownUntil - now) / 1000);
      return '<span class="scan-chip scan-chip-warn" title="' + escapeHtml(k.lastError) + '">⏳ Cooldown ' + (s >= 60 ? Math.ceil(s / 60) + ' phút' : s + 's') + '</span>';
    }
    return '<span class="scan-chip scan-chip-ok">✅ Sẵn sàng</span>';
  }

  async function renderKeyList() {
    const box = $('#geminiKeyList');
    if (!box) return;
    let keys = [];
    try { keys = await listKeys(); } catch (e) {
      box.innerHTML = '<div class="error-text">Không đọc được IndexedDB: ' + escapeHtml(e.message) + '</div>';
      return;
    }
    if (!keys.length) {
      box.innerHTML = '<div class="hint">Chưa có key nào. Thêm ít nhất 1 key Gemini để dùng tính năng Quét phiếu.</div>';
    } else {
      box.innerHTML = keys.map(k => `
        <div class="scan-key-row" data-id="${k.id}">
          <label class="chk-inline" title="Bật/tắt key này"><input type="checkbox" data-act="toggle" ${k.enabled ? 'checked' : ''}></label>
          <b class="scan-key-label">${escapeHtml(k.label)}</b>
          <code>${escapeHtml(maskKey(k.key))}</code>
          ${keyStatusChip(k)}
          <span class="scan-key-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-act="test">Kiểm tra</button>
            ${k.status === 'invalid' || k.cooldownUntil > Date.now() ? '<button type="button" class="btn btn-ghost btn-sm" data-act="reset" title="Xóa cooldown / trạng thái lỗi">↺ Reset</button>' : ''}
            <button type="button" class="btn btn-ghost btn-sm" data-act="del">🗑️</button>
          </span>
        </div>`).join('');
    }
    updateScanKeySummary(keys);
  }

  function updateScanKeySummary(keys) {
    const el = $('#scanKeySummary');
    if (!el) return;
    const now = Date.now();
    const ok = keys.filter(k => k.enabled && k.status !== 'invalid' && (k.cooldownUntil || 0) <= now).length;
    const usable = keys.filter(k => k.enabled && k.status !== 'invalid').length;
    el.textContent = keys.length
      ? `Gemini: ${ok} key sẵn sàng / ${usable} đang bật / ${keys.length} tổng`
      : 'Gemini: chưa có key — mở ⚙️ Cài đặt để thêm';
    el.className = 'badge ' + (ok ? 'scan-badge-ok' : 'scan-badge-bad');
  }

  async function fillScanSettingsForm() {
    const st = await loadSettings();
    $('#geminiModel').value = st.model;
    $('#geminiTimeout').value = st.timeoutSec;
    $('#geminiMaxWait').value = st.maxWaitRounds;
    renderKeyList();
  }

  function bindSettingsUI() {
    // Mở Cài đặt -> nạp form key (app.js đã tự mở modal ở listener của nó)
    $('#btnSettings').addEventListener('click', fillScanSettingsForm);

    $('#btnAddGeminiKey').addEventListener('click', async () => {
      const labelEl = $('#geminiKeyLabel'), keyEl = $('#geminiKeyValue');
      const key = keyEl.value.trim();
      if (!key) { toast('Hãy dán API key Gemini.', true); return; }
      const keys = await listKeys();
      if (keys.some(k => k.key === key)) { toast('Key này đã có trong danh sách.', true); return; }
      await addKey(labelEl.value.trim() || ('Key' + (keys.length + 1)), key);
      labelEl.value = ''; keyEl.value = '';
      toast('Đã thêm key.');
      renderKeyList();
    });

    $('#geminiKeyList').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.type === 'checkbox') return;
      const id = btn.closest('.scan-key-row').dataset.id;
      const act = btn.dataset.act;
      if (act === 'del') {
        if (!confirm('Xóa key này?')) return;
        await removeKey(id); renderKeyList();
      } else if (act === 'reset') {
        await patchKey(id, { status: 'ok', errorCount: 0, cooldownUntil: 0, lastError: '' });
      } else if (act === 'test') {
        btn.disabled = true; btn.textContent = 'Đang thử…';
        const r = await testKey(id);
        toast((r.ok ? '✅ ' : '❌ ') + r.message, !r.ok);
        renderKeyList();
      }
    });
    $('#geminiKeyList').addEventListener('change', async (e) => {
      if (e.target.dataset.act !== 'toggle') return;
      await patchKey(e.target.closest('.scan-key-row').dataset.id, { enabled: e.target.checked });
    });

    // Thông số: lưu ngay khi đổi
    const saveParams = async () => {
      const st = await loadSettings();
      st.model = $('#geminiModel').value.trim() || DEFAULT_SETTINGS.model;
      st.timeoutSec = Math.max(10, parseInt($('#geminiTimeout').value, 10) || DEFAULT_SETTINGS.timeoutSec);
      st.maxWaitRounds = Math.max(0, parseInt($('#geminiMaxWait').value, 10) || 0);
      await saveSettings(st);
    };
    ['#geminiModel', '#geminiTimeout', '#geminiMaxWait'].forEach(sel => $(sel).addEventListener('change', saveParams));

    // Làm tươi trạng thái cooldown khi vòng xoay đổi key
    _onKeysChanged = () => {
      if (!$('#settingsModal').classList.contains('hidden') || !$('#scanModal').classList.contains('hidden')) renderKeyList();
    };
  }

  /* ---------------------------- 8. UI: MODAL QUÉT PHIẾU (SPRINT 1: THỬ 1 PHIẾU) ---------------------------- */
  const ui = { front: null, back: null, abort: null, objectUrls: [], lastResult: null };

  function dbgLog(msg, level) {
    const el = $('#scanLog');
    const t = new Date().toLocaleTimeString('vi-VN');
    const line = document.createElement('div');
    line.className = 'scan-log-' + (level || 'info');
    line.textContent = `[${t}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    $('#scanStatusText').textContent = msg;
  }

  function setPreview(which, file) {
    const box = $(which === 'front' ? '#scanPreviewFront' : '#scanPreviewBack');
    ui[which] = file || null;
    if (!file) { box.innerHTML = '<span class="hint">Chưa chọn</span>'; return; }
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      box.innerHTML = '<span class="hint">📄 ' + escapeHtml(file.name) + '</span>';
      return;
    }
    const url = URL.createObjectURL(file);
    ui.objectUrls.push(url);
    box.innerHTML = '<img alt="preview" src="' + url + '"><div class="hint">' + escapeHtml(file.name) + ' · ' + Math.round(file.size / 1024) + ' KB</div>';
  }

  function renderResult(res, savedId) {
    const x = res.extracted;
    const rows = (x.vehicles || []).map((v, i) => `
      <tr><td>${i + 1}</td><td><b>${escapeHtml(v.bienSo || '')}</b><div class="hint">chuẩn hóa: ${escapeHtml(normalizeBienSo(v.bienSo))}</div></td>
      <td>${escapeHtml(v.loaiXe || '')}</td>
      <td>${escapeHtml(TINH_TRANG_LABEL[v.tinhTrang] || v.tinhTrang || '')}<div class="hint">${escapeHtml(v.tinhTrangGhiTrenPhieu || '')}</div></td>
      <td>${escapeHtml(v.ghiChu || '')}</td></tr>`).join('');
    const m = res.meta;
    const tok = m.usage ? `${m.usage.promptTokenCount || 0} vào / ${m.usage.candidatesTokenCount || 0} ra` : '—';
    $('#scanResultView').innerHTML = `
      <div class="scan-kv">
        <div><span>Loại phiếu</span><b>${escapeHtml(x.loaiPhieu)}</b></div>
        <div><span>Chủ hộ</span><b>${escapeHtml(x.chuHo) || '—'}</b></div>
        <div><span>CCCD (chữ số)</span><b>${escapeHtml(x.cccd) || '—'}</b> <small>(${x.cccd.length} số)</small></div>
        <div><span>SĐT</span><b>${escapeHtml(x.sdt) || '—'}</b></div>
        <div><span>Mặt 2 có nội dung</span><b>${x.backHasContent ? 'Có' : 'Không'}</b></div>
        <div><span>Ghi chú tay</span><b>${escapeHtml(x.ghiChu) || '—'}</b></div>
      </div>
      ${x.truongKhongRo.length ? '<div class="error-text">⚠️ Chữ khó đọc, cần kiểm tra: ' + escapeHtml(x.truongKhongRo.join(', ')) + '</div>' : ''}
      <table class="scan-mini-table"><thead><tr><th>#</th><th>Biển số</th><th>Loại xe</th><th>Tình trạng</th><th>Ghi chú</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="hint">Không có xe nào được nhận diện</td></tr>'}</tbody></table>
      <div class="hint">Model: ${escapeHtml(m.model)} · Key: ${escapeHtml(m.keyLabel)} · ${m.ms} ms · token ${tok}${savedId ? ' · đã lưu DB: ' + savedId.slice(0, 8) : ''}</div>`;
    $('#scanJsonRaw').textContent = JSON.stringify(res.json, null, 2);
  }

  async function refreshScanCount() {
    try { $('#scanDbCount').textContent = (await dbCount(ST_SCANS)) + ' bản ghi scan trong DB'; }
    catch (e) { $('#scanDbCount').textContent = 'DB lỗi: ' + e.message; }
  }

  async function runTest() {
    if (!ui.front) { toast('Chọn ảnh/PDF mặt 1 trước.', true); return; }
    const btn = $('#btnScanRun'), cancel = $('#btnScanCancel');
    btn.disabled = true; cancel.classList.remove('hidden');
    ui.abort = new AbortController();
    $('#scanResultView').innerHTML = ''; $('#scanJsonRaw').textContent = '';
    try {
      const st = await loadSettings();
      dbgLog('Chuẩn bị ảnh (nén cạnh dài ≤ ' + st.maxEdgePx + 'px)…');
      const front = await prepareFile(ui.front, st.maxEdgePx);
      const back = ui.back ? await prepareFile(ui.back, st.maxEdgePx) : null;
      dbgLog(`Mặt 1: ${Math.round(front.original / 1024)}KB → ${Math.round(front.blob.size / 1024)}KB` + (back ? `; mặt 2: ${Math.round(back.original / 1024)}KB → ${Math.round(back.blob.size / 1024)}KB` : ''));
      const res = await analyzeSheet({ front, back, onStatus: dbgLog, signal: ui.abort.signal });
      dbgLog(`Xong: ${res.extracted.bienSo.length} xe nhận diện (${res.meta.ms}ms)`, 'ok');
      let savedId = null;
      if ($('#chkScanSave').checked) {
        savedId = uid();
        await dbPut(ST_SCANS, {
          id: savedId, timestamp: Date.now(), source: 'manual-test', isTest: true,
          frontBlob: front.blob, frontMime: front.mime,
          backBlob: back ? back.blob : null, backMime: back ? back.mime : null,
          frontHash: await sha256Hex(front.blob),
          backBlank: back ? !res.extracted.backHasContent : false,
          status: 'done', geminiRaw: res.geminiRaw, model: res.meta.model, keyLabel: res.meta.keyLabel,
          extracted: res.extracted, matchedBienSo: [],
        });
        dbgLog('Đã lưu vào IndexedDB (scans), id=' + savedId.slice(0, 8), 'ok');
        refreshScanCount();
      }
      ui.lastResult = res;
      renderResult(res, savedId);
    } catch (e) {
      const label = e.kind === 'cancelled' ? 'Đã hủy.' : 'LỖI [' + (e.kind || 'unknown') + ']: ' + e.message;
      dbgLog(label, e.kind === 'cancelled' ? 'warn' : 'error');
      if (e.raw) $('#scanJsonRaw').textContent = String(e.raw);
    } finally {
      btn.disabled = false; cancel.classList.add('hidden'); ui.abort = null;
      renderKeyList();
    }
  }

  function bindScanUI() {
    $('#btnScan').addEventListener('click', async () => {
      openModal('scanModal');
      renderKeyList();
      refreshScanCount();
    });
    $('#scanOpenSettings').addEventListener('click', () => {
      closeModal('scanModal');
      $('#btnSettings').click();
    });
    $('#scanFileFront').addEventListener('change', (e) => setPreview('front', e.target.files[0]));
    $('#scanFileBack').addEventListener('change', (e) => setPreview('back', e.target.files[0]));
    $('#btnScanClearBack').addEventListener('click', () => { $('#scanFileBack').value = ''; setPreview('back', null); });
    $('#btnScanRun').addEventListener('click', runTest);
    $('#btnScanCancel').addEventListener('click', () => { if (ui.abort) ui.abort.abort('user'); });
    $('#btnScanCopyJson').addEventListener('click', () => {
      const t = $('#scanJsonRaw').textContent;
      if (!t) return;
      navigator.clipboard.writeText(t).then(() => toast('Đã copy JSON.'), () => toast('Không copy được.', true));
    });
    $('#btnScanClearLog').addEventListener('click', () => { $('#scanLog').innerHTML = ''; });
    $('#btnScanDeleteTests').addEventListener('click', async () => {
      if (!confirm('Xóa tất cả bản ghi scan thử (isTest) trong DB?')) return;
      const all = await dbGetAll(ST_SCANS);
      for (const s of all) if (s.isTest) await dbDelete(ST_SCANS, s.id);
      toast('Đã xóa dữ liệu thử.'); refreshScanCount();
    });
    setPreview('front', null); setPreview('back', null);
  }

  /* ---------------------------- 9. KHỞI TẠO ---------------------------- */
  function init() {
    bindSettingsUI();
    bindScanUI();
    renderKeyList();
    // Xin trình duyệt giữ dữ liệu bền vững (tránh bị dọn khi đầy ổ đĩa) — ảnh scan là dữ liệu quan trọng.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  init();

  // API công khai cho Sprint 2+ (hàng đợi batch, đối sánh...)
  return {
    db: { openDb, dbGetAll, dbGet, dbPut, dbDelete, dbCount, ST_SCANS, ST_KEYS },
    keys: { listKeys, addKey, patchKey, removeKey, testKey },
    settings: { loadSettings, saveSettings },
    prepareFile, analyzeSheet, geminiGenerate, normalizeBienSo, normalizeCccd, sha256Hex, uid,
    TINH_TRANG_LABEL,
  };
})();
