import test from 'node:test';
import assert from 'node:assert/strict';
import {
  streamRelevanceV2,
  handleRemoteRelevanceV2,
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

test('streamRelevanceV2: 凑齐前重复 N（[1][1]）→ 抛 unparseable', async () => {
  await assert.rejects(
    () => runStream(['[1] 0\n[1] 1\n[2] 2\n']),
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

test('streamRelevanceV2: 凑齐后多余行（含重复 N / 说明）→ 忽略且成功', async () => {
  const rows = await runStream(['[1] 2\n[2] 0\n[2] 9\nTokens: 8\n']);
  assert.deepEqual(rows, [
    { n: 1, count: 2 },
    { n: 2, count: 0 },
  ]);
});

test('streamRelevanceV2: 流式中断带顶层 error 事件 → 抛真实错误而非 unparseable', async () => {
  const enc = new TextEncoder();
  const data = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '[1] 0\n' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '[2] 1\n' } }] })}\n\n`,
    `data: ${JSON.stringify({
      error: { code: 502, message: 'Provider disconnected unexpectedly' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    })}\n\n`,
  ].join('');
  globalThis.fetch = async () => ({
    status: 200,
    body: new ReadableStream({
      start(ctl) {
        ctl.enqueue(enc.encode(data));
        ctl.close();
      },
    }),
  });
  await assert.rejects(
    () =>
      streamRelevanceV2(
        { OPENROUTER_API_KEY: 'test' },
        '查询',
        ['红色', '蓝色'],
        () => {},
        undefined
      ),
    (err) =>
      err.message.includes('OpenRouter stream error') &&
      err.message.includes('Provider disconnected') &&
      err.message.includes('[2] 1')
  );
});

test('streamRelevanceV2: 流式中断仅 finish_reason=error → 抛真实错误', async () => {
  const enc = new TextEncoder();
  const data = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '[1] 0\n' } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error', native_finish_reason: 'server_error' }],
    })}\n\n`,
  ].join('');
  globalThis.fetch = async () => ({
    status: 200,
    body: new ReadableStream({
      start(ctl) {
        ctl.enqueue(enc.encode(data));
        ctl.close();
      },
    }),
  });
  await assert.rejects(
    () =>
      streamRelevanceV2(
        { OPENROUTER_API_KEY: 'test' },
        '查询',
        ['红色', '蓝色'],
        () => {},
        undefined
      ),
    (err) =>
      err.message.includes('finish_reason=error') && err.message.includes('server_error')
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

test('makeSseDeltaFeeder: 字符串 code 裸写且未传 onError 时直接 throw', () => {
  const feed = makeSseDeltaFeeder(() => {});
  const frame = JSON.stringify({
    error: { code: '502', message: 'Overloaded' },
    choices: [{ delta: {}, finish_reason: 'error' }],
  });
  assert.throws(
    () => feed(`data: ${frame}\n\n`),
    (err) =>
      err.message.includes('OpenRouter stream error:') &&
      err.message.includes('code=502') &&
      !err.message.includes('code="502"')
  );
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
  const compact = parseMultiChunkCounts('[1]2\n[2]0');
  assert.deepEqual([...compact.counts], [[1, 2], [2, 0]]);
});

test('buildMultiChunkUserContent: 三明治包含 task/query/输出格式/ok pass', () => {
  const s = buildMultiChunkUserContent('查询', ['红']);
  assert.ok(s.includes('Query: 查询'));
  assert.ok(s.includes('Task Reminder'));
  assert.ok(s.includes('Passage 1: 红'));
  assert.ok(s.includes('[1]0'));
  const iTask = s.indexOf('Task: ');
  const iFmt1 = s.indexOf('Output Format:');
  const iQuery1 = s.indexOf('Query: 查询');
  const iArt = s.indexOf('Article:');
  const iRem = s.indexOf('Task Reminder:');
  const iFmt2 = s.lastIndexOf('Output Format:');
  const iQuery2 = s.lastIndexOf('Query: 查询');
  assert.ok(iTask < iQuery1 && iQuery1 < iFmt1 && iFmt1 < iArt);
  assert.ok(iArt < iRem && iRem < iQuery2 && iQuery2 < iFmt2);
});

test('buildMultiChunkUserContent: formatReminder 为 true 时附加具体行数与非全0举例', () => {
  const s1 = buildMultiChunkUserContent('查询', ['红'], true);
  assert.ok(s1.includes('CRITICAL: Strictly adhere to the format. Output EXACTLY 1 lines, from [1] to [1].'));
  assert.ok(s1.includes('Example reply for 1 passages:\n[1]0'));

  const s2 = buildMultiChunkUserContent('查询', ['红', '蓝'], true);
  assert.ok(s2.includes('CRITICAL: Strictly adhere to the format. Output EXACTLY 2 lines, from [1] to [2].'));
  assert.ok(s2.includes('Example reply for 2 passages:\n[1]0\n[2]1'));

  const s3 = buildMultiChunkUserContent('查询', ['红', '蓝', '绿'], true);
  assert.ok(s3.includes('Example reply for 3 passages:\n[1]0\n[2]1\n[3]0'));

  const sLong = buildMultiChunkUserContent('查询', ['1', '2', '3', '4', '5'], true);
  assert.ok(sLong.includes('CRITICAL: Strictly adhere to the format. Output EXACTLY 5 lines, from [1] to [5].'));
  assert.ok(sLong.includes('Example reply for 5 passages:\n[1]0\n[2]1\n...\n[5]0'));
});

test('handleRemoteRelevanceV2: 首次中途 unparseable 重试时从断点切片继续并映射 n 序号', async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      callCount++;
      const body = JSON.parse(init.body);
      const content = body.messages[0].content;
      if (callCount === 1) {
        assert.ok(content.includes('Passage 1: 红') && content.includes('Passage 2: 蓝'));
        // 第一次成功发了 [1]，在 [2] 乱码断开
        return sseRespContent(['[1] 2\n[s,\n']);
      }
      // 重试只发送了剩余切片（蓝），模型从 [1] 编号输出
      assert.ok(!content.includes('Passage 1: 红'));
      assert.ok(content.includes('Passage 1: 蓝'));
      assert.ok(content.includes('CRITICAL: Strictly adhere'));
      return sseRespContent(['[1] 0\n']);
    };
    const req = new Request('https://test.local/api/v2/analyze-semantic-relevance', {
      method: 'POST',
      body: JSON.stringify({ query: '查询', texts: ['红', '蓝'] }),
    });
    const resp = await handleRemoteRelevanceV2(
      req,
      { OPENROUTER_API_KEY: 'test' },
      (_r, b, s) => new Response(JSON.stringify(b), { status: s || 200 })
    );
    assert.equal(resp.status, 200);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.equal(callCount, 2);
    // 验证 n:1 与 n:2 各有一条正确结果
    assert.ok(text.includes('"type":"row","n":1,"full_match_degree":1'));
    assert.ok(text.includes('"type":"row","n":2,"full_match_degree":0'));
    assert.ok(text.includes('"type":"result","success":true'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handleRemoteRelevanceV2: unparseable 耗尽 3 次重试 → error', async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      callCount++;
      const content = JSON.parse(init.body).messages[0].content;
      if (callCount === 1) assert.ok(!content.includes('CRITICAL: Strictly adhere'));
      else assert.ok(content.includes('CRITICAL: Strictly adhere'));
      return sseRespContent(['[s,\n']);
    };
    const req = new Request('https://test.local/api/v2/analyze-semantic-relevance', {
      method: 'POST',
      body: JSON.stringify({ query: '查询', texts: ['红', '蓝'] }),
    });
    const resp = await handleRemoteRelevanceV2(
      req,
      { OPENROUTER_API_KEY: 'test' },
      (_r, b, s) => new Response(JSON.stringify(b), { status: s || 200 })
    );
    assert.equal(resp.status, 200);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.equal(callCount, 4);
    assert.ok(text.includes('"type":"error"'));
    assert.ok(!text.includes('"type":"result","success":true'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
