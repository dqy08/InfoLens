/**
 * 阶段性：Info Highlight 本地权重初始化结果流水（可整段删除）。
 * POST /api/extension-local-init（公开）→ REPORT_LOGS R2，不写 STATE KV。
 * GET /facade-extension-local-init（ADMIN_TOKEN）仍读历史 KV；新事件在 R2（无查询 UI）。
 */

import { clipStr, utcSavedAt } from './extension_feedback.js';
import { persistAcceptedReport } from './report_log.js';

export const LOCAL_INIT_PATH = '/api/extension-local-init';
export const LOCAL_INIT_ADMIN_PATH = '/facade-extension-local-init';
export const LOCAL_INIT_KEY_PREFIX = 'local_init:';

const EXTENSION = 'info-highlight';
const OUTCOMES = new Set(['ok', 'failed', 'cancelled']);
const HUBS = new Set(['huggingface', 'modelscope']);
/** 防止异常时钟或挂死上报炸开；约 24h */
const MAX_DURATION_MS = 86_400_000;

export function localInitKey(id8, ms = Date.now()) {
  const inv = String(1e15 - ms).padStart(16, '0');
  return `${LOCAL_INIT_KEY_PREFIX}${inv}:${id8}`;
}

function clampDurationMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), MAX_DURATION_MS);
}

export function buildLocalInitRecord(body) {
  const d = body && typeof body === 'object' ? body : {};
  const extension = clipStr(d.extension, 64);
  const outcome = String(d.outcome || '').trim();
  const version = clipStr(d.version, 32);
  const hubRaw = clipStr(d.hub, 32);
  const hub = hubRaw && HUBS.has(hubRaw) ? hubRaw : null;
  return {
    saved_at: utcSavedAt(),
    extension,
    version,
    outcome,
    duration_ms: clampDurationMs(d.duration_ms),
    hub,
    error: outcome === 'ok' ? null : clipStr(d.error, 500),
  };
}

/**
 * @param {Request} request
 * @param {{ REPORT_LOGS?: R2Bucket }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 * @param {ExecutionContext} [ctx]
 */
export async function handlePostExtensionLocalInit(request, env, json, ctx) {
  if (request.method !== 'POST') {
    return json(request, { success: false, message: 'method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, { success: false, message: 'invalid json' }, 400);
  }

  const record = buildLocalInitRecord(body);
  if (
    record.extension !== EXTENSION ||
    !OUTCOMES.has(record.outcome) ||
    !record.version
  ) {
    return json(request, { success: false, message: 'invalid extension, outcome, or version' }, 400);
  }

  const result = await persistAcceptedReport(ctx, env, { route: LOCAL_INIT_PATH, body });
  return json(request, result);
}

/**
 * 历史 STATE KV 流水。新事件在 REPORT_LOGS R2，本接口不查桶。
 * @param {Request} request
 * @param {{ STATE?: KVNamespace }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 * @param {(req: Request, env: unknown) => string | null} requireAdmin
 */
export async function handleListExtensionLocalInit(request, env, json, requireAdmin) {
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
    if (!wantKey.startsWith(LOCAL_INIT_KEY_PREFIX)) {
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

  const listed = await env.STATE.list({ prefix: LOCAL_INIT_KEY_PREFIX, limit });
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
