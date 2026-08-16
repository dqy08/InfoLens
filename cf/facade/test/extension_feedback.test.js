import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipStr,
  clipObj,
  buildFeedbackRecord,
  feedbackKey,
  FEEDBACK_KEY_PREFIX,
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

test('clipObj: 限制深度与键数', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  const clipped = clipObj(deep, 2, 40);
  assert.deepEqual(clipped, { a: { b: { c: null } } });
  const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(clipObj(many, 1, 3)).length, 3);
});

test('buildFeedbackRecord: 裁剪并存储运行期诊断字段', () => {
  const rec = buildFeedbackRecord({
    status: { tone: 'error', label: 'Failed', detail: 'x', error_detail: 'stack' },
    page_url: 'https://example.com/a',
    query: 'q',
    config: { apiBase: 'https://api.info-lens.app' },
    progress: { matched_chunks: 1 },
    extension_version: '0.6.1',
    user_agent: 'Mozilla/5.0',
  });
  assert.equal(rec.status.tone, 'error');
  assert.equal(rec.status.error_detail, 'stack');
  assert.equal(rec.page_url, 'https://example.com/a');
  assert.equal(rec.extension_version, '0.6.1');
  assert.match(rec.saved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('feedbackKey: 更新的 ms 字典序更靠前', () => {
  const older = feedbackKey('aaaaaaaa', 1_000_000);
  const newer = feedbackKey('bbbbbbbb', 2_000_000);
  assert.ok(older.startsWith(FEEDBACK_KEY_PREFIX));
  assert.ok(newer < older);
});

test('handlePostExtensionFeedback: 空反馈不入库', async () => {
  const STATE = mockState();
  const empty = await handlePostExtensionFeedback(postReq({}), { STATE }, json);
  assert.equal(empty.body.stored, false);
  assert.equal(Object.keys(STATE.data).length, 0);

  const ok = await handlePostExtensionFeedback(
    postReq({ status: { tone: 'error', detail: 'boom' } }),
    { STATE },
    json
  );
  assert.equal(ok.body.stored, true);
  assert.equal(Object.keys(STATE.data).length, 1);
});

test('handleListExtensionFeedback: 支持 limit 与详情查询', async () => {
  const key = `${FEEDBACK_KEY_PREFIX}123:abc`;
  const STATE = mockState({
    [key]: JSON.stringify({ status: { detail: 'err' } }),
  });
  const listRes = await handleListExtensionFeedback(
    new Request('https://example.test/facade-extension-feedback?limit=10'),
    { STATE },
    json,
    () => null
  );
  assert.equal(listRes.body.count, 1);
  assert.equal(listRes.body.items[0].key, key);

  const getRes = await handleListExtensionFeedback(
    new Request(`https://example.test/facade-extension-feedback?key=${key}`),
    { STATE },
    json,
    () => null
  );
  assert.equal(getRes.body.ok, true);
  assert.equal(getRes.body.record.status.detail, 'err');
});
