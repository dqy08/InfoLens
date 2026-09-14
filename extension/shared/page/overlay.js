/**
 * 进度图 / 状态条：主题、CSS 加载、状态条 DOM。样式在 ui/overlay.css。
 */
globalThis.IL_overlay ||= (() => {
  function resolveTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(el) {
    if (!el) return;
    el.setAttribute('data-theme', resolveTheme());
  }

  function watchTheme(el) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => applyTheme(el));
  }

  /** @type {Promise<string> | null} */
  let cssTextPromise = null;
  function loadCss() {
    if (!cssTextPromise) {
      cssTextPromise = fetch(chrome.runtime.getURL('ui/overlay.css')).then((r) => {
        if (!r.ok) throw new Error(`failed to load overlay css (${r.status})`);
        return r.text();
      });
    }
    return cssTextPromise;
  }

  /**
   * @param {{
   *   label: string,
   *   detail?: string,
   *   tone?: 'error' | 'info',
   *   continueHidden?: boolean,
   *   feedbackHidden?: boolean,
   *   onContinue?: () => void,
   *   onClose?: () => void,
   * }} opts
   */
  function createStatus(opts) {
    const tone = opts.tone === 'error' ? 'error' : 'info';
    const head = String(opts.label || '').trim() || (tone === 'error' ? 'Failed' : 'Note');
    const body = String(opts.detail || '').trim();

    const el = document.createElement('div');
    el.className =
      tone === 'error'
        ? 'semantic-find-strip semantic-find-status is-error'
        : 'semantic-find-strip semantic-find-status';
    el.setAttribute('role', 'status');

    const textEl = document.createElement('span');
    textEl.className = 'semantic-find-status-text';
    const labelEl = document.createElement('span');
    labelEl.className =
      tone === 'error' ? 'semantic-find-status-label is-error' : 'semantic-find-status-label';
    labelEl.textContent = head;
    textEl.replaceChildren(labelEl, ...(body ? [document.createTextNode(` · ${body}`)] : []));
    textEl.title = body ? `${head} · ${body}` : head;

    const actions = document.createElement('div');
    actions.className = 'semantic-find-status-actions';

    const feedbackBtn = document.createElement('button');
    feedbackBtn.type = 'button';
    feedbackBtn.className = 'semantic-find-status-feedback';
    feedbackBtn.title = 'Report this to the author';
    feedbackBtn.setAttribute('aria-label', 'Report this to the author');
    feedbackBtn.hidden = opts.feedbackHidden !== false;

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'semantic-find-status-continue';
    continueBtn.title = 'Continue';
    continueBtn.setAttribute('aria-label', 'Continue');
    continueBtn.textContent = 'Continue';
    continueBtn.hidden = opts.continueHidden !== false;
    if (opts.onContinue) continueBtn.addEventListener('click', opts.onContinue);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'semantic-find-status-close';
    closeBtn.title = 'Dismiss';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '×';
    if (opts.onClose) closeBtn.addEventListener('click', opts.onClose);

    actions.append(feedbackBtn, continueBtn, closeBtn);
    el.append(textEl, actions);
    return el;
  }

  return { resolveTheme, applyTheme, watchTheme, loadCss, createStatus };
})();
