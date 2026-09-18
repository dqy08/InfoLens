import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_INIT_KEY_PREFIX,
  localInitKey,
  buildLocalInitRecord,
  handlePostExtensionLocalInit,
  handleListExtensionLocalInit,
} from '../src/extension_local_init.js';
import { mockR2, r2Records } from './mock_r2.js';

function mockState(init = {}) {
  const data = { ...init };
  return {
    data,
    async get(key) {
      return key in data ? data[key] : null;
    },
    async put(key, value) {
      data[key] = value;
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
  return new Request('https://example.test/api/extension-local-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('localInitKey: 更新的 ms 字典序更靠前', () => {
  const older = localInitKey('aaaaaaaa', 1_000_000);
  const newer = localInitKey('bbbbbbbb', 2_000_000);
  assert.ok(older.startsWith(LOCAL_INIT_KEY_PREFIX));
  assert.ok(newer < older);
});

test('buildLocalInitRecord: 裁剪字段；ok 时不带 error', () => {
  const ok = buildLocalInitRecord({
    extension: 'info-highlight',
    version: '0.1.1',
    outcome: 'ok',
    duration_ms: 12_345.6,
    hub: 'huggingface',
    error: 'should ignore',
  });
  assert.equal(ok.extension, 'info-highlight');
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.duration_ms, 12346);
  assert.equal(ok.hub, 'huggingface');
  assert.equal(ok.error, null);
  assert.match(ok.saved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const fail = buildLocalInitRecord({
    extension: 'info-highlight',
    version: '0.1.1',
    outcome: 'failed',
    duration_ms: -1,
    hub: 'other',
    error: 'WebGPU is unavailable',
  });
  assert.equal(fail.duration_ms, 0);
  assert.equal(fail.hub, null);
  assert.equal(fail.error, 'WebGPU is unavailable');
});

test('handlePostExtensionLocalInit: 非法字段拒收；合法写入 R2', async () => {
  const REPORT_LOGS = mockR2();
  const STATE = mockState();
  const bad = await handlePostExtensionLocalInit(
    postReq({ extension: 'semantic-highlight', outcome: 'ok', version: '0.1.1' }),
    { REPORT_LOGS, STATE },
    json,
  );
  assert.equal(bad.status, 400);

  const noVer = await handlePostExtensionLocalInit(
    postReq({ extension: 'info-highlight', outcome: 'ok' }),
    { REPORT_LOGS, STATE },
    json,
  );
  assert.equal(noVer.status, 400);

  const ok = await handlePostExtensionLocalInit(
    postReq({
      extension: 'info-highlight',
      outcome: 'failed',
      version: '0.1.1',
      duration_ms: 900,
      hub: 'modelscope',
      error: 'local model init failed',
      client_id: 'cid-init',
    }),
    { REPORT_LOGS, STATE },
    json,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stored, true);
  assert.equal(Object.keys(STATE.data).length, 0);
  const recs = r2Records(REPORT_LOGS);
  assert.equal(recs.length, 1);
  assert.match(recs[0].key, /\/api-extension-local-init\//);
  const rec = recs[0].record;
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.hub, 'modelscope');
  assert.equal(rec.duration_ms, 900);
  assert.equal(rec.client_id, 'cid-init');
});

test('handleListExtensionLocalInit: 列表与单 key', async () => {
  const key = localInitKey('cccccccc', 3_000_000);
  const STATE = mockState({
    [key]: JSON.stringify({
      saved_at: '2026-09-16T00:00:00Z',
      extension: 'info-highlight',
      version: '0.1.1',
      outcome: 'ok',
      duration_ms: 1,
      hub: null,
      error: null,
    }),
  });
  const list = await handleListExtensionLocalInit(
    new Request('https://example.test/facade-extension-local-init?limit=10'),
    { STATE },
    json,
    () => null,
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 1);
  assert.equal(list.body.items[0].key, key);

  const one = await handleListExtensionLocalInit(
    new Request(`https://example.test/facade-extension-local-init?key=${key}`),
    { STATE },
    json,
    () => null,
  );
  assert.equal(one.status, 200);
  assert.equal(one.body.record.outcome, 'ok');
});
