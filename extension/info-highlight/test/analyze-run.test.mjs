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
        cb({ ok: true, data: { result: { bpe_strings: raw } }, inferred: true, engine: 'cloud' });
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

  globalThis.__ihAlignFail = true;
  const report2 = newReport();
  const session2 = { ...session, painted: 0 };
  const last = await R.paintRange(session2, 0, 1, () => true, {}, report2);
  assert.match(String(last?.message || last), /token offset align failed/);
  assert.equal(report2.align_fail_n, 1);
  assert.equal(report2.segments_ok, 0);
  assert.equal(report2.last_align_err, 'token offset align failed');
});

test('afterPaint：painted===0 挂 detail 且 error 仍以 emptyMsg 开头', async () => {
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
    (err) => {
      assert.match(err.message, /^No tokens mapped onto the page /);
      assert.match(err.message, /in=12/);
      assert.match(err.message, /skip_lvl=12/);
      assert.match(err.message, /painted=0/);
      return true;
    },
  );
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

test('afterPaint：lastAlignErr 优先抛出，detail 仍带 last_align_err', async () => {
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
    /token offset align failed/,
  );
  assert.equal(report.detail.align_fail_n, 2);
  assert.equal(report.detail.last_align_err, 'token offset align failed');
  assert.equal(report.detail.painted, 0);
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
  assert.match(failMsg.error, /^No tokens mapped onto the page /);
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

test('background.js：/api/extension-usage keepalive 不含 error/detail', () => {
  const src = readFileSync(join(dir, '../background.js'), 'utf8');
  const fn = src.match(/async function postUsageReport\(body\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'postUsageReport missing');
  assert.match(fn[0], /IL_postKeepalive\('\/api\/extension-usage', payload/);
  assert.doesNotMatch(fn[0], /payload\.error/);
  assert.doesNotMatch(fn[0], /payload\.detail/);
  assert.match(fn[0], /detail: body\?\.detail/);
  assert.match(src, /IL_postKeepalive\('\/api\/extension-analysis-fail'/);
});
