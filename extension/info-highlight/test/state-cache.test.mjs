/**
 * 本机模型 Cache API 占用 / 清空。运行：node --test extension/info-highlight/test/state-cache.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../local/state.js'), 'utf8'), {
  filename: 'state.js',
});
const S = globalThis.IH_localState;
const CACHE = S.MODEL_CACHE;
const MODEL = S.MODEL_ID;

function modelUrl(file) {
  return `https://huggingface.co/${MODEL}/resolve/main/${file}`;
}

function mockCaches(files) {
  const store = { [CACHE]: { ...files } };
  globalThis.caches = {
    async has(name) {
      return name in store;
    },
    async keys() {
      return Object.keys(store);
    },
    async open(name) {
      const bucket = store[name] || {};
      return {
        async keys() {
          return Object.keys(bucket).map((url) => ({ url }));
        },
        async match(req) {
          const rec = bucket[req.url];
          if (!rec) return undefined;
          const headers = rec.headers || {};
          return {
            headers: {
              get(k) {
                const hit = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
                return hit == null ? null : headers[hit];
              },
            },
            blob: async () => ({ size: rec.size }),
          };
        },
      };
    },
    async delete(name) {
      const had = name in store;
      delete store[name];
      return had;
    },
  };
  return store;
}

test.beforeEach(() => {
  delete globalThis.caches;
});

test('无缓存桶则占用为 0', async () => {
  globalThis.caches = {
    async has() {
      return false;
    },
  };
  assert.deepEqual(await S.modelCacheUsage(), { entries: 0, bytes: 0 });
});

test('按 Content-Length 累加本模型文件', async () => {
  mockCaches({
    [modelUrl('onnx/model_q4.onnx')]: { headers: { 'Content-Length': '839800000' } },
    [modelUrl('tokenizer.json')]: { headers: { 'Content-Length': '33400000' } },
    'https://huggingface.co/other/model/resolve/main/onnx/model.onnx': {
      headers: { 'Content-Length': '999' },
    },
  });
  assert.deepEqual(await S.modelCacheUsage(), { entries: 2, bytes: 873200000 });
});

test('没有 Content-Length 时用 blob.size', async () => {
  mockCaches({
    [modelUrl('config.json')]: { size: 1340 },
  });
  assert.deepEqual(await S.modelCacheUsage(), { entries: 1, bytes: 1340 });
});

test('normalizeHub 只认 modelscope，其余为 huggingface', () => {
  assert.equal(S.normalizeHub('modelscope'), 'modelscope');
  assert.equal(S.normalizeHub('huggingface'), 'huggingface');
  assert.equal(S.normalizeHub(undefined), 'huggingface');
});

test('hubRemoteHost / hubOrigins 按源区分', () => {
  assert.equal(S.hubRemoteHost('huggingface'), 'https://huggingface.co/');
  assert.equal(S.hubRemoteHost('modelscope'), 'https://www.modelscope.cn/models/');
  assert.ok(S.hubOrigins('huggingface').some((o) => o.includes('huggingface.co')));
  assert.deepEqual(S.hubOrigins('modelscope'), ['https://*.modelscope.cn/*']);
});

test('ModelScope URL 也计入本模型占用', async () => {
  mockCaches({
    [`https://www.modelscope.cn/models/${MODEL}/resolve/main/onnx/model_q4.onnx`]: {
      headers: { 'Content-Length': '10' },
    },
  });
  assert.deepEqual(await S.modelCacheUsage(), { entries: 1, bytes: 10 });
});

test('dropModelCache 删掉整个缓存桶', async () => {
  const store = mockCaches({
    [modelUrl('onnx/model_q4.onnx')]: { headers: { 'Content-Length': '10' } },
  });
  await S.dropModelCache();
  assert.equal(CACHE in store, false);
  assert.deepEqual(await S.modelCacheUsage(), { entries: 0, bytes: 0 });
});
