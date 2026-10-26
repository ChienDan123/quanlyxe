/* =========================================================================
   dvc-fill.js — ĐIỀN NHANH form «Thu hồi chứng nhận đăng ký xe, biển số xe»
   trên cổng dichvucong.bocongan.gov.vn từ dữ liệu của web Quản lý xe.
   -------------------------------------------------------------------------
   Cách hoạt động (trình duyệt chặn điều khiển tab khác nên dùng clipboard):
     1) Web Quản lý xe: bấm «Sao chép → Dịch vụ công» -> dữ liệu xe vào clipboard
        dạng  QLXE_THUHOI::{json}.
     2) Ở tab dichvucong: bấm dấu trang «Điền QLXE» (bookmarklet sinh từ file này).
        File này đọc clipboard, tìm ô theo NHÃN (label) rồi điền + bắn sự kiện
        input/change để trang nhận giá trị.
   QUY ƯỚC VIẾT FILE NÀY (để dán được thành bookmarklet 1 dòng):
     - chỉ dùng chú thích khối, KHÔNG dùng chú thích //
     - mọi câu lệnh đều kết thúc bằng dấu chấm phẩy
   Không điền ô «Mã bảo mật» (captcha) — người dùng tự nhập.
   ========================================================================= */
(function () {
  'use strict';
  var PREFIX = 'QLXE_THUHOI::';

  /* Bỏ dấu, hạ chữ thường, gộp ký tự lạ thành 1 khoảng trắng — để so khớp nhãn/lựa chọn. */
  var norm = function (s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\u0111/g, 'd').replace(/\u0110/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* Bảng ánh xạ: khoá dữ liệu -> mẫu nhãn (đã chuẩn hoá) trên form dichvucong.
     Mỗi khoá chỉ điền cho nhãn ĐẦU TIÊN khớp (tránh điền nhầm sang khối «chủ xe mới»). */
  var SPEC = [
    { k: 'loaiPT', re: /^o to xe may/, name: 'Ô tô / Xe máy', sel: true },
    { k: 'mauBien', re: /^mau bien/, name: 'Màu biển', sel: true },
    { k: 'bienSo', re: /^bien so/, name: 'Biển số' },
    { k: 'soMay', re: /^so may/, name: 'Số máy' },
    { k: 'soKhung', re: /^so khung/, name: 'Số khung' },
    { k: 'lyDo', re: /^ly do thu hoi/, name: 'Lý do thu hồi', sel: true },
    { k: 'cccd', re: /^ma dinh danh/, name: 'Mã định danh của chủ xe' },
    { k: 'loaiGiayTo', re: /^loai giay to/, name: 'Loại giấy tờ', sel: true },
    { k: 'ngayCap', re: /^cap ngay/, name: 'Cấp ngày', date: true },
    { k: 'noiCap', re: /^noi cap/, name: 'Nơi cấp' },
    { k: 'chuXe', re: /^ho va ten/, name: 'Họ và tên chủ xe' },
    { k: 'dienThoai', re: /^(so )?(dien thoai|dt)|^sdt/, name: 'Điện thoại' },
    { k: 'diaChi', re: /^dia chi/, name: 'Địa chỉ' },
    { k: 'nhanHieu', re: /^nhan hieu/, name: 'Nhãn hiệu' },
    { k: 'soLoai', re: /^so loai/, name: 'Số loại' },
    { k: 'namSX', re: /^nam san xuat/, name: 'Năm sản xuất' }
  ];

  /* Ứng viên chuỗi để tìm lựa chọn trong ô chọn (select) cho từng khoá. */
  var candidates = function (k, v, data) {
    if (k === 'mauBien') { return ['nền màu ' + v, v]; }
    if (k === 'loaiGiayTo') {
      var n = norm(v);
      if (/can cuoc|cccd/.test(n)) { return [v, 'Căn cước công dân', 'Căn cước', 'CCCD']; }
      if (/chung minh|cmnd/.test(n)) { return [v, 'Chứng minh nhân dân', 'CMND']; }
      return [v];
    }
    return [v];
  };

  /* Chọn lựa chọn khớp nhất: ưu tiên bằng hẳn > bắt đầu bằng > chứa. */
  var pickOption = function (sel, cands) {
    var opts = Array.prototype.slice.call(sel.options).filter(function (o) {
      return o.value !== '' && !/chua chon/.test(norm(o.text));
    });
    var levels = [
      function (t, c) { return t === c; },
      function (t, c) { return t.indexOf(c) === 0 || (c.length > 25 && t.indexOf(c.slice(0, 25)) === 0); },
      function (t, c) { return t.indexOf(c) >= 0 || (c.length > 25 && t.indexOf(c.slice(0, 25)) >= 0); }
    ];
    for (var ci = 0; ci < cands.length; ci++) {
      var c = norm(cands[ci]);
      if (!c) { continue; }
      for (var li = 0; li < levels.length; li++) {
        for (var oi = 0; oi < opts.length; oi++) {
          if (levels[li](norm(opts[oi].text), c)) { return opts[oi]; }
        }
      }
    }
    return null;
  };

  /* Gán giá trị theo cách «React/Angular/Vue» nhận biết được (gọi setter gốc rồi bắn sự kiện). */
  var setNative = function (el, v) {
    var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : (el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) { d.set.call(el, v); } else { el.value = v; }
  };
  var fire = function (el, blur) {
    ['input', 'change'].forEach(function (t) { el.dispatchEvent(new Event(t, { bubbles: true })); });
    if (window.jQuery) {
      try { window.jQuery(el).trigger('change'); } catch (e) { }
    }
    if (blur) {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    }
  };

  /* Điền 1 ô. Trả về chuỗi trạng thái: 'ok' | 'khoa' (ô bị khoá) | 'khong-co-lua-chon'. */
  var fillOne = async function (el, spec, v, data) {
    if (el.tagName === 'SELECT') {
      if (el.disabled) {
        var cur = el.options[el.selectedIndex];
        return (cur && norm(cur.text).indexOf(norm(v)) >= 0) ? 'ok' : 'khoa';
      }
      var opt = null;
      for (var t = 0; t < 8 && !opt; t++) {
        opt = pickOption(el, candidates(spec.k, v, data));
        if (!opt) { await sleep(350); }
      }
      if (!opt) { return 'khong-co-lua-chon'; }
      setNative(el, opt.value);
      opt.selected = true;
      fire(el, false);
      return 'ok';
    }
    if (el.disabled) { return 'khoa'; }
    setNative(el, v);
    fire(el, true);
    if (spec.date && window.jQuery && window.jQuery.fn && window.jQuery.fn.datepicker) {
      try { window.jQuery(el).datepicker('update', v); } catch (e) { }
    }
    return 'ok';
  };

  /* Ghép nhãn <-> ô nhập: ưu tiên label.control (for=/lồng nhau), nếu không thì lấy
     ô đầu tiên đứng SAU nhãn trong thứ tự tài liệu và TRƯỚC nhãn kế tiếp. */
  var collectPairs = function () {
    var nodes = document.querySelectorAll('label, input, select, textarea');
    var pairs = [];
    var curLabel = null;
    var curPaired = true;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.tagName === 'LABEL') {
        curLabel = n;
        curPaired = false;
        if (n.control && /^(INPUT|SELECT|TEXTAREA)$/.test(n.control.tagName) && n.control.type !== 'hidden') {
          pairs.push({ label: n, el: n.control });
          curPaired = true;
        }
        continue;
      }
      var type = (n.type || '').toLowerCase();
      if (/^(hidden|checkbox|radio|button|submit|file|image|reset)$/.test(type)) { continue; }
      if (n.classList && n.classList.contains('select2-search__field')) { continue; }
      if (curLabel && !curPaired) {
        pairs.push({ label: curLabel, el: n });
        curPaired = true;
      }
    }
    return pairs;
  };

  /* Bảng kết quả nhỏ ở góc phải trên trang. */
  var showPanel = function (title, okList, missList, note) {
    var old = document.getElementById('qlxe-fill-panel');
    if (old) { old.remove(); }
    var box = document.createElement('div');
    box.id = 'qlxe-fill-panel';
    box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:360px;background:#fff;color:#111;' +
      'border:2px solid #2e7d32;border-radius:8px;padding:10px 12px;font:13px/1.45 Arial,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35);';
    var add = function (tag, text, css) {
      var e = document.createElement(tag);
      e.textContent = text;
      if (css) { e.style.cssText = css; }
      box.appendChild(e);
      return e;
    };
    var close = add('button', '✕', 'position:absolute;top:4px;right:6px;border:0;background:none;font-size:15px;cursor:pointer;');
    close.onclick = function () { box.remove(); };
    add('b', title, 'display:block;margin-bottom:4px;');
    if (okList.length) { add('div', '✔ Đã điền: ' + okList.join(', '), 'color:#1b5e20;'); }
    if (missList.length) { add('div', '⚠ Chưa điền được: ' + missList.join('; '), 'color:#b71c1c;margin-top:4px;'); }
    if (note) { add('div', note, 'margin-top:6px;color:#444;'); }
    document.body.appendChild(box);
    setTimeout(function () { if (box.parentNode) { box.remove(); } }, 25000);
  };

  /* Đọc dữ liệu: clipboard trước, không được thì cho dán tay vào hộp thoại. */
  var getData = async function () {
    var txt = '';
    try { txt = await navigator.clipboard.readText(); } catch (e) { txt = ''; }
    if (txt.indexOf(PREFIX) < 0) {
      txt = window.prompt('Không đọc được clipboard. Dán dữ liệu đã sao chép từ web Quản lý xe vào đây (Ctrl+V):', '') || '';
    }
    var i = txt.indexOf(PREFIX);
    if (i < 0) { return null; }
    try { return JSON.parse(txt.slice(i + PREFIX.length).trim()); } catch (e) { return null; }
  };

  var main = async function () {
    if (location.hostname.indexOf('dichvucong') < 0 &&
      !window.confirm('Trang này không phải cổng dichvucong. Vẫn điền thử?')) { return; }
    var data = await getData();
    if (!data) {
      window.alert('Chưa có dữ liệu. Hãy vào web Quản lý xe, mở Giấy khai thu hồi và bấm «Sao chép → Dịch vụ công» trước.');
      return;
    }
    var pairs = collectPairs();
    var done = {};
    var ok = [];
    var miss = [];
    for (var si = 0; si < SPEC.length; si++) {
      var spec = SPEC[si];
      var v = data[spec.k];
      if (v == null || String(v).trim() === '') { continue; }
      var found = null;
      for (var pi = 0; pi < pairs.length; pi++) {
        if (!done[pi] && spec.re.test(norm(pairs[pi].label.textContent))) { found = pi; break; }
      }
      if (found == null) { miss.push(spec.name + ' (không thấy ô)'); continue; }
      done[found] = true;
      var st;
      try { st = await fillOne(pairs[found].el, spec, String(v), data); } catch (e) { st = 'loi'; }
      if (st === 'ok') { ok.push(spec.name); }
      else if (st === 'khoa') { miss.push(spec.name + ' (ô bị khoá — kiểm tra thủ công)'); }
      else if (st === 'khong-co-lua-chon') { miss.push(spec.name + ' (không có lựa chọn «' + v + '»)'); }
      else { miss.push(spec.name + ' (lỗi)'); }
      /* Sau khi đổi Ô tô/Xe máy, trang có thể nạp lại danh sách Màu biển -> chờ một chút. */
      await sleep(spec.k === 'loaiPT' ? 700 : 150);
    }
    showPanel('Điền nhanh xe ' + (data.bienSo || ''), ok, miss,
      'Hãy kiểm tra lại các ô, tự nhập «Mã bảo mật» rồi bấm «Tra cứu».');
  };
  main();
})();
