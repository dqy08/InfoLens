/**
 * 自动分析站点名单。运行：node --test extension/info-highlight/test/auto-sites.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../auto-sites.js'), 'utf8'), {
  filename: 'auto-sites.js',
});
const A = globalThis.IH_autoSites;

/** @param {{ sites?: unknown, origins?: string[] }} init */
function mockChrome(init = {}) {
  const store = 'sites' in init ? { [A.KEY]: init.sites } : {};
  const origins = new Set(init.origins || []);
  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          const out = {};
          for (const [k, v] of Object.entries(defaults)) out[k] = k in store ? store[k] : v;
          return out;
        },
        async set(patch) {
          Object.assign(store, patch);
        },
      },
    },
    permissions: {
      async contains({ origins: want }) {
        return want.every((o) => origins.has(o));
      },
      async remove({ origins: drop }) {
        for (const o of drop) origins.delete(o);
        return true;
      },
    },
  };
  return { store, origins };
}

test.beforeEach(() => {
  delete globalThis.chrome;
});

test('hostOf 只认 http(s)', () => {
  assert.equal(A.hostOf('https://example.com/a?b=1'), 'example.com');
  assert.equal(A.hostOf('http://news.example.com/'), 'news.example.com');
  assert.equal(A.hostOf('file:///tmp/a.pdf'), null);
  assert.equal(A.hostOf('chrome://extensions'), null);
  assert.equal(A.hostOf('not a url'), null);
});

test('parseHost 接受 hostname 或 URL', () => {
  assert.equal(A.parseHost('example.com'), 'example.com');
  assert.equal(A.parseHost('  NEWS.example.com/path  '), 'news.example.com');
  assert.equal(A.parseHost('https://example.com/a'), 'example.com');
  assert.equal(A.parseHost(''), null);
  assert.equal(A.parseHost('chrome://extensions'), null);
});

test('子域各算各的', () => {
  assert.equal(A.originPattern('news.example.com'), '*://news.example.com/*');
  assert.notEqual(A.originPattern('news.example.com'), A.originPattern('example.com'));
});

test('list 忽略非字符串与非数组', async () => {
  mockChrome({ sites: ['a.com', 42, '', 'b.com'] });
  assert.deepEqual(await A.list(), ['a.com', 'b.com']);
  mockChrome({ sites: 'a.com' });
  assert.deepEqual(await A.list(), []);
  mockChrome();
  assert.deepEqual(await A.list(), []);
});

test('add 去重并排序', async () => {
  const { store } = mockChrome({ sites: ['b.com'] });
  await A.add('a.com');
  await A.add('b.com');
  assert.deepEqual(store[A.KEY], ['a.com', 'b.com']);
});

test('remove 同时撤掉 host 权限', async () => {
  const { store, origins } = mockChrome({
    sites: ['a.com', 'b.com'],
    origins: ['*://a.com/*', '*://b.com/*'],
  });
  await A.remove('a.com');
  assert.deepEqual(store[A.KEY], ['b.com']);
  assert.deepEqual([...origins], ['*://b.com/*']);
});

test('granted 要名单与权限都在', async () => {
  mockChrome({ sites: ['a.com', 'b.com'], origins: ['*://a.com/*'] });
  assert.equal(await A.granted('a.com'), true);
  // 用户在扩展详情页单独撤了权限
  assert.equal(await A.granted('b.com'), false);
  // 权限还在但已退出名单
  assert.equal(await A.granted('c.com'), false);
});
