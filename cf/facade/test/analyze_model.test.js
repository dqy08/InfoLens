import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  ANALYZE_PATH,
  isAllowedAnalyzeModel,
  analyzeModelGateMessage,
} from '../src/analyze_model.js';

function buf(obj) {
  return new TextEncoder().encode(JSON.stringify(obj));
}

test('isAllowedAnalyzeModel：default / 空 / 两档 id', () => {
  assert.equal(isAllowedAnalyzeModel(undefined), true);
  assert.equal(isAllowedAnalyzeModel(null), true);
  assert.equal(isAllowedAnalyzeModel(''), true);
  assert.equal(isAllowedAnalyzeModel('default'), true);
  assert.equal(isAllowedAnalyzeModel(' Default '), true);
  assert.equal(isAllowedAnalyzeModel('gemma-3-270m'), true);
  assert.equal(isAllowedAnalyzeModel('Qwen3-0.6B'), true);
  assert.equal(isAllowedAnalyzeModel('qwen3-14b'), false);
  assert.equal(isAllowedAnalyzeModel(1), false);
});

test('analyzeModelGateMessage：非法 JSON 放行；未知 id 拒绝', () => {
  assert.equal(analyzeModelGateMessage(new TextEncoder().encode('{')), null);
  assert.equal(analyzeModelGateMessage(buf({ text: 'hi' })), null);
  assert.equal(analyzeModelGateMessage(buf({ model: 'default', text: 'hi' })), null);
  assert.equal(analyzeModelGateMessage(buf({ model: 'gemma-3-270m', text: 'hi' })), null);
  const msg = analyzeModelGateMessage(buf({ model: 'qwen3-14b', text: 'hi' }));
  assert.match(msg, /qwen3-14b/);
  assert.match(msg, /gemma-3-270m/);
});

test('POST /api/analyze：未知模型 400，不打上游', async () => {
  const origFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return new Response('{}', { status: 200 });
  };
  try {
    const res = await worker.fetch(
      new Request(`https://example.test${ANALYZE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3-14b', text: 'hello' }),
      }),
      { HF_ORIGIN: 'https://hf.example.test' },
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.match(data.message, /qwen3-14b/);
    assert.equal(n, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('POST /api/analyze：default 与 gemma 转发上游', async () => {
  const origFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), body: init.body });
    return new Response(JSON.stringify({ from: 'hf' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    for (const model of ['default', 'gemma-3-270m', 'qwen3-0.6b']) {
      fetched.length = 0;
      const res = await worker.fetch(
        new Request(`https://example.test${ANALYZE_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, text: 'hello' }),
        }),
        { HF_ORIGIN: 'https://hf.example.test' },
      );
      assert.equal(res.status, 200);
      assert.equal(fetched.length, 1);
      assert.equal(fetched[0].url, `https://hf.example.test${ANALYZE_PATH}`);
      const forwarded = JSON.parse(new TextDecoder().decode(fetched[0].body));
      assert.equal(forwarded.model, model);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});
