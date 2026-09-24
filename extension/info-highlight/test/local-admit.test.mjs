/**
 * 藏页前的本机分析：同时只放行一条，多条在等时先当前窗口的激活标签。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, '../background.js'), 'utf8');
const start = src.indexOf('/** 已发出、还没进藏页的本机分析。');
const end = src.indexOf('function isOffscreenGone');
if (start < 0 || end < start) throw new Error('local admit block missing');

function loadAdmit() {
  const sandbox = {
    chrome: {
      tabs: {
        query() {
          return Promise.resolve([{ id: sandbox.activeTabId }]);
        },
      },
    },
    activeTabId: null,
  };
  runInNewContext(src.slice(start, end), sandbox, { filename: 'local-admit.js' });
  return sandbox;
}

test('有激活标签就挑它，否则挑最早的一条', () => {
  const sandbox = loadAdmit();
  const waiters = [{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }];
  assert.equal(sandbox.pickLocalWaiter(waiters, 2), 1);
  assert.equal(sandbox.pickLocalWaiter(waiters, 9), 0);
  assert.equal(sandbox.pickLocalWaiter(waiters, null), 0);
});

test('放行时先跑激活标签，上一条出错后下一条仍跑', async () => {
  const sandbox = loadAdmit();
  sandbox.activeTabId = 2;
  const order = [];
  const first = sandbox.runLocalAnalyze(1, async () => {
    order.push('bg');
    throw new Error('bg failed');
  });
  const second = sandbox.runLocalAnalyze(2, async () => {
    order.push('fg');
    return 'ok';
  });
  await assert.rejects(first, /bg failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(order, ['fg', 'bg']);
});

test('正在算的那条结束前，不放行下一条', async () => {
  const sandbox = loadAdmit();
  sandbox.activeTabId = 1;
  let release;
  const running = sandbox.runLocalAnalyze(1, () => new Promise((resolve) => {
    release = resolve;
  }));
  let started = false;
  const waiting = sandbox.runLocalAnalyze(2, async () => {
    started = true;
    return 'next';
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, false);
  release('done');
  assert.equal(await running, 'done');
  assert.equal(await waiting, 'next');
  assert.equal(started, true);
});
