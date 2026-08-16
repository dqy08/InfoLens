import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNINSTALL_SURVEY_KEY_PREFIX,
  buildUninstallSurveyRecord,
  uninstallSurveyKey,
  handlePostUninstallSurvey,
  handleListUninstallSurveys,
} from '../src/extension_uninstall_survey.js';

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
  return new Request('https://example.test/api/extension-uninstall-survey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('buildUninstallSurveyRecord: 卸载问卷只收白名单原因与评论', () => {
  const rec = buildUninstallSurveyRecord({
    reasons: ['unused', 'bogus', 'unused', 'privacy'],
    comment: '  too noisy  ',
    version: '0.6.5',
    user_agent: 'Mozilla/5.0',
  });
  assert.deepEqual(rec.reasons, ['unused', 'privacy']);
  assert.equal(rec.comment, 'too noisy');
  assert.equal(rec.extension_version, '0.6.5');
  assert.match(rec.saved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('uninstallSurveyKey: 倒序排序前缀正确', () => {
  const older = uninstallSurveyKey('aaaaaaaa', 1_000_000);
  const newer = uninstallSurveyKey('bbbbbbbb', 2_000_000);
  assert.ok(older.startsWith(UNINSTALL_SURVEY_KEY_PREFIX));
  assert.ok(newer < older);
});

test('handlePostUninstallSurvey: 空内容不入库', async () => {
  const STATE = mockState();
  const empty = await handlePostUninstallSurvey(
    postReq({ reasons: [], comment: '  ' }),
    { STATE },
    json
  );
  assert.equal(empty.body.stored, false);
  assert.equal(Object.keys(STATE.data).length, 0);

  const filled = await handlePostUninstallSurvey(
    postReq({ reasons: ['slow_or_fail'], comment: 'failed on arxiv' }),
    { STATE },
    json
  );
  assert.equal(filled.body.stored, true);
  assert.equal(Object.keys(STATE.data).length, 1);
});

test('handleListUninstallSurveys: 读取列表与详情', async () => {
  const key = `${UNINSTALL_SURVEY_KEY_PREFIX}123:abc`;
  const STATE = mockState({
    [key]: JSON.stringify({ reasons: ['unused'], comment: 'bye' }),
  });

  const listRes = await handleListUninstallSurveys(
    new Request('https://example.test/facade-extension-uninstall-survey?limit=10'),
    { STATE },
    json,
    () => null
  );
  assert.equal(listRes.body.count, 1);
  assert.equal(listRes.body.items[0].key, key);

  const getRes = await handleListUninstallSurveys(
    new Request(`https://example.test/facade-extension-uninstall-survey?key=${key}`),
    { STATE },
    json,
    () => null
  );
  assert.equal(getRes.body.ok, true);
  assert.equal(getRes.body.record.comment, 'bye');
});
