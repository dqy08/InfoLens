/**
 * 请求缓存：命中不打网、失败不写。运行：node --test extension/test/analyzeCache.test.mjs
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
const src = readFileSync(join(dir, '../semantic/analyzeCache.js'), 'utf8');
runInThisContext(src, { filename: 'analyzeCache.js' });
const cache = globalThis.IL_analyzeCache;

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

function rowsOf(texts, degrees) {
  return async (query, sent, onRow) => {
    sent.forEach((t, i) => onRow(i + 1, degrees[texts.indexOf(t)]));
  };
}

test('全未命中：一次 send 全部 texts，再读走缓存', async () => {
  const texts = ['a', 'b', 'c'];
  const sent = [];
  const send = async (query, ts, onRow) => {
    sent.push(ts.slice());
    ts.forEach((_, i) => onRow(i + 1, [0.1, 0.2, 0.3][i]));
  };
  const rows = [];
  await cache.relevance('q', texts, (n, d) => rows.push([n, d]), undefined, send);
  assert.deepEqual(sent, [['a', 'b', 'c']]);
  assert.deepEqual(rows, [
    [1, 0.1],
    [2, 0.2],
    [3, 0.3],
  ]);

  sent.length = 0;
  rows.length = 0;
  await cache.relevance('q', texts, (n, d) => rows.push([n, d]), undefined, send);
  assert.deepEqual(sent, []);
  assert.deepEqual(rows, [
    [1, 0.1],
    [2, 0.2],
    [3, 0.3],
  ]);
});

test('全命中：不调用 send', async () => {
  const texts = ['x', 'y'];
  await cache.relevance('q', texts, () => {}, undefined, rowsOf(texts, [0.4, 0.9]));
  let called = 0;
  const rows = [];
  await cache.relevance(
    'q',
    texts,
    (n, d) => rows.push([n, d]),
    undefined,
    async () => {
      called += 1;
    }
  );
  assert.equal(called, 0);
  assert.deepEqual(rows, [
    [1, 0.4],
    [2, 0.9],
  ]);
});

test('部分在缓存：回放前缀，只 send 后缀', async () => {
  await cache.relevance('q', ['a'], () => {}, undefined, async (_q, _ts, onRow) => {
    onRow(1, 0.5);
  });
  const sent = [];
  const rows = [];
  await cache.relevance(
    'q',
    ['a', 'b', 'c'],
    (n, d) => rows.push([n, d]),
    undefined,
    async (_q, ts, onRow) => {
      sent.push(ts.slice());
      ts.forEach((_, i) => onRow(i + 1, 0.2));
    }
  );
  assert.deepEqual(sent, [['b', 'c']]);
  assert.deepEqual(rows, [
    [1, 0.5],
    [2, 0.2],
    [3, 0.2],
  ]);
});

test('relevance row 已到则写入；send 随后失败不影响已到的 degree', async () => {
  const send = async (_q, ts, onRow) => {
    onRow(1, 0.7);
    throw new Error('network');
  };
  await assert.rejects(() => cache.relevance('q', ['a', 'b'], () => {}, undefined, send));

  const sent = [];
  const rows = [];
  await cache.relevance(
    'q',
    ['a', 'b'],
    (n, d) => rows.push([n, d]),
    undefined,
    async (_q, ts, onRow) => {
      sent.push(ts.slice());
      ts.forEach((_, i) => onRow(i + 1, 0.3));
    }
  );
  assert.deepEqual(sent, [['b']]);
  assert.deepEqual(rows, [
    [1, 0.7],
    [2, 0.3],
  ]);
});

test('cachedWindowLength：满窗都在则不截', () => {
  const all = [0, 0.2, 0.05];
  assert.equal(cache.cachedWindowLength(all, 0.1), 3);
});

test('cachedWindowLength：前缀有匹配、后面有洞 → 收到连续缓存末', () => {
  assert.equal(cache.cachedWindowLength([0, 0.2, 0.05, undefined, 0.9], 0.1), 3);
});

test('cachedWindowLength：前缀无匹配且有洞 → 从洞起再取 maxSend', () => {
  assert.equal(cache.cachedWindowLength([0, 0.05, undefined, 0.9], 0.1), 4);
  const degrees = [0, 0.05, undefined, ...Array(40).fill(undefined)];
  assert.equal(cache.cachedWindowLength(degrees, 0.1, 32), 34);
});

test('cachedWindowLength：第一块就未缓存 → 整窗', () => {
  assert.equal(cache.cachedWindowLength([undefined, 0.9], 0.1), 2);
});

test('windowPlan：前缀有匹配则只取连续缓存，不把后面的洞算进窗', async () => {
  await cache.relevance('q', ['a', 'b', 'c'], () => {}, undefined, async (_q, ts, onRow) => {
    ts.forEach((t, i) => onRow(i + 1, t === 'b' ? 0.2 : 0.05));
  });
  const plan = await cache.windowPlan('q', ['a', 'b', 'c', 'd'], 0.1);
  assert.equal(plan.n, 3);
  assert.deepEqual(plan.degrees, [0.05, 0.2, 0.05]);
});

test('windowPlan：前缀无匹配有洞 → 前缀加 maxSend，不把前缀算进配额', async () => {
  const texts = Array.from({ length: 50 }, (_, i) => `t${i}`);
  await cache.relevance('q', texts.slice(0, 10), () => {}, undefined, async (_q, ts, onRow) => {
    ts.forEach((_, i) => onRow(i + 1, 0.05));
  });
  const plan = await cache.windowPlan('q', texts, 0.1, 32);
  assert.equal(plan.n, 42);
  assert.equal(plan.degrees.length, 32);
  assert.equal(plan.degrees[9], 0.05);
  assert.equal(plan.degrees[10], undefined);
});

test('windowPlan：遇洞即停，不扫完全部剩余', async () => {
  mockLocal();
  const api = globalThis.chrome.storage.local;
  const orig = api.get;
  let maxKeys = 0;
  api.get = async (key) => {
    if (Array.isArray(key)) maxKeys = Math.max(maxKeys, key.length);
    return orig.call(api, key);
  };
  const texts = Array.from({ length: 80 }, (_, i) => `t${i}`);
  const plan = await cache.windowPlan('q', texts, 0.1, 32);
  assert.equal(plan.n, 32);
  assert.ok(maxKeys > 0 && maxKeys <= 32);
});

test('一次 send 的多行只改一次占用表', async () => {
  mockLocal();
  const api = globalThis.chrome.storage.local;
  const orig = api.set;
  let orderWrites = 0;
  api.set = async (obj) => {
    if ('il_ac/order' in obj) orderWrites += 1;
    return orig.call(api, obj);
  };
  await cache.relevance('q', ['a', 'b', 'c'], () => {}, undefined, async (_q, ts, onRow) => {
    ts.forEach((_, i) => onRow(i + 1, 0.2));
  });
  assert.equal(orderWrites, 1);
});

test('keywords 成功（含空 runs）才写；再读不打网', async () => {
  let calls = 0;
  const sendEmpty = async () => {
    calls += 1;
  };
  await cache.keywords('q', 't0', () => {}, undefined, sendEmpty);
  await cache.keywords('q', 't0', () => {}, undefined, sendEmpty);
  assert.equal(calls, 1);

  const runs = [
    { offset: [0, 2], raw: 'ab', score: 0.9 },
    { offset: [4, 6], raw: 'cd', score: 0.4 },
  ];
  await cache.keywords('q', 't1', () => {}, undefined, async (_q, _t, onRun) => {
    calls += 1;
    for (const r of runs) onRun(r);
  });
  const replayed = [];
  await cache.keywords('q', 't1', (r) => replayed.push(r), undefined, async () => {
    calls += 1;
  });
  assert.equal(calls, 2);
  assert.deepEqual(replayed, [
    { offset: [0, 2], score: 0.9 },
    { offset: [4, 6], score: 0.4 },
  ]);
});

test('keywords abort / 失败不写', async () => {
  const boom = async (_q, _t, onRun) => {
    onRun({ offset: [0, 1], score: 1 });
    throw new Error('aborted');
  };
  await assert.rejects(() => cache.keywords('q', 'tx', () => {}, undefined, boom));

  let calls = 0;
  const seen = [];
  await cache.keywords(
    'q',
    'tx',
    (r) => seen.push(r),
    undefined,
    async (_q, _t, onRun) => {
      calls += 1;
      onRun({ offset: [2, 3], score: 0.5 });
    }
  );
  assert.equal(calls, 1);
  assert.deepEqual(seen, [{ offset: [2, 3], score: 0.5 }]);
});

test('再次执行脚本不丢已有缓存', async () => {
  await cache.relevance('q', ['keep'], () => {}, undefined, async (_q, _t, onRow) => {
    onRow(1, 0.6);
  });
  runInThisContext(src, { filename: 'analyzeCache.js' });
  assert.equal(globalThis.IL_analyzeCache, cache);
  let called = 0;
  await globalThis.IL_analyzeCache.relevance(
    'q',
    ['keep'],
    () => {},
    undefined,
    async () => {
      called += 1;
    }
  );
  assert.equal(called, 0);
});

test('storage：内存清空后从 local 命中', async () => {
  mockLocal();
  await cache.relevance('q', ['a'], () => {}, undefined, async (_q, _t, onRow) => {
    onRow(1, 0.4);
  });
  cache.clear();
  let called = 0;
  await cache.relevance('q', ['a'], () => {}, undefined, async () => {
    called += 1;
  });
  assert.equal(called, 0);
});

test('并发写入都进环，再读不打网', async () => {
  mockLocal();
  await Promise.all(
    ['a', 'b', 'c'].map((t) =>
      cache.relevance('q', [t], () => {}, undefined, async (_q, _ts, onRow) => {
        onRow(1, 0.2);
      })
    )
  );
  let called = 0;
  await cache.relevance('q', ['a', 'b', 'c'], () => {}, undefined, async () => {
    called += 1;
  });
  assert.equal(called, 0);
});

test('满员时覆盖环上最旧条', async () => {
  const data = mockLocal();
  const keys = [];
  for (let i = 0; i < cache.MAX_ENTRIES; i++) {
    const k = `il_ac/r/${String(i).padStart(64, '0')}`;
    keys.push(k);
    data[k] = 0.1;
  }
  data['il_ac/order'] = { keys, i: 0 };
  await cache.relevance('q', ['new'], () => {}, undefined, async (_q, _t, onRow) => {
    onRow(1, 0.9);
  });
  assert.equal(data[keys[0]], undefined);
  assert.equal(data[keys[1]], 0.1);
  assert.equal(data[`il_ac/r/${await cache.key('q', 'new')}`], 0.9);
});

test('storage：按条写入后可直接命中', async () => {
  const k = await cache.key('q', 'a');
  mockLocal({ [`il_ac/r/${k}`]: 0.99 });
  let called = 0;
  await cache.relevance('q', ['a'], () => {}, undefined, async () => {
    called += 1;
  });
  assert.equal(called, 0);
});

test('键含 query：不同 query 不命中', async () => {
  await cache.relevance('q1', ['same'], () => {}, undefined, async (_q, _t, onRow) => {
    onRow(1, 0.1);
  });
  let called = 0;
  await cache.relevance('q2', ['same'], () => {}, undefined, async (_q, _t, onRow) => {
    called += 1;
    onRow(1, 0.9);
  });
  assert.equal(called, 1);
});

test('syncRemoteModel：每次打开都 fetch', async () => {
  const data = mockLocal();
  let n = 0;
  const fetchVer = async () => {
    n += 1;
    return { relevance: 1, keywords: 1 };
  };
  await cache.syncRemoteModel(fetchVer);
  await cache.syncRemoteModel(fetchVer);
  assert.equal(n, 2);
  assert.equal(data['il_ac/meta'].relevanceKey, '1:1');
  assert.equal(data['il_ac/meta'].keywordsKey, '1:1');
});

test('syncRemoteModel：只升相关度不清 keywords', async () => {
  mockLocal();
  await cache.syncRemoteModel(async () => ({ relevance: 1, keywords: 1 }));
  await cache.relevance('q', ['a'], () => {}, undefined, async (_q, _t, onRow) => {
    onRow(1, 0.9);
  });
  await cache.keywords('q', 'a', () => {}, undefined, async (_q, _t, onRun) => {
    onRun({ offset: [0, 1], score: 1 });
  });
  cache.clear();
  await cache.syncRemoteModel(async () => ({ relevance: 2, keywords: 1 }));
  let rel = 0;
  await cache.relevance('q', ['a'], () => {}, undefined, async () => {
    rel += 1;
  });
  let kw = 0;
  await cache.keywords('q', 'a', () => {}, undefined, async () => {
    kw += 1;
  });
  assert.equal(rel, 1);
  assert.equal(kw, 0);
});

test('syncRemoteModel：只升 keywords 不清相关度', async () => {
  mockLocal();
  await cache.syncRemoteModel(async () => ({ relevance: 1, keywords: 1 }));
  await cache.relevance('q', ['a'], () => {}, undefined, async (_q, _t, onRow) => {
    onRow(1, 0.9);
  });
  await cache.keywords('q', 'a', () => {}, undefined, async (_q, _t, onRun) => {
    onRun({ offset: [0, 1], score: 1 });
  });
  cache.clear();
  await cache.syncRemoteModel(async () => ({ relevance: 1, keywords: 2 }));
  let rel = 0;
  await cache.relevance('q', ['a'], () => {}, undefined, async () => {
    rel += 1;
  });
  let kw = 0;
  await cache.keywords('q', 'a', () => {}, undefined, async () => {
    kw += 1;
  });
  assert.equal(rel, 0);
  assert.equal(kw, 1);
});

test('只升 keywords 且环已满：不拧淘汰指针', async () => {
  const data = mockLocal();
  const keys = [];
  for (let i = 0; i < cache.MAX_ENTRIES; i++) {
    const k = `il_ac/r/${String(i).padStart(64, '0')}`;
    keys.push(k);
    data[k] = 0.1;
  }
  data['il_ac/order'] = { keys, i: 7 };
  data['il_ac/meta'] = { relevanceKey: '1:1', keywordsKey: '1:1' };
  await cache.syncRemoteModel(async () => ({ relevance: 1, keywords: 2 }));
  assert.equal(data['il_ac/order'].i, 7);
  assert.equal(data['il_ac/order'].keys.length, cache.MAX_ENTRIES);
});

test('丢一类后剩余按年龄排', async () => {
  const data = mockLocal();
  const keys = [];
  const kNew = `il_ac/k/${'a'.repeat(64)}`;
  const kOld = `il_ac/k/${'b'.repeat(64)}`;
  for (let i = 0; i < cache.MAX_ENTRIES; i++) {
    const k =
      i === 0 ? kNew : i === cache.MAX_ENTRIES - 1 ? kOld : `il_ac/r/${String(i).padStart(64, '0')}`;
    keys.push(k);
    data[k] = k.startsWith('il_ac/k/') ? [] : 0.1;
  }
  data['il_ac/order'] = { keys, i: 1 };
  data['il_ac/meta'] = { relevanceKey: '1:1', keywordsKey: '1:1' };
  await cache.syncRemoteModel(async () => ({ relevance: 2, keywords: 1 }));
  assert.deepEqual(data['il_ac/order'].keys, [kOld, kNew]);
  assert.equal(data['il_ac/order'].i, 0);
});

test('打开时清掉旧整包 key', async () => {
  const data = mockLocal({ il_analyze_cache: { degrees: {}, runs: {} } });
  await cache.syncRemoteModel(async () => ({ relevance: 1, keywords: 1 }));
  assert.equal(data.il_analyze_cache, undefined);
});

test('syncRemoteModel：fetch 失败不改 key，下次仍问', async () => {
  mockLocal();
  await assert.rejects(() => cache.syncRemoteModel(async () => {
    throw new Error('net');
  }));
  let n = 0;
  await cache.syncRemoteModel(async () => {
    n += 1;
    return { relevance: 1, keywords: 1 };
  });
  assert.equal(n, 1);
});
