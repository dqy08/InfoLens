import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  USAGE_PATH,
  MAX_REPORT_LOG_BYTES,
  routeSlug,
  compactIso,
  reportLogKey,
  buildReportLogRecord,
  planReportLog,
  teeReportLog,
  persistAcceptedReport,
  resetReportLogWarnings,
} from '../src/report_log.js';
import { mockR2, mockCtx, r2Records } from './mock_r2.js';

function mockState(init = {}) {
  const data = { ...init };
  const puts = [];
  return {
    data,
    puts,
    async get(key) {
      return key in data ? data[key] : null;
    },
    async put(key, value, opts) {
      data[key] = value;
      puts.push({ key, opts });
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

test('routeSlug / compactIso / reportLogKey 命名', () => {
  assert.equal(routeSlug('/api/extension-usage'), 'api-extension-usage');
  assert.equal(routeSlug('///api/extension-events'), 'api-extension-events');
  assert.equal(compactIso('2026-09-18T06:45:00.123Z'), '20260918T064500123Z');
  assert.equal(compactIso(new Date('2026-09-18T06:45:00.123Z')), '20260918T064500123Z');
  const key = reportLogKey(
    '/api/extension-usage',
    new Date('2026-09-18T06:45:00.123Z'),
    'a1b2c3d4',
  );
  assert.equal(
    key,
    'reports/2026-09-18/api-extension-usage/20260918T064500123Z-a1b2c3d4.json',
  );
});

test('buildReportLogRecord: 保留原字段（含 client_id），覆盖 received_at/route', () => {
  const rec = buildReportLogRecord({
    route: '/api/extension-usage',
    received_at: '2026-09-18T06:45:00.123Z',
    body: {
      client_id: 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678',
      extension: 'info-highlight',
      received_at: 'client-supplied',
      route: 'client-supplied',
    },
  });
  assert.equal(rec.client_id, 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678');
  assert.equal(rec.extension, 'info-highlight');
  assert.equal(rec.received_at, '2026-09-18T06:45:00.123Z');
  assert.equal(rec.route, '/api/extension-usage');
});

test('teeReportLog: 缺 binding no-op 且 warn 一次', async () => {
  resetReportLogWarnings();
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const a = await teeReportLog({}, { route: USAGE_PATH, body: { n: 1 } });
    const b = await teeReportLog({}, { route: USAGE_PATH, body: { n: 2 } });
    assert.equal(a.skipped, 'no_binding');
    assert.equal(b.skipped, 'no_binding');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /REPORT_LOGS/);
  } finally {
    console.warn = orig;
  }
});

test('teeReportLog: 超大 payload 写 stub 不落原文', async () => {
  const REPORT_LOGS = mockR2();
  const body = { blob: 'x'.repeat(MAX_REPORT_LOG_BYTES) };
  const out = await teeReportLog(
    { REPORT_LOGS },
    { route: '/api/extension-feedback', body, received_at: '2026-09-18T06:45:00.123Z' },
  );
  assert.equal(out.ok, true);
  assert.equal(out.omitted, 'payload_too_large');
  const recs = r2Records(REPORT_LOGS);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].record.omitted, 'payload_too_large');
  assert.equal('blob' in recs[0].record, false);
  assert.ok(recs[0].record.bytes > MAX_REPORT_LOG_BYTES);
  const planned = planReportLog({ route: '/api/extension-feedback', body });
  assert.equal(planned.truncated, true);
});

test('teeReportLog: R2 put 失败不抛', async () => {
  const REPORT_LOGS = mockR2({ failPut: true });
  const out = await teeReportLog(
    { REPORT_LOGS },
    { route: USAGE_PATH, body: { client_id: 'x' } },
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /R2 put failed/);
});

test('persistAcceptedReport: waitUntil 调度写入', async () => {
  const REPORT_LOGS = mockR2();
  const ctx = mockCtx();
  const res = await persistAcceptedReport(ctx, { REPORT_LOGS }, {
    route: '/api/extension-events',
    body: { event: 'install', client_id: 'cid-1' },
    received_at: '2026-09-18T06:45:00.123Z',
  });
  assert.equal(res.success, true);
  assert.equal(res.stored, true);
  assert.match(res.path, /^reports\/2026-09-18\/api-extension-events\//);
  await ctx.flush();
  const recs = r2Records(REPORT_LOGS);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].record.client_id, 'cid-1');
  assert.equal(recs[0].key, res.path);
});

test('POST /api/extension-usage：tee R2（保留 client_id）后代理 HF；不写 STATE', async () => {
  const REPORT_LOGS = mockR2();
  const STATE = mockState();
  const ctx = mockCtx();
  const origFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), init });
    return new Response(JSON.stringify({ success: true, from: 'hf' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const body = {
      extension: 'info-highlight',
      engine: 'local',
      outcome: 'ok',
      segments: 3,
      client_id: 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678',
    };
    const res = await worker.fetch(
      new Request('https://api.info-lens.app/api/extension-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { REPORT_LOGS, STATE, HF_ORIGIN: 'https://hf.example.test' },
      ctx,
    );
    await ctx.flush();
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.from, 'hf');
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].url, 'https://hf.example.test/api/extension-usage');
    const forwarded = JSON.parse(new TextDecoder().decode(fetched[0].init.body));
    assert.equal(forwarded.client_id, body.client_id);
    const recs = r2Records(REPORT_LOGS);
    assert.equal(recs.length, 1);
    assert.match(recs[0].key, /^reports\/\d{4}-\d{2}-\d{2}\/api-extension-usage\//);
    assert.equal(recs[0].record.client_id, body.client_id);
    assert.equal(recs[0].record.route, '/api/extension-usage');
    assert.match(recs[0].record.received_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(STATE.puts.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('POST /api/extension-usage：R2 失败仍返回代理响应', async () => {
  const REPORT_LOGS = mockR2({ failPut: true });
  const ctx = mockCtx();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, from: 'hf' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const res = await worker.fetch(
      new Request('https://example.test/api/extension-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extension: 'info-highlight', engine: 'local', outcome: 'ok', segments: 1 }),
      }),
      { REPORT_LOGS, HF_ORIGIN: 'https://hf.example.test' },
      ctx,
    );
    await ctx.flush();
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.from, 'hf');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('POST /api/extension-events：写 R2 保留 client_id，不写 STATE', async () => {
  const REPORT_LOGS = mockR2();
  const STATE = mockState();
  const ctx = mockCtx();
  const body = {
    event: 'install',
    version: '0.1.0',
    extension: 'info-highlight',
    client_id: 'A1B2C3D4-E5F6-4789-8ABC-DEF012345678',
  };
  const res = await worker.fetch(
    new Request('https://example.test/api/extension-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { REPORT_LOGS, STATE },
    ctx,
  );
  await ctx.flush();
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.stored, true);
  assert.equal(STATE.puts.length, 0);
  const recs = r2Records(REPORT_LOGS);
  assert.equal(recs.length, 1);
  assert.match(recs[0].key, /^reports\/\d{4}-\d{2}-\d{2}\/api-extension-events\//);
  assert.equal(recs[0].record.client_id, body.client_id);
  assert.equal(recs[0].record.event, 'install');
  assert.equal(recs[0].record.route, '/api/extension-events');
  assert.match(recs[0].record.received_at, /^\d{4}-\d{2}-\d{2}T/);
});
