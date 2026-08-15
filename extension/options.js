(() => {
  if (!globalThis.IL_analyzeCache) {
    throw new Error('IL_analyzeCache missing — inject semantic/analyzeCache.js before options.js');
  }

  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
  const iconEl = document.getElementById('brand_icon');
  const brandEl = document.getElementById('brand_name');
  const headingEl = document.getElementById('storage_heading');
  const cacheTitleEl = document.getElementById('cache_title');
  const descEl = document.getElementById('cache_desc');
  const clearBtn = document.getElementById('cache_clear');
  if (!iconEl || !brandEl || !headingEl || !cacheTitleEl || !descEl || !clearBtn) {
    throw new Error('options page missing required elements');
  }

  document.documentElement.lang = chrome.i18n.getUILanguage();
  const manifest = chrome.runtime.getManifest();
  const name = manifest.name;
  const iconRel = manifest.icons?.['48'] || manifest.icons?.['32'] || manifest.icons?.['128'];
  if (!name) throw new Error('manifest name missing');
  if (!iconRel) throw new Error('manifest icons missing');
  document.title = name;
  iconEl.src = iconRel;
  iconEl.alt = name;
  brandEl.textContent = name;
  headingEl.textContent = t('optionsStorageSection');
  cacheTitleEl.textContent = t('optionsCacheTitle');
  clearBtn.textContent = t('optionsCacheClear');

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
    const { entries, bytes } = await globalThis.IL_analyzeCache.usage();
    descEl.textContent = t('optionsCacheUsage', [String(entries), formatBytes(bytes)]);
    clearBtn.disabled = entries === 0;
  }

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await globalThis.IL_analyzeCache.dropAll();
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
