/**
 * 自动分析：1 秒内已跑完才对正文，变了再跑；不靠空串分支。
 * 运行：node --test extension/info-highlight/test/auto-recheck.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

test('content.js：1 秒内跑完才对正文，变了再跑', () => {
  const src = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(src, /1000 - \(Date\.now\(\) - t0\)/);
  assert.match(src, /pageText\(\) !== \(session\?\.mapped\?\.text \|\| ''\)/);
  assert.doesNotMatch(src, /settle && !pageText\(\)\.trim\(\)/);
});
