/* =========================================================================
   scan-compare.js — Hàm so sánh THUẦN (không đụng DOM/DB) giữa dữ liệu trích
   từ phiếu scan (bên trái) và dữ liệu hiện có trên Sheet (bên phải).
   Mỗi hàm trả về { state, newVal?, note?, defaultDecision? }:
     state 'same'  : khớp — không cần làm gì
           'fill'  : Sheet đang trống / thiếu, phiếu có thể bổ sung
           'diff'  : KHÁC thật — cần người xem
           'empty' : phiếu không có giá trị cho trường này — bỏ qua
     newVal          : giá trị sẽ ghi vào Sheet nếu người dùng chọn "Cập nhật"
     defaultDecision : 'apply' | 'later' — gợi ý ban đầu; hệ thống CHƯA ĐỦ CHẮC thì 'later'
   Chạy được cả trong trình duyệt lẫn Node (để kiểm thử).
   ========================================================================= */
(function (root) {
  'use strict';

  const strip = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  const digits = (s) => String(s || '').replace(/\D/g, '');
  // Dạng so sánh: bỏ dấu, thường, bỏ mọi ký tự không phải chữ/số (khoảng trắng, chấm, gạch...)
  const flat = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  // Chuẩn hóa biển số: UPPERCASE, bỏ khoảng trắng / chấm / gạch.
  const normPlate = (s) => String(s || '').toUpperCase().replace(/[\s.\-_]/g, '');

  /* ---- CCCD ----
     Quy tắc (theo quy trình đối chiếu thủ công):
     - chỉ lấy chữ số; Excel hay làm MẤT số 0 đầu -> pad về 12 số rồi mới so;
     - phiếu thiếu 1–2 số CUỐI nhưng là TIỀN TỐ của CCCD trong DS => coi KHỚP, lấy đủ từ DS;
     - chỉ báo KHÁC khi lệch chữ số thật. */
  const cccdLenOk = (a) => a.length === 12 || a.length === 9; // CCCD 12 số, CMND cũ 9 số
  const pad12 = (x) => (x.length >= 10 && x.length < 12) ? x.padStart(12, '0') : x;
  function cmpCccd(scanRaw, dsRaw) {
    const a = digits(scanRaw), b = digits(dsRaw);
    if (!a) return { state: 'empty' };
    if (!b) return { state: 'fill', newVal: a, defaultDecision: cccdLenOk(a) ? 'apply' : 'later', note: cccdLenOk(a) ? '' : `Phiếu có ${a.length} số — độ dài bất thường, nên kiểm lại` };
    const pa = pad12(a), pb = pad12(b);
    if (a === b || pa === pb) return { state: 'same', note: a === b ? '' : 'Khớp (lệch số 0 đầu)' };
    for (const [x, y] of [[a, b], [pa, pb]]) {
      if (x.length < y.length && y.length - x.length <= 2 && y.startsWith(x))
        return { state: 'same', note: `Phiếu thiếu ${y.length - x.length} số cuối — lấy đủ từ DS` };
    }
    for (const [x, y] of [[a, b], [pa, pb]]) {
      if (y.length < x.length && x.length - y.length <= 2 && x.startsWith(y))
        return { state: 'fill', newVal: pa.length === 12 ? pa : a, defaultDecision: 'later', note: 'DS đang thiếu số cuối, phiếu đầy đủ hơn' };
    }
    return { state: 'diff', newVal: a, defaultDecision: 'later', note: 'Lệch chữ số thật' };
  }

  /* ---- Chủ xe: so sau khi bỏ khoảng trắng + dấu; gần giống thì KHÔNG báo "khác chủ" ---- */
  function cmpName(scanRaw, dsRaw) {
    const a = String(scanRaw || '').trim(), b = String(dsRaw || '').trim();
    if (!a) return { state: 'empty' };
    if (!b) return { state: 'fill', newVal: a, defaultDecision: 'apply' };
    if (flat(a) === flat(b)) return { state: 'same', note: a === b ? '' : 'Khớp (khác dấu/khoảng trắng)' };
    if (typeof root.isFuzzyNameMatch === 'function' && root.isFuzzyNameMatch(a, b)) return { state: 'same', note: 'Gần giống — coi là cùng người' };
    return { state: 'diff', newVal: a, defaultDecision: 'later', note: 'Khác tên chủ xe' };
  }

  /* ---- SĐT: chuẩn hóa 84xxxxxxxxx -> 0xxxxxxxxx, thiếu số 0 đầu; Sheet có thể chứa nhiều số ---- */
  function normPhone(x) {
    let d = digits(x);
    if (d.startsWith('84') && d.length >= 11) d = '0' + d.slice(2);
    if (d.length === 9) d = '0' + d;
    return d;
  }
  function cmpPhone(scanRaw, dsRaw) {
    const a = normPhone(scanRaw);
    if (!a) return { state: 'empty' };
    const list = String(dsRaw || '').split(/[,;|\/\n]+/).map(normPhone).filter(Boolean);
    if (!list.length) return { state: 'fill', newVal: a, defaultDecision: a.length === 10 ? 'apply' : 'later', note: a.length === 10 ? '' : `SĐT ${a.length} số — nên kiểm lại` };
    if (list.includes(a)) return { state: 'same' };
    // Khác: không ghi đè số cũ — thêm số mới vào cuối (app cho phép nhiều SĐT, phân cách dấu phẩy)
    return { state: 'diff', newVal: `${String(dsRaw).trim()}, ${a}`, defaultDecision: 'later', note: 'Phiếu có số khác — nếu cập nhật sẽ THÊM vào cuối, không ghi đè' };
  }

  /* ---- Ghi chú: nếu Sheet đã chứa nội dung phiếu thì khớp; không thì NỐI THÊM, không ghi đè ---- */
  function cmpNote(scanRaw, dsRaw) {
    const a = String(scanRaw || '').trim(), b = String(dsRaw || '').trim();
    if (!a) return { state: 'empty' };
    if (flat(b).includes(flat(a))) return { state: 'same' };
    return { state: 'fill', newVal: b ? `${b} | Phiếu: ${a}` : `Phiếu: ${a}`, defaultDecision: 'apply', note: b ? 'Sẽ nối thêm vào ghi chú hiện có' : '' };
  }

  /* ---- Tình trạng cam kết: chỉ ĐỀ XUẤT khi là bản cam kết có nội dung mặt 2 (chữ ký).
     Máy chưa chắc có chữ ký thật nên luôn để mặc định 'later' cho người xem ảnh. ---- */
  function cmpCommit(scanRaw, dsRaw) {
    const a = String(scanRaw || '').trim(), b = String(dsRaw || '').trim();
    if (!a) return { state: 'empty' };
    if (flat(a) === flat(b)) return { state: 'same' };
    if (!b || flat(b) === flat('Chưa thu thập')) return { state: 'fill', newVal: a, defaultDecision: 'later', note: 'Cần xem chữ ký xác nhận trên ảnh phiếu' };
    return { state: 'diff', newVal: a, defaultDecision: 'later', note: 'Khác giá trị đang có' };
  }

  /* ---- Người thực hiện: KHÔNG có trên phiếu — là người đang đối chiếu (chọn ở màn so sánh).
     Sheet trống -> đề xuất ghi; Sheet đã có NGƯỜI KHÁC -> mặc định giữ nguyên, không ghi đè. ---- */
  function cmpAssignee(scanRaw, dsRaw) {
    const a = String(scanRaw || '').trim(), b = String(dsRaw || '').trim();
    if (!a) return { state: 'empty' };
    if (!b) return { state: 'fill', newVal: a, defaultDecision: 'apply' };
    if (flat(a) === flat(b)) return { state: 'same' };
    return { state: 'diff', newVal: a, defaultDecision: 'skip', note: 'Sheet đã gán người khác — mặc định GIỮ NGUYÊN' };
  }

  const api = { normPlate, cmpCccd, cmpName, cmpPhone, cmpNote, cmpCommit, cmpAssignee, normPhone, flat };
  root.ScanCompare = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
