/**
 * Info Highlight — webpage entry after toolbar inject.
 * 点击：按段流式分析并画热力图。再点清除。
 * 进度图：开跑亮空框，段回了加线；不跟滚、不跳最新段。
 * 注入可在加载中；抽正文和分析等 complete。
 *
 * 设计：`complete` 只表示可以开始抽，不表示正文已在 DOM。
 * extractStable 是「这份抽字已过晚到窗口」：此前自动分析对拍、必要时整份重来；
 * 此后 DOM 再变只丢掉映不回的高亮，不重抽、不清场。
 */
(() => {
  // 注入只挂 API，开跑由 SW 显式调 toggle / start
  try {
    if (typeof window.__IH_DEMO__?.isLive === 'function' && window.__IH_DEMO__.isLive()) return;
  } catch {
    /* 扩展已重载：旧 API 作废 */
  }

  if (typeof globalThis.IH_extractPage !== 'function') {
    throw new Error('IH_extractPage missing — inject page-map.js before content.js');
  }
  if (!globalThis.IH_prefsReady) {
    throw new Error('IH_prefsReady missing — inject page-map.js first');
  }
  if (typeof globalThis.IH_watchHighlightLive !== 'function') {
    throw new Error('IH_watchHighlightLive missing — inject page-map.js first');
  }
  if (!globalThis.IH_tokenTip) {
    throw new Error('IH_tokenTip missing — inject tokenTip.js before content.js');
  }
  if (!globalThis.IH_analyzeRun) {
    throw new Error('IH_analyzeRun missing — inject analyzeRun.js before content.js');
  }

  const R = globalThis.IH_analyzeRun;
  /** 自动分析：complete 之后还可能晚到正文，开跑后这一窗里对拍 */
  const SETTLE_MS = 1000;
  let gen = 0;
  let busy = false;
  let active = false;
  /** 这份抽字是否已过晚到窗口（手点开跑即稳定；自动分析要等对拍窗结束） */
  let extractStable = false;
  /** @type {{ mapped: { text: string, pieces: unknown[] }, segs: { start: number, end: number, text: string }[], next: number, painted: number, skipCache?: boolean } | null} */
  let session = null;

  function clearAll() {
    extractStable = false;
    session = null;
    globalThis.IH_clearHighlights();
    globalThis.IH_clearProgress();
    globalThis.IH_clearError();
    globalThis.IH_tokenTip.clear();
    active = false;
    R.reportActionState('off');
  }

  function markExtractStable() {
    extractStable = true;
    globalThis.IH_watchHighlightLive();
  }

  function whenComplete() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }

  function continuePaused() {
    if (busy || !session) return;
    void runBatch(gen += 1, false, session.skipCache);
  }

  function pageText() {
    try {
      return globalThis.IH_extractPage().text;
    } catch {
      return '';
    }
  }

  async function openSession(skip) {
    session = await R.beginSession(globalThis.IH_extractPage(), 'No article text');
    session.skipCache = skip;
    globalThis.IH_tokenTip.bind(session.mapped);
    if (extractStable) globalThis.IH_watchHighlightLive();
  }

  /** 第一段画完立刻再抽：和开跑那份不同，视为正文刚进 DOM，丢掉骨架高亮重来。 */
  async function paintAfterFirstSegmentCheck(paintTo, cap, still) {
    let lastAlignErr = await paintTo(1);
    if (!still()) return lastAlignErr;
    if (pageText() !== session.mapped.text) {
      await openSession(session.skipCache);
      return paintTo(Math.min(R.MAX_SEGMENTS_PER_RUN, session.segs.length));
    }
    if (session.next < cap) return paintTo(cap);
    return lastAlignErr;
  }

  async function runBatch(myGen, settle, skipCache) {
    const still = () => myGen === gen;
    const skip = !!skipCache;
    busy = true;
    R.reportActionState('analyzing');
    await whenComplete();
    await globalThis.IH_prefsReady;
    if (!still()) return;
    const t0 = Date.now();
    let heldErr = null;

    const onFailed = ({ report, err }) => {
      globalThis.IH_feedbackContext?.stash({ session, report, err, surface: 'web' });
    };
    const fail = (err) => {
      clearAll();
      active = true;
      R.reportActionState('on');
      return globalThis.IH_showError(err?.message || err);
    };
    const idle = () => {
      if (!still()) return;
      busy = false;
      if (!active) return;
      R.reportActionState('on');
    };
    // settle：idle 延到对拍窗结束，图标一直显示分析中
    const hooks = settle
      ? { fail: (err) => { heldErr = err; }, idle() {}, onFailed }
      : { fail, idle, onFailed };
    const job = async (report) => {
      if (!settle) extractStable = true;
      if (!session) await openSession(skip);
      const opts = { onTokens: (tokens) => globalThis.IH_tokenTip.add(tokens), skipCache: skip };
      const paintTo = async (to) => {
        const err = await R.paintRange(session, session.next, to, still, opts, report);
        if (still()) session.next = to;
        return err;
      };
      const cap = Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length);
      const lastAlignErr = (settle && !extractStable && session.next === 0 && cap > 0)
        ? await paintAfterFirstSegmentCheck(paintTo, cap, still)
        : await paintTo(cap);
      if (!still()) return;
      await R.afterPaint(session, lastAlignErr, 'No tokens mapped onto the page', () => {
        return globalThis.IH_showPaused(continuePaused);
      }, report);
      active = true;
    };

    await R.runJob(still, hooks, job);
    if (!still()) return;
    if (!settle) {
      markExtractStable();
      return;
    }

    const left = SETTLE_MS - (Date.now() - t0);
    if (left > 0) {
      await new Promise((r) => setTimeout(r, left));
      if (!still()) return;
      if (pageText() !== (session?.mapped?.text || '')) {
        heldErr = null;
        session = null;
        active = false;
        await R.runJob(still, hooks, job);
        if (!still()) return;
      }
    }
    if (heldErr) {
      await fail(heldErr);
      idle();
      return;
    }
    markExtractStable();
    idle();
  }

  function setEnabled(on) {
    if (on) {
      if (busy || active) return;
      void runBatch(gen += 1, false, false);
      return;
    }
    if (busy || active) {
      gen += 1;
      busy = false;
      clearAll();
    }
  }

  function toggle() {
    setEnabled(!(busy || active));
  }

  function force() {
    if (busy) {
      alert(R.FORCE_BUSY_MSG);
      return;
    }
    if (active) clearAll();
    void runBatch(gen += 1, false, true);
  }

  function isLive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  /** 自动分析用：开跑返回 true；已有一轮在跑返回 'busy'、已画好返回 'painted'（都不动它）。 */
  function start() {
    if (busy) return 'busy';
    if (active) return 'painted';
    void runBatch(gen += 1, true, false);
    return true;
  }

  // SYNC: background.js → pageCsPeek 的 data-ih-cs
  document.documentElement.setAttribute('data-ih-cs', '');
  window.__IH_DEMO__ = { toggle, start, force, isLive, setEnabled };
})();
