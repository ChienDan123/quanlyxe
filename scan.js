/* =========================================================================
   QUÉT PHIẾU HÀNG LOẠT — scan.js  (SPRINT 1)
   Nạp SAU app.js (dùng lại các hàm toàn cục: $, $all, toast, openModal,
   closeModal, escapeHtml).

   Sprint 1 gồm:
     1. Schema IndexedDB riêng cho module quét (scans / apiKeys / settings).
     2. Quản lý nhiều API key Gemini (thêm/xóa/bật-tắt/kiểm tra) trong Cài đặt.
     3. Hàm gọi Gemini có XOAY KEY + XOAY MODEL (fallback) + cooldown + chờ quota + phân loại lỗi
        (503 = model quá tải -> cooldown MODEL 30–90s, không phạt key; 429 -> cooldown theo cặp key×model).
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
  const DB_VERSION = 2; // v2: thêm store scanItems + plateLinks (màn so sánh & xác nhận)
  const ST_SCANS = 'scans';       // 1 record / 1 tờ vật lý
  const ST_KEYS = 'apiKeys';      // danh sách key Gemini
  const ST_SETTINGS = 'settings'; // cấu hình module (model, timeout...)
  const ST_ITEMS = 'scanItems';   // v2: 1 mục so sánh / 1 xe trên 1 phiếu (KHÔNG chứa ảnh) — do scan-review.js quản lý
  const ST_LINKS = 'plateLinks';  // v2: biển số -> danh sách phiếu + trạng thái Đã kiểm/Chưa kiểm

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
                errorCount, cooldownUntil, quotaCooldowns:{[model]:{until,count}}, lastError, createdAt }
     settings: { name:'main', model, fallbackModels[], timeoutSec, maxWaitRounds, maxEdgePx, settingsVer } */
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
        // Nâng cấp v1 -> v2: chỉ THÊM store mới, giữ nguyên toàn bộ ảnh/phiếu đã quét.
        if (!db.objectStoreNames.contains(ST_ITEMS)) {
          const si = db.createObjectStore(ST_ITEMS, { keyPath: 'id' });
          si.createIndex('bienSo', 'bienSo');
          si.createIndex('scanId', 'scanId');
        }
        if (!db.objectStoreNames.contains(ST_LINKS)) db.createObjectStore(ST_LINKS, { keyPath: 'bienSo' });
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
  // Nhường luồng giao diện: các vòng lặp dài (áp dụng hàng trăm mục) gọi hàm này
  // định kỳ để trang vẫn mượt, người dùng làm việc khác được (chạy ngầm).
  const yieldToUi = () => new Promise(r => (window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 50 }) : setTimeout(r, 0)));
  // Bus sự kiện nhỏ: scan-review.js đăng ký 'sheetDone' / 'queueFinished'.
  // Handler chạy KHÔNG chờ (fire-and-forget) và lỗi của handler không làm hỏng hàng đợi quét.
  const _handlers = {};
  const on = (evt, fn) => { (_handlers[evt] = _handlers[evt] || []).push(fn); };
  const emit = (evt, data) => (_handlers[evt] || []).forEach(fn => {
    try { Promise.resolve(fn(data)).catch(e => console.warn('[scan] handler ' + evt, e)); } catch (e) { console.warn('[scan] handler ' + evt, e); }
  });

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

  /* ---- XỬ LÝ ẢNH / PDF TRƯỚC KHI GỬI GEMINI ----
     NGUYÊN NHÂN LỖI 400 "Request contains an invalid argument" (Sprint 1):
     file PDF ~120MB bị gửi NGUYÊN VẸN (nhánh PDF cũ không nén) dưới dạng base64
     inline (~160MB). Gemini giới hạn toàn bộ request inline ~20MB nên từ chối.
     Cách sửa: KHÔNG bao giờ gửi PDF thô. PDF được render từng trang -> ảnh JPEG
     (pdf.js chạy ngay trên trình duyệt), mỗi ảnh nén <= ~3,5MB. Có thêm chốt chặn
     dung lượng request trước khi gửi (xem analyzeSheet). */
  const MAX_IMG_BYTES = 3.5 * 1024 * 1024;     // trần dung lượng mỗi ảnh sau nén
  const MAX_REQUEST_B64 = 18 * 1024 * 1024;    // trần tổng base64 của 1 request (Gemini ~20MB)

  const canvasToBlob = (canvas, q) => new Promise(res => canvas.toBlob(res, 'image/jpeg', q));

  // Canvas -> JPEG đã nén. Nếu vẫn quá nặng: hạ chất lượng, rồi thu nhỏ 20% và thử lại.
  async function canvasToPrepared(canvas, name, originalSize) {
    let c = canvas, q = 0.85, blob = await canvasToBlob(c, q), guard = 0;
    while (blob && blob.size > MAX_IMG_BYTES && guard++ < 8) {
      if (q > 0.55) q -= 0.1;
      else {
        const small = document.createElement('canvas');
        small.width = Math.max(200, Math.round(c.width * 0.8));
        small.height = Math.max(200, Math.round(c.height * 0.8));
        small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
        if (c !== canvas) { c.width = c.height = 0; }
        c = small;
      }
      blob = await canvasToBlob(c, q);
    }
    if (!blob) throw new Error('Không nén được ảnh (canvas.toBlob trả về rỗng)');
    const out = { blob, mime: 'image/jpeg', base64: await blobToBase64(blob), name, original: originalSize || blob.size, w: c.width, h: c.height };
    if (c !== canvas) c.width = c.height = 0;
    return out;
  }

  const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const isImageFile = (f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);

  // Nén 1 file ảnh: giảm cạnh dài về <= maxEdge, xuất JPEG.
  async function prepareImageFile(file, maxEdge) {
    if (!isImageFile(file)) throw new Error(`Định dạng "${file.type || file.name}" chưa hỗ trợ (dùng JPG/PNG/WebP/PDF).`);
    let bmp;
    // imageOrientation:'from-image' = áp EXIF (ảnh chụp bằng điện thoại xoay ngang/dọc). Trình duyệt cũ không hiểu tùy chọn -> thử lại không tham số.
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e1) {
      try { bmp = await createImageBitmap(file); }
      catch (e) { throw new Error('Không đọc được ảnh "' + file.name + '" (file hỏng hoặc quá lớn): ' + e.message); }
    }
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // nền trắng cho PNG trong suốt
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    const out = await canvasToPrepared(canvas, file.name, file.size);
    canvas.width = canvas.height = 0;
    return out;
  }

  /* ---- pdf.js (nạp theo yêu cầu từ CDN, chỉ khi người dùng upload PDF) ---- */
  const PDFJS_VER = '3.11.174';
  const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/`;
  let _pdfjsPromise = null;
  function loadPdfJs() {
    if (_pdfjsPromise) return _pdfjsPromise;
    _pdfjsPromise = new Promise((resolve, reject) => {
      if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
      const sc = document.createElement('script');
      sc.src = PDFJS_BASE + 'pdf.min.js';
      sc.onload = async () => {
        try {
          // Worker nằm khác origin (CDN) nên trình duyệt chặn nếu trỏ thẳng URL ->
          // tải mã worker về, đóng vào Blob cùng origin rồi mới đưa cho pdf.js.
          const code = await (await fetch(PDFJS_BASE + 'pdf.worker.min.js')).text();
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          resolve(window.pdfjsLib);
        } catch (e) { reject(new Error('Không nạp được worker pdf.js: ' + e.message)); }
      };
      sc.onerror = () => { _pdfjsPromise = null; reject(new Error('Không tải được pdf.js từ CDN (kiểm tra mạng).')); };
      document.head.appendChild(sc);
    });
    return _pdfjsPromise;
  }
  async function openPdf(file) {
    const lib = await loadPdfJs();
    const buf = await file.arrayBuffer(); // file lớn (100MB+) vẫn đọc được, chỉ tốn RAM tạm thời
    return lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  }
  // Render 1 trang PDF -> ảnh JPEG nén. Chỉ render khi tới lượt tờ đó (tiết kiệm RAM).
  async function renderPdfPage(doc, pageNo, maxEdge, name) {
    const page = await doc.getPage(pageNo);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(4, maxEdge / Math.max(vp1.width, vp1.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
    page.cleanup();
    const out = await canvasToPrepared(canvas, `${name} (tr.${pageNo})`, 0);
    canvas.width = canvas.height = 0;
    return out;
  }

  /* ---------------------------- 3. CÀI ĐẶT MODULE ---------------------------- */
  // Model mặc định + danh sách dự phòng (thử lần lượt khi model trước bị 503 quá tải / 429 hết quota / 404 không tồn tại)
  const DEFAULT_MODEL = 'gemini-3.8-flash';
  const DEFAULT_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
  const OLD_DEFAULT_MODEL = 'gemini-2.5-flash';   // mặc định cũ -> tự nâng lên mặc định mới (xem loadSettings)
  const SETTINGS_VER = 2;                         // v2: thêm fallbackModels + đổi model mặc định

  const DEFAULT_SETTINGS = {
    name: 'main',
    model: DEFAULT_MODEL,                      // model CHÍNH — sửa được trong Cài đặt (tên model Gemini thay đổi theo thời gian)
    fallbackModels: [...DEFAULT_FALLBACK_MODELS], // model DỰ PHÒNG theo thứ tự ưu tiên — sửa được trong Cài đặt
    timeoutSec: 90,
    maxWaitRounds: 4,          // số lần chờ khi MỌI (model × key) đang cooldown, rồi mới báo lỗi
    maxEdgePx: 2000,
    pagesPerSheet: 2,          // 2 = mỗi tờ gồm 2 trang/ảnh liên tiếp (mặt trước + sau); 1 = mỗi trang là 1 tờ
    skipDuplicates: true,      // bỏ qua tờ đã quét (trùng hash ảnh mặt 1)
  };

  // Chuẩn hóa tên model: bỏ tiền tố "models/", chỉ giữ ký tự hợp lệ, bỏ trùng. Nhận mảng hoặc chuỗi "a, b, c".
  function normalizeModelList(v) {
    const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;\n\s]+/);
    const out = [];
    for (let m of arr) {
      m = String(m || '').trim().replace(/^models\//i, '');
      if (m && /^[A-Za-z0-9._-]+$/.test(m) && !out.includes(m)) out.push(m);
    }
    return out;
  }
  // Chuỗi model sẽ thử: model chính rồi tới các model dự phòng (không trùng)
  const modelChain = (st) => normalizeModelList([st.model || DEFAULT_MODEL, ...(st.fallbackModels || [])]);
  let _chainCache = [];   // chuỗi model gần nhất (để chip trạng thái key biết đang xét model nào)

  async function loadSettings() {
    let stored = {};
    try { stored = (await dbGet(ST_SETTINGS, 'main')) || {}; } catch (e) { return { ...DEFAULT_SETTINGS, fallbackModels: [...DEFAULT_FALLBACK_MODELS] }; }
    const st = { ...DEFAULT_SETTINGS, ...stored };
    // Migrate 1 lần: người dùng cũ đang lưu 'gemini-2.5-flash' (mặc định cũ) -> đổi sang mặc định mới.
    // Model do người dùng TỰ ĐẶT khác mặc định cũ thì giữ nguyên.
    if ((stored.settingsVer || 0) < SETTINGS_VER) {
      if (!stored.model || stored.model === OLD_DEFAULT_MODEL) st.model = DEFAULT_MODEL;
      if (!Array.isArray(stored.fallbackModels)) st.fallbackModels = [...DEFAULT_FALLBACK_MODELS];
      st.settingsVer = SETTINGS_VER;
      try { await dbPut(ST_SETTINGS, { ...st, name: 'main' }); } catch (e) { /* bỏ qua, lần sau migrate lại */ }
    }
    st.model = normalizeModelList(st.model)[0] || DEFAULT_MODEL;
    st.fallbackModels = normalizeModelList(st.fallbackModels);
    _chainCache = modelChain(st);
    return st;
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
  //  'quota'     429 hết quota          -> cooldown theo cặp key×model (lũy thừa), thử key/model khác
  //  'invalid'   key sai / bị khóa      -> loại key khỏi vòng, báo đỏ
  //  'overload'  503 (high demand) và 500/502/504 -> cooldown MODEL 30–90s, KHÔNG phạt key, chuyển model dự phòng
  //  'nomodel'   404 model không tồn tại/không hỗ trợ -> bỏ qua model này, thử model kế (không phải lỗi vĩnh viễn của cả yêu cầu)
  //  'transient' mạng / timeout / 5xx lạ -> cooldown ngắn theo key, thử key khác
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
    if (status === 404) return new GeminiError('nomodel', `Model không tồn tại hoặc không hỗ trợ (404): ${msg}`);
    if (status === 400) return new GeminiError('fatal', `Yêu cầu bị từ chối (400): ${msg}`);
    // 503 "high demand" là lỗi TẠM THỜI của model, không liên quan key -> kind riêng 'overload'
    if (status === 503 || status === 500 || status === 502 || status === 504 || errStatus === 'UNAVAILABLE')
      return new GeminiError('overload', `Lỗi máy chủ Gemini (${status}): ${msg}`, { httpStatus: status });
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

  /* ---- TRẠNG THÁI MODEL (trong bộ nhớ, mất khi tải lại trang — cooldown chỉ 30–90s nên không cần lưu) ----
     _modelState: model -> { until, overloadCount, dead }
       - until > now && !dead : model đang nghỉ do 503 (cooldown ngắn 30s -> 60s -> 90s theo số lần liên tiếp)
       - dead                 : model báo 404 (không tồn tại/không hỗ trợ) -> bỏ qua ~30 phút để khỏi gọi lại vô ích */
  const OVERLOAD_COOLDOWN_SEC = [30, 60, 90];
  const MODEL_DEAD_MS = 30 * 60000;
  const _modelState = new Map();
  let _lastUsed = null;    // { model, keyLabel, fallback, at } — lần gọi thành công gần nhất (hiển thị trong Cài đặt)

  const isModelDead = (m, now = Date.now()) => { const s = _modelState.get(m); return !!(s && s.dead && s.until > now); };
  const modelCoolUntil = (m, now = Date.now()) => { const s = _modelState.get(m); return s && !s.dead && s.until > now ? s.until : 0; };
  function markModelOverload(m) {
    const n = ((_modelState.get(m) || {}).overloadCount || 0) + 1;
    const sec = OVERLOAD_COOLDOWN_SEC[Math.min(n - 1, OVERLOAD_COOLDOWN_SEC.length - 1)];
    _modelState.set(m, { overloadCount: n, until: Date.now() + sec * 1000, dead: false });
    return sec;
  }
  const markModelDead = (m) => _modelState.set(m, { overloadCount: 0, until: Date.now() + MODEL_DEAD_MS, dead: true });
  const markModelOk = (m) => _modelState.delete(m);
  function resetModelState() { _modelState.clear(); notifyKeysChanged(); }

  // Cooldown quota (429) của 1 key trên 1 model cụ thể — lưu trong record key để bền qua tải lại trang
  const quotaUntil = (k, m, now = Date.now()) => { const q = k.quotaCooldowns && k.quotaCooldowns[m]; return q && q.until > now ? q.until : 0; };
  const hasQuotaCooldown = (k) => Object.keys(k.quotaCooldowns || {}).some(m => quotaUntil(k, m) > 0);
  // Số giây key bị chặn trên MỌI model của chuỗi hiện tại (0 = vẫn còn model dùng được)
  function keyQuotaBlockedSec(k, now = Date.now()) {
    if (!_chainCache.length) return 0;
    let min = Infinity;
    for (const m of _chainCache) { const u = quotaUntil(k, m, now); if (!u) return 0; min = Math.min(min, u - now); }
    return Math.ceil(min / 1000);
  }

  // Ghi kết quả của 1 lần gọi (key × model) vào record key (cooldown / loại key / reset lỗi).
  async function recordKeyResult(keyRec, err, model) {
    const cur = (await dbGet(ST_KEYS, keyRec.id)) || keyRec;
    const qc = { ...(cur.quotaCooldowns || {}) };
    if (!err) {
      if (model) delete qc[model];   // gọi được -> hết phạt quota của cặp này
      await patchKey(keyRec.id, { lastUsed: Date.now(), errorCount: 0, cooldownUntil: 0, lastError: '', status: 'ok', quotaCooldowns: qc });
      return;
    }
    const n = (keyRec.errorCount || 0) + 1;
    if (err.kind === 'invalid') {
      await patchKey(keyRec.id, { status: 'invalid', errorCount: n, lastError: err.message, lastUsed: Date.now() });
    } else if (err.kind === 'quota') {
      // 429: quota tính THEO MODEL -> chỉ cooldown cặp key×model này (model khác của key vẫn dùng được).
      // Lũy thừa: 60s, 120s, 240s... tối đa 15 phút; nếu Gemini gợi ý retryDelay dài hơn thì lấy giá trị đó.
      const c = ((qc[model] || {}).count || 0) + 1;
      const backoff = Math.min(60000 * Math.pow(2, c - 1), 15 * 60000);
      const wait = Math.max(backoff, (err.retrySec || 0) * 1000);
      if (model) qc[model] = { until: Date.now() + wait, count: c };
      await patchKey(keyRec.id, { quotaCooldowns: qc, lastError: err.message, lastUsed: Date.now() });
    } else if (err.kind === 'transient') {
      const wait = Math.min(15000 * Math.pow(2, Math.min(n - 1, 3)), 5 * 60000); // 15s..2 phút
      await patchKey(keyRec.id, { errorCount: n, cooldownUntil: Date.now() + wait, lastError: err.message, lastUsed: Date.now() });
    }
    // overload (503) / nomodel (404): lỗi của MODEL, KHÔNG phạt key (cooldown nằm ở _modelState).
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

  /* XOAY MODEL + KEY — thuật toán:
     1. Chuỗi model = [model chính, ...model dự phòng]. Lấy các key: bật + chưa 'invalid'. Không có key -> lỗi NO_KEY.
     2. Duyệt model THEO THỨ TỰ ƯU TIÊN; với mỗi model bỏ qua nếu đang cooldown (503) hoặc 'dead' (404).
        Trong model đó chọn key không cooldown (cả cooldown key lẫn quota 429 của cặp key×model),
        dùng lâu nhất (lastUsed nhỏ nhất) => xoay vòng đều các key, luôn ưu tiên model chính.
     3. Gọi. Kết quả lỗi:
          503/5xx  -> cooldown MODEL 30/60/90s (không phạt key) -> vòng sau tự chọn model dự phòng,
                      hết cooldown thì model chính được thử lại.
          429      -> cooldown cặp key×model -> thử key khác của model đó, hoặc model kế.
          404      -> model bị bỏ qua ~30 phút -> thử model kế.
          401/403  -> loại key. 400 / blocked / parse -> dừng ngay (lỗi do yêu cầu).
     4. Nếu MỌI (model × key) đều đang cooldown -> chờ tới lúc sớm nhất hồi (tối thiểu 5s),
        báo UI "Đang chờ…", tối đa maxWaitRounds lần rồi mới bỏ cuộc (kind 'quota' -> hàng đợi tạm dừng).
        Nếu MỌI model đều 'dead' (sai tên) -> dừng với kind 'nomodel'.
     Chạy TUẦN TỰ (mỗi lần 1 request) theo đúng yêu cầu, không song song. */
  async function geminiGenerate({ parts, schema, onStatus, signal, systemInstruction }) {
    const st = await loadSettings();
    const chain = modelChain(st);
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
      const alive = chain.filter(m => !isModelDead(m, now));
      if (!alive.length) throw new GeminiError('nomodel', `Không model nào dùng được (đều báo không tồn tại/không hỗ trợ): ${chain.join(', ')}. Kiểm tra lại tên model trong ⚙️ Cài đặt.`);

      // Chọn cặp (model, key): model ưu tiên cao nhất đang sẵn sàng + key rảnh lâu nhất
      let pick = null;
      for (const model of alive) {
        if (modelCoolUntil(model, now)) continue;
        const key = usable
          .filter(k => (k.cooldownUntil || 0) <= now && !quotaUntil(k, model, now))
          .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))[0];
        if (key) { pick = { model, key }; break; }
      }

      if (!pick) {
        // Mọi (model × key) đều đang nghỉ -> chờ cặp sớm hồi nhất
        if (waitRound >= st.maxWaitRounds) throw new GeminiError('quota', `Mọi model/key đều đang quá tải hoặc hết quota sau ${waitRound} lần chờ.`);
        const times = [];
        for (const m of alive) for (const k of usable) times.push(Math.max(modelCoolUntil(m, now), k.cooldownUntil || 0, quotaUntil(k, m, now)));
        const wait = Math.max(5000, Math.min(...times) - now);
        waitRound++;
        await waitWithCountdown(wait, (s) => say(`Các model đang quá tải/hết quota… thử lại sau ${s}s (lần chờ ${waitRound}/${st.maxWaitRounds})`, 'warn'), signal);
        continue;
      }

      const { model, key } = pick, isFallback = model !== chain[0];
      say(`Gọi ${model}${isFallback ? ' (dự phòng)' : ''} bằng "${key.label}"…`, isFallback ? 'warn' : 'info');
      const t0 = performance.now();
      try {
        const data = await requestOnce(key, model, body, st.timeoutSec * 1000, signal);
        const cand = data.candidates && data.candidates[0];
        const block = data.promptFeedback && data.promptFeedback.blockReason;
        if (block) throw new GeminiError('blocked', `Gemini chặn nội dung: ${block}`);
        const txt = cand && cand.content && cand.content.parts
          ? cand.content.parts.map(p => p.text || '').join('') : '';
        if (!txt.trim()) throw new GeminiError('parse', `Gemini trả rỗng (finishReason=${cand && cand.finishReason})`);
        await recordKeyResult(key, null, model);
        markModelOk(model);   // gọi được -> reset đếm quá tải của model
        _lastUsed = { model, keyLabel: key.label, fallback: isFallback, at: Date.now() };
        return {
          text: txt, usage: data.usageMetadata || null, finishReason: cand && cand.finishReason,
          model, primaryModel: chain[0], fallbackUsed: isFallback,   // model THỰC SỰ trả lời (lưu vào phiếu)
          keyId: key.id, keyLabel: key.label, ms: Math.round(performance.now() - t0),
        };
      } catch (e) {
        if (!(e instanceof GeminiError)) throw e;
        await recordKeyResult(key, e, model);
        if (e.kind === 'cancelled' || e.kind === 'fatal' || e.kind === 'blocked' || e.kind === 'parse') throw e;
        if (e.kind === 'invalid') say(`Key "${key.label}" KHÔNG HỢP LỆ — đã loại khỏi vòng. ${e.message}`, 'error');
        else if (e.kind === 'overload') {
          const sec = markModelOverload(model);   // 503: nghỉ MODEL, key vẫn tốt
          say(`${model} quá tải (${e.httpStatus || 503}) → nghỉ ${sec}s, thử model/key khác. ${e.message}`, 'warn');
        } else if (e.kind === 'nomodel') {
          markModelDead(model);
          say(`Model "${model}" không tồn tại/không hỗ trợ → bỏ qua, thử model kế. ${e.message}`, 'error');
        } else if (e.kind === 'quota') say(`Key "${key.label}" hết quota ở ${model} → thử key/model khác`, 'warn');
        else say(`Key "${key.label}": ${e.message} → đổi key`, 'warn');
        notifyKeysChanged();
        // overload / nomodel / quota / transient / invalid: quay lại đầu vòng, chọn cặp (model, key) kế
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
            tenDKX: { type: S },            // «Tên trong ĐKX» của dòng xe = CHỦ PHƯƠNG TIỆN
            nguoiMuaSuDung: { type: S },    // dòng «Tên người mua / người sử dụng» của dòng xe
            // Khung chữ nhật bao khối thông tin của xe trên MẶT 1, chuẩn hóa 0–1000 (gốc trên-trái) — màn So sánh dùng để bấm ảnh ↔ xe
            vungY0: { type: 'INTEGER' }, vungX0: { type: 'INTEGER' }, vungY1: { type: 'INTEGER' }, vungX1: { type: 'INTEGER' },
          },
          required: ['bienSo', 'tinhTrang', 'vungY0', 'vungX0', 'vungY1', 'vungX1'],
        },
      },
      chuHo: { type: S },
      cccd: { type: S },
      sdt: { type: S },
      ghiChuTay: { type: S },
      backHasContent: { type: 'BOOLEAN' },
      backNote: { type: S },
      truongKhongRo: { type: 'ARRAY', items: { type: S } },
      huongMat1: { type: 'INTEGER' },   // độ xoay THUẬN chiều kim đồng hồ cần để MẶT 1 đứng thẳng: 0 | 90 | 180 | 270
      huongMat2: { type: 'INTEGER' },   // như trên cho MẶT 2 (không có mặt 2 -> 0)
    },
    required: ['loaiPhieu', 'danhSachXe', 'chuHo', 'cccd', 'sdt', 'ghiChuTay', 'backHasContent', 'huongMat1', 'huongMat2'],
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
   - tenDKX: họ tên ghi ở ô «Tên trong ĐKX» của DÒNG XE đó (đây là CHỦ PHƯƠNG TIỆN thật sự). Dòng xe không ghi tên thì "" — TUYỆT ĐỐI không tự điền tên chủ hộ vào.
   - nguoiMuaSuDung: họ tên ghi ở dòng «Tên người mua / người sử dụng» ngay dưới của xe đó (người đang sử dụng / mua xe hiện tại). Không ghi thì "".
3. chuHo: họ tên CHỦ PHIẾU / chủ hộ ở phần đầu phiếu (người khai). Người này có thể KHÔNG phải chủ xe — chủ xe của từng xe là tenDKX. Giữ nguyên dấu tiếng Việt.
4. cccd: số CCCD/CMND/MST, CHỈ gồm chữ số đúng như trên phiếu. Nếu thiếu số hoặc mờ, chép phần đọc được — KHÔNG tự thêm số.
5. sdt: số điện thoại, chỉ chữ số.
6. ghiChuTay: toàn bộ chữ viết tay/ghi chú thêm không thuộc ô in sẵn. Không có thì "".
7. truongKhongRo: liệt kê tên trường (VD "cccd", "bienSo xe 2") mà chữ mờ/khó đọc, để con người kiểm tra lại.
8. TUYỆT ĐỐI không bịa dữ liệu. Chỗ không có/không đọc được -> chuỗi rỗng.
10. HƯỚNG ẢNH: huongMat1${hasBack ? ' / huongMat2' : ''} = số độ cần xoay ảnh THEO CHIỀU KIM ĐỒNG HỒ để chữ in đứng thẳng, đọc xuôi từ trái sang phải: 0 (ảnh đã đúng chiều), 90 (đầu phiếu đang nằm bên TRÁI ảnh), 180 (ảnh bị lộn ngược), 270 (đầu phiếu đang nằm bên PHẢI ảnh). Ảnh gần như trắng/không có chữ -> 0.${hasBack ? '' : ' Đặt huongMat2 = 0.'}
11. VÙNG XE: với mỗi xe, vungY0, vungX0, vungY1, vungX1 là khung chữ nhật bao TOÀN BỘ khối thông tin của xe đó trên MẶT 1 (dòng biển số, tình trạng, tên trong ĐKX, tên người mua / sử dụng). Tọa độ chuẩn hóa 0–1000 so với cả ảnh MẶT 1, gốc ở góc TRÊN-TRÁI (Y = chiều dọc, X = chiều ngang, Y0<Y1, X0<X1), tính theo ảnh đúng như được gửi. Các xe khác nhau phải có khung khác nhau, không chồng lên nhau.
${hasBack
  ? `9. Có 2 ảnh: MẶT 1 (thông tin chính) và MẶT 2. backHasContent = true nếu mặt 2 có chữ/chữ ký/dấu/ghi chú đáng kể; = false nếu trống hoặc gần như trắng. Nếu true, tóm tắt ngắn vào backNote (VD "có chữ ký người kê khai"). Thông tin xe/chủ hộ vẫn lấy chủ yếu từ mặt 1.`
  : `9. Chỉ có 1 ảnh (mặt 1). Đặt backHasContent = false.`}`;
  }

  // Dựng parts cho request từ ảnh đã chuẩn bị (prepareImageFile / renderPdfPage)
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

  /* ---- TỰ XOAY ẢNH CHO ĐÚNG CHIỀU ----
     Gemini báo huongMat1/huongMat2 (0/90/180/270 độ thuận chiều kim đồng hồ). Nếu có mặt nào lệch: xoay ảnh bằng canvas rồi ĐỌC LẠI 1 lần
     (để chữ + tọa độ vùng xe tính trên ảnh đã đúng chiều). Ảnh đúng chiều -> chỉ 1 lần gọi như cũ. EXIF đã được áp ở prepareImageFile. */
  const normDeg = (n) => { n = Math.round(Number(n) || 0); n = ((n % 360) + 360) % 360; return [0, 90, 180, 270].includes(n) ? n : (Math.round(n / 90) * 90) % 360; };
  async function rotatePrepared(page, deg) {
    const bmp = await createImageBitmap(page.blob);
    const w0 = bmp.width, h0 = bmp.height, swap = deg === 90 || deg === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? h0 : w0; canvas.height = swap ? w0 : h0;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (deg === 90) ctx.translate(h0, 0); else if (deg === 180) ctx.translate(w0, h0); else if (deg === 270) ctx.translate(0, w0);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const out = await canvasToPrepared(canvas, page.name, page.original);
    canvas.width = canvas.height = 0;
    return out;
  }
  const stripRegions = (j) => { (j.danhSachXe || []).forEach(v => { delete v.vungY0; delete v.vungX0; delete v.vungY1; delete v.vungX1; }); };

  async function analyzeOnce(front, back, onStatus, signal) {
    const total = front.base64.length + (back ? back.base64.length : 0);
    if (total > MAX_REQUEST_B64) {
      throw new GeminiError('fatal', `Dung lượng ảnh quá lớn (${(total / 1048576).toFixed(1)}MB > 18MB) dù đã nén.`);
    }
    const r = await geminiGenerate({ parts: buildParts(front, back), schema: SCAN_SCHEMA, onStatus, signal });
    const json = parseJsonLoose(r.text);
    return { json, extracted: toExtracted(json), geminiRaw: r.text, meta: r };
  }

  // Phân tích 1 tờ: trả { extracted, geminiRaw, meta, front, back, rotated:{front,back} } — front/back là ảnh ĐÃ xoay đúng chiều (dùng để lưu).
  async function analyzeSheet({ front, back, onStatus, signal }) {
    const say = onStatus || (() => {});
    let res = await analyzeOnce(front, back, onStatus, signal);
    let f = front, b = back, rotated = { front: 0, back: 0 };
    const dF = normDeg(res.json.huongMat1), dB = back ? normDeg(res.json.huongMat2) : 0;
    if (dF || dB) {
      say(`  ↻ Ảnh lệch chiều (mặt 1: ${dF}°, mặt 2: ${dB}°) → tự xoay rồi đọc lại…`, 'warn');
      try {
        if (dF) f = await rotatePrepared(front, dF);
        if (dB) b = await rotatePrepared(back, dB);
        rotated = { front: dF, back: dB };
      } catch (e) { say('  Không xoay được ảnh: ' + (e.message || e), 'warn'); f = front; b = back; }
      if (f !== front || b !== back) {
        try {
          res = await analyzeOnce(f, b, onStatus, signal);
          if (normDeg(res.json.huongMat1) || (b && normDeg(res.json.huongMat2))) say('  ⚠ Sau khi xoay máy vẫn thấy ảnh lệch — hãy kiểm tra lại ảnh.', 'warn');
        } catch (e) {
          if (['cancelled', 'quota', 'nokey', 'nomodel'].includes(e && e.kind)) throw e;   // lỗi hạ tầng: để hàng đợi tạm dừng như thường
          say('  Đọc lại sau khi xoay bị lỗi (' + (e.message || e) + ') → dùng kết quả lần 1, bỏ vùng xe.', 'warn');
          stripRegions(res.json); res.extracted = toExtracted(res.json);   // tọa độ lần 1 thuộc ảnh chưa xoay → không dùng
        }
      }
    }
    return { ...res, front: f, back: b, rotated };
  }

  // Kiểm tra 1 key còn sống không (gọi 1 câu ngắn, không schema) — thử trên model CHÍNH
  async function testKey(id) {
    const k = await dbGet(ST_KEYS, id);
    if (!k) throw new Error('Không tìm thấy key');
    const st = await loadSettings();
    try {
      await requestOnce(k, st.model, { contents: [{ role: 'user', parts: [{ text: 'Trả lời đúng 1 từ: OK' }] }] }, 30000);
      await recordKeyResult(k, null, st.model);
      return { ok: true, message: 'Key hoạt động tốt (' + st.model + ')' };
    } catch (e) {
      if (e instanceof GeminiError) await recordKeyResult(k, e, st.model);
      // 503/404 là lỗi của MODEL: Google đã chấp nhận key nên không báo "key hỏng"
      if (e.kind === 'overload') return { ok: true, message: `Key không bị từ chối, nhưng ${st.model} đang quá tải (${e.httpStatus || 503}) — khi quét hệ thống tự chuyển model dự phòng.`, kind: e.kind };
      if (e.kind === 'nomodel') return { ok: false, message: `Key không bị từ chối, nhưng model "${st.model}" không tồn tại/không hỗ trợ — sửa tên model trong Cài đặt.`, kind: e.kind };
      return { ok: false, message: e.message, kind: e.kind };
    }
  }

  /* ---------------------------- 7. UI: CÀI ĐẶT (KEY + THÔNG SỐ) ---------------------------- */
  const maskKey = (k) => k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-4) : '••••';

  function keyStatusChip(k) {
    const now = Date.now();
    if (k.status === 'invalid') return '<span class="scan-chip scan-chip-err" title="' + escapeHtml(k.lastError) + '">❌ Không hợp lệ</span>';
    if (!k.enabled) return '<span class="scan-chip scan-chip-off">⏸ Tắt</span>';
    const qs = keyQuotaBlockedSec(k, now);   // hết quota (429) trên mọi model trong chuỗi
    if (qs) return '<span class="scan-chip scan-chip-warn" title="' + escapeHtml(k.lastError) + '">⏳ Hết quota mọi model ' + (qs >= 60 ? Math.ceil(qs / 60) + ' phút' : qs + 's') + '</span>';
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
            ${k.status === 'invalid' || k.cooldownUntil > Date.now() || hasQuotaCooldown(k) ? '<button type="button" class="btn btn-ghost btn-sm" data-act="reset" title="Xóa cooldown / trạng thái lỗi">↺ Reset</button>' : ''}
            <button type="button" class="btn btn-ghost btn-sm" data-act="del">🗑️</button>
          </span>
        </div>`).join('');
    }
    updateScanKeySummary(keys);
    renderModelStatus(keys);
  }

  function updateScanKeySummary(keys) {
    const el = $('#scanKeySummary');
    if (!el) return;
    const now = Date.now();
    const ok = keys.filter(k => k.enabled && k.status !== 'invalid' && (k.cooldownUntil || 0) <= now && !keyQuotaBlockedSec(k, now)).length;
    const usable = keys.filter(k => k.enabled && k.status !== 'invalid').length;
    el.textContent = keys.length
      ? `Gemini: ${ok} key sẵn sàng / ${usable} đang bật / ${keys.length} tổng`
      : 'Gemini: chưa có key — mở ⚙️ Cài đặt để thêm';
    el.className = 'badge ' + (ok ? 'scan-badge-ok' : 'scan-badge-bad');
  }

  /* ---- Khối UI Model dự phòng + bảng trạng thái ----
     Nếu index.html chưa có #geminiFallback / #geminiModelStatus thì tự chèn ngay dưới ô #geminiModel
     (không cần sửa HTML). Muốn tự bố trí: thêm sẵn 2 phần tử có id đó vào index.html, code sẽ dùng lại. */
  function ensureModelUi() {
    const modelEl = $('#geminiModel');
    if (!modelEl || $('#geminiModelExtra')) return;
    const wrap = document.createElement('div');
    wrap.id = 'geminiModelExtra';
    wrap.style.cssText = 'flex-basis:100%;grid-column:1/-1;width:100%;margin:8px 0';
    wrap.innerHTML = ($('#geminiFallback') ? '' : `
      <label for="geminiFallback" style="display:block;font-weight:600;margin-bottom:4px">Model dự phòng <span class="hint" style="font-weight:400">(thử lần lượt khi model chính bị 503 quá tải / 429 hết quota; cách nhau bằng dấu phẩy)</span></label>
      <input type="text" id="geminiFallback" style="width:100%" autocomplete="off" spellcheck="false" placeholder="${DEFAULT_FALLBACK_MODELS.join(', ')}">`) +
      ($('#geminiModelStatus') ? '' : `<div id="geminiModelStatus" style="margin-top:8px"></div>`) + `
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="btn btn-ghost btn-sm" id="btnGeminiModelDefault" title="Đặt lại model chính + dự phòng về mặc định">↺ Model mặc định</button>
        <button type="button" class="btn btn-ghost btn-sm" id="btnGeminiModelReset" title="Xóa cooldown/đánh dấu lỗi của các model">↺ Xóa cooldown model</button>
      </div>`;
    const anchor = modelEl.closest('label') || modelEl.closest('.form-group, .field, .form-row') || modelEl;
    anchor.insertAdjacentElement('afterend', wrap);
  }

  const fmtSec = (s) => s >= 60 ? Math.ceil(s / 60) + ' phút' : s + 's';
  // Bảng: thứ tự model, vai trò (chính/dự phòng), trạng thái, model đang dùng
  async function renderModelStatus(keysIn) {
    const box = $('#geminiModelStatus');
    if (!box) return;
    let st, keys;
    try { st = await loadSettings(); keys = keysIn || await listKeys(); } catch (e) { return; }
    const now = Date.now(), chain = modelChain(st);
    const usable = keys.filter(k => k.enabled && k.status !== 'invalid');
    const rows = chain.map((m, i) => {
      let state, cls;
      if (isModelDead(m, now)) { state = '❌ Không tồn tại/không hỗ trợ (tạm bỏ qua)'; cls = 'scan-chip-err'; }
      else if (modelCoolUntil(m, now)) { state = '⏳ Quá tải (503) — nghỉ ' + fmtSec(Math.ceil((modelCoolUntil(m, now) - now) / 1000)); cls = 'scan-chip-warn'; }
      else if (usable.length && usable.every(k => quotaUntil(k, m, now))) { state = '⏳ Hết quota (mọi key)'; cls = 'scan-chip-warn'; }
      else if (!usable.length) { state = '⏸ Chưa có key dùng được'; cls = 'scan-chip-off'; }
      else { state = '✅ Sẵn sàng'; cls = 'scan-chip-ok'; }
      return { m, role: i === 0 ? 'Chính' : 'Dự phòng ' + i, state, cls, ready: cls === 'scan-chip-ok' };
    });
    const cur = rows.find(r => r.ready);   // model sẽ được dùng cho lần gọi kế tiếp
    box.innerHTML = '<div style="font-weight:600;margin-bottom:4px">Thứ tự model khi quét</div>' + rows.map(r => `
      <div class="scan-key-row">
        <b class="scan-key-label" style="min-width:110px">${r.role}</b>
        <code>${escapeHtml(r.m)}</code>
        <span class="scan-chip ${r.cls}">${r.state}</span>
        ${cur && cur.m === r.m ? '<span class="scan-chip scan-chip-ok">▶ ĐANG DÙNG</span>' : ''}
      </div>`).join('') +
      (cur ? '' : '<div class="hint">Hiện chưa model nào sẵn sàng — hệ thống sẽ tự chờ rồi thử lại khi quét.</div>') +
      (_lastUsed ? `<div class="hint">Lần gọi thành công gần nhất: <b>${escapeHtml(_lastUsed.model)}</b>${_lastUsed.fallback ? ' (đã dùng model DỰ PHÒNG)' : ''} bằng "${escapeHtml(_lastUsed.keyLabel)}"</div>` : '');
  }

  async function fillScanSettingsForm() {
    ensureModelUi();
    const st = await loadSettings();
    $('#geminiModel').value = st.model;
    if ($('#geminiFallback')) $('#geminiFallback').value = st.fallbackModels.join(', ');
    $('#geminiTimeout').value = st.timeoutSec;
    $('#geminiMaxWait').value = st.maxWaitRounds;
    renderKeyList();
  }

  function bindSettingsUI() {
    ensureModelUi();
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
        await patchKey(id, { status: 'ok', errorCount: 0, cooldownUntil: 0, lastError: '', quotaCooldowns: {} });
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
      st.model = normalizeModelList($('#geminiModel').value)[0] || DEFAULT_MODEL;
      if ($('#geminiFallback')) st.fallbackModels = normalizeModelList($('#geminiFallback').value).filter(m => m !== st.model);
      st.timeoutSec = Math.max(10, parseInt($('#geminiTimeout').value, 10) || DEFAULT_SETTINGS.timeoutSec);
      st.maxWaitRounds = Math.max(0, parseInt($('#geminiMaxWait').value, 10) || 0);
      await saveSettings(st);
      await fillScanSettingsForm();   // hiển thị lại giá trị đã chuẩn hóa + bảng trạng thái model
    };
    ['#geminiModel', '#geminiFallback', '#geminiTimeout', '#geminiMaxWait'].forEach(sel => { const el = $(sel); if (el) el.addEventListener('change', saveParams); });
    const btnDef = $('#btnGeminiModelDefault'), btnRst = $('#btnGeminiModelReset');
    if (btnDef) btnDef.addEventListener('click', async () => {
      const st = await loadSettings();
      st.model = DEFAULT_MODEL; st.fallbackModels = [...DEFAULT_FALLBACK_MODELS];
      await saveSettings(st); await fillScanSettingsForm(); toast('Đã đặt lại model mặc định + dự phòng.');
    });
    if (btnRst) btnRst.addEventListener('click', () => { resetModelState(); renderModelStatus(); toast('Đã xóa cooldown model.'); });
    // Đếm ngược cooldown trên bảng trạng thái khi đang mở Cài đặt
    setInterval(() => { const m = $('#settingsModal'); if (m && !m.classList.contains('hidden')) renderModelStatus(); }, 2000);

    // Làm tươi trạng thái cooldown khi vòng xoay đổi key
    _onKeysChanged = () => {
      if (!$('#settingsModal').classList.contains('hidden') || !$('#scanModal').classList.contains('hidden')) renderKeyList();
    };
  }

  /* ---------------------------- 8. HÀNG ĐỢI UPLOAD (TUẦN TỰ) ---------------------------- */
  /* Mô hình:
       entry = 1 "nguồn" người dùng upload: 1 file PDF, hoặc 1 nhóm ảnh upload cùng lần.
       job   = 1 TỜ vật lý (1–2 trang/ảnh) = 1 lần gọi Gemini.
     Xử lý TUẦN TỰ tuyệt đối: hết tờ này mới sang tờ kế, hết file này mới sang file kế.
     PDF chỉ được MỞ khi tới lượt (expandEntry) và ĐÓNG ngay khi xong file -> không
     giữ nhiều file lớn trong RAM. */
  const Q = { entries: [], running: false, paused: false, abort: null, seq: 0, jobNo: 0 };

  const allJobs = () => Q.entries.flatMap(e => e.jobs || []);
  const platesText = (job) => (job.extracted && job.extracted.bienSo.length) ? job.extracted.bienSo.join(', ') : '';

  function dbgLog(msg, level) {
    const el = $('#scanLog');
    const line = document.createElement('div');
    line.className = 'scan-log-' + (level || 'info');
    line.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`;
    el.appendChild(line);
    while (el.childNodes.length > 500) el.removeChild(el.firstChild); // giữ log gọn khi chạy hàng nghìn tờ
    el.scrollTop = el.scrollHeight;
    $('#scanStatusText').textContent = msg;
  }

  // Tìm bản ghi scan đã xong có cùng hash ảnh mặt 1 (chống quét trùng)
  async function findDoneByHash(hash) {
    const all = await tx(ST_SCANS, 'readonly', os => os.index('frontHash').getAll(hash));
    return (all || []).find(r => r.status === 'done' && !r.isTest) || null;
  }

  /* ---- ĐỐI SÁNH (Sprint 2: chỉ khớp EXACT biển số đã chuẩn hóa) ----
     CCCD / chủ xe / tình trạng: Sprint 3. Biển gần đúng KHÔNG được gán nhầm:
     không có trong DS -> đánh dấu "phiếu lạ". */
  function buildDsIndex() {
    const idx = new Map();
    const rows = (typeof state !== 'undefined' && state.rawData) ? state.rawData : [];
    for (const r of rows) {
      const k = normalizeBienSo(r.bienSo);
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(r);
    }
    return idx;
  }
  function matchPlates(plates, idx) {
    if (!idx.size) return null; // chưa tải danh sách xe -> không đối sánh
    return plates.map(p => ({ bienSo: p, found: idx.has(p), rows: (idx.get(p) || []).length }));
  }

  /* ---- Mở rộng 1 entry thành các job (tờ) ---- */
  async function expandEntry(entry) {
    const st = await loadSettings();
    const pps = st.pagesPerSheet === 1 ? 1 : 2;
    entry.jobs = [];
    const mk = (label, pagesDesc, render) => {
      const job = { id: ++Q.jobNo, entry, label, pagesDesc, render, status: 'wait', error: '', extracted: null, json: null, match: null, scanId: null };
      entry.jobs.push(job);
      return job;
    };
    if (entry.type === 'pdf') {
      dbgLog(`Đang mở PDF "${entry.name}" (${(entry.files[0].size / 1048576).toFixed(1)}MB)…`);
      entry.getDoc = async () => entry.doc || (entry.doc = await openPdf(entry.files[0]));
      const doc = await entry.getDoc();
      const n = doc.numPages;
      for (let i = 1; i <= n; i += pps) {
        const nums = (pps === 2 && i + 1 <= n) ? [i, i + 1] : [i];
        mk(entry.name, 'tr.' + nums.join('-'), async (maxEdge) => {
          const d = await entry.getDoc();
          const out = [];
          for (const no of nums) out.push(await renderPdfPage(d, no, maxEdge, entry.name)); // tuần tự từng trang
          return out;
        });
      }
      dbgLog(`PDF "${entry.name}": ${n} trang → ${entry.jobs.length} tờ (${pps} trang/tờ).`, 'ok');
    } else {
      const files = entry.files;
      for (let i = 0; i < files.length; i += pps) {
        const grp = files.slice(i, i + pps);
        mk(grp.map(f => f.name).join(' + '), grp.length > 1 ? 'ảnh ' + (i + 1) + '-' + (i + grp.length) : 'ảnh ' + (i + 1),
          async (maxEdge) => { const out = []; for (const f of grp) out.push(await prepareImageFile(f, maxEdge)); return out; });
      }
      dbgLog(`${files.length} ảnh → ${entry.jobs.length} tờ (${pps} ảnh/tờ).`, 'ok');
    }
    entry.jobs.forEach(j => renderJobRow(j));
    updateAll();
  }

  /* ---- Xử lý 1 tờ: render/nén -> (bỏ qua nếu trùng) -> lưu DB -> Gemini -> đối sánh -> lưu ---- */
  async function processJob(job, dsIdx) {
    job.status = 'run'; job.error = '';
    renderJobRow(job); updateAll();
    Q.abort = new AbortController();
    let rec = null;
    try {
      const st = await loadSettings();
      const known = allJobs().length;
      const pos = allJobs().indexOf(job) + 1;
      dbgLog(`Tờ ${pos}/${known} — ${job.label} (${job.pagesDesc}): chuẩn bị ảnh…`);
      const pages = await job.render(st.maxEdgePx);
      const front = pages[0], back = pages[1] || null;
      dbgLog(`  mặt 1: ${Math.round(front.blob.size / 1024)}KB` + (back ? `, mặt 2: ${Math.round(back.blob.size / 1024)}KB` : ' (không có mặt 2)'));
      const hash = await sha256Hex(front.blob);
      if (st.skipDuplicates && hash) {
        const ex = await findDoneByHash(hash);
        if (ex) {
          job.status = 'dup'; job.scanId = ex.id; job.extracted = ex.extracted; job.match = ex.match || null;
          dbgLog(`  tờ trùng với bản đã quét → bỏ qua.`, 'warn');
          // Tờ trùng: phát lại sự kiện để tạo mục so sánh nếu chưa có (createItemsForScan không ghi đè mục cũ)
          if (ex.extracted) emit('sheetDone', { scanId: ex.id, extracted: ex.extracted, label: `${job.entry.name} · ${job.pagesDesc}` });
          return;
        }
      }
      rec = {
        id: uid(), timestamp: Date.now(), source: 'batch', isTest: false,
        fileName: job.entry.name, pagesDesc: job.pagesDesc,
        frontBlob: front.blob, frontMime: front.mime, backBlob: back ? back.blob : null, backMime: back ? back.mime : null,
        frontHash: hash, backBlank: false, status: 'analyzing', matchedBienSo: [],
      };
      job.scanId = rec.id;
      await dbPut(ST_SCANS, rec);
      const res = await analyzeSheet({ front, back, onStatus: dbgLog, signal: Q.abort.signal });
      const match = matchPlates(res.extracted.bienSo, dsIdx);
      if (res.rotated && (res.rotated.front || res.rotated.back)) {   // lưu ảnh ĐÃ xoay đúng chiều (hash giữ nguyên của bản gốc để chống quét trùng)
        rec.frontBlob = res.front.blob; rec.frontMime = res.front.mime;
        if (res.back) { rec.backBlob = res.back.blob; rec.backMime = res.back.mime; }
        rec.rotated = res.rotated;
      }
      Object.assign(rec, {
        status: 'done', geminiRaw: res.geminiRaw, model: res.meta.model, keyLabel: res.meta.keyLabel,
        extracted: res.extracted, backBlank: back ? !res.extracted.backHasContent : false,
        matchedBienSo: match ? match.filter(m => m.found).map(m => m.bienSo) : [], match,
      });
      await dbPut(ST_SCANS, rec);
      job.extracted = res.extracted; job.json = res.json; job.match = match; job.status = 'done';
      // Báo cho màn so sánh tạo mục cho từng xe trên phiếu (không chặn hàng đợi quét)
      emit('sheetDone', { scanId: rec.id, extracted: res.extracted, label: `${job.entry.name} · ${job.pagesDesc}` });
      const tt = res.extracted.tinhTrang.map(t => TINH_TRANG_LABEL[t] || t).join(' / ');
      dbgLog(`  ✔ ${platesText(job) || '(không đọc được biển số)'} — ${tt || '—'}` + (match ? ` — ${match.filter(m => m.found).length}/${match.length} biển khớp DS` : ' — chưa tải DS xe'), 'ok');
    } catch (e) {
      const kind = e && e.kind;
      if (rec) { rec.status = (kind === 'quota' || kind === 'nokey' || kind === 'nomodel' || kind === 'cancelled') ? 'pending' : 'error'; rec.error = e.message; try { await dbPut(ST_SCANS, rec); } catch (x) { /* bỏ qua */ } }
      if (kind === 'quota' || kind === 'nokey' || kind === 'nomodel' || kind === 'cancelled') {
        // Lỗi KHÔNG phải do tờ giấy -> giữ tờ ở trạng thái chờ và TẠM DỪNG hàng đợi (tránh đốt hết cả lốc vào lỗi).
        job.status = 'wait'; job.error = e.message; Q.paused = true;
        dbgLog(kind === 'cancelled' ? 'Đã dừng tờ hiện tại.' : `Tạm dừng hàng đợi: ${e.message}`, 'warn');
      } else {
        job.status = 'error'; job.error = (e && e.message) || String(e);
        dbgLog(`  ✘ Lỗi tờ ${job.label} (${job.pagesDesc}) [${kind || 'unknown'}]: ${job.error}`, 'error');
        if (e && e.raw) $('#scanJsonRaw').textContent = String(e.raw);
      }
    } finally {
      Q.abort = null;
      renderJobRow(job); updateAll();
    }
  }

  /* ---- Vòng chạy chính ---- */
  async function runQueue() {
    if (Q.running) return;
    Q.running = true; Q.paused = false; updateAll();
    const dsIdx = buildDsIndex();
    if (!dsIdx.size) dbgLog('⚠️ Chưa tải danh sách xe từ Google Sheet — chỉ OCR, chưa đối sánh được.', 'warn');
    try {
      for (const entry of Q.entries) {
        if (Q.paused) break;
        if (entry.status === 'done') continue;
        entry.status = 'run'; renderEntryRow(entry);
        try {
          if (!entry.jobs) await expandEntry(entry);
        } catch (e) {
          entry.status = 'error'; entry.error = e.message; renderEntryRow(entry);
          dbgLog(`Không mở được "${entry.name}": ${e.message}`, 'error');
          continue; // file hỏng -> sang file kế
        }
        for (const job of entry.jobs) {
          if (Q.paused) break;
          if (job.status !== 'wait') continue;
          await processJob(job, dsIdx);
        }
        const pending = entry.jobs.some(j => j.status === 'wait' || j.status === 'run');
        if (!pending) {
          entry.status = entry.jobs.some(j => j.status === 'error') ? 'partial' : 'done';
          // Giải phóng PDF khỏi RAM ngay khi xong file
          if (entry.doc) { try { entry.doc.destroy(); } catch (x) { /* bỏ qua */ } entry.doc = null; }
        }
        renderEntryRow(entry);
      }
    } finally {
      Q.running = false;
      updateAll();
      const left = allJobs().some(j => j.status === 'wait') || Q.entries.some(e => !e.jobs && e.status !== 'error');
      dbgLog(Q.paused ? 'Hàng đợi đang tạm dừng.' : (left ? 'Dừng.' : '🏁 Hoàn tất toàn bộ hàng đợi.'), left || Q.paused ? 'warn' : 'ok');
      // Xong hẳn -> báo để mở bước SO SÁNH & XÁC NHẬN (chưa ghi gì lên Sheet cho đến khi người dùng bấm Áp dụng)
      if (!Q.paused && !left) emit('queueFinished', { jobs: allJobs().length });
    }
  }

  /* ---- Thêm file vào hàng đợi ---- */
  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    const pdfs = files.filter(isPdfFile);
    const imgs = files.filter(f => !isPdfFile(f) && isImageFile(f)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const bad = files.filter(f => !isPdfFile(f) && !isImageFile(f));
    if (bad.length) toast(`Bỏ qua ${bad.length} file không hỗ trợ: ${bad.slice(0, 3).map(f => f.name).join(', ')}`, true);
    const mk = (type, name, fs) => {
      const e = { id: ++Q.seq, type, name, files: fs, status: 'wait', jobs: null, doc: null, error: '' };
      Q.entries.push(e);
      renderEntryRow(e);
    };
    pdfs.forEach(f => mk('pdf', f.name, [f]));
    if (imgs.length) mk('img', imgs.length === 1 ? imgs[0].name : `${imgs.length} ảnh (${imgs[0].name} …)`, imgs);
    if (pdfs.length || imgs.length) dbgLog(`Đã thêm ${pdfs.length} PDF + ${imgs.length} ảnh vào hàng đợi.`);
    updateAll();
  }

  /* ---- Hiển thị ---- */
  const STATUS_LABEL = { wait: 'Chờ', run: '⏳ Đang xử lý', done: '✅ Xong', dup: '♻️ Trùng — bỏ qua', error: '❌ Lỗi' };

  function ensureRow(id, entry, isFile) {
    let tr = document.getElementById(id);
    if (tr) return tr;
    tr = document.createElement('tr');
    tr.id = id;
    if (isFile) tr.className = 'scan-row-file';
    const body = $('#scanQueueBody');
    // Chèn ngay SAU hàng cuối của entry (để tờ của file nào nằm dưới file đó)
    const anchor = isFile ? null : (entry.tail || entry.rowEl);
    if (anchor && anchor.nextSibling) body.insertBefore(tr, anchor.nextSibling); else body.appendChild(tr);
    if (isFile) entry.rowEl = tr;
    entry.tail = tr;
    return tr;
  }
  function renderEntryRow(e) {
    const tr = ensureRow('scan-entry-' + e.id, e, true);
    const n = e.jobs ? e.jobs.length : null;
    const st = { wait: 'Chờ xử lý', run: '⏳ Đang mở/xử lý', done: '✅ Hoàn tất', partial: '⚠️ Xong (có tờ lỗi)', error: '❌ Không mở được' }[e.status] || e.status;
    tr.innerHTML = `<td colspan="6">${e.type === 'pdf' ? '📄' : '🖼️'} <b>${escapeHtml(e.name)}</b>${n != null ? ` · ${n} tờ` : ''} — ${st}${e.error ? ' · ' + escapeHtml(e.error) : ''}</td>`;
  }
  function renderJobRow(job) {
    const tr = ensureRow('scan-job-' + job.id, job.entry, false);
    tr.className = 'scan-row-' + job.status;
    const x = job.extracted;
    const plates = x ? x.bienSo.map(p => {
      const m = job.match && job.match.find(mm => mm.bienSo === p);
      const cls = !job.match ? '' : (m && m.found ? 'ok' : 'miss');
      return `<span class="scan-plate ${cls}" title="${!job.match ? 'Chưa tải DS xe' : (cls === 'ok' ? 'Khớp danh sách xe' : 'KHÔNG có trong DS — phiếu lạ / cần bổ sung')}">${escapeHtml(p)}</span>`;
    }).join(' ') : '';
    const tt = x ? x.tinhTrang.map(t => TINH_TRANG_LABEL[t] || t).join(' / ') : '';
    const err = job.error ? ` title="${escapeHtml(job.error)}"` : '';
    tr.dataset.job = job.id;
    tr.innerHTML = `<td>${job.id}</td><td>${escapeHtml(job.label)}<div class="hint">${escapeHtml(job.pagesDesc)}</div></td>
      <td>${plates || '<span class="hint">—</span>'}</td><td>${x ? escapeHtml(x.chuHo) : ''}</td><td>${escapeHtml(tt)}</td>
      <td${err}>${STATUS_LABEL[job.status]}${job.status === 'error' || (job.status === 'wait' && job.error) ? '<div class="hint">' + escapeHtml(job.error.slice(0, 80)) + '</div>' : ''}</td>`;
  }

  function updateAll() {
    const jobs = allJobs();
    const cnt = (s) => jobs.filter(j => j.status === s).length;
    const done = cnt('done'), dup = cnt('dup'), err = cnt('error');
    const finished = done + dup + err;
    const unopened = Q.entries.filter(e => !e.jobs && e.status !== 'error').length;
    // Thanh tiến độ (chỉ biết tổng số tờ của các file đã mở)
    $('#scanProgressBar').style.width = (jobs.length ? Math.round(finished / jobs.length * 100) : 0) + '%';
    $('#scanProgressText').textContent = jobs.length || unopened
      ? `${finished}/${jobs.length} tờ` + (unopened ? ` · còn ${unopened} file chưa mở` : '') + (Q.running ? (Q.paused ? ' · đang dừng sau tờ này…' : ' · đang chạy') : (Q.paused ? ' · tạm dừng' : ''))
      : 'Chưa có file trong hàng đợi';
    // Báo cáo tổng
    let khop = 0, miss = 0;
    for (const j of jobs) if (j.match) for (const m of j.match) (m.found ? khop++ : miss++);
    $('#scanSummary').innerHTML = `Xong <b>${done}</b> · trùng <b>${dup}</b> · lỗi <b class="${err ? 'scan-bad' : ''}">${err}</b> · biển khớp DS <b>${khop}</b> · phiếu lạ (chưa có trong DS) <b class="${miss ? 'scan-warn' : ''}">${miss}</b>`;
    // Nút
    const hasWork = jobs.some(j => j.status === 'wait') || unopened > 0;
    $('#btnScanStart').disabled = Q.running || !hasWork;
    $('#btnScanStart').textContent = (finished || Q.paused) ? '▶ Tiếp tục' : '▶ Bắt đầu';
    $('#btnScanPause').disabled = !Q.running || Q.paused;
    $('#btnScanStop').disabled = !Q.running;
    $('#btnScanRetry').disabled = Q.running || !err;
    $('#btnScanClearQueue').disabled = Q.running || !Q.entries.length;
    // Chip trạng thái trên thanh đầu trang: đóng cửa sổ Quét phiếu vẫn thấy tiến độ, bấm để mở lại.
    const chip = $('#scanBgChip');
    if (chip) {
      const show = Q.running || Q.paused;
      chip.classList.toggle('hidden', !show);
      if (show) chip.textContent = `📷 Đang quét ${finished}/${jobs.length || '?'}${Q.paused ? ' (tạm dừng)' : ''}`;
    }
  }

  function showJobJson(jobId) {
    const job = allJobs().find(j => j.id === jobId);
    if (!job) return;
    $('#scanJsonRaw').textContent = job.json ? JSON.stringify(job.json, null, 2) : (job.extracted ? JSON.stringify(job.extracted, null, 2) : (job.error || '(chưa có dữ liệu)'));
  }

  async function refreshScanCount() {
    try { $('#scanDbCount').textContent = (await dbCount(ST_SCANS)) + ' bản ghi scan trong DB'; }
    catch (e) { $('#scanDbCount').textContent = 'DB lỗi: ' + e.message; }
  }

  function bindScanUI() {
    $('#btnScan').addEventListener('click', async () => {
      openModal('scanModal');
      const st = await loadSettings();
      $('#scanPagesPerSheet').value = String(st.pagesPerSheet);
      $('#chkScanSkipDup').checked = !!st.skipDuplicates;
      renderKeyList(); refreshScanCount(); updateAll();
    });
    $('#scanOpenSettings').addEventListener('click', () => { closeModal('scanModal'); $('#btnSettings').click(); });

    // Chọn file + kéo thả
    $('#scanFiles').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    const drop = $('#scanDrop');
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    // Tuỳ chọn (lưu ngay)
    $('#scanPagesPerSheet').addEventListener('change', async (e) => {
      const st = await loadSettings(); st.pagesPerSheet = parseInt(e.target.value, 10) === 1 ? 1 : 2; await saveSettings(st);
      toast('Áp dụng cho file được mở từ giờ (file đã mở giữ nguyên cách chia tờ).');
    });
    $('#chkScanSkipDup').addEventListener('change', async (e) => {
      const st = await loadSettings(); st.skipDuplicates = e.target.checked; await saveSettings(st);
    });

    // Điều khiển hàng đợi
    $('#btnScanStart').addEventListener('click', runQueue);
    $('#btnScanPause').addEventListener('click', () => { Q.paused = true; dbgLog('Sẽ tạm dừng sau khi xong tờ đang xử lý.', 'warn'); updateAll(); });
    $('#btnScanStop').addEventListener('click', () => { Q.paused = true; if (Q.abort) Q.abort.abort('user'); });
    $('#btnScanRetry').addEventListener('click', () => {
      // Đưa các tờ lỗi về trạng thái chờ rồi chạy lại
      for (const j of allJobs()) if (j.status === 'error') { j.status = 'wait'; j.error = ''; renderJobRow(j); }
      for (const e of Q.entries) if (e.status === 'partial') e.status = 'wait';
      runQueue();
    });
    $('#btnScanClearQueue').addEventListener('click', () => {
      if (!confirm('Xóa hàng đợi hiện tại? (Dữ liệu đã lưu trong DB vẫn giữ nguyên)')) return;
      Q.entries.forEach(e => { if (e.doc) { try { e.doc.destroy(); } catch (x) { /* bỏ qua */ } } });
      Q.entries = []; Q.paused = false; $('#scanQueueBody').innerHTML = ''; updateAll();
    });

    $('#scanQueueBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-job]');
      if (tr) showJobJson(parseInt(tr.dataset.job, 10));
    });
    $('#btnScanCopyJson').addEventListener('click', () => {
      const t = $('#scanJsonRaw').textContent;
      if (!t) return;
      navigator.clipboard.writeText(t).then(() => toast('Đã copy JSON.'), () => toast('Không copy được.', true));
    });
    $('#btnScanClearLog').addEventListener('click', () => { $('#scanLog').innerHTML = ''; });
    $('#btnScanDeleteTests').addEventListener('click', async () => {
      if (!confirm('Xóa các bản ghi scan thử từ Sprint 1 (isTest) trong DB?')) return;
      const all = await dbGetAll(ST_SCANS);
      for (const r of all) if (r.isTest) await dbDelete(ST_SCANS, r.id);
      toast('Đã xóa dữ liệu thử.'); refreshScanCount();
    });
    // Cảnh báo khi đang chạy mà đóng tab
    window.addEventListener('beforeunload', (e) => { if (Q.running) { e.preventDefault(); e.returnValue = ''; } });
  }

  /* ---------------------------- 9. KHỞI TẠO ---------------------------- */
  function init() {
    bindSettingsUI();
    bindScanUI();
    renderKeyList();
    updateAll();
    // Xin trình duyệt giữ dữ liệu bền vững (tránh bị dọn khi đầy ổ đĩa) — ảnh scan là dữ liệu quan trọng.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  init();

  // API công khai cho Sprint 3+ (đối sánh đầy đủ, xem phiếu theo xe...)
  return {
    db: { openDb, tx, dbGetAll, dbGet, dbPut, dbDelete, dbCount, ST_SCANS, ST_KEYS, ST_ITEMS, ST_LINKS },
    on, emit, yieldToUi,
    keys: { listKeys, addKey, patchKey, removeKey, testKey, refreshUi: () => { renderKeyList(); notifyKeysChanged(); } },   // refreshUi: scan-store.js gọi sau khi nhập key từ kho khóa
    settings: { loadSettings, saveSettings, modelChain, DEFAULT_MODEL, DEFAULT_FALLBACK_MODELS },
    models: { resetState: resetModelState, renderStatus: renderModelStatus },
    prepareImageFile, openPdf, renderPdfPage, analyzeSheet, geminiGenerate, normalizeBienSo, normalizeCccd, sha256Hex, uid,
    TINH_TRANG_LABEL,
  };
})();
