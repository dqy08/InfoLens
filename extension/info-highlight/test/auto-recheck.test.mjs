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
  assert.match(fn, /if \(settle && session\.next === 0 && cap > 0\)/);
  assert.match(fn, /await paintTo\(1\)/);
  assert.match(fn, /pageText\(\) !== session\.mapped\.text/);
  assert.match(fn, /1000 - \(Date\.now\(\) - t0\)/);
  assert.doesNotMatch(fn, /settle && !pageText\(\)\.trim\(\)/);
  const wait = fn.match(/if \(left > 0\) \{[\s\S]*?\n    \}/);
  assert.ok(wait, '应留下未满 1 秒则等待');
  assert.match(wait[0], /pageText\(\)/);
});
