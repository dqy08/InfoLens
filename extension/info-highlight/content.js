/**
 * Info Highlight — webpage entry after toolbar inject.
 * 点击：按段流式分析并画热力图。再点清除。
 * 进度图：开跑亮空框，段回了加线；不跟滚、不跳最新段。
 */
(() => {
  if (window.__IH_DEMO__) {
    window.__IH_DEMO__.toggle();
    return;
  }

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

  async function runBatch(myGen) {
    const still = () => myGen === gen;
    busy = true;
    R.reportActionState('analyzing');
    await R.runJob(still, {
      fail(err) {
        clearAll();
        active = true;
        R.reportActionState('on');
        return globalThis.IH_showError(err?.message || err);
      },
      idle() {
        // 已被更新一代取消时不要清 busy：recheck 可能已开跑下一轮
        if (!still()) return;
        busy = false;
        if (active) {
          R.reportActionState('on');
          // complete 时可能还在 busy/pending；本轮画完再核一次正文
          Promise.resolve().then(() => {
            if (myGen !== gen) return;
            recheck();
          });
        }
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

  /** 自动分析用：已在跑或已画好则 false，否则开跑并 true */
  function start() {
    if (busy || active) return false;
    void runBatch(gen += 1);
    return true;
  }

  /**
   * 在 tabs.complete 时（SW）以及本轮分析收尾时调用：
   * 正文相对本轮 session 变了则清掉重跑（缓存命中重复段）。
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
    gen += 1;
    busy = false;
    clearAll();
    R.releaseLocalEngine();
    void runBatch(gen += 1);
    return 'rerun';
  }

  window.__IH_DEMO__ = { toggle, start, recheck };
  toggle();
})();
