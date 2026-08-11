(() => {
  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
  const titleEl = document.getElementById('title');
  const leadEl = document.getElementById('lead');
  const stepsEl = document.getElementById('steps');
  const statusEl = document.getElementById('status');
  const btn = document.getElementById('primary-btn');
  const params = new URLSearchParams(location.search);
  const permissionRequestFailed = params.get('reason') === 'permission';
  const permissionRequestDetail = params.get('detail') || '';

  document.title = t('fileAccessPageTitle');

  function setSteps(keys) {
    stepsEl.replaceChildren();
    for (const key of keys) {
      const li = document.createElement('li');
      li.innerHTML = t(key);
      stepsEl.appendChild(li);
    }
  }

  async function hasFileToggle() {
    try {
      return await chrome.extension.isAllowedFileSchemeAccess();
    } catch (err) {
      console.warn('[InfoLens] isAllowedFileSchemeAccess failed', err);
      return false;
    }
  }

  async function refresh() {
    if (await hasFileToggle()) {
      if (permissionRequestFailed) {
        titleEl.textContent = t('fileAccessPermissionTitle');
        leadEl.textContent = t('fileAccessPermissionLead');
        setSteps(['fileAccessPermissionStep']);
        statusEl.textContent = permissionRequestDetail
          ? t('fileAccessPermissionDetail', permissionRequestDetail)
          : '';
        btn.textContent = t('fileAccessOpenDetails');
        btn.disabled = false;
        return;
      }
      titleEl.textContent = t('fileAccessReadyTitle');
      leadEl.textContent = t('fileAccessReadyLead');
      setSteps(['fileAccessReadyStep']);
      statusEl.textContent = '';
      btn.textContent = t('fileAccessDone');
      btn.disabled = true;
      return;
    }
    titleEl.textContent = t('fileAccessTitle');
    leadEl.textContent = t('fileAccessLead');
    setSteps(['fileAccessStep1', 'fileAccessStep2', 'fileAccessStep3']);
    statusEl.textContent = '';
    btn.textContent = t('fileAccessOpenDetails');
    btn.disabled = false;
  }

  btn.addEventListener('click', () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });

  // 用户从详情页开完开关回到本页时自动刷新状态
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  void refresh();
})();
