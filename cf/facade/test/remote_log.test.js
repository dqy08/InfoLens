import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRemoteError } from '../src/remote_log.js';

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