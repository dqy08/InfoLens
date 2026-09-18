/**
 * 扩展生命周期事件流水（install / update / uninstall）。
 * POST /api/extension-events（公开）→ REPORT_LOGS R2，不写 STATE KV。
 * GET /facade-extension-events（ADMIN_TOKEN）仍读历史 KV；新事件在 R2（无查询 UI）。
 * body.extension：semantic-highlight | info-highlight；缺省按 semantic-highlight（兼容旧客户端）。
 */

import { clipStr, utcSavedAt } from './extension_feedback.js';
import { normalizeClientId } from './client_id.js';
import { persistAcceptedReport } from './report_log.js';

export const EVENTS_PATH = '/api/extension-events';
export const EVENTS_ADMIN_PATH = '/facade-extension-events';
export const EVENT_KEY_PREFIX = 'event:';

export const EXTENSION_IDS = new Set(['semantic-highlight', 'info-highlight']);
export const DEFAULT_EXTENSION = 'semantic-highlight';

const ALLOWED_EVENTS = new Set(['install', 'update', 'uninstall']);

export function eventKey(event, id8, ms = Date.now()) {
  const inv = String(1e15 - ms).padStart(16, '0');
  return `${EVENT_KEY_PREFIX}${inv}:${event}:${id8}`;
}

/** 缺省或空 → DEFAULT；非法非空 → null（调用方拒收）。 */
export function normalizeExtension(v) {
  const id = clipStr(v, 64);
  if (!id) return DEFAULT_EXTENSION;
  return EXTENSION_IDS.has(id) ? id : null;
}

export function buildEventRecord(body) {
  const d = body && typeof body === 'object' ? body : {};
  const event = String(d.event || '').trim();
  const version = clipStr(d.version, 32);
  const previous_version = event === 'update' ? clipStr(d.previous_version, 32) : null;
  const extension = normalizeExtension(d.extension);
  const client_id = normalizeClientId(d.client_id);
  return {
    saved_at: utcSavedAt(),
    event,
    version,
    extension,
    ...(previous_version ? { previous_version } : {}),
    ...(client_id ? { client_id } : {}),
  };
}

/**
 * @param {Request} request
 * @param {{ REPORT_LOGS?: R2Bucket }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 * @param {ExecutionContext} [ctx]
 */
export async function handlePostExtensionEvents(request, env, json, ctx) {
  if (request.method !== 'POST') {
    return json(request, { success: false, message: 'method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, { success: false, message: 'invalid json' }, 400);
  }

  const record = buildEventRecord(body);
  if (!ALLOWED_EVENTS.has(record.event) || !record.version || !record.extension) {
    return json(request, { success: false, message: 'invalid event, version, or extension' }, 400);
  }

  const result = await persistAcceptedReport(ctx, env, { route: EVENTS_PATH, body });
  return json(request, result);
}

/**
 * 历史 STATE KV 流水。新事件在 REPORT_LOGS R2，本接口不查桶。
 * @param {Request} request
 * @param {{ STATE?: KVNamespace }} env
 * @param {(req: Request, body: unknown, status?: number) => Response} json
 * @param {(req: Request, env: unknown) => string | null} requireAdmin
 */
export async function handleListExtensionEvents(request, env, json, requireAdmin) {
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
    if (!wantKey.startsWith(EVENT_KEY_PREFIX)) {
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

  const listed = await env.STATE.list({ prefix: EVENT_KEY_PREFIX, limit });
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
