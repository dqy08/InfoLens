/**
 * 阶段性调试：Info Highlight 分析失败原因流水（可整段删除）。
 *
 * 正式用量计数仍走 POST /api/extension-usage（只有计数，不加 message/error 字段）。
 * 本通道只收低频失败详情，方便看失败原因分布；不要当长期日志用。
 *
 * 校验仍用裁剪后的 record（不把 page_url/page_text 当必填；error 去 URL）。
 * POST 落 R2 的是请求 JSON 原文（含 client_id）；不再写 STATE KV。
 *
 * POST /api/extension-analysis-fail（公开）→ REPORT_LOGS R2，不写 STATE KV。
 * GET /facade-extension-analysis-fail（ADMIN_TOKEN）仍读历史 KV；新事件在 R2（无查询 UI）。
 */

import { clipStr, utcSavedAt } from './extension_feedback.js';
import { persistAcceptedReport } from './report_log.js';

export const ANALYSIS_FAIL_PATH = '/api/extension-analysis-fail';
export const ANALYSIS_FAIL_ADMIN_PATH = '/facade-extension-analysis-fail';
export const ANALYSIS_FAIL_KEY_PREFIX = 'analysis_fail:';

const EXTENSION = 'info-highlight';
const OUTCOME = 'failed';
const ENGINES = new Set(['local', 'cloud']);
const MAX_SEGMENTS = 512;
/** 防止异常时钟或挂死上报炸开；约 24h。与 local-init / usage 同档。 */
const MAX_DURATION_MS = 86_400_000;
/** mapped_chars / tokens_in 等可比 segments 大一个数量级。 */
const MAX_DETAIL_COUNT = 10_000_000;
const MAX_ALIGN_ERR = 200;
const MAX_DETAIL_JSON = 800;
const DETAIL_COUNT_KEYS = [
  'segments',
  'segments_ok',
  'align_fail_n',
  'tokens_in',
  'tokens_skip_level',
  'tokens_skip_empty_range',
  'painted',
  'mapped_chars',
  'mapped_pieces',
];
const DETAIL_SEGMENT_KEYS = new Set(['segments', 'segments_ok', 'align_fail_n']);

export function analysisFailKey(id8, ms = Date.now()) {
  const inv = String(1e15 - ms).padStart(16, '0');
  return `${ANALYSIS_FAIL_KEY_PREFIX}${inv}:${id8}`;
}

/**
 * 剥离 error 里的明显 URL，避免把页面/接口地址写进 KV。
 * 先 redact 再 clip，避免截断半截 URL 漏过去。
 */
export function redactUrls(v) {
  if (v == null) return null;
  const s = String(v);
  if (!s) return s;
  // data:/blob: 可能夹页面正文；scheme:// 覆盖 http(s)/file/chrome-extension 等。
  return s.replace(
    /\b(?:data:|blob:)[^\s<>"'`]+|(?:[a-z][a-z0-9+.-]*:\/\/)[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi,
    '[url]',
  );
}

function clampSegments(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), MAX_SEGMENTS);
}

function clampDurationMs(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), MAX_DURATION_MS);
}

function clampDetailCount(v, max) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean' || (typeof v === 'object' && v !== null)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), max);
}

/**
 * painted===0 诊断：只收 allowlist 键。未知字段、嵌套对象、超长 JSON 一律丢掉。
 * @param {unknown} raw
 * @returns {Record<string, number | boolean | string> | null}
 */
