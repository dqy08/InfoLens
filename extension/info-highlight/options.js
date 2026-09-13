(() => {
  if (!globalThis.IH_analyzeCache) {
    throw new Error('IH_analyzeCache missing — inject analyzeCache.js before options.js');
  }
  if (!globalThis.IH_localState) {
    throw new Error('IH_localState missing — inject state.js before options.js');
  }

  /** 复选框 id 即 chrome.storage.local 的键；值为默认值 */
  const TOGGLES = { show_progress: false, show_token_tip: true };

  const iconEl = document.getElementById('brand_icon');
  const brandEl = document.getElementById('brand_name');
  const descEl = document.getElementById('cache_desc');
  const clearBtn = document.getElementById('cache_clear');
  const webgpuDesc = document.getElementById('webgpu_desc');
  const modelDesc = document.getElementById('model_desc');
  const initBtn = document.getElementById('local_init');
  const modelClear = document.getElementById('model_clear');
  const prefSel = document.getElementById('analyze_pref');
  if (!iconEl || !brandEl || !descEl || !clearBtn || !webgpuDesc || !modelDesc || !initBtn || !modelClear || !prefSel) {
    throw new Error('options page missing required elements');
  }

  const manifest = chrome.runtime.getManifest();
  document.title = manifest.name;
  brandEl.textContent = manifest.name;
  iconEl.src = manifest.icons?.['48'] || manifest.icons?.['32'] || manifest.icons?.['128'] || '';

  for (const [key, fallback] of Object.entries(TOGGLES)) {
    const box = document.getElementById(key);
    if (!box) throw new Error(`options page missing checkbox: ${key}`);
    chrome.storage.local.get({ [key]: fallback }, (res) => {
      box.checked = !!res[key];
    });
    box.addEventListener('change', () => {
      chrome.storage.local.set({ [key]: box.checked });
    });
  }

  function modelStatusText(st, webgpu) {
    if (st.ready) return '已就绪（Gemma 3 270M）';
    if (webgpu) return '尚未准备（Gemma 3 270M）';
    return '这台电脑不能使用本机模型';
  }

  let modelCacheGen = 0;
  function applyBackend(st) {
    const webgpu = st.webgpuOk === true;
    webgpuDesc.textContent = webgpu
      ? '可用'
      : st.webgpuOk === false
        ? (st.pref === 'local' ? '不可用。已选仅本机，不会改去云端' : '不可用，将使用云端')
        : '尚未检测';
    const base = modelStatusText(st, webgpu);
    modelDesc.textContent = base;
    prefSel.value = st.pref === 'cloud' || st.pref === 'local' ? st.pref : 'auto';
    initBtn.disabled = !webgpu || !!st.ready;
    const gen = ++modelCacheGen;
    void globalThis.IH_localState.modelCacheUsage().then(({ bytes }) => {
      if (gen !== modelCacheGen) return;
      modelDesc.textContent = bytes > 0 ? `${base} · ${formatBytes(bytes)}` : base;
      modelClear.disabled = bytes === 0;
    }).catch(() => {
      if (gen !== modelCacheGen) return;
      modelClear.disabled = !st.ready;
    });
  }

  function loadBackend() {
    chrome.runtime.sendMessage({ type: 'ih-local-status' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        webgpuDesc.textContent = res?.error || chrome.runtime.lastError?.message || '状态读取失败';
        initBtn.disabled = true;
        modelClear.disabled = true;
        return;
      }
      applyBackend(res);
    });
  }

  prefSel.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'ih-local-set-pref', pref: prefSel.value }, () => {
      loadBackend();
    });
  });

  initBtn.addEventListener('click', () => {
    initBtn.disabled = true;
    const pref = prefSel.value === 'cloud' ? 'auto' : prefSel.value;
    chrome.runtime.sendMessage({ type: 'ih-local-set-pref', pref }, () => {
      chrome.runtime.sendMessage({ type: 'ih-local-open-init' }, () => {
        loadBackend();
      });
    });
  });

  modelClear.addEventListener('click', () => {
    if (!confirm('清空本机模型？下次要用需重新下载约 800 MB。')) return;
    modelClear.disabled = true;
    chrome.runtime.sendMessage({ type: 'ih-local-drop-model' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        modelDesc.textContent = res?.error || chrome.runtime.lastError?.message || '清空失败';
        modelClear.disabled = false;
        return;
      }
      loadBackend();
    });
  });

  loadBackend();

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) throw new Error(`bad cache size: ${n}`);
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) {
      const kb = n / 1024;
      return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }
    const mb = n / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }

  async function refresh() {
    const { entries, bytes } = await globalThis.IH_analyzeCache.usage();
    descEl.textContent = `${entries} 条 · ${formatBytes(bytes)}`;
    clearBtn.disabled = entries === 0;
  }

  function showCacheError(err) {
    descEl.textContent = err?.message || String(err);
    clearBtn.disabled = true;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'ih-local-progress') return;
    const info = msg.info;
    initBtn.disabled = true;
    modelClear.disabled = true;
    if (info && Number.isFinite(info.loaded) && Number.isFinite(info.total) && info.total > 0) {
      const file = info.file || info.name || '';
      modelDesc.textContent = `下载 ${file} · ${formatBytes(info.loaded)} / ${formatBytes(info.total)}`;
    } else {
      modelDesc.textContent = '正在下载本机模型…';
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ih_webgpu_ok || changes.ih_analyze_pref || changes.ih_local_ready) loadBackend();
    if (Object.keys(changes).some((k) => k.startsWith(globalThis.IH_analyzeCache.PREFIX))) {
      void refresh().catch(showCacheError);
    }
  });

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await globalThis.IH_analyzeCache.dropAll();
      await refresh();
    } catch (err) {
      descEl.textContent = err?.message || String(err);
      clearBtn.disabled = false;
    }
  });

  void refresh().catch(showCacheError);
})();
