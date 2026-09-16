/**
 * 两边插件共用安装/卸载流水：引入共享脚本，并上报带 extension 的事件。
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

test('每个插件都引入 lifecycle-events，并上报本插件 extension', () => {
  for (const name of plugins()) {
    const bg = readFileSync(`${ROOT}${name}/background.js`, 'utf8');
    assert.match(bg, /importScripts\('sw\/lifecycle-events\.js'\)/, `${name} 未引入 lifecycle-events`);
    assert.match(bg, /IL_setUninstallSurveyUrl\(EXTENSION_ID\)/, `${name} 未设卸载 URL`);
    assert.match(bg, /IL_reportInstallOrUpdate\(details, EXTENSION_ID/, `${name} 未上报 install/update`);
    assert.match(bg, new RegExp(`EXTENSION_ID\\s*=\\s*'${name}'`), `${name} EXTENSION_ID 应对齐目录名`);
  }
});

test('IL_setUninstallSurveyUrl / IL_reportInstallOrUpdate 带 ext 与 extension', () => {
  const calls = { uninstall: [], fetch: [] };
  const sandbox = {
    chrome: {
      runtime: {
        getManifest: () => ({ version: '0.1.0' }),
        setUninstallURL: (url) => calls.uninstall.push(url),
      },
    },
    fetch: (url, opts) => {
      calls.fetch.push({ url, body: JSON.parse(opts.body) });
      return Promise.resolve();
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(readFileSync(`${ROOT}shared/sw/lifecycle-events.js`, 'utf8'), vm.createContext(sandbox));

  sandbox.IL_setUninstallSurveyUrl('info-highlight');
  assert.equal(
    calls.uninstall[0],
    'https://info-lens.app/uninstall.html?v=0.1.0&ext=info-highlight'
  );

  sandbox.IL_reportInstallOrUpdate({ reason: 'install' }, 'info-highlight', 'https://api.example');
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, 'https://api.example/api/extension-events');
  assert.deepEqual(calls.fetch[0].body, {
    event: 'install',
    version: '0.1.0',
    extension: 'info-highlight',
  });

  sandbox.IL_reportInstallOrUpdate(
    { reason: 'update', previousVersion: '0.0.9' },
    'semantic-highlight',
    'https://api.example'
  );
  assert.equal(calls.fetch[1].body.extension, 'semantic-highlight');
  assert.equal(calls.fetch[1].body.previous_version, '0.0.9');

  assert.equal(sandbox.IL_reportsEnabled(undefined), true);
  assert.equal(sandbox.IL_reportsEnabled({ reportUsage: true }), true);
  assert.equal(sandbox.IL_reportsEnabled({ reportUsage: false }), false);
});
