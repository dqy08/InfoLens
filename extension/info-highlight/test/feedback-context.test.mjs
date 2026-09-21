import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));

function loadFeedbackContext() {
  globalThis.location = { href: 'https://example.com/article' };
  globalThis.navigator = { userAgent: 'test-ua' };
  runInThisContext(readFileSync(join(dir, '../feedbackContext.js'), 'utf8'), {
    filename: 'feedbackContext.js',
  });
  return globalThis.IH_feedbackContext;
}

test('stash：分段正文与 mapped 文本进入 debug', () => {
  const C = loadFeedbackContext();
  C.stash({
    surface: 'web',
    session: {
      next: 2,
      painted: 0,
      segs: [
        { start: 0, end: 3, text: 'abc' },
        { start: 3, end: 6, text: 'def' },
      ],
      mapped: { text: 'abcdef', pieces: [{}, {}] },
    },
    report: {
      outcome: 'failed',
      error: 'No tokens mapped onto the page',
      detail: { painted: 0, tokens_in: 4 },
      engine: 'cloud',
      model: 'm1',
    },
    err: new Error('No tokens mapped onto the page'),
  });
  const body = C.buildUserReport({ label: 'Failed', detail: 'Could not highlight' });
  assert.equal(body.page_url, 'https://example.com/article');
  assert.equal(body.extension, 'info-highlight');
  assert.equal(body.status.detail, 'Could not highlight');
  assert.match(body.status.error_detail, /engine=cloud/);
  assert.match(body.status.error_detail, /"painted":0/);
  assert.equal(body.debug.mapped_text, 'abcdef');
  assert.equal(body.debug.segments.length, 2);
  assert.equal(body.debug.segments[1].text, 'def');
  assert.equal(body.progress.segments_done, 2);
});

test('segmentsPayload：单段超长会截断', () => {
  const C = loadFeedbackContext();
  const long = 'x'.repeat(5000);
  const segs = C.segmentsPayload([{ start: 0, end: 5000, text: long }]);
  assert.equal(segs.length, 1);
  assert.ok(segs[0].text.length < 5000);
  assert.ok(segs[0].text.endsWith('…'));
});
