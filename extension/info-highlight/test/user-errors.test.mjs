/**
 * node --test extension/info-highlight/test/user-errors.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../local/state.js'), 'utf8'), { filename: 'state.js' });
runInThisContext(readFileSync(join(dir, '../local/userErrors.js'), 'utf8'), {
  filename: 'user-errors.js',
});
const U = globalThis.IH_userErrors;

const TECH = /webgpu|adapter|HTTP \d|application\/json|bpe_strings|offscreen|ORT|setEnd/i;

function assertNoTech(userMsg) {
  assert.doesNotMatch(userMsg, TECH);
}

test('localOnlyFailure：GPU 原文不露出', () => {
  const msg = U.localOnlyFailure(new Error('no available backend found. ERR: [webgpu] Failed to get GPU adapter'));
  assert.match(msg, /on-device only/i);
  assertNoTech(msg);
});

test('localOnlyBlock：未 Prepare', () => {
  const msg = U.localOnlyBlock({ pref: 'local', webgpuOk: true, ready: false });
  assert.match(msg, /not ready/i);
  assert.match(msg, /Prepare/i);
});

test('pageAnalyzeError：正文与高亮类', () => {
  assert.equal(
    U.pageAnalyzeError('No tokens mapped onto the page'),
    'Nothing here could be highlighted. Try turning off “Main article only”, or use a simpler page.',
  );
  assert.equal(
    U.pageAnalyzeError('token offset align failed'),
    'Nothing here could be highlighted. Try turning off “Main article only”, or use a simpler page.',
  );
  assert.equal(U.pageAnalyzeError('No article text'), 'No readable article text on this page.');
});

test('pageAnalyzeError：网络与云端', () => {
  const net = U.pageAnalyzeError('Failed to fetch');
  assert.equal(net, 'Cannot reach the analyze server.');
  assertNoTech(net);
  const http = U.pageAnalyzeError('HTTP 502: expected application/json, got text/html');
  assert.equal(http, 'The analyze server returned an error. Try again later.');
  assertNoTech(http);
});

test('pageAnalyzeError：本机与扩展通道', () => {
  const gpu = U.pageAnalyzeError('On-device WebGPU is unavailable. On-device only is selected, so cloud will not be used.');
  assert.equal(gpu, 'This computer cannot run the on-device model.');
  assertNoTech(gpu);
  const port = U.pageAnalyzeError(
    'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
  );
  assert.match(port, /refresh/i);
  assertNoTech(port);
});

test('pageAnalyzeError：未知错误不泄露原文', () => {
  const raw = 'IH_appendProgress before IH_bindProgress';
  const out = U.pageAnalyzeError(raw);
  assert.equal(out, 'Analysis could not finish. Try again.');
  assertNoTech(out);
  assert.doesNotMatch(out, /IH_/);
});
