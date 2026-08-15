import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { RELEVANCE_CACHE_VERSION } from '../src/relevance_remote_v2.js';
import { KEYWORDS_CACHE_VERSION } from '../src/keywords_remote_v2.js';

test('GET /api/v2/analyze-semantic-version 返回两个 epoch，不打上游', async () => {
  const res = await worker.fetch(
    new Request('https://example/api/v2/analyze-semantic-version'),
    {}
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.relevance, RELEVANCE_CACHE_VERSION);
  assert.equal(data.keywords, KEYWORDS_CACHE_VERSION);
});
