/**
 * InfoLens 门面：把 /api/*、/demo/* 转到 HF（注入 Bearer），供 Pages 等静态前端跨域调用。
 * 以后可在此加本机算力选路 / 注册；当前仅单 origin。
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

function buildUpstreamHeaders(req, env) {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  if (!env.HF_TOKEN) {
    throw new Error('HF_TOKEN secret is not set');
  }
  out.set('Authorization', `Bearer ${env.HF_TOKEN}`);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/' || url.pathname === '/facade-health') {
      return Response.json(
        { ok: true, facade: true, upstream: env.HF_ORIGIN || null },
        { headers: corsHeaders(request) },
      );
    }

    const path = url.pathname;
    if (!(path === '/api' || path.startsWith('/api/') || path === '/demo' || path.startsWith('/demo/'))) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404, headers: corsHeaders(request) });
    }

    const origin = (env.HF_ORIGIN || '').replace(/\/+$/, '');
    if (!origin) {
      return Response.json(
        { ok: false, error: 'HF_ORIGIN is not configured' },
        { status: 500, headers: corsHeaders(request) },
      );
    }

    const target = `${origin}${path}${url.search}`;
    let upstreamHeaders;
    try {
      upstreamHeaders = buildUpstreamHeaders(request, env);
    } catch (e) {
      return Response.json(
        { ok: false, error: String(e.message || e) },
        { status: 500, headers: corsHeaders(request) },
      );
    }

    const init = {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    const upstream = await fetch(target, init);
    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders(request))) {
      respHeaders.set(k, v);
    }
    // 避免中间层缓冲 SSE
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
