import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_KEY_PREFIX,
  eventKey,
  buildEventRecord,
  handlePostExtensionEvents,
  handleListExtensionEvents,
} from '../src/extension_events.js';

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
  return new Request('https://example.test/api/extension-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('eventKey: 时间在前，event 在 key 里；更新的 ms 字典序更靠前', () => {
  const olderInstall = eventKey('install', 'aaaaaaaa', 1_000_000);
  const newerUninstall = eventKey('uninstall', 'bbbbbbbb', 2_000_000);
  assert.ok(olderInstall.startsWith(EVENT_KEY_PREFIX));
  assert.match(olderInstall, /:install:aaaaaaaa$/);
  assert.match(newerUninstall, /:uninstall:bbbbbbbb$/);
  assert.ok(newerUninstall < olderInstall);
});

test('buildEventRecord: update 才带 previous_version', () => {
  const inst = buildEventRecord({ event: 'install', version: '0.6.5', previous_version: '0.6.4' });
  assert.equal(inst.event, 'install');
  assert.equal(inst.version, '0.6.5');
  assert.equal(inst.previous_version, undefined);
  assert.match(inst.saved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const upd = buildEventRecord({ event: 'update', version: '0.6.5', previous_version: '0.6.4' });
  assert.equal(upd.previous_version, '0.6.4');
});

test('handlePostExtensionEvents: 非法 event / 缺 version 拒收', async () => {
  const STATE = mockState();
  const badEvent = await handlePostExtensionEvents(postReq({ event: 'other', version: '0.6.5' }), { STATE }, json);
  assert.equal(badEvent.status, 400);
  const noVer = await handlePostExtensionEvents(postReq({ event: 'install' }), { STATE }, json);
  assert.equal(noVer.status, 400);
  assert.equal(Object.keys(STATE.data).length, 0);
});

test('handlePostExtensionEvents: 每条事件单独落盘', async () => {
  const STATE = mockState();
  const inst = await handlePostExtensionEvents(
    postReq({ event: 'install', version: '0.6.5' }),
    { STATE },
    json
  );
  const upd = await handlePostExtensionEvents(
    postReq({ event: 'update', version: '0.6.6', previous_version: '0.6.5' }),
    { STATE },
    json
  );
  const visit = await handlePostExtensionEvents(
    postReq({ event: 'uninstall', version: '0.6.6' }),
    { STATE },
    json
  );
  assert.equal(inst.body.stored, true);
  assert.equal(upd.body.stored, true);
  assert.equal(visit.body.stored, true);
  const keys = Object.keys(STATE.data);
  assert.equal(keys.length, 3);
  assert.equal(keys.filter((k) => k.includes(':install:')).length, 1);
  assert.equal(keys.filter((k) => k.includes(':update:')).length, 1);
  assert.equal(keys.filter((k) => k.includes(':uninstall:')).length, 1);
  const records = Object.values(STATE.data).map((raw) => JSON.parse(raw));
  assert.equal(records.filter((r) => r.event === 'install').length, 1);
  const updateRec = records.find((r) => r.event === 'update');
  assert.equal(updateRec.previous_version, '0.6.5');
});

test('handleListExtensionEvents: 最新在前，支持单条 key', async () => {
  const older = eventKey('install', 'aaaaaaaa', 1_000_000);
  const newer = eventKey('uninstall', 'bbbbbbbb', 2_000_000);
  const STATE = mockState({
    [older]: JSON.stringify({ event: 'install', version: '0.6.4', saved_at: '2026-01-01T00:00:00Z' }),
    [newer]: JSON.stringify({ event: 'uninstall', version: '0.6.5', saved_at: '2026-01-02T00:00:00Z' }),
  });

  const listRes = await handleListExtensionEvents(
    new Request('https://example.test/facade-extension-events?limit=10'),
    { STATE },
    json,
    () => null
  );
  assert.equal(listRes.body.count, 2);
  assert.equal(listRes.body.items[0].key, newer);
  assert.equal(listRes.body.items[0].record.event, 'uninstall');

  const getRes = await handleListExtensionEvents(
    new Request(`https://example.test/facade-extension-events?key=${newer}`),
    { STATE },
    json,
    () => null
  );
  assert.equal(getRes.body.ok, true);
  assert.equal(getRes.body.record.version, '0.6.5');
});
