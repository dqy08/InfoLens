import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  LOCAL_ENGINE_KEY_PREFIX,
  localEngineKey,
  buildLocalEngineRecord,
  handlePostExtensionLocalEngine,
  handleListExtensionLocalEngine,
} from '../src/extension_local_engine.js';

function mockState(init = {}) {
  const data = { ...init };
  const puts = [];
  return {
    data,
    puts,
    async get(key) {
      return key in data ? data[key] : null;
    },
    async put(key, value, opts) {
      data[key] = value;
      puts.push({ key, opts });
    },
    async list({ prefix, limit }) {
      const keys = Object.keys(data)
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function json(_req, body, status = 200) {
  return { status, body };
}

function postReq(body) {
  return new Request('https://example.test/api/extension-local-engine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('localEngineKey: 更新的 ms 字典序更靠前', () => {
  const older = localEngineKey('aaaaaaaa', 1_000_000);
  const newer = localEngineKey('bbbbbbbb', 2_000_000);
  assert.ok(older.startsWith(LOCAL_ENGINE_KEY_PREFIX));
  assert.ok(newer < older);
});

test('buildLocalEngineRecord: 只收布尔 loaded 与白名单 blocked', () => {
  const rec = buildLocalEngineRecord({
    extension: 'info-highlight',
    version: '0.1.5',
    event: 'unload_linger',
    loaded: true,
    js_heap_bytes: 2_147_483_648.4,
    wait_ms: 10_000.2,
    blocked: 'offer',
    page_url: 'https://news.example/article',
  });
  assert.equal(rec.extension, 'info-highlight');
  assert.equal(rec.event, 'unload_linger');
  assert.equal(rec.loaded, true);
  assert.equal(rec.js_heap_bytes, 2_147_483_648);
  assert.equal(rec.wait_ms, 10_000);
  assert.equal(rec.blocked, 'offer');
  assert.equal('page_url' in rec, false);
  assert.match(rec.saved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const skipped = buildLocalEngineRecord({
    extension: 'info-highlight',
    version: '0.1.5',
    event: 'unload_linger',
    loaded: 'yes',
    blocked: 'other',
  });
  assert.equal(skipped.loaded, false);
  assert.equal(skipped.blocked, null);
});

test('handlePostExtensionLocalEngine: 非法拒收；合法写入', async () => {
  const STATE = mockState();
  const bad = await handlePostExtensionLocalEngine(
    postReq({ extension: 'semantic-highlight', event: 'unload_linger', version: '0.1.5' }),
    { STATE },
    json,
  );
  assert.equal(bad.status, 400);

  const ok = await handlePostExtensionLocalEngine(
    postReq({
      extension: 'info-highlight',
      version: '0.1.5',
      event: 'unload_linger',
      loaded: true,
      wait_ms: 10_000,
      blocked: 'inflight',
      js_heap_bytes: 800_000_000,
    }),
    { STATE },
    json,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stored, true);
  const keys = Object.keys(STATE.data);
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith(LOCAL_ENGINE_KEY_PREFIX));
  const rec = JSON.parse(STATE.data[keys[0]]);
  assert.equal(rec.loaded, true);
  assert.equal(rec.blocked, 'inflight');
});

test('handleListExtensionLocalEngine: 列表与单 key', async () => {
  const key = localEngineKey('cccccccc', 3_000_000);
  const STATE = mockState({
    [key]: JSON.stringify({
      saved_at: '2026-09-17T00:00:00Z',
      extension: 'info-highlight',
      version: '0.1.5',
      event: 'unload_linger',
      loaded: true,
      wait_ms: 10_000,
      blocked: 'none',
    }),
  });
  const list = await handleListExtensionLocalEngine(
    new Request('https://example.test/facade-extension-local-engine?limit=10'),
    { STATE },
    json,
    () => null,
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 1);
  assert.equal(list.body.items[0].key, key);

  const one = await handleListExtensionLocalEngine(
    new Request(`https://example.test/facade-extension-local-engine?key=${key}`),
    { STATE },
    json,
    () => null,
  );
  assert.equal(one.status, 200);
  assert.equal(one.body.record.event, 'unload_linger');
});

test('worker 路由：POST 写入 KV；admin GET 需 token', async () => {
  const STATE = mockState();
  const posted = await worker.fetch(
    new Request('https://example.test/api/extension-local-engine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extension: 'info-highlight',
        version: '0.1.5',
        event: 'unload_linger',
        loaded: true,
        wait_ms: 10_000,
        blocked: 'offer',
      }),
    }),
    { STATE },
  );
  assert.equal(posted.status, 200);
  const postedBody = await posted.json();
  assert.equal(postedBody.stored, true);

  const denied = await worker.fetch(
    new Request('https://example.test/facade-extension-local-engine'),
    { STATE, ADMIN_TOKEN: 'secret' },
  );
  assert.equal(denied.status, 403);

  const okList = await worker.fetch(
    new Request('https://example.test/facade-extension-local-engine?limit=5', {
      headers: { 'X-Admin-Token': 'secret' },
    }),
    { STATE, ADMIN_TOKEN: 'secret' },
  );
  assert.equal(okList.status, 200);
  const listBody = await okList.json();
  assert.equal(listBody.count, 1);
  assert.equal(listBody.items[0].record.blocked, 'offer');
});
