(() => {
  const agreeBtn = document.getElementById('agree');
  const refuseBtn = document.getElementById('refuse');
  const hideBtn = document.getElementById('hide');
  const closeBtn = document.getElementById('close');
  const statusEl = document.getElementById('status');
  const bar = document.getElementById('bar');
  const leadEl = document.getElementById('lead');
  const hubSel = document.getElementById('model_hub');
  if (!agreeBtn || !refuseBtn || !hideBtn || !closeBtn || !statusEl || !bar || !leadEl || !hubSel) {
    throw new Error('init page missing required elements');
  }
  if (!globalThis.IH_localState) {
    throw new Error('IH_localState missing — inject state.js before init.js');
  }

  let localOnly = false;
  globalThis.IH_localState.get().then((st) => {
    localOnly = st.pref === globalThis.IH_localState.PREF_LOCAL;
    hubSel.value = globalThis.IH_localState.normalizeHub(st.hub);
    if (!localOnly) return;
    refuseBtn.textContent = '取消';
    leadEl.textContent =
      '你选择了仅本机分析，正文不会上传。首次需下载约 800 MB 权重（Gemma 3 270M q4），之后留在本机。';
  });

  hubSel.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'ih-local-set-hub', hub: hubSel.value }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        globalThis.IH_localState.get().then((st) => {
          hubSel.value = globalThis.IH_localState.normalizeHub(st.hub);
        });
      }
    });
  });

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function doneButtons() {
    agreeBtn.hidden = true;
    refuseBtn.hidden = true;
    hideBtn.hidden = true;
    closeBtn.hidden = false;
    bar.hidden = true;
  }

  function restoreActions() {
    agreeBtn.disabled = false;
    refuseBtn.disabled = false;
    hubSel.disabled = false;
    hideBtn.hidden = true;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function onProgress(info) {
    if (!info || typeof info !== 'object') return;
    const status = info.status;
    const file = info.file || info.name || '';
    if (status === 'progress' && Number.isFinite(info.loaded) && Number.isFinite(info.total) && info.total > 0) {
      bar.hidden = false;
      bar.max = info.total;
      bar.value = info.loaded;
      setStatus(`下载 ${file} · ${formatBytes(info.loaded)} / ${formatBytes(info.total)}`);
      return;
    }
    if (status === 'initiate' || status === 'download') {
      bar.hidden = false;
      bar.removeAttribute('value');
      setStatus(file ? `准备 ${file}` : '准备下载');
      return;
    }
    if (status === 'done') {
      setStatus(file ? `已获取 ${file}` : '下载完成');
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ih-local-progress') onProgress(msg.info);
  });

  agreeBtn.addEventListener('click', async () => {
    agreeBtn.disabled = true;
    refuseBtn.disabled = true;
    hubSel.disabled = true;
    setStatus('正在准备本机模型…');
    try {
      const granted = await chrome.permissions.request({
        origins: globalThis.IH_localState.hubOrigins(hubSel.value),
      });
      if (!granted) throw new Error('未授权下载本机模型');
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'ih-local-set-hub', hub: hubSel.value }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res?.ok) reject(new Error(res?.error || '切换下载源失败'));
          else resolve(res);
        });
      });
    } catch (err) {
      setStatus(err?.message || String(err));
      restoreActions();
      return;
    }
    hideBtn.hidden = false;
    chrome.runtime.sendMessage({ type: 'ih-local-agree' }, (res) => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message);
        restoreActions();
        return;
      }
      if (!res?.ok) {
        setStatus(res?.error || '初始化失败');
        restoreActions();
        return;
      }
      setStatus(
        localOnly
          ? '本机模型已就绪，可关闭此窗口。之后点工具栏只会在本机分析。'
          : '本机模型已就绪，可关闭此窗口。之后点工具栏会优先用本机分析。',
      );
      doneButtons();
    });
  });

  refuseBtn.addEventListener('click', () => {
    agreeBtn.disabled = true;
    refuseBtn.disabled = true;
    hubSel.disabled = true;
    chrome.runtime.sendMessage({ type: 'ih-local-refuse' }, () => {
      window.close();
    });
  });

  hideBtn.addEventListener('click', () => window.close());

  closeBtn.addEventListener('click', () => window.close());
})();
