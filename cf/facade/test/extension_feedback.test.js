import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipStr,
  clipObj,
  buildFeedbackRecord,
  feedbackKey,
  FEEDBACK_KEY_PREFIX,
  UNINSTALL_COUNT_PREFIX,
  handlePostExtensionFeedback,
  handleListExtensionFeedback,
} from '../src/extension_feedback.js';

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
  return new Request('https://example.test/api/extension-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('clipStr: 截断并加省略号', () => {
  assert.equal(clipStr('  ab  ', 10), 'ab');
  assert.equal(clipStr('abcdefghij', 5), 'abcd…');
  assert.equal(clipStr('', 10), null);
  assert.equal(clipStr(null, 10), null);
});

test('clipObj: 限制深度与键数（与后端同：depth 耗尽后嵌套为 null）', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  const clipped = clipObj(deep, 2, 40);
  assert.deepEqual(clipped, { a: { b: { c: null } } });
  const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(clipObj(many, 1, 3)).length, 3);
});

test('buildFeedbackRecord: 裁剪并对齐后端字段', () => {
  const rec = buildFeedbackRecord({
    status: { tone: 'error', label: 'Failed', detail: 'x', error_detail: 'stack' },
    page_url: 'https://example.com/a',
    query: 'q',
    config: { apiBase: 'https://api.info-lens.app' },
    progress: { matched_chunks: 1 },
    extension_version: '0.6.1',
    user_agent: 'Mozilla/5.0',
  });
  assert.equal(rec.source, 'extension');
  assert.equal(rec.status.tone, 'error');
  assert.equal(rec.status.error_detail, 'stack');
  assert.equal(rec.page_url, 'https://example.com/a');
  assert.equal(rec.extension_version, '0.6.1');
  assert.match(rec.saved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('buildFeedbackRecord: 卸载问卷只收白名单原因', () => {
  const rec = buildFeedbackRecord({
    source: 'uninstall',
    reasons: ['unused', 'bogus', 'unused', 'privacy'],
    comment: '  too noisy  ',
    extension_version: '0.6.5',
    user_agent: 'Mozilla/5.0',
  });
  assert.equal(rec.source, 'uninstall');
  assert.deepEqual(rec.reasons, ['unused', 'privacy']);
  assert.equal(rec.comment, 'too noisy');
  assert.equal(rec.status.tone, 'uninstall');
  assert.equal(rec.status.label, 'unused,privacy');
  assert.equal(rec.status.detail, 'too noisy');
  assert.equal(rec.status.error_detail, null);
  assert.equal(rec.extension_version, '0.6.5');
});

test('buildFeedbackRecord: 只有评论时不带空 reasons', () => {
  const rec = buildFeedbackRecord({ source: 'uninstall', comment: 'too slow' });
  assert.equal(rec.comment, 'too slow');
  assert.equal(rec.reasons, undefined);
});

test('feedbackKey: 更新的 ms 字典序更靠前', () => {
  const older = feedbackKey('aaaaaaaa', 1_000_000);
  const newer = feedbackKey('bbbbbbbb', 2_000_000);
  assert.ok(older.startsWith(FEEDBACK_KEY_PREFIX));
  assert.ok(newer < older);
});

test('handlePost: 卸载打开按版本加一，缺 version 拒收', async () => {
  const STATE = mockState();
  const denied = await handlePostExtensionFeedback(
    postReq({ source: 'uninstall_visit' }),
    { STATE },
    json
  );
  assert.equal(denied.status, 400);
  assert.equal(denied.body.success, false);

  const first = await handlePostExtensionFeedback(
    postReq({ source: 'uninstall_visit', version: '0.6.5' }),
    { STATE },
    json
  );
  const second = await handlePostExtensionFeedback(
    postReq({ source: 'uninstall_visit', version: '0.6.5' }),
    { STATE },
    json
  );
  assert.equal(first.body.count, 1);
  assert.equal(second.body.count, 2);
  assert.equal(STATE.data[`${UNINSTALL_COUNT_PREFIX}0.6.5`], '2');
});

test('handlePost: 空扩展 / 空卸载都不入库', async () => {
  const STATE = mockState();
  const ext = await handlePostExtensionFeedback(postReq({}), { STATE }, json);
  const un = await handlePostExtensionFeedback(
    postReq({ source: 'uninstall', reasons: [], comment: '  ' }),
    { STATE },
    json
  );
  assert.equal(ext.body.stored, false);
  assert.equal(un.body.stored, false);
  assert.equal(Object.keys(STATE.data).length, 0);
});

test('handleList: ?counts=1 只读卸载计数前缀', async () => {
  const STATE = mockState({
    [`${UNINSTALL_COUNT_PREFIX}0.6.5`]: '3',
    [`${FEEDBACK_KEY_PREFIX}x`]: '{}',
  });
  const res = await handleListExtensionFeedback(
    new Request('https://example.test/facade-extension-feedback?counts=1'),
    { STATE },
    json,
    () => null
  );
  assert.deepEqual(res.body, { ok: true, counts: { '0.6.5': 3 } });
});
