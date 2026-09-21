/**
 * analyzeRun：paint 计数跨段累加；painted===0 把 detail 挂到 fail 上报。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));

const messages = [];
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      messages.push(msg);
      if (msg?.type === 'ih-analyze') {
        const raw = globalThis.__ihAnalyzeTokens || [{ offset: [0, 5], p: 0.01 }];
        cb({
          ok: true,
          data: { result: { bpe_strings: raw, model: 'qwen3-0.6b' } },
          inferred: true,
          engine: 'cloud',
        });
        return;
      }
      cb?.();
    },
  },
};

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

globalThis.IH_setProgressSearching = async () => {};
globalThis.IH_appendProgress = () => {};
globalThis.IH_clearError = () => {};
globalThis.IH_segmentWindow = () => ({
  requestText: 'Hello',
  originCp: 0,
  segStartCp: 0,
  segEndCp: 5,
});
globalThis.IH_tokensInSegment = (raw) => {
  if (globalThis.__ihAlignFail) throw new Error('token offset align failed');
  return raw;
};
globalThis.IH_paintTokens = (tokens) => globalThis.__ihPaintStats?.(tokens) || {
  painted: 0,
  tokens_in: Array.isArray(tokens) ? tokens.length : 0,
  tokens_skip_level: Array.isArray(tokens) ? tokens.length : 0,
  tokens_skip_empty_range: 0,
};

runInThisContext(readFileSync(join(dir, '../analyzeRun.js'), 'utf8'), {
  filename: 'analyzeRun.js',
});
const R = globalThis.IH_analyzeRun;

function newReport() {
  return {
    segments: 0,
    segments_ok: 0,
    cached: 0,
    engine: null,
    outcome: null,
    error: null,
    duration_ms: 0,
    align_fail_n: 0,
    tokens_in: 0,
    tokens_skip_level: 0,
    tokens_skip_empty_range: 0,
    painted: 0,
    last_align_err: null,
    detail: null,
  };
}

test.beforeEach(() => {
  messages.length = 0;
  globalThis.__ihAlignFail = false;
  globalThis.__ihAnalyzeTokens = [{ offset: [0, 5], p: 0.01 }];
  globalThis.CSS = { highlights: new Map() };
  globalThis.IH_tokenTip = {
    models: [],
    setModel(name) {
      this.models.push(name);
    },
  };
});

test('paintRange：累加 skip_level / painted，align_fail_n 计入跳过段', async () => {
  const session = {
    mapped: { text: 'Hello world', pieces: [{}, {}] },
    segs: [
      { start: 0, end: 5, text: 'Hello' },
      { start: 6, end: 11, text: 'world' },
    ],
    painted: 0,
  };
  const report = newReport();
  let n = 0;
  globalThis.__ihPaintStats = (tokens) => {
    n += 1;
    return {
      painted: 0,
      tokens_in: tokens.length,
      tokens_skip_level: tokens.length,
      tokens_skip_empty_range: 0,
    };
  };
  const align = await R.paintRange(session, 0, 2, () => true, {}, report);
  assert.equal(align, undefined);
  assert.equal(n, 2);
  assert.equal(report.segments, 2);
  assert.equal(report.segments_ok, 2);
  assert.equal(report.tokens_in, 2);
  assert.equal(report.tokens_skip_level, 2);
  assert.equal(report.painted, 0);
  assert.equal(session.painted, 0);
  assert.equal(report.align_fail_n, 0);
  assert.equal(report.engine, 'cloud');
  assert.equal(report.model, 'qwen3-0.6b');
  assert.deepEqual(globalThis.IH_tokenTip.models, ['qwen3-0.6b', 'qwen3-0.6b']);

  globalThis.__ihAlignFail = true;
  const report2 = newReport();
  const session2 = { ...session, painted: 0 };
  const last = await R.paintRange(session2, 0, 1, () => true, {}, report2);
  assert.match(String(last?.message || last), /token offset align failed/);
  assert.equal(report2.align_fail_n, 1);
  assert.equal(report2.segments_ok, 0);
  assert.equal(report2.last_align_err, 'token offset align failed');
});

test('paintRange：opts.skipCache 写进 ih-analyze', async () => {
  const session = {
    mapped: { text: 'Hello', pieces: [{}] },
    segs: [{ start: 0, end: 5, text: 'Hello' }],
    painted: 0,
  };
  globalThis.__ihPaintStats = () => ({
    painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0,
  });
  await R.paintRange(session, 0, 1, () => true, { skipCache: true }, newReport());
  const analyze = messages.filter((m) => m.type === 'ih-analyze');
  assert.equal(analyze.length, 1);
  assert.equal(analyze[0].skipCache, true);
});

test('afterPaint：painted===0 挂 detail；对用户只抛 emptyMsg', async () => {
  const session = {
    next: 1,
    segs: [{}],
    painted: 0,
    mapped: { text: 'Hello', pieces: [1, 2, 3] },
  };
  const report = newReport();
  report.segments = 1;
  report.segments_ok = 1;
  report.tokens_in = 12;
  report.tokens_skip_level = 12;
  await assert.rejects(
    () => R.afterPaint(session, null, 'No tokens mapped onto the page', () => {}, report),
    /No tokens mapped onto the page/,
  );
  assert.equal(report.error, 'No tokens mapped onto the page');
  assert.doesNotMatch(String(report.error), /skip_lvl=/);
  assert.equal(report.detail.tokens_in, 12);
  assert.equal(report.detail.tokens_skip_level, 12);
  assert.equal(report.detail.tokens_skip_empty_range, 0);
  assert.equal(report.detail.painted, 0);
  assert.equal(report.detail.mapped_chars, 5);
  assert.equal(report.detail.mapped_pieces, 3);
  assert.equal(report.detail.highlights_ok, true);
  assert.equal(report.detail.segments, 1);
  assert.equal('page_url' in report.detail, false);
  assert.equal('page_text' in report.detail, false);
});

test('afterPaint：painted===0 时 detail 带 last_align_err，对用户仍用 emptyMsg', async () => {
  const session = {
    next: 1,
    segs: [{}],
    painted: 0,
    mapped: { text: 'ab', pieces: [{}] },
  };
  const report = newReport();
  report.align_fail_n = 2;
  const alignErr = new Error('token offset align failed');
  await assert.rejects(
    () => R.afterPaint(session, alignErr, 'No tokens mapped onto the page', () => {}, report),
    /No tokens mapped onto the page/,
  );
  assert.equal(report.error, 'No tokens mapped onto the page');
  assert.equal(report.detail.align_fail_n, 2);
  assert.equal(report.detail.last_align_err, 'token offset align failed');
  assert.equal(report.detail.painted, 0);
});

test('paintRange：按段写入 tokensBySeg；align_fail 记空数组', async () => {
  const toks = [{ offset: [0, 5], p: 0.01 }];
  globalThis.__ihAnalyzeTokens = toks;
  globalThis.__ihPaintStats = () => ({
    painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0,
  });
  const session = {
    mapped: { text: 'Hello world', pieces: [{}, {}] },
    segs: [
      { start: 0, end: 5, text: 'Hello' },
      { start: 6, end: 11, text: 'world' },
    ],
    painted: 0,
  };
  await R.paintRange(session, 0, 2, () => true, {}, newReport());
  assert.deepEqual(session.tokensBySeg, [toks, toks]);

  globalThis.__ihAlignFail = true;
  const skipped = { mapped: { text: 'Hello', pieces: [{}] }, segs: [{ start: 0, end: 5, text: 'Hello' }], painted: 0 };
  await R.paintRange(skipped, 0, 1, () => true, {}, newReport());
  assert.deepEqual(skipped.tokensBySeg, [[]]);
});

test('repaintCommitted：只画 [0, next)，不发 ih-analyze', async () => {
  const paints = [];
  const progress = [];
  const prevAppend = globalThis.IH_appendProgress;
  globalThis.__ihPaintStats = (tokens) => {
    paints.push(tokens);
    return { painted: tokens.length, tokens_in: tokens.length, tokens_skip_level: 0, tokens_skip_empty_range: 0 };
  };
  globalThis.IH_appendProgress = (tokens, seg) => {
    progress.push({ tokens, start: seg.start });
  };
  const extra = [{ offset: [99, 100], p: 0.5 }];
  const session = {
    mapped: { text: 'old', pieces: [] },
    segs: [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' },
      { start: 2, end: 3, text: 'c' },
    ],
    next: 2,
    painted: 9,
    tokensBySeg: [
      [{ offset: [0, 1], p: 0.1 }],
      [{ offset: [1, 2], p: 0.2 }],
      extra,
    ],
  };
  const mapped = { text: 'old', pieces: [{}], root: {} };
  const before = messages.filter((m) => m.type === 'ih-analyze').length;
  try {
    await R.repaintCommitted(session, mapped, true);
  } finally {
    globalThis.IH_appendProgress = prevAppend;
  }
  assert.equal(messages.filter((m) => m.type === 'ih-analyze').length, before);
  assert.equal(paints.length, 2);
  assert.equal(session.mapped, mapped);
  assert.equal(session.painted, 2);
  assert.deepEqual(progress.map((p) => p.start), [0, 1]);
  assert.equal(session.tokensBySeg[2], extra);
});

test('repaintCommitted：缺已提交段 token 则抛错', async () => {
  const session = {
    mapped: { text: 'x', pieces: [] },
    segs: [{ start: 0, end: 1, text: 'x' }],
    next: 1,
    painted: 1,
    tokensBySeg: [],
  };
  await assert.rejects(
    () => R.repaintCommitted(session, session.mapped, true),
    /tokens missing for segment 0/,
  );
});

test('repaintCommitted：still 为假则停，不画', async () => {
  const paints = [];
  globalThis.__ihPaintStats = (tokens) => {
    paints.push(tokens);
    return { painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0 };
  };
  const session = {
    mapped: { text: 'ab', pieces: [] },
    segs: [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' },
    ],
    next: 2,
    painted: 0,
    tokensBySeg: [[{ offset: [0, 1], p: 0.1 }], [{ offset: [1, 2], p: 0.2 }]],
  };
  await R.repaintCommitted(session, { text: 'ab', pieces: [{}] }, true, () => false);
  assert.equal(paints.length, 0);
});

test('runJob：failed 时 ih-usage-report 带 detail；ok 时不带', async () => {
  await R.runJob(
    () => true,
    { fail: async () => {}, idle: () => {} },
    async (report) => {
      report.segments = 1;
      report.tokens_in = 3;
      report.tokens_skip_level = 3;
      const session = {
        next: 1,
        segs: [{}],
        painted: 0,
        mapped: { text: 'Hi', pieces: [{}] },
      };
      await R.afterPaint(session, null, 'No tokens mapped onto the page', () => {}, report);
    },
  );
  const failMsg = messages.find((m) => m.type === 'ih-usage-report');
  assert.equal(failMsg.outcome, 'failed');
  assert.equal(failMsg.detail.tokens_in, 3);
  assert.equal(failMsg.detail.painted, 0);
  assert.equal(failMsg.error, 'No tokens mapped onto the page');
  assert.equal(failMsg.segments, 1);

  messages.length = 0;
  await R.runJob(
    () => true,
    { fail: async () => {}, idle: () => {} },
    async (report) => {
      report.segments = 1;
      report.detail = { tokens_in: 9 };
    },
  );
  const okMsg = messages.find((m) => m.type === 'ih-usage-report');
  assert.equal(okMsg.outcome, 'ok');
  assert.equal('detail' in okMsg, false);
  assert.equal('error' in okMsg, false);
});

test('runJob：onFailed 在 fail 之前收到 report', async () => {
  let seen = null;
  await R.runJob(
    () => true,
    {
      onFailed: ({ report }) => {
        seen = report.outcome;
      },
      fail: async () => {},
      idle: () => {},
    },
    async (report) => {
      report.segments = 1;
      throw new Error('boom');
    },
  );
  assert.equal(seen, 'failed');
});

test('background.js：失败时 error/detail 写进同一条 /api/extension-usage', () => {
  const src = readFileSync(join(dir, '../background.js'), 'utf8');
  const fn = src.match(/async function postUsageReport\(body\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'postUsageReport missing');
  assert.match(fn[0], /IL_postKeepalive\('\/api\/extension-usage', payload/);
  assert.match(src, /il-extension-feedback/);
  assert.match(fn[0], /if \(model\) payload\.model = model/);
  assert.match(fn[0], /payload\.error = err/);
  assert.match(fn[0], /payload\.detail = detail/);
  assert.doesNotMatch(src, /function usageModelId/);
  assert.doesNotMatch(src, /\/api\/extension-analysis-fail/);
});
