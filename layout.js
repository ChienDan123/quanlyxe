/* =========================================================================
   layout.js — Thu gọn / mở rộng các khối lọc ở trang chủ
   (🔎 Lọc theo · 🚫 Loại trừ · ↕️ Sắp xếp theo)
   - Nhấn vào tiêu đề (hoặc nút ▾/▸) để ẩn/hiện nội dung khối.
   - Trạng thái được nhớ lại (localStorage) cho lần mở trang sau.
   - Khi đang thu gọn vẫn hiện số điều kiện đang áp dụng, tránh quên bộ lọc
     đang bật mà không thấy.
   Nạp SAU app.js (dùng biến toàn cục `state`).
   ========================================================================= */
(function () {
  'use strict';
  const KEY = 'vehicleBlockCollapsedV1';
  const BLOCKS = ['filterBar', 'excludeBar', 'sortBar'];

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }

  // Đếm điều kiện đang áp dụng của từng khối (chỉ để hiện huy hiệu khi thu gọn)
  function activeCount(id) {
    if (typeof state === 'undefined') return 0;
    try {
      if (id === 'filterBar') {
        return Object.values(state.filters).reduce((n, set) => n + set.size, 0) + (state.quickDiaBan ? 1 : 0);
      }
      if (id === 'sortBar') return (state.sortCriteria || []).length;
    } catch (e) { /* state chưa sẵn sàng */ }
    return 0; // excludeBar đã có sẵn dòng tóm tắt #excludeSummary nằm trong tiêu đề
  }

  const items = [];
  BLOCKS.forEach((id) => {
    const bar = document.getElementById(id);
    const title = bar && bar.querySelector(':scope > .filter-section-title');
    if (!bar || !title) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'block-toggle';
    title.insertBefore(btn, title.firstChild);

    const badge = document.createElement('span');
    badge.className = 'block-count hidden';
    title.appendChild(badge);

    const apply = (collapsed) => {
      bar.classList.toggle('is-collapsed', collapsed);
      btn.textContent = collapsed ? '▸' : '▾';
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = collapsed ? 'Mở rộng' : 'Thu gọn';
      saved[id] = collapsed;
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* bỏ qua */ }
      refresh();
    };
    title.classList.add('block-title-clickable');
    title.addEventListener('click', () => apply(!bar.classList.contains('is-collapsed')));
    apply(!!saved[id]);
    items.push({ id, bar, badge });
  });

  function refresh() {
    items.forEach(({ id, bar, badge }) => {
      const n = activeCount(id);
      const show = bar.classList.contains('is-collapsed') && n > 0;
      badge.classList.toggle('hidden', !show);
      if (show) badge.textContent = id === 'sortBar' ? `${n} tiêu chí` : `${n} điều kiện đang lọc`;
    });
  }
  // Bộ lọc thay đổi ở nhiều nơi trong app.js -> làm tươi huy hiệu theo chu kỳ nhẹ.
  setInterval(refresh, 700);
})();
