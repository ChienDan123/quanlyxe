/* =========================================================================
   scan-review-ai.js — AI KIỂM LẠI NGẦM · LỌC «CHƯA CHẮC CHẮN» · KHÓA TRƯỜNG
   -------------------------------------------------------------------------
   • Nút «🔁 AI kiểm lại tất cả chưa kiểm» — thay nút cũ (ẩn nút cũ bằng text-search).
   • Bộ lọc #rvAvFilter — hook qua window.ScanReviewAVFilter (đã có sẵn trong passesFilter).
   • Nút «🔍 Kiểm thủ công mục nghi vấn» — mở đúng thẻ, chỉ hiện trường nghi vấn,
     mở ảnh đúng phiếu (setFocus → scrollImageToItem), cho chọn Lần 1 / Lần 2 / Sheet,
     khi xác nhận → KHOÁ trường (it.recheck.locked[field] = {by:'user',at}), tự nhảy
     sang xe/trường kế tiếp.
   • Chạy ngầm: chỉ push khi hàng đợi quét không chạy; polling 15s; tiến độ lưu vào
     IndexedDB (it.recheck) — mở lại tab vẫn tiếp tục.
   • Toàn bộ ghi đi qua ScanReview.applyViews / applyFoundItem / setFieldSource —
     KHÔNG viết tay, có history (record/track), không đổi UI hiện có.
   ========================================================================= */
window.ScanReviewAI = (() => {
  'use strict';
  const S = window.ScanApp, Y = window.ScanSync;
  if (!S || !Y) { console.warn('[scan-review-ai] thiếu ScanApp/ScanSync — bỏ qua'); return {}; }
  const DB = S.db, ST_ITEMS = DB.ST_ITEMS;

  // Trường được AI đối chiếu tự động. KHÔNG có nguoiSuDung/nguoiMua* vì FIELD_MAP
  // không có key tương ứng — người dùng tự kiểm thủ công.
  const FIELDS = ['chuXe', 'cccd', 'soDienThoai', 'ghiChu', 'trangThaiXe'];
  const FIELD_LABEL = {
    chuXe: 'Chủ phương tiện', cccd: 'Số CCCD/MST', soDienThoai: 'SĐT',
    ghiChu: 'Ghi chú', trangThaiXe: 'Trạng thái xe'
  };
  // Map field AI ↔ key scanData trong `it`
  const SCAN_KEY = { chuXe: 'chuXe', cccd: 'cccd', soDienThoai: 'soDienThoai', ghiChu: 'ghiChu', trangThaiXe: 'trangThaiXe' };

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toastSafe = (m, err) => { try { if (typeof toast === 'function') toast(m, err); } catch (e) { /* bỏ qua */ } };
  const openM = (id) => { if (typeof openModal === 'function') openModal(id); else { const e = document.getElementById(id); if (e) e.classList.remove('hidden'); } };
  const closeM = (id) => { if (typeof closeModal === 'function') closeModal(id); else { const e = document.getElementById(id); if (e) e.classList.add('hidden'); } };
  const fmtDate = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`; };

  // Đảm bảo các trường recheck tồn tại — không phá normItem nếu đã chạy
  function normSafe(it) {
    if (window.ScanReview && window.ScanReview.normItem) it = window.ScanReview.normItem(it);
    it.recheck = it.recheck || {};
    it.recheck.uncertain = it.recheck.uncertain || {};
    it.recheck.locked = it.recheck.locked || {};
    it.recheck.lan = it.recheck.lan || 0;
    return it;
  }

  /* ======================================================================= */
  /* 1. BỘ LỌC #rvAvFilter — hook vào passesFilter của scan-review.js         */
  /* ======================================================================= */
  let avFilterVal = '';
  window.ScanReviewAVFilter = function (it) {
    if (!avFilterVal) return true;
    const r = (it && it.recheck) || {};
    const hasUnc = Object.keys(r.uncertain || {}).length > 0;
    if (avFilterVal === 'uncertain') return hasUnc;
    if (avFilterVal === 'certain_done') return !hasUnc && (r.lastAiAt || 0) > 0;
    if (avFilterVal === 'locked') return Object.keys(r.locked || {}).length > 0;
    return true;
  };
  function injectFilter() {
    if ($('#rvAvFilter')) return;
    const bar = $('.rv-toolbar') || $('#scanReviewModal .modal-header');
    if (!bar) return;
    const wrap = document.createElement('label');
    wrap.className = 'rv-av-filter-wrap';
    wrap.style.cssText = 'display:inline-flex;gap:6px;align-items:center;margin-left:8px;';
    wrap.innerHTML = 'AI: <select id="rvAvFilter" class="row-inline-select">' +
      '<option value="">Tất cả</option>' +
      '<option value="uncertain">Còn nghi vấn</option>' +
      '<option value="certain_done">AI đã chốt</option>' +
      '<option value="locked">Có trường đã khóa</option>' +
      '</select>';
    bar.appendChild(wrap);
    wrap.querySelector('#rvAvFilter').addEventListener('change', (e) => {
      avFilterVal = e.target.value;
      if (window.ScanReview && window.ScanReview.renderReview) window.ScanReview.renderReview();
    });
  }

  /* ======================================================================= */
  /* 2. Ẩn nút cũ + chèn 2 nút mới                                           */
  /* ======================================================================= */
  function hideOldButton() {
    document.querySelectorAll('button').forEach(btn => {
      if (btn.id === 'btnAiRecheckAll' || btn.id === 'btnAiManualReview') return;
      const txt = (btn.textContent || '').trim();
      if (/^🔁\s*Kiểm lại tất cả|Kiểm lại tất cả chưa kiểm/i.test(txt) && !/AI/.test(txt)) {
        btn.style.display = 'none';
        btn.dataset._aiHidden = '1';
      }
    });
  }
