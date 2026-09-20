/**
 * IH_mergeWordTokens：Intl.Segmenter 词切分 + 整 token 覆盖才合并；bit 相加。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../wordMerge.js'), 'utf8'), {
  filename: 'wordMerge.js',
});

const merge = globalThis.IH_mergeWordTokens;

test('一词多 token：offset 合并，surprisal bit 相加', () => {
  const text = ' unbelievable';
  const tokens = [
    { offset: [0, 3], p: 0.5, pred_topk: [['a', 1]] },
    { offset: [3, 9], p: 0.5, pred_topk: [['b', 1]] },
    { offset: [9, 13], p: 0.25, pred_topk: [['c', 1]] },
  ];
  const out = merge(tokens, text);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].offset, [0, 13]);
  assert.equal(out[0].raw, text);
  const expectBits = 1 + 1 + 2;
  assert.equal(out[0].p, 2 ** -expectBits);
  assert.equal(out[0].real_topk[1], out[0].p);
  assert.equal('pred_topk' in out[0], false);
});

test('铺不满词区间：保持原 token', () => {
  const text = 'foo bar';
  const tokens = [
    { offset: [0, 2], p: 0.5 },
    { offset: [2, 5], p: 0.5 },
    { offset: [5, 7], p: 0.5 },
  ];
  const out = merge(tokens, text);
  assert.equal(out.length, 3);
  assert.equal(out[0], tokens[0]);
  assert.equal(out[1], tokens[1]);
  assert.equal(out[2], tokens[2]);
});

test('已是一词一块：原样返回同一对象', () => {
  const text = 'Hello';
  const tok = { offset: [0, 5], p: 0.01 };
  const out = merge([tok], text);
  assert.equal(out.length, 1);
  assert.equal(out[0], tok);
});
