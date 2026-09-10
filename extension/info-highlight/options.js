(() => {
  if (!globalThis.IH_analyzeCache) {
    throw new Error('IH_analyzeCache missing — inject analyzeCache.js before options.js');
  }

  /** 复选框 id 即 chrome.storage.local 的键；值为默认值 */
  const TOGGLES = { show_progress: false, show_token_tip: true };

  const iconEl = document.getElementById('brand_icon');
  const brandEl = document.getElementById('brand_name');
  const descEl = document.getElementById('cache_desc');
  const clearBtn = document.getElementById('cache_clear');
  if (!iconEl || !brandEl || !descEl || !clearBtn) {
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

  void refresh().catch((err) => {
    descEl.textContent = err?.message || String(err);
    clearBtn.disabled = true;
  });
})();
