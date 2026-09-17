/**
 * 阶段性调试：Info Highlight 分析失败原因流水（可整段删除）。
 *
 * 正式用量计数仍走 POST /api/extension-usage（只有计数，不加 message/error 字段）。
 * 本通道只收低频失败详情，方便看失败原因分布；不要当长期日志用。
 *
 * 隐私：
 * - 不存 page_url / page_text / 页面正文等专用字段。
 * - error 文本里的明显 URL（含 http(s)/file/data/blob/chrome-extension 等）一律打成 [url]。
 *
 * POST /api/extension-analysis-fail（公开）；GET /facade-extension-analysis-fail（ADMIN_TOKEN）。
 */

import { clipStr, utcSavedAt } from './extension_feedback.js';

export const ANALYSIS_FAIL_PATH = '/api/extension-analysis-fail';
export const ANALYSIS_FAIL_ADMIN_PATH = '/facade-extension-analysis-fail';
export const ANALYSIS_FAIL_KEY_PREFIX = 'analysis_fail:';

const EXTENSION = 'info-highlight';
const OUTCOME = 'failed';
const ENGINES = new Set(['local', 'cloud']);
const MAX_SEGMENTS = 512;

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

export function buildAnalysisFailRecord(body) {
  const d = body && typeof body === 'object' ? body : {};
  const extension = clipStr(d.extension, 64);
  const outcome = String(d.outcome || '').trim();
  const version = clipStr(d.version, 32);
  const engineRaw = clipStr(d.engine, 16);
  const engine = engineRaw && ENGINES.has(engineRaw) ? engineRaw : null;
  const error = clipStr(redactUrls(d.error || d.message), 500);
  return {
    saved_at: utcSavedAt(),
    extension,
    version,
    engine,
    outcome,
    error,
    segments: clampSegments(d.segments),
  };
}

function newId8() {
  return (
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10)
  )
    .replace(/-/g, '')
    .slice(0, 8);
}

/**
 * @param {Request} request
 * @param {{ STATE?: KVNamespace }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 */
export async function handlePostExtensionAnalysisFail(request, env, json) {
  if (request.method !== 'POST') {
    return json(request, { success: false, message: 'method not allowed' }, 405);
  }
  if (!env.STATE) {
    return json(request, { success: false, message: 'STATE KV is not configured' }, 503);
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

  const key = analysisFailKey(newId8());
  try {
    await env.STATE.put(key, JSON.stringify(record));
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error('[extension analysis-fail] KV put failed:', msg);
    return json(request, { success: true, stored: false, path: key });
  }

  return json(request, { success: true, stored: true, path: key });
}

/**
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
