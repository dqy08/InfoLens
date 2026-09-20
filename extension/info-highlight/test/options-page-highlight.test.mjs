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

test('选项页挂网页管线，无 tokenTip，实验项标在所属组', () => {
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  assert.match(html, /<main>[\s\S]*?id="ih_highlight_options_page"/);
  assert.match(html, /id="ih_highlight_options_page">\s*Highlight this page to preview the highlight in real time\./);
  assert.doesNotMatch(html, /id="ih_highlight_options_page" checked/);
  assert.ok(html.indexOf('id="ih_highlight_options_page"') < html.indexOf('<h2>Highlight</h2>'));
  assert.ok(html.indexOf('class="page-demo"') < html.indexOf('<h2>Highlight</h2>'));
  assert.match(html, /id="ih_paint_style"/);
  assert.match(html, /id="ih_highlight_color"/);
  assert.match(html, /class="ih-hue"/);
  assert.match(html, /ih-color-swatch-ink/);
  assert.match(html, /How strong the highlight looks/);
  assert.match(html, /PDFs cannot use color blocks/);
  assert.doesNotMatch(html, /<h2>Experimental<\/h2>/);
  assert.match(html, /Progress chart[\s\S]*class="experimental">Experimental/);
  assert.match(html, /One-tone highlight[\s\S]*class="experimental">Experimental/);
  assert.match(html, /Merge subwords[\s\S]*class="experimental">Experimental/);
  assert.match(html, /Not recommended/);
  const highlight = html.slice(html.indexOf('<h2>Highlight</h2>'), html.indexOf('<h2>Display</h2>'));
  assert.ok(highlight.indexOf('Highlight style') < highlight.indexOf('Highlight color'));
  assert.ok(highlight.indexOf('Highlight color') < highlight.indexOf('Highlight intensity'));
  assert.ok(highlight.indexOf('Highlight intensity') < highlight.indexOf('One-tone highlight'));
  const display = html.slice(html.indexOf('<h2>Display</h2>'), html.indexOf('<h2>Analysis</h2>'));
  assert.ok(display.indexOf('Progress chart') < display.indexOf('Merge subwords'));
  assert.match(html, /src="wordMerge\.js"/);
  assert.match(html, /src="content\.js"/);
  assert.match(html, /src="options-page-flags\.js"/);
  assert.match(html, /href="content\.css"/);
  assert.doesNotMatch(html, /tokenTip\.js/);
  const catalog = readFileSync(join(dir, '../options-catalog.js'), 'utf8');
  assert.doesNotMatch(catalog, /ih_highlight_options_page/);
  assert.match(catalog, /'ih_word_merge'/);
  assert.match(catalog, /'ih_paint_style'/);
  assert.match(catalog, /'ih_highlight_color'/);
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_paint_style/,
  );
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_highlight_color/,
  );
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_highlight_options_page/,
  );
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_word_merge/,
  );
  const opts = readFileSync(join(dir, '../options.js'), 'utf8');
  assert.match(opts, /ih_highlight_options_page: false/);
  assert.match(opts, /ih_word_merge: false/);
  assert.match(opts, /IH_optionsPageReady/);
  assert.match(opts, /COLOR_INK/);
  assert.match(opts, /Black \/ white/);
  assert.match(opts, /ih_highlight_color\.hidden/);
  assert.ok(opts.indexOf('for (const id of HS.COLOR_IDS)') < opts.indexOf("appendColorSwatch(HS.COLOR_INK"));
});

test('选项页抽字忽略只标主文；分析强制云端', () => {
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  assert.match(pageMap, /IH_OPTIONS_PAGE \? false : articleOnly/);
  const flags = readFileSync(join(dir, '../options-page-flags.js'), 'utf8');
  assert.match(flags, /IH_OPTIONS_PAGE = true/);
  assert.match(flags, /IH_tokenTip/);
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  assert.match(bg, /'wordMerge\.js'/);
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
