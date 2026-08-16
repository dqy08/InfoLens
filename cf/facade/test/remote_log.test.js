import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicRemoteError,
  isCustomDomain,
  logRemoteFailure,
  AUTO_ERROR_TTL_SEC,
} from '../src/remote_log.js';

test('publicRemoteError: 流式中断 502 → 归 inference', () => {
  const r = publicRemoteError(
    new Error('OpenRouter stream error: code=502 message="Overloaded"\n--- raw output ---\n[1] 0')
  );
  assert.equal(r.kind, 'inference');
  assert.match(r.message, /Inference API temporarily unavailable/);
  assert.ok(r.error_detail.includes('Overloaded'));
});

test('publicRemoteError: 流式中断无 code → 归 inference', () => {
  const r = publicRemoteError(new Error('OpenRouter stream error: finish_reason=error'));
  assert.equal(r.kind, 'inference');
});

test('publicRemoteError: 流式中断 400 → 归 inference', () => {
  const r = publicRemoteError(new Error('OpenRouter stream error: code=400 message="bad request"'));
  assert.equal(r.kind, 'inference');
});

test('publicRemoteError: 普通 unparseable → 仍归 internal（契约问题）', () => {
  const r = publicRemoteError(new Error('unparseable multi-chunk output'));
  assert.equal(r.kind, 'internal');
  assert.equal(r.message, 'Unparsable model output');
});

test('isCustomDomain: 仅识别 api.info-lens.app', () => {
  assert.equal(
    isCustomDomain(new Request('https://api.info-lens.app/api/v2/analyze-semantic-relevance')),
    true
  );
  assert.equal(
    isCustomDomain(new Request('https://api.info-lens.app:443/api/v2/analyze-semantic-relevance')),
    true
  );
  assert.equal(
    isCustomDomain(
      new Request('https://worker.dev/test', {
        headers: { host: 'api.info-lens.app' },
      })
    ),
    true
  );
  assert.equal(
    isCustomDomain(new Request('https://infolens-api.xiaoyundqy.workers.dev/api/v2/analyze-semantic-relevance')),
    false
  );
  assert.equal(
    isCustomDomain(new Request('https://test.local/api/v2/analyze-semantic-relevance')),
    false
  );
  assert.equal(isCustomDomain(null), false);
});

test('logRemoteFailure: 自定义域名写入 STATE KV 并携带 7 天 TTL', async () => {
  let putKey = null;
  let putVal = null;
  let putOpts = null;
  const mockState = {
    async put(k, v, opts) {
      putKey = k;
      putVal = v;
      putOpts = opts;
    },
  };

  const req = new Request('https://api.info-lens.app/api/v2/analyze-semantic-relevance');
  const err = new Error('unparseable multi-chunk output: expected [1] count, got "["');
  const pub = publicRemoteError(err);

  await logRemoteFailure('remote_relevance_v2_failed', err, pub, { STATE: mockState }, req);

  assert.ok(putKey && putKey.startsWith('feedback:'));
  assert.equal(putOpts?.expirationTtl, AUTO_ERROR_TTL_SEC);
  assert.equal(putOpts?.expirationTtl, 604800);

  const parsed = JSON.parse(putVal);
  assert.equal(parsed.source, 'facade_auto');
  assert.equal(parsed.event, 'remote_relevance_v2_failed');
  assert.equal(parsed.kind, 'internal');
  assert.equal(parsed.message, 'Unparsable model output');
  assert.ok(parsed.error_detail.includes('unparseable multi-chunk output'));
  assert.equal(parsed.domain, 'api.info-lens.app');
  assert.match(parsed.saved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('logRemoteFailure: 非自定义域名不写入 STATE KV', async () => {
  let putCalled = false;
  const mockState = {
    async put() {
      putCalled = true;
    },
  };

  const req = new Request('https://infolens-api.xiaoyundqy.workers.dev/api/v2/analyze-semantic-relevance');
  const err = new Error('unparseable');
  const pub = publicRemoteError(err);

  await logRemoteFailure('remote_relevance_v2_failed', err, pub, { STATE: mockState }, req);
  assert.equal(putCalled, false);
});