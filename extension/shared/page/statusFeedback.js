/**
 * 状态条「反馈作者」按钮：与 semantic-find-status-feedback 样式配套。
 */
globalThis.IL_statusFeedback ||= (() => {
  const STATUS_FEEDBACK_ICON =
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 L9.5 2.5 L5.5 10 L5 7 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const STATUS_HEART_ICON =
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.2 C6 10.2 1.8 7.4 1.8 4.6 C1.8 3.2 2.9 2.2 4.2 2.2 C5.1 2.2 5.7 2.7 6 3.3 C6.3 2.7 6.9 2.2 7.8 2.2 C9.1 2.2 10.2 3.2 10.2 4.6 C10.2 7.4 6 10.2 6 10.2 Z" fill="currentColor"/></svg>';

  function resetButton(btn) {
    if (!btn) return;
    btn.hidden = false;
    btn.disabled = false;
    btn.classList.remove('is-thanks');
    btn.innerHTML = STATUS_FEEDBACK_ICON;
    btn.title = 'Report this to the author';
    btn.setAttribute('aria-label', 'Report this to the author');
  }

  function markThanks(btn) {
    if (!btn) return;
    btn.disabled = true;
    btn.classList.add('is-thanks');
    btn.innerHTML = STATUS_HEART_ICON;
    btn.removeAttribute('title');
    btn.setAttribute('aria-label', 'Thanks');
    window.setTimeout(() => {
      if (!btn.isConnected || !btn.classList.contains('is-thanks')) return;
      btn.hidden = true;
      btn.classList.remove('is-thanks');
      btn.innerHTML = STATUS_FEEDBACK_ICON;
    }, 3000);
  }

  /**
   * @param {HTMLButtonElement} btn
   * @param {Record<string, unknown>} body POST /api/extension-feedback 正文
   */
  function sendReport(btn, body) {
    if (!btn || btn.disabled || !body || typeof body !== 'object') return;
    btn.disabled = true;
    chrome.runtime.sendMessage({
      type: 'il-extension-feedback',
      body,
    });
    markThanks(btn);
  }

  return { resetButton, markThanks, sendReport };
})();
