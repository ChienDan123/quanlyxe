/* =========================================================================
   sync-issues.js — CHI TIẾT LỖI ĐỒNG BỘ LÊN GOOGLE SHEET (bấm vào dòng «⏳ N thay đổi lỗi…» để xem)
   Vấn đề cũ: badge chỉ báo «N thay đổi lỗi — đang chờ thử lại» nhưng người dùng không biết thay đổi nào, lỗi gì, làm sao khắc phục.
   Module này làm 3 việc (hàng đợi + thử lại ngầm vẫn nằm trong app.js, không đổi cơ chế):
     1) classify(msg, attempts): PHÂN LOẠI lỗi
          • 'retry' = lỗi tạm (mất mạng, 429, 5xx, quá tải…) → hệ thống tự thử lại, người dùng không cần làm gì.
          • 'user'  = lỗi CẦN NGƯỜI DÙNG xử lý (sai quyền, chưa Deploy bản mới, thiếu cột, dữ liệu không hợp lệ…) → dừng tự thử
                      (không chặn các thay đổi khác) và hiện rõ cách khắc phục. Lỗi lạ lặp lại nhiều lần cũng được nâng lên 'user'.
     2) Bảng chi tiết (modal #syncIssuesModal): mỗi thay đổi lỗi = xe nào · sửa trường nào · lỗi gì (nguyên văn) · cách khắc phục · nút Thử lại / Bỏ.
     3) Nút «Sao chép chi tiết» để gửi cho người hỗ trợ.
   Phụ thuộc (app.js): syncQueue qua window.SyncQueueAPI, state, FIELD_MAP, escapeHtml, toast, openModal/closeModal, isWriteConnected.
   Nạp SAU app.js. Nếu file này không nạp được, app.js vẫn chạy như cũ (coi mọi lỗi là lỗi tạm).
   ========================================================================= */
