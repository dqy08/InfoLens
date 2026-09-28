/**
 * 选项页自带高亮：分析走同一套后端、无悬停、实验开关。
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
  assert.match(html, /<nav class="side-nav"[\s\S]*?<main>[\s\S]*?id="ih_highlight_options_page"/);
  assert.match(html, /\.top \{[\s\S]*?position: sticky;/);
  assert.match(html, /\.side-nav \{[\s\S]*?position: sticky;/);
  assert.match(html, /\.side-nav a \{[\s\S]*?font-size: 16px;/);
  assert.match(html, /\.side-nav a\.nav-is-new::after/);
  assert.match(html, /\.side-nav a\[aria-current="true"\]/);
  assert.match(html, /padding: 8px 0 100vh/);
  const optJs = readFileSync(join(dir, '../options.js'), 'utf8');
  assert.match(optJs, /scrollIntoView\(\{ block: 'start' \}\)/);
  assert.match(optJs, /function syncNavCurrent/);
  assert.match(optJs, /setAttribute\('aria-current', 'true'\)/);
  assert.match(optJs, /addEventListener\('scroll', scheduleNavCurrent/);
  assert.match(html, /<section id="highlight">/);
  assert.match(html, /<section id="settings-restore">/);
  assert.match(html, /id="ih_highlight_options_page" checked>\s*<span data-i18n>Highlight this page to preview<\/span>/);
  assert.ok(html.indexOf('id="ih_highlight_options_page"') < html.indexOf('>Highlight</h2>'));
  assert.ok(html.indexOf('class="page-demo"') < html.indexOf('>Highlight</h2>'));
  assert.match(html, /\.page-demo \{[\s\S]*?justify-content: flex-end;/);
  assert.match(html, /\.page-demo \{[\s\S]*?font-size: 13px;/);
  assert.match(html, /id="ih_paint_style"/);
  assert.match(html, /id="ih_highlight_color"/);
  assert.match(html, /id="ih_text_swatches"/);
  assert.match(html, /id="ih_fade_min_pct"/);
  assert.match(html, /id="ih_fade_norm"/);
  assert.match(html, /Normalize scale/);
  assert.match(html, /Scale the highlight so the most surprising text is at full highlight\./);
  assert.match(html, /id="ih_fade_norm_pct"/);
  assert.match(html, /min="1" max="50"/);
  assert.match(html, /id="restore_recommended"/);
  assert.match(html, /Auto-analyze sites stay/);
  assert.doesNotMatch(html, /Normalize brightness/);
  assert.match(html, /id="ih_fade_value"/);
  assert.match(html, /data-option-id="ih_fade_min_pct"/);
  assert.match(html, /Minimum visibility/);
  assert.match(html, /How visible the least important text stays\./);
  assert.match(html, /ih-fade/);
  assert.match(html, /\.ih-paint-card\[data-style="fade"\]/);
  assert.match(html, /\.row\[hidden\] \{ display: none; \}/);
  assert.match(html, /class="ih-hue"/);
  assert.match(html, /ih-color-swatch-ink/);
  assert.match(html, /PDFs fall back to underline/);
  assert.doesNotMatch(html, /Ink for the text-color style/);
  assert.doesNotMatch(html, /How strong the highlight looks/);
  assert.doesNotMatch(html, /<select id="ih_paint_style"/);
  assert.match(html, /\.ih-paint-cards \{[\s\S]*?grid-template-columns: 1fr;/);
  assert.doesNotMatch(html, /grid-template-columns: 1fr 1fr 1fr/);
  assert.match(html, /\.ih-paint-demo \{[\s\S]*?font-size: 16px;/);
  assert.match(html, /button\.ih-paint-card \{[\s\S]*?border-color: transparent;/);
  assert.doesNotMatch(html, /<h2>Experimental<\/h2>/);
  assert.match(html, /Progress chart[\s\S]*class="experimental">Experimental/);
  assert.match(html, /One-tone highlight[\s\S]*class="experimental">Experimental/);
  assert.match(html, /Merge subwords[\s\S]*class="experimental">Experimental/);
  assert.match(html, /Not recommended/);
  const highlight = html.slice(html.indexOf('>Highlight</h2>'), html.indexOf('>Display</h2>'));
  assert.ok(highlight.indexOf('Highlight style') < highlight.indexOf('Highlight color'));
  assert.ok(highlight.indexOf('id="ih_highlight_color"') < highlight.indexOf('id="ih_text_swatches"'));
  assert.ok(highlight.indexOf('id="ih_text_swatches"') < highlight.indexOf('Highlight intensity'));
  assert.ok(highlight.indexOf('Highlight intensity') < highlight.indexOf('Minimum visibility'));
  assert.ok(highlight.indexOf('Minimum visibility') < highlight.indexOf('One-tone highlight'));
  const display = html.slice(html.indexOf('>Display</h2>'), html.indexOf('>Analysis</h2>'));
  assert.ok(display.indexOf('Progress chart') < display.indexOf('Merge subwords'));
  assert.match(html, /src="highlightStyle\.js"[\s\S]*?src="optionDefaults\.js"/);
  assert.match(html, /src="wordMerge\.js"/);
  assert.match(html, /src="auto-nudge\.js"/);
  assert.ok(html.indexOf('src="auto-nudge.js"') < html.indexOf('src="content.js"'));
  assert.match(html, /src="content\.js"/);
  assert.match(html, /src="options-page-flags\.js"/);
  assert.match(html, /href="content\.css"/);
  assert.doesNotMatch(html, /tokenTip\.js/);
  const catalog = readFileSync(join(dir, '../options-catalog.js'), 'utf8');
  assert.doesNotMatch(catalog, /ih_highlight_options_page/);
  assert.match(catalog, /'ih_word_merge'/);
  assert.match(catalog, /'ih_paint_style'/);
  assert.match(catalog, /'ih_highlight_color'/);
  assert.match(catalog, /'ih_fade_min_pct'/);
  assert.match(catalog, /'ih_fade_norm'/);
  assert.doesNotMatch(catalog, /ih_text_color/);
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
  const defs = readFileSync(join(dir, '../optionDefaults.js'), 'utf8');
  assert.match(defs, /ih_highlight_options_page: true/);
  assert.match(defs, /ih_word_merge: false/);
  assert.match(defs, /ih_article_only: false/);
  assert.match(opts, /IH_optionDefaults/);
  assert.doesNotMatch(opts, /ih_article_only: false/);
  assert.match(opts, /IH_optionsPageReady/);
  assert.match(opts, /COLOR_INK/);
  assert.match(opts, /Black \/ white/);
  assert.match(opts, /KEY_TEXT_COLOR/);
  assert.match(opts, /TEXT_COLOR_IDS/);
  assert.match(opts, /ih_highlight_color\.hidden/);
  assert.match(opts, /function syncPaintColorUi/);
  assert.match(opts, /ih-paint-card/);
  assert.match(opts, /PAINT_STYLES/);
  assert.match(opts, /\[' Highlight', 19\]/);
  assert.match(opts, /\[' yourself', 4\.29\]/);
  assert.match(opts, /function syncPaintDemo/);
  assert.match(opts, /tokenLevelFromBits/);
  assert.match(opts, /tokenLevelForFade/);
  assert.match(opts, /fadeOpacityForLevel/);
  assert.match(opts, /function syncFadeLabel/);
  assert.match(opts, /KEY_FADE_MIN_PCT/);
  assert.match(opts, /KEY_FADE_NORM/);
  assert.match(opts, /KEY_FADE_NORM_PCT/);
  assert.match(opts, /storage\.local\.remove/);
  assert.doesNotMatch(opts, /storage\.local\.set\(\{ \.\.\.HS\.STORAGE_DEFAULTS/);
  assert.match(opts, /restore_recommended/);
  assert.match(opts, /Auto-analyze sites stay/);
  assert.match(opts, /fadeNormScaleBits/);
  assert.match(opts, /syncDemoFadeScale/);
  assert.match(opts, /Fade unimportant/);
  assert.match(opts, /setAttribute\('aria-hidden', 'true'\)/);
  const collect = readFileSync(join(dir, '../../shared/page/collectTextMap.js'), 'utf8');
  assert.match(collect, /\[aria-hidden="true"\]/);
  assert.doesNotMatch(opts, /The more surprising a word is the stronger it looks/);
  assert.doesNotMatch(opts, /ih-paint-card-label/);
  assert.doesNotMatch(html, /ih-paint-card-label/);
  assert.match(html, /rgba\(var\(--ih-mark-rgb/);
  assert.match(html, /var\(--ih-block-max/);
  assert.match(html, /var\(--ih-line-max/);
  assert.match(html, /var\(--ih-ink-max/);
  assert.match(opts, /--ih-block-max/);
  assert.doesNotMatch(html, /data-option-id="ih_text_color"/);
  assert.doesNotMatch(html, /data-option-id="ih_highlight_color"[^>]*hidden/);
  assert.ok(opts.indexOf('for (const id of HS.COLOR_IDS)') < opts.indexOf("appendColorSwatch(HS.COLOR_INK"));
});

test('选项页抽字忽略只标主文；分析不单独指定后端', () => {
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  assert.match(pageMap, /IH_OPTIONS_PAGE \? false : articleOnly/);
  assert.match(pageMap, /color-mix\(in srgb-linear/);
  assert.match(pageMap, /highlightForFadeRange/);
  assert.match(pageMap, /--ih-fade-pct-/);
  const flags = readFileSync(join(dir, '../options-page-flags.js'), 'utf8');
  assert.match(flags, /IH_OPTIONS_PAGE = true/);
  assert.match(flags, /IL_TEXT_MAP_EXTRA_EXCLUDE \+= ', #cache_desc'/);
  assert.match(flags, /IH_tokenTip/);
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  assert.match(bg, /'wordMerge\.js'/);
  assert.doesNotMatch(bg, /isOwnOptionsPage/);
  assert.match(bg, /handleAnalyze\(text, !!msg\.skipCache, false, sender\.tab\?\.id, msg\.cloudModel\)/);
  assert.match(bg, /fetchTokensWithAutoFallback/);
  assert.match(bg, /st\.ready && st\.webgpuOk !== false \? 'local' : 'cloud'/);
  assert.match(bg, /if \(!forceCloud\) await maybeOfferInit\(\)/);
  assert.match(bg, /if \(!prepare\) \{[\s\S]*?st\.pref !== IH_localState\.PREF_LOCAL\) return;/);
  assert.match(bg, /maybeOfferInit\(true\)/);
  assert.match(bg, /if \(pref === IH_localState\.PREF_LOCAL\) \{[\s\S]*?probeAndStore\(\)/);
  assert.match(bg, /await IH_localState\.set\(\{ pref \}\);[\s\S]*?if \(pref === IH_localState\.PREF_LOCAL\) await maybeOfferInit\(\)/);
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  const optJs = readFileSync(join(dir, '../options.js'), 'utf8');
  assert.match(html, /<option value="local" disabled data-i18n>/);
  assert.match(optJs, /localOpt\.disabled = !webgpu/);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /function setEnabled\(on, trigger\)/);
  assert.match(content, /void runBatch\(gen \+= 1, false, false\)/);
  assert.match(content, /setEnabled\(\!\(busy \|\| active\), trigger\)/);
  assert.match(content, /lastTrigger = R\.normalizeUsageTrigger\(trigger\) \|\| 'other'/);
  assert.match(content, /lastTrigger = 'auto'/);
  assert.match(content, /lastTrigger = R\.normalizeUsageTrigger\(trigger\) \|\| 'rerun'/);
  const run = readFileSync(join(dir, '../analyzeRun.js'), 'utf8');
  assert.match(run, /if \(globalThis\.IH_OPTIONS_PAGE\) return;/);
  assert.match(run, /armCloudWait && !globalThis\.IH_OPTIONS_PAGE/);
});

test('升级且没存过高亮形式时提醒一次，Settings 打开高亮一节', () => {
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  assert.match(bg, /async function armFadeDefaultNotice\(details\)/);
  assert.match(bg, /details\.reason === 'install'/);
  assert.match(bg, /details\.reason === 'update'/);
  assert.match(bg, /ih_fade_default_notice/);
  assert.match(bg, /options\.html'\) \+ '#highlight'/);
  assert.match(pageMap, /The default style is now "Fade"\./);
  assert.match(pageMap, /textContent = tr\('OK'\)/);
  assert.match(pageMap, /textContent = tr\('Go to settings'\)/);
  assert.match(pageMap, /ih-open-highlight-options/);
  assert.match(pageMap, /if \(!opts\?\.overlay && stats\.painted > 0\) maybeShowFadeDefaultNotice\(\)/);
});

test('选项页 About 可以给作者留言', () => {
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  const optJs = readFileSync(join(dir, '../options.js'), 'utf8');
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  assert.match(html, /<a href="#about" data-i18n>About<\/a>/);
  assert.ok(html.indexOf('id="settings-restore"') < html.indexOf('id="about"'));
  assert.match(html, /<section id="about">/);
  assert.match(html, /Info Highlight is part of <a class="about-home" href="https:\/\/info-lens\.app\/" target="_blank" rel="noopener noreferrer">Info Lens<\/a>, a toolbox for exploring the informational nature of LLMs and language\./);
  assert.doesNotMatch(html, />Homepage</);
  assert.match(html, /<details class="about-feedback" id="about_feedback">\s*<summary data-i18n>Feedback<\/summary>/);
  assert.match(html, /We'd love to hear from you\. Please tell us anything you'd like\./);
  assert.match(optJs, /Thank you\. Your feedback helps us improve\./);
  assert.match(html, /https:\/\/info-lens\.app\//);
  assert.match(html, /id="about_contact"/);
  assert.match(html, /about-optional">optional</);
  assert.match(optJs, /type: 'ih-author-note'/);
  assert.match(bg, /msg\?\.type === 'ih-author-note'/);
  const fn = bg.slice(bg.indexOf('async function postAuthorNote'), bg.indexOf('async function postLocalInitReport'));
  assert.match(fn, /client_id/);
  assert.doesNotMatch(fn, /page_url/);
});
