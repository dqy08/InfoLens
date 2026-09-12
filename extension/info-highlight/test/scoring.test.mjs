/**
 * 本机 Analyze 打分：offset / BOS / softmax+topk，不需要 GPU。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../local/scoring.js'), 'utf8'), {
  filename: 'scoring.js',
});
const S = globalThis.IH_localScoring;

test('Gemma 前导空 span 不 insert 首 token', () => {
  const { offsets, insertFirst } = S.scoringPayloadOffsets([
    [0, 0],
    [0, 3],
    [3, 11],
    [11, 14],
  ]);
  assert.equal(insertFirst, false);
  assert.deepEqual(offsets, [
    [0, 3],
    [3, 11],
    [11, 14],
  ]);
});

test('无前导空 span 时 insertFirst', () => {
  const { offsets, insertFirst } = S.scoringPayloadOffsets([
    [0, 2],
    [2, 4],
    [4, 5],
  ]);
  assert.equal(insertFirst, true);
  assert.deepEqual(offsets, [
    [0, 2],
    [2, 4],
    [4, 5],
  ]);
});

test('去掉尾部空 span', () => {
  const { offsets, insertFirst } = S.scoringPayloadOffsets([
    [0, 0],
    [0, 3],
    [3, 5],
    [5, 5],
  ]);
  assert.equal(insertFirst, false);
  assert.deepEqual(offsets, [
    [0, 3],
    [3, 5],
  ]);
});

test('ensureGemmaBos 已有空 span 则不动', () => {
  const ids = [2, 10, 11];
  const offsets = [
    [0, 0],
    [0, 2],
    [2, 4],
  ];
  const out = S.ensureGemmaBos(ids, offsets, 2);
  assert.deepEqual(out.ids, ids);
  assert.deepEqual(out.offsets, offsets);
});

test('ensureGemmaBos 缺 BOS 则前置', () => {
  const out = S.ensureGemmaBos([10, 11], [
    [0, 2],
    [2, 4],
  ], 2);
  assert.deepEqual(out.ids, [2, 10, 11]);
  assert.deepEqual(out.offsets, [
    [0, 0],
    [0, 2],
    [2, 4],
  ]);
});

test('alignUtf16Offsets：特殊 token 空 span，正文顺序对齐', () => {
  const text = 'ab';
  const ids = [9, 1, 2];
  const special = new Set([9]);
  const decode = (id) => ({ 1: 'a', 2: 'b' }[id] || `<t${id}>`);
  assert.deepEqual(S.alignUtf16Offsets(text, ids, decode, special), [
    [0, 0],
    [0, 1],
    [1, 2],
  ]);
});

test('alignUtf16Offsets：piece 带前导空格时贴在 cursor', () => {
  const text = 'Hi';
  const decode = (id) => (id === 1 ? ' Hi' : '');
  assert.deepEqual(S.alignUtf16Offsets(text, [1], decode, new Set()), [[0, 2]]);
});

test('alignUtf16Offsets：▁ 换成空格后贴在 cursor', () => {
  const text = 'Hi';
  assert.deepEqual(S.alignUtf16Offsets(text, [1], () => '\u2581Hi', new Set()), [[0, 2]]);
});

test('alignUtf16Offsets：<0xXX> 拼成原文字符，共用 span', () => {
  const text = 'hello\u00a0world';
  const piece = (id) => ({ 1: 'hello', 432: '<0xC2>', 398: '<0xA0>', 2: 'world' }[id]);
  assert.deepEqual(S.alignUtf16Offsets(text, [1, 432, 398, 2], piece, new Set()), [
    [0, 5],
    [5, 6],
    [5, 6],
    [6, 11],
  ]);
});

test('alignUtf16Offsets：四字节 UTF-8 共用 span', () => {
  const text = '😀';
  const piece = (id) => ({ 1: '<0xF0>', 2: '<0x9F>', 3: '<0x98>', 4: '<0x80>' }[id]);
  assert.deepEqual(S.alignUtf16Offsets(text, [1, 2, 3, 4], piece, new Set()), [
    [0, 2],
    [0, 2],
    [0, 2],
    [0, 2],
  ]);
});

test('alignUtf16Offsets：对不上则抛错', () => {
  assert.throws(
    () => S.alignUtf16Offsets('ab', [1], () => 'z', new Set()),
    /token offset align failed/,
  );
});

test('alignUtf16Offsets：不在 cursor 处的相同子串不算对齐', () => {
  assert.throws(
    () => S.alignUtf16Offsets('xa', [1], () => 'a', new Set()),
    /token offset align failed/,
  );
});

test('alignUtf16Offsets：半截 UTF-8 则抛错', () => {
  assert.throws(
    () => S.alignUtf16Offsets('\u00a0', [432], () => '<0xC2>', new Set()),
    /token offset align failed/,
  );
});

test('utf16ToCpOffsets 把补充平面从 UTF-16 换成码点', () => {
  const text = 'a\u{1F600}b';
  const utf16 = [
    [0, 1],
    [1, 3],
    [3, 4],
  ];
  assert.deepEqual(S.utf16ToCpOffsets(text, utf16), [
    [0, 1],
    [1, 2],
    [2, 3],
  ]);
});

test('scoreRow gold 与 top1 一致', () => {
  const logits = [1, 3, 0];
  const row = S.scoreRow(logits, 0, 3, 1, 2);
  assert.equal(row.pred[0][0], 1);
  assert.ok(Math.abs(row.p - row.pred[0][1]) < 1e-12);
  assert.ok(row.p > 0.5);
});

test('bpeFromLogits 跳过 BOS，产出 Analyze 形状', () => {
  const vocab = 3;
  const seq = 3;
  const logits = new Float32Array(seq * vocab);
  // row 0 → class 1; row 1 → class 2
  logits[1] = 5;
  logits[vocab + 2] = 5;
  const out = S.bpeFromLogits({
    logits,
    dims: [1, seq, vocab],
    ids: [0, 1, 2],
    offsets: [
      [0, 0],
      [0, 1],
      [1, 2],
    ],
    text: 'ab',
    decodeId: (id) => ['<bos>', 'a', 'b'][id],
    topk: 2,
  });
  assert.equal(out.bpe_strings.length, 2);
  assert.deepEqual(out.bpe_strings[0].offset, [0, 1]);
  assert.equal(out.bpe_strings[0].raw, 'a');
  assert.equal(out.bpe_strings[0].real_topk[0], 0);
  assert.equal(out.bpe_strings[0].pred_topk[0][0], 'a');
  assert.equal(out.bpe_strings[1].raw, 'b');
});

test('bpeFromLogits 无 BOS 空 span 则报错', () => {
  const logits = new Float32Array(4);
  assert.throws(
    () =>
      S.bpeFromLogits({
        logits,
        dims: [1, 2, 2],
        ids: [1, 2],
        offsets: [
          [0, 1],
          [1, 2],
        ],
        text: 'ab',
        decodeId: String,
      }),
    /leading empty BOS span/,
  );
});

test('scoreChunk 拼起来与整表 bpeFromLogits 一致', () => {
  const vocab = 3;
  const seq = 5;
  const logits = new Float32Array(seq * vocab);
  for (let i = 0; i < seq - 1; i++) logits[i * vocab + ((i + 1) % vocab)] = 4;
  const args = {
    ids: [0, 1, 2, 0, 1],
    offsets: [
      [0, 0],
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
    text: 'abcd',
    decodeId: (id) => ['x', 'a', 'b'][id],
    topk: 2,
  };
  const full = S.bpeFromLogits({ logits, dims: [1, seq, vocab], ...args });
  const rows = [
    ...S.scoreChunk(logits, vocab, args.ids, 0, 3, args.topk),
    ...S.scoreChunk(logits.subarray(3 * vocab), vocab, args.ids, 3, 5, args.topk),
  ];
  const chunked = S.bpeFromRows({ rows, ...args });
  assert.deepEqual(chunked, full);
});

test('scoreChunk 最后一块只有末 token 则没有行', () => {
  assert.deepEqual(S.scoreChunk(new Float32Array(3), 3, [0, 1, 2], 2, 3), []);
});
