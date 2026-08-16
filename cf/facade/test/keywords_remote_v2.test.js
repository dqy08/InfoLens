import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVerbalKeywords,
  uniquifyStep,
  keywordsToTokenAttention,
  buildKeywordsUserContent,
  streamKeywordsV2,
  handleRemoteKeywordsV2,
} from '../src/keywords_remote_v2.js';

/** 构造 OpenRouter stream 响应体：把若干 delta.content 帧拼成 SSE 文本 */
function sseResp(deltaChunks) {
  const enc = new TextEncoder();
  const data = deltaChunks
    .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
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

async function readSseText(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

async function runStream(deltaChunks, text = '正文无需任何关键词') {
  const rows = [];
  globalThis.fetch = async () => sseResp(deltaChunks);
  await streamKeywordsV2(
    { OPENROUTER_API_KEY: 'test' },
    '查询',
    text,
    (ev) => {
      if (ev.type === 'row') rows.push({ raw: ev.raw, score: ev.score });
    },
    undefined
  );
  return rows;
}

test('parseVerbalKeywords: 空/空白字符串 = 零词', () => {
  assert.deepEqual(parseVerbalKeywords(''), []);
  assert.deepEqual(parseVerbalKeywords('  \n  '), []);
});

test('parseVerbalKeywords: 合法条目解析并截断分到 1..5', () => {
  assert.deepEqual(parseVerbalKeywords('[红楼]5\n[梦]0'), [
    ['红楼', 5],
    ['梦', 1],
  ]);
  assert.deepEqual(parseVerbalKeywords('[红楼]5\n\n[梦]0'), [
    ['红楼', 5],
    ['梦', 1],
  ]);
});

test('parseVerbalKeywords: 非空却 0 条有效 / 无 content / 夹杂非法行 = 解析失败', () => {
  assert.equal(parseVerbalKeywords('sorry'), null);
  assert.equal(parseVerbalKeywords('{oops'), null);
  assert.equal(parseVerbalKeywords(null), null);
  assert.equal(parseVerbalKeywords('[红楼]5\nsorry'), null);
});

test('uniquifyStep: 档位降级但不落到 1 以下', () => {
  const taken = new Set();
  assert.equal(uniquifyStep(5, taken), 5);
  assert.equal(uniquifyStep(5, taken), 4); // 5 已占 → 降到 4
  assert.equal(uniquifyStep(1, taken), 1); // 1 不限
});

test('keywordsToTokenAttention: 无关键词 → 空 runs', () => {
  assert.deepEqual(keywordsToTokenAttention('无关正文', []), []);
});

test('keywordsToTokenAttention: 关键词定位出无重叠 run', () => {
  const runs = keywordsToTokenAttention('这是测试正文测试', [['测试', 5]]);
  assert.ok(runs.length > 0);
  assert.equal(runs[0].raw, '测试');
  assert.equal(runs[0].score, 1); // 5/5 = 1
});

test('buildKeywordsUserContent: 三明治 Task/Query/Format 头尾同序', () => {
  const s = buildKeywordsUserContent('红楼梦', '红楼梦正文');
  assert.ok(s.includes('Query: 红楼梦'));
  assert.ok(s.includes('红楼梦正文'));
  assert.ok(s.includes('Task Reminder'));
  assert.ok(s.includes('Output Format:'));
  assert.ok(!s.includes('Submit with'));
  const iTask = s.indexOf('Task: ');
  const iQuery1 = s.indexOf('Query: 红楼梦');
  const iFmt1 = s.indexOf('Output Format:');
  const iText = s.indexOf('Text:');
  const iRem = s.indexOf('Task Reminder:');
  const iQuery2 = s.lastIndexOf('Query: 红楼梦');
  const iFmt2 = s.lastIndexOf('Output Format:');
  assert.ok(iTask < iQuery1 && iQuery1 < iFmt1 && iFmt1 < iText);
  assert.ok(iText < iRem && iRem < iQuery2 && iQuery2 < iFmt2);
});

test('buildKeywordsUserContent: formatReminder 为 true 时附加格式强化', () => {
  const s = buildKeywordsUserContent('红楼梦', '红楼梦正文', true);
  assert.ok(s.includes('CRITICAL: Strictly adhere to the format.'));
  assert.ok(s.includes('Example reply:\n[foo]5\n[bar]3'));
});

test('handleRemoteKeywordsV2: 首次 unparseable 时以 formatReminder 重试一次', async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      callCount++;
      const body = JSON.parse(init.body);
      const content = body.messages[0].content;
      if (callCount === 1) {
        assert.ok(!content.includes('CRITICAL: Strictly adhere'));
        // 首次返回首 Token 乱码
        return sseResp(['[1,\n']);
      }
      // 重试调用带 formatReminder
      assert.ok(content.includes('CRITICAL: Strictly adhere'));
      return sseResp(['[测试]5\n']);
    };
    const req = new Request('https://test.local/api/v2/analyze-semantic-keywords', {
      method: 'POST',
      body: JSON.stringify({ query: '查询', text: '这是测试正文', stream: true }),
    });
    const resp = await handleRemoteKeywordsV2(
      req,
      { OPENROUTER_API_KEY: 'test' },
      (_r, b, s) => new Response(JSON.stringify(b), { status: s || 200 })
    );
    assert.equal(resp.status, 200);
    const text = await readSseText(resp);
    assert.equal(callCount, 2);
    assert.ok(text.includes('"type":"row","offset":[2,4],"raw":"测试","score":1'));
    assert.ok(text.includes('"type":"result","success":true'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handleRemoteKeywordsV2: 已发出 row 后 unparseable → 不重试、客户端成功，仍写 KV', async () => {
  let callCount = 0;
  let putVal = null;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      callCount++;
      return sseResp(['[测试]5\nsorry\n']);
    };
    const req = new Request('https://api.info-lens.app/api/v2/analyze-semantic-keywords', {
      method: 'POST',
      body: JSON.stringify({ query: '查询', text: '这是测试正文', stream: true }),
    });
    const resp = await handleRemoteKeywordsV2(
      req,
      {
        OPENROUTER_API_KEY: 'test',
        STATE: { async put(_k, v) { putVal = v; } },
      },
      (_r, b, s) => new Response(JSON.stringify(b), { status: s || 200 })
    );
    assert.equal(resp.status, 200);
    const text = await readSseText(resp);
    assert.equal(callCount, 1);
    assert.ok(text.includes('"type":"row","offset":[2,4],"raw":"测试","score":1'));
    assert.ok(text.includes('"type":"result","success":true'));
    assert.ok(!text.includes('"type":"error"'));
    const parsed = JSON.parse(putVal);
    assert.equal(parsed.source, 'facade_auto');
    assert.equal(parsed.event, 'remote_keywords_v2_failed');
    assert.equal(parsed.attempt, 1);
    assert.equal(parsed.retries, 3);
    assert.ok(parsed.error_detail.includes('unparseable verbal output'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handleRemoteKeywordsV2: unparseable 耗尽 3 次重试 → error', async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      callCount++;
      const content = JSON.parse(init.body).messages[0].content;
      if (callCount === 1) assert.ok(!content.includes('CRITICAL: Strictly adhere'));
      else assert.ok(content.includes('CRITICAL: Strictly adhere'));
      return sseResp(['[1,\n']);
    };
    const req = new Request('https://test.local/api/v2/analyze-semantic-keywords', {
      method: 'POST',
      body: JSON.stringify({ query: '查询', text: '这是测试正文', stream: true }),
    });
    const resp = await handleRemoteKeywordsV2(
      req,
      { OPENROUTER_API_KEY: 'test' },
      (_r, b, s) => new Response(JSON.stringify(b), { status: s || 200 })
    );
    assert.equal(resp.status, 200);
    const text = await readSseText(resp);
    assert.equal(callCount, 4);
    assert.ok(text.includes('"type":"error"'));
    assert.ok(!text.includes('"type":"result","success":true'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamKeywordsV2: 空回复 → 不抛错', async () => {
  const rows = await runStream(['']);
  assert.deepEqual(rows, []);
});

test('streamKeywordsV2: 有词但原文全对不上 → 与空回复一样成功（零行）', async () => {
  const rows = await runStream(['[Final words]5\n'], '正文里没有这个短语');
  assert.deepEqual(rows, []);
});

test('streamKeywordsV2: 碎片增量仍能捞到完整 keyword', async () => {
  const chunks = ['[测', '试]5\n'];
  const rows = await runStream(chunks, '这是测试正文');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw, '测试');
});

test('streamKeywordsV2: 增量扫描跨多个 delta 仍只 emit 一次完整条目', async () => {
  const chunks = ['[测', '试]5\n[匹', '配]3\n'];
  const rows = await runStream(chunks, '这是测试正文，还有一个匹配的词');
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.raw).sort(),
    ['测试', '匹配'].sort()
  );
});

test('streamKeywordsV2: 非空但无效输出 → 仍报 unparseable', async () => {
  await assert.rejects(
    () => runStream(['sorry I cannot']),
    /unparseable verbal output/
  );
});

test('streamKeywordsV2: 合法行后夹杂非法行 → 报错（不跳过）', async () => {
  await assert.rejects(
    () => runStream(['[测试]5\nsorry\n'], '这是测试正文'),
    /unparseable verbal output/
  );
});

test('streamKeywordsV2: 流式中断带顶层 error → 抛真实错误', async () => {
  const enc = new TextEncoder();
  const data = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '[测' } }] })}\n\n`,
    `data: ${JSON.stringify({
      error: { code: 502, message: 'Overloaded' },
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
      streamKeywordsV2(
        { OPENROUTER_API_KEY: 'test' },
        '查询',
        '正文',
        () => {},
        undefined
      ),
    /OpenRouter stream error: code=502 message="Overloaded"/
  );
});
