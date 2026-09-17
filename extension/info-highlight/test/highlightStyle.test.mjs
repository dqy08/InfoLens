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

test('depth ↔ maxAlpha：100% 强度 = CAP_ALPHA 0.5', () => {
  assert.equal(HS.depthToMaxAlpha(100), 0.5);
  assert.equal(HS.depthToMaxAlpha(50), 0.25);
  assert.equal(HS.clampMaxAlphaDepth(1), HS.INTENSITY_MIN);
  assert.equal(HS.clampMaxAlphaDepth(200), HS.INTENSITY_MAX);
  assert.equal(HS.clampThresholdPct(-3), 0);
  assert.equal(HS.clampThresholdPct(150), 100);
});

test('normalizePrefs 填默认', () => {
  const p = HS.normalizePrefs({});
  assert.equal(p.twoTier, false);
  assert.equal(p.thresholdPct, 25);
  assert.equal(p.maxAlphaDepth, 100);
});
