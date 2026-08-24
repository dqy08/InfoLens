#!/usr/bin/env node
/**
 * 打真实接口：版本 + 相关度 SSE + 关键词 SSE。
 * 只确认通、能结束；不断言具体命中词。
 * 默认 apiBase 取自 extension/config.dev.js，避免打到主域名。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function defaultApiBase() {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../extension/config.dev.js'),
    'utf8'
  );
  const m = src.match(/apiBase:\s*'([^']+)'/);
  if (!m) throw new Error('apiBase missing in extension/config.dev.js');
  return m[1];
}

const BASE = (process.env.API_BASE || defaultApiBase()).replace(/\/$/, '');
const TIMEOUT_MS = 45_000;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success !== true) {
    fail(`${path}: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function readSse(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok || !res.body) fail(`${path}: HTTP ${res.status}`);
  const text = await res.text();
  let sawResult = false;
  let errorMsg = '';
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    if (ev.type === 'result') sawResult = true;
    if (ev.type === 'error') errorMsg = ev.message || 'error';
  }
  if (errorMsg) fail(`${path}: ${errorMsg}`);
  if (!sawResult) fail(`${path}: stream ended without type:result\n${text.slice(0, 400)}`);
}

const query = 'orangutan';
const text =
  'The orangutan is a great ape that lives in the trees of Borneo and Sumatra.';

const ver = await getJson('/api/v2/analyze-semantic-version');
if (!Number.isInteger(ver.relevance) || !Number.isInteger(ver.keywords)) {
  fail(`version: missing integer epochs ${JSON.stringify(ver)}`);
}
await readSse('/api/v2/analyze-semantic-relevance', {
  query,
  texts: [text],
  privacy_mode: true,
});
await readSse('/api/v2/analyze-semantic-keywords', {
  query,
  text,
  stream: true,
  privacy_mode: true,
});
console.log(`ok ${BASE} version relevance=${ver.relevance} keywords=${ver.keywords}`);
