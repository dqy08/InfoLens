/**
 * Enter 省请求三条路。运行：node --test extension/test/enterSearchPlan.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, '../semantic/enterSearchPlan.js'), 'utf8');
const root = {};
root.globalThis = root;
new Function('globalThis', src)(root);
const { plan, shouldTrim } = root.IL_enterSearchPlan;

/** 全文已挖 0–31（码点 0–3200），全文长 20000，后面还能 Continue。 */
function snap(over = {}) {
  return {
    sameQuery: true,
    hasProgress: true,
    connected: true,
    startCp: 0,
    originCp: 0,
    analyzedEndCp: 3200,
    paintLength: 20000,
    hasMatchFromStart: false,
    canResume: true,
    ...over,
  };
}

test('全省：全文 0–31 已有匹配，再 Enter 全文 → skip', () => {
  assert.equal(plan(snap({ hasMatchFromStart: true })), 'skip');
});

test('全省：从 100 搜到 131，第 110 块匹配，视口仍在 100 → skip', () => {
  assert.equal(
    plan(
      snap({
        originCp: 10000,
        analyzedEndCp: 13100,
        startCp: 10000,
        hasMatchFromStart: true,
      })
    ),
    'skip'
  );
});

test('全省：从 100 挖尽无匹配，再从 100 Enter → skip 空操作', () => {
  assert.equal(
    plan(
      snap({
        originCp: 10000,
        analyzedEndCp: 20000,
        startCp: 10000,
        paintLength: 20000,
        hasMatchFromStart: false,
        canResume: false,
      })
    ),
    'skip'
  );
});

test('全省：起点已过文末 → skip 空操作', () => {
  assert.equal(plan(snap({ startCp: 20000 })), 'skip');
});

test('省前缀：全文 0–31 无匹配，再 Enter 全文 → resume 从 32', () => {
  assert.equal(plan(snap()), 'resume');
  assert.equal(shouldTrim(0, 0, 3200), false);
});

test('省前缀：100–131 无匹配，视口挪到 110 → resume，裁掉 100–109', () => {
  assert.equal(
    plan(
      snap({
        originCp: 10000,
        analyzedEndCp: 13100,
        startCp: 11000,
        hasMatchFromStart: false,
      })
    ),
    'resume'
  );
  assert.equal(shouldTrim(11000, 10000, 13100), true);
});

test('省前缀：视口贴在前沿（S = analyzedEnd）→ resume，不裁', () => {
  assert.equal(plan(snap({ startCp: 3200 })), 'resume');
  assert.equal(shouldTrim(3200, 0, 3200), false);
});

test('整段重开：从 100–131 搜过，改全文从 0 → fresh', () => {
  assert.equal(
    plan(
      snap({
        originCp: 10000,
        analyzedEndCp: 13100,
        startCp: 0,
        hasMatchFromStart: true,
      })
    ),
    'fresh'
  );
});

test('整段重开：已有 0–31，视口跳到 80（中间会留洞）→ fresh', () => {
  assert.equal(plan(snap({ startCp: 8000 })), 'fresh');
  assert.equal(shouldTrim(8000, 0, 3200), false);
});

test('整段重开：query 变了 / 尚无进度 / 未连上 → fresh', () => {
  assert.equal(plan(snap({ sameQuery: false, hasMatchFromStart: true })), 'fresh');
  assert.equal(plan(snap({ hasProgress: false })), 'fresh');
  assert.equal(plan(snap({ connected: false, hasMatchFromStart: true })), 'fresh');
});

test('交叉：0–31 有旧匹配，从 20 起这段没有 → resume（旧匹配不算本次命中）', () => {
  assert.equal(
    plan(
      snap({
        startCp: 2000,
        hasMatchFromStart: false,
        canResume: true,
      })
    ),
    'resume'
  );
  assert.equal(shouldTrim(2000, 0, 3200), true);
});
