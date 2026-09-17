/**
 * /api/client-id：Cookie 签发与 body/cookie 优先序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_ID_COOKIE,
  CLIENT_ID_PATH,
  parseCookieHeader,
  cookieDomainForHost,
  buildClientIdSetCookie,
  resolveClientId,
  handleClientId,
  normalizeClientId,
  isAllowedClientIdOrigin,
} from '../src/client_id.js';

// Workers 运行时自带 crypto；Node 18 需要补上。
globalThis.crypto ??= (await import('node:crypto')).webcrypto;

test('normalizeClientId / parseCookieHeader', () => {
  const id = 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678';
  assert.equal(normalizeClientId(id), id.toLowerCase());
  assert.equal(normalizeClientId('nope'), null);
  assert.equal(
    parseCookieHeader(`foo=1; ${CLIENT_ID_COOKIE}=${encodeURIComponent(id)}; bar=2`),
    id.toLowerCase(),
  );
});

test('cookieDomainForHost: 仅 info-lens.app 族用父域', () => {
  assert.equal(cookieDomainForHost('api.info-lens.app'), '.info-lens.app');
  assert.equal(cookieDomainForHost('info-lens.app'), '.info-lens.app');
  assert.equal(cookieDomainForHost('infolens-api.xiaoyundqy.workers.dev'), null);
});

test('buildClientIdSetCookie: 含 SameSite=None 与 Domain', () => {
  const id = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
  const sc = buildClientIdSetCookie(id, 'api.info-lens.app');
  assert.match(sc, new RegExp(`^${CLIENT_ID_COOKIE}=`));
  assert.match(sc, /Domain=\.info-lens\.app/);
  assert.match(sc, /SameSite=None/);
  assert.match(sc, /Secure/);
});

test('resolveClientId: 有 Cookie 则回显，否则新发', () => {
  const cookieId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const withCookie = new Request('https://api.info-lens.app/api/client-id', {
    headers: { Cookie: `${CLIENT_ID_COOKIE}=${cookieId}` },
  });
  assert.deepEqual(resolveClientId(withCookie), { client_id: cookieId, from: 'cookie' });
  assert.equal(resolveClientId(new Request('https://api.info-lens.app/api/client-id')).from, 'new');
});

test('isAllowedClientIdOrigin: 仅官网与插件可带凭据', () => {
  assert.equal(isAllowedClientIdOrigin('https://info-lens.app'), true);
  assert.equal(isAllowedClientIdOrigin('https://www.info-lens.app'), true);
  assert.equal(isAllowedClientIdOrigin('chrome-extension://abcdef'), true);
  assert.equal(isAllowedClientIdOrigin('https://evil.example'), false);
  assert.equal(isAllowedClientIdOrigin('null'), false);
  assert.equal(isAllowedClientIdOrigin(''), false);
});

test('handleClientId: 陌生来源不给凭据 CORS 头', async () => {
  const req = new Request(`https://api.info-lens.app${CLIENT_ID_PATH}`, {
    method: 'GET',
    headers: { Origin: 'https://evil.example' },
  });
  const res = await handleClientId(req);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
});

test('handleClientId GET: 返回 client_id 与 Set-Cookie', async () => {
  const req = new Request(`https://api.info-lens.app${CLIENT_ID_PATH}`, {
    method: 'GET',
    headers: { Origin: 'chrome-extension://abcdef' },
  });
  const res = await handleClientId(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(normalizeClientId(data.client_id));
  const sc = res.headers.get('Set-Cookie');
  assert.match(sc, new RegExp(CLIENT_ID_COOKIE));
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), 'true');
});

test('handleClientId GET: 已有 Cookie 则回显并续期', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const req = new Request(`https://api.info-lens.app${CLIENT_ID_PATH}`, {
    headers: { Origin: 'https://info-lens.app', Cookie: `${CLIENT_ID_COOKIE}=${id}` },
  });
  const res = await handleClientId(req);
  const data = await res.json();
  assert.equal(data.client_id, id);
  assert.equal(data.from, 'cookie');
  assert.match(res.headers.get('Set-Cookie'), new RegExp(id));
});

test('handleClientId: 非 GET 拒绝', async () => {
  const req = new Request(`https://api.info-lens.app${CLIENT_ID_PATH}`, { method: 'POST' });
  assert.equal((await handleClientId(req)).status, 405);
});
