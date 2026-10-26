/* =========================================================================
   thu-hoi.js — LÕI tạo "GIẤY KHAI THU HỒI CHỨNG NHẬN ĐĂNG KÝ XE, BIỂN SỐ XE"
   -------------------------------------------------------------------------
   • Bố cục lấy ĐÚNG theo file mẫu "Giấy khai THU HOI DKX 2.pdf":
       - Khổ trang 612 × 792 pt (Letter), phông Times New Roman 10–14pt;
       - Mỗi dòng có đường cơ sở (baseline) + toạ độ x đo trực tiếp từ file mẫu;
       - Khoảng cách chữ lấy từ phông Liberation Serif (cùng số đo ngang với
         Times New Roman nên vị trí từng ký tự khớp mẫu).
   • Chỉ làm việc "thuần": nhận dữ liệu -> trả về danh sách thao tác vẽ chữ (ops),
     rồi mới ghi ra PDF (pdf-lib) hoặc vẽ xem trước (canvas). Nhờ vậy bản PDF và
     bản xem trước luôn trùng nhau, và chạy thử được bằng Node.
   • Hai bản in:
       - "full"    : bản in lần 1 — chừa TRẮNG Mã hồ sơ, ngày ký, và mọi trường
                     chưa có dữ liệu (để in bồi);
       - "overlay" : bản in bồi lần 2 — CHỈ chứa chữ điền vào đúng các chỗ trắng đó,
                     cùng toạ độ với bản lần 1 (nền trang trắng, không in lại gì khác).
   • Giao diện (hộp thoại, nút bấm) nằm ở thu-hoi-ui.js; file này không đụng DOM.
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThuHoi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------- 1. HẰNG SỐ BỐ CỤC ---------------------------- */
  const PAGE = { w: 612, h: 792 };        // pt — đúng khổ file mẫu
  const LEFT = 54.1;                        // lề trái nội dung (x chữ đầu dòng)
  const RIGHT = 557.6;                      // mép phải căn đều (dòng "Lý do thu hồi")
  const REASON_LINE_GAP = 14.9;            // khoảng cách 2 dòng của đoạn "Lý do thu hồi"
  const REASON_MAX_LINES = 2;               // mẫu chừa chỗ cho tối đa 2 dòng
  // Tên file phông (thư mục lib/fonts) tương ứng 4 kiểu chữ của mẫu.
  const FONT_FILES = {
    r: 'LiberationSerif-Regular.ttf',
    b: 'LiberationSerif-Bold.ttf',
    i: 'LiberationSerif-Italic.ttf',
    bi: 'LiberationSerif-BoldItalic.ttf',
  };

  /* ---------------------------- 2. DANH SÁCH TRƯỜNG --------------------------
     key      : tên trường trong đối tượng dữ liệu
     label    : nhãn hiển thị trên form
     reserve  : bề rộng (pt) chừa lại khi trường để trống, để các nhãn đứng
                SAU nó không bị dịch chỗ -> bản in bồi vẫn khớp đúng vị trí.
     bobOnly  : trường chỉ có ở bản in bồi (luôn trống ở bản lần 1).             */
  const FIELDS = [
    { key: 'diaDanh',        label: 'Địa danh (dòng ngày ký)',     group: 'Ký',       reserve: 0 },
    { key: 'bienSo',         label: 'Biển số',                      group: 'Xe',       reserve: 0 },
    { key: 'mauBien',        label: 'Màu biển',                     group: 'Xe',       reserve: 0 },
    { key: 'chuXe',          label: 'Tên chủ xe',                   group: 'Chủ xe',   reserve: 0 },
    { key: 'diaChi',         label: 'Địa chỉ (thôn, địa chỉ mới nhất)', group: 'Chủ xe', reserve: 95 },
    { key: 'dienThoai',      label: 'Điện thoại',                   group: 'Chủ xe',   reserve: 0 },
    { key: 'cccd',           label: 'Mã định danh (CCCD)',          group: 'Chủ xe',   reserve: 80 },
    { key: 'loaiGiayTo',     label: 'Loại giấy tờ',                 group: 'Chủ xe',   reserve: 0 },
    { key: 'coQuanCap',      label: 'Cơ quan cấp',                  group: 'Chủ xe',   reserve: 80 },
    { key: 'ngayCap',        label: 'Ngày cấp',                     group: 'Chủ xe',   reserve: 0 },
    { key: 'nguoiLamThuTuc', label: 'Người làm thủ tục',            group: 'Chủ xe',   reserve: 90 },
    { key: 'soGiayTo',       label: 'Số giấy tờ',                   group: 'Chủ xe',   reserve: 80 },
    { key: 'sdtNguoiLam',    label: 'SĐT người làm thủ tục',        group: 'Chủ xe',   reserve: 0 },
    { key: 'coQuanNhan',     label: 'Đề nghị (cơ quan)',            group: 'Đề nghị',  reserve: 0 },
    { key: 'lyDo',           label: 'Lý do thu hồi',                group: 'Đề nghị',  reserve: 0, multiline: true },
    { key: 'nhanHieu',       label: 'Nhãn hiệu',                    group: 'Đặc điểm xe', reserve: 60 },
    { key: 'soLoai',         label: 'Số loại',                      group: 'Đặc điểm xe', reserve: 0 },
    { key: 'loaiXe',         label: 'Loại xe',                      group: 'Đặc điểm xe', reserve: 50 },
    { key: 'soMay',          label: 'Số máy',                       group: 'Đặc điểm xe', reserve: 0 },
    { key: 'soKhung',        label: 'Số khung',                     group: 'Đặc điểm xe', reserve: 0 },
    { key: 'namSX',          label: 'Năm sản xuất',                 group: 'Đặc điểm xe', reserve: 0 },
  ];
  // Trường "in bồi": luôn trống ở bản lần 1.
  const BOI_FIELDS = [
    { key: 'maHoSo', label: 'Mã hồ sơ trực tuyến', hint: 'VD: G01.863.828-261021-00007' },
    { key: 'ngay',   label: 'Ngày ký (chủ xe)' },
    { key: 'thang',  label: 'Tháng' },
    { key: 'nam',    label: 'Năm' },
  ];
  // Điểm đặt chữ cố định của các trường in bồi (đo từ mẫu).
  const MA_HO_SO_POS = { x: 288.9, y: 130.4, f: 'bi', z: 12 };

  /* ---------------------------- 3. KHAI BÁO CÁC DÒNG -------------------------
     y  = vị trí đường cơ sở tính từ MÉP TRÊN trang (pt) — đo từ mẫu.
     Phần tử của dòng:
       { t, f, z }            chữ cố định (f: r|b|i|bi, z: cỡ chữ). Có thể có x (đặt tuyệt đối)
       { k, f, z }            giá trị trường dữ liệu (xem FIELDS)
       { dots, f, z }         dãy dấu chấm điền tay
       { sup, f, z, dy }      chỉ số trên (VD cm³), dy = độ nâng so với đường cơ sở
       { para: 'lyDo' }       đoạn căn đều nhiều dòng (Lý do thu hồi)
       { boi: 'maHoSo'|'ngayThang' }  chỗ chừa trắng cho in bồi
     Không có x thì chữ nối tiếp ngay sau phần tử trước (giống chữ chạy trong mẫu). */
  const L = (y, name, items) => ({ y, name, items });
  const T = (t, f, z, x) => (x == null ? { t, f, z } : { t, f, z, x });
  const V = (k, f, z) => ({ k, f, z });
  const D = (dots, f, z) => ({ dots, f, z });

  const LINES = [
    L(76.3,  'Quốc hiệu',   [T('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 'b', 13, 170.5)]),
    L(92.4,  'Tiêu ngữ',    [T('Độc lập - Tự do - Hạnh phúc', 'b', 13, 226.6)]),
    L(115.5, 'Tên giấy',    [T('GIẤY KHAI THU HỒI CHỨNG NHẬN ĐĂNG KÝ XE, BIỂN SỐ XE', 'b', 12, 125.4)]),
    L(130.4, 'Mã hồ sơ',    [T('Mã hồ sơ trực tuyến', 'bi', 12, 185.6), { boi: 'maHoSo' }]),
    L(160.2, 'Biển số',     [T('BIỂN SỐ: ', 'b', 12, LEFT), V('bienSo', 'b', 12),
                             T('Màu biển :', 'b', 12, 247.7), V('mauBien', 'b', 12)]),
    L(179.8, 'Tên chủ xe',  [T('Tên chủ xe:  ', 'r', 13), V('chuXe', 'b', 13)]),
    L(199.5, 'Địa chỉ',     [T('Địa chỉ: ', 'r', 13), V('diaChi', 'b', 13), T('  Điện thoại: ', 'r', 13), V('dienThoai', 'b', 13)]),
    L(214.5, 'Mã định danh',[T('Mã định danh: ', 'r', 13), V('cccd', 'b', 13), T('   Loại giấy tờ:', 'r', 13), T(' ', 'r', 13), V('loaiGiayTo', 'b', 13)]),
    L(229.4, 'Cơ quan cấp', [T('Cơ quan cấp:', 'r', 13), T(' ', 'r', 13), V('coQuanCap', 'b', 13), T(' ', 'r', 13), T('Ngày cấp: ', 'r', 13), V('ngayCap', 'b', 13)]),
    L(244.4, 'Người làm thủ tục', [T('Người làm thủ tục: ', 'r', 13), V('nguoiLamThuTuc', 'b', 13), T('         Số giấy tờ:', 'r', 13), T(' ', 'r', 13),
                             V('soGiayTo', 'b', 13), T('    SĐT: ', 'r', 13), V('sdtNguoiLam', 'b', 13)]),
    L(268.5, 'Đề nghị',     [T('Đề nghị: ', 'r', 13), V('coQuanNhan', 'b', 13)]),
    L(288.2, 'Thu hồi',     [T('Thu hồi và cấp chứng nhận thu hồi chứng nhận đăng ký xe, biển số xe: ', 'r', 13), V('bienSo', 'b', 13)]),
    L(308.0, 'Lý do thu hồi', [{ para: 'lyDo', z: 13 }]),
    L(342.7, 'Sang tên',    [T('Sang tên cho chủ xe mới (nếu có): ', 'r', 13), D(97, 'r', 13)]),
    L(366.8, 'Địa chỉ chủ mới', [T('Địa chỉ:', 'r', 13), D(140, 'i', 13)]),
    L(386.5, 'Mã định danh chủ mới', [T('Mã định danh:', 'r', 13), D(66, 'i', 13), T(' ', 'i', 13), T('Số điện thoại:', 'r', 13), T(' ', 'i', 13), D(39, 'i', 13)]),
    L(406.3, 'Đặc điểm',    [T('Đặc điểm xe như sau:', 'bi', 13)]),
    L(426.0, 'Nhãn hiệu',   [T('Nhãn hiệu: ', 'r', 13), V('nhanHieu', 'b', 13), T(' Số loại: ', 'r', 13), V('soLoai', 'b', 13)]),
    L(441.0, 'Loại xe',     [T('Loại xe : ', 'r', 13), V('loaiXe', 'b', 13), T('            Dung tích:', 'r', 13), D(8, 'i', 13), T(' cm', 'r', 13),
                             { sup: '3', f: 'r', z: 7.5, dy: -5.2 }, T('; Công suất:', 'r', 13), D(9, 'i', 13), T(' kw', 'r', 13)]),
    L(455.9, 'Số máy',      [T('Số máy: ', 'r', 13), V('soMay', 'b', 13)]),
    L(470.9, 'Số khung',    [T('Số khung: ', 'r', 13), V('soKhung', 'b', 13)]),
    L(485.8, 'Trọng tải',   [T('Trọng tải: ', 'r', 13), D(13, 'i', 13), T('kg; Số chỗ ngồi: ', 'r', 13), D(6, 'i', 13), T('; đứng: ', 'r', 13), D(7, 'i', 13),
                             T('; nằm: ', 'r', 13), D(5, 'i', 13), T('; Năm sản xuất : ', 'r', 13), V('namSX', 'b', 13)]),
    L(508.8, 'Kèm theo',    [T('Kèm theo giấy này có:', 'r', 13), D(118, 'i', 13)]),
    L(523.7, 'Dòng chấm 1', [T('', 'i', 13), D(154, 'i', 13)]),
    L(538.7, 'Dòng chấm 2', [T('', 'i', 13), D(154, 'i', 13)]),
    L(577.5, 'Ký tên',      [T('CÁN BỘ ĐĂNG KÝ XE', 'b', 12, 71.3), T('', 'i', 14, 280.6), V('diaDanh', 'i', 14), { boi: 'ngayThang' }]),
    L(593.0, 'Ký tên 2',    [T('Ký, ghi rõ họ tên', 'i', 11, 89.8), T('CHỦ XE', 'b', 12, 369.1)]),
    L(610.8, 'Ghi chú ký',  [T('(Ký số hoặc ký, ghi rõ họ tên, đóng dấu nếu là xe cơ quan)', 'i', 10, 286.6)]),
  ];
  // Đường kẻ dưới "Độc lập - Tự do - Hạnh phúc" (đo từ mẫu).
  const RULES = [{ x1: 245.75, x2: 366.25, y: 95.65, w: 0.75 }];

  /* ---------------------------- 4. TIỆN ÍCH ----------------------------------- */
  const nfc = (s) => (s == null ? '' : String(s)).normalize('NFC');
  const clean = (s) => nfc(s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Tạo hàm đo bề ngang chữ (pt) từ phông thật -> cùng số đo với PDF.
  //   fontkitLib : thư viện fontkit (@pdf-lib/fontkit);  fontBytes: { r,b,i,bi } (Uint8Array)
  function makeMeasure(fontkitLib, fontBytes) {
    const fonts = {};
    Object.keys(FONT_FILES).forEach(k => { fonts[k] = fontkitLib.create(fontBytes[k]); });
    const cache = new Map();
    return function measure(f, z, s) {
      if (!s) return 0;
      const key = f + '|' + s;
      let units = cache.get(key);
      if (units == null) {
        units = fonts[f].layout(nfc(s)).glyphs.reduce((a, g) => a + g.advanceWidth, 0) / fonts[f].unitsPerEm;
        cache.set(key, units);
      }
      return units * z;
    };
  }

  // Đoạn "Lý do thu hồi": nhãn thường + nội dung đậm dính liền sau dấu ":" (đúng mẫu).
  //   mode 'justify': bản lần 1 — căn đều 2 bên (cả nhãn lẫn nội dung, trừ dòng cuối), vẽ cả nhãn;
  //   mode 'natural': bản in bồi — nhãn đã in sẵn ở lần 1 theo khoảng cách tự nhiên, nên chỉ
  //                   vẽ phần nội dung, không căn đều dòng đầu (nội dung nối ngay sau nhãn).
  const REASON_LABEL = 'Lý do thu hồi:';
  function layoutParagraph(measure, text, y0, z, ops, warn, mode) {
    const words = clean(text).split(' ').filter(Boolean);
    if (!words.length) return;
    const toks = REASON_LABEL.split(' ').map(w => ({ s: w, f: 'r', lead: true }));
    words.forEach((w, i) => toks.push({ s: w, f: 'b', glue: i === 0 }));   // từ đầu dính liền dấu ":"
    const spaceW = measure('b', z, ' ');
    const lines = []; let cur = [], curW = 0;
    toks.forEach(t => {
      t.w = measure(t.f, z, t.s);
      const need = cur.length ? curW + (t.glue ? 0 : spaceW) + t.w : t.w;
      if (cur.length && need > RIGHT - LEFT + 0.01) { lines.push({ ts: cur, w: curW }); cur = [t]; curW = t.w; }
      else { cur.push(t); curW = need; }
    });
    lines.push({ ts: cur, w: curW, last: true });
    if (lines.length > REASON_MAX_LINES) warn.push('«Lý do thu hồi» dài quá ' + REASON_MAX_LINES + ' dòng — sẽ đè lên dòng dưới, hãy rút gọn.');
    lines.forEach((ln, i) => {
      let x = LEFT;
      const y = y0 + i * REASON_LINE_GAP;
      const gaps = ln.ts.filter((t, k) => k > 0 && !t.glue).length;
      const justify = mode === 'justify' && !ln.last && gaps > 0;
      const gap = justify ? spaceW + (RIGHT - LEFT - ln.w) / gaps : spaceW;
      ln.ts.forEach((t, k) => {
        if (k > 0 && !t.glue) x += gap;
        if (!(t.lead && mode === 'natural')) ops.push({ x, y, s: t.s, f: t.f, z });
        x += t.w;
      });
    });
  }

  /* ---------------------------- 5. BỐ TRÍ (LAYOUT) ---------------------------- 
     d1 = dữ liệu bản lần 1 (trường trống -> chừa chỗ để in bồi)
     d2 = dữ liệu in bồi { maHoSo, ngay, thang, nam, <trường khác nếu lần 1 để trống> }
     Trả về { full: [ops], overlay: [ops], rules: [...], warnings: [...], slots }
     ops = { x, y(đường cơ sở từ mép trên), s, f, z }                                  */
  function layout(measure, d1, d2) {
    d1 = d1 || {}; d2 = d2 || {};
    const full = [], overlay = [], warnings = [], slots = {};
    const val = (o, k) => clean(o[k]);

    LINES.forEach(line => {
      let x = LEFT;
      line.items.forEach(it => {
        if (it.x != null) x = it.x;
        if (it.t != null) {                                   // chữ cố định
          if (it.t) { full.push({ x, y: line.y, s: it.t, f: it.f, z: it.z }); x += measure(it.f, it.z, it.t); }
        } else if (it.dots) {                                 // dấu chấm điền tay
          const s = '.'.repeat(it.dots);
          full.push({ x, y: line.y, s, f: it.f, z: it.z }); x += measure(it.f, it.z, s);
        } else if (it.sup) {                                  // chỉ số trên
          full.push({ x, y: line.y + it.dy, s: it.sup, f: it.f, z: it.z }); x += measure(it.f, it.z, it.sup);
        } else if (it.para) {                                 // đoạn căn đều (Lý do thu hồi)
          const v1 = val(d1, it.para), v2 = val(d2, it.para);
          if (v1) layoutParagraph(measure, v1, line.y, it.z, full, warnings, 'justify');
          else {
            const lab = REASON_LABEL;                         // chưa có nội dung: in nhãn tự nhiên, chừa chỗ in bồi
            full.push({ x: LEFT, y: line.y, s: lab, f: 'r', z: it.z });
            slots[it.para] = { x: LEFT + measure('r', it.z, lab), y: line.y, f: 'b', z: it.z, para: true };
            if (v2) layoutParagraph(measure, v2, line.y, it.z, overlay, warnings, 'natural');
          }
        } else if (it.k) {                                    // trường dữ liệu
          const meta = FIELDS.find(f => f.key === it.k) || { reserve: 0 };
          const v1 = val(d1, it.k);
          if (v1) {
            full.push({ x, y: line.y, s: v1, f: it.f, z: it.z, field: it.k }); x += measure(it.f, it.z, v1);
          } else {                                            // để trống -> chừa chỗ + cho phép in bồi
            slots[it.k] = slots[it.k] || { x, y: line.y, f: it.f, z: it.z };
            const v2 = val(d2, it.k);
            if (v2) {
              overlay.push({ x, y: line.y, s: v2, f: it.f, z: it.z, field: it.k });
              const w2 = measure(it.f, it.z, v2);
              if (meta.reserve && w2 > meta.reserve + 0.5) warnings.push('«' + meta.label + '» (in bồi) dài hơn chỗ chừa trống — có thể đè lên chữ bên phải.');
            }
            x += meta.reserve || 0;
          }
        } else if (it.boi === 'maHoSo') {                     // Mã hồ sơ — luôn chừa trắng ở bản lần 1
          slots.maHoSo = Object.assign({}, MA_HO_SO_POS);
          const v = val(d2, 'maHoSo');
          if (v) overlay.push({ x: MA_HO_SO_POS.x, y: MA_HO_SO_POS.y, s: v, f: MA_HO_SO_POS.f, z: MA_HO_SO_POS.z, field: 'maHoSo' });
        } else if (it.boi === 'ngayThang') {                  // "ngày … tháng … năm …" — chừa trắng ở bản lần 1
          // Mẫu in "Chiên Đàn, ngày" rồi để trống phần còn lại: thêm đúng "ngày " (nhãn) sau địa danh.
          const lead = ', ngày ';
          full.push({ x, y: line.y, s: lead, f: 'i', z: 14 }); x += measure('i', 14, lead);
          slots.ngayThang = { x, y: line.y, f: 'i', z: 14 };
          const ng = val(d2, 'ngay'), th = val(d2, 'thang'), na = val(d2, 'nam');
          if (ng || th || na) {
            const s = (ng) + ' tháng ' + (th) + ' năm ' + (na);
            overlay.push({ x, y: line.y, s, f: 'i', z: 14, field: 'ngayThang' });
          }
        }
      });
      if (x > RIGHT + 1 && line.items.some(i => i.k)) warnings.push('Dòng «' + line.name + '» dài quá lề phải — hãy rút gọn nội dung.');
    });
    return { full, overlay, rules: RULES, warnings, slots };
  }

  /* ---------------------------- 6. GHI RA PDF (pdf-lib) ----------------------- 
     pages: [{ d1, d2, mode: 'full' | 'overlay' }]  — mỗi phần tử là 1 trang (1 xe).
     Trả về Uint8Array của file PDF. Phông được nhúng dạng subset (nhẹ).           */
  async function createPdf(PDFLib, fontkitLib, fontBytes, pages) {
    const { PDFDocument, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkitLib);
    doc.setTitle('Giấy khai thu hồi chứng nhận đăng ký xe, biển số xe');
    doc.setCreator('Quản lý Phương tiện');
    const measure = makeMeasure(fontkitLib, fontBytes);
    const embedded = {};
    const font = async (k) => (embedded[k] || (embedded[k] = await doc.embedFont(fontBytes[k], { subset: true })));
    const black = rgb(0, 0, 0);

    for (const pg of pages) {
      const res = layout(measure, pg.d1, pg.d2);
      const page = doc.addPage([PAGE.w, PAGE.h]);
      const ops = pg.mode === 'overlay' ? res.overlay : res.full;
      for (const op of ops) {
        page.drawText(nfc(op.s), { x: op.x, y: PAGE.h - op.y, size: op.z, font: await font(op.f), color: black });
      }
      if (pg.mode !== 'overlay') {
        res.rules.forEach(r => page.drawLine({ start: { x: r.x1, y: PAGE.h - r.y }, end: { x: r.x2, y: PAGE.h - r.y }, thickness: r.w, color: black }));
      }
    }
    return doc.save();
  }

  return { PAGE, LEFT, RIGHT, FONT_FILES, FIELDS, BOI_FIELDS, LINES, makeMeasure, layout, createPdf, clean };
});
