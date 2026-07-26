/**
 * InfoLens 门面：
 * - 默认 /api/*、/demo/* → HF_ORIGIN
 * - 已登记 origin：
 *   - mode=accelerate（默认）：仅算力路径 → backup；其余仍 HF_ORIGIN
 *   - mode=full：/api/*、/demo/* 全部 → backup（HF 灾备）
 * - TTL≈90s；过期或清空后回 HF_ORIGIN
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

/** mode=accelerate 时走 backup 的算力路径（其余 /api|/demo 仍 HF） */
const COMPUTE_PATHS = new Set([
  '/api/analyze',
  '/api/tokenize',
  '/api/prediction-attribute',
  '/api/analyze-semantic',
  '/api/analyze-semantic-relevance',
  '/api/analyze-semantic-keywords',
  '/api/available_models',
  '/api/current_model',
  '/api/switch_model',
]);

function isComputePath(path) {
  if (path === '/api/v1/completions' || path.startsWith('/api/v1/completions/')) return true;
  return COMPUTE_PATHS.has(path);
}

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

function normalizeMode(raw) {
  return raw === 'full' ? 'full' : 'accelerate';
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

/** @returns {{ origin: string, mode: 'accelerate'|'full' } | null} */
async function getBackup(env) {
  if (!env.STATE) return null;
  const raw = await env.STATE.get(BACKUP_KEY);
  if (!raw) return null;
  if (raw.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const origin = normalizeOrigin(parsed && parsed.origin);
    if (!origin) return null;
    return { origin, mode: normalizeMode(parsed && parsed.mode) };
  }
  // 旧值：纯 origin 字符串 → 视为 full（与改前整站切流一致）
  const origin = normalizeOrigin(raw);
  return origin ? { origin, mode: 'full' } : null;
}

async function setBackup(env, origin, mode) {
  if (!env.STATE) throw new Error('STATE KV binding is not configured');
  if (origin) {
    const payload = JSON.stringify({ origin, mode: normalizeMode(mode) });
    await env.STATE.put(BACKUP_KEY, payload, { expirationTtl: BACKUP_TTL_SEC });
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
    const backup = await getBackup(env);
    return json(request, {
      ok: true,
      active: backup ? backup.mode : 'hf',
      origin: backup ? backup.origin : null,
      mode: backup ? backup.mode : null,
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
      await setBackup(env, null);
      return json(request, {
        ok: true,
        active: 'hf',
        origin: null,
        mode: null,
        ttl_sec: BACKUP_TTL_SEC,
      });
    }
    const origin = normalizeOrigin(String(raw));
    if (!origin) {
      return json(request, { ok: false, error: 'invalid origin' }, 400);
    }
    if (body.mode != null && body.mode !== 'accelerate' && body.mode !== 'full') {
      return json(request, { ok: false, error: 'invalid mode (accelerate|full)' }, 400);
    }
    const mode = normalizeMode(body.mode);
    await setBackup(env, origin, mode);
    return json(request, {
      ok: true,
      active: mode,
      origin,
      mode,
      ttl_sec: BACKUP_TTL_SEC,
    });
  }

  return json(request, { ok: false, error: 'method_not_allowed' }, 405);
}

/** 有 backup 时选上游：full 全走 backup；accelerate 仅算力走 backup */
function pickUpstream(path, backup, env) {
  const hf = hfOrigin(env);
  if (!backup) {
    return { origin: hf, via: 'hf' };
  }
  if (backup.mode === 'full') {
    return { origin: backup.origin, via: 'full' };
  }
  // accelerate
  if (isComputePath(path)) {
    return { origin: backup.origin, via: 'accelerate' };
  }
  return { origin: hf, via: 'hf' };
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

    const backup = await getBackup(env);

    if (url.pathname === '/' || url.pathname === '/facade-health') {
      return json(request, {
        ok: true,
        facade: true,
        active: backup ? backup.mode : 'hf',
        mode: backup ? backup.mode : null,
        forward_to: backup ? backup.origin : hfOrigin(env),
        ttl_sec: BACKUP_TTL_SEC,
      });
    }

    const path = url.pathname;
    if (!(path === '/api' || path.startsWith('/api/') || path === '/demo' || path.startsWith('/demo/'))) {
      return json(request, { ok: false, error: 'not_found' }, 404);
    }

    const { origin, via } = pickUpstream(path, backup, env);
    if (!origin) {
      return json(
        request,
        {
          ok: false,
          error: via === 'hf' ? 'HF_ORIGIN is not configured' : 'backup origin missing',
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
    respHeaders.set('X-Infolens-Upstream', via);
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
