/**
 * InfoLens 门面：
 *
 * 路由：
 * - 默认 /api/*、/demo/* → HF_ORIGIN
 * - home-server 允许访问（粘性 switch，无 TTL）：
 *   - mode=accelerate（默认）：仅算力路径 → HOME_ORIGIN；其余仍 HF
 *   - mode=full：算力路径 + /demo/* + /api/list_demos → HOME_ORIGIN；其余仍 HF
 * - 边缘远程（始终 OpenRouter，无 HF/Home 回退、无旁路开关）：
 *   - /api/analyze-semantic-relevance → Hy3（旧扩展，单 text）
 *   - /api/v2/analyze-semantic-relevance → Hy3 多切片（新扩展/新前端，texts 数组，新版本主力）
 *   - /api/v2/analyze-semantic-keywords → Hy3（新扩展）
 * - keywords 双轨（扩展审核慢于 Worker，过渡期内并存）：
 *   - 旧扩展：/api/analyze-semantic-keywords → 仍 HF/Home 梯度归因（COMPUTE_PATHS，勿接到 v2）
 *   旧扩展升级完后再决定退役旧路径，或把旧入口接到 v2；当前不切
 * - 请求发现 home 不可达（fetch 抛错 / 502·52x·530）→ 写 last_fail_at，本请求改打 HF
 *   冷却期内不再尝试 home；不含源站业务 503/504
 * - /facade-home-probe：始终探 HOME_ORIGIN/api/health；冷却期内若恢复则清 last_fail_at（不通则只观测、不续写）
 */
import {
  RELEVANCE_PATH,
  handleRemoteRelevance,
} from './relevance_remote.js';
import {
  RELEVANCE_V2_PATH,
  handleRemoteRelevanceV2,
} from './relevance_remote_v2.js';
import {
  KEYWORDS_V2_PATH,
  handleRemoteKeywordsV2,
} from './keywords_remote_v2.js';
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

const ALLOW_KEY = 'home_allow';
const HEALTH_KEY = 'home_health';
const COOLDOWN_SEC = 60;

/** 两模式均走 home 的算力路径（不含已边缘短路的 relevance / keywords v2） */
const COMPUTE_PATHS = new Set([
  '/api/analyze',
  '/api/tokenize',
  '/api/prediction-attribute',
  '/api/analyze-semantic',
  '/api/analyze-semantic-keywords',
]);

function isComputePath(path) {
  if (path === '/api/v1/completions' || path.startsWith('/api/v1/completions/')) return true;
  return COMPUTE_PATHS.has(path);
}

/** mode=full 相对 accelerate 多切的 demo 读路径 */
function isFullExtraPath(path) {
  if (path === '/api/list_demos') return true;
  return path === '/demo' || path.startsWith('/demo/');
}

