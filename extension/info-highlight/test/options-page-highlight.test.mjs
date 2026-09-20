/**
 * 选项页自带高亮：云端、无悬停、实验开关。
 * 运行：node --test extension/info-highlight/test/options-page-highlight.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

test('选项页挂网页管线，无 tokenTip，实验项默认开', () => {
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  assert.match(html, /id="ih_highlight_options_page"/);
  assert.match(html, /<h2>Experimental<\/h2>/);
  assert.match(html, /src="content\.js"/);
  assert.match(html, /src="options-page-flags\.js"/);
  assert.match(html, /href="content\.css"/);
  assert.doesNotMatch(html, /tokenTip\.js/);
  const catalog = readFileSync(join(dir, '../options-catalog.js'), 'utf8');
  assert.match(catalog, /'ih_highlight_options_page'/);
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_highlight_options_page/,
  );
  const opts = readFileSync(join(dir, '../options.js'), 'utf8');
  assert.match(opts, /ih_highlight_options_page: true/);
  assert.match(opts, /IH_optionsPageReady/);
});

test('选项页抽字忽略只标主文；分析强制云端', () => {
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  assert.match(pageMap, /IH_OPTIONS_PAGE \? false : articleOnly/);
  const flags = readFileSync(join(dir, '../options-page-flags.js'), 'utf8');
  assert.match(flags, /IH_OPTIONS_PAGE = true/);
  assert.match(flags, /IH_tokenTip/);
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  assert.match(bg, /function isOwnOptionsPage\(sender\)/);
  assert.match(bg, /handleAnalyze\(text, !!msg\.skipCache, isOwnOptionsPage\(sender\)\)/);
  assert.match(bg, /const engine = forceCloud \? 'cloud' : engineFrom\(st\)/);
  assert.match(bg, /if \(!forceCloud\) await maybeOfferInit\(\)/);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /function setEnabled\(on\)/);
  assert.match(content, /void runBatch\(gen \+= 1, false, false\)/);
  assert.match(content, /setEnabled\(\!\(busy \|\| active\)\)/);
  const run = readFileSync(join(dir, '../analyzeRun.js'), 'utf8');
  assert.match(run, /if \(globalThis\.IH_OPTIONS_PAGE\) return;/);
});
