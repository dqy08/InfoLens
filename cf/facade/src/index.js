/**
 * InfoLens 门面：
 * - 默认 /api/*、/demo/* → HF_ORIGIN
 * - 已登记 origin：
 *   - mode=accelerate（默认）：仅算力路径 → backup；其余仍 HF_ORIGIN
 *   - mode=full：/api/*、/demo/* 全部 → backup（HF 灾备）
 * - TTL≈5min；过期或清空后回 HF_ORIGIN
 * - backup 连不上（fetch 抛错 / 502·52x·530）→ 清 KV 并改打 HF（本请求）
 *   不含源站业务 503/504（如模型加载中），避免误踢加速
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
/** KV 最短 TTL 60s；登记方在剩余约 20s 时续期；约 5min 无续期则回 HF_ORIGIN */
const BACKUP_TTL_SEC = 300;

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

/** @returns {Promise<{ ok: true } | { ok: false, error: string }>} */
async function setBackup(env, origin, mode) {
  if (!env.STATE) return { ok: false, error: 'STATE KV binding is not configured' };
  try {
    if (origin) {
      const payload = JSON.stringify({ origin, mode: normalizeMode(mode) });
      await env.STATE.put(BACKUP_KEY, payload, { expirationTtl: BACKUP_TTL_SEC });
    } else {
      await env.STATE.delete(BACKUP_KEY);
    }
    return { ok: true };
  } catch (err) {
    // 免费 KV 写满等会抛错；勿再 throw，否则平台回 1101 HTML
    const msg = err && err.message ? String(err.message) : String(err);
    return { ok: false, error: msg || 'STATE KV write failed' };
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
    let backup;
    try {
      backup = await getBackup(env);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      return json(request, { ok: false, error: msg || 'STATE KV read failed' }, 503);
    }
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
      const cleared = await setBackup(env, null);
      if (!cleared.ok) return json(request, { ok: false, error: cleared.error }, 503);
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
    const saved = await setBackup(env, origin, mode);
    if (!saved.ok) return json(request, { ok: false, error: saved.error }, 503);
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

/** 有 backup 时选上游：full 全走 backup；accelerate 仅算力走 backup。via = 实际落点 hf|accel */
function pickUpstream(path, backup, env) {
  const hf = hfOrigin(env);
  if (!backup) {
    return { origin: hf, via: 'hf' };
  }
  if (backup.mode === 'full') {
    return { origin: backup.origin, via: 'accel' };
  }
  // accelerate：仅算力路径走 backup
  if (isComputePath(path)) {
    return { origin: backup.origin, via: 'accel' };
  }
  return { origin: hf, via: 'hf' };
}

/** 边缘/隧道不可达类状态 → 可回退 HF（不含源站业务 503/504） */
function isUpstreamDeadStatus(status) {
  return status === 502 || status === 530 || (status >= 521 && status <= 525);
}

function withUpstreamMeta(request, upstream, via) {
  const respHeaders = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    respHeaders.set(k, v);
  }
  respHeaders.set('X-Infolens-Backend', via);
  if ((respHeaders.get('content-type') || '').includes('text/event-stream')) {
    respHeaders.set('Cache-Control', 'no-cache');
    respHeaders.set('X-Accel-Buffering', 'no');
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (url.pathname === '/facade-backup') {
    return handleBackupAdmin(request, env);
  }

  let backup;
  try {
    backup = await getBackup(env);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return json(request, { ok: false, error: msg || 'STATE KV read failed' }, 503);
  }

  if (url.pathname === '/' || url.pathname === '/facade-health') {
    const forwardTo = backup ? backup.origin : hfOrigin(env);
    return json(request, {
      ok: true,
      facade: true,
      active: backup ? backup.mode : 'hf',
      mode: backup ? backup.mode : null,
      forward_to: forwardTo,
      // 兼容旧客户端/脚本（曾用 upstream）
      upstream: forwardTo,
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

  // POST 等 body 只能读一次；失败回退 HF 前先缓冲
  let bodyBuf = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    bodyBuf = await request.arrayBuffer();
  }
  const makeInit = () => {
    const init = {
      method: request.method,
      headers: buildUpstreamHeaders(request),
      redirect: 'manual',
    };
    if (bodyBuf !== null) init.body = bodyBuf;
    return init;
  };

  const targetUrl = `${origin}${path}${url.search}`;

  if (via === 'hf') {
    const upstream = await fetch(targetUrl, makeInit());
    return withUpstreamMeta(request, upstream, via);
  }

  let upstream;
  let dead = false;
  try {
    upstream = await fetch(targetUrl, makeInit());
    dead = isUpstreamDeadStatus(upstream.status);
  } catch {
    dead = true;
  }

  if (!dead) {
    return withUpstreamMeta(request, upstream, via);
  }

  if (upstream && upstream.body) {
    try {
      await upstream.body.cancel();
    } catch {
      /* ignore */
    }
  }

  // 清登记，避免后续请求继续打死 origin；脚本 GET 发现丢失后会再 PUT
  const cleared = await setBackup(env, null);

  const hf = hfOrigin(env);
  if (!hf) {
    return json(request, { ok: false, error: 'HF_ORIGIN is not configured' }, 500);
  }
  const fallback = await fetch(`${hf}${path}${url.search}`, makeInit());
  const resp = withUpstreamMeta(request, fallback, 'hf');
  // KV 写满等导致删不掉时本请求仍回 HF，但登记可能还在
  if (!cleared.ok) {
    const headers = new Headers(resp.headers);
    headers.set('X-Infolens-Backup-Clear', 'failed');
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }
  return resp;
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      return json(request, { ok: false, error: msg || 'worker error' }, 503);
    }
  },
};
