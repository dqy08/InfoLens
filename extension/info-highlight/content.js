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

  /** SYNC: extension/semantic-highlight/semantic/find.js → MAX_CHUNKS_PER_SEARCH */
  const MAX_SEGMENTS_PER_RUN = 32;

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
  }

  function sendAnalyze(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'ih-analyze', text }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res?.ok) {
          reject(new Error(res?.error || 'Analyze failed'));
          return;
        }
        resolve(res.data);
      });
    });
  }

  function releaseLocalEngine() {
    chrome.runtime.sendMessage({ type: 'ih-local-unload' }, () => {
      void chrome.runtime.lastError;
    });
  }

  async function fetchTokens(text) {
    const data = await sendAnalyze(text);
    const tokens = data?.result?.bpe_strings;
    if (!Array.isArray(tokens)) throw new Error('Analyze returned no tokens');
    return tokens;
  }

  /** 请求相对坐标；命中缓存后再映射、裁剪到当前文档的这一段（缓存在 SW）。 */
  async function analyzeSegment(text, segs, i) {
    if (!/\S/.test(segs[i].text)) return [];
    const win = globalThis.IH_segmentWindow(text, segs, i);
    const tokens = await fetchTokens(win.requestText);
    return globalThis.IH_tokensInSegment(tokens, win);
  }

  function continuePaused() {
    if (busy || !session) return;
    void runBatch(gen += 1);
  }

  async function runBatch(myGen) {
    busy = true;
    globalThis.IH_clearError();
    globalThis.IH_setProgressSearching(true);
    try {
      if (!session) {
        const mapped = globalThis.IH_extractPage();
        const segs = globalThis.IH_splitSegments(mapped.text);
        if (!segs.length) throw new Error('No article text');
        globalThis.IH_clearHighlights();
        globalThis.IH_bindProgress(mapped, segs);
        globalThis.IH_tokenTip.bind(mapped);
        session = { mapped, segs, next: 0, painted: 0 };
      }
      const { mapped, segs } = session;
      const start = session.next;
      const end = Math.min(start + MAX_SEGMENTS_PER_RUN, segs.length);
      let lastAlignErr;
      for (let i = start; i < end; i++) {
        if (myGen !== gen) return;
        let tokens;
        try {
          tokens = await analyzeSegment(mapped.text, segs, i);
        } catch (err) {
          if (myGen !== gen) return;
          if (!String(err?.message || err).includes('token offset align failed')) throw err;
          console.warn('[Info Highlight] skip segment', i, err);
          lastAlignErr = err;
          continue;
        }
        if (myGen !== gen) return;
        session.painted += globalThis.IH_paintTokens(tokens, mapped, { append: true });
        globalThis.IH_tokenTip.add(tokens);
        globalThis.IH_appendProgress(tokens, segs[i]);
      }
      session.next = end;
      if (myGen !== gen) return;
      globalThis.IH_setProgressSearching(false);
      if (!session.painted) throw lastAlignErr || new Error('No tokens mapped onto the page');
      if (end < segs.length) {
        active = true;
        globalThis.IH_showPaused(continuePaused);
        return;
      }
      active = true;
    } catch (err) {
      if (myGen !== gen) return;
      clearAll();
      globalThis.IH_showError(err?.message || err);
      active = true;
    } finally {
      if (myGen === gen) {
        busy = false;
        releaseLocalEngine();
      }
    }
  }

  function toggle() {
    if (busy || active) {
      gen += 1;
      busy = false;
      clearAll();
      releaseLocalEngine();
      return;
    }
    void runBatch(gen += 1);
  }

  window.__IH_DEMO__ = { toggle };
  toggle();
})();
