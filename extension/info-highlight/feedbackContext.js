/**
 * 用户点失败条「反馈」时附带的调试上下文（URL、分段正文、用量报告等）。
 * 与 extension-usage 自动上报互补：此处可含页面正文，仅用户主动触发。
 */
globalThis.IH_feedbackContext ||= (function () {
  const MAX_MAPPED_CHARS = 24_000;
  const MAX_SEGMENTS = 80;
  const MAX_SEG_TEXT = 4000;
  const MAX_ERROR_DETAIL = 12_000;

  /** @type {object | null} */
  let pending = null;

  function clipText(s, max) {
    const t = String(s ?? '');
    if (t.length <= max) return t;
    return t.slice(0, max - 1) + '…';
  }

  function segmentsPayload(segs) {
    if (!Array.isArray(segs)) return [];
    return segs.slice(0, MAX_SEGMENTS).map((s, index) => ({
      index,
      start: Number(s?.start) || 0,
      end: Number(s?.end) || 0,
      text: clipText(s?.text, MAX_SEG_TEXT),
    }));
  }

  function formatErrorDetail(report, err) {
    const lines = [];
    const surface = pending?.surface;
    if (surface) lines.push(`surface=${surface}`);
    if (report?.engine) lines.push(`engine=${report.engine}`);
    if (report?.model) lines.push(`model=${report.model}`);
    if (report?.outcome) lines.push(`outcome=${report.outcome}`);
    if (report?.error) lines.push(`report.error=${report.error}`);
    const thrown = String(err?.message || err || '').trim();
    if (thrown) lines.push(`thrown=${thrown}`);
    const sum = pending?.session_summary;
    if (sum) {
      lines.push(
        `session.next=${sum.next}`,
        `session.painted=${sum.painted}`,
        `segments_total=${sum.segments_total}`,
      );
    }
    if (report?.detail && typeof report.detail === 'object') {
      lines.push('--- detail ---', JSON.stringify(report.detail));
    }
    return clipText(lines.join('\n'), MAX_ERROR_DETAIL);
  }

  /**
   * @param {{ session?: object | null, report?: object | null, err?: unknown, surface?: string }} args
   */
  function stash(args) {
    const session = args?.session || null;
    const report = args?.report && typeof args.report === 'object' ? args.report : null;
    const mapped = session?.mapped;
    const mappedText = mapped?.text != null ? String(mapped.text) : '';
    pending = {
      surface: args?.surface || 'web',
      report,
      err: args?.err ?? null,
      session_summary: session
        ? {
            next: Number(session.next) || 0,
            painted: Number(session.painted) || 0,
            segments_total: Array.isArray(session.segs) ? session.segs.length : 0,
          }
        : null,
      debug: {
        mapped_chars: mappedText.length,
        mapped_pieces: Array.isArray(mapped?.pieces) ? mapped.pieces.length : 0,
        mapped_text: clipText(mappedText, MAX_MAPPED_CHARS),
        segments: segmentsPayload(session?.segs),
      },
    };
  }

  /** 无 session 时（抽字失败等）尽量带上当前页映射。 */
  function stashMinimal(err, surface = 'web') {
    let mapped = null;
    try {
      mapped = globalThis.IH_extractPage?.();
    } catch {
      mapped = null;
    }
    let segs = [];
    if (mapped?.text && typeof globalThis.IH_splitSegments === 'function') {
      try {
        segs = globalThis.IH_splitSegments(mapped.text);
      } catch {
        segs = [];
      }
    }
    stash({
      session: mapped ? { mapped, segs, next: 0, painted: 0 } : null,
      report: { error: String(err?.message || err || '').slice(0, 500) },
      err,
      surface,
    });
  }

  function peek() {
    return pending;
  }

  function clear() {
    pending = null;
  }

  /**
   * @param {{ label: string, detail: string }} userStatus 用户可见文案
   */
  function buildUserReport(userStatus) {
    const label = String(userStatus?.label || 'Failed').trim() || 'Failed';
    const detail = String(userStatus?.detail || '').trim();
    const report = pending?.report || null;
    const err = pending?.err;
    return {
      status: {
        tone: 'error',
        label,
        detail,
        error_detail: formatErrorDetail(report, err),
      },
      page_url: globalThis.location?.href || '',
      extension: 'info-highlight',
      debug: pending?.debug || null,
      progress: pending?.session_summary
        ? {
            segments_total: pending.session_summary.segments_total,
            segments_done: pending.session_summary.next,
            painted: pending.session_summary.painted,
          }
        : null,
      user_agent: globalThis.navigator?.userAgent || '',
    };
  }

  return { stash, stashMinimal, peek, clear, buildUserReport, clipText, segmentsPayload };
})();
