import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  ANALYSIS_FAIL_KEY_PREFIX,
  analysisFailKey,
  redactUrls,
  buildAnalysisFailRecord,
  handlePostExtensionAnalysisFail,
  handleListExtensionAnalysisFail,
} from '../src/extension_analysis_fail.js';

function mockState(init = {}) {
  const data = { ...init };
  return {
    data,
    async get(key) {
      return key in data ? data[key] : null;
    },
    async put(key, value) {
      data[key] = value;
    },
    async list({ prefix, limit }) {
      const keys = Object.keys(data)
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function json(_req, body, status = 200) {
  return { status, body };
}

function postReq(body) {
  return new Request('https://example.test/api/extension-analysis-fail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('analysisFailKey: 更新的 ms 字典序更靠前', () => {
  const older = analysisFailKey('aaaaaaaa', 1_000_000);
  const newer = analysisFailKey('bbbbbbbb', 2_000_000);
  assert.ok(older.startsWith(ANALYSIS_FAIL_KEY_PREFIX));
  assert.ok(newer < older);
});

test('redactUrls: 剥离 http(s)/file/data 等明显 URL', () => {
  assert.equal(redactUrls('Cannot reach https://api.info-lens.app'), 'Cannot reach [url]');
  assert.equal(
    redactUrls('failed fetching http://example.com/path?q=1 and www.evil.test/x'),
    'failed fetching [url] and [url]',
  );
  assert.equal(redactUrls('file:///tmp/page.pdf leaked'), '[url] leaked');
  assert.equal(redactUrls('data:text/html,secret-body'), '[url]');
  assert.equal(redactUrls('chrome-extension://abcdef/offscreen.html'), '[url]');
  assert.equal(redactUrls('WebGPU is unavailable'), 'WebGPU is unavailable');
});

test('buildAnalysisFailRecord: 裁剪、只收 failed、忽略页面字段、error 去 URL', () => {
  const rec = buildAnalysisFailRecord({
    extension: 'info-highlight',
    version: '0.1.3-too-long-version-string-should-clip-here',
    engine: 'local',
    outcome: 'failed',
    error: 'On-device analysis failed: Cannot reach https://api.info-lens.app/api/analyze',
    segments: 3.2,
    duration_ms: 12_345.6,
    page_url: 'https://news.example/article',
    page_text: 'full article body must never be stored',
  });
  assert.equal(rec.extension, 'info-highlight');
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.engine, 'local');
  assert.equal(rec.version.length, 32);
  assert.equal(rec.version.endsWith('…'), true);
  assert.equal(rec.segments, 3);
  assert.equal(rec.duration_ms, 12346);
  assert.equal(rec.error, 'On-device analysis failed: Cannot reach [url]');
  assert.equal('page_url' in rec, false);
  assert.equal('page_text' in rec, false);
  assert.match(rec.saved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const fromMessage = buildAnalysisFailRecord({
    extension: 'info-highlight',
    version: '0.1.3',
    outcome: 'failed',
    message: 'HTTP 502',
    engine: 'gpu',
    segments: -1,
  });
  assert.equal(fromMessage.error, 'HTTP 502');
  assert.equal(fromMessage.engine, null);
  assert.equal(fromMessage.segments, null);
  assert.equal(fromMessage.duration_ms, null);

  const long = buildAnalysisFailRecord({
    extension: 'info-highlight',
    version: '0.1.3',
    outcome: 'failed',
    error: `see https://example.com/overflow ${'x'.repeat(600)}`,
  });
  assert.equal(long.error.length, 500);
  assert.equal(long.error.endsWith('…'), true);
  assert.equal(long.error.includes('https://'), false);
  assert.equal(long.error.includes('[url]'), true);
});

test('handlePostExtensionAnalysisFail: 非法字段拒收；合法写入', async () => {
  const STATE = mockState();
  const badExt = await handlePostExtensionAnalysisFail(
    postReq({
      extension: 'semantic-highlight',
      outcome: 'failed',
      version: '0.1.3',
      error: 'nope',
    }),
    { STATE },
    json,
  );
  assert.equal(badExt.status, 400);

  const okOutcome = await handlePostExtensionAnalysisFail(
    postReq({
      extension: 'info-highlight',
      outcome: 'ok',
      version: '0.1.3',
      error: 'should not store successes',
    }),
    { STATE },
    json,
  );
  assert.equal(okOutcome.status, 400);

  const cancelled = await handlePostExtensionAnalysisFail(
    postReq({
      extension: 'info-highlight',
      outcome: 'cancelled',
      version: '0.1.3',
      error: 'Cancelled',
    }),
    { STATE },
    json,
  );
  assert.equal(cancelled.status, 400);

  const noVer = await handlePostExtensionAnalysisFail(
    postReq({ extension: 'info-highlight', outcome: 'failed', error: 'x' }),
    { STATE },
    json,
  );
  assert.equal(noVer.status, 400);

  const noErr = await handlePostExtensionAnalysisFail(
    postReq({ extension: 'info-highlight', outcome: 'failed', version: '0.1.3' }),
    { STATE },
    json,
  );
  assert.equal(noErr.status, 400);

  const ok = await handlePostExtensionAnalysisFail(
    postReq({
      extension: 'info-highlight',
      outcome: 'failed',
      version: '0.1.3',
      engine: 'cloud',
      segments: 4,
      duration_ms: 900,
      error: 'HTTP 500: expected application/json, got text/html',
    }),
    { STATE },
    json,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stored, true);
  const keys = Object.keys(STATE.data);
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith(ANALYSIS_FAIL_KEY_PREFIX));
  const rec = JSON.parse(STATE.data[keys[0]]);
  assert.equal(rec.outcome, 'failed');
  assert.equal(rec.engine, 'cloud');
  assert.equal(rec.segments, 4);
  assert.equal(rec.duration_ms, 900);
  assert.equal(rec.error, 'HTTP 500: expected application/json, got text/html');
  assert.equal('page_url' in rec, false);
});

test('handleListExtensionAnalysisFail: 列表与单 key；无 token 拒绝', async () => {
  const key = analysisFailKey('cccccccc', 3_000_000);
  const STATE = mockState({
    [key]: JSON.stringify({
      saved_at: '2026-09-17T00:00:00Z',
      extension: 'info-highlight',
      version: '0.1.3',
      engine: 'local',
      outcome: 'failed',
      error: 'WebGPU is unavailable',
      segments: 1,
    }),
  });
  const denied = await handleListExtensionAnalysisFail(
    new Request('https://example.test/facade-extension-analysis-fail?limit=10'),
    { STATE },
    json,
    () => 'unauthorized',
  );
  assert.equal(denied.status, 403);

  const list = await handleListExtensionAnalysisFail(
    new Request('https://example.test/facade-extension-analysis-fail?limit=10'),
    { STATE },
    json,
    () => null,
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 1);
  assert.equal(list.body.items[0].key, key);
  assert.equal(list.body.items[0].record.error, 'WebGPU is unavailable');

  const one = await handleListExtensionAnalysisFail(
    new Request(`https://example.test/facade-extension-analysis-fail?key=${key}`),
    { STATE },
    json,
    () => null,
  );
  assert.equal(one.status, 200);
  assert.equal(one.body.record.outcome, 'failed');
});

test('worker 路由：POST 写入 KV 并 redact URL；admin GET 需 token', async () => {
  const STATE = mockState();
  const posted = await worker.fetch(
    new Request('https://example.test/api/extension-analysis-fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extension: 'info-highlight',
        version: '0.1.3',
        outcome: 'failed',
        engine: 'local',
        segments: 2,
        error: 'Cannot reach https://api.info-lens.app',
      }),
    }),
    { STATE },
  );
  assert.equal(posted.status, 200);
  const postedBody = await posted.json();
  assert.equal(postedBody.stored, true);
  const stored = JSON.parse(Object.values(STATE.data)[0]);
  assert.equal(stored.error, 'Cannot reach [url]');
  assert.equal('page_url' in stored, false);

  const denied = await worker.fetch(
    new Request('https://example.test/facade-extension-analysis-fail'),
    { STATE, ADMIN_TOKEN: 'secret' },
  );
  assert.equal(denied.status, 403);

  const okList = await worker.fetch(
    new Request('https://example.test/facade-extension-analysis-fail?limit=5', {
      headers: { 'X-Admin-Token': 'secret' },
    }),
    { STATE, ADMIN_TOKEN: 'secret' },
  );
  assert.equal(okList.status, 200);
  const listBody = await okList.json();
  assert.equal(listBody.count, 1);
  assert.equal(listBody.items[0].record.error, 'Cannot reach [url]');
});
