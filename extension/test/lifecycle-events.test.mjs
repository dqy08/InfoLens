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
    assert.match(bg, /IL_prepareClientIdReporting\(EXTENSION_ID/, `${name} 未设卸载 URL`);
    assert.match(bg, /IL_reportInstallOrUpdate\(details, EXTENSION_ID/, `${name} 未上报 install/update`);
    assert.match(bg, new RegExp(`EXTENSION_ID\\s*=\\s*'${name}'`), `${name} EXTENSION_ID 应对齐目录名`);
  }
});

test('IL_setUninstallSurveyUrl / IL_reportInstallOrUpdate 带 ext、extension 与 client_id', async () => {
  const calls = { uninstall: [], fetch: [] };
  const sandbox = {
    chrome: {
      runtime: {
        getManifest: () => ({ version: '0.1.0' }),
        setUninstallURL: (url) => calls.uninstall.push(url),
        lastError: undefined,
      },
      storage: {
        local: {
          get: (_keys, cb) => queueMicrotask(() => cb({})),
          set: (_obj, cb) => queueMicrotask(() => cb()),
        },
      },
    },
    crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    fetch: (url, opts) => {
      calls.fetch.push({ url, body: opts.body ? JSON.parse(opts.body) : null, credentials: opts.credentials });
      if (String(url).includes('/api/client-id')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            client_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          }),
        });
      }
      return Promise.resolve();
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(`${ROOT}shared/sw/client-id.js`, 'utf8'), ctx);
  vm.runInContext(readFileSync(`${ROOT}shared/sw/lifecycle-events.js`, 'utf8'), ctx);

  sandbox.IL_setUninstallSurveyUrl('info-highlight', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(
    calls.uninstall[0],
    'https://info-lens.app/uninstall.html?v=0.1.0&ext=info-highlight&cid=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  );

  sandbox.IL_reportInstallOrUpdate({ reason: 'install' }, 'info-highlight');
  await new Promise((r) => setTimeout(r, 20));
  const ev = calls.fetch.find((c) => c.url.includes('/api/extension-events'));
  assert.ok(ev);
  assert.deepEqual(ev.body, {
    event: 'install',
    version: '0.1.0',
    extension: 'info-highlight',
    client_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  });

  sandbox.IL_reportInstallOrUpdate(
    { reason: 'update', previousVersion: '0.0.9' },
    'semantic-highlight',
  );
  await new Promise((r) => setTimeout(r, 20));
  const upd = calls.fetch.filter((c) => c.url.includes('/api/extension-events')).at(-1);
  assert.equal(upd.body.extension, 'semantic-highlight');
  assert.equal(upd.body.previous_version, '0.0.9');
  assert.equal(upd.body.client_id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
});
