/**
 * 工具栏蓝点（安装/升级亮、点击灭）+ 选项未看提示：catalog 与 HTML 对齐。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function plugins() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${ROOT}${e.name}/manifest.json`))
    .map((e) => e.name);
}

function loadAttention(manifest, storage = {}, extras = {}) {
  const calls = [];
  const bag = { ...storage };
  const sandbox = {
    chrome: {
      runtime: { getManifest: () => manifest },
      action: { setIcon: (opts) => calls.push({ path: { ...opts.path } }) },
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            for (const k of Array.isArray(keys) ? keys : [keys]) {
              if (k in bag) out[k] = bag[k];
            }
            return out;
          },
          set: async (obj) => {
            Object.assign(bag, obj);
          },
        },
      },
    },
    ...extras,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(`${ROOT}shared/sw/action-dot.js`, 'utf8'), ctx);
  vm.runInContext(readFileSync(`${ROOT}shared/options-attention.js`, 'utf8'), ctx);
  return { sandbox, calls, bag };
}

test('每个插件都接入蓝点链路，且有 16/32 -dot 图标', () => {
  for (const name of plugins()) {
    const bg = readFileSync(`${ROOT}${name}/background.js`, 'utf8');
    assert.match(bg, /importScripts\('sw\/action-dot\.js'\)/, `${name} 未引入 action-dot`);
    assert.match(bg, /importScripts\('options-attention\.js'\)/, `${name} 未引入 options-attention`);
    assert.match(bg, /importScripts\('options-catalog\.js'\)/, `${name} 未引入 options-catalog`);
    assert.match(bg, /IL_optionsAttention\.onInstalled\(details, IL_OPTIONS_CATALOG\)/, `${name} 安装未接入`);
    assert.match(bg, /IL_setActionIconDotted\(true\)/, `${name} 安装/升级未亮工具栏蓝点`);
    assert.match(bg, /IL_setActionIconDotted\(false\)/, `${name} 点击未灭工具栏蓝点`);
    assert.doesNotMatch(bg, /syncToolbar/, `${name} 不应在 SW 启动时同步工具栏`);
    const html = readFileSync(`${ROOT}${name}/options.html`, 'utf8');
    assert.match(html, /options-new-dots\.css/, `${name} 选项页缺蓝点样式`);
    assert.match(html, /options-new-dots\.js/, `${name} 选项页缺蓝点脚本`);
    for (const file of ['icon16-dot.png', 'icon32-dot.png']) {
      assert.ok(existsSync(`${ROOT}${name}/icons/${file}`), `${name} 缺 ${file}`);
    }
  }
});

test('catalog / SEED_SEEN 与选项页 data-option-id 对齐', () => {
  for (const name of plugins()) {
    const sandbox = { globalThis: {} };
    sandbox.globalThis = sandbox;
    vm.runInContext(readFileSync(`${ROOT}${name}/options-catalog.js`, 'utf8'), vm.createContext(sandbox));
    const catalog = sandbox.IL_OPTIONS_CATALOG;
    const seed = sandbox.IL_OPTIONS_SEED_SEEN;
    assert.ok(Array.isArray(catalog) && catalog.length > 0, `${name} catalog 空`);
    assert.ok(Array.isArray(seed), `${name} 缺 IL_OPTIONS_SEED_SEEN`);
    const html = readFileSync(`${ROOT}${name}/options.html`, 'utf8');
    for (const id of catalog) {
      assert.match(html, new RegExp(`data-option-id="${id}"`), `${name} 缺 data-option-id=${id}`);
    }
    for (const id of seed) {
      assert.ok(catalog.includes(id), `${name} SEED_SEEN 含不在 catalog 的 ${id}`);
    }
  }
});

test('Info Highlight 本版：升级后 intensity / one-tone / auto-sites 为新；工具栏与选项解耦', async () => {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
  const catSandbox = { globalThis: {} };
  catSandbox.globalThis = catSandbox;
  vm.runInContext(
    readFileSync(`${ROOT}info-highlight/options-catalog.js`, 'utf8'),
    vm.createContext(catSandbox),
  );
  const catalog = [...catSandbox.IL_OPTIONS_CATALOG];
  const seed = [...catSandbox.IL_OPTIONS_SEED_SEEN];
  assert.ok(seed.includes('show_progress'));
  assert.ok(!seed.includes('ih_max_highlight_alpha'));
  assert.ok(!seed.includes('ih_two_tier'));
  assert.ok(!seed.includes('ih_auto_sites'));

  const env = loadAttention(
    { action: { default_icon: icons }, update_url: 'https://example' },
    {},
    { IL_OPTIONS_SEED_SEEN: seed },
  );
  await env.sandbox.IL_optionsAttention.onInstalled({ reason: 'update' }, catalog);
  assert.equal(env.bag.il_options_seen_ids.join(','), seed.join(','));
  assert.equal(env.calls.length, 0); // 选项播种不碰工具栏
  const unseen = await env.sandbox.IL_optionsAttention.unseen(catalog);
  assert.equal(unseen.slice().sort().join(','), 'ih_auto_sites,ih_max_highlight_alpha,ih_two_tier');
});

test('安装视全部为已看；升级无新项也不影响工具栏（由 background 直接打点）', async () => {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
  const dotted = { 16: 'icons/icon16-dot.png', 32: 'icons/icon32-dot.png' };
  const catalog = ['a', 'b'];

  const store = loadAttention({ action: { default_icon: icons }, update_url: 'https://example' });
  await store.sandbox.IL_optionsAttention.onInstalled({ reason: 'install' }, catalog);
  assert.equal(store.bag.il_options_seen_ids.join(','), 'a,b');
  assert.equal(store.calls.length, 0);

  store.sandbox.IL_setActionIconDotted(true);
  assert.deepEqual(store.calls.at(-1), { path: dotted });
  store.sandbox.IL_setActionIconDotted(false);
  assert.deepEqual(store.calls.at(-1), { path: icons });

  store.calls.length = 0;
  await store.sandbox.IL_optionsAttention.onInstalled({ reason: 'update' }, catalog);
  assert.equal(store.calls.length, 0);
  store.sandbox.IL_setActionIconDotted(true);
  assert.deepEqual(store.calls.at(-1), { path: dotted });
});

test('列未看项 / markSeen 不碰工具栏', async () => {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
  const env = loadAttention(
    { action: { default_icon: icons }, update_url: 'https://example' },
    { il_options_seen_ids: ['a'] },
  );
  const catalog = ['a', 'b'];
  const unseen = await env.sandbox.IL_optionsAttention.unseen(catalog);
  assert.equal(unseen.join(','), 'b');
  assert.equal(env.calls.length, 0);

  await env.sandbox.IL_optionsAttention.markSeen(['b'], catalog);
  assert.equal(env.bag.il_options_seen_ids.slice().sort().join(','), 'a,b');
  assert.equal(env.calls.length, 0);
});
