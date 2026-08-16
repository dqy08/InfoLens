/**
 * 扩展生命周期事件流水（install / update / uninstall）。
 * POST /api/extension-events（公开）；GET /facade-extension-events（ADMIN_TOKEN）。
 */

import { clipStr, utcSavedAt } from './extension_feedback.js';

export const EVENTS_PATH = '/api/extension-events';
export const EVENTS_ADMIN_PATH = '/facade-extension-events';
export const EVENT_KEY_PREFIX = 'event:';

const ALLOWED_EVENTS = new Set(['install', 'update', 'uninstall']);

export function eventKey(event, id8, ms = Date.now()) {
  const inv = String(1e15 - ms).padStart(16, '0');
  return `${EVENT_KEY_PREFIX}${inv}:${event}:${id8}`;
}

export function buildEventRecord(body) {
  const d = body && typeof body === 'object' ? body : {};
  const event = String(d.event || '').trim();
  const version = clipStr(d.version, 32);
  const previous_version = event === 'update' ? clipStr(d.previous_version, 32) : null;
  return {
    saved_at: utcSavedAt(),
    event,
    version,
    ...(previous_version ? { previous_version } : {}),
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
export async function handlePostExtensionEvents(request, env, json) {
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

  const record = buildEventRecord(body);
  if (!ALLOWED_EVENTS.has(record.event) || !record.version) {
    return json(request, { success: false, message: 'invalid event or version' }, 400);
  }

  const key = eventKey(record.event, newId8());
  try {
    await env.STATE.put(key, JSON.stringify(record));
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    console.error('[extension events] KV put failed:', msg);
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
