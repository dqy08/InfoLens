import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../cloudWait.js'), 'utf8'), { filename: 'cloudWait.js' });

const wait = globalThis.IH_cloudWait;

test('冷启动条', () => {
  assert.deepEqual(wait.status(), { label: 'Cold starting .', detail: '' });
  assert.deepEqual(wait.status(1), { label: 'Cold starting ..', detail: '' });
  assert.deepEqual(wait.status(2), { label: 'Cold starting ...', detail: '' });
  assert.equal(wait.FIRST_SEGMENT_WAIT_MS, 2000);
  assert.equal(wait.DOT_INTERVAL_MS, 400);
});
