/**
 * init popup 夹到宿主窗口：无 system.display。运行：
 * node --test extension/info-highlight/test/init-window-bounds.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../init-window-bounds.js'), 'utf8'), {
  filename: 'init-window-bounds.js',
});
const B = globalThis.IH_initWindowBounds;
const WIDTH = 540;
const HEIGHT = 420;

test('centered inside large host', () => {
  const host = { left: 100, top: 50, width: 1920, height: 1080 };
  const pos = B.clampPopupToHost(host, WIDTH, HEIGHT);
  assert.deepEqual(pos, {
    left: Math.round(100 + (1920 - WIDTH) / 2),
    top: Math.round(50 + (1080 - HEIGHT) / 2),
  });
});

test('host smaller than popup pins to host.left/top', () => {
  const host = { left: 10, top: 20, width: 200, height: 100 };
  assert.deepEqual(B.clampPopupToHost(host, WIDTH, HEIGHT), { left: 10, top: 20 });
});

test('negative host.left/top still centers on that host', () => {
  const host = { left: -1920, top: -40, width: 1920, height: 1080 };
  const pos = B.clampPopupToHost(host, WIDTH, HEIGHT);
  assert.deepEqual(pos, {
    left: Math.round(-1920 + (1920 - WIDTH) / 2),
    top: Math.round(-40 + (1080 - HEIGHT) / 2),
  });
});

test('omit when host missing or invalid', () => {
  assert.equal(B.clampPopupToHost(null, WIDTH, HEIGHT), null);
  assert.equal(B.clampPopupToHost(undefined, WIDTH, HEIGHT), null);
  assert.equal(B.clampPopupToHost({}, WIDTH, HEIGHT), null);
  assert.equal(B.clampPopupToHost({ left: 0, top: 0, width: 0, height: 800 }, WIDTH, HEIGHT), null);
  assert.equal(B.clampPopupToHost({ left: 0, top: 0, width: 800, height: NaN }, WIDTH, HEIGHT), null);
});

test('isBoundsError matches Chrome ≥50% messages', () => {
  const yes = [
    new Error('Invalid value for bounds. Bounds must be at least 50% onscreen.'),
    'Bounds must be 50% on a screen',
    'Window bounds must be 50 % within a screen',
  ];
  for (const err of yes) assert.equal(B.isBoundsError(err), true, String(err));
  const no = [
    '',
    new Error('Init window create returned no id'),
    'No window with id: 12',
    'Invalid bounds size',
    'Must be 50% visible',
  ];
  for (const err of no) assert.equal(B.isBoundsError(err), false, String(err));
});
