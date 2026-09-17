/**
 * IL_getClientId：本地缓存 + 远程 /api/client-id（失败则本地 UUID）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = readFileSync(`${ROOT}shared/sw/client-id.js`, 'utf8');
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plugins() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${ROOT}${e.name}/manifest.json`))
    .map((e) => e.name);
}

function load({ store = {}, fetchImpl } = {}) {
  const sandbox = {
    chrome: {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            for (const k of keys) out[k] = store[k];
            queueMicrotask(() => cb(out));
          },
          set: (obj, cb) => {
            Object.assign(store, obj);
            queueMicrotask(() => cb());
          },
        },
      },
    },
    crypto: {
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      getRandomValues: (buf) => {
        for (let i = 0; i < buf.length; i++) buf[i] = (i * 17) & 0xff;
        return buf;
      },
    },
    fetch:
      fetchImpl ||
      (async () => ({
        ok: true,
        json: async () => ({ success: true, client_id: '11111111-2222-4333-8444-555555555555' }),
      })),
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(SRC, vm.createContext(sandbox));
  return { sandbox, store };
}

test('两插件均引入 client-id，并预热上报', () => {
  for (const name of plugins()) {
    const bg = readFileSync(`${ROOT}${name}/background.js`, 'utf8');
    assert.match(bg, /importScripts\('sw\/client-id\.js'\)/, `${name} 未引入 client-id`);
    assert.match(bg, /IL_prepareClientIdReporting/, `${name} 未预热 client_id`);
  }
});

test('远程成功时采用服务端 client_id 并写入 storage', async () => {
  const { sandbox, store } = load();
  const id = await sandbox.IL_getClientId('https://api.example');
  assert.equal(id, '11111111-2222-4333-8444-555555555555');
  assert.equal(store.il_client_id, id);
});

test('远程失败时回退本地 UUID', async () => {
  const { sandbox, store } = load({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const id = await sandbox.IL_getClientId('https://api.example');
  assert.match(id, UUID_RE);
  assert.equal(store.il_client_id, id);
});

test('有缓存时直接用本地 id，不打网络', async () => {
  const calls = [];
  const existing = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const { sandbox } = load({
    store: { il_client_id: existing },
    fetchImpl: async (url) => {
      calls.push(url);
      throw new Error('不该请求');
    },
  });
  assert.equal(await sandbox.IL_getClientId('https://api.example'), existing);
  assert.equal(calls.length, 0);
});

test('无缓存时带 Cookie GET 门面', async () => {
  const calls = [];
  const { sandbox } = load({
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method, credentials: opts.credentials });
      return {
        ok: true,
        json: async () => ({ success: true, client_id: '11111111-2222-4333-8444-555555555555' }),
      };
    },
  });
  await sandbox.IL_getClientId('https://api.example');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/client-id$/);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].credentials, 'include');
});
