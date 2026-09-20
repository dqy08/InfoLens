/**
 * 网页 / PDF 共用：向 SW 要 token、按段画、对齐失败跳过；一轮结束上报用量。
 */
globalThis.IH_analyzeRun ||= (function () {
  /** SYNC: extension/semantic-highlight/semantic/find.js → MAX_CHUNKS_PER_SEARCH */
  const MAX_SEGMENTS_PER_RUN = 32;
  /** SYNC: local/scoring.js → alignUtf16Offsets fail() */
  const ALIGN_FAIL = 'token offset align failed';

  function sendAnalyze(text, skipCache) {
    return new Promise((resolve, reject) => {
      const msg = { type: 'ih-analyze', text };
      if (skipCache) msg.skipCache = true;
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res?.ok) {
          reject(new Error(res?.error || 'Analyze failed'));
          return;
        }
        const model = typeof res.data?.result?.model === 'string' ? res.data.result.model.trim() : '';
        if (model) globalThis.IH_tokenTip?.setModel?.(model);
        resolve({
          data: res.data,
          inferred: !!res.inferred,
          engine: res.engine === 'local' || res.engine === 'cloud' ? res.engine : null,
          model: model || null,
        });
      });
    });
  }

  /** SYNC: action-state.js TILES / icons/render-icons.py TILES */
  const ACTION_TILES = 8;

  /** @param {'off' | 'analyzing' | 'on'} state @param {number} [filled] */
  function reportActionState(state, filled) {
    const msg = { type: 'ih-action-state', state };
    if (state === 'analyzing') {
      const v = Math.floor(Number(filled));
      msg.filled = Number.isFinite(v) && v > 0 ? (v >= ACTION_TILES ? ACTION_TILES : v) : 0;
    }
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  }

  function reportActionFilled(done, total) {
    const n = Number(total);
    if (!(n > 0)) {
      reportActionState('analyzing', 0);
      return;
    }
    reportActionState('analyzing', Math.min(ACTION_TILES, Math.floor((Number(done) * ACTION_TILES) / n)));
  }

  /** 一轮结束后上报；未尝试任何段时不发。失败时附带截断后的 error（不含页面 URL/正文）。 */
  function reportUsage(report) {
    if (!report || report.segments < 1) return;
    const msg = {
      type: 'ih-usage-report',
      engine: report.engine,
      outcome: report.outcome || 'ok',
      segments: report.segments,
      segments_ok: report.segments_ok,
      cached: report.cached,
      duration_ms: Math.max(0, Math.round(Number(report.duration_ms) || 0)),
    };
    if (report.model) msg.model = String(report.model);
    if (report.outcome === 'failed' && report.error) {
      msg.error = String(report.error).slice(0, 500);
    }
    // detail 只给 fail 通道；SW 不得把它写进 /api/extension-usage
    if (report.outcome === 'failed' && report.detail && typeof report.detail === 'object' && !Array.isArray(report.detail)) {
      msg.detail = report.detail;
    }
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  }

  function newUsageReport() {
    return {
      segments: 0,
      segments_ok: 0,
      cached: 0,
      engine: null,
      model: null,
      outcome: null,
      error: null,
      duration_ms: 0,
      align_fail_n: 0,
      tokens_in: 0,
      tokens_skip_level: 0,
      tokens_skip_empty_range: 0,
      painted: 0,
      last_align_err: null,
      detail: null,
    };
  }

  function addPaintStats(report, stats) {
    if (!report || !stats) return;
    report.painted += Number(stats.painted) || 0;
    report.tokens_in += Number(stats.tokens_in) || 0;
    report.tokens_skip_level += Number(stats.tokens_skip_level) || 0;
    report.tokens_skip_empty_range += Number(stats.tokens_skip_empty_range) || 0;
  }

  function clipAlignErr(err) {
    const t = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 200 ? t.slice(0, 199) + '…' : t;
  }

  function highlightsOk() {
    try {
      return !!(globalThis.CSS && globalThis.CSS.highlights);
    } catch {
      return false;
    }
  }

  /** painted===0 诊断：只有数字/布尔/短字符串，无页面 URL/正文。 */
  function buildPaintFailDetail(session, report, lastAlignErr) {
    const mapped = session?.mapped;
    const detail = {
      segments: Number(report?.segments) || 0,
      segments_ok: Number(report?.segments_ok) || 0,
      align_fail_n: Number(report?.align_fail_n) || 0,
      tokens_in: Number(report?.tokens_in) || 0,
      tokens_skip_level: Number(report?.tokens_skip_level) || 0,
      tokens_skip_empty_range: Number(report?.tokens_skip_empty_range) || 0,
      painted: Number(session?.painted) || 0,
      mapped_chars: mapped?.text ? mapped.text.length : 0,
      mapped_pieces: Array.isArray(mapped?.pieces) ? mapped.pieces.length : 0,
      highlights_ok: highlightsOk(),
    };
    const align = clipAlignErr(lastAlignErr || report?.last_align_err);
    if (align) detail.last_align_err = align;
    return detail;
  }

  function formatPaintFailSummary(d) {
    if (!d) return '';
    return `(in=${d.tokens_in} skip_lvl=${d.tokens_skip_level} empty=${d.tokens_skip_empty_range} align=${d.align_fail_n} painted=${d.painted})`;
  }

  /** @param {boolean | null} inferred 仅 `false` 计为 cache hit；`null` 表示未知（失败路径） */
  function noteAttempt(report, inferred, engine, model) {
    if (!report) return;
    report.segments += 1;
    if (inferred === false) report.cached += 1;
    if (engine) report.engine = engine;
    if (model) report.model = model;
  }

  /**
   * @returns {Promise<
   *   | { kind: 'empty' }
   *   | { kind: 'ok', tokens: unknown[], inferred: boolean, engine: string | null, model: string | null }
   *   | { kind: 'align_fail', err: Error, inferred: boolean, engine: string | null, model: string | null }
   *   | { kind: 'error', err: Error, inferred: boolean, engine: string | null, model: string | null }
   * >}
   */
  async function analyzeSegment(text, segs, i, skipCache) {
    if (!/\S/.test(segs[i].text)) return { kind: 'empty' };
    const win = globalThis.IH_segmentWindow(text, segs, i);
    const { data, inferred, engine, model } = await sendAnalyze(win.requestText, skipCache);
    const raw = data?.result?.bpe_strings;
    if (!Array.isArray(raw)) {
      return { kind: 'error', err: new Error('Analyze returned no tokens'), inferred, engine, model };
    }
    try {
      return {
        kind: 'ok',
        tokens: globalThis.IH_tokensInSegment(raw, win),
        inferred,
        engine,
        model,
      };
    } catch (err) {
      if (String(err?.message || err).includes(ALIGN_FAIL)) {
        return { kind: 'align_fail', err, inferred, engine, model };
      }
      throw err;
    }
  }

  /** 取下一段前让一帧：后台标签不触发 rAF，就停在段边界不再发请求。引擎闲置 10s 自己卸。 */
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function applyTokens(session, tokens, i, opts, report) {
    const stats = globalThis.IH_paintTokens(tokens, session.mapped, {
      append: true,
      overlay: !!opts?.overlay,
    });
    session.painted += Number(stats?.painted) || 0;
    addPaintStats(report, stats);
    opts?.onTokens?.(tokens, i);
    globalThis.IH_appendProgress(tokens, session.segs[i]);
  }

  /**
   * @param {{ mapped: { text: string }, segs: unknown[], painted: number }} session
   * @param {number} from
   * @param {number} to
   * @param {() => boolean} still
   * @param {{ overlay?: boolean, onTokens?: (tokens: unknown[], i: number) => void, skipCache?: boolean }} [opts]
   * @param {{ segments: number, segments_ok: number, cached: number, engine: string | null, error?: string | null, duration_ms?: number, align_fail_n?: number, tokens_in?: number, tokens_skip_level?: number, tokens_skip_empty_range?: number, painted?: number, detail?: object | null }} report
   * @returns {Promise<Error | undefined>}
   */
  async function paintRange(session, from, to, still, opts, report) {
    const batch = to - from;
    reportActionFilled(0, batch);
    let lastAlignErr;
    for (let i = from; i < to; i++) {
      await nextFrame();
      if (!still()) return lastAlignErr;
      let got;
      try {
        got = await analyzeSegment(session.mapped.text, session.segs, i, opts?.skipCache);
      } catch (err) {
        if (!still()) return lastAlignErr;
        // SW/通道失败：计入尝试，但不记 cached（inferred 未知）
        noteAttempt(report, null, null);
        throw err;
      }
      if (!still()) return lastAlignErr;
      if (got.kind === 'empty') {
        applyTokens(session, [], i, opts, report);
        reportActionFilled(i + 1 - from, batch);
        continue;
      }
      noteAttempt(report, got.inferred, got.engine, got.model);
      if (got.kind === 'error') throw got.err;
      if (got.kind === 'align_fail') {
        console.warn('[Info Highlight] skip segment', i, got.err);
        lastAlignErr = got.err;
        if (report) {
          report.align_fail_n = (report.align_fail_n || 0) + 1;
          report.last_align_err = clipAlignErr(got.err);
        }
        reportActionFilled(i + 1 - from, batch);
        continue;
      }
      if (report) report.segments_ok += 1;
      applyTokens(session, got.tokens, i, opts, report);
      reportActionFilled(i + 1 - from, batch);
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

  async function afterPaint(session, lastAlignErr, emptyMsg, onMore, report) {
    await globalThis.IH_setProgressSearching(false);
    if (session.next < session.segs.length) {
      await onMore();
      return;
    }
    if (!session.painted) {
      const detail = buildPaintFailDetail(session, report, lastAlignErr);
      if (report) report.detail = detail;
      if (lastAlignErr) throw lastAlignErr;
      throw new Error(`${emptyMsg} ${formatPaintFailSummary(detail)}`);
    }
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
    const t0 = Date.now();
    try {
      await job(report);
      report.outcome = still() ? 'ok' : 'cancelled';
    } catch (err) {
      if (!still()) {
        report.outcome = 'cancelled';
      } else {
        report.outcome = 'failed';
        report.error = String(err?.message || err).slice(0, 500);
        await fail(err);
      }
    } finally {
      // 取消/失败/成功都带墙钟；取消也要收尾：上报、清 busy
      report.duration_ms = Math.max(0, Date.now() - t0);
      reportUsage(report);
      idle();
    }
  }

  return {
    MAX_SEGMENTS_PER_RUN,
    FORCE_BUSY_MSG: 'Info Highlight is still analyzing this page. Try again when it finishes.',
    reportActionState,
    beginSession,
    paintRange,
    afterPaint,
    runJob,
  };
})();
