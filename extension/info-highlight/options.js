(() => {
  if (!globalThis.IH_analyzeCache) {
    throw new Error('IH_analyzeCache missing — inject analyzeCache.js before options.js');
  }
  if (!globalThis.IH_localState) {
    throw new Error('IH_localState missing — inject state.js before options.js');
  }
  if (!globalThis.IH_highlightStyle) {
    throw new Error('IH_highlightStyle missing — inject highlightStyle.js before options.js');
  }
  if (!globalThis.IH_autoSites) {
    throw new Error('IH_autoSites missing — inject auto-sites.js before options.js');
  }
  if (typeof globalThis.IL_setActionIconDotted !== 'function') {
    throw new Error('IL_setActionIconDotted missing — inject action-dot.js before options.js');
  }
  // 右键工具栏图标 → 选项：Chrome 不发手势事件，只能在选项页打开时灭蓝点
  IL_setActionIconDotted(false);

  const HS = globalThis.IH_highlightStyle;

  let resolvePageReady;
  globalThis.IH_optionsPageReady = new Promise((r) => { resolvePageReady = r; });

  /** 复选框 id 即 chrome.storage.local 的键；值为默认值 */
  const TOGGLES = {
    ih_article_only: true,
    show_progress: false,
    show_token_tip: true,
    [HS.KEY_TWO_TIER]: HS.STORAGE_DEFAULTS[HS.KEY_TWO_TIER],
    ih_word_merge: false,
    ih_highlight_options_page: false,
  };

  const ids = [
    'brand_icon', 'brand_name',
    'analyze_pref', 'ih_cloud_model',
    'webgpu_desc', 'model_desc',
    'local_init', 'model_clear',
    'auto_sites', 'auto_site_input', 'auto_site_add', 'auto_site_error',
    'cache_desc', 'cache_clear',
    'ih_threshold_row', 'ih_threshold_value', 'ih_highlight_threshold_pct',
    'ih_depth_value', 'ih_max_highlight_alpha',
    'ih_paint_style', 'ih_highlight_color', 'ih_highlight_swatches',
    'ih_text_swatches',
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

  function demoP(bits) {
    const twoTier = !!document.getElementById(HS.KEY_TWO_TIER)?.checked;
    const level = HS.tokenLevelFromBits(bits, {
      twoTier,
      thresholdPct: HS.clampThresholdPct(el.ih_highlight_threshold_pct.value),
    });
    if (level < 0) return 0;
    return twoTier ? 1 : level / HS.TOKEN_LEVELS;
  }

  function syncPaintDemo() {
    for (const s of el.ih_paint_style.querySelectorAll('.ih-paint-demo span')) {
      s.style.setProperty('--ih-p', String(demoP(Number(s.dataset.bits))));
    }
  }

  function syncTwoTierUi(on) {
    el.ih_threshold_row.hidden = !on;
    syncPaintDemo();
  }

  function syncPaintColorUi() {
    const text = paintStyle === HS.PAINT_TEXT;
    el.ih_highlight_swatches.closest('.row').hidden = text;
    el.ih_text_swatches.closest('.row').hidden = !text;
  }

  function syncPaintStyle(v) {
    paintStyle = HS.normalizePaintStyle(v);
    for (const btn of el.ih_paint_style.querySelectorAll('.ih-paint-card')) {
      btn.setAttribute('aria-checked', btn.dataset.style === paintStyle ? 'true' : 'false');
    }
    syncPaintColorUi();
  }

  function syncThresholdLabel(pct) {
    el.ih_threshold_value.textContent = HS.formatThresholdLabel(pct);
    syncPaintDemo();
  }

  let paintStyle = HS.PAINT_BLOCK;
  let highlightColor = HS.HUE_RED;
  let lastHue = HS.HUE_RED;
  let textColor = 'red';

  const PAINT_CARD_LABEL = Object.freeze({
    [HS.PAINT_BLOCK]: 'Color blocks',
    [HS.PAINT_UNDERLINE]: 'Underline',
    [HS.PAINT_TEXT]: 'Text color',
  });

  function hueNear(a, b) {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d) <= 8;
  }

  function parseRgb(rgb) {
    return rgb.split(',').map((s) => Number(s.trim()));
  }

  function activeRgb() {
    return paintStyle === HS.PAINT_TEXT
      ? HS.rgbForTextColor(textColor)
      : HS.rgbForColor(highlightColor);
  }

  /** 滑条 accent 合成到页面底色上，观感接近正文里的高亮 */
  function intensityAccent(depth) {
    const a = HS.depthToMaxAlpha(depth, paintStyle);
    const [r, g, b] = parseRgb(activeRgb());
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+/g);
    if (!m || m.length < 3) return `rgba(${r}, ${g}, ${b}, ${a})`;
    const [br, bgG, bb] = m.map(Number);
    return `rgb(${Math.round(br * (1 - a) + r * a)}, ${Math.round(bgG * (1 - a) + g * a)}, ${Math.round(bb * (1 - a) + b * a)})`;
  }

  function syncHighlightColor(v) {
    highlightColor = HS.normalizeHighlightColor(v);
    const ink = HS.isInk(highlightColor);
    if (!ink) lastHue = highlightColor;
    el.ih_highlight_color.value = String(lastHue);
    el.ih_highlight_color.hidden = ink;
    const rgb = activeRgb();
    document.documentElement.style.setProperty('--ih-highlight-rgb', rgb);
    document.documentElement.style.setProperty('--ih-mark-rgb', HS.rgbForColor(highlightColor));
    el.ih_highlight_color.style.setProperty('--ih-hue-track', HS.hueTrackCss());
    for (const btn of el.ih_highlight_swatches.querySelectorAll('.ih-color-swatch')) {
      const id = btn.dataset.color;
      const on = id === HS.COLOR_INK
        ? ink
        : !ink && hueNear(HS.hueForColorId(id), lastHue);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    syncDepthLabel(HS.clampMaxAlphaDepth(el.ih_max_highlight_alpha.value));
  }

  function syncTextColor(v) {
    textColor = HS.normalizeTextColor(v);
    for (const btn of el.ih_text_swatches.querySelectorAll('.ih-color-swatch')) {
      btn.setAttribute('aria-checked', btn.dataset.color === textColor ? 'true' : 'false');
    }
    document.documentElement.style.setProperty('--ih-ink-rgb', HS.rgbForTextColor(textColor));
    if (paintStyle === HS.PAINT_TEXT) {
      document.documentElement.style.setProperty('--ih-highlight-rgb', HS.rgbForTextColor(textColor));
    }
    syncDepthLabel(HS.clampMaxAlphaDepth(el.ih_max_highlight_alpha.value));
  }

  function syncDepthLabel(depth) {
    el.ih_depth_value.textContent = HS.formatDepthLabel(depth);
    const input = el.ih_max_highlight_alpha;
    const min = Number(input.min);
    const max = Number(input.max);
    const pct = max === min ? 100 : ((depth - min) / (max - min)) * 100;
    input.style.setProperty('--ih-intensity-accent', intensityAccent(depth));
    input.style.setProperty('--ih-intensity-pct', `${pct}%`);
    const root = document.documentElement;
    root.style.setProperty('--ih-block-max', String(HS.depthToMaxAlpha(depth, HS.PAINT_BLOCK)));
    root.style.setProperty('--ih-line-max', String(HS.depthToMaxAlpha(depth, HS.PAINT_UNDERLINE)));
    root.style.setProperty('--ih-ink-max', String(HS.depthToMaxAlpha(depth, HS.PAINT_TEXT)));
  }

  HS.watchColorScheme(() => {
    syncHighlightColor(highlightColor);
    syncTextColor(textColor);
  });

  function loadToggles() {
    return Promise.all(Object.entries(TOGGLES).map(([key, fallback]) => new Promise((resolve) => {
      const box = document.getElementById(key);
      if (!box) throw new Error(`options page missing checkbox: ${key}`);
      chrome.storage.local.get({ [key]: fallback }, (res) => {
        box.checked = !!res[key];
        if (key === HS.KEY_TWO_TIER) syncTwoTierUi(box.checked);
        resolve();
      });
      box.addEventListener('change', () => {
        chrome.storage.local.set({ [key]: box.checked });
        if (key === HS.KEY_TWO_TIER) syncTwoTierUi(box.checked);
      });
    })));
  }

  function loadSliders() {
    return new Promise((resolve) => {
      chrome.storage.local.get(HS.STORAGE_DEFAULTS, (res) => {
        const prefs = HS.normalizePrefs(res);
        el.ih_highlight_threshold_pct.value = String(prefs.thresholdPct);
        syncThresholdLabel(prefs.thresholdPct);
        syncPaintStyle(prefs.paintStyle);
        el.ih_max_highlight_alpha.value = String(prefs.maxAlphaDepth);
        syncHighlightColor(prefs.highlightColor);
        syncTextColor(prefs.textColor);
        syncTwoTierUi(prefs.twoTier);
        resolve();
      });
    });
  }

  el.ih_highlight_threshold_pct.addEventListener('input', () => {
    const pct = HS.clampThresholdPct(el.ih_highlight_threshold_pct.value);
    el.ih_highlight_threshold_pct.value = String(pct);
    syncThresholdLabel(pct);
    chrome.storage.local.set({ [HS.KEY_THRESHOLD_PCT]: pct });
  });

  el.ih_max_highlight_alpha.addEventListener('input', () => {
    const depth = HS.clampMaxAlphaDepth(el.ih_max_highlight_alpha.value);
    el.ih_max_highlight_alpha.value = String(depth);
    syncDepthLabel(depth);
    chrome.storage.local.set({ [HS.KEY_MAX_ALPHA_DEPTH]: depth });
  });

  function pickPaint(v) {
    syncPaintStyle(v);
    chrome.storage.local.set({ [HS.KEY_PAINT_STYLE]: paintStyle });
    syncHighlightColor(highlightColor);
    syncTextColor(textColor);
  }

  function paintDemo() {
    const demo = document.createElement('span');
    demo.className = 'ih-paint-demo';
    demo.setAttribute('aria-hidden', 'true');
    // Qwen3-0.6B-Base surprisal bits；--ih-p 由 tokenLevelFromBits 现算
    const tokens = [
      ['Try', 12.39], [' Info', 14.04], [' Highlight', 19], ['.', 7.28],
      [' It', 4.64], [' uses', 7.4], [' large', 11.11], [' language', 6.03],
      [' models', 0.11], [' to', 0.81], [' analyze', 4.5], [' text', 3.03],
      [' information', 9.97], [' density', 17.48], [' and', 1.37],
      [' visual', 8.31], ['izes', 10.65], [' where', 10.72], [' the', 2.28],
      [' important', 8.38], [' parts', 3.45], [' are', 1.44], ['.\n', 3.78],
      ['The', 5.26], [' color', 10.57], [' intensity', 5.06], [' of', 1.15],
      [' each', 2.34], [' token', 8.51], [' indicates', 4.09], [' how', 2.69],
      [' much', 2.39], [' information', 1.68], [' it', 1.82], [' carries', 2.91],
      ['.', 1.13], [' Try', 8.72], [' it', 3.01], [' yourself', 4.29], ['!', 3.91],
    ];
    for (const [raw, bits] of tokens) {
      const s = document.createElement('span');
      s.dataset.bits = String(bits);
      s.style.setProperty('--ih-p', String(demoP(bits)));
      s.textContent = raw;
      demo.append(s);
    }
    return demo;
  }

  for (const id of HS.PAINT_STYLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ih-paint-card';
    btn.dataset.style = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', PAINT_CARD_LABEL[id]);
    btn.append(paintDemo());
    btn.addEventListener('click', () => pickPaint(id));
    el.ih_paint_style.append(btn);
  }

  el.ih_highlight_color.addEventListener('input', () => {
    syncHighlightColor(el.ih_highlight_color.value);
    chrome.storage.local.set({ [HS.KEY_HIGHLIGHT_COLOR]: highlightColor });
  });

  function appendColorSwatch(id, label, rgb) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ih-color-swatch';
    btn.dataset.color = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', label);
    if (id === HS.COLOR_INK) btn.classList.add('ih-color-swatch-ink');
    else btn.style.setProperty('--ih-swatch-rgb', rgb);
    btn.addEventListener('click', () => {
      syncHighlightColor(id === HS.COLOR_INK ? HS.COLOR_INK : HS.hueForColorId(id));
      chrome.storage.local.set({ [HS.KEY_HIGHLIGHT_COLOR]: highlightColor });
    });
    el.ih_highlight_swatches.append(btn);
  }
  for (const id of HS.COLOR_IDS) {
    appendColorSwatch(id, `${id[0].toUpperCase()}${id.slice(1)}`, HS.rgbForHue(HS.hueForColorId(id)));
  }
  appendColorSwatch(HS.COLOR_INK, 'Black / white');

  for (const id of HS.TEXT_COLOR_IDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ih-color-swatch';
    btn.dataset.color = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', `${id[0].toUpperCase()}${id.slice(1)}`);
    btn.style.setProperty('--ih-swatch-rgb', HS.rgbForTextColor(id));
    btn.addEventListener('click', () => {
      syncTextColor(id);
      chrome.storage.local.set({ [HS.KEY_TEXT_COLOR]: textColor });
    });
    el.ih_text_swatches.append(btn);
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
    el.ih_cloud_model.value = st.cloudModel;
    el.local_init.disabled = !webgpu || !!st.ready;
    const gen = ++modelCacheGen;
    return globalThis.IH_localState.modelCacheUsage().then(({ bytes }) => {
      if (gen !== modelCacheGen) return;
      el.model_desc.textContent = bytes > 0 ? `${base} · ${formatBytes(bytes)}` : base;
      el.model_clear.disabled = bytes === 0;
    }).catch(() => {
      if (gen !== modelCacheGen) return;
      el.model_clear.disabled = !st.ready;
    });
  }

  function syncNewDotsPaused(overlay) {
    globalThis.IL_optionsNewDots?.setPaused(!!overlay);
  }

  function loadBackend() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'ih-local-status' }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          el.webgpu_desc.textContent = res?.error || chrome.runtime.lastError?.message || 'Failed to read status';
          el.local_init.disabled = true;
          el.model_clear.disabled = true;
          resolve();
          return;
        }
        syncNewDotsPaused(res.initOverlay);
        void Promise.resolve(applyBackend(res)).finally(resolve);
      });
    });
  }

  el.analyze_pref.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'ih-local-set-pref', pref: el.analyze_pref.value }, () => {
      loadBackend();
    });
  });

  for (const m of IH_localState.CLOUD_MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    el.ih_cloud_model.append(opt);
  }

  el.ih_cloud_model.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'ih-local-set-cloud-model', model: el.ih_cloud_model.value }, () => {
      loadBackend();
    });
  });

  function startPrepare() {
    syncNewDotsPaused(true);
    el.local_init.disabled = true;
    const pref = el.analyze_pref.value === 'cloud' ? 'auto' : el.analyze_pref.value;
    chrome.runtime.sendMessage({ type: 'ih-local-set-pref', pref }, () => {
      chrome.runtime.sendMessage({ type: 'ih-local-open-init' }, () => {
        loadBackend();
      });
    });
  }

  el.local_init.addEventListener('click', () => {
    startPrepare();
  });

  {
    const q = new URLSearchParams(location.search);
    if (q.get('prepare') === '1') {
      history.replaceState(null, '', chrome.runtime.getURL('options.html'));
      startPrepare();
    }
  }

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

  function autoSiteRow(host) {
    const li = document.createElement('li');
    li.className = 'row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = host;
    text.append(title);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      // 名单变了由 storage.onChanged 重绘
      globalThis.IH_autoSites.remove(host).catch((err) => {
        btn.disabled = false;
        showAutoSiteError(String(err?.message || err));
      });
    });
    li.append(text, btn);
    return li;
  }

  function loadAutoSites() {
    return globalThis.IH_autoSites.list().then((hosts) => {
      el.auto_sites.replaceChildren(...hosts.map(autoSiteRow));
    });
  }

  function showAutoSiteError(msg) {
    el.auto_site_error.hidden = !msg;
    el.auto_site_error.textContent = msg || '';
  }

  async function addAutoSite() {
    showAutoSiteError('');
    const host = globalThis.IH_autoSites.parseHost(el.auto_site_input.value);
    if (!host) {
      showAutoSiteError('Enter a site like example.com, *.example.com, or * for every site');
      return;
    }
    // 选项页点 Add 本身就是手势，可直接 request
    const granted = await chrome.permissions.request({
      origins: [globalThis.IH_autoSites.originPattern(host)],
    });
    if (!granted) return;
    // 名单变了由 storage.onChanged 重绘
    await globalThis.IH_autoSites.add(host);
    el.auto_site_input.value = '';
  }

  function submitAutoSite() {
    addAutoSite().catch((err) => showAutoSiteError(String(err?.message || err)));
  }

  el.auto_site_add.addEventListener('click', submitAutoSite);
  el.auto_site_input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAutoSite();
    }
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
    el.cache_desc.textContent = `${entries} entries · ${formatBytes(bytes)}`;
    el.cache_clear.disabled = entries === 0;
  }

  function showCacheError(err) {
    el.cache_desc.textContent = err?.message || String(err);
    el.cache_clear.disabled = true;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ih-local-init-overlay') {
      syncNewDotsPaused(msg.active);
      return;
    }
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
    if (changes.ih_webgpu_ok || changes.ih_analyze_pref || changes.ih_local_ready || changes.ih_cloud_model) {
      loadBackend();
    }
    if (changes[globalThis.IH_autoSites.KEY]) void loadAutoSites();
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

  void Promise.all([
    loadToggles(),
    loadSliders(),
    loadBackend(),
    loadAutoSites(),
    refresh().catch(showCacheError),
  ]).finally(() => resolvePageReady());
})();
