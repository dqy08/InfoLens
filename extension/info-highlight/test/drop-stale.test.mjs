/**
 * 扩展重载后旧页内 API 必须当成未注入。运行：node --test extension/info-highlight/test/drop-stale.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));

function pageApiUsable(api) {
  if (!api) return false;
  try {
    return typeof api.isLive === 'function' && !!api.isLive();
  } catch {
    return false;
  }
}

function loadDropStale() {
  runInThisContext(readFileSync(join(dir, '../drop-stale.js'), 'utf8'), {
    filename: 'drop-stale.js',
  });
}

test('没有 isLive 的旧 API 不可用（会回报 painted 的那种）', () => {
  assert.equal(pageApiUsable(undefined), false);
  assert.equal(pageApiUsable({ start: () => 'painted' }), false);
  assert.equal(
    pageApiUsable({
      isLive: () => {
        throw new Error('Extension context invalidated');
      },
      start: () => 'painted',
    }),
    false,
  );
  assert.equal(pageApiUsable({ isLive: () => false, start: () => 'painted' }), false);
  assert.equal(pageApiUsable({ isLive: () => true, start: () => 'painted' }), true);
});

test('drop-stale：活着的 API 留下', () => {
  globalThis.window = globalThis;
  window.__IH_DEMO__ = { isLive: () => true };
  globalThis.IH_analyzeRun = { keep: true };
  loadDropStale();
  assert.equal(window.__IH_DEMO__.isLive(), true);
  assert.equal(globalThis.IH_analyzeRun.keep, true);
  delete globalThis.window;
  delete globalThis.IH_analyzeRun;
});

test('drop-stale：无 isLive / 已作废则清掉全局', () => {
  globalThis.window = globalThis;
  window.__IH_DEMO__ = { start: () => 'painted' };
  globalThis.IH_analyzeRun = { keep: true };
  globalThis.IL_overlay = { keep: true };
  globalThis.IH_tokenTip = {
    keep: true,
    clear() {
      this.cleared = true;
    },
  };
  loadDropStale();
  assert.equal(window.__IH_DEMO__, undefined);
  assert.equal(globalThis.IH_analyzeRun, undefined);
  assert.equal(globalThis.IL_overlay, undefined);
  assert.equal(globalThis.IH_tokenTip, undefined);

  window.__IH_DEMO__ = {
    isLive: () => {
      throw new Error('Extension context invalidated');
    },
  };
  globalThis.IH_analyzeRun = { keep: true };
  loadDropStale();
  assert.equal(window.__IH_DEMO__, undefined);
  assert.equal(globalThis.IH_analyzeRun, undefined);
  delete globalThis.window;
});

test('callPageApi 在调 start 前先问 isLive', () => {
  const src = readFileSync(join(dir, '../background.js'), 'utf8');
  const fn = src.match(/async function callPageApi\(tabId, method\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'callPageApi missing');
  assert.match(fn[0], /api\.isLive/);
  assert.match(fn[0], /return false/);
});