export function parseAnalysisFailDetail(raw) {
  let d = raw;
  if (typeof d === 'string') {
    const clipped = clipStr(redactUrls(d), MAX_DETAIL_JSON);
    if (!clipped || clipped.endsWith('…')) return null;
    try {
      d = JSON.parse(clipped);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;

  const out = {};
  for (const key of DETAIL_COUNT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(d, key)) continue;
    const max = DETAIL_SEGMENT_KEYS.has(key) ? MAX_SEGMENTS : MAX_DETAIL_COUNT;
    const n = clampDetailCount(d[key], max);
    if (n != null) out[key] = n;
  }
  if (Object.prototype.hasOwnProperty.call(d, 'highlights_ok') && typeof d.highlights_ok === 'boolean') {
    out.highlights_ok = d.highlights_ok;
  }
  if (typeof d.last_align_err === 'string') {
    const s = clipStr(redactUrls(d.last_align_err), MAX_ALIGN_ERR);
    if (s) out.last_align_err = s;
  }
  return Object.keys(out).length ? out : null;
}

export function buildAnalysisFailRecord(body) {
  const d = body && typeof body === 'object' ? body : {};
  const extension = clipStr(d.extension, 64);
  const outcome = String(d.outcome || '').trim();
  const version = clipStr(d.version, 32);
  const engineRaw = clipStr(d.engine, 16);
  const engine = engineRaw && ENGINES.has(engineRaw) ? engineRaw : null;
  const error = clipStr(redactUrls(d.error || d.message), 500);
  const rec = {
    saved_at: utcSavedAt(),
    extension,
    version,
    engine,
    outcome,
    error,
    segments: clampSegments(d.segments),
    duration_ms: clampDurationMs(d.duration_ms),
  };
  const detail = parseAnalysisFailDetail(d.detail);
  if (detail) rec.detail = detail;
  return rec;
}

/**
 * @param {Request} request
 * @param {{ REPORT_LOGS?: R2Bucket }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 * @param {ExecutionContext} [ctx]
 */
export async function handlePostExtensionAnalysisFail(request, env, json, ctx) {
  if (request.method !== 'POST') {
    return json(request, { success: false, message: 'method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, { success: false, message: 'invalid json' }, 400);
  }

  const record = buildAnalysisFailRecord(body);
  if (
    record.extension !== EXTENSION ||
    record.outcome !== OUTCOME ||
    !record.version ||
    !record.error
  ) {
    return json(request, { success: false, message: 'invalid extension, outcome, version, or error' }, 400);
  }

  const result = await persistAcceptedReport(ctx, env, { route: ANALYSIS_FAIL_PATH, body });
  return json(request, result);
}

/**
 * 历史 STATE KV 流水。新事件在 REPORT_LOGS R2，本接口不查桶。
 * @param {Request} request
 * @param {{ STATE?: KVNamespace }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 * @param {(req: Request, env: unknown) => string | null} requireAdmin
 */
export async function handleListExtensionAnalysisFail(request, env, json, requireAdmin) {
  const denied = requireAdmin(request, env);
  if (denied) return json(request, { ok: false, error: denied }, 403);
  if (request.method !== 'GET') {
    return json(request, { ok: false, error: 'method_not_allowed' }, 405);
  }
  if (!env.STATE) {
    return json(request, { ok: false, error: 'STATE KV is not configured' }, 503);
  }

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
  const wantKey = (url.searchParams.get('key') || '').trim();

  if (wantKey) {
    if (!wantKey.startsWith(ANALYSIS_FAIL_KEY_PREFIX)) {
      return json(request, { ok: false, error: 'invalid key prefix' }, 400);
    }
    const raw = await env.STATE.get(wantKey);
    if (raw == null) return json(request, { ok: false, error: 'not_found' }, 404);
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return json(request, { ok: false, error: 'corrupt value' }, 500);
    }
    return json(request, { ok: true, key: wantKey, record });
  }

  const listed = await env.STATE.list({ prefix: ANALYSIS_FAIL_KEY_PREFIX, limit });
  const items = [];
  for (const { name } of listed.keys) {
    const raw = await env.STATE.get(name);
    if (raw == null) continue;
    try {
      items.push({ key: name, record: JSON.parse(raw) });
    } catch {
      items.push({ key: name, record: null, error: 'corrupt value' });
    }
  }

  return json(request, {
    ok: true,
    list_complete: listed.list_complete !== false,
    count: items.length,
    items,
  });
}
