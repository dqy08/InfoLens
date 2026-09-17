/**
 * 产品级匿名客户端 ID（il_aid Cookie + JSON client_id）。
 * Domain=.info-lens.app 时与官网、两插件共用；workers.dev 等非该域则 host-only。
 * SameSite=None; Secure：扩展 SW 无 host_permissions 时仍可带/收 Cookie（跨站）；Lax 则不行。
 */

export const CLIENT_ID_PATH = '/api/client-id';
export const CLIENT_ID_COOKIE = 'il_aid';
export const CLIENT_ID_MAX_AGE_SEC = 63_072_000; // 730 days

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidClientId(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

export function normalizeClientId(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return isValidClientId(s) ? s.toLowerCase() : null;
}

export function parseCookieHeader(header, name = CLIENT_ID_COOKIE) {
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k !== name) continue;
    return normalizeClientId(decodeURIComponent(part.slice(i + 1).trim()));
  }
  return null;
}

export function newClientId() {
  return globalThis.crypto.randomUUID().toLowerCase();
}

/** api.info-lens.app → .info-lens.app；其余 host-only（如 *.workers.dev）。 */
export function cookieDomainForHost(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (h === 'info-lens.app' || h.endsWith('.info-lens.app')) return '.info-lens.app';
  return null;
}

export function buildClientIdSetCookie(clientId, hostname) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  const parts = [
    `${CLIENT_ID_COOKIE}=${encodeURIComponent(id)}`,
    'Path=/',
    `Max-Age=${CLIENT_ID_MAX_AGE_SEC}`,
    'Secure',
    'SameSite=None',
  ];
  const domain = cookieDomainForHost(hostname);
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

/** 有 Cookie 则回显，否则新发。 */
export function resolveClientId(request) {
  const fromCookie = parseCookieHeader(request.headers.get('Cookie') || '');
  return {
    client_id: fromCookie || newClientId(),
    from: fromCookie ? 'cookie' : 'new',
  };
}

/** 带凭据只开放给官网与插件；任意网页不得读取访客 client_id。 */
export function isAllowedClientIdOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  if (origin.startsWith('chrome-extension://')) return true;
  try {
    return cookieDomainForHost(new URL(origin).hostname) !== null;
  } catch {
    return false;
  }
}

function credentialCorsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers':
      req.headers.get('Access-Control-Request-Headers') || 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (isAllowedClientIdOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/**
 * GET /api/client-id：回显或签发匿名 client_id，并 Set-Cookie。
 * @param {Request} request
 */
export function handleClientId(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: credentialCorsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return Response.json(
      { success: false, message: 'method not allowed' },
      { status: 405, headers: credentialCorsHeaders(request) },
    );
  }

  const { client_id, from } = resolveClientId(request);
  const host = new URL(request.url).hostname;
  const setCookie = buildClientIdSetCookie(client_id, host);
  const headers = {
    ...credentialCorsHeaders(request),
    'Content-Type': 'application/json',
  };
  if (setCookie) headers['Set-Cookie'] = setCookie;

  return new Response(JSON.stringify({ success: true, client_id, from }), {
    status: 200,
    headers,
  });
}
