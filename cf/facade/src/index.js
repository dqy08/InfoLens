/**
 * InfoLens 门面：
 * - 默认 /api/*、/demo/* → HF_ORIGIN
 * - 已登记 backup → 全部打 backup origin（带 TTL；过期或清空后回 HF_ORIGIN）
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
]);

const BACKUP_KEY = 'backup_origin';
/** KV 最短 TTL 60s；登记方续期；约 90s 无续期则回 HF_ORIGIN */
const BACKUP_TTL_SEC = 90;

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers':
      req.headers.get('Access-Control-Request-Headers') ||
      'Content-Type, Authorization, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(req, body, status = 200) {
  return Response.json(body, { status, headers: corsHeaders(req) });
}

function normalizeOrigin(raw) {
  const s = (raw || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return s;
}

function requireAdmin(req, env) {
  const expected = (env.ADMIN_TOKEN || '').trim();
  if (!expected) return 'ADMIN_TOKEN secret is not set';
  const got = (req.headers.get('X-Admin-Token') || '').trim();
  if (got !== expected) return 'unauthorized';
  return null;
}

function hfOrigin(env) {
  return (env.HF_ORIGIN || '').replace(/\/+$/, '') || null;
}

async function getBackupOrigin(env) {
  if (!env.STATE) return null;
  return normalizeOrigin(await env.STATE.get(BACKUP_KEY));
}

async function setBackupOrigin(env, origin) {
  if (!env.STATE) throw new Error('STATE KV binding is not configured');
  if (origin) {
    await env.STATE.put(BACKUP_KEY, origin, { expirationTtl: BACKUP_TTL_SEC });
  } else {
    await env.STATE.delete(BACKUP_KEY);
  }
}

function buildUpstreamHeaders(req) {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  return out;
}

async function handleBackupAdmin(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return json(request, { ok: false, error: denied }, 403);

  if (request.method === 'GET') {
    const backup = await getBackupOrigin(env);
    return json(request, {
      ok: true,
      active: backup ? 'backup' : 'hf',
      origin: backup,
      ttl_sec: BACKUP_TTL_SEC,
      hf_origin: hfOrigin(env),
    });
  }

  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(request, { ok: false, error: 'invalid json' }, 400);
    }
    const raw = body && 'origin' in body ? body.origin : undefined;
    if (raw === undefined) {
      return json(request, { ok: false, error: 'missing origin field' }, 400);
    }
    if (raw === null || raw === '') {
      await setBackupOrigin(env, null);
      return json(request, { ok: true, active: 'hf', origin: null, ttl_sec: BACKUP_TTL_SEC });
    }
    const origin = normalizeOrigin(String(raw));
    if (!origin) {
      return json(request, { ok: false, error: 'invalid origin' }, 400);
    }
    await setBackupOrigin(env, origin);
    return json(request, {
      ok: true,
      active: 'backup',
      origin,
      ttl_sec: BACKUP_TTL_SEC,
    });
  }

  return json(request, { ok: false, error: 'method_not_allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/facade-backup') {
      return handleBackupAdmin(request, env);
    }

    const backup = await getBackupOrigin(env);

    if (url.pathname === '/' || url.pathname === '/facade-health') {
      return json(request, {
        ok: true,
        facade: true,
        active: backup ? 'backup' : 'hf',
        upstream: backup || hfOrigin(env),
        ttl_sec: BACKUP_TTL_SEC,
      });
    }

    const path = url.pathname;
    if (!(path === '/api' || path.startsWith('/api/') || path === '/demo' || path.startsWith('/demo/'))) {
      return json(request, { ok: false, error: 'not_found' }, 404);
    }

    const usingBackup = Boolean(backup);
    const origin = usingBackup ? backup : hfOrigin(env);
    if (!origin) {
      return json(
        request,
        {
          ok: false,
          error: usingBackup ? 'backup origin missing' : 'HF_ORIGIN is not configured',
        },
        500,
      );
    }

    const init = {
      method: request.method,
      headers: buildUpstreamHeaders(request),
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    const upstream = await fetch(`${origin}${path}${url.search}`, init);
    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders(request))) {
      respHeaders.set(k, v);
    }
    respHeaders.set('X-Infolens-Upstream', usingBackup ? 'backup' : 'hf');
    if ((respHeaders.get('content-type') || '').includes('text/event-stream')) {
      respHeaders.set('Cache-Control', 'no-cache');
      respHeaders.set('X-Accel-Buffering', 'no');
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};
