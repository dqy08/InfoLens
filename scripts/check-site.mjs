#!/usr/bin/env node
/**
 * 网站可用性：首页能打开，且站点依赖的 /api/health 返回 ok。
 * 不断言具体功能。
 */
const SITE = (process.env.SITE_URL || 'https://info-lens.app').replace(/\/$/, '');
const API = (process.env.API_BASE || 'https://api.info-lens.app').replace(/\/$/, '');
const TIMEOUT_MS = 20_000;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  const text = await res.text();
  return { res, text };
}

const home = await get(`${SITE}/`);
if (!home.res.ok) fail(`home: HTTP ${home.res.status}`);
if (!home.text.includes('nav-landing-page')) fail('home: missing nav-landing-page');
if (!home.text.includes('Info Lens')) fail('home: missing Info Lens');

const health = await get(`${API}/api/health`);
if (!health.res.ok) fail(`health: HTTP ${health.res.status} ${health.text.slice(0, 200)}`);
let body;
try {
  body = JSON.parse(health.text);
} catch {
  fail(`health: not JSON ${health.text.slice(0, 200)}`);
}
if (body.ok !== true) fail(`health: ${JSON.stringify(body)}`);

console.log(`ok ${SITE} ${API}/api/health`);
