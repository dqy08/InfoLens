(() => {
  if (!globalThis.IH_analyzeCache) {
    throw new Error('IH_analyzeCache missing — inject analyzeCache.js before options.js');
  }
  if (!globalThis.IH_localState) {
    throw new Error('IH_localState missing — inject state.js before options.js');
  }

  /** 复选框 id 即 chrome.storage.local 的键；值为默认值 */
  const TOGGLES = { show_progress: false, show_token_tip: true };

  const ids = [
    'brand_icon', 'brand_name',
    'analyze_pref',
    'webgpu_desc', 'model_desc',
    'local_init', 'model_clear',
    'cache_desc', 'cache_clear',
  ];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  if (ids.some((id) => !el[id])) {
    throw new Error('options page missing required elements');
  }

  const manifest = chrome.runtime.getManifest();
  const name = manifest.name;
  const iconRel = manifest.icons?.['48'] || manifest.icons?.['32'] || manifest.icons?.['128'];
  if (!name) throw new Error('manifest name missing');
  if (!iconRel) throw new Error('manifest icons missing');
  document.title = name;
  el.brand_name.textContent = name;
  el.brand_icon.src = iconRel;
  el.brand_icon.alt = name;

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
    if (st.ready) return 'Ready (Gemma 3 270M)';
    if (webgpu) return 'Not prepared (Gemma 3 270M)';
    return 'This computer cannot run the on-device model';
  }

  let modelCacheGen = 0;
  function applyBackend(st) {
    const webgpu = st.webgpuOk === true;
    el.webgpu_desc.textContent = webgpu
      ? 'Available'
      : st.webgpuOk === false
        ? (st.pref === 'local'
          ? 'Unavailable. On-device only is selected, so cloud will not be used'
          : 'Unavailable; cloud will be used')
        : 'Not checked yet';
    const base = modelStatusText(st, webgpu);
    el.model_desc.textContent = base;
    el.analyze_pref.value = st.pref === 'cloud' || st.pref === 'local' ? st.pref : 'auto';
    el.local_init.disabled = !webgpu || !!st.ready;
    const gen = ++modelCacheGen;
    void globalThis.IH_localState.modelCacheUsage().then(({ bytes }) => {
      if (gen !== modelCacheGen) return;
      el.model_desc.textContent = bytes > 0 ? `${base} · ${formatBytes(bytes)}` : base;
      el.model_clear.disabled = bytes === 0;
    }).catch(() => {
      if (gen !== modelCacheGen) return;
      el.model_clear.disabled = !st.ready;
    });
  }

  function loadBackend() {
    chrome.runtime.sendMessage({ type: 'ih-local-status' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        el.webgpu_desc.textContent = res?.error || chrome.runtime.lastError?.message || 'Failed to read status';
        el.local_init.disabled = true;
        el.model_clear.disabled = true;
        return;
      }
      applyBackend(res);
    });
  }

  el.analyze_pref.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'ih-local-set-pref', pref: el.analyze_pref.value }, () => {
      loadBackend();
    });
  });

  el.local_init.addEventListener('click', () => {
    el.local_init.disabled = true;
    const pref = el.analyze_pref.value === 'cloud' ? 'auto' : el.analyze_pref.value;
    chrome.runtime.sendMessage({ type: 'ih-local-set-pref', pref }, () => {
      chrome.runtime.sendMessage({ type: 'ih-local-open-init' }, () => {
        loadBackend();
      });
    });
  });

  el.model_clear.addEventListener('click', () => {
    if (!confirm('Clear the on-device model? Using it next time will download about 800 MB again.')) return;
    el.model_clear.disabled = true;
    chrome.runtime.sendMessage({ type: 'ih-local-drop-model' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        el.model_desc.textContent = res?.error || chrome.runtime.lastError?.message || 'Failed to clear';
        el.model_clear.disabled = false;
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
    el.cache_desc.textContent = `${entries} entries · ${formatBytes(bytes)}`;
    el.cache_clear.disabled = entries === 0;
  }

  function showCacheError(err) {
    el.cache_desc.textContent = err?.message || String(err);
    el.cache_clear.disabled = true;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ih-local-init-outcome') {
      loadBackend();
      return;
    }
    if (msg?.type !== 'ih-local-progress') return;
    const info = msg.info;
    el.local_init.disabled = true;
    el.model_clear.disabled = true;
    if (info && Number.isFinite(info.loaded) && Number.isFinite(info.total) && info.total > 0) {
      const file = info.file || info.name || '';
      el.model_desc.textContent = `Downloading ${file} · ${formatBytes(info.loaded)} / ${formatBytes(info.total)}`;
    } else {
      el.model_desc.textContent = 'Downloading on-device model…';
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ih_webgpu_ok || changes.ih_analyze_pref || changes.ih_local_ready) loadBackend();
    if (Object.keys(changes).some((k) => k.startsWith(globalThis.IH_analyzeCache.PREFIX))) {
      void refresh().catch(showCacheError);
    }
  });

  el.cache_clear.addEventListener('click', async () => {
    el.cache_clear.disabled = true;
    try {
      await globalThis.IH_analyzeCache.dropAll();
      await refresh();
    } catch (err) {
      el.cache_desc.textContent = err?.message || String(err);
      el.cache_clear.disabled = false;
    }
  });

  void refresh().catch(showCacheError);
})();
