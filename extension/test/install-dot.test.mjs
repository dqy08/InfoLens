/**
 * 两边插件共用安装打点：都得引入共享脚本，都得有 16/32 打点图。
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

function load(manifest) {
  const calls = [];
  const sandbox = {
    chrome: {
      runtime: { getManifest: () => manifest },
      action: { setIcon: (opts) => calls.push({ path: { ...opts.path } }) },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(readFileSync(`${ROOT}shared/sw/install-dot.js`, 'utf8'), vm.createContext(sandbox));
  return { sandbox, calls };
}

test('每个插件都引入安装打点，且有 16/32 -dot 图标', () => {
  for (const name of plugins()) {
    const bg = readFileSync(`${ROOT}${name}/background.js`, 'utf8');
    assert.match(bg, /importScripts\('sw\/install-dot\.js'\)/, `${name} 未引入 install-dot`);
    assert.match(bg, /IL_maybeShowInstallDot\(details\)/, `${name} 安装时未打点`);
    assert.match(bg, /IL_setActionIconDotted\(false\)/, `${name} 点击后未清点`);
    for (const file of ['icon16-dot.png', 'icon32-dot.png']) {
      assert.ok(existsSync(`${ROOT}${name}/icons/${file}`), `${name} 缺 ${file}`);
    }
  }
});

test('商店仅新安装打点；unpacked 的 Reload 也打', () => {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
  const dotted = { 16: 'icons/icon16-dot.png', 32: 'icons/icon32-dot.png' };

  const store = load({ action: { default_icon: icons }, update_url: 'https://example' });
  store.sandbox.IL_maybeShowInstallDot({ reason: 'install' });
  store.sandbox.IL_maybeShowInstallDot({ reason: 'update' });
  assert.deepEqual(store.calls, [{ path: dotted }]);

  const unpacked = load({ action: { default_icon: icons } });
  unpacked.sandbox.IL_maybeShowInstallDot({ reason: 'update' });
  unpacked.sandbox.IL_setActionIconDotted(false);
  assert.deepEqual(unpacked.calls, [{ path: dotted }, { path: icons }]);
});
