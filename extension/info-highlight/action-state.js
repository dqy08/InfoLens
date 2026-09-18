/**
 * 工具栏图标三态（按 tab）：off 默认红 / analyzing 灰 / on 加浓红。
 * 分析中短时忽略重复点击（防误触取消）。
 */
(() => {
  const GRACE_MS = 500;
  const TITLE = {
    off: 'Info Highlight',
    analyzing: 'Analyzing… · click to cancel',
    on: 'Click to clear',
  };

  /** @type {Map<number, { state: 'off' | 'analyzing' | 'on', since: number }>} */
  const byTab = new Map();

  function iconsFor(state) {
    const suffix = state === 'analyzing' ? '-busy' : state === 'on' ? '-on' : '';
    return {
      16: `icons/icon16${suffix}.png`,
      32: `icons/icon32${suffix}.png`,
    };
  }

  /**
   * @param {number} tabId
   * @param {'off' | 'analyzing' | 'on'} state
   */
  function setTabActionState(tabId, state) {
    if (!tabId || (state !== 'off' && state !== 'analyzing' && state !== 'on')) return;
    const prev = byTab.get(tabId);
    const since =
      state === 'analyzing'
        ? (prev?.state === 'analyzing' ? prev.since : Date.now())
        : 0;
    byTab.set(tabId, { state, since });
    void chrome.action.setIcon({ tabId, path: iconsFor(state) });
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
