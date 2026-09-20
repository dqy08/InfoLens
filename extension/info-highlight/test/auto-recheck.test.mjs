/**
 * 自动分析：第一段结束正文变了就重来；整轮 1 秒内结束才再等再对。不靠空串。
 * 运行：node --test extension/info-highlight/test/auto-recheck.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

test('content.js：段末作废重来；1 秒只补瞬间结束', () => {
  const src = readFileSync(join(dir, '../content.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function runBatch'), src.indexOf('function toggle'));
  assert.match(src, /let extractStable/);
  assert.match(src, /markExtractStable/);
  assert.match(src, /不表示正文已在 DOM/);
  assert.match(fn, /await globalThis\.IH_prefsReady/);
  assert.match(fn, /SETTLE_MS/);
  assert.match(src, /paintAfterFirstSegmentCheck/);
  assert.match(src, /await paintTo\(1\)/);
  assert.match(src, /pageText\(\) !== session\.mapped\.text/);
  assert.doesNotMatch(fn, /settle && !pageText\(\)\.trim\(\)/);
  const wait = fn.match(/if \(left > 0\) \{[\s\S]*?\n    \}/);
  assert.ok(wait, '应留下未满 SETTLE_MS 则等待');
  assert.match(wait[0], /pageText\(\)/);
});

test('content.js：skipCache 是 runBatch 参数，不是页内状态位', () => {
  const src = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.doesNotMatch(src, /let skipCache/);
  assert.match(src, /async function runBatch\(myGen, settle, skipCache\)/);
  assert.match(src, /void runBatch\(gen \+= 1, false, true\)/);
  assert.match(src, /void runBatch\(gen \+= 1, false, session\.skipCache\)/);
});
