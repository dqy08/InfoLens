/**
 * 扩展流水上报：逐条写入 R2（无真正 append API，一事件一对象）。
 * Binding：REPORT_LOGS → bucket infolens-report-logs。
 * 缺 binding 时 no-op（warn 一次），永不抛进请求路径。
 *
 * Key：reports/YYYY-MM-DD/<route-slug>/<ISO8601compact>-<id8>.json
 * Body：{ received_at, route, ...原 JSON 字段 }（不剥 client_id）。
 */

export const USAGE_PATH = '/api/extension-usage';
export const REPORT_LOGS_BINDING = 'REPORT_LOGS';
/** 单条上限；超限不落原文，改写 stub，避免把 R2 灌满。 */
export const MAX_REPORT_LOG_BYTES = 64 * 1024;

let missingBindingWarned = false;

export function resetReportLogWarnings() {
  missingBindingWarned = false;
}

function warnMissingBinding() {
  if (missingBindingWarned) return;
  missingBindingWarned = true;
  console.warn('[report_log] REPORT_LOGS R2 binding missing; skip');
}

export function newId8() {
  return (
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10)
  )
    .replace(/-/g, '')
    .slice(0, 8);
}

export function routeSlug(route) {
  const s = String(route || 'unknown')
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'unknown';
}

/** 2026-09-18T06:45:00.123Z → 20260918T064500123Z */
export function compactIso(isoOrDate) {
  const iso = isoOrDate instanceof Date ? isoOrDate.toISOString() : String(isoOrDate);
  return iso.replace(/[-:]/g, '').replace('.', '');
}

function asDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export function reportLogKey(route, when = new Date(), id8 = newId8()) {
  const d = asDate(when);
  const day = d.toISOString().slice(0, 10);
  return `reports/${day}/${routeSlug(route)}/${compactIso(d)}-${id8}.json`;
}

function utf8ByteLength(s) {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * 信封：原字段浅拷贝后覆盖 received_at / route（服务端为准）。
 * 非对象 body 放进 payload，避免把数组当 map 展开。
 */
export function buildReportLogRecord({ route, body, received_at }) {
  const base =
    body && typeof body === 'object' && !Array.isArray(body)
      ? { ...body }
      : { payload: body ?? null };
  base.received_at = received_at;
  base.route = route;
  return base;
}

export function planReportLog({ route, body, received_at, id8, now } = {}) {
  const at = received_at || (now || new Date()).toISOString();
  const rec = buildReportLogRecord({ route, body, received_at: at });
  let payload = JSON.stringify(rec);
  const bytes = utf8ByteLength(payload);
  const truncated = bytes > MAX_REPORT_LOG_BYTES;
  if (truncated) {
    payload = JSON.stringify({
      received_at: at,
      route,
      omitted: 'payload_too_large',
      bytes,
    });
  }
  const key = reportLogKey(route, asDate(at), id8);
  return { key, payload, bytes, truncated, record: rec };
}

/**
 * @returns {Promise<{ ok: boolean, key?: string, skipped?: string, error?: string, omitted?: string }>}
 */
export async function putPlannedReport(env, planned) {
  try {
    if (!env || !env.REPORT_LOGS) {
      warnMissingBinding();
      return { ok: false, skipped: 'no_binding' };
    }
    await env.REPORT_LOGS.put(planned.key, planned.payload, {
      httpMetadata: { contentType: 'application/json' },
    });
    return {
      ok: true,
      key: planned.key,
      ...(planned.truncated ? { omitted: 'payload_too_large' } : {}),
    };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error('[report_log] R2 put failed:', msg);
    return { ok: false, error: msg };
  }
}

/** 火忘：永不抛。缺 binding 时 no-op。 */
export async function teeReportLog(env, args) {
  try {
    return await putPlannedReport(env, planReportLog(args));
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error('[report_log] tee failed:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * 已通过校验的上报：计划 key，有 ExecutionContext 则 waitUntil，否则 await（测试无 ctx）。
 * 主路径不因 R2 失败而 5xx；stored 表示有 binding（写入已调度），不保证 put 已成功。
 */
export async function persistAcceptedReport(ctx, env, args) {
  try {
    const planned = planReportLog(args);
    const p = putPlannedReport(env, planned);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(p);
    } else {
      await p;
    }
    return {
      success: true,
      stored: !!(env && env.REPORT_LOGS),
      path: planned.key,
    };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error('[report_log] persist failed:', msg);
    return { success: true, stored: false };
  }
}
