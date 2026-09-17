/**
 * 安装/升级上报 + 卸载问卷 URL。
 * extensionId：semantic-highlight | info-highlight（与门面 body.extension 一致）。
 * 用量/事件可附带产品级匿名 client_id（见 client-id.js）。
 */
const IL_UNINSTALL_SURVEY_URL = 'https://info-lens.app/uninstall.html';

/** config.reportUsage === false 时跳过 install/update/用量等上报（dev 用）。缺省视为开启。 */
globalThis.IL_reportsEnabled = function IL_reportsEnabled(config) {
  return config?.reportUsage !== false;
};

globalThis.IL_postKeepalive = function IL_postKeepalive(path, body, apiBase) {
  const base = String(apiBase || 'https://api.info-lens.app').replace(/\/$/, '');
  void fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  });
};

/**
 * @param {string} extensionId
 * @param {string} [clientId]
 */
globalThis.IL_setUninstallSurveyUrl = function IL_setUninstallSurveyUrl(extensionId, clientId) {
  const version = chrome.runtime.getManifest().version;
  let url =
    `${IL_UNINSTALL_SURVEY_URL}?v=${encodeURIComponent(version)}` +
    `&ext=${encodeURIComponent(extensionId)}`;
  if (clientId) url += `&cid=${encodeURIComponent(clientId)}`;
  chrome.runtime.setUninstallURL(url);
};

globalThis.IL_reportInstallOrUpdate = function IL_reportInstallOrUpdate(
  details,
  extensionId,
  apiBase,
) {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  void (async () => {
    const body = {
      event: details.reason,
      version: chrome.runtime.getManifest().version,
      extension: extensionId,
    };
    if (details.reason === 'update' && details.previousVersion) {
      body.previous_version = details.previousVersion;
    }
    const clientId = await IL_getClientId(apiBase).catch(() => null);
    if (clientId) body.client_id = clientId;
    IL_postKeepalive('/api/extension-events', body, apiBase);
  })();
};

/** 启动时取 client_id 并写进卸载问卷 URL（重装后靠门面 Cookie 认回同一 id）。 */
globalThis.IL_prepareClientIdReporting = function IL_prepareClientIdReporting(
  extensionId,
  apiBase,
) {
  void IL_getClientId(apiBase)
    .catch(() => null)
    .then((cid) => IL_setUninstallSurveyUrl(extensionId, cid));
};
