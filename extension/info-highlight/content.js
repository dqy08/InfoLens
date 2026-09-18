/**
 * Info Highlight — webpage entry after toolbar inject.
 * 点击：按段流式分析并画热力图。再点清除。
 * 进度图：开跑亮空框，段回了加线；不跟滚、不跳最新段。
 */
(() => {
  // 注入只挂 API，开跑由 SW 显式调 toggle / start
  if (window.__IH_DEMO__) return;

  if (typeof globalThis.IH_extractPage !== 'function') {
    throw new Error('IH_extractPage missing — inject page-map.js before content.js');
  }
  if (!globalThis.IH_tokenTip) {
    throw new Error('IH_tokenTip missing — inject tokenTip.js before content.js');
  }
  if (!globalThis.IH_analyzeRun) {
    throw new Error('IH_analyzeRun missing — inject analyzeRun.js before content.js');
  }

  const R = globalThis.IH_analyzeRun;
  let gen = 0;
  let busy = false;
  let active = false;
  /** @type {{ mapped: { text: string, pieces: unknown[] }, segs: { start: number, end: number, text: string }[], next: number, painted: number } | null} */
  let session = null;

  function clearAll() {
    session = null;
    globalThis.IH_clearHighlights();
    globalThis.IH_clearProgress();
    globalThis.IH_clearError();
    globalThis.IH_tokenTip.clear();
    active = false;
    R.reportActionState('off');
  }

  function continuePaused() {
    if (busy || !session) return;
    void runBatch(gen += 1);
  }

  /** @param {boolean} [auto] 自动触发的一轮：页面还没加载完就失败多半是正文没出来，静默等下一轮 */
  async function runBatch(myGen, auto) {
    const still = () => myGen === gen;
    const early = document.readyState !== 'complete';
    busy = true;
    R.reportActionState('analyzing');
    await R.runJob(still, {
      fail(err) {
        clearAll();
        if (auto && document.readyState !== 'complete') return;
        active = true;
        R.reportActionState('on');
        return globalThis.IH_showError(err?.message || err);
      },
      idle() {
        // 已被更新一代取消时不要清 busy：recheck 可能已开跑下一轮
        if (!still()) return;
        busy = false;
        if (!active) return;
        R.reportActionState('on');
        // 开跑时页面还没加载完：收尾再核一次正文（complete 那次 recheck 可能来得更早）。
        // 加载完之后开的轮不核，免得正文一直变就一直重跑。
        if (!early) return;
        Promise.resolve().then(() => {
          if (myGen !== gen) return;
          recheck();
        });
      },
    }, async (report) => {
      if (!session) {
        session = await R.beginSession(globalThis.IH_extractPage(), 'No article text');
        globalThis.IH_tokenTip.bind(session.mapped);
      }
      const end = Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length);
      const lastAlignErr = await R.paintRange(session, session.next, end, still, {
        onTokens: (tokens) => globalThis.IH_tokenTip.add(tokens),
      }, report);
      if (!still()) return;
      session.next = end;
      await R.afterPaint(session, lastAlignErr, 'No tokens mapped onto the page', () => {
        return globalThis.IH_showPaused(continuePaused);
      }, report);
      active = true;
    });
  }

  function toggle() {
    if (busy || active) {
      gen += 1;
      busy = false;
      clearAll();
      R.releaseLocalEngine();
      return;
    }
    void runBatch(gen += 1);
  }

  /** 自动分析用：开跑返回 true；已有一轮在跑返回 'busy'、已画好返回 'painted'（都不动它）。 */
  function start() {
    if (busy) return 'busy';
    if (active) return 'painted';
    void runBatch(gen += 1, true);
    return true;
  }

  /**
   * 在 tabs.complete 时（SW）以及尝试轮收尾时调用：
   * 正文相对本轮 session 变了则清掉重跑（缓存命中重复段）。重跑一律是正式轮，不会再自己触发 recheck。
   * @returns {false | 'same' | 'pending' | 'rerun'}
   */
  function recheck() {
    if (!busy && !active) return false;
    // 首轮还没抽出 session：让它用此刻 DOM 做完，避免无意义的连环重跑
    if (!session) return 'pending';
    let mapped;
    try {
      mapped = globalThis.IH_extractPage();
    } catch {
      return false;
    }
    const text = typeof mapped?.text === 'string' ? mapped.text : '';
    if (!text || text === session.mapped.text) return 'same';
    clearAll();
    R.releaseLocalEngine();
    void runBatch(gen += 1, true);
    return 'rerun';
  }

  window.__IH_DEMO__ = { toggle, start, recheck };
})();
