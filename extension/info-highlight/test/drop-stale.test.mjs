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

test('扩展重载后的旧世界：有痕迹则 stale，拒绝再注入', () => {
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  const peek = bg.match(/async function pageCsPeek\(tabId, method\) \{[\s\S]*?\n\}/);
  assert.ok(peek, 'pageCsPeek missing');
  assert.match(peek[0], /data-ih-cs/);
  assert.match(peek[0], /il-pdf-entry/);
  assert.doesNotMatch(peek[0], /ih-progress-host/);
  assert.doesNotMatch(peek[0], /ih-token-0/);
  assert.match(peek[0], /demo\.isLive/);
  assert.match(bg, /pageCsPeek\(tab\.id, 'toggle'\)/);
  assert.match(bg, /peek\.state === 'live' && peek\.result/);
  assert.match(bg, /pageCsPeek\(tabId, 'start'\)/);
  assert.match(bg, /IL_pdfSw\.isPdfUrl\(url\)[\s\S]*pageCsPeek\(tab\.id\)/);
  assert.match(bg, /async function refuseStalePage\(tabId\)/);
  assert.match(bg, /alert\(msg\)/);
  assert.match(bg, /Another Info Highlight is already on this page/);
  assert.match(bg, /res\?\.ok === true/);
  const pdfHl = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
  assert.match(pdfHl, /if \(tab\?\.id !== message\.tabId\) return;/);
  assert.match(pdfHl, /sendResponse\(\{ ok: true \}\)/);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /setAttribute\('data-ih-cs'/);
  const entry = readFileSync(join(dir, '../../shared/pdf/entry.js'), 'utf8');
  assert.match(entry, /window\.__IH_PDF_ENTRY__/);
  assert.doesNotMatch(bg, /async function callPageApi/);
  assert.doesNotMatch(bg, /pageCsProbe/);
});
