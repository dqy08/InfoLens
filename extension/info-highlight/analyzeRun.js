/**
 * 网页 / PDF 共用：向 SW 要 token、按段画、对齐失败跳过。
 */
globalThis.IH_analyzeRun ||= (function () {
  /** SYNC: extension/semantic-highlight/semantic/find.js → MAX_CHUNKS_PER_SEARCH */
  const MAX_SEGMENTS_PER_RUN = 32;
  /** SYNC: local/scoring.js → alignUtf16Offsets fail() */
  const ALIGN_FAIL = 'token offset align failed';

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

  async function analyzeSegment(text, segs, i) {
    if (!/\S/.test(segs[i].text)) return [];
    const win = globalThis.IH_segmentWindow(text, segs, i);
    const tokens = (await sendAnalyze(win.requestText))?.result?.bpe_strings;
    if (!Array.isArray(tokens)) throw new Error('Analyze returned no tokens');
    return globalThis.IH_tokensInSegment(tokens, win);
  }

  function applyTokens(session, tokens, i, opts) {
    session.painted += globalThis.IH_paintTokens(tokens, session.mapped, {
      append: true,
      overlay: !!opts?.overlay,
    });
    opts?.onTokens?.(tokens, i);
    globalThis.IH_appendProgress(tokens, session.segs[i]);
  }

  /**
   * @param {{ mapped: { text: string }, segs: unknown[], painted: number }} session
   * @param {number} from
   * @param {number} to
   * @param {() => boolean} still
   * @param {{ overlay?: boolean, onTokens?: (tokens: unknown[], i: number) => void }} [opts]
   * @returns {Promise<Error | undefined>}
   */
  async function paintRange(session, from, to, still, opts) {
    let lastAlignErr;
    for (let i = from; i < to; i++) {
      if (!still()) return lastAlignErr;
      let tokens;
      try {
        tokens = await analyzeSegment(session.mapped.text, session.segs, i);
      } catch (err) {
        if (!still()) return lastAlignErr;
        if (!String(err?.message || err).includes(ALIGN_FAIL)) throw err;
        console.warn('[Info Highlight] skip segment', i, err);
        lastAlignErr = err;
        continue;
      }
      if (!still()) return lastAlignErr;
      applyTokens(session, tokens, i, opts);
    }
    return lastAlignErr;
  }

  async function beginSession(mapped, emptyMsg) {
    const segs = globalThis.IH_splitSegments(mapped.text);
    if (!segs.length) throw new Error(emptyMsg);
    globalThis.IH_clearHighlights();
    await globalThis.IH_bindProgress(mapped, segs);
    return { mapped, segs, next: 0, painted: 0 };
  }

  async function afterPaint(session, lastAlignErr, emptyMsg, onMore) {
    await globalThis.IH_setProgressSearching(false);
    if (session.next < session.segs.length) {
      await onMore();
      return;
    }
    if (!session.painted) throw lastAlignErr || new Error(emptyMsg);
  }

  /**
   * @param {() => boolean} still
   * @param {{ fail: (err: unknown) => void | Promise<void>, idle: () => void }} hooks
   * @param {() => Promise<void>} job
   */
  async function runJob(still, { fail, idle }, job) {
    globalThis.IH_clearError();
    await globalThis.IH_setProgressSearching(true);
    try {
      await job();
    } catch (err) {
      if (!still()) return;
      await fail(err);
    } finally {
      if (!still()) return;
      idle();
      releaseLocalEngine();
    }
  }

  return {
    MAX_SEGMENTS_PER_RUN,
    releaseLocalEngine,
    beginSession,
    paintRange,
    afterPaint,
    runJob,
  };
})();
