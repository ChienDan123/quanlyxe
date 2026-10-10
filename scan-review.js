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
     4. Biển số KHÔNG có trong danh sách ("phiếu lạ"): khi bấm Cập nhật -> ghi vào HÀNG TRỐNG MỚI của sheet đang làm việc, CHỈ 5 cột AL–AP
        «Phiếu lạ - Biển số / Họ tên / CCCD / Địa chỉ / Số điện thoại» (các cột khác để trống; gửi lại cùng biển không tạo hàng trùng). Nếu sau đó xác định trùng xe đã có
        (đổi biển) -> chuyển dữ liệu về đúng dòng xe đó rồi XÓA hàng phiếu lạ.
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
    // «Tình trạng phương tiện» trên phiếu ↔ «Trạng thái xe» ở trang chủ (danh sách STATUS_OPTIONS, bổ sung được)
    { key: 'trangThaiXe', label: 'Trạng thái xe (tình trạng phương tiện)', cmp: C.cmpStatus },
    { key: 'ghiChu', label: 'Ghi chú', cmp: C.cmpNote },
    { key: 'tinhTrangCamKet', label: 'Tình trạng cam kết', cmp: C.cmpCommit },
    // Người thực hiện: trường "meta" — không làm xe bị tính là "có khác biệt", chỉ ghi kèm khi áp dụng.
    { key: 'nguoiThucHien', label: 'Người thực hiện', cmp: C.cmpAssignee, meta: true },
  ];
  const NOTEWORTHY = (code) => code && !['khong_ro', 'dang_hoat_dong'].includes(code);

  /* ---- «Chủ xe đã chết»: hậu tố « (Đã chết)» nối vào tên chủ xe bên Google Sheet ---- */
  const DEAD_SUFFIX = ' (Đã chết)';
  const DEAD_RE = /\s*\(\s*đã\s+chết\s*\)\s*$/i;
  const isDead = (name) => DEAD_RE.test(String(name || ''));
  const stripDead = (name) => String(name || '').replace(DEAD_RE, '').trim();

  /* ---- NGƯỜI MUA / NGƯỜI SỬ DỤNG XE ----
     Thông tin trên phiếu có thể là của người mua hoặc người đang sử dụng xe (không phải chủ xe đứng tên). Mỗi vai trò có 4 cột riêng trên Sheet:
     «Người mua - Họ tên / Địa chỉ / Số CCCD / Số điện thoại» và «Người sử dụng xe - …». Cột chưa có thì Apps Script (updateRow_) tự tạo thêm ở cột trống đầu tiên. */
  const PARTY_ROLES = { buyer: { label: 'Người mua', prefix: 'nguoiMua' }, user: { label: 'Người sử dụng xe', prefix: 'nguoiSuDung' } };
  const PARTY_FIELDS = [
    // from = khóa trong scanData dùng làm giá trị mặc định (partyTen/partyCccd/partySdt do buildScanData tính theo quy tắc ĐKX);
    // legacy = khóa của mục tạo từ bản cũ (chưa có partyXxx) -> vẫn dùng được
    { k: 'ten', suffix: 'Ten', label: 'Họ tên', from: 'partyTen', legacy: 'chuXe' },
    { k: 'diaChi', suffix: 'DiaChi', label: 'Địa chỉ', from: null },       // phiếu chưa đọc địa chỉ -> người dùng nhập tay
    { k: 'cccd', suffix: 'Cccd', label: 'Số CCCD', from: 'partyCccd', legacy: 'cccd' },
    { k: 'sdt', suffix: 'Sdt', label: 'Số điện thoại', from: 'partySdt', legacy: 'soDienThoai' },
  ];
  const PARTY_OWNER_KEYS = ['chuXe', 'cccd', 'soDienThoai'];               // các trường «chủ xe» không còn so sánh khi phiếu là của người mua / người sử dụng
  const partyKey = (role, f) => PARTY_ROLES[role].prefix + f.suffix;
  const partyHeader = (role, f) => `${PARTY_ROLES[role].label} - ${f.label}`;
  const partyKeys = (role) => PARTY_FIELDS.map(f => partyKey(role, f));
  // Đăng ký 8 cột mới vào FIELD_MAP (app.js) lúc chạy: sao chép dạng của cột «Kết quả đối chiếu phiếu» để updateSingleRowFields / gasRequest
  // hiểu khóa mới → tiêu đề cột. Đã có sẵn trong FIELD_MAP thì bỏ qua (nên chuyển hẳn vào app.js khi tiện).
  function ensurePartyFields() {
    try {
      if (typeof FIELD_MAP === 'undefined' || !Array.isArray(FIELD_MAP)) return;
      const tpl = FIELD_MAP.find(f => f.key === 'ketQuaPhieu') || FIELD_MAP.find(f => f.key === 'kiemPhieu');
      if (!tpl) return;
      for (const role of Object.keys(PARTY_ROLES)) for (const f of PARTY_FIELDS) {
        const key = partyKey(role, f), header = partyHeader(role, f);
        if (FIELD_MAP.some(x => x.key === key)) continue;
        const e = {};
        for (const p of Object.keys(tpl)) e[p] = Array.isArray(tpl[p]) ? [header] : tpl[p];   // không để bí danh của cột mẫu trùng sang cột mới
        e.key = key; e.header = header; FIELD_MAP.push(e);
      }
    } catch (err) { console.warn('[scan-review] không đăng ký được cột người mua / sử dụng', err); }
  }
  ensurePartyFields();

  /* ---- TRƯỜNG THÔNG TIN MỚI (người dùng tự thêm trong So sánh phiếu) ----
     Người dùng gõ TÊN TRƯỜNG + GIÁ TRỊ (vd. «Người đang sử dụng xe») → lưu trong mục phiếu (it.customFields) → «Ghi lên Sheet»:
     tên trường = tiêu đề cột; cột chưa có thì Apps Script (updateRow_) tự tạo ở cột trống đầu tiên.
     Danh sách tên trường đã từng thêm được nhớ ở localStorage và đăng ký lại vào FIELD_MAP mỗi lần mở trang (để đọc lại đúng cột khi tải Sheet). */
  const CF_DEFS_KEY = 'rvCustomFieldDefs';
  const CF_PREFIX = 'cf_';
  const cfPlain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const cfKey = (name) => CF_PREFIX + cfPlain(name).replace(/ /g, '_');
  const cfLoadDefs = () => { try { const a = JSON.parse(localStorage.getItem(CF_DEFS_KEY) || '[]'); return Array.isArray(a) ? a.filter(d => d && d.key && d.header) : []; } catch (e) { return []; } };
  const cfSaveDefs = (defs) => { try { localStorage.setItem(CF_DEFS_KEY, JSON.stringify(defs)); } catch (e) { /* bỏ qua */ } };
  function cfRegister(def) {                                           // khóa → tiêu đề cột trong FIELD_MAP (app.js) để updateSingleRowFields / processRows hiểu
    try {
      if (typeof FIELD_MAP === 'undefined' || !Array.isArray(FIELD_MAP)) return false;
      if (FIELD_MAP.some(x => x.key === def.key)) return true;
      const tpl = FIELD_MAP.find(f => f.key === 'ketQuaPhieu') || FIELD_MAP.find(f => f.key === 'kiemPhieu');
      if (!tpl) return false;
      const e = {};
      for (const p of Object.keys(tpl)) e[p] = Array.isArray(tpl[p]) ? [def.header] : tpl[p];
      e.key = def.key; e.header = def.header; FIELD_MAP.push(e);
      return true;
    } catch (err) { console.warn('[scan-review] không đăng ký được trường mới', err); return false; }
  }
  cfLoadDefs().forEach(cfRegister);
  /* ---- NGƯỜI SỬ DỤNG XE = cột AH → AK của sheet «Tong hop» ----
     AH «Người sử dụng xe - Họ tên» · AI «… - Địa chỉ» · AJ «… - Số CCCD» · AK «… - Số điện thoại»  (khóa nguoiSuDungTen / DiaChi / Cccd / Sdt).
     Khi phiếu có dòng «Tên người mua / người sử dụng», 4 trường này được ĐƯA VÀO BẢNG ĐỐI CHIẾU như Chủ xe: so phiếu ↔ Sheet, sửa phiếu, sửa Sheet,
     chọn nguồn (phiếu / Sheet), xác nhận đã đối chiếu ảnh, áp dụng cả xe, hoàn tác… (mọi cơ chế đó chạy theo SPECS nên dùng chung 100% với Chủ xe). */
  const USER_COL_FIRST = 33;                                                   // AH = cột thứ 34 → chỉ số 33 (A = 0); chỉ dùng để ghi chú / log
  // So sánh văn bản thường (địa chỉ): bỏ dấu / hoa-thường / ký tự lạ; phiếu trống => không có gì để đối chiếu
  function cmpPlainText(sv, dsv) {
    const a = C.flat(sv), b = C.flat(dsv);
    if (!a) return { state: 'same' };
    if (!b) return { state: 'fill', newVal: String(sv).trim(), defaultDecision: 'apply', note: 'Sheet đang trống → điền từ phiếu' };
    if (a === b || b.includes(a) || a.includes(b)) return { state: 'same' };
    return { state: 'diff', newVal: String(sv).trim(), defaultDecision: 'later', note: 'Phiếu và Sheet khác nhau — chọn nguồn đúng' };
  }
  const USER_CMP = { ten: (a, b) => C.cmpName(a, b), diaChi: cmpPlainText, cccd: (a, b) => C.cmpCccd(a, b), sdt: (a, b) => C.cmpPhone(a, b) };
  const USER_SPECS = PARTY_FIELDS.map(f => ({ key: partyKey('user', f), label: 'Người sử dụng xe - ' + f.label, cmp: USER_CMP[f.k], pf: f, party: true }));
  const USER_BY_KEY = Object.fromEntries(USER_SPECS.map(sp => [sp.key, sp]));
  // Có đưa «Người sử dụng xe» vào bảng đối chiếu không? — chọn tay vai trò «Người sử dụng xe», hoặc (tự động) phiếu có dòng người mua / sử dụng
  // và người dùng chưa chọn «Không có người sử dụng». Vai trò «Người mua» vẫn dùng khung cũ.
  const userMode = (it) => !!it && (it.partyRole === 'user' || (!it.partyRole && !it.userSkip && !!String((it.scanData || {}).nguoiDung || '').trim()));
  // Danh sách trường của 1 xe: 4 trường Người sử dụng chèn ngay sau Chủ xe / CCCD / SĐT cho dễ nhìn
  const specsFor = (it) => userMode(it) ? SPECS.slice(0, 3).concat(USER_SPECS, SPECS.slice(3)) : SPECS;
  // Giá trị MẶC ĐỊNH bên phiếu của 1 trường người sử dụng (chưa tính chỗ người dùng sửa ở bảng)
  const userDefault = (it, key) => USER_BY_KEY[key] ? (partyDefault(it, USER_BY_KEY[key].pf) || '').toString().trim() : '';
  // Khớp cột AH–AK theo TIÊU ĐỀ THỰC TẾ trên Sheet (chịu được gạch nối khác / thiếu dấu); gọi từ processRows() của app.js.
  // Khớp được thì gán khóa + đặt tiêu đề trong FIELD_MAP = tiêu đề thật => ghi ngược luôn trúng đúng cột, không tạo cột trùng.
  function resolveUserColumns(headers, headerToKey) {
    const plain = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
    const WORD = { ten: /(ho ten|\bten\b)/, diaChi: /dia chi/, cccd: /(cccd|cmnd|\bmst\b|can cuoc)/, sdt: /(dien thoai|\bsdt\b|so dt)/ };
    PARTY_FIELDS.forEach(f => {
      const key = partyKey('user', f);
      if (headers.some(h => headerToKey[h] === key)) return;                    // đã khớp đúng tên
      const h = headers.find(x => !headerToKey[x] && /su dung/.test(plain(x)) && !/nguoi mua/.test(plain(x)) && WORD[f.k].test(plain(x)));
      if (!h) { console.warn('[scan-review] Không thấy cột «' + partyHeader('user', f) + '» (dự kiến cột AH–AK) — sẽ tự tạo khi ghi.'); return; }
      headerToKey[h] = key;
      const e = (typeof FIELD_MAP !== 'undefined') && FIELD_MAP.find(x => x.key === key); if (e) e.header = h;
    });
  }
  window.resolveUserColumns = resolveUserColumns;
  // Giá trị đang định ghi cho 1 ô của người mua / người sử dụng: ưu tiên chỗ người dùng đã sửa, không thì lấy từ phiếu
  const partyDefault = (it, f) => !f.from ? '' : (f.from in it.scanData ? (it.scanData[f.from] || '') : (f.legacy ? (it.scanData[f.legacy] || '') : ''));
  const partyValue = (it, f) => String((it.partyEdits && f.k in it.partyEdits) ? it.partyEdits[f.k] : partyDefault(it, f)).trim();

  /* ---- QUY TẮC ĐỌC PHIẾU (chủ phiếu ≠ chủ phương tiện) ----
     • «Chủ hộ» đầu phiếu = CHỦ PHIẾU (người khai) — có thể KHÔNG phải chủ xe.
     • Từng dòng xe: «Tên trong ĐKX» = CHỦ PHƯƠNG TIỆN (chủ xe thật sự); dòng «Tên người mua / người sử dụng» = người đang dùng / mua xe.
     • CHỈ KHI dòng xe không ghi tên ĐKX mới coi tên chủ phiếu là chủ phương tiện.
     • CCCD / SĐT đầu phiếu thuộc CHỦ PHIẾU: chỉ đem so với chủ xe khi chủ phiếu chính là chủ xe; ngược lại chuyển sang «người mua / sử dụng».
     Khóa trên từng xe do scan.js (prompt Gemini) trả về; chấp nhận vài tên gọi để không vỡ khi đổi tên khóa. */
  const VEH_OWNER_KEYS = ['tenDKX', 'tenTrongDKX', 'chuPhuongTien', 'chuXe'];
  const VEH_USER_KEYS = ['nguoiMuaSuDung', 'nguoiMua', 'nguoiSuDung', 'tenNguoiMua', 'tenNguoiSuDung'];
  const pickStr = (o, keys) => { for (const k of keys) { const t = String((o && o[k]) == null ? '' : o[k]).trim(); if (t) return t; } return ''; };

  // Dữ liệu của 1 xe trên phiếu (thông tin chủ phiếu dùng chung cho mọi xe cùng phiếu)
  function buildScanData(ex, v) {
    const code = v.tinhTrang || 'khong_ro';
    const label = S.TINH_TRANG_LABEL[code] || code;
    const notes = [];
    if (NOTEWORTHY(code)) notes.push(label);           // VD: "Đã bán chưa sang tên", "Mất cắp"
    if (v.ghiChu) notes.push(v.ghiChu);
    if (ex.ghiChu) notes.push(ex.ghiChu);              // ghi chú tay + ghi chú mặt 2
    const chuPhieu = String(ex.chuHo || '').trim();
    const tenDKX = pickStr(v, VEH_OWNER_KEYS), nguoiDung = pickStr(v, VEH_USER_KEYS);
    const ownerName = tenDKX || chuPhieu;                                   // dòng xe không ghi tên ĐKX -> tên chủ phiếu là chủ phương tiện
    const holderIsOwner = !tenDKX || (!!C.flat(tenDKX) && C.flat(tenDKX) === C.flat(chuPhieu));
    return {
      chuXe: ownerName,
      cccd: holderIsOwner ? (pickStr(v, ['cccd']) || ex.cccd || '') : '',    // CCCD / SĐT của chủ phiếu chỉ so với chủ xe khi chủ phiếu = chủ xe
      soDienThoai: holderIsOwner ? (pickStr(v, ['sdt', 'soDienThoai']) || ex.sdt || '') : '',
      chuPhieu, tenDKX, nguoiDung, ownerFromHead: !tenDKX,
      // Gợi ý «người mua / sử dụng»: tên ghi ở dòng xe; nếu không có mà chủ phiếu ≠ chủ xe thì chính chủ phiếu là người đang dùng
      partyTen: nguoiDung || (holderIsOwner ? '' : chuPhieu),
      partyCccd: holderIsOwner ? '' : (ex.cccd || ''), partySdt: holderIsOwner ? '' : (ex.sdt || ''),
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
        edits: {}, sheetEdits: {}, fixed: {}, imgChecked: false,
        source: {}, fieldChecked: {}, sheetOk: {},   // nguồn đã chọn RIÊNG từng trường ('scan'|'sheet'), tick «đã kiểm ảnh» từng trường, trường «Sheet đúng» đã chốt // chỉnh sửa tay bên phiếu / bên Sheet + tick "Đã kiểm với ảnh"
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
    items: [], filter: 'review', checker: '', search: '', page: 1, pageSize: 12, busy: false, listIds: [],
    // Khung ảnh phiếu đặt cạnh bảng so sánh (vừa xem ảnh vừa đối chiếu)
    pane: { open: false, id: null, loadedId: null, mode: 'both', zoom: 100, urls: [], token: 0 },
  };
  // Tùy chọn của người dùng (nhớ trên máy): người thực hiện mặc định, ghi dấu 📷, xác nhận nhanh = áp dụng luôn
  const PREF_KEY = 'vehicleScanPrefsV1';
  const prefs = { assignee: '', tag: true, quick: true, full: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* bỏ qua */ }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* bỏ qua */ } };

  const ADD_STATUS = '__add_status__';
  const ADD_NEW = (typeof ASSIGNEE_ADD_NEW_VALUE !== 'undefined') ? ASSIGNEE_ADD_NEW_VALUE : '__add_new__';
  const assigneeList = () => { try { return typeof loadAssigneeList === 'function' ? loadAssigneeList() : []; } catch (e) { return []; } };
  // Nhãn NGẮN dùng trong dấu nguồn "📷Phiếu dd/mm: CCCD, SĐT" (Người thực hiện không lấy từ phiếu nên không có)
  const TAG_LABEL = { trangThaiXe: 'Trạng thái', chuXe: 'Chủ xe', cccd: 'CCCD', soDienThoai: 'SĐT', ghiChu: 'Ghi chú', tinhTrangCamKet: 'Cam kết',
    nguoiSuDungTen: 'Người SD-Tên', nguoiSuDungDiaChi: 'Người SD-Địa chỉ', nguoiSuDungCccd: 'Người SD-CCCD', nguoiSuDungSdt: 'Người SD-SĐT' };
  const isActionable = (st) => st === 'fill' || st === 'diff' || st === 'sheetedit';
  const SIGNED = (typeof COMMITMENT_OPTIONS !== 'undefined' && COMMITMENT_OPTIONS[0]) || 'Đã ký cam kết';

  // Mục cũ (tạo trước bản này) thiếu các trường mới -> bổ sung mặc định
  function normItem(it) {
    it.edits = it.edits || {}; it.sheetEdits = it.sheetEdits || {}; it.fixed = it.fixed || {};
    it.decisions = it.decisions || {}; it.applied = it.applied || {}; it.imgChecked = !!it.imgChecked;
    it.source = it.source || {}; it.fieldChecked = it.fieldChecked || {}; it.sheetOk = it.sheetOk || {};
    it.orphanSheet = !!it.orphanSheet; it.orphanStale = it.orphanStale || null;   // phiếu lạ đã ghi thành hàng mới / hàng thừa chờ xóa
    it.partyRole = it.partyRole || ''; it.partyEdits = it.partyEdits || {}; it.partyDoneAt = it.partyDoneAt || null;   // người mua / người sử dụng
    it.userSkip = !!it.userSkip;   // true = người dùng chọn «Không có người sử dụng» (tắt tự động đưa vào bảng đối chiếu)
    it.customFields = Array.isArray(it.customFields) ? it.customFields : [];   // trường thông tin mới do người dùng thêm: [{id, key, name, value, doneAt}]
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

  /* ---- Ánh xạ «Tình trạng phương tiện» (phiếu) -> «Trạng thái xe» (web) ----
     Thứ tự: khớp chữ ghi trên phiếu -> khớp nhãn chuẩn của mã -> mã có tương ứng rõ ràng -> nhãn/chữ trên phiếu (CHƯA có trong
     danh sách => người dùng bấm ➕ để thêm lựa chọn mới). Mã chưa rõ nghĩa thì KHÔNG tự đoán sang trạng thái khác. */
  const STATUS_BY_CODE = { dang_hoat_dong: 'Còn sử dụng' };
  const statusList = () => (typeof STATUS_OPTIONS !== 'undefined' ? STATUS_OPTIONS : []);
  const matchStatus = (t) => { const f = C.flat(t); return f ? (statusList().find(o => C.flat(o) === f) || '') : ''; };
  const addStatus = (name) => (typeof addStatusOption === 'function' ? addStatusOption(name) : null);
  function scanStatus(it) {
    const d = it.scanData || {}, goc = String(d.tinhTrangGoc || '').trim(), code = d.tinhTrangCode || 'khong_ro';
    if (code === 'khong_ro' && !goc) return '';
    const label = (code === 'khac' || code === 'khong_ro') ? '' : (d.tinhTrangLabel || '');
    return matchStatus(goc) || matchStatus(label) || STATUS_BY_CODE[code] || label || goc;
  }
  const isUnknownStatus = (v) => !!String(v || '').trim() && !matchStatus(v);

  // Giá trị "bên phiếu" của 1 trường: ưu tiên giá trị người dùng đã SỬA TAY; Người thực hiện lấy mặc định ở thanh công cụ.
  function scanValue(it, key) {
    if (it.edits && key in it.edits) return it.edits[key];
    // 4 trường «Người sử dụng xe» (AH–AK): lấy từ dòng người mua / sử dụng của phiếu (hoặc chỗ người dùng đã nhập ở khung cũ)
    if (USER_BY_KEY[key]) return partyValue(it, USER_BY_KEY[key].pf);
    // Phiếu là của NGƯỜI MUA / NGƯỜI SỬ DỤNG: thông tin chủ hộ trên phiếu không phải của chủ xe đứng tên -> không đem so với Sheet
    if (it.partyRole && PARTY_OWNER_KEYS.includes(key)) return '';
    if (key === 'nguoiThucHien') return prefs.assignee || '';
    if (key === 'trangThaiXe') return scanStatus(it);
    return it.scanData[key] || '';
  }

  // Giá trị CHÍNH XÁC sẽ ghi khi người dùng chọn «Dữ liệu từ phiếu scan đúng» — luôn lấy từ PHIẾU, không lấy lại giá trị Sheet cũ.
  // (Ghi chú là ngoại lệ: luôn NỐI THÊM, không ghi đè.)
  function exactScanValue(key, sv, c) {
    const s0 = String(sv == null ? '' : sv).trim();
    if (key === 'cccd' || key === 'nguoiSuDungCccd') return (c && c.newVal != null) ? c.newVal : s0.replace(/\D/g, '');
    if (key === 'soDienThoai' || key === 'nguoiSuDungSdt') return C.normPhone(s0);
    if (key === 'ghiChu') return (c && c.newVal != null) ? c.newVal : s0;
    return s0;
  }

  // So sánh luôn dùng dữ liệu HIỆN TẠI của Sheet + giá trị phiếu SAU KHI chỉnh sửa
  // => sửa tay xong mà khớp Sheet thì trường tự chuyển thành "khớp" (đối chiếu/cập nhật bình thường).
  function computeView(it) {
    normItem(it);
    const rows = it.bienSo ? (dsIndex().get(it.bienSo) || []) : [];
    const row = rows[0] || null;
    const v = { it, row, rowCount: rows.length, found: !!row, fields: [], actionable: 0, later: 0 };
    if (!row) {   // PHIẾU LẠ: vẫn dựng đủ các trường để người dùng xem / sửa / tick kiểm ảnh như phiếu đã khớp (bên Sheet để trống)
      v.fields = specsFor(it).map(spec => ({ spec, scanVal: scanValue(it, spec.key), dsVal: '', state: 'orphan', note: '', decision: null,
        writeVal: undefined, srcSel: null, edited: spec.key in it.edits, sheetEdit: null, checked: !!it.fieldChecked[spec.key] }));
      return v;
    }
    for (const spec of specsFor(it)) {
      const key = spec.key;
      const sv = scanValue(it, key), dsv = row[key] || '';
      const srcSel = it.source[key] || null;      // nguồn người dùng đã CHỌN RÕ cho trường này: 'scan' | 'sheet'
      // Chủ xe đã đánh dấu « (Đã chết)» trên Sheet: bỏ hậu tố khi so sánh để không báo khác biệt giả
      const deadSuffix = key === 'chuXe' && isDead(dsv), dsvCmp = deadSuffix ? stripDead(dsv) : dsv;
      let c = spec.cmp(sv, dsvCmp);
      // Đã chọn «phiếu đúng» nhưng hàm so sánh coi là khớp (lệch số 0 đầu / dấu / thiếu số cuối...) -> vẫn phải ghi đúng giá trị phiếu
      if (srcSel === 'scan' && c.state === 'same' && key !== 'ghiChu' && String(sv).trim() && exactScanValue(key, sv, c) !== String(dsvCmp).trim())
        c = { state: 'diff', newVal: exactScanValue(key, sv, c), defaultDecision: 'apply', note: 'Bạn chọn lấy từ phiếu: sẽ ghi đúng giá trị trên phiếu thay cho giá trị Sheet' };
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
      else if (decision === 'apply') {
        if (srcSel === 'scan' && String(sv).trim()) writeVal = exactScanValue(key, sv, c);   // đã chọn nguồn = phiếu -> BẮT BUỘC ghi giá trị phiếu
        else writeVal = c.newVal != null ? c.newVal : (state_ === 'sheetedit' && sv ? sv : undefined);
        // Ghi tên từ phiếu đè lên tên chủ xe đã chết thì giữ lại hậu tố « (Đã chết)» (không làm mất thông tin)
        if (deadSuffix && typeof writeVal === 'string' && writeVal) writeVal = stripDead(writeVal) + DEAD_SUFFIX;
      }
      v.fields.push({ spec, scanVal: sv, dsVal: dsv, state: state_, newVal: c.newVal, note, decision, writeVal, srcSel,
        edited: key in it.edits, sheetEdit, checked: !!it.fieldChecked[key] });
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

  /* ---- GIỮ DỮ LIỆU CŨ: khi giá trị từ phiếu GHI ĐÈ giá trị đang có trên Sheet, nối giá trị cũ vào Ghi chú để hồi tố sau này.
     Dạng: "⏪Trước cập nhật từ phiếu 07/10: CCCD=0123…; SĐT=09…". Cùng ngày + cùng trường thì giữ giá trị cũ NHẤT (gốc), không nhân đôi. ---- */
  const OLD_MAX = 60;   // mỗi giá trị cũ tối đa 60 ký tự để Ghi chú không phình to
  function withOldValues(note, pairs) {   // pairs: [{ label, old }]
    if (!pairs.length) return note;
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0'), date = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
    const clean = (v) => { const t = String(v).replace(/[|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > OLD_MAX ? t.slice(0, OLD_MAX) + '…' : t; };
    const base = String(note || '').trim();
    const re = new RegExp('⏪Trước cập nhật từ phiếu ' + date + ': ([^|]*)');
    const m = base.match(re);
    const have = m ? m[1] : '';
    const add = pairs.filter(x => !have.includes(x.label + '=')).map(x => `${x.label}=${clean(x.old)}`);
    if (!add.length) return base;
    if (m) return base.replace(re, (s0) => s0.replace(/\s+$/, '') + '; ' + add.join('; ') + (/\s$/.test(s0) ? ' ' : ''));
    return (base ? base + ' | ' : '') + `⏪Trước cập nhật từ phiếu ${date}: ${add.join('; ')}`;
  }

  // Chuỗi mô tả ghi vào cột "Kết quả đối chiếu phiếu" của Sheet
  function buildResultText(v, plannedKeys) {
    const it = v.it, parts = [];
    const lab = (k) => TAG_LABEL[k] || k;
    if (it.scanData.tinhTrangCode !== 'khong_ro') parts.push(it.scanData.tinhTrangLabel);
    if (!v.found) parts.push('Chưa có trong DS');
    else {
      const byKey = Object.fromEntries(v.fields.map(f => [f.spec.key, f]));
      // «Đã cập nhật từ phiếu» chỉ tính trường ĐANG lấy từ phiếu — bỏ trường vừa chuyển sang «Sheet đúng» / «Để kiểm sau»
      const applied = [...new Set([...Object.keys(it.applied || {}).filter(k => it.applied[k] && TAG_LABEL[k]), ...(plannedKeys || [])])]
        .filter(k => { const f = byKey[k]; return !(f && isActionable(f.state) && (f.decision === 'skip' || f.decision === 'later')); });
      const keepKeys = [...new Set([...v.fields.filter(f => !f.spec.meta && f.decision === 'skip').map(f => f.spec.key),
        ...Object.keys(it.sheetOk || {}).filter(k => it.sheetOk[k] && TAG_LABEL[k])])].filter(k => !applied.includes(k));
      const keep = keepKeys.map(lab);
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
  // Lưu mục + báo cho scan-sync.js đẩy lại meta phiếu lên online (trước đây thiếu sự kiện này nên thay đổi đối chiếu không lên Drive)
  async function saveItem(it) { it.updatedAt = Date.now(); await DB.dbPut(ST_ITEMS, it); S.emit('itemsChanged', { scanId: it.scanId }); }

  // Áp dụng 1 mục có trên DS. onlyKeys (tùy chọn) = chỉ áp dụng các trường này (áp dụng RIÊNG LẺ từng trường).
  async function applyFoundItem(v, onlyKeys) {
    const it = v.it, row = v.row;
    const toWrite = {}, wrote = [], fromScan = [];
    for (const f of v.fields) {
      if (onlyKeys && !onlyKeys.includes(f.spec.key)) continue;
      const k = f.spec.key;
      if (!willWrite(f)) {
        // Ghi nhận nguồn đã chọn: «Sheet đúng» / «Để kiểm sau» => KHÔNG còn tính là «đã cập nhật từ phiếu»
        if (isActionable(f.state) && f.decision === 'skip') { delete it.applied[k]; it.sheetOk[k] = true; }
        else if (isActionable(f.state) && f.decision === 'later') { delete it.applied[k]; delete it.sheetOk[k]; }
        continue;
      }
      toWrite[k] = f.writeVal; wrote.push(k);
      if (f.decision === 'sheetfix') { it.fixed[k] = true; delete it.applied[k]; }   // sửa tay giá trị Sheet khi kiểm
      else { it.applied[k] = true; delete it.sheetOk[k]; if (!f.spec.meta) fromScan.push(k); }
    }
    // Trạng thái xe mới (chưa có trong danh sách) được ghi vào Sheet -> bổ sung luôn vào danh sách chọn ở trang chủ
    if (toWrite.trangThaiXe) toWrite.trangThaiXe = addStatus(toWrite.trangThaiXe) || toWrite.trangThaiXe;
    // DẤU NGUỒN: chỉ nối vào Ghi chú (không làm bẩn CCCD/SĐT/Chủ xe) khi thật sự có trường lấy từ phiếu
    if (prefs.tag && fromScan.length) toWrite.ghiChu = withSourceTag(('ghiChu' in toWrite) ? toWrite.ghiChu : row.ghiChu, fromScan);
    // GIỮ DỮ LIỆU CŨ: trường lấy từ phiếu mà Sheet ĐANG CÓ giá trị khác -> ghi giá trị cũ vào Ghi chú (luôn bật, không phụ thuộc dấu 📷)
    const olds = v.fields.filter(f => willWrite(f) && f.decision === 'apply' && !f.spec.meta && f.spec.key !== 'ghiChu' && (!onlyKeys || onlyKeys.includes(f.spec.key))
      && String(f.dsVal || '').trim() && String(f.dsVal).trim() !== String(f.writeVal).trim())
      .map(f => ({ label: TAG_LABEL[f.spec.key] || f.spec.label, old: f.dsVal }));
    if (olds.length) toWrite.ghiChu = withOldValues(('ghiChu' in toWrite) ? toWrite.ghiChu : row.ghiChu, olds);
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

  /* ---- PHIẾU LẠ → ghi 1 HÀNG TRỐNG MỚI vào chính sheet đang làm việc (không còn tab «PhieuLa»; chỉ ghi 5 cột AL–AP) ----
     Gửi theo TIÊU ĐỀ CỘT (kèm bí danh) để Apps Script tự khớp cột đúng; cột chưa có thì tự tạo ở cột trống đầu tiên; ô chưa có dữ liệu để trống.
     Apps Script nhận dạng hàng bằng (biển số đã ghi + «mã phiếu» trong cột Phiếu scan) nên GỬI LẠI nhiều lần cũng không tạo hàng trùng
     => phiếu lạ từng bị lỗi trước đây chỉ cần bấm «Cập nhật» lại là ghi được. */
  const colSpec = (key) => {
    const e = FIELD_MAP.find(f => f.key === key) || {}, al = [];
    for (const p of Object.keys(e)) if (Array.isArray(e[p])) e[p].forEach(x => { if (typeof x === 'string') al.push(x); });   // bí danh tiêu đề (nếu app.js có)
    return { key, header: e.header || key, aliases: [...new Set(al)] };
  };
  const currentSheetName = () => { try { return String((state && (state.sheetName || state.sheet || state.activeSheet)) || ''); } catch (e) { return ''; } };
  const id8 = (it) => String(it.scanId).slice(0, 8);
  // PHIẾU LẠ → chỉ 5 cột AL–AP «Phiếu lạ - Biển số / Họ tên / CCCD / Địa chỉ / Số điện thoại»; mọi cột khác của hàng để TRỐNG.
  // Họ tên / CCCD / SĐT: lấy giá trị phiếu (đã sửa tay nếu có); nếu phiếu đã gán cho người mua / sử dụng thì lấy từ dòng đó. Địa chỉ: phiếu chưa đọc được -> chỉ ghi khi người dùng đã nhập tay.
  const partyF = (k) => PARTY_FIELDS.find(f => f.k === k);
  function orphanCells(it) {
    const pick = (key, k) => String(scanValue(it, key) || partyValue(it, partyF(k)) || '').trim();
    return {
      bienSo: String(it.bienSoRaw || it.bienSo || '').trim(),
      hoTen: pick('chuXe', 'ten'),
      cccd: pick('cccd', 'cccd'),
      diaChi: partyValue(it, partyF('diaChi')),
      sdt: pick('soDienThoai', 'sdt'),
    };
  }
  const reloadSheetData = () => { try { const b = document.getElementById('btnReload'); if (b) b.click(); } catch (e) { /* bỏ qua */ } };
  const gasErr = (res, def) => (res && res.error) || def;
  const needPatch = (m) => /Unknown POST action/i.test(m) ? 'doPost của Apps Script chưa nối với scanDispatch_ — dán AppsScript_DoPost.gs vào dự án (trong dự án chỉ được có 1 hàm doPost), rồi Deploy PHIÊN BẢN MỚI.' : m;

  // Gọi Apps Script (POST text/plain như gasRequest) nhưng NÉM LỖI RÕ RÀNG khi mạng hỏng / trả về trang HTML (chưa cấp quyền, sai URL, lỗi code)
  async function gasCall(payload) {
    let text;
    try {
      const res = await fetch(state.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
      text = await res.text();
    } catch (e) { throw new Error('Không gọi được Apps Script (mất mạng, URL sai, hoặc bản triển khai chưa đặt «Ai cũng truy cập được»): ' + (e.message || e)); }
    try { return JSON.parse(text); }
    catch (e) {
      const t = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new Error('Apps Script trả về trang lỗi thay vì dữ liệu: «' + t + '». Thường do: chưa cấp quyền khi Deploy, URL không phải bản /exec đã triển khai, hoặc code Apps Script bị lỗi.');
    }
  }
  // Hỏi Apps Script «bạn đang chạy bản nào» TRƯỚC khi ghi phiếu lạ → báo ĐÚNG nguyên nhân thay vì im lặng. Trả null nếu ổn, ngược lại trả câu báo lỗi.
  let _orphanBackendOk = false;
  async function checkOrphanBackend() {
    if (_orphanBackendOk) return null;
    let r;
    try { r = await gasCall({ action: 'scanPing' }); } catch (e) { return String(e.message || e); }
    if (!r || r.ok === false) {
      const m = gasErr(r, '');
      return /Unknown POST action/i.test(m) ? 'Apps Script chưa nối doPost với scanDispatch_ (báo «Unknown POST action»). Dán AppsScript_DoPost.gs vào dự án (chỉ được có 1 hàm doPost) → Deploy phiên bản mới.' : (m || 'Apps Script không phản hồi đúng.');
    }
    if (!(r.actions || []).includes('scanOrphanUpsert') || Number(r.version || 0) < 6)
      return 'Apps Script đang chạy BẢN CŨ (version ' + (r.version || '?') + '). Xóa sạch file «Ma lenh luu anh.gs», dán lại AppsScript_ScanPatch.gs rồi Deploy → Phiên bản mới (không dùng «Bản triển khai mới»).';
    _orphanBackendOk = true; return null;
  }

  async function pushOrphans(items) {
    if (!items.length) return { ok: true, n: 0 };
    if (!isWriteConnected()) return { ok: false, error: 'Chưa kết nối Apps Script 2 chiều (đang ở chế độ chỉ đọc) — vào «Kết nối» và chọn chế độ Apps Script.' };
    const bad = await checkOrphanBackend();                       // báo đúng nguyên nhân nếu Apps Script chưa sẵn sàng
    if (bad) return { ok: false, error: bad };
    try {
      const res = await gasCall({ action: 'scanOrphanUpsert', sheetName: currentSheetName(), plate: colSpec('bienSo'),
        rows: items.map(it => ({ plateRaw: String(it.bienSoRaw || it.bienSo), cells: orphanCells(it) })) });
      if (!res || res.ok === false) return { ok: false, error: needPatch(gasErr(res, 'Apps Script không phản hồi.')) };
      if (!Array.isArray(res.results) || res.results.length < items.length) return { ok: false, error: 'Apps Script trả về thiếu kết quả (' + (res.results || []).length + '/' + items.length + ') — chưa chắc đã ghi, hãy bấm lại.' };
      const by = {}; (res.results || []).forEach(r => { by[r.plateRaw] = r; });
      items.forEach(it => {   // nhớ biển ĐÃ GHI + dòng, để sau này xóa đúng hàng nếu hóa ra trùng xe đã có
        const r = by[String(it.bienSoRaw || it.bienSo)] || {};
        it.orphanSheet = true; it.orphanSheetPlateRaw = String(it.bienSoRaw || it.bienSo); it.orphanSheetRow = r.row || null; it.orphanSheetName = res.sheet || '';
      });
      return { ok: true, n: items.length, sheet: res.sheet };
    } catch (e) { return { ok: false, error: needPatch(String(e.message || e)) }; }
  }

  // Trả về { pushed, failed, error, sheet, notes[] } — applyViews gom lại thành 1 thông báo (trước đây toast lỗi bị toast «Đã áp dụng» ghi đè nên người dùng thấy như im lặng).
  async function applyOrphanItems(vs) {
    const toPush = [], out = { pushed: 0, failed: 0, error: '', sheet: '', notes: [] };
    for (const v of vs) {
      const it = v.it, dec = it.orphanDecision || 'later';
      it.orphan = true;
      it.result = [it.scanData.tinhTrangCode !== 'khong_ro' ? it.scanData.tinhTrangLabel : '', 'Chưa có trong DS'].filter(Boolean).join(' · ');
      if (dec === 'apply' && it.bienSo && !it.orphanSheet) toPush.push(it);
      else if (dec === 'apply' && !it.bienSo) out.notes.push(`«${it.bienSoRaw || '(chưa có biển)'}»: chưa có biển số nên KHÔNG ghi được — nhập biển số rồi bấm lại`);
      else if (dec === 'later') out.notes.push(`«${it.bienSoRaw || it.bienSo}»: đang ở «Để kiểm sau» nên CHƯA ghi — bấm nút «📷 Dữ liệu từ phiếu scan đúng → ghi phiếu lạ» để ghi`);
      // 'skip' = đã xem và quyết định không ghi => coi là đã kiểm; 'later' = để kiểm sau
      it.review = (dec === 'later' || (dec === 'apply' && !it.orphanSheet)) ? 'chua_kiem' : 'da_kiem';
    }
    if (toPush.length) {
      const r = await pushOrphans(toPush);
      toPush.forEach(it => { if (r.ok) { it.orphanPushed = true; it.review = 'da_kiem'; it.pushError = ''; } else { it.pushError = r.error; it.review = 'chua_kiem'; } });
      if (r.ok) { out.pushed = toPush.length; out.sheet = r.sheet || ''; } else { out.failed = toPush.length; out.error = r.error; }
    }
    for (const v of vs) {
      const it = v.it, failed = it.orphanDecision === 'apply' && !!it.bienSo && !it.orphanSheet;
      // Ghi lỗi => giữ ở trạng thái CHỜ ÁP DỤNG (để bấm «Cập nhật» lại là thử lại)
      it.done = !failed; it.dirty = failed;
      await saveItem(it); await recomputeLink(it.bienSo);
    }
    return out;
  }

  /* ---- PHIẾU LẠ THỰC RA TRÙNG XE ĐÃ CÓ: xóa đúng hàng phiếu lạ đã ghi ----
     Server chỉ xóa hàng thỏa CẢ HAI: biển số đúng bằng biển đã ghi + cột Phiếu scan chứa đúng mã phiếu này. Không khớp thì không đụng gì. */
  async function deleteOrphanRow(ref) {
    if (!isWriteConnected()) return { ok: false, error: 'Chưa kết nối Apps Script 2 chiều.' };
    try {
      const res = await gasCall({ action: 'scanOrphanDelete', sheetName: ref.sheetName || currentSheetName(), scanId8: ref.scanId8, plateRaw: ref.plateRaw,
        plate: colSpec('bienSo') });
      if (!res || res.ok === false) return { ok: false, error: needPatch(gasErr(res, 'Apps Script không phản hồi.')) };
      return { ok: true, deleted: res.deleted || 0 };
    } catch (e) { return { ok: false, error: needPatch(String(e.message || e)) }; }
  }
  // Thử xóa hàng phiếu lạ còn tồn đọng (it.orphanStale) — dùng khi đổi sang xe có sẵn hoặc bấm «Xóa hàng phiếu lạ»
  async function cleanupOrphanRow(it) {
    if (!it.orphanStale) return true;
    const r = await deleteOrphanRow(it.orphanStale);
    if (!r.ok) { it.pushError = 'Chưa xóa được hàng phiếu lạ: ' + r.error; await saveItem(it); toast(it.pushError, true); return false; }
    it.orphanStale = null; it.pushError = ''; await saveItem(it);
    reloadSheetData();   // hàng bị xóa làm dòng phía dưới dịch lên -> nạp lại để chỉ số dòng không lệch
    toast(r.deleted ? 'Đã xóa hàng phiếu lạ trên Sheet.' : 'Hàng phiếu lạ không còn trên Sheet (đã xóa trước đó).');
    return true;
  }
  // Sau khi đổi biển sang xe CÓ SẴN: chuyển dữ liệu phiếu vào đúng dòng xe đó (chỉ điền ô TRỐNG; ô khác biệt để người dùng quyết định, không ghi đè)
  async function moveOrphanDataToExisting(it) {
    const v = computeView(it); if (!v.found) return 0;
    const fillKeys = v.fields.filter(f => !f.spec.meta && f.state === 'fill' && f.decision === 'apply' && f.writeVal != null).map(f => f.spec.key);
    const r = await applyFoundItem(v, fillKeys);          // luôn ghi kèm Phiếu scan / Kiểm phiếu / Kết quả đối chiếu vào dòng xe có sẵn
    if (it.partyRole && PARTY_ROLES[it.partyRole] && !userMode(it)) {      // người mua: cũng chỉ điền cột đang trống (người sử dụng đã nằm trong fillKeys ở trên)
      const pw = {};
      PARTY_FIELDS.forEach(f => { const k = partyKey(it.partyRole, f), nv = partyValue(it, f); if (nv && !String(v.row[k] || '').trim()) pw[k] = nv; });
      if (Object.keys(pw).length) await updateSingleRowFields(v.row, pw);
    }
    return r.writes;
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

  // Chế độ TOÀN MÀN HÌNH của cửa sổ so sánh (mặc định bật; nhớ lựa chọn)
  function applyFullscreen() {
    const m = document.querySelector('#scanReviewModal .modal'); if (m) m.classList.toggle('rv-full', !!prefs.full);
    syncStickyOffset();
    const b = $('#btnRvFull'); if (b) b.textContent = prefs.full ? '🗗 Thu nhỏ' : '⛶ Toàn màn hình';
  }

  async function open() {
    openModal('scanReviewModal'); applyFullscreen();
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
  /* ---- Bộ lọc theo quy trình kiểm ---- */
  const NO_CHECKER = '__none__';
  // «Tên người kiểm» = Người thực hiện: ưu tiên giá trị đã có trên Sheet, chưa có thì lấy giá trị đang chọn bên phiếu
  const checkerOf = (v) => String((v.row && v.row.nguoiThucHien) || scanValue(v.it, 'nguoiThucHien') || '').trim();
  // Có trường nào (hoặc phiếu lạ) đang để «Để kiểm sau»
  // (chỉ tính lựa chọn «Để kiểm sau» do người dùng chủ động chọn — mặc định chưa chọn cũng hiển thị «Để kiểm sau» nên không dùng f.decision)
  const hasLater = (v) => v.fields.some(f => !f.spec.meta && isActionable(f.state) && v.it.decisions[f.spec.key] === 'later') || (!v.found && v.it.orphanDecision === 'later');
  const passesChecker = (v) => !R.checker || (R.checker === NO_CHECKER ? !checkerOf(v) : checkerOf(v) === R.checker);
  function buildCheckerSelect(views) {
    const sel = $('#rvChecker'); if (!sel) return;
    const names = new Set(assigneeList());
    views.forEach(v => { const c = checkerOf(v); if (c) names.add(c); });
    if (R.checker && R.checker !== NO_CHECKER) names.add(R.checker);
    sel.innerHTML = '<option value="">Người kiểm: tất cả</option><option value="' + NO_CHECKER + '">⚠ Chưa có tên người kiểm</option>' +
      [...names].sort((a, b) => a.localeCompare(b, 'vi')).map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    sel.value = R.checker;
  }
  function passesFilter(v) {
    if (!passesChecker(v)) return false;
    const cat = viewCategory(v), it = v.it;
    switch (R.filter) {
      case 'later': return hasLater(v);                                   // có trường «Để kiểm sau»
      case 'pending': return !it.done || it.dirty;                        // chưa áp dụng / còn chờ ghi
      case 'applied': return it.done && !it.dirty;                        // đã áp dụng xong
      case 'party': return !!it.partyRole;                                // đã đánh dấu Người mua / Người sử dụng
      case 'party_todo': return !!it.partyRole && !it.partyDoneAt;        // đã đánh dấu nhưng chưa cập nhật lên Sheet
      case 'dead': return !!(v.row && isDead(v.row.chuXe));               // chủ xe đã chết
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
    else if (key === 'trangThaiXe') list = statusList().slice();
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
        (key === 'nguoiThucHien' ? `<option value="${ADD_NEW}">+ Thêm người mới...</option>` : '') +
        (key === 'trangThaiXe' ? `<option value="${ADD_STATUS}">+ Thêm Trạng thái mới...</option>` : '') + '</select>';
    }
    if (key === 'ghiChu') return `<textarea class="rv-edit" rows="2" ${attrs}>${escapeHtml(val)}</textarea>`;
    return `<input type="text" class="rv-edit" ${attrs} value="${escapeHtml(val)}">`;
  }

  // Nút RIÊNG CỦA TỪNG TRƯỜNG — mỗi nút nằm NGAY TRONG ô/cột mà nó nói đến (hết mơ hồ «trên / dưới / cả phiếu»):
  //   • scan   «✅ Dữ liệu từ phiếu scan đúng» -> dưới ô GIÁ TRỊ TỪ PHIẾU     = trường này lấy theo phiếu (ghi vào Sheet)
  //   • sheet  «✅ Google Sheet đúng»          -> dưới ô GIÁ TRỊ GOOGLE SHEET = trường này giữ nguyên theo Sheet
  //   • tick   huy hiệu «🖼 Đã đối chiếu ảnh»  -> ô tên trường: KHÔNG phải nút, tự bật sau khi người dùng XÁC NHẬN chọn nguồn
  // Bấm nút nguồn luôn hỏi xác nhận (xem confirmSource) — xác nhận = «đã đối chiếu với ảnh», nên không còn ô tick «Đã kiểm ảnh» riêng.
  // Nút «cả xe» (mọi trường) nằm riêng ở khung CẢ XE phía trên — xem quickBarHtml.
  function fieldBtnsHtml(it, f, canSheet, canScan) {
    const key = f.spec.key, id = escapeHtml(it.id), a = `data-id="${id}" data-field="${key}"`, name = escapeHtml(f.spec.label);
    const src = it.source[key];
    const pickBtn = (act, on, label, onLabel, title) => `<button type="button" class="btn btn-sm rv-pick ${on ? 'btn-primary is-on' : 'btn-secondary'}" data-act="${act}" ${a} aria-pressed="${on ? 'true' : 'false'}" title="${title}">${on ? onLabel : label}</button>`;
    return {
      tick: f.checked ? `<div class="rv-checked" title="Bạn đã xác nhận đối chiếu trường «${name}» với ảnh phiếu">🖼 Đã đối chiếu ảnh</div>` : '',
      scan: canScan ? pickBtn('field-scan', src === 'scan', '✅ Dữ liệu từ phiếu scan đúng', '✔ Đã chọn: Phiếu scan đúng', `Chỉ trường «${name}»: lấy giá trị bên PHIẾU và ghi vào Sheet (sẽ hỏi xác nhận)`) : '',
      sheet: canSheet ? pickBtn('field-sheet', src === 'sheet', '✅ Google Sheet đúng', '✔ Đã chọn: Sheet đúng', `Chỉ trường «${name}»: giữ nguyên giá trị Google Sheet (sẽ hỏi xác nhận)`) : ''
    };
  }

  // Hộp xác nhận DÙNG CHUNG cho mọi nút chọn nguồn (từng trường lẫn cả xe/cả phiếu). OK = người dùng khẳng định đã xem ảnh + chọn nguồn này.
  const SRC_NAME = { scan: 'Dữ liệu từ phiếu scan đúng', sheet: 'Google Sheet đúng' };
  function confirmSource(mode, scopeText) {
    return window.confirm(`Bạn xác nhận đã đối chiếu với ảnh và chọn «${SRC_NAME[mode]}» với thông tin này?\n\n(${scopeText})`);
  }
  // Sau khi xác nhận: trường đã đối chiếu ảnh; khi MỌI trường cần quyết định của xe đều đã xác nhận thì cả xe = «đã kiểm với ảnh»
  function markFieldsChecked(it, keys) {
    keys.forEach(k => { it.fieldChecked[k] = true; });
    const open = computeView(it).fields.filter(f => !f.spec.meta && isActionable(f.state));
    if (open.every(f => it.fieldChecked[f.spec.key])) { it.imgChecked = true; it.imgCheckedAt = Date.now(); }
  }

  function fieldRowHtml(it, f, v) {
    const key = f.spec.key, col = hdr(key), id = escapeHtml(it.id), orphan = !v.found;
    const leftCls = f.state === 'diff' ? 'diff' : (f.state === 'fill' ? 'fill' : (f.state === 'same' ? 'same' : (f.state === 'sheetedit' ? 'fill' : '')));
    const svT = String(f.scanVal || '').trim(), dsT = String(f.dsVal || '').trim();
    const canSheet = !f.spec.meta && isActionable(f.state);
    // Dòng "khớp" nhưng khác về định dạng (số 0 đầu, dấu, thiếu số cuối...) vẫn cho chọn lấy đúng từ phiếu
    const canScan = !f.spec.meta && (isActionable(f.state) || (f.state === 'same' && svT && svT !== dsT && key !== 'ghiChu'));
    const pick = f.spec.meta ? { tick: '', scan: '', sheet: '' } : fieldBtnsHtml(it, f, canSheet, canScan);
    const btns = '';   // cột «Quyết định» không còn chứa nút chọn nguồn — chúng đã nằm dưới đúng cột nguồn (xem return)
    let dec = '';
    const revert = (f.edited || f.sheetEdit != null) ? `<button type="button" class="rv-revert" data-act="revert" data-id="${id}" data-field="${key}" title="Hoàn tác chỉnh sửa trường này">↺</button>` : '';
    // Trạng thái xe: hiện chữ gốc trên phiếu + nút thêm lựa chọn mới khi chưa có trong danh sách
    let scanExtra = '';
    if (key === 'trangThaiXe') {
      const goc = it.scanData.tinhTrangGoc || it.scanData.tinhTrangLabel;
      if (goc && it.scanData.tinhTrangCode !== 'khong_ro') scanExtra += `<div class="hint">Phiếu ghi: “${escapeHtml(goc)}”</div>`;
      if (isUnknownStatus(f.scanVal)) scanExtra += `<button type="button" class="btn btn-secondary btn-sm" data-act="add-status" data-id="${id}" data-field="${key}" title="Thêm vào danh sách Trạng thái xe ở trang chủ">➕ Thêm «${escapeHtml(f.scanVal)}» vào danh sách Trạng thái xe</button>`;
    }
    if (orphan) dec = `<span class="hint">${f.spec.meta ? 'Ghi kèm khi lưu phiếu lạ.' : 'Xe chưa có trong DS — sẽ ghi vào cột «Phiếu lạ» (AL–AP) ở hàng mới khi cập nhật.'}</span>${btns}`;
    else if (f.state === 'empty') dec = `<span class="hint">${key === 'nguoiThucHien' ? 'Chọn người thực hiện bên trái để ghi.' : 'Phiếu không có giá trị — nhập/chọn bên trái nếu nhìn ảnh thấy.'}</span>${btns}`;
    else if (f.state === 'same') dec = '<span class="rv-same">✔ Khớp</span>' + (f.note ? `<div class="hint">${escapeHtml(f.note)}</div>` : '') + btns;
    else {
      const opts = ['apply', 'skip'].concat(f.spec.meta ? [] : ['later']).concat(f.sheetEdit != null ? ['sheetfix'] : []);
      const tagNote = (!f.spec.meta && prefs.tag && f.decision === 'apply') ? ' + dấu 📷 trong «Ghi Chú»' : '';
      let target = '→ không ghi gì';
      if (f.decision === 'apply') target = f.writeVal != null ? `→ ghi vào cột «${escapeHtml(col)}» (từ PHIẾU): <b>${escapeHtml(f.writeVal)}</b>${tagNote}` : '→ (chưa có giá trị để ghi)';
      else if (f.decision === 'sheetfix') target = `→ ghi giá trị Sheet đã sửa vào cột «${escapeHtml(col)}»: <b>${escapeHtml(f.writeVal || '')}</b>`;
      else if (f.decision === 'later') target = '→ chỉ ghi cảnh báo vào cột «Kết quả đối chiếu phiếu»';
      else if (f.decision === 'skip') target = '→ giữ nguyên Google Sheet';
      dec = `<select class="row-inline-select rv-dec rv-dec-${f.decision}" data-act="decide" data-id="${id}" data-field="${key}">` +
        opts.map(k => `<option value="${k}" ${f.decision === k ? 'selected' : ''}>${DEC_LABEL[k]}</option>`).join('') + '</select>' +
        (f.note ? `<div class="hint">${escapeHtml(f.note)}</div>` : '') +
        `<div class="rv-target ${willWrite(f) ? 'on' : ''}">${target}</div>` + btns +
        (willWrite(f) ? `<button type="button" class="btn btn-ghost btn-sm" data-act="apply-field" data-id="${id}" data-field="${key}" title="Chỉ ghi trường này, các trường khác giữ nguyên">⚡ Áp dụng riêng trường này</button>` : '');
    }
    const src = it.source[key];
    const right = orphan ? '<div class="rv-cell right na"><span class="rv-src-tag sheet">📋 GOOGLE SHEET</span>— Không có trên Google Sheet —</div>'
      : `<div class="rv-cell right ${f.sheetEdit != null ? 'edited' : ''} ${src === 'sheet' ? 'picked' : ''}"><span class="rv-src-tag sheet">📋 GOOGLE SHEET</span>${editorHtml(it, f, 'sheet')}${deadHtml(it, f)}${pick.sheet ? `<div class="rv-pick-row">${pick.sheet}</div>` : ''}</div>`;
    return `<div class="rv-row ${f.spec.meta ? 'rv-meta' : ''}" data-field="${key}"><div class="rv-field"><b>${escapeHtml(f.spec.label)}</b><div class="hint">cột «${escapeHtml(col)}»</div>${pick.tick}</div>
      <div class="rv-cell left ${leftCls} ${f.edited ? 'edited' : ''} ${src === 'scan' ? 'picked' : ''}"><span class="rv-src-tag scan">📷 PHIẾU SCAN</span>${editorHtml(it, f, 'scan')}${revert}${scanExtra}${pick.scan ? `<div class="rv-pick-row">${pick.scan}</div>` : ''}</div>
      ${right}
      <div class="rv-dec-cell"><span class="rv-src-tag dec">⚙ QUYẾT ĐỊNH</span>${dec}</div></div>`;
  }

  /* ---- Chủ xe ĐÃ CHẾT: tick ở ô Google Sheet → tên tự thêm « (Đã chết)» (bỏ tick → gỡ lại) ---- */
  function deadHtml(it, f) {
    if (f.spec.key !== 'chuXe') return '';
    const cur = String(f.sheetEdit != null ? f.sheetEdit : (f.dsVal || '')).trim();
    return `<label class="rv-dead ${isDead(cur) ? 'on' : ''}" title="Tick nếu chủ xe đã mất: tên trên Sheet sẽ có thêm “${DEAD_SUFFIX.trim()}”">
      <input type="checkbox" data-act="toggle-dead" data-id="${escapeHtml(it.id)}" data-field="chuXe" ${isDead(cur) ? 'checked' : ''} ${cur ? '' : 'disabled'}> ⚰ Chủ xe đã chết</label>`;
  }
  async function onToggleDead(it, checked) {
    const v = computeView(it); if (!v.row) return;
    const cur = String((it.sheetEdits.chuXe != null) ? it.sheetEdits.chuXe : (v.row.chuXe || '')).trim();
    if (!cur) return;
    await onEditSheet(it, 'chuXe', checked ? stripDead(cur) + DEAD_SUFFIX : stripDead(cur));
  }

  /* ---- NGƯỜI MUA / NGƯỜI SỬ DỤNG XE: thông tin trên phiếu không phải của chủ xe → ghi sang cột riêng trên Sheet ----
     Chọn vai trò → các ô Họ tên / Địa chỉ / CCCD / SĐT lấy sẵn từ phiếu (sửa được) → «Cập nhật vào Sheet».
     Khi đã chọn vai trò, CCCD / SĐT / Họ tên trên phiếu KHÔNG còn bị đem so với Chủ xe trên Sheet (xem scanValue). */
  function partyHtml(v) {
    const it = v.it; if (!v.found) return '';
    const id = escapeHtml(it.id), role = it.partyRole, inUser = userMode(it);
    // Giá trị hiển thị của ô chọn: '' = mặc định (tự theo phiếu) · buyer · user · none = tắt «Người sử dụng»
    const cur = it.userSkip && !role ? 'none' : role;
    const opts = [['', inUser ? '— Tự động: phiếu có dòng người mua / sử dụng —' : '— Phiếu là của chủ xe (mặc định) —']]
      .concat(Object.keys(PARTY_ROLES).map(r => [r, '👤 Là của ' + PARTY_ROLES[r].label]))
      .concat(it.scanData.nguoiDung ? [['none', '🚫 Không có người sử dụng']] : []);
    let body = '';
    if (inUser) {   // Người sử dụng xe: đã nằm trong BẢNG ĐỐI CHIẾU (4 dòng AH–AK) → không cần khung nhập riêng
      body = `<div class="hint">Đã đưa vào bảng đối chiếu bên trên (4 dòng «Người sử dụng xe - …», cột AH–AK của Sheet): so với Sheet, sửa phiếu / sửa Sheet, chọn nguồn và xác nhận như Chủ phương tiện.</div>`;
    } else if (role) {   // Người mua: giữ khung nhập riêng như cũ
      const cols = PARTY_FIELDS.map(f => {
        const curVal = String((v.row && v.row[partyKey(role, f)]) || '').trim(), val = partyValue(it, f);
        return `<label class="rv-party-f"><span>${f.label}</span>
          <input type="text" class="rv-edit" data-act="party-edit" data-id="${id}" data-field="${f.k}" value="${escapeHtml(val)}" placeholder="${f.label}" autocomplete="off">
          <small class="hint">Sheet: ${curVal ? escapeHtml(curVal) : '<i>(trống / chưa có cột)</i>'}</small></label>`;
      }).join('');
      const done = it.partyDoneAt ? `<span class="rv-checked">✔ Đã cập nhật ${new Date(it.partyDoneAt).toLocaleString('vi-VN')}</span>` : '<span class="rv-unchecked">Chưa cập nhật lên Sheet</span>';
      body = `<div class="rv-party-grid">${cols}</div><div class="rv-party-act">${done}
        <button type="button" class="btn btn-primary btn-sm" data-act="party-apply" data-id="${id}" title="Ghi vào các cột «${PARTY_ROLES[role].label} - …» (tự thêm cột nếu chưa có)">⬆ Cập nhật ${PARTY_ROLES[role].label} vào Sheet</button></div>`;
    }
    return `<div class="rv-party ${(role || inUser) ? 'on' : ''}"><label class="rv-party-head">👥 Thông tin trên phiếu là của:
      <select class="row-inline-select" data-act="party-role" data-id="${id}">${opts.map(([k, l]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${body}</div>`;
  }
  async function onPartyRole(it, role) {
    await track(it, 'Chọn người mua / sử dụng', async () => {
      it.userSkip = role === 'none';                                  // «Không có người sử dụng» = tắt tự động đưa 4 trường AH–AK vào bảng
      it.partyRole = PARTY_ROLES[role] ? role : ''; it.partyDoneAt = null;
      // Đổi chế độ => quyết định / nguồn đã chọn cho 4 trường người sử dụng không còn ý nghĩa
      if (!userMode(it)) USER_SPECS.forEach(sp => { delete it.decisions[sp.key]; delete it.source[sp.key]; delete it.sheetEdits[sp.key]; delete it.fieldChecked[sp.key]; });
      await persistEdit(it);
    });
    rerenderCard(it);
  }
  async function onPartyEdit(it, k, val) {
    const f = PARTY_FIELDS.find(x => x.k === k); if (!f) return;
    await track(it, 'Sửa thông tin ' + f.label, async () => {
      it.partyEdits[k] = String(val || '').trim(); it.partyDoneAt = null; await persistEdit(it);
    });
    scheduleRerender(it);
  }
  async function onPartyApply(it) {
    const v = computeView(it), role = it.partyRole;
    if (!v.row || !PARTY_ROLES[role]) return;
    const toWrite = {};
    PARTY_FIELDS.forEach(f => { toWrite[partyKey(role, f)] = partyValue(it, f); });
    if (!PARTY_FIELDS.some(f => partyValue(it, f))) { toast('Chưa có thông tin nào để cập nhật.', true); return; }
    if (!confirm(`Bạn xác nhận đã đối chiếu với ảnh và ghi thông tin này là của ${PARTY_ROLES[role].label.toUpperCase()} (xe ${it.bienSoRaw || ''}) vào Google Sheet?\n` +
      PARTY_FIELDS.map(f => `• ${f.label}: ${partyValue(it, f) || '(trống)'}`).join('\n') + '\n\nCột chưa có sẽ được tự thêm vào cột trống.')) return;
    const keys = Object.keys(toWrite), before = clone(it), rowBefore = rowSnap(v.row, keys);
    await updateSingleRowFields(v.row, toWrite);
    it.partyDoneAt = Date.now(); it.imgChecked = true; it.imgCheckedAt = it.imgCheckedAt || Date.now();   // xác nhận = đã đối chiếu ảnh
    await saveItem(it);
    record('Cập nhật ' + PARTY_ROLES[role].label + ' vào Sheet', [{ id: it.id, before, after: clone(it), rowId: v.row._rowId, rowBefore, rowAfter: rowSnap(v.row, keys) }]);
    refreshMainTable(); rerenderCard(it);
    toast(`Đã cập nhật ${PARTY_ROLES[role].label} (${v.row.bienSo || it.bienSoRaw}). ` + (isWriteConnected() ? 'Đang đồng bộ ngầm lên Google Sheet…' : 'Mới lưu trên máy.'));
  }

  /* ---- THÊM TRƯỜNG THÔNG TIN MỚI ---- */
  function customHtml(v) {
    const it = v.it; if (!v.found) return '';
    const id = escapeHtml(it.id), list = it.customFields || [], dlId = 'cfNames-' + id;
    const names = cfLoadDefs().map(d => `<option value="${escapeHtml(d.header)}"></option>`).join('');
    const rows = list.map(cf => {
      const cur = String((v.row && v.row[cf.key]) || '').trim(), cid = escapeHtml(cf.id);
      const st = cf.doneAt ? `<span class="rv-checked" title="${escapeHtml(new Date(cf.doneAt).toLocaleString('vi-VN'))}">✔ Đã ghi lên Sheet</span>` : '<span class="rv-unchecked">Chưa ghi lên Sheet</span>';
      return `<div class="rv-cf-row">
        <div class="rv-cf-name" title="Tiêu đề cột trên Sheet">🏷 ${escapeHtml(cf.name)}</div>
        <div class="rv-cf-val"><input type="text" class="rv-edit" data-act="cf-edit" data-id="${id}" data-field="${cid}" value="${escapeHtml(cf.value)}" placeholder="Giá trị" autocomplete="off">
          <small class="hint">Sheet: ${cur ? escapeHtml(cur) : '<i>(trống / chưa có cột)</i>'}</small></div>
        <div class="rv-cf-act">${st}
          <button type="button" class="btn btn-primary btn-sm" data-act="cf-apply" data-id="${id}" data-field="${cid}" title="Ghi vào cột «${escapeHtml(cf.name)}» (tự tạo cột nếu chưa có)">⬆ Ghi lên Sheet</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="cf-del" data-id="${id}" data-field="${cid}" title="Bỏ trường này khỏi phiếu (không xóa dữ liệu đã ghi trên Sheet)">🗑</button></div>
      </div>`;
    }).join('');
    const all = list.length > 1 ? `<button type="button" class="btn btn-secondary btn-sm" data-act="cf-apply-all" data-id="${id}">⬆ Ghi tất cả trường mới lên Sheet</button>` : '';
    return `<div class="rv-custom ${list.length ? 'on' : ''}">
      <div class="rv-custom-head">➕ Thêm thông tin mới <small>— trường mà hệ thống chưa nhận ra (vd. người đang sử dụng xe). Ghi lên Sheet sẽ tự tạo cột mới nếu chưa có.</small></div>
      ${rows}
      <div class="rv-cf-add">
        <input type="text" class="rv-edit" data-cf="name" list="${dlId}" maxlength="60" placeholder="Tên trường (vd: Người đang sử dụng xe)" autocomplete="off">
        <input type="text" class="rv-edit" data-cf="value" placeholder="Giá trị" autocomplete="off">
        <button type="button" class="btn btn-secondary btn-sm" data-act="cf-add" data-id="${id}">➕ Thêm trường</button>${all}
        <datalist id="${dlId}">${names}</datalist>
      </div>
    </div>`;
  }
  async function onCfAdd(it, root) {
    if (!root) return;
    const nameEl = root.querySelector('[data-cf="name"]'), valEl = root.querySelector('[data-cf="value"]');
    const name = String(nameEl.value || '').replace(/\s+/g, ' ').trim(), value = String(valEl.value || '').trim();
    if (!name) { toast('Hãy nhập tên trường.', true); nameEl.focus(); return; }
    if (!cfPlain(name)) { toast('Tên trường phải có ít nhất một chữ hoặc số.', true); nameEl.focus(); return; }
    if (!value) { toast(`Hãy nhập giá trị cho trường «${name}».`, true); valEl.focus(); return; }
    const defs = cfLoadDefs(), plain = cfPlain(name);
    let def = defs.find(d => cfPlain(d.header) === plain);            // đã từng thêm (kể cả ở xe khác) → dùng lại đúng tiêu đề cột
    if (!def) {
      const builtin = (typeof FIELD_MAP !== 'undefined' ? FIELD_MAP : []).find(f => !String(f.key).startsWith(CF_PREFIX) && cfPlain(f.header) === plain);
      if (builtin) { toast(`«${name}» đã là cột có sẵn của hệ thống («${builtin.header}») — hãy sửa ở dòng đối chiếu tương ứng.`, true); return; }
      def = { key: cfKey(name), header: name };
    }
    if ((it.customFields || []).some(c => c.key === def.key)) { toast(`Xe này đã có trường «${def.header}» — hãy sửa giá trị ở dòng đó.`, true); return; }
    if (!cfRegister(def)) { toast('Chưa đăng ký được trường mới (app.js chưa nạp xong). Tải lại trang rồi thử lại.', true); return; }
    if (!defs.some(d => d.key === def.key)) { defs.push(def); cfSaveDefs(defs); }
    await track(it, `Thêm trường «${def.header}»`, async () => {
      it.customFields.push({ id: 'cf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), key: def.key, name: def.header, value, doneAt: null });
      await persistEdit(it);
    });
    rerenderCard(it);
    toast(`Đã thêm trường «${def.header}». Bấm «⬆ Ghi lên Sheet» để cập nhật.`);
  }
  async function onCfEdit(it, cfid, val) {
    const cf = (it.customFields || []).find(c => c.id === cfid); if (!cf) return;
    await track(it, `Sửa trường «${cf.name}»`, async () => { cf.value = String(val || '').trim(); cf.doneAt = null; await persistEdit(it); });
    scheduleRerender(it);
  }
  async function onCfDel(it, cfid) {
    const cf = (it.customFields || []).find(c => c.id === cfid); if (!cf) return;
    if (cf.doneAt && !confirm(`Bỏ trường «${cf.name}» khỏi phiếu này?\nGiá trị đã ghi trên Google Sheet sẽ KHÔNG bị xóa.`)) return;
    await track(it, `Xóa trường «${cf.name}»`, async () => { it.customFields = it.customFields.filter(c => c.id !== cfid); await persistEdit(it); });
    rerenderCard(it);
  }
  async function onCfApply(it, ids) {                                   // ids = mảng id trường; null = tất cả
    const v = computeView(it);
    if (!v.row) { toast('Xe này chưa có trong danh sách nên chưa ghi được lên Sheet.', true); return; }
    const cfs = (it.customFields || []).filter(c => (!ids || ids.includes(c.id)) && String(c.value || '').trim());
    if (!cfs.length) { toast('Chưa có giá trị nào để ghi.', true); return; }
    const toWrite = {};
    cfs.forEach(c => { cfRegister({ key: c.key, header: c.name }); toWrite[c.key] = String(c.value).trim(); });
    const lines = cfs.map(c => { const old = String(v.row[c.key] || '').trim(); return `• ${c.name}: ${toWrite[c.key]}` + (old && old !== toWrite[c.key] ? `   (Sheet đang là: ${old} → sẽ bị thay)` : ''); });
    if (!confirm(`Bạn xác nhận đã đối chiếu với ảnh và ghi thông tin sau cho xe ${it.bienSoRaw || ''} vào Google Sheet?\n${lines.join('\n')}\n\nCột chưa có sẽ được tự tạo; cột đã có cùng tên sẽ được ghi đè ở dòng xe này.`)) return;
    const keys = Object.keys(toWrite), before = clone(it), rowBefore = rowSnap(v.row, keys);
    await updateSingleRowFields(v.row, toWrite);
    cfs.forEach(c => { c.doneAt = Date.now(); });
    it.imgChecked = true; it.imgCheckedAt = it.imgCheckedAt || Date.now();   // xác nhận = đã đối chiếu ảnh
    await saveItem(it);
    record('Ghi trường mới lên Sheet', [{ id: it.id, before, after: clone(it), rowId: v.row._rowId, rowBefore, rowAfter: rowSnap(v.row, keys) }]);
    refreshMainTable(); rerenderCard(it);
    toast(`Đã cập nhật ${cfs.length} trường mới (${v.row.bienSo || it.bienSoRaw}). ` + (isWriteConnected() ? 'Đang đồng bộ ngầm lên Google Sheet…' : 'Mới lưu trên máy.'));
  }

  // Khung «CẢ XE / CẢ PHIẾU»: các nút áp dụng cho TOÀN BỘ xe này (mọi trường khác biệt), tách hẳn khỏi nút của từng trường.
  // Xe đã khớp: giữ hết Sheet / lấy hết phiếu / ký cam kết. Phiếu lạ: thêm hàng mới vào sheet / không ghi. Dùng cho cả thẻ lẫn khung ảnh.
  function quickBarHtml(it, found) {
    const id = escapeHtml(it.id), plate = escapeHtml(it.bienSoRaw || it.bienSo || '');
    // Không còn ô tick «Đã kiểm ảnh»: trạng thái này tự bật khi người dùng xác nhận chọn nguồn (chỉ hiển thị, không bấm được)
    const tick = it.imgChecked ? '<span class="rv-checked" title="Bạn đã xác nhận đối chiếu với ảnh phiếu">🖼 Đã kiểm với ảnh</span>' : '<span class="rv-unchecked" title="Chưa xác nhận đối chiếu ảnh — bấm một nút chọn nguồn để xác nhận">🖼 Chưa kiểm ảnh</span>';
    const head = `<span class="rv-scope-title">🚗 CẢ XE${plate ? ' ' + plate : ''} <small>— áp dụng cho TẤT CẢ trường</small></span>`;
    let btns;
    if (found) btns = `<span class="rv-scope-lbl">Mọi trường khác biệt:</span>
      <button type="button" class="btn btn-secondary btn-sm" data-act="quick-sheet" data-id="${id}" title="CẢ XE: mọi trường khác biệt giữ nguyên Google Sheet (sẽ hỏi xác nhận)">📋 Cả xe: Google Sheet đúng</button>
      <button type="button" class="btn btn-primary btn-sm" data-act="quick-scan" data-id="${id}" title="CẢ XE: mọi trường khác biệt lấy giá trị từ phiếu, gồm cả chỗ đã chỉnh sửa (sẽ hỏi xác nhận)">📷 Cả xe: Dữ liệu từ phiếu scan đúng</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="quick-sign" data-id="${id}" title="Đặt Tình trạng cam kết = ${escapeHtml(SIGNED)}">✍️ Phiếu đã ký cam kết</button>`;
    else btns = it.bienSo
      ? `<span class="rv-scope-lbl">Xe chưa có trong danh sách:</span>
      <button type="button" class="btn btn-primary btn-sm" data-act="orphan-apply" data-id="${id}" title="Dữ liệu phiếu (đã chỉnh sửa) đúng: ghi vào cột «Phiếu lạ» AL–AP ở 1 HÀNG MỚI cuối sheet đang làm việc, các cột khác để trống (sẽ hỏi xác nhận)">📷 Dữ liệu từ phiếu scan đúng → ghi phiếu lạ (AL–AP)</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="orphan-skip" data-id="${id}">⏭ Không ghi</button>`
      : '<span class="hint">Nhập biển số (ô bên trên) để đối chiếu / ghi.</span>';
    return `<div class="rv-scope">${head}<div class="rv-scope-body">${tick}<span class="rv-scope-sep" aria-hidden="true"></span>${btns}</div></div>`;
  }

  /* ---- Sửa BIỂN SỐ khi scan sai + tự tìm biển khớp trong danh sách ---- */
  function lev(a, b) {
    const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  // Biển trong DS "gần giống" biển đang nhập: chứa/được chứa (gõ thiếu-thừa ký tự) hoặc lệch ≤1–2 ký tự. KHÔNG tự gán — người dùng bấm chọn.
  function findPlateCandidates(p, max = 6) {
    if (!p || p.length < 4) return [];
    const out = [];
    for (const [k, rows] of dsIndex()) {
      if (k === p) continue;
      let score = null;
      if (Math.min(k.length, p.length) >= 4 && (k.includes(p) || p.includes(k))) score = 0.5 + Math.abs(k.length - p.length) * 0.1;
      else if (Math.abs(k.length - p.length) <= 1) { const d = lev(k, p); if (d <= (p.length >= 7 ? 2 : 1)) score = d; }
      if (score != null) out.push({ k, score, row: rows[0] });
    }
    return out.sort((x, y) => x.score - y.score).slice(0, max);
  }
  function plateSuggestHtml(v) {
    const it = v.it; if (v.found) return '';
    if (!it.bienSo) return '<div class="rv-sugg"><span class="hint">Chưa đọc được biển số — nhập biển vào ô trên, hệ thống sẽ tự tìm xe khớp trong danh sách.</span></div>';
    const cands = findPlateCandidates(it.bienSo);
    return `<div class="rv-sugg">${cands.length ? '<span class="hint">🔎 Không có «' + escapeHtml(it.bienSoRaw) + '» trong DS. Biển gần giống — bấm để chọn:</span> ' +
      cands.map(c => `<button type="button" class="btn btn-secondary btn-sm" data-act="pick-plate" data-id="${escapeHtml(it.id)}" data-plate="${escapeHtml(c.row.bienSo)}" title="${escapeHtml(c.row.chuXe || '')}">${escapeHtml(c.row.bienSo)}${c.row.chuXe ? ' · ' + escapeHtml(c.row.chuXe) : ''}</button>`).join(' ')
      : '<span class="hint">🔎 Không có biển nào khớp / gần giống trong DS — sửa lại biển số nếu scan sai, hoặc xử lý như phiếu lạ.</span>'}</div>`;
  }
  const staleRow = (ref) => !!ref;
  async function onEditPlate(it, raw) {
    const rawT = String(raw || '').trim().toUpperCase(), plate = norm(rawT), oldPlate = it.bienSo;
    if (plate === it.bienSo && rawT === (it.bienSoRaw || '')) return;
    if (it.done && !confirm('Mục này đã được áp dụng cho biển «' + (it.bienSoRaw || '?') + '». Đổi biển số sẽ đối chiếu lại từ đầu (dữ liệu đã ghi trước đó KHÔNG tự hoàn tác — dùng «Quay lại bước trước» nếu cần). Tiếp tục?')) { rerenderCard(it); return; }
    // Phiếu lạ ĐÃ ghi thành hàng mới trên Sheet mà nay đổi sang biển khác -> hàng đó thành thừa, phải xóa (nếu trùng xe có sẵn thì chuyển dữ liệu trước)
    const staleRef = (it.orphanSheet && it.orphanSheetPlateRaw && norm(it.orphanSheetPlateRaw) !== plate)
      ? { scanId8: id8(it), plateRaw: it.orphanSheetPlateRaw, sheetName: it.orphanSheetName || '' } : null;
    const dupTarget = !!(staleRow(staleRef) && plate && dsIndex().has(plate));
    if (staleRef && !confirm(dupTarget
      ? `Biển «${rawT}» ĐÃ CÓ trong danh sách xe.\n\n• Dữ liệu phiếu sẽ được chuyển vào đúng dòng xe «${rawT}» (chỉ điền ô đang trống; ô khác biệt để bạn quyết định, không ghi đè).\n• Sau đó HÀNG PHIẾU LẠ «${staleRef.plateRaw}» đã ghi trước đó sẽ bị XÓA khỏi Sheet.\n\nTiếp tục?`
      : `Phiếu «${staleRef.plateRaw}» đã được ghi thành hàng mới trên Sheet. Đổi sang biển «${rawT || '(trống)'}» (chưa có trong danh sách) sẽ XÓA hàng cũ đó; bạn bấm «Cập nhật» lại để ghi hàng mới với biển đúng. Tiếp tục?`)) { rerenderCard(it); return; }
    await track(it, `Sửa biển số ${it.bienSoRaw || '?'} → ${rawT || '?'}`, async () => {
      if (staleRef) { it.orphanStale = staleRef; it.orphanSheet = false; it.orphanSheetPlateRaw = ''; it.orphanSheetRow = null; }
      it.bienSoRaw = rawT; it.bienSo = plate; it.plateEdited = true;
      // Đổi xe đích = đối chiếu lại từ đầu (giữ giá trị phiếu đã sửa tay; xác nhận đối chiếu ảnh cũ không còn đúng với xe mới nên xóa)
      it.fieldChecked = {}; it.imgChecked = false; it.imgCheckedAt = null;
      it.decisions = {}; it.source = {}; it.sheetEdits = {}; it.applied = {}; it.sheetOk = {}; it.fixed = {};
      it.orphanDecision = null; it.orphanPushed = false; it.pushError = ''; it.done = false; it.dirty = false; it.review = 'chua_kiem'; it.result = '';
      await saveItem(it);
    });
    await recomputeLink(oldPlate); await recomputeLink(plate);
    if (staleRef) {
      try {
        if (dupTarget) await moveOrphanDataToExisting(it);            // 1) chuyển dữ liệu về đúng xe có sẵn  2) CHỈ KHI ghi xong mới xóa hàng lạ
        await cleanupOrphanRow(it);
      } catch (e) { it.pushError = 'Chuyển dữ liệu lỗi, CHƯA xóa hàng phiếu lạ: ' + (e.message || e); await saveItem(it); toast(it.pushError, true); }
    }
    refreshMainTable(); rerenderCard(it);
    const found = plate && dsIndex().has(plate);
    toast(!plate ? 'Đã xóa biển số.' : (found ? `✔ Tìm thấy ${rawT} trong danh sách — đã tự đối chiếu.` : `Không có «${rawT}» trong danh sách — xem gợi ý biển gần giống.`), !plate ? false : !found);
  }

  function cardHtml(v) {
    const it = v.it, cat = viewCategory(v);
    const plate = it.bienSoRaw || '(không đọc được biển số)';
    const badges = [`<span class="rv-badge ${cat}">${CAT_LABEL[cat]}${cat === 'diff' ? ` (${v.actionable})` : ''}</span>`,
      `<span class="rv-badge ${it.review}">${it.review === 'da_kiem' ? '✔ Đã kiểm' : '○ Chưa kiểm'}</span>`];
    if (it.imgChecked) badges.push('<span class="rv-badge applied">🖼 Đã kiểm với ảnh</span>');
    if (userMode(it)) badges.push(`<span class="rv-badge warn" title="Dòng «người mua / sử dụng» trên phiếu → đối chiếu với cột AH–AK «Người sử dụng xe - …» ở bảng bên dưới.">👥 Người sử dụng: ${escapeHtml(partyValue(it, PARTY_FIELDS[0]) || '(chưa rõ tên)')}</span>`);
    else if (it.scanData.partyTen && !it.partyRole) badges.push(`<span class="rv-badge warn" title="Theo phiếu: người mua / sử dụng ≠ chủ xe đứng tên ĐKX. Chọn mục «Thông tin trên phiếu là của» để ghi sang cột riêng.">👥 Người mua / sử dụng: ${escapeHtml(it.scanData.partyTen)}</span>`);
    if (v.rowCount > 1) badges.push(`<span class="rv-badge warn" title="Có ${v.rowCount} dòng cùng biển trên Sheet; chỉ cập nhật dòng đầu">⚠ ${v.rowCount} dòng trùng biển</span>`);
    if (it.done && !it.dirty) badges.push('<span class="rv-badge applied">Đã áp dụng</span>');
    let body = v.fields.map(f => fieldRowHtml(it, f, v)).join('');
    if (it.orphanSheet && v.found) {   // hàng phiếu lạ đã ghi và đã tải lại -> vẫn cho xử lý nếu hóa ra trùng xe có sẵn
      const cands = findPlateCandidates(it.bienSo);
      body = `<div class="rv-row"><div class="rv-sugg" style="grid-column: 1 / -1"><span class="hint">🆕 Đây là hàng PHIẾU LẠ vừa thêm vào Sheet${it.orphanSheetRow ? ' (dòng ' + it.orphanSheetRow + ')' : ''}. Nếu thực ra là xe đã có, ${cands.length ? 'bấm biển gần giống:' : 'sửa biển số ở trên thành biển đúng'} — dữ liệu sẽ chuyển về xe đó và hàng này bị xóa.</span> ` +
        cands.map(c => `<button type="button" class="btn btn-secondary btn-sm" data-act="pick-plate" data-id="${escapeHtml(it.id)}" data-plate="${escapeHtml(c.row.bienSo)}">${escapeHtml(c.row.bienSo)}${c.row.chuXe ? ' · ' + escapeHtml(c.row.chuXe) : ''}</button>`).join(' ') + '</div></div>' + body;
    }
    if (cat === 'orphan') {   // phiếu lạ: vẫn đủ các trường để xem/sửa như phiếu đã khớp, thêm 1 dòng quyết định xử lý
      const dec = it.orphanDecision || 'later';
      body += `<div class="rv-row rv-orphan-row"><div class="rv-field">Xử lý phiếu lạ</div>
        <div class="rv-cell left" style="grid-column: 2 / 4"><b>Không có trong danh sách xe.</b><div class="hint">Không tự gán sang biển gần giống. Khi bấm «Cập nhật» sẽ ghi 1 HÀNG MỚI cuối sheet, CHỈ vào 5 cột «Phiếu lạ» AL–AP (các cột khác để trống). Nếu thực ra là xe đã có: bấm biển gần giống / sửa biển số ở trên — dữ liệu chuyển về đúng xe và hàng mới bị xóa.</div></div>
        <div class="rv-dec-cell">${it.bienSo ? `<select class="row-inline-select rv-dec rv-dec-${dec}" data-act="decide-orphan" data-id="${escapeHtml(it.id)}">` +
          [['apply', '📥 Thêm hàng mới vào sheet'], ['skip', '⏭ Không ghi'], ['later', '🕓 Để kiểm sau']].map(([k, l]) => `<option value="${k}" ${dec === k ? 'selected' : ''}>${l}</option>`).join('') + '</select>' : '<span class="hint">Chưa có biển số — chỉ lưu local</span>'}
          ${it.pushError ? `<div class="error-text">${escapeHtml(it.pushError)}</div>` : ''}${it.orphanSheet ? `<div class="rv-same">✔ Đã ghi thành hàng mới${it.orphanSheetRow ? ' (dòng ' + it.orphanSheetRow + ')' : ''}</div>` : ''}${it.orphanStale ? `<div class="error-text">Còn hàng phiếu lạ «${escapeHtml(it.orphanStale.plateRaw)}» chưa xóa khỏi Sheet. <button type="button" class="btn btn-secondary btn-sm" data-act="orphan-cleanup" data-id="${escapeHtml(it.id)}">🧹 Xóa hàng phiếu lạ</button></div>` : ''}</div></div>`;
    }
    const focus = R.pane.open && R.pane.id === it.id ? ' rv-focus' : '';
    return `<div class="rv-card rv-${cat}${focus}" data-id="${escapeHtml(it.id)}">
      <div class="rv-card-head">
        <label class="rv-plate-edit" title="Sửa biển số nếu scan sai — hệ thống tự tìm xe khớp trong danh sách">🚗 <input type="text" class="rv-edit rv-plate-input" data-act="edit-plate" data-id="${escapeHtml(it.id)}" value="${escapeHtml(it.bienSoRaw || '')}" placeholder="Nhập biển số" autocomplete="off"></label> ${badges.join(' ')}
        <span class="hint rv-src">${escapeHtml(it.sheetLabel)}${it.scanData.tinhTrangGoc ? ' · trên phiếu: “' + escapeHtml(it.scanData.tinhTrangGoc) + '”' : ''}</span>
        <span class="rv-card-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="view" data-id="${escapeHtml(it.id)}" title="Mở ảnh phiếu cạnh bảng so sánh để vừa xem vừa sửa">📷 Xem ảnh phiếu</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="apply-one" data-id="${escapeHtml(it.id)}" ${!state.rawData.length ? 'disabled' : ''}>✅ Áp dụng xe này</button>
        </span>
      </div>
      <div class="rv-quick">${quickBarHtml(it, v.found)}</div>
      ${partyHtml(v)}
      ${customHtml(v)}
      ${plateSuggestHtml(v)}
      <div class="rv-split"><div class="rv-split-head"><div class="rv-head-plate" title="Xe đang đối chiếu">🚗 ${escapeHtml(it.bienSoRaw || '(chưa có biển)')}</div><div class="left src-scan">📷 TỪ PHIẾU SCAN <span class="hint">(sửa được)</span></div><div class="right src-sheet">📋 TRÊN GOOGLE SHEET <span class="hint">(sửa được)</span></div><div class="dec">⚙ Quyết định · ghi vào đâu</div></div>${body}</div>
      ${v.found ? `<div class="hint rv-result">Kết quả đối chiếu sẽ ghi: <i>${escapeHtml(buildResultText(v, plannedFromScan(v)))}</i></div>` : ''}
    </div>`;
  }

  function renderStats(views) {
    const cnt = { match: 0, diff: 0, orphan: 0, da: 0, chua: 0, img: 0, later: 0, noChecker: 0 };
    views.forEach(v => { if (hasLater(v)) cnt.later++; if (!checkerOf(v)) cnt.noChecker++; cnt[viewCategory(v)]++; if (v.it.review === 'da_kiem') cnt.da++; else cnt.chua++; if (v.it.imgChecked) cnt.img++; });
    const withScan = new Set(R.items.filter(i => i.bienSo && dsIndex().has(i.bienSo)).map(i => i.bienSo));
    const dsNoScan = (state.rawData || []).filter(r => !withScan.has(norm(r.bienSo))).length;
    $('#rvStats').innerHTML = `<b>${views.length}</b> xe trên phiếu · khớp hoàn toàn <b>${cnt.match}</b> · có khác biệt <b>${cnt.diff}</b> · phiếu lạ <b class="${cnt.orphan ? 'scan-warn' : ''}">${cnt.orphan}</b> · đã kiểm <b>${cnt.da}</b> · chưa kiểm <b>${cnt.chua}</b> · 🖼 đã kiểm với ảnh <b>${cnt.img}/${views.length}</b> · 🕓 để kiểm sau <b>${cnt.later}</b> · chưa có người kiểm <b class="${cnt.noChecker ? 'scan-warn' : ''}">${cnt.noChecker}</b> · DS chưa có phiếu <b>${dsNoScan}</b>`;
  }

  function renderReview() {
    syncStickyOffset();
    const scroller = document.querySelector('#scanReviewModal .modal-body'), keepTop = scroller ? scroller.scrollTop : 0;
    const views = R.items.map(computeView);
    renderStats(views); buildCheckerSelect(views);
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
    if (scroller) scroller.scrollTop = keepTop;   // vẽ lại xong vẫn giữ vị trí đang làm việc
    updateHistoryButtons();
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
        if ((v.it.orphanDecision) === 'apply' && v.it.bienSo) { orphanPush++; lines.push(`<li><b>${P}</b> (phiếu lạ) → thêm 1 <b>hàng mới</b> vào sheet</li>`); }
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

  /* ---- LỊCH SỬ THAO TÁC: «Quay lại bước trước» / «Tới bước sau» ----
     Mỗi thao tác = 1 bước, lưu ảnh chụp mục (item) TRƯỚC/SAU và, nếu có ghi vào Sheet, cả các cột của dòng xe TRƯỚC/SAU
     => quay lại sẽ khôi phục luôn giá trị trên Sheet (qua updateSingleRowFields nên vẫn đồng bộ ngầm). Chỉ giữ trong phiên. */
  const HIST = { undo: [], redo: [], max: 100 };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const ROW_KEYS = ['trangThaiXe', 'chuXe', 'cccd', 'soDienThoai', 'ghiChu', 'tinhTrangCamKet', 'nguoiThucHien', 'phieuScan', 'kiemPhieu', 'ketQuaPhieu', ...USER_SPECS.map(sp => sp.key)];   // gồm 4 cột Người sử dụng (AH–AK) để hoàn tác
  // extra = các khóa cột phụ (vd. cột Người mua / Người sử dụng) cần chụp thêm để hoàn tác được
  const rowSnap = (row, extra = []) => row ? Object.fromEntries(ROW_KEYS.concat(extra).map(k => [k, row[k] || ''])) : null;
  const findRow = (rowId) => state.rawData.find(r => r._rowId === rowId);
  const labelOf = (k) => (SPECS.concat(USER_SPECS).find(sp => sp.key === k) || {}).label || k;
  function updateHistoryButtons() {
    const u = $('#rvUndo'), r = $('#rvRedo'); if (!u || !r) return;
    const lu = HIST.undo[HIST.undo.length - 1], lr = HIST.redo[HIST.redo.length - 1];
    u.disabled = R.busy || !lu; r.disabled = R.busy || !lr;
    u.title = lu ? 'Hoàn tác: ' + lu.label : 'Chưa có bước nào để quay lại';
    r.title = lr ? 'Làm lại: ' + lr.label : 'Chưa có bước nào để tới';
  }
  function record(label, changes) {
    const real = changes.filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after) || (c.rowBefore && JSON.stringify(c.rowBefore) !== JSON.stringify(c.rowAfter)));
    if (!real.length) return;
    HIST.undo.push({ label, changes: real }); if (HIST.undo.length > HIST.max) HIST.undo.shift();
    HIST.redo.length = 0; updateHistoryButtons();
  }
  // Chạy 1 thao tác sửa mục và ghi thành 1 bước lịch sử
  async function track(it, label, fn) { const before = clone(it); await fn(); record(label, [{ id: it.id, before, after: clone(it) }]); }
  async function stepHistory(dir) {          // dir = -1: quay lại · +1: tới
    if (R.busy) return;
    const from = dir < 0 ? HIST.undo : HIST.redo, to = dir < 0 ? HIST.redo : HIST.undo;
    const e = from.pop(); if (!e) return;
    R.busy = true; updateHistoryButtons();
    try {
      for (const c of e.changes) {
        const item = dir < 0 ? c.before : c.after, rowState = dir < 0 ? c.rowBefore : c.rowAfter;
        if (rowState && c.rowId) { const row = findRow(c.rowId); if (row) await updateSingleRowFields(row, rowState); }
        await DB.dbPut(ST_ITEMS, clone(item)); S.emit('itemsChanged', { scanId: item.scanId });
        await recomputeLink(c.before.bienSo); await recomputeLink(c.after.bienSo);
      }
      to.push(e);
    } catch (err) { from.push(e); toast('Không hoàn tác được: ' + (err.message || err), true); }
    finally { R.busy = false; }
    R.items = (await DB.dbGetAll(ST_ITEMS)).map(normItem);
    renderReview(); refreshMainTable(); updateHistoryButtons();
    toast((dir < 0 ? '↶ Đã quay lại bước: ' : '↷ Đã làm lại bước: ') + e.label);
  }

  // pre (tùy chọn) = { [itemId]: bản chụp mục TRƯỚC thao tác chọn nguồn } để gộp "chọn + áp dụng" thành 1 bước lịch sử
  async function applyViews(vs, label, onlyKeys, pre) {
    R.busy = true; renderFooter(); updateHistoryButtons();
    let ok = 0, writes = 0, orphanRes = null;
    const orphans = vs.filter(v => !v.found);
    const founds = vs.filter(v => v.found);
    const changes = [];
    try {
      for (const v of founds) {
        const before = (pre && pre[v.it.id]) || clone(v.it), rowBefore = rowSnap(v.row);
        const r = await applyFoundItem(v, onlyKeys);
        changes.push({ id: v.it.id, before, after: clone(v.it), rowId: v.row._rowId, rowBefore, rowAfter: rowSnap(v.row) });
        writes += r.writes; ok++;
        if (ok % 10 === 0) { $('#rvFooterSummary').textContent = `${label}… ${ok}/${founds.length}`; await S.yieldToUi(); } // chạy ngầm, nhường UI
      }
      if (orphans.length) {
        const olds = orphans.map(v => clone(v.it));
        orphanRes = await applyOrphanItems(orphans);
        orphans.forEach((v, i) => changes.push({ id: v.it.id, before: olds[i], after: clone(v.it) }));
      }
    } finally { R.busy = false; }
    record(onlyKeys ? 'Áp dụng riêng 1 trường' : (vs.length === 1 ? 'Áp dụng xe ' + (vs[0].it.bienSoRaw || '') : `Áp dụng ${vs.length} mục`), changes);
    R.items = (await DB.dbGetAll(ST_ITEMS)).map(normItem);
    // Thông báo TRUNG THỰC: phiếu lạ ghi lỗi / chưa ghi thì báo ĐỎ, không nói «đã áp dụng»
    const parts = [];
    if (ok) parts.push(`Đã áp dụng ${ok} xe (${writes} trường cập nhật)` + (isWriteConnected() ? ', đang đồng bộ ngầm lên Google Sheet' : ', mới lưu trên máy'));
    if (orphanRes && orphanRes.pushed) parts.push(`Đã ghi ${orphanRes.pushed} phiếu lạ vào cột AL–AP (hàng mới) của sheet${orphanRes.sheet ? ' «' + orphanRes.sheet + '»' : ''}`);
    if (orphanRes && orphanRes.failed) parts.push(`CHƯA ghi được ${orphanRes.failed} phiếu lạ lên Sheet: ${orphanRes.error}`);
    if (orphanRes && orphanRes.notes.length) parts.push(orphanRes.notes.join('; '));
    if (!parts.length) parts.push('Không có gì để áp dụng.');
    const orphanProblem = !!orphanRes && (orphanRes.failed > 0 || (!orphanRes.pushed && orphanRes.notes.length > 0));
    toast(parts.join('. ') + '.', orphanProblem);
    if (orphanProblem) { clearTimeout(toast._t); toast._t = setTimeout(() => { const el = $('#toast'); if (el) el.classList.add('hidden'); }, 12000); }   // lỗi hiển thị lâu hơn để kịp đọc
    renderReview();
    refreshMainTable();
    updateHistoryButtons();
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
    if (val === ADD_STATUS) {              // chọn "+ Thêm Trạng thái mới..." -> bổ sung vào danh sách Trạng thái xe
      val = addStatus(window.prompt('Nhập Trạng thái xe mới (sẽ có trong danh sách chọn ở trang chủ):', scanStatus(it))) || '';
      if (!val) { scheduleRerender(it, 0); return; }
    }
    await track(it, `Sửa «${labelOf(key)}» bên phiếu`, async () => {
      const base = key === 'nguoiThucHien' ? (prefs.assignee || '') : (USER_BY_KEY[key] ? userDefault(it, key) : (it.scanData[key] || ''));
      if (val === base) delete it.edits[key]; else it.edits[key] = val;
      // Sửa xong: còn khác Sheet -> chọn nguồn = phiếu (người dùng đã chủ động sửa); đã khớp -> bỏ quyết định cũ
      const f = computeView(it).fields.find(x => x.spec.key === key);
      if (f && isActionable(f.state) && (key in it.edits)) { it.decisions[key] = 'apply'; it.source[key] = 'scan'; }
      else if (f && !isActionable(f.state)) { delete it.decisions[key]; delete it.source[key]; }
      await persistEdit(it);
    });
    scheduleRerender(it, val === ADD_NEW ? 0 : 250);
  }
  // Sửa giá trị BÊN SHEET ngay tại chỗ (Sheet gõ sai) -> ghi giá trị đã sửa lên Sheet khi áp dụng
  async function onEditSheet(it, key, raw) {
    const v = computeView(it); if (!v.row) return;
    let val = String(raw || '').trim(); const orig = v.row[key] || '';
    if (val === ADD_STATUS) { val = addStatus(window.prompt('Nhập Trạng thái xe mới:')) || ''; if (!val) { scheduleRerender(it, 0); return; } }
    await track(it, `Sửa «${labelOf(key)}» bên Sheet`, async () => {
      if (val === orig) { delete it.sheetEdits[key]; if (it.decisions[key] === 'sheetfix') delete it.decisions[key]; if (it.source[key] === 'sheet') delete it.source[key]; }
      else { it.sheetEdits[key] = val; it.decisions[key] = 'sheetfix'; it.source[key] = 'sheet'; }
      await persistEdit(it);
    });
    scheduleRerender(it);
  }

  const isWriteConnectedOrLocal = () => state.rawData.length > 0; // local-first: vẫn áp dụng được khi chưa nối Sheet 2 chiều
  // Chạy thao tác chọn nguồn rồi (nếu bật «Xác nhận nhanh») áp dụng luôn; cả hai gộp thành 1 bước lịch sử.
  async function mutateThenMaybeApply(it, label, onlyKeys, fn, force) {   // force = true: ghi NGAY dù ô «áp dụng ngay» đang tắt
    const before = clone(it);
    await fn();
    it.dirty = true; await saveItem(it);
    if ((force || prefs.quick) && isWriteConnectedOrLocal()) await applyViews([computeView(it)], 'Đang áp dụng', onlyKeys, { [it.id]: before });
    else { record(label, [{ id: it.id, before, after: clone(it) }]); rerenderCard(it); }
  }

  // CHỌN NGUỒN RIÊNG TỪNG TRƯỜNG: 'sheet' = Google Sheet đúng (giữ nguyên) · 'scan' = Dữ liệu từ phiếu scan đúng (ghi đúng giá trị phiếu)
  async function setFieldSource(it, key, mode) {
    const f = computeView(it).fields.find(x => x.spec.key === key); if (!f) return;
    if (!confirmSource(mode, 'Trường: ' + labelOf(key) + (it.bienSoRaw ? ' · xe ' + it.bienSoRaw : ''))) return;   // không xác nhận -> không đổi gì
    const label = (mode === 'scan' ? '«Phiếu đúng» — ' : '«Sheet đúng» — ') + labelOf(key);
    await mutateThenMaybeApply(it, label, [key], async () => {
      it.source[key] = mode;
      if (mode === 'sheet') it.decisions[key] = f.sheetEdit != null ? 'sheetfix' : 'skip';
      else { delete it.sheetEdits[key]; it.decisions[key] = 'apply'; }
      markFieldsChecked(it, [key]);          // xác nhận = đã đối chiếu với ảnh
    });
  }

  // XÁC NHẬN NHANH cho CẢ XE: đặt nguồn cho MỌI trường đang khác/thiếu chỉ bằng 1 cú bấm
  //  mode 'sheet' = Google Sheet đúng (giữ Sheet; trường người dùng đã sửa Sheet vẫn được ghi)
  //  mode 'scan'  = Dữ liệu từ phiếu scan đúng (lấy giá trị phiếu, gồm cả chỗ đã chỉnh sửa)
  async function quickConfirm(it, mode) {
    const v = computeView(it);
    if (!v.found) return;
    if (!confirmSource(mode, 'Áp dụng cho CẢ XE' + (it.bienSoRaw ? ' ' + it.bienSoRaw : '') + ' — mọi trường đang khác biệt')) return;
    await mutateThenMaybeApply(it, mode === 'sheet' ? '«Google Sheet đúng» cho cả xe' : '«Dữ liệu từ phiếu scan đúng» cho cả xe', undefined, async () => {
      const keys = [];
      for (const f of v.fields) {
        if (f.spec.meta || !isActionable(f.state)) continue;
        const k = f.spec.key; keys.push(k);
        if (mode === 'sheet') { it.decisions[k] = (f.state === 'sheetedit') ? 'sheetfix' : 'skip'; it.source[k] = 'sheet'; }
        else { delete it.sheetEdits[k]; it.decisions[k] = 'apply'; it.source[k] = 'scan'; }
      }
      markFieldsChecked(it, keys);
      it.imgChecked = true; it.imgCheckedAt = Date.now();   // xác nhận cả xe = đã đối chiếu xong với ảnh
    });
  }

  // Đặt "Tình trạng cam kết = Đã ký cam kết" khi nhìn ảnh thấy phiếu đã ký (máy chưa chắc nên cần người xác nhận)
  async function quickSign(it) {
    let f;
    await track(it, 'Phiếu đã ký cam kết', async () => {
      it.edits.tinhTrangCamKet = SIGNED;
      f = computeView(it).fields.find(x => x.spec.key === 'tinhTrangCamKet');
      if (f && isActionable(f.state)) { it.decisions.tinhTrangCamKet = 'apply'; it.source.tinhTrangCamKet = 'scan'; }
      else { delete it.decisions.tinhTrangCamKet; delete it.source.tinhTrangCamKet; }
      it.dirty = it.dirty || it.done; await saveItem(it);
    });
    rerenderCard(it);
    toast(f && f.state === 'same' ? 'Tình trạng cam kết trên Sheet đã là «' + SIGNED + '».' : 'Đã chọn «' + SIGNED + '» — bấm Áp dụng để ghi.');
  }

  /* ---- KHUNG ẢNH PHIẾU cạnh bảng so sánh ---- */
  const revoke = (u) => URL.revokeObjectURL(u);
  function pageBlock(label, blob, mime, urls) {
    if (!blob) return `<div class="rv-pg"><div class="rv-pg-label">${label}</div><div class="sv-empty">Không có ${escapeHtml(label.toLowerCase())}.</div></div>`;
    const url = URL.createObjectURL(blob); urls.push(url);
    const media = mime === 'application/pdf' ? `<iframe class="rv-pg-pdf" src="${url}" title="${escapeHtml(label)}"></iframe>` : `<img class="rv-pg-img" src="${url}" alt="${escapeHtml(label)}" title="Kéo để dời ảnh · nhấp đúp để phóng to / thu nhỏ">`;
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
    if (!p.open) { p.urls.forEach(revoke); p.urls = []; p.loadedId = null; p.zoom = 100; $('#rvImgBody').innerHTML = ''; return; }   // đóng: dọn ảnh + đặt lại mức phóng
    const it = R.items.find(i => i.id === p.id); if (!it) return;
    refreshPaneActions();
    if (!force && p.loadedId === it.id) return;
    const token = ++p.token;
    let rec = await DB.dbGet(ST_SCANS, it.scanId);
    if (rec && window.ScanSync && !rec.frontBlob && rec.cloud) {            // phiếu từ máy khác: tải ảnh từ online
      $('#rvImgInfo').textContent = '⏳ Đang tải ảnh từ online…';
      rec = await ScanSync.ensureBlobs(rec);
    }
    if (token !== p.token) return;                      // người dùng đã chuyển sang mục khác trong lúc nạp
    p.urls.forEach(revoke); p.urls = []; p.loadedId = it.id;
    $('#rvImgTitle').textContent = '📷 ' + (it.bienSoRaw || '(không đọc được biển)');
    if (!rec) { $('#rvImgInfo').textContent = 'Không tìm thấy ảnh phiếu trong máy này (có thể đã xóa hoặc quét ở máy khác).'; $('#rvImgBody').innerHTML = ''; return; }
    $('#rvImgInfo').innerHTML = `Nguồn: <b>${escapeHtml(rec.sheetLabel || rec.fileName || '')}</b> · quét ${new Date(rec.timestamp).toLocaleString('vi-VN')} · mã ${escapeHtml(rec.id.slice(0, 8))}`
      + (window.ScanFiles ? ` <button type="button" class="btn btn-ghost btn-sm" data-rvdl="pdf" data-scan="${escapeHtml(rec.id)}">⬇ PDF đầy đủ</button>` : '')
      + (rec._cloudMsg ? ` <span class="error-text">${escapeHtml(rec._cloudMsg)}</span>` : '');
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

  /* ---- KÉO ẢNH (pan): bấm giữ chuột trái rồi kéo để dời vị trí xem; kéo xong không bị tính là «click» ---- */
  function enablePan(el) {
    if (!el) return;
    let st = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType === 'touch' || e.target.closest('a,button,iframe,input,select,textarea')) return;   // cảm ứng đã cuộn tự nhiên
      st = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, stp: el.scrollTop, id: e.pointerId }; el._moved = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!st) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!el._moved) { if (Math.hypot(dx, dy) < 4) return; el._moved = true; el.classList.add('panning'); try { el.setPointerCapture(st.id); } catch (err) { /* bỏ qua */ } }
      el.scrollLeft = st.sl - dx; el.scrollTop = st.stp - dy; e.preventDefault();
    });
    const end = () => { if (!st) return; st = null; el.classList.remove('panning'); el._panEnd = Date.now(); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('click', (e) => { if (el._moved && Date.now() - (el._panEnd || 0) < 150) { e.stopPropagation(); e.preventDefault(); el._moved = false; } }, true);
    el.addEventListener('dragstart', (e) => e.preventDefault());
  }
  // Chiều cao thanh công cụ dính trên cùng -> các phần dính khác (tiêu đề cột Phiếu/Sheet, khung ảnh) nằm NGAY DƯỚI, không bị đè
  function syncStickyOffset() {
    const tb = document.querySelector('#scanReviewModal .rv-toolbar'), m = document.querySelector('#scanReviewModal .modal');
    if (tb && m) m.style.setProperty('--rv-sticky', (tb.offsetHeight + 2) + 'px');
  }

  function bindReviewUI() {
    enablePan($('#rvImgBody')); window.addEventListener('resize', syncStickyOffset);
    $('#btnScanOpenReview').addEventListener('click', open);
    $('#rvUndo').addEventListener('click', () => stepHistory(-1));
    $('#rvRedo').addEventListener('click', () => stepHistory(1));
    $('#btnRvFull').addEventListener('click', () => { prefs.full = !prefs.full; savePrefs(); applyFullscreen(); });
    $('#rvFilter').addEventListener('change', (e) => { R.filter = e.target.value; R.page = 1; renderReview(); });
    $('#rvChecker').addEventListener('change', (e) => { R.checker = e.target.value; R.page = 1; renderReview(); });
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
      const act = el.dataset.act, key = el.dataset.field;
      if (act === 'decide') {
        await track(it, `Đổi quyết định «${labelOf(key)}»`, async () => {
          it.decisions[key] = el.value;
          // Quyết định chọn rõ nguồn nào thì nguồn đó được ghi nhận (để lúc ghi KHÔNG lấy nhầm nguồn còn lại)
          if (el.value === 'apply') it.source[key] = 'scan'; else if (el.value === 'skip' || el.value === 'sheetfix') it.source[key] = 'sheet'; else delete it.source[key];
          await persistEdit(it);
        });
        rerenderCard(it);
      }
      else if (act === 'decide-orphan') { await track(it, 'Đổi quyết định phiếu lạ', async () => { it.orphanDecision = el.value; await persistEdit(it); }); rerenderCard(it); }
      else if (act === 'edit-plate') await onEditPlate(it, el.value);
      else if (act === 'edit-scan') await onEditScan(it, key, el.value);
      else if (act === 'edit-sheet') await onEditSheet(it, key, el.value);
      else if (act === 'toggle-dead') await onToggleDead(it, el.checked);
      else if (act === 'party-role') await onPartyRole(it, el.value);
      else if (act === 'party-edit') await onPartyEdit(it, key, el.value);
      else if (act === 'cf-edit') await onCfEdit(it, key, el.value);
      // (Đã bỏ 'tick-field' / 'tick-img': «đã kiểm với ảnh» nay tự bật khi người dùng xác nhận chọn nguồn — xem confirmSource)
    });
    // Enter trong ô «Tên trường» / «Giá trị» = bấm «➕ Thêm trường»
    work.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.dataset || !e.target.dataset.cf) return;
      e.preventDefault(); const btn = e.target.closest('.rv-custom'); const add = btn && btn.querySelector('[data-act="cf-add"]'); if (add) add.click();
    });
    // nhấp đúp ảnh: phóng to / vừa khung (nhấp đơn dành cho kéo ảnh)
    work.addEventListener('dblclick', (e) => { if (e.target.classList && e.target.classList.contains('rv-pg-img')) { R.pane.zoom = R.pane.zoom > 100 ? 100 : 200; applyPaneView(); } });
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
      else if (act === 'pick-plate') await onEditPlate(it, b.dataset.plate);
      else if (act === 'add-status') {
        const added = addStatus(scanValue(it, 'trangThaiXe'));
        if (added) { toast(`Đã thêm «${added}» vào danh sách Trạng thái xe.`); refreshMainTable(); }
        rerenderCard(it);
      }
      else if (act === 'orphan-apply' || act === 'orphan-skip') {
        if (act === 'orphan-apply' && !confirmSource('scan', 'Xe chưa có trong danh sách' + (it.bienSoRaw ? ' ' + it.bienSoRaw : '') + ' — thêm 1 hàng mới vào sheet đang làm việc')) return;
        // «Ghi phiếu lạ» là thao tác CHỦ ĐỘNG (đã hỏi xác nhận) → ghi lên Sheet ngay. Server nhận dạng hàng theo biển số nên gửi lại không tạo hàng trùng.
        await mutateThenMaybeApply(it, act === 'orphan-apply' ? 'Phiếu lạ: thêm hàng mới vào sheet' : 'Phiếu lạ: không ghi', undefined, async () => {
          it.orphanDecision = act === 'orphan-apply' ? 'apply' : 'skip';
          if (act === 'orphan-apply') { it.imgChecked = true; it.orphanSheet = false; it.pushError = ''; }   // bỏ cờ «đã ghi» cũ (có thể sót từ lần lỗi) để gửi lại thật sự
        }, act === 'orphan-apply');
      }
      else if (act === 'orphan-cleanup') { await cleanupOrphanRow(it); rerenderCard(it); }
      else if (act === 'party-apply') await onPartyApply(it);
      else if (act === 'cf-add') await onCfAdd(it, b.closest('.rv-custom'));
      else if (act === 'cf-apply') await onCfApply(it, [b.dataset.field]);
      else if (act === 'cf-apply-all') await onCfApply(it, null);
      else if (act === 'cf-del') await onCfDel(it, b.dataset.field);
      else if (act === 'field-scan') await setFieldSource(it, b.dataset.field, 'scan');
      else if (act === 'field-sheet') await setFieldSource(it, b.dataset.field, 'sheet');
      else if (act === 'revert') { // hoàn tác chỉnh sửa của 1 trường
        const k = b.dataset.field;
        await track(it, `Hoàn tác chỉnh sửa «${labelOf(k)}»`, async () => { delete it.edits[k]; delete it.sheetEdits[k]; delete it.decisions[k]; delete it.source[k]; delete it.fieldChecked[k]; it.imgChecked = false; await persistEdit(it); });
        rerenderCard(it);
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
    // Nút tải nằm ở thanh #svActions (tên file ghi rõ biển số — ScanFiles), không còn link tải riêng từng mặt
    return mime === 'application/pdf'
      ? `<iframe class="sv-frame" src="${url}" title="${escapeHtml(title)}"></iframe>`
      : `<img class="sv-img" src="${url}" alt="${escapeHtml(title)}" title="Bấm để phóng to / thu nhỏ">`;
  }
  async function showViewerIdx(i) {
    revokeUrls(); V.idx = i;
    let rec = await DB.dbGet(ST_SCANS, V.ids[i]);
    // Phiếu quét ở máy khác: ảnh đang nằm online -> tải về (và nhớ trong máy) trước khi hiển thị
    if (rec && window.ScanSync && !rec.frontBlob && rec.cloud) {
      $('#svFront').innerHTML = '<div class="sv-empty">⏳ Đang tải ảnh từ online…</div>'; $('#svBack').innerHTML = '';
      rec = await ScanSync.ensureBlobs(rec);
      if (V.idx !== i) return;                       // người dùng đã chuyển phiếu khác trong lúc tải
    }
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
    const act = $('#svActions');
    if (act) act.innerHTML = window.ScanFiles
      ? `<button type="button" class="btn btn-primary btn-sm" data-dl="pdf" ${rec.frontBlob || rec.cloud ? '' : 'disabled'}>⬇ PDF đầy đủ (2 mặt)</button> `
        + `<button type="button" class="btn btn-ghost btn-sm" data-dl="front">⬇ Ảnh mặt 1</button> `
        + `<button type="button" class="btn btn-ghost btn-sm" data-dl="back" ${rec.backBlob || (rec.cloud && rec.cloud.backId) ? '' : 'disabled'}>⬇ Ảnh mặt 2</button>`
        + (rec._cloudMsg ? ` <span class="error-text">${escapeHtml(rec._cloudMsg)}</span>` : '') : '';
    $('#svFront').innerHTML = rec.frontBlob ? pageHtml(rec.frontBlob, rec.frontMime, 'phieu-mat1-' + rec.id.slice(0, 8)) : `<div class="sv-empty">${escapeHtml(rec._cloudMsg || 'Không có ảnh mặt 1.')}</div>`;
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
    enablePan($('#svFront')); enablePan($('#svBack'));
    // Tải ảnh / PDF đầy đủ: tên file ghi tất cả biển số của phiếu (scan-files.js)
    document.addEventListener('click', (e) => { const b = e.target.closest('[data-rvdl]'); if (b && window.ScanFiles) ScanFiles.download(b.dataset.scan, b.dataset.rvdl); });
    $('#svActions').addEventListener('click', (e) => { const b = e.target.closest('[data-dl]'); if (b && window.ScanFiles) ScanFiles.download(V.ids[V.idx], b.dataset.dl); });
    $('#svTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-sv]'); if (b) showViewerIdx(parseInt(b.dataset.sv, 10)); });
    $('#scanViewerModal').addEventListener('click', (e) => { if (e.target.classList.contains('sv-img')) e.target.classList.toggle('zoom'); });
    // Dọn URL ảnh khi đóng (nút ✕ hoặc click nền — app.js đã xử lý đóng, ta chỉ thu dọn)
    $('#scanViewerModal').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target.id === 'scanViewerModal') setTimeout(revokeUrls, 300); });
  }

  /* ------------------------------------------------------------------ */
  /* 6b. XÓA PHIẾU TRÊN MÁY + LÀM TƯƠI SAU KHI ĐỒNG BỘ (scan-sync.js / scan-store.js gọi)  */
  /* ------------------------------------------------------------------ */
  // Xóa hẳn 1 phiếu trên máy này: bản ghi + ảnh, mọi mục so sánh, rồi tính lại liên kết các biển liên quan.
  // KHÔNG đụng dữ liệu xe trên Sheet (các cột đã cập nhật từ phiếu vẫn giữ — dữ liệu cũ nằm trong Ghi chú).
  async function purgeScanLocal(scanId) {
    const items = await itemsByIndex('scanId', scanId), plates = new Set();
    for (const it of items) { if (it.bienSo) plates.add(it.bienSo); await DB.dbDelete(ST_ITEMS, it.id); }
    await DB.dbDelete(ST_SCANS, scanId);
    for (const pl of plates) await recomputeLink(pl);
    R.items = R.items.filter(i => i.scanId !== scanId);
    if (R.pane.open && !R.items.some(i => i.id === R.pane.id)) R.pane.open = false;
    refreshMainTable();
    return items.length;
  }
  // Sau khi kéo phiếu mới từ online: tính lại liên kết biển số để icon 📷 hiện ngay trên bảng chính
  async function afterRemoteMerge(plates) {
    for (const pl of new Set((plates || []).filter(Boolean))) await recomputeLink(pl);
    refreshMainTable();
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

  // Nạp lại tùy chọn từ localStorage (scan-hub.js gọi khi nhận cài đặt mới từ máy khác)
  function reloadPrefs() { try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* bỏ qua */ } }
  return { reloadPrefs, open, openViewer, linkMap, computeView, createItemsForScan, backfillItems, purgeScanLocal, afterRemoteMerge };
})();
window.ScanReview = ScanReview;
