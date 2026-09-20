/**
 * highlightStyle：两档阈值、色阶 alpha、标签文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../highlightStyle.js'), 'utf8'), {
  filename: 'highlightStyle.js',
});
const HS = globalThis.IH_highlightStyle;

test('thresholdBits：100% = MAX bits，25% = 4.5', () => {
  assert.equal(HS.thresholdBits(100), HS.MAX_SURPRISAL_BITS);
  assert.equal(HS.thresholdBits(25), 4.5);
  assert.equal(HS.thresholdBits(0), 0);
});

test('formatThresholdLabel 淡化 bit、主展示百分比', () => {
  assert.equal(HS.formatThresholdLabel(50), '50% (9 bit)');
  assert.equal(HS.formatThresholdLabel(25), '25% (4.5 bit)');
});

test('多档 tokenLevel：低于 1 档跳过，高 surprisal 顶档', () => {
  const prefs = { twoTier: false, thresholdPct: 25 };
  assert.equal(HS.tokenLevelFromBits(0.5, prefs), -1);
  assert.equal(HS.tokenLevelFromBits(HS.MAX_SURPRISAL_BITS, prefs), HS.TOKEN_LEVELS - 1);
  // 刚过 1 档下沿：18/16 = 1.125
  assert.equal(HS.tokenLevelFromBits(1.2, prefs), 1);
});

test('两档：阈值上下 on/off，高亮固定顶档', () => {
  const prefs = { twoTier: true, thresholdPct: 50 };
  assert.equal(HS.tokenLevelFromBits(8.9, prefs), -1);
  assert.equal(HS.tokenLevelFromBits(9, prefs), HS.TOKEN_LEVELS - 1);
  assert.equal(HS.tokenLevelFromBits(18, prefs), HS.TOKEN_LEVELS - 1);
});

test('alpha 线性：多档按 level/16 * max；两档顶档 = max', () => {
  assert.equal(HS.alphaForLevel(8, 0.5, false), 0.25);
  assert.equal(HS.alphaForLevel(15, 0.5, false), (15 / 16) * 0.5);
  assert.equal(HS.alphaForLevel(15, 0.7, true), 0.7);
  assert.equal(HS.alphaForLevel(8, 0.7, true), 0);
});

test('depth ↔ maxAlpha：100% = PAINT_CAP[形式]', () => {
  assert.equal(HS.PAINT_CAP.block, 0.5);
  assert.equal(HS.PAINT_CAP.underline, 1);
  assert.equal(HS.depthToMaxAlpha(100), 0.5);
  assert.equal(HS.depthToMaxAlpha(50), 0.25);
  assert.equal(HS.depthToMaxAlpha(100, 'underline'), 1);
  assert.equal(HS.depthToMaxAlpha(50, 'underline'), 0.5);
  assert.equal(HS.clampMaxAlphaDepth(1), HS.INTENSITY_MIN);
  assert.equal(HS.clampMaxAlphaDepth(200), HS.INTENSITY_MAX);
  assert.equal(HS.clampThresholdPct(-3), 0);
  assert.equal(HS.clampThresholdPct(150), 100);
});

test('depthToMaxAlpha：深色整套 α × DARK_ALPHA_SCALE', () => {
  const prev = globalThis.matchMedia;
  globalThis.matchMedia = (q) => ({
    matches: String(q).includes('prefers-color-scheme: dark'),
    addEventListener() {},
  });
  try {
    assert.equal(HS.DARK_ALPHA_SCALE, 0.8);
    assert.equal(HS.depthToMaxAlpha(100), 0.4);
    assert.equal(HS.depthToMaxAlpha(50), 0.2);
    assert.equal(HS.depthToMaxAlpha(100, 'underline'), 0.8);
    assert.equal(HS.depthToMaxAlpha(100, 'block', 'pdf'), 1);
    assert.equal(HS.depthToMaxAlpha(100, 'underline', 'pdf'), 1);
    assert.equal(HS.depthToMaxAlpha(100, 'block', 'web'), 0.4);
  } finally {
    if (prev === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prev;
  }
});

test('normalizePrefs 填默认', () => {
  const p = HS.normalizePrefs({});
  assert.equal(p.twoTier, false);
  assert.equal(p.thresholdPct, 25);
  assert.equal(p.maxAlphaDepth, 100);
  assert.equal(p.paintStyle, HS.PAINT_BLOCK);
});

test('normalizePaintStyle：未知值回块', () => {
  assert.equal(HS.normalizePaintStyle('underline'), HS.PAINT_UNDERLINE);
  assert.equal(HS.normalizePaintStyle('block'), HS.PAINT_BLOCK);
  assert.equal(HS.normalizePaintStyle('nope'), HS.PAINT_BLOCK);
});

test('resolvePaintStyle：PDF 色块回退下划线，网页不回退', () => {
  assert.equal(HS.resolvePaintStyle('block', 'pdf'), HS.PAINT_UNDERLINE);
  assert.equal(HS.resolvePaintStyle('underline', 'pdf'), HS.PAINT_UNDERLINE);
  assert.equal(HS.resolvePaintStyle('block', 'web'), HS.PAINT_BLOCK);
  assert.equal(HS.resolvePaintStyle('underline', 'web'), HS.PAINT_UNDERLINE);
  assert.equal(HS.depthToMaxAlpha(100, 'block', 'pdf'), HS.PAINT_CAP.underline);
  assert.equal(HS.depthToMaxAlpha(100, 'block', 'web'), HS.PAINT_CAP.block);
});

test('applyCssVars：下划线透明底、block 写底色；100% 各用自己的 cap', () => {
  const props = {};
  const root = { style: { setProperty(k, v) { props[k] = v; } } };
  HS.applyCssVars(root, { twoTier: false, maxAlphaDepth: 100, paintStyle: 'underline' });
  assert.equal(props['--ih-paint-deco'], 'underline');
  assert.equal(props['--ih-token-bg-8'], 'transparent');
  assert.equal(props['--ih-token-8'], `rgba(${HS.SURPRISAL_RED_RGB}, 0.5)`);
  HS.applyCssVars(root, { twoTier: false, maxAlphaDepth: 100, paintStyle: 'block' });
  assert.equal(props['--ih-paint-deco'], 'none');
  assert.equal(props['--ih-token-bg-8'], props['--ih-token-8']);
  assert.equal(props['--ih-token-8'], `rgba(${HS.SURPRISAL_RED_RGB}, 0.25)`);
  assert.equal(props['--ih-underline-thickness'], '12.5%');
  assert.equal(props['--ih-underline-offset'], '18.75%');
});

test('underlineOverlayBox：16px 字盒 = 2px 粗、再上移 1px', () => {
  const box = HS.underlineOverlayBox(
    { left: 10, bottom: 50, width: 40, height: 16 },
    { left: 0, top: 0 },
  );
  assert.equal(box.height, 2);
  assert.equal(box.width, 40);
  assert.equal(box.x, 10);
  assert.equal(box.y, 47);
});
