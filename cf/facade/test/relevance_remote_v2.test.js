import test from 'node:test';
import assert from 'node:assert/strict';
import {
  streamRelevanceV2,
  makeSseDeltaFeeder,
  makeLineSplitter,
  parseMultiChunkCounts,
  buildMultiChunkUserContent,
} from '../src/relevance_remote_v2.js';

/** 构造 OpenRouter stream 响应体：把若干 delta.content 帧拼成 SSE 文本 */
function sseRespContent(deltaChunks) {
  const enc = new TextEncoder();
  // relevance v2 走 delta.content；OpenRouter 流式每条 data 行一个 delta
  const data = deltaChunks
    .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    .join('');
  return {
    status: 200,
    body: new ReadableStream({
      start(ctl) {
        ctl.enqueue(enc.encode(data));
        ctl.close();
      },
    }),
  };
}

async function runStream(chunks, query = '查询') {
  const rows = [];
  globalThis.fetch = async () => sseRespContent(chunks);
  await streamRelevanceV2(
    { OPENROUTER_API_KEY: 'test' },
    query,
    ['红色', '蓝色'],
    (ev) => {
      if (ev.type === 'row') rows.push({ n: ev.n, count: ev.count });
    },
    undefined
  );
  return rows;
}

test('streamRelevanceV2: 正常连续输出 → 逐行 emit 每片 count', async () => {
  const rows = await runStream(['[1] 2\n[2] 0\n']);
  assert.deepEqual(rows, [
    { n: 1, count: 2 },
    { n: 2, count: 0 },
  ]);
});

test('streamRelevanceV2: 跨 delta 碎片也能连续整流', async () => {
  // 每行被切成多个 SSE 帧；[1] 在中间换行断开
  const rows = await runStream(['[1] ', '2\n', '[2] 0\n']);
  assert.deepEqual(rows, [
    { n: 1, count: 2 },
    { n: 2, count: 0 },
  ]);
});

test('streamRelevanceV2: 跳号（[1] 后直接 [3]）→ 抛 unparseable', async () => {
  await assert.rejects(
    () => runStream(['[1] 2\n[3] 5\n']),
    /unparseable multi-chunk output/
  );
});

test('streamRelevanceV2: 重复同一 N（[1][2][2]）→ 抛 unparseable', async () => {
  await assert.rejects(
    () => runStream(['[1] 0\n[2] 1\n[2] 2\n']),
    /unparseable multi-chunk output/
  );
});

test('streamRelevanceV2: 中间夹说明文字行 → 视为契约外内容抛 unparseable', async () => {
  await assert.rejects(
    () => runStream(['[1] 2\nTokens: 8\n[2] 0\n']),
    /unparseable multi-chunk output/
  );
});

test('streamRelevanceV2: 末尾缺行（只有 [1]）→ 抛 unparseable（收尾三边校验）', async () => {
  await assert.rejects(
    () => runStream(['[1] 2\n']),
    /unparseable multi-chunk output/
  );
});

test('makeSseDeltaFeeder: SSE 帧可被任意字节边界切开，仍正确累积', () => {
  const out = [];
  const feed = makeSseDeltaFeeder((delta) => out.push(delta));
  // 一次 feed 半个 data: 行 + 换行，帧跨两次调用
  const d1 = JSON.stringify({ choices: [{ delta: { content: '[1' } }] });
  const d2 = JSON.stringify({ choices: [{ delta: { content: '] 2' } }] });
  feed(`data: ${d1}\n`);
  feed(`data: ${d2}\n\n`);
  assert.deepEqual(out, ['[1', '] 2']);
});

test('makeLineSplitter: 按换行切分，冲刷时把残留尾段也 emit', () => {
  const lines = [];
  const push = makeLineSplitter((l) => lines.push(l));
  push('[1] 0\n[2] 1');
  assert.deepEqual(lines, ['[1] 0']);
  push(''); // 冲刷残留
  assert.deepEqual(lines, ['[1] 0', '[2] 1']);
});

test('parseMultiChunkCounts: 宽松解析所有 [N] count 行（基线）', () => {
  const r = parseMultiChunkCounts('[1] 2\n[2] 0');
  assert.deepEqual([...r.counts], [[1, 2], [2, 0]]);
});

test('buildMultiChunkUserContent: 三明治包含 task/query/输出格式/ok pass', () => {
  const s = buildMultiChunkUserContent('查询', ['红']);
  assert.ok(s.includes('Query: 查询'));
  assert.ok(s.includes('Task Reminder'));
  assert.ok(s.includes('[1] 红'));
});