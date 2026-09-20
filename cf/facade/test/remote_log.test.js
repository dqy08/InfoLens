import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicRemoteError,
  isCustomDomain,
  logRemoteFailure,
  FACADE_AUTO_PATH,
} from '../src/remote_log.js';
import { mockR2, r2Records } from './mock_r2.js';

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

test('logRemoteFailure: 自定义域名写入对象存储', async () => {
  const bucket = mockR2();
  const req = new Request('https://api.info-lens.app/api/v2/analyze-semantic-relevance');
  const err = new Error('unparseable multi-chunk output: expected [1] count, got "["');
  const pub = publicRemoteError(err);

  await logRemoteFailure('remote_relevance_v2_failed', err, pub, { REPORT_LOGS: bucket }, req);

  const recs = r2Records(bucket);
  assert.equal(recs.length, 1);
  assert.match(recs[0].key, new RegExp(`/facade-auto/`));
  const parsed = recs[0].record;
  assert.equal(parsed.source, 'facade_auto');
  assert.equal(parsed.event, 'remote_relevance_v2_failed');
  assert.equal(parsed.kind, 'internal');
  assert.equal(parsed.message, 'Unparsable model output');
  assert.ok(parsed.error_detail.includes('unparseable multi-chunk output'));
  assert.equal(parsed.domain, 'api.info-lens.app');
  assert.equal(parsed.route, FACADE_AUTO_PATH);
  assert.match(parsed.received_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('logRemoteFailure: 非自定义域名不写入对象存储', async () => {
  const bucket = mockR2();
  const req = new Request('https://infolens-api.xiaoyundqy.workers.dev/api/v2/analyze-semantic-relevance');
  const err = new Error('unparseable');
  const pub = publicRemoteError(err);

  await logRemoteFailure('remote_relevance_v2_failed', err, pub, { REPORT_LOGS: bucket }, req);
  assert.equal(r2Records(bucket).length, 0);
});