/**
 * 工具栏图标三态（按 tab）：off 默认红 / analyzing 灰→红 8 格 / on 绿勾。
 * 分析中短时忽略重复点击（防误触取消）。
 * TILES 与 icons/render-icons.py 的字块数一致。
 */
(() => {
  const GRACE_MS = 500;
  const TILES = 8;
  const TITLE = {
    off: 'Info Highlight',
    analyzing: 'Analyzing… · click to cancel',
    on: 'Click to clear',
  };

  /** @type {Map<number, { state: 'off' | 'analyzing' | 'on', filled: number, since: number }>} */
  const byTab = new Map();

  function clampFilled(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v >= TILES ? TILES : v;
  }

  function iconsFor(state, filled) {
    if (state === 'on') {
      return { 16: 'icons/icon16-on.png', 32: 'icons/icon32-on.png' };
    }
    if (state !== 'analyzing') {
      return { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
    }
    const n = clampFilled(filled);
    if (n >= TILES) return { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
    const suffix = n === 0 ? '-busy' : `-busy-${n}`;
    return {
      16: `icons/icon16${suffix}.png`,
      32: `icons/icon32${suffix}.png`,
    };
  }

  /**
   * @param {number} tabId
   * @param {'off' | 'analyzing' | 'on'} state
   * @param {number} [filled]
   */
  function setTabActionState(tabId, state, filled) {
    if (!tabId || (state !== 'off' && state !== 'analyzing' && state !== 'on')) return;
    const prev = byTab.get(tabId);
    const nextFilled = state === 'analyzing' ? clampFilled(filled) : 0;
    const since =
      state === 'analyzing'
        ? (prev?.state === 'analyzing' ? prev.since : Date.now())
        : 0;
    if (prev?.state === state && prev.filled === nextFilled) return;
    byTab.set(tabId, { state, filled: nextFilled, since });
    void chrome.action.setIcon({ tabId, path: iconsFor(state, nextFilled) });
    void chrome.action.setTitle({ tabId, title: TITLE[state] });
  }

  /** @param {number} tabId */
  function tabActionState(tabId) {
    return byTab.get(tabId)?.state || 'off';
  }

  /**
   * 分析中且仍在防误触窗口内 → true（应忽略本次点击）。
   * @param {number} tabId
   */
  function shouldIgnoreActionClick(tabId) {
    const cur = byTab.get(tabId);
    if (!cur || cur.state !== 'analyzing') return false;
    return Date.now() - cur.since < GRACE_MS;
  }

  /** 即将开始分析时预置 analyzing，便于注入完成前的连点也被挡住。 */
  function markAnalyzingIfIdle(tabId) {
    if (tabActionState(tabId) === 'off') setTabActionState(tabId, 'analyzing');
  }

  function clearTabActionState(tabId) {
    byTab.delete(tabId);
  }

  globalThis.IH_actionState = {
    GRACE_MS,
    set: setTabActionState,
    get: tabActionState,
    shouldIgnoreClick: shouldIgnoreActionClick,
    markAnalyzingIfIdle,
    clear: clearTabActionState,
  };
})();
