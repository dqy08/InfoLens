import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSubmitKeywordsArguments,
  salvagePartialKeywordsArguments,
  uniquifyStep,
  keywordsToTokenAttention,
  buildKeywordsUserContent,
  streamKeywordsV2,
} from '../src/keywords_remote_v2.js';

/** 构造 OpenRouter stream 响应体：把若干 delta 帧拼成 SSE 文本 */
function sseResp(deltaArgsChunks) {
  const enc = new TextEncoder();
  const data = deltaArgsChunks
    .map((args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: args } }] } }] })}\n\n`)
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

async function runStream(argsChunks, text = '正文无需任何关键词') {
  const rows = [];
  globalThis.fetch = async () => sseResp(argsChunks);
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

test('parseSubmitKeywordsArguments: 合法空数组 = 零词', () => {
  assert.deepEqual(parseSubmitKeywordsArguments('{"keywords":[]}'), []);
  assert.deepEqual(parseSubmitKeywordsArguments('{"keywords": [  ] }'), []);
});

test('parseSubmitKeywordsArguments: 合法条目解析并截断分到 1..5', () => {
  assert.deepEqual(
    parseSubmitKeywordsArguments('{"keywords":[{"keyword":"红楼","score":5},{"keyword":"梦","score":0}]}'),
    [['红楼', 5], ['梦', 1]]
  );
});

test('parseSubmitKeywordsArguments: 非空却 0 条有效 = 解析失败', () => {
  assert.equal(parseSubmitKeywordsArguments('{"keywords":[{"wrong":1}]}'), null);
  assert.equal(parseSubmitKeywordsArguments('{oops'), null);
});

test('salvagePartialKeywordsArguments: 从残缺增量捞已写完条目', () => {
  assert.deepEqual(salvagePartialKeywordsArguments('{"keywords":[{"keyword":"红楼","score":5},'), [
    ['红楼', 5],
  ]);
  assert.equal(salvagePartialKeywordsArguments('{"keywords":['), null);
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

test('buildKeywordsUserContent: 三明治结构包含 query/text', () => {
  const s = buildKeywordsUserContent('红楼梦', '红楼梦正文');
  assert.ok(s.includes('Query: 红楼梦'));
  assert.ok(s.includes('红楼梦正文'));
  assert.ok(s.includes('Task Reminder'));
});

test('streamKeywordsV2: 模型返回合法空数组 → 不抛错（回归修复）', async () => {
  const rows = await runStream([JSON.stringify({ keywords: [] })]);
  assert.deepEqual(rows, []);
});

test('streamKeywordsV2: 碎片增量仍能捞到完整 keyword', async () => {
  const chunks = ['{"keywo', 'rds":[{"keyword":"测试","score":5}]}'];
  const rows = await runStream(chunks, '这是测试正文');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw, '测试');
});

test('streamKeywordsV2: 增量扫描跨多个 delta 仍只 emit 一次完整条目', async () => {
  // 每个 delta 切成小碎片，多轮跨边界累计；增量 fromIndex 扫描应不重不漏
  const chunks = [
    '{"keywo',
    'rds":[{"keyword":"测试","score":5},{"keywo',
    'rd":"匹配","score":3}]}',
  ];
  const rows = await runStream(chunks, '这是测试正文，还有一个匹配的词');
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.raw).sort(),
    ['测试', '匹配'].sort()
  );
});

test('streamKeywordsV2: 非空但无效输出 → 仍报 unparseable', async () => {
  await assert.rejects(
    () => runStream([JSON.stringify({ keywords: [{ wrong: 1 }] })]),
    /unparseable tool arguments output/
  );
});

test('streamKeywordsV2: 流式中断带顶层 error → 抛真实错误', async () => {
  const enc = new TextEncoder();
  const data = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"key' } }] } }] })}\n\n`,
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
