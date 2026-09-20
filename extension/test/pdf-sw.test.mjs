/**
 * shared/pdf 两半之间的契约：SW 半边（sw.js）对得上页内半边（entry.js / viewer.js）。
 * fork 出新插件时把 il- 前缀整体改名过一次，这两半就对不上了——点按钮直接失败、缩放后不重画。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const EXTENSIONS = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(EXTENSIONS + rel, 'utf8');

/** 在 SW 环境替身里跑 sw.js；stash 用空实现，只看消息路由与开页 */
function loadSw() {
  const opened = [];
  const sandbox = {
    console: { ...console, error: () => {} },
    crypto: webcrypto,
    URL,
    chrome: {
      runtime: { getURL: (p) => `chrome-extension://test/${p}` },
      tabs: { create: async (o) => opened.push(o.url) },
    },
    IL_pdfStashStartUpload: async () => {},
    IL_pdfStashAppendUploadChunk: async () => {},
    IL_pdfStashFinishUpload: async () => {},
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(read('shared/pdf/sw.js'), vm.createContext(sandbox));
  const send = (msg) =>
    new Promise((resolve) => {
      assert.equal(sandbox.IL_pdfSw.handleMessage(msg, {}, resolve), true, `未接管 ${msg.type}`);
    });
  return { sw: sandbox.IL_pdfSw, send, opened };
}

/** 某插件目录下自己写的 js（不含 vendor / 构建产物 / 依赖） */
function ownSources(dir) {
  const skip = new Set(['node_modules', 'dist', 'vendor', 'e2e', 'test']);
  let source = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !skip.has(entry.name)) source += ownSources(`${dir}/${entry.name}`);
    else if (entry.isFile() && entry.name.endsWith('.js')) source += readFileSync(`${dir}/${entry.name}`, 'utf8');
  }
  return source;
}

/** 与 build_extension.py 一致：有 manifest.json 的目录就是一个插件 */
function extensionDirs() {
  return readdirSync(EXTENSIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${EXTENSIONS}${e.name}/manifest.json`))
    .map((e) => `${EXTENSIONS}${e.name}`);
}

test('上传三步走完，开出带 stash id 的查看器', async () => {
  const { send, opened } = loadSw();
  const id = 'stash-id';
  for (const msg of [
    { type: 'il-pdf-upload-start', id, fileName: 'a.pdf' },
    { type: 'il-pdf-upload-chunk', id, index: 0, base64: 'JVBERg==', byteLength: 5 },
    { type: 'il-pdf-upload-finish', id, chunkCount: 1, byteLength: 5 },
  ]) {
    assert.equal((await send(msg)).ok, true, `${msg.type} 未成功`);
  }
  assert.deepEqual(opened, [`chrome-extension://test/pdf/viewer.html?id=${id}`]);
});

test('缺 id 时回错，不静默成功', async () => {
  const { send } = loadSw();
  const resp = await send({ type: 'il-pdf-upload-start' });
  assert.equal(resp.ok, false);
  assert.match(resp.error, /id missing/);
});

test('插件自己的消息不被接管', () => {
  const { sw } = loadSw();
  for (const type of ['ih-analyze', 'il-analyze-semantic', 'il-pdf-open-bar']) {
    assert.equal(sw.handleMessage({ type }, {}, () => {}), false, `${type} 被误接管`);
  }
});

test('entry.js 发出的每个消息类型，sw.js 都认', () => {
  const sw = read('shared/pdf/sw.js');
  const sent = new Set([...read('shared/pdf/entry.js').matchAll(/type: '(il-[\w-]+)'/g)].map((m) => m[1]));
  assert.ok(sent.size >= 4, `只从 entry.js 认出 ${sent.size} 个消息类型，正则可能失效了`);
  for (const type of sent) assert.ok(sw.includes(`'${type}'`), `sw.js 不认识 ${type}`);
});

test('viewer.js 派发的每个事件，每个插件都有人听', () => {
  const events = [...read('shared/pdf/viewer.js').matchAll(/CustomEvent\("(il-[\w-]+)"/g)].map((m) => m[1]);
  assert.ok(events.length >= 2, `只从 viewer.js 认出 ${events.length} 个事件，正则可能失效了`);
  for (const dir of extensionDirs()) {
    const source = ownSources(dir);
    for (const name of events) {
      assert.ok(source.includes(`'${name}'`), `${dir.split('/').pop()} 里没人监听 ${name}`);
    }
  }
});

test('IL_createPdfZoomIdle：连调只跑最后一次', async () => {
  const sandbox = {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => setTimeout(() => cb(0), 0),
    Node: { TEXT_NODE: 3 },
    window: {},
    document: { getElementById: () => null },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(read('shared/pdf/text-layer.js'), vm.createContext(sandbox));
  const idle = sandbox.IL_createPdfZoomIdle();
  const hits = [];
  idle.schedule(() => {
    hits.push(1);
  });
  idle.schedule(() => {
    hits.push(2);
  });
  await new Promise((r) => setTimeout(r, idle.IDLE_MS + 80));
  assert.deepEqual(hits, [2]);
  idle.cancel();
});
