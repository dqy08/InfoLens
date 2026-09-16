/**
 * 网页 / PDF 共用：向 SW 要 token、按段画、对齐失败跳过；一轮结束上报用量。
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
        resolve({
          data: res.data,
          inferred: !!res.inferred,
          engine: res.engine === 'local' || res.engine === 'cloud' ? res.engine : null,
        });
      });
    });
  }

  function releaseLocalEngine() {
    chrome.runtime.sendMessage({ type: 'ih-local-unload' }, () => {
      void chrome.runtime.lastError;
    });
  }

  /** 一轮结束后上报；未尝试任何段时不发。 */
  function reportUsage(report) {
    if (!report || report.segments < 1) return;
    chrome.runtime.sendMessage(
      {
        type: 'ih-usage-report',
        engine: report.engine,
        outcome: report.outcome || 'ok',
        segments: report.segments,
        segments_ok: report.segments_ok,
        cached: report.cached,
      },
      () => {
        void chrome.runtime.lastError;
      },
    );
  }

  function newUsageReport() {
    return { segments: 0, segments_ok: 0, cached: 0, engine: null, outcome: null };
  }

  /** @param {boolean | null} inferred 仅 `false` 计为 cache hit；`null` 表示未知（失败路径） */
  function noteAttempt(report, inferred, engine) {
    if (!report) return;
    report.segments += 1;
    if (inferred === false) report.cached += 1;
    if (engine) report.engine = engine;
  }

  /**
   * @returns {Promise<
   *   | { kind: 'empty' }
   *   | { kind: 'ok', tokens: unknown[], inferred: boolean, engine: string | null }
   *   | { kind: 'align_fail', err: Error, inferred: boolean, engine: string | null }
   *   | { kind: 'error', err: Error, inferred: boolean, engine: string | null }
   * >}
   */
  async function analyzeSegment(text, segs, i) {
    if (!/\S/.test(segs[i].text)) return { kind: 'empty' };
    const win = globalThis.IH_segmentWindow(text, segs, i);
    const { data, inferred, engine } = await sendAnalyze(win.requestText);
    const raw = data?.result?.bpe_strings;
    if (!Array.isArray(raw)) {
      return { kind: 'error', err: new Error('Analyze returned no tokens'), inferred, engine };
    }
    try {
      return {
        kind: 'ok',
        tokens: globalThis.IH_tokensInSegment(raw, win),
        inferred,
        engine,
      };
    } catch (err) {
      if (String(err?.message || err).includes(ALIGN_FAIL)) {
        return { kind: 'align_fail', err, inferred, engine };
      }
      throw err;
    }
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
   * @param {{ segments: number, segments_ok: number, cached: number, engine: string | null }} report
   * @returns {Promise<Error | undefined>}
   */
  async function paintRange(session, from, to, still, opts, report) {
    let lastAlignErr;
    for (let i = from; i < to; i++) {
      if (!still()) return lastAlignErr;
      let got;
      try {
        got = await analyzeSegment(session.mapped.text, session.segs, i);
      } catch (err) {
        if (!still()) return lastAlignErr;
        // SW/通道失败：计入尝试，但不记 cached（inferred 未知）
        noteAttempt(report, null, null);
        throw err;
      }
      if (!still()) return lastAlignErr;
      if (got.kind === 'empty') {
        applyTokens(session, [], i, opts);
        continue;
      }
      noteAttempt(report, got.inferred, got.engine);
      if (got.kind === 'error') throw got.err;
      if (got.kind === 'align_fail') {
        console.warn('[Info Highlight] skip segment', i, got.err);
        lastAlignErr = got.err;
        continue;
      }
      if (report) report.segments_ok += 1;
      applyTokens(session, got.tokens, i, opts);
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
   * @param {(report: ReturnType<typeof newUsageReport>) => Promise<void>} job
   */
  async function runJob(still, { fail, idle }, job) {
    globalThis.IH_clearError();
    await globalThis.IH_setProgressSearching(true);
    const report = newUsageReport();
    try {
      await job(report);
      report.outcome = still() ? 'ok' : 'cancelled';
    } catch (err) {
      if (!still()) {
        report.outcome = 'cancelled';
      } else {
        report.outcome = 'failed';
        await fail(err);
      }
    } finally {
      // 取消也要收尾：上报、清 busy、卸本地引擎（避免 busy 卡住）
      reportUsage(report);
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
