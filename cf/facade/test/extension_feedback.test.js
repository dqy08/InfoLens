import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipStr,
  clipObj,
  buildFeedbackRecord,
  feedbackKey,
  FEEDBACK_KEY_PREFIX,
} from '../src/extension_feedback.js';

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

test('feedbackKey: 更新的 ms 字典序更靠前', () => {
  const older = feedbackKey('aaaaaaaa', 1_000_000);
  const newer = feedbackKey('bbbbbbbb', 2_000_000);
  assert.ok(older.startsWith(FEEDBACK_KEY_PREFIX));
  assert.ok(newer < older);
});
