/**
 * Info Highlight — webpage entry after toolbar inject.
 * 点击：按段流式分析并画热力图。再点清除。
 * 进度图：开跑亮空框，段回了加线；不跟滚、不跳最新段。
 * 注入可在加载中；抽正文和分析等 complete。
 * 自动分析：complete 后马上跑；第一段结束时正文变了就作废重来。整轮 1 秒内结束则等到 1 秒再对一次。补查结束前图标保持分析中。
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

  function whenComplete() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }

  function continuePaused() {
    if (busy || !session) return;
    void runBatch(gen += 1, false);
  }

  function pageText() {
    try {
      return globalThis.IH_extractPage().text;
    } catch {
      return '';
    }
  }

  async function runBatch(myGen, settle) {
    const still = () => myGen === gen;
    busy = true;
    R.reportActionState('analyzing');
    await whenComplete();
    if (!still()) return;
    const t0 = Date.now();
    let heldErr = null;

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
    const hooks = settle
      ? { fail: (err) => { heldErr = err; }, idle() {} }
      : { fail, idle };
    const job = async (report) => {
      if (!session) {
        session = await R.beginSession(globalThis.IH_extractPage(), 'No article text');
        globalThis.IH_tokenTip.bind(session.mapped);
      }
      const opts = { onTokens: (tokens) => globalThis.IH_tokenTip.add(tokens) };
      const paintTo = async (to) => {
        const err = await R.paintRange(session, session.next, to, still, opts, report);
        if (still()) session.next = to;
        return err;
      };
      const cap = Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length);
      let lastAlignErr;
      if (settle && session.next === 0 && cap > 0) {
        lastAlignErr = await paintTo(1);
        if (!still()) return;
        if (pageText() !== session.mapped.text) {
          session = await R.beginSession(globalThis.IH_extractPage(), 'No article text');
          globalThis.IH_tokenTip.bind(session.mapped);
          lastAlignErr = await paintTo(Math.min(R.MAX_SEGMENTS_PER_RUN, session.segs.length));
        } else if (session.next < cap) {
          lastAlignErr = await paintTo(cap);
        }
      } else {
        lastAlignErr = await paintTo(cap);
      }
      if (!still()) return;
      await R.afterPaint(session, lastAlignErr, 'No tokens mapped onto the page', () => {
        return globalThis.IH_showPaused(continuePaused);
      }, report);
      active = true;
    };

    await R.runJob(still, hooks, job);
    if (!still() || !settle) return;
    const left = 1000 - (Date.now() - t0);
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
    if (heldErr) await fail(heldErr);
    idle();
  }

  function toggle() {
    if (busy || active) {
      gen += 1;
      busy = false;
      clearAll();
      return;
    }
    void runBatch(gen += 1, false);
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
    void runBatch(gen += 1, true);
    return true;
  }

  // SYNC: background.js → pageCsPeek 的 data-ih-cs
  document.documentElement.setAttribute('data-ih-cs', '');
  window.__IH_DEMO__ = { toggle, start, isLive };
})();
