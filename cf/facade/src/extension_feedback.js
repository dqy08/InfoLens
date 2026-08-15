/**
 * 扩展单向黑箱反馈：边缘写 STATE KV。
 * POST /api/extension-feedback（公开）；GET /facade-extension-feedback（ADMIN_TOKEN）。
 * 字段裁剪与历史后端 extension_feedback 对齐（tone/label/detail/error_detail 等长度上限）。
 */

export const FEEDBACK_PATH = '/api/extension-feedback';
export const FEEDBACK_ADMIN_PATH = '/facade-extension-feedback';
export const FEEDBACK_KEY_PREFIX = 'feedback:';
export const UNINSTALL_COUNT_PREFIX = 'uninstall_count:';

export const UNINSTALL_REASON_IDS = [
  'unused',
  'inaccurate',
  'slow_or_fail',
  'looks_bad',
  'privacy',
  'alternative',
];
const UNINSTALL_REASON_SET = new Set(UNINSTALL_REASON_IDS);

export function clipStr(v, maxLen) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}

export function clipObj(v, maxDepth = 3, maxKeys = 40) {
  if (maxDepth < 0) return null;
  if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return clipStr(v, 2000);
  if (Array.isArray(v)) {
    return v.slice(0, maxKeys).map((x) => clipObj(x, maxDepth - 1, maxKeys));
  }
  if (typeof v === 'object') {
    const out = {};
    let i = 0;
    for (const [k, val] of Object.entries(v)) {
      if (i >= maxKeys) break;
      const key = clipStr(k, 64) || `k${i}`;
      out[key] = clipObj(val, maxDepth - 1, maxKeys);
      i += 1;
    }
    return out;
  }
  return clipStr(v, 500);
}

/** UTC `YYYY-MM-DDTHH:MM:SSZ`（与 visit_stats saved_at 同形） */
export function utcSavedAt(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * KV list 按 key 字典序升序；用 (1e15 - ms) 零垫，使最新反馈排在 prefix 扫描最前。
 * @param {number} [ms]
 * @param {string} id8
 */
export function feedbackKey(id8, ms = Date.now()) {
  const inv = String(1e15 - ms).padStart(16, '0');
  return `${FEEDBACK_KEY_PREFIX}${inv}:${id8}`;
}

/**
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
function clipUninstallReasons(v) {
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

export function buildFeedbackRecord(body) {
  const d = body && typeof body === 'object' ? body : {};
  const status = d.status && typeof d.status === 'object' ? d.status : {};
  const progress = d.progress && typeof d.progress === 'object' ? d.progress : {};
  const config = d.config && typeof d.config === 'object' ? d.config : {};
  const saved_at = utcSavedAt();
  const source = d.source === 'uninstall' ? 'uninstall' : 'extension';
  const reasons = source === 'uninstall' ? clipUninstallReasons(d.reasons) : null;
  const comment = source === 'uninstall' ? clipStr(d.comment, 2000) : null;
  return {
    saved_at,
    source,
    ...(reasons?.length ? { reasons } : {}),
    ...(comment ? { comment } : {}),
    status: {
      tone: source === 'uninstall' ? 'uninstall' : clipStr(status.tone, 32),
      label:
        source === 'uninstall'
          ? clipStr(reasons.join(',') || 'uninstall', 64)
          : clipStr(status.label, 64),
      detail: source === 'uninstall' ? comment : clipStr(status.detail, 2000),
      error_detail: source === 'uninstall' ? null : clipStr(status.error_detail, 2000),
    },
    page_url: clipStr(d.page_url, 2000),
    query: clipStr(d.query, 500),
    config: clipObj(config, 2, 24),
    progress: clipObj(progress, 2, 24),
    extension_version: clipStr(d.extension_version, 32),
    user_agent: clipStr(d.user_agent, 400),
  };
}

/**
 * @param {Request} request
 * @param {{ STATE?: KVNamespace }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 */
export async function handlePostExtensionFeedback(request, env, json) {
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

  if (body && body.source === 'uninstall_visit') {
    const version = String(body.version || '').trim().slice(0, 32);
    if (!version) return json(request, { success: false, message: 'invalid version' }, 400);
    const key = `${UNINSTALL_COUNT_PREFIX}${version}`;
    const n = parseInt(await env.STATE.get(key), 10);
    const count = (Number.isFinite(n) ? n : 0) + 1;
    await env.STATE.put(key, String(count));
    return json(request, { success: true, version, count });
  }

  const record = buildFeedbackRecord(body && typeof body === 'object' ? body : {});
  const s = record.status || {};
  const empty =
    record.source === 'uninstall'
      ? !record.reasons?.length && !record.comment
      : !s.tone && !s.label && !s.detail && !s.error_detail;
  if (empty) {
    return json(request, { success: true, stored: false });
  }
  const id8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const key = feedbackKey(id8);

  try {
    await env.STATE.put(key, JSON.stringify(record));
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error('[extension feedback] KV put failed:', msg);
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
export async function handleListExtensionFeedback(request, env, json, requireAdmin) {
  const denied = requireAdmin(request, env);
  if (denied) return json(request, { ok: false, error: denied }, 403);
  if (request.method !== 'GET') {
    return json(request, { ok: false, error: 'method_not_allowed' }, 405);
  }
  if (!env.STATE) {
    return json(request, { ok: false, error: 'STATE KV is not configured' }, 503);
  }

  const url = new URL(request.url);
  if (url.searchParams.has('counts')) {
    const listed = await env.STATE.list({ prefix: UNINSTALL_COUNT_PREFIX, limit: 128 });
    const counts = {};
    for (const { name } of listed.keys) {
      counts[name.slice(UNINSTALL_COUNT_PREFIX.length)] = parseInt(await env.STATE.get(name), 10) || 0;
    }
    return json(request, { ok: true, counts });
  }
  const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
  const wantKey = (url.searchParams.get('key') || '').trim();

  if (wantKey) {
    if (!wantKey.startsWith(FEEDBACK_KEY_PREFIX)) {
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

  // key 已倒序时间，list 前 limit 条即最新
  const listed = await env.STATE.list({ prefix: FEEDBACK_KEY_PREFIX, limit });
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
