(() => {
  if (!globalThis.IH_analyzeCache) {
    throw new Error('IH_analyzeCache missing — inject analyzeCache.js before options.js');
  }

  const iconEl = document.getElementById('brand_icon');
  const brandEl = document.getElementById('brand_name');
  const checkbox = document.getElementById('show_progress');
  const descEl = document.getElementById('cache_desc');
  const clearBtn = document.getElementById('cache_clear');
  if (!iconEl || !brandEl || !checkbox || !descEl || !clearBtn) {
    throw new Error('options page missing required elements');
  }

  const manifest = chrome.runtime.getManifest();
  document.title = manifest.name;
  brandEl.textContent = manifest.name;
  iconEl.src = manifest.icons?.['48'] || manifest.icons?.['32'] || manifest.icons?.['128'] || '';

  chrome.storage.local.get({ show_progress: false }, (res) => {
    checkbox.checked = !!res.show_progress;
  });

  checkbox.addEventListener('change', () => {
    chrome.storage.local.set({ show_progress: checkbox.checked });
  });

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