function isHomePath(path, mode) {
  if (isComputePath(path)) return true;
  return mode === 'full' && isFullExtraPath(path);
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

function homeOrigin(env) {
  return (env.HOME_ORIGIN || '').replace(/\/+$/, '') || null;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** @returns {Promise<{ mode: 'accelerate'|'full' } | null>} */
async function getAllow(env) {
  if (!env.STATE) return null;
  const raw = await env.STATE.get(ALLOW_KEY);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || parsed.allowed !== true) return null;
  return { mode: normalizeMode(parsed.mode) };
}

/** @returns {Promise<number|null>} last_fail_at unix sec */
async function getLastFailAt(env) {
  if (!env.STATE) return null;
  const raw = await env.STATE.get(HEALTH_KEY);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const t = parsed && parsed.last_fail_at;
  return typeof t === 'number' && t > 0 ? t : null;
}

function inCooldown(lastFailAt, now = nowSec()) {
  return lastFailAt != null && now < lastFailAt + COOLDOWN_SEC;
}

/** @returns {Promise<{ ok: true } | { ok: false, error: string }>} */
async function kvPut(env, key, value) {
  if (!env.STATE) return { ok: false, error: 'STATE KV binding is not configured' };
  try {
    await env.STATE.put(key, value);
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return { ok: false, error: msg || 'STATE KV write failed' };
  }
}

/** @returns {Promise<{ ok: true } | { ok: false, error: string }>} */
async function kvDelete(env, key) {
  if (!env.STATE) return { ok: false, error: 'STATE KV binding is not configured' };
  try {
    await env.STATE.delete(key);
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return { ok: false, error: msg || 'STATE KV delete failed' };
  }
}

async function setAllow(env, mode) {
  return kvPut(env, ALLOW_KEY, JSON.stringify({ allowed: true, mode: normalizeMode(mode) }));
}

async function clearAllow(env) {
  return kvDelete(env, ALLOW_KEY);
}

async function setLastFailAt(env, ts) {
  return kvPut(env, HEALTH_KEY, JSON.stringify({ last_fail_at: ts }));
}

async function clearHealth(env) {
  return kvDelete(env, HEALTH_KEY);
}

async function handleSwitchAdmin(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return json(request, { ok: false, error: denied }, 403);

  if (request.method === 'GET') {
    return json(request, { ok: true });
  }

  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(request, { ok: false, error: 'invalid json' }, 400);
    }
    if (!body || typeof body.allowed !== 'boolean') {
      return json(request, { ok: false, error: 'missing allowed boolean' }, 400);
    }
    if (body.allowed === false) {
      const cleared = await clearAllow(env);
      if (!cleared.ok) return json(request, { ok: false, error: cleared.error }, 503);
      return json(request, { ok: true });
    }
    if (body.mode != null && body.mode !== 'accelerate' && body.mode !== 'full') {
      return json(request, { ok: false, error: 'invalid mode (accelerate|full)' }, 400);
    }
    const mode = normalizeMode(body.mode);
    const saved = await setAllow(env, mode);
    if (!saved.ok) return json(request, { ok: false, error: saved.error }, 503);
    const healthCleared = await clearHealth(env);
    if (!healthCleared.ok) {
      const rolled = await clearAllow(env);
      const error = rolled.ok
        ? healthCleared.error
        : `${healthCleared.error}; rollback allow failed: ${rolled.error}`;
      return json(request, { ok: false, error }, 503);
    }
    return json(request, { ok: true });
  }

  return json(request, { ok: false, error: 'method_not_allowed' }, 405);
}

async function handleHomeProbe(request, env) {
  const denied = requireAdmin(request, env);
  if (denied) return json(request, { ok: false, error: denied }, 403);
  if (request.method !== 'POST') {
    return json(request, { ok: false, error: 'method_not_allowed' }, 405);
  }

  const home = homeOrigin(env);
  if (!home) {
    return json(request, { ok: false, error: 'HOME_ORIGIN is not configured' }, 500);
  }

  let lastFailAt;
  try {
    lastFailAt = await getLastFailAt(env);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return json(request, { ok: false, error: msg || 'STATE KV read failed' }, 503);
  }

  const now = nowSec();
  const cooling = inCooldown(lastFailAt, now);
  const started = Date.now();
  let status = null; // 仅真实 HTTP 状态码；无响应时为 null，不造 0
  let homeOk = false;
  let healthBodyOk = false;
  try {
    const resp = await fetch(`${home}/api/health`, {
      method: 'GET',
      redirect: 'manual',
    });
    status = resp.status;
    if (status === 200) {
      try {
        const data = await resp.json();
        healthBodyOk = data && data.ok === true;
        homeOk = healthBodyOk;
      } catch {
        homeOk = false;
      }
    }
  } catch {
    homeOk = false;
  }
  const elapsedMs = Date.now() - started;

  let healthAction = 'none';
  if (cooling && homeOk) {
    const cleared = await clearHealth(env);
    if (!cleared.ok) {
      return json(
        request,
        {
          ok: false,
          error: cleared.error,
          home_ok: homeOk,
          status,
          elapsed_ms: elapsedMs,
          in_cooldown: true,
          last_fail_at: lastFailAt,
        },
        503,
      );
    }
    lastFailAt = null;
    healthAction = 'cleared';
  }

  const coolingAfter = inCooldown(lastFailAt, nowSec());
  return json(request, {
    ok: true,
    home_ok: homeOk,
    status,
    elapsed_ms: elapsedMs,
    health_body_ok: healthBodyOk,
    in_cooldown: coolingAfter,
    last_fail_at: lastFailAt,
    health_action: healthAction,
    cooldown_sec: COOLDOWN_SEC,
    home_origin: home,
  });
}