const SyncIssues = (() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MODAL = 'syncIssuesModal';
  const API = () => window.SyncQueueAPI;

  /* ---------------- 1) PHÂN LOẠI LỖI ----------------
     Mỗi luật: re = nhận dạng trong nội dung lỗi · kind · code · title · hint (+ steps = các bước làm) · escalateAfter = số lần thử thất bại
     thì nâng lên «cần người dùng» (cho lỗi có thể là tạm thời nhưng nếu lặp mãi thì chắc chắn do cấu hình).
     THỨ TỰ QUAN TRỌNG: luật cụ thể đặt trước luật chung. Nội dung lỗi nguyên văn luôn được hiện kèm, nên luật chưa bắt hết vẫn không mất thông tin. */
  const REDEPLOY = ['Mở Google Sheet → Tiện ích mở rộng → Apps Script. Dán file AppsScript_UpdateRow.gs (chứa doPost duy nhất) và đổi tên MỌI hàm doPost khác (Code.gs, AppsScript.gs, AppsScript_DoPost.gs…) thành doPostCu_.',
    'Bấm Triển khai → Quản lý triển khai → biểu tượng bút chì → Phiên bản: «Phiên bản mới» → Triển khai (giữ nguyên URL /exec).',
    'Quay lại web, bấm «Thử lại».'];
  const RULES = [
    { re: /unknown action|invalid action|unsupported action|action .{0,40}(không|chưa) (hợp lệ|hỗ trợ|được hỗ trợ|biết)|(không|chưa) (hỗ trợ|biết) action/i,
      kind: 'user', code: 'action_missing', title: 'Apps Script chưa có chức năng này (chưa Deploy bản mới)',
      hint: 'Apps Script đang chạy là bản cũ, chưa biết lệnh mà web vừa gửi.', steps: REDEPLOY },
    { re: /permission|authori[sz]ation|unauthori[sz]ed|forbidden|access denied|not have access|requires? (access|authori)|không có quyền|chưa cấp quyền|(http|status|code|lỗi)\s*:?\s*40[13]\b/i,
      kind: 'user', code: 'permission', title: 'Sai quyền truy cập / chưa cấp quyền',
      hint: 'Apps Script không được phép ghi vào Google Sheet này, hoặc Web App chưa mở cho «Bất kỳ ai».',
      steps: ['Mở Apps Script → Triển khai → Quản lý triển khai → Chỉnh sửa: «Thực thi với tư cách: Tôi» và «Người có quyền truy cập: Bất kỳ ai».',
        'Chạy thử 1 hàm bất kỳ trong trình soạn thảo Apps Script một lần để cấp quyền Google Sheet khi được hỏi.',
        'Chắc chắn tài khoản triển khai là CHỦ hoặc có quyền SỬA file Sheet. Rồi bấm «Thử lại».'] },
    { re: /protected|được bảo vệ|đang bị khóa sheet|bảo vệ (trang tính|vùng)/i,
      kind: 'user', code: 'protected', title: 'Ô / trang tính đang được bảo vệ',
      hint: 'Vùng dữ liệu này bị khóa chỉnh sửa trên Google Sheet.',
      steps: ['Mở Sheet → Dữ liệu → Trang tính và dải ô được bảo vệ → bỏ bảo vệ hoặc thêm tài khoản triển khai vào danh sách được sửa.', 'Bấm «Thử lại».'] },
    { re: /(sheet|tab|trang tính).{0,40}(not found|không tồn tại|không tìm thấy|không có)|SHEET_NAME|getSheetByName/i,
      kind: 'user', code: 'sheet_name', title: 'Không tìm thấy tab dữ liệu trong Sheet',
      hint: 'Tên tab đặt trong Apps Script (SHEET_NAME) không khớp với tên tab thật trên Google Sheet.',
      steps: ['Mở Apps Script, sửa hằng số SHEET_NAME ở đầu file cho đúng tên tab (phân biệt hoa/thường, dấu cách).', 'Triển khai phiên bản mới rồi bấm «Thử lại».'] },
    { re: /(không (tìm thấy|có|tồn tại)|thiếu|missing|not found|no such).{0,30}(cột|column|header|tiêu đề)|(cột|column|header|tiêu đề).{0,40}(không tồn tại|không tìm thấy|not found|missing|không có)/i,
      kind: 'user', code: 'column', title: 'Thiếu cột trên Google Sheet',
      hint: 'Sheet không có cột tương ứng với trường đang sửa (hoặc dòng tiêu đề bị đổi tên).',
      steps: ['Mở Sheet, kiểm tra dòng tiêu đề có đúng tên cột như trong chi tiết thay đổi (ví dụ «Biển số», «Ghi Chú»).', 'Thêm cột còn thiếu hoặc đổi lại tên cột cho khớp, rồi bấm «Thử lại».'] },
    { re: /(không (tìm thấy|có|khớp)|not found|cannot find|couldn.?t find).{0,40}(dòng|hàng|bản ghi|row|record|match)|row not found|no matching row|không khớp dòng/i,
      kind: 'user', code: 'row_missing', title: 'Không tìm thấy dòng xe này trên Sheet',
      hint: 'Mã ID / MOTO_ID / Biển số dùng để tìm dòng không còn khớp (dòng bị xóa hoặc đã đổi giá trị trên Sheet).',
      steps: ['Bấm «⟳ Tải lại» trên web để lấy dữ liệu mới nhất từ Sheet, kiểm tra xe còn tồn tại không.', 'Nếu dòng đã bị xóa/đổi khóa: bấm «Bỏ thay đổi này». Nếu còn: sửa lại cho đúng rồi «Thử lại».'] },
    { re: /phản hồi không hợp lệ|unexpected token|is not valid json|<!doctype|<html|unexpected end of json|json\.parse|not valid json/i,
      kind: 'retry', escalateAfter: 3, code: 'bad_response', title: 'Apps Script trả về nội dung không đọc được',
      hint: 'Thường do Google tạm lỗi. Nếu lặp lại, nhiều khả năng URL /exec sai, Web App chưa Deploy hoặc chưa mở cho «Bất kỳ ai».',
      steps: ['Mở Cài đặt kết nối, kiểm tra URL Apps Script kết thúc bằng /exec và còn hoạt động.',
        'Apps Script → Triển khai → Quản lý triển khai: loại «Ứng dụng web», quyền truy cập «Bất kỳ ai».', 'Triển khai phiên bản mới nếu vừa sửa mã, rồi bấm «Thử lại».'] },
    { re: /(http|status|code|lỗi)\s*:?\s*429\b|too many (times|requests)|invoked too many|quota|rate.?limit|exceeded.{0,30}(limit|quota)|service invoked|đã vượt quá|quá nhiều (lần|yêu cầu)/i,
      kind: 'retry', escalateAfter: 12, code: 'quota', title: 'Google đang giới hạn tốc độ (quá nhiều yêu cầu)',
      hint: 'Tạm thời. Hệ thống tự giãn thời gian rồi gửi lại, dữ liệu không mất.' },
    { re: /(http|status|code|lỗi)\s*:?\s*50[0234]\b|server error|service unavailable|internal error|backend error|exceeded maximum execution time|\block\b|lock timeout|timed? ?out|timeout|bận|quá tải|overloaded|high demand/i,
      kind: 'retry', escalateAfter: 12, code: 'server', title: 'Máy chủ Google đang bận / quá tải',
      hint: 'Tạm thời. Hệ thống tự thử lại, không cần làm gì.' },
    { re: /failed to fetch|networkerror|network request failed|load failed|net::err_|err_(internet|network|connection|name)|offline|mất mạng|abort|ECONN|ETIMEDOUT/i,
      kind: 'retry', escalateAfter: 0, code: 'network', title: 'Không kết nối được tới Google (mất mạng / bị chặn)',
      hint: 'Kiểm tra Wi-Fi/4G. Có mạng lại là tự gửi tiếp. Nếu mạng bình thường mà vẫn lỗi mãi: kiểm tra URL Apps Script và tiện ích chặn quảng cáo / VPN.' },
    { re: /không hợp lệ|invalid|sai định dạng|dữ liệu.{0,20}(lỗi|sai)|quá (dài|lớn)|too (long|large)|exceeds?|50000|limit of|không thể ghi|cannot (write|set)|type mismatch|validation|data validation/i,
      kind: 'user', code: 'invalid_data', title: 'Dữ liệu không hợp lệ với Sheet',
      hint: 'Giá trị vừa nhập bị Sheet từ chối (sai định dạng, quá dài hoặc vi phạm quy tắc kiểm tra dữ liệu của ô).',
      steps: ['Xem giá trị đã sửa ở phần «Thay đổi» bên dưới, sửa lại cho đúng định dạng trên web.', 'Bấm «Thử lại», hoặc «Bỏ thay đổi này» nếu không cần nữa.'] },
  ];
  const UNKNOWN = { kind: 'retry', escalateAfter: 6, code: 'unknown', title: 'Lỗi chưa rõ nguyên nhân',
    hint: 'Chưa nhận dạng được lỗi này. Hệ thống thử lại vài lần; nếu vẫn lỗi sẽ chuyển sang «cần bạn xử lý». Hãy xem nội dung lỗi nguyên văn bên dưới.' };

  // Trả { kind, code, title, hint, steps?, escalated? }. attempts = số lần đã thử thất bại của tác vụ (kể cả lần vừa lỗi).
  function classify(msg, attempts) {
    const text = String(msg == null ? '' : msg);
    const rule = RULES.find((r) => r.re.test(text)) || UNKNOWN;
    const out = { kind: rule.kind, code: rule.code, title: rule.title, hint: rule.hint, steps: rule.steps || null };
    if (rule.kind === 'retry' && rule.escalateAfter && (attempts || 0) >= rule.escalateAfter) {
      out.kind = 'user'; out.escalated = true;
      out.title += ' — lặp lại nhiều lần';
      out.hint = 'Đã thử lại ' + attempts + ' lần vẫn lỗi nên khả năng cao không phải sự cố tạm thời. ' + (rule.hint || '');
      out.steps = rule.steps || ['Kiểm tra URL / quyền / bản Deploy của Apps Script (Cài đặt kết nối).', 'Xem nội dung lỗi nguyên văn bên dưới, rồi bấm «Thử lại».'];
    }
    return out;
  }

  /* ---------------- 2) BẢNG CHI TIẾT ---------------- */
  const fmtTime = (t) => t ? new Date(t).toLocaleTimeString('vi-VN') : '—';
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

  // Tìm dòng xe trên bảng để hiện «biển số · chủ xe» thay vì chỉ có mã khóa
  function rowOf(job) {
    try {
      const f = FIELD_MAP.find((x) => x.header === job.matchHeader);
      return f ? (state.rawData || []).find((r) => (r[f.key] || '') === job.matchValue) : null;
    } catch (e) { return null; }
  }
  function titleOf(job) {
    const r = rowOf(job);
    if (r) { const bits = [r.bienSo, r.chuXe].filter(Boolean); if (bits.length) return bits.join(' · '); }
    return job.matchHeader + ': ' + job.matchValue;
  }
  const changesHtml = (job) => Object.keys(job.updates || {}).map((h) =>
    `<li><b>${esc(h)}</b> → <span class="si-val">${esc(clip(job.updates[h], 90)) || '<i>(để trống)</i>'}</span></li>`).join('') || '<li><i>(không có nội dung)</i></li>';

  function classOf(job) {
    // Tác vụ chưa lỗi lần nào -> chưa có phân loại; còn lại phân loại lại từ nội dung lỗi (luật có thể đã được cập nhật)
    if (!job.attempts) return null;
    return classify(job.lastError, job.attempts);
  }
  function cardHtml(job, kind) {
    const c = classOf(job), busy = job.current;
    const steps = c && c.steps ? `<ol class="si-steps">${c.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';
    const err = job.lastError ? `<details class="si-raw"><summary>Nội dung lỗi nguyên văn</summary><pre>${esc(job.lastError)}</pre></details>` : '';
    return `<div class="si-card si-${kind}" data-job="${esc(job.id)}">
      <div class="si-head"><b>🚗 ${esc(titleOf(job))}</b><span class="si-meta">${job.attempts ? 'đã thử ' + job.attempts + ' lần · lần cuối ' + fmtTime(job.lastErrorAt) : 'đang chờ gửi'}</span></div>
      <div class="si-sec">Thay đổi cần ghi lên Sheet:</div><ul class="si-changes">${changesHtml(job)}</ul>
      ${c ? `<div class="si-err"><b>${esc(c.title)}</b><div>${esc(c.hint || '')}</div></div>${steps}${err}` : ''}
      <div class="si-actions">
        <button type="button" class="btn btn-primary btn-sm" data-si="retry" ${busy ? 'disabled' : ''}>🔁 ${kind === 'user' ? 'Thử lại sau khi đã xử lý' : 'Thử ngay'}</button>
        <button type="button" class="btn btn-ghost btn-sm si-drop" data-si="drop" ${busy ? 'disabled' : ''} title="Bỏ thay đổi này khỏi hàng đợi (giá trị vẫn hiện trên máy này nhưng sẽ không lên Sheet)">🗑 Bỏ thay đổi này</button>
        ${busy ? '<span class="hint">đang gửi…</span>' : ''}
      </div></div>`;
  }

  function render() {
    const body = $('#syncIssuesBody'); if (!body || !API()) return;
    const jobs = API().list();
    if (!jobs.length) { body.innerHTML = '<div class="si-empty">✅ Không còn thay đổi nào chờ đồng bộ.</div>'; return; }
    const user = [], retry = [], wait = [];
    jobs.forEach((j) => { (j.blocked ? user : (j.attempts ? retry : wait)).push(j); });
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const conn = (typeof isWriteConnected === 'function' && !isWriteConnected()) ? '<div class="si-note">⚠ Chưa kết nối Apps Script 2 chiều nên hàng đợi đang tạm dừng — kết nối lại ở nút «Kết nối» để tiếp tục gửi.</div>' : '';
    body.innerHTML = conn + (offline ? '<div class="si-note">📴 Máy đang mất mạng — các thay đổi sẽ tự gửi khi có mạng lại.</div>' : '')
      + '<p class="hint">Mọi thay đổi đều đã được lưu trên máy này, không bị mất. Lỗi tạm thời (mạng, quá tải) tự thử lại; chỉ lỗi ở mục đầu tiên mới cần bạn làm gì đó.</p>'
      + (user.length ? `<h3 class="si-h si-h-user">⚠️ Cần bạn xử lý (${user.length})</h3><div class="hint">Các thay đổi này KHÔNG tự thử lại; các thay đổi khác vẫn được gửi bình thường.</div>${user.map((j) => cardHtml(j, 'user')).join('')}` : '')
      + (retry.length ? `<h3 class="si-h si-h-retry">⏳ Đang tự thử lại (${retry.length}) — không cần làm gì</h3>${retry.map((j) => cardHtml(j, 'retry')).join('')}` : '')
      + (wait.length ? `<h3 class="si-h">🕒 Đang chờ gửi (${wait.length})</h3>${wait.map((j) => cardHtml(j, 'wait')).join('')}` : '');
  }

  // Văn bản chẩn đoán để dán gửi người hỗ trợ
  function diagText() {
    const jobs = API().list();
    return ['Chẩn đoán đồng bộ — ' + new Date().toLocaleString('vi-VN'), 'Số thay đổi trong hàng đợi: ' + jobs.length, ''].concat(jobs.map((j, i) => {
      const c = classOf(j);
      return `#${i + 1} ${titleOf(j)} | khóa ${j.matchHeader}=${j.matchValue}\n  thay đổi: ${Object.keys(j.updates || {}).map((h) => h + '=' + clip(j.updates[h], 60)).join('; ')}\n  trạng thái: ${j.blocked ? 'CẦN XỬ LÝ' : (j.attempts ? 'tự thử lại' : 'chờ gửi')}${c ? ' [' + c.code + '] ' + c.title : ''}\n  lỗi nguyên văn: ${j.lastError || '—'}`;
    })).join('\n');
  }

  async function onClick(e) {
    const t = e.target.closest('[data-si]'); if (!t || !API()) return;
    const act = t.dataset.si, card = t.closest('[data-job]'), id = card && card.dataset.job;
    if (act === 'retry' && id) { API().retry(id); toast('Đang thử gửi lại…'); }
    else if (act === 'drop' && id) {
      if (!confirm('Bỏ thay đổi này khỏi hàng đợi?\n\nGiá trị vẫn hiện trên máy này nhưng sẽ KHÔNG được ghi lên Google Sheet (khi tải lại dữ liệu từ Sheet sẽ trở về giá trị cũ).')) return;
      API().drop(id); toast('Đã bỏ thay đổi khỏi hàng đợi.');
    } else if (act === 'retry-all') { API().retryAll(); toast('Đang thử gửi lại tất cả…'); }
    else if (act === 'copy') {
      try { await navigator.clipboard.writeText(diagText()); toast('Đã sao chép chi tiết lỗi.'); } catch (err) { toast('Không sao chép được — hãy bôi đen nội dung rồi copy tay.', true); }
    }
    render();
  }

  function open() {
    if (!API() || !API().list().length) return;
    render(); openModal(MODAL);
  }
  const isOpen = () => { const m = $('#' + MODAL); return !!m && !m.classList.contains('hidden'); };
  // app.js gọi mỗi khi hàng đợi / trạng thái đổi: nếu bảng đang mở thì vẽ lại cho khớp (vd. gửi xong thì thẻ biến mất)
  function onQueueChange() { if (isOpen()) render(); }

  function init() {
    const badge = $('#syncStatusBadge');
    if (badge && !badge._si) {
      badge._si = true;
      badge.setAttribute('role', 'button'); badge.tabIndex = 0; badge.title = 'Bấm để xem chi tiết các thay đổi đang chờ / bị lỗi';
      badge.addEventListener('click', open);
      badge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    }
    const modal = $('#' + MODAL); if (modal && !modal._si) { modal._si = true; modal.addEventListener('click', onClick); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return { classify, open, render, onQueueChange, diagText };
})();
window.SyncIssues = SyncIssues;
