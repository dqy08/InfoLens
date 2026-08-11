/**
 * 扩展单向黑箱反馈：边缘写 STATE KV。
 * POST /api/extension-feedback（公开）；GET /facade-extension-feedback（ADMIN_TOKEN）。
 * 字段裁剪与历史后端 extension_feedback 对齐（tone/label/detail/error_detail 等长度上限）。
 */

export const FEEDBACK_PATH = '/api/extension-feedback';
export const FEEDBACK_ADMIN_PATH = '/facade-extension-feedback';
export const FEEDBACK_KEY_PREFIX = 'feedback:';
/** 90 天；黑箱不承诺永久存档 */
export const FEEDBACK_TTL_SEC = 90 * 24 * 60 * 60;

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
export function buildFeedbackRecord(body) {
  const d = body && typeof body === 'object' ? body : {};
  const status = d.status && typeof d.status === 'object' ? d.status : {};
  const progress = d.progress && typeof d.progress === 'object' ? d.progress : {};
  const config = d.config && typeof d.config === 'object' ? d.config : {};
  const saved_at = utcSavedAt();
  return {
    saved_at,
    source: 'extension',
    status: {
      tone: clipStr(status.tone, 32),
      label: clipStr(status.label, 64),
      detail: clipStr(status.detail, 2000),
      error_detail: clipStr(status.error_detail, 2000),
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

  const record = buildFeedbackRecord(body && typeof body === 'object' ? body : {});
  const id8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const key = feedbackKey(id8);

  try {
    await env.STATE.put(key, JSON.stringify(record), { expirationTtl: FEEDBACK_TTL_SEC });
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
