/**
 * 扩展卸载问卷调查（流失分析）。
 * POST /api/extension-uninstall-survey（公开）；GET /facade-extension-uninstall-survey（ADMIN_TOKEN）。
 */

import { clipStr, utcSavedAt } from './extension_feedback.js';

export const UNINSTALL_SURVEY_PATH = '/api/extension-uninstall-survey';
export const UNINSTALL_SURVEY_ADMIN_PATH = '/facade-extension-uninstall-survey';
export const UNINSTALL_SURVEY_KEY_PREFIX = 'survey:uninstall:';

export const UNINSTALL_REASON_IDS = [
  'unused',
  'inaccurate',
  'slow_or_fail',
  'looks_bad',
  'privacy',
  'alternative',
];
const UNINSTALL_REASON_SET = new Set(UNINSTALL_REASON_IDS);

export function uninstallSurveyKey(id8, ms = Date.now()) {
  const inv = String(1e15 - ms).padStart(16, '0');
  return `${UNINSTALL_SURVEY_KEY_PREFIX}${inv}:${id8}`;
}

export function clipUninstallReasons(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const id = clipStr(item, 32);
    if (!id || !UNINSTALL_REASON_SET.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= UNINSTALL_REASON_IDS.length) break;
  }
  return out;
}

export function buildUninstallSurveyRecord(body) {
  const d = body && typeof body === 'object' ? body : {};
  const reasons = clipUninstallReasons(d.reasons);
  const comment = clipStr(d.comment, 2000);
  const saved_at = utcSavedAt();
  return {
    saved_at,
    ...(reasons.length ? { reasons } : {}),
    ...(comment ? { comment } : {}),
    extension_version: clipStr(d.extension_version || d.version, 32),
    user_agent: clipStr(d.user_agent, 400),
  };
}

/**
 * @param {Request} request
 * @param {{ STATE?: KVNamespace }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 */
export async function handlePostUninstallSurvey(request, env, json) {
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

  const record = buildUninstallSurveyRecord(body);
  if (!record.reasons?.length && !record.comment) {
    return json(request, { success: true, stored: false });
  }

  const id8 = (
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10)
  )
    .replace(/-/g, '')
    .slice(0, 8);
  const key = uninstallSurveyKey(id8);

  try {
    await env.STATE.put(key, JSON.stringify(record));
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error('[uninstall survey] KV put failed:', msg);
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
export async function handleListUninstallSurveys(request, env, json, requireAdmin) {
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
    if (!wantKey.startsWith(UNINSTALL_SURVEY_KEY_PREFIX)) {
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

  const listed = await env.STATE.list({ prefix: UNINSTALL_SURVEY_KEY_PREFIX, limit });
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
