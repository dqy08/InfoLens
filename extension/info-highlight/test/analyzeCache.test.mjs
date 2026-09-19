/**
 * 请求缓存：命中不打网、失败不写。运行：node --test extension-info-highlight/test/analyzeCache.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../../shared/cache/ring-store.js'), 'utf8'), {
  filename: 'ring-store.js',
});
const src = readFileSync(join(dir, '../analyzeCache.js'), 'utf8');
runInThisContext(src, { filename: 'analyzeCache.js' });
const cache = globalThis.IH_analyzeCache;

test.beforeEach(() => {
  cache.clear();
  delete globalThis.chrome;
});

function mockLocal(initial = {}) {
  const data = { ...initial };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (key == null) return { ...data };
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) {
              if (k in data) out[k] = data[k];
            }
            return out;
          }
          return { [key]: data[key] };
        },
        async set(obj) {
          Object.assign(data, obj);
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) delete data[k];
        },
      },
    },
  };
  return data;
}

function tok(s, e, p = 0.5) {
  return { offset: [s, e], real_topk: [1, p] };
}

function stored(s, e, p = 0.5) {
  return { offset: [s, e], p };
}

function live(s, e, p = 0.5, raw = '', pred = []) {
  return { offset: [s, e], p, raw, pred_topk: pred };
}

test('全未命中：一次 send，再读走缓存', async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return [tok(0, 1)];
  };
  const a = await cache.tokens('t0', send);
  const b = await cache.tokens('t0', send);
  assert.equal(calls, 1);
  assert.deepEqual(a, [live(0, 1)]);
  assert.deepEqual(b, [stored(0, 1)]);
});

test('相同请求命中缓存后按当前文档位置重新映射', async () => {
  mockLocal();
  runInThisContext(readFileSync(join(dir, '../../shared/page/textIndex.js'), 'utf8'), {
    filename: 'textIndex.js',
  });
  runInThisContext(readFileSync(join(dir, '../../shared/page/progressAxis.js'), 'utf8'), {
    filename: 'progressAxis.js',
  });
  runInThisContext(readFileSync(join(dir, '../highlightStyle.js'), 'utf8'), {
    filename: 'highlightStyle.js',
  });
  runInThisContext(readFileSync(join(dir, '../page-map.js'), 'utf8'), {
    filename: 'page-map.js',
  });
  const cached = await cache.tokens('same request', async () => [tok(0, 1, 0.25)]);
  const hit = await cache.tokens('same request', async () => {
    throw new Error('cache miss');
  });
  const at10 = globalThis.IH_tokensInSegment(cached, {
    originCp: 10,
    segStartCp: 10,
    segEndCp: 11,
  });
  const at30 = globalThis.IH_tokensInSegment(hit, {
    originCp: 30,
    segStartCp: 30,
    segEndCp: 31,
  });
  assert.deepEqual(at10, [live(10, 11, 0.25)]);
  assert.deepEqual(at30, [stored(30, 31, 0.25)]);
});

test('空数组也写；再读不打网', async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return [];
  };
  assert.deepEqual(await cache.tokens('empty', send), []);
  assert.deepEqual(await cache.tokens('empty', send), []);
  assert.equal(calls, 1);
});

test('skip：已有缓存也打网并覆盖；失败则原条留下', async () => {
  mockLocal();
  await cache.tokens('t0', async () => [tok(0, 1, 0.1)]);
  await assert.rejects(() =>
    cache.tokens('t0', async () => {
      throw new Error('network');
    }, { skip: true })
  );
  let calls = 0;
  const got = await cache.tokens('t0', async () => {
    calls += 1;
    return [tok(0, 1, 0.9)];
  }, { skip: true });
  assert.equal(calls, 1);
  assert.deepEqual(got, [live(0, 1, 0.9)]);
  let hit = 0;
  const cached = await cache.tokens('t0', async () => {
    hit += 1;
    return [tok(0, 1)];
  });
  assert.equal(hit, 0);
  assert.equal(cached[0].p, 0.9);
});

test('失败不写', async () => {
  await assert.rejects(() =>
    cache.tokens('tx', async () => {
      throw new Error('network');
    })
  );
  let calls = 0;
  const got = await cache.tokens('tx', async () => {
    calls += 1;
    return [tok(2, 3, 0.2)];
  });
  assert.equal(calls, 1);
  assert.deepEqual(got, [live(2, 3, 0.2)]);
});

test('只存 offset 与 p；悬停字段只在未命中的返回值里', async () => {
  const data = mockLocal();
  const got = await cache.tokens('hello', async () => [
    { offset: [0, 1], real_topk: [3, 0.25], pred_topk: [['a', 0.5]], raw: 'h', extra: 1 },
  ]);
  const k = `ih_ac/t/${await cache.key('hello')}`;
  assert.deepEqual(data[k], [stored(0, 1, 0.25)]);
  assert.deepEqual(got, [live(0, 1, 0.25, 'h', [['a', 0.5]])]);
});

test('再次执行脚本不丢已有缓存', async () => {
  await cache.tokens('keep', async () => [tok(0, 1)]);
  runInThisContext(src, { filename: 'analyzeCache.js' });
  assert.equal(globalThis.IH_analyzeCache, cache);
  let called = 0;
  await globalThis.IH_analyzeCache.tokens('keep', async () => {
    called += 1;
    return [tok(9, 10)];
  });
  assert.equal(called, 0);
});

test('storage：内存清空后从 local 命中', async () => {
  mockLocal();
  await cache.tokens('a', async () => [tok(0, 1, 0.4)]);
  cache.clear();
  let called = 0;
  await cache.tokens('a', async () => {
    called += 1;
    return [tok(0, 1)];
  });
  assert.equal(called, 0);
});

test('并发写入都进环，再读不打网', async () => {
  mockLocal();
  await Promise.all(
    ['a', 'b', 'c'].map((t) => cache.tokens(t, async () => [tok(0, 1, 0.2)]))
  );
  let called = 0;
  await cache.tokens('a', async () => {
    called += 1;
    return [tok(0, 1)];
  });
  await cache.tokens('b', async () => {
    called += 1;
    return [tok(0, 1)];
  });
  await cache.tokens('c', async () => {
    called += 1;
    return [tok(0, 1)];
  });
  assert.equal(called, 0);
});

test('满员时覆盖环上最旧条', async () => {
  const data = mockLocal();
  const keys = [];
  for (let i = 0; i < cache.MAX_ENTRIES; i++) {
    const k = `ih_ac/t/${String(i).padStart(32, '0')}`;
    keys.push(k);
    data[k] = [tok(0, 1)];
  }
  data['ih_ac/order'] = { keys, i: 0 };
  data['ih_ac/meta'] = { v: 6 };
  await cache.tokens('new', async () => [tok(0, 2, 0.9)]);
  assert.equal(data[keys[0]], undefined);
  assert.equal(data[keys[1]][0].offset[1], 1);
  assert.deepEqual(data[`ih_ac/t/${await cache.key('new')}`], [stored(0, 2, 0.9)]);
});

test('文本哈希为 32 位十六进制', async () => {
  const k = await cache.key('hello');
  assert.equal(k.length, 32);
  assert.match(k, /^[0-9a-f]{32}$/);
});

test('不同文本不命中', async () => {
  await cache.tokens('t1', async () => [tok(0, 1, 0.1)]);
  let called = 0;
  await cache.tokens('t2', async () => {
    called += 1;
    return [tok(0, 1, 0.9)];
  });
  assert.equal(called, 1);
});

test('usage：条数为数据 key，不含 meta/order', async () => {
  mockLocal();
  await cache.tokens('a', async () => [tok(0, 1)]);
  await cache.tokens('b', async () => [tok(0, 1)]);
  const u = await cache.usage();
  assert.equal(u.entries, 2);
  assert.ok(u.bytes > 0);
});

test('dropAll：清掉缓存条，不碰其它 key', async () => {
  const data = mockLocal({ show_progress: true });
  await cache.tokens('a', async () => [tok(0, 1, 0.4)]);
  await cache.dropAll();
  const u = await cache.usage();
  assert.equal(u.entries, 0);
  assert.equal(u.bytes, 0);
  assert.equal(data.show_progress, true);
  assert.equal(
    Object.keys(data).some((k) => k.startsWith('ih_ac/')),
    false
  );
  let called = 0;
  await cache.tokens('a', async () => {
    called += 1;
    return [tok(0, 1, 0.4)];
  });
  assert.equal(called, 1);
});

test('旧的绝对偏移缓存版本会被丢弃', async () => {
  const data = mockLocal();
  const k = `ih_ac/t/${'a'.repeat(32)}`;
  data[k] = [tok(0, 1)];
  data['ih_ac/order'] = { keys: [k], i: 0 };
  data['ih_ac/meta'] = { v: 2 };
  const u = await cache.usage();
  assert.equal(u.entries, 0);
  assert.equal(data[k], undefined);
});