/**
 * 有 allow 且不在冷却时选 home；否则 HF。
 * via = 实际落点 hf|accel
 */
function pickUpstream(path, allow, lastFailAt, env) {
  const hf = hfOrigin(env);
  const home = homeOrigin(env);
  if (!allow || inCooldown(lastFailAt)) {
    return { origin: hf, via: 'hf' };
  }
  if (isHomePath(path, allow.mode)) {
    return { origin: home, via: 'accel' };
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

function buildUpstreamHeaders(req) {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  return out;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (url.pathname === '/facade-switch') {
    return handleSwitchAdmin(request, env);
  }
  if (url.pathname === '/facade-home-probe') {
    return handleHomeProbe(request, env);
  }
  if (url.pathname === '/' || url.pathname === '/facade-health') {
    return json(request, { ok: true, facade: true });
  }

  const path = url.pathname;
  if (!(path === '/api' || path.startsWith('/api/') || path === '/demo' || path.startsWith('/demo/'))) {
    return json(request, { ok: false, error: 'not_found' }, 404);
  }

  // 边缘远程：始终 OpenRouter，不碰 home allow/health。
  // relevance v1 / relevance v2 / keywords v2 并列；旧 keywords 仍走下方 HF/Home，勿合并。
  if (
    path === RELEVANCE_PATH ||
    path === RELEVANCE_V2_PATH ||
    path === KEYWORDS_V2_PATH
  ) {
    const resp =
      path === RELEVANCE_PATH
        ? await handleRemoteRelevance(request, env, json)
        : path === RELEVANCE_V2_PATH
          ? await handleRemoteRelevanceV2(request, env, json)
          : await handleRemoteKeywordsV2(request, env, json);
    const headers = new Headers(resp.headers);
    headers.set('X-Infolens-Backend', 'remote');
    // 远程 SSE/JSON 均需 CORS 头，否则扩展 background fetch 读流报 "Failed to fetch"。
    for (const [k, v] of Object.entries(corsHeaders(request))) {
      headers.set(k, v);
    }
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  }

  // HF/Home 分流才需要 allow + health
  let allow;
  let lastFailAt;
  try {
    allow = await getAllow(env);
    lastFailAt = await getLastFailAt(env);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    return json(request, { ok: false, error: msg || 'STATE KV read failed' }, 503);
  }

  const { origin, via } = pickUpstream(path, allow, lastFailAt, env);
  if (!origin) {
    return json(
      request,
      {
        ok: false,
        error: via === 'hf' ? 'HF_ORIGIN is not configured' : 'HOME_ORIGIN is not configured',
      },
      500,
    );
  }

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

  const marked = await setLastFailAt(env, nowSec());

  const hf = hfOrigin(env);
  if (!hf) {
    return json(request, { ok: false, error: 'HF_ORIGIN is not configured' }, 500);
  }
  const fallback = await fetch(`${hf}${path}${url.search}`, makeInit());
  const resp = withUpstreamMeta(request, fallback, 'hf');
  if (!marked.ok) {
    const headers = new Headers(resp.headers);
    headers.set('X-Infolens-Health-Write', 'failed');
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
