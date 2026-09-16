/**
 * 安装/升级上报 + 卸载问卷 URL。
 * extensionId：semantic-highlight | info-highlight（与门面 body.extension 一致）。
 */
const IL_UNINSTALL_SURVEY_URL = 'https://info-lens.app/uninstall.html';

globalThis.IL_postKeepalive = function IL_postKeepalive(path, body, apiBase) {
  const base = String(apiBase || 'https://api.info-lens.app').replace(/\/$/, '');
  void fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  });
};

globalThis.IL_setUninstallSurveyUrl = function IL_setUninstallSurveyUrl(extensionId) {
  const version = chrome.runtime.getManifest().version;
  chrome.runtime.setUninstallURL(
    `${IL_UNINSTALL_SURVEY_URL}?v=${encodeURIComponent(version)}&ext=${encodeURIComponent(extensionId)}`
  );
};

globalThis.IL_reportInstallOrUpdate = function IL_reportInstallOrUpdate(details, extensionId, apiBase) {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  const body = {
    event: details.reason,
    version: chrome.runtime.getManifest().version,
    extension: extensionId,
  };
  if (details.reason === 'update' && details.previousVersion) {
    body.previous_version = details.previousVersion;
  }
  IL_postKeepalive('/api/extension-events', body, apiBase);
};
