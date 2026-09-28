/**
 * 工具栏点击 / 右键菜单 → 注入 content（activeTab 手势）。已注入则 toggle。
 * 分析：本机 WebGPU（已就绪）或 /api/analyze。
 * PDF：整条流程在 pdf/sw.js（共享），本文件只负责在网页管线里的何处插入它。
 */

importScripts('sw/restricted-url.js');
importScripts('sw/action-dot.js');
importScripts('options-attention.js');
importScripts('options-catalog.js');
importScripts('sw/lifecycle-events.js');
importScripts('sw/client-id.js');
importScripts('sw/inject.js');
importScripts('auto-sites.js');
importScripts('config.js');
importScripts('pdf/stash-db.js');
importScripts('pdf/sw.js');
importScripts('cache/ring-store.js');
importScripts('analyzeCache.js');
importScripts('local/state.js');
importScripts('highlightStyle.js');
importScripts('optionDefaults.js');
importScripts('zh.js');
importScripts('i18n.js');
importScripts('local/userErrors.js');
importScripts('cloudWait.js');
importScripts('init-window-bounds.js');
importScripts('action-state.js');

const EXTENSION_ID = 'info-highlight';
const { tr } = IH_i18n;

if (!globalThis.IH_localState) throw new Error('IH_localState missing');
if (!globalThis.IH_highlightStyle) throw new Error('IH_highlightStyle missing');
if (!globalThis.IH_optionDefaults) throw new Error('IH_optionDefaults missing');
if (!globalThis.IH_userErrors) throw new Error('IH_userErrors missing');
if (!globalThis.IH_cloudWait) throw new Error('IH_cloudWait missing');
if (!globalThis.IH_analyzeCache) throw new Error('IH_analyzeCache missing');
if (!globalThis.IH_initWindowBounds) throw new Error('IH_initWindowBounds missing');
if (!globalThis.IH_actionState) throw new Error('IH_actionState missing');
if (!globalThis.IH_autoSites) throw new Error('IH_autoSites missing');

IL_prepareClientIdReporting(EXTENSION_ID);

function analyzeUrl() {
  return `${IL_API_BASE}/api/analyze`;
}

const CONTENT_CSS = ['content.css'];
/** SYNC: options.html 网页管线脚本（无 drop-stale / tokenTip；另加 options-page-flags.js） */
const CONTENT_JS = [
  'drop-stale.js',
  'vendor/Readability.js',
  'extractRootPatches.js',
  'articleRoot.js',
  'textMapConfig.js',
  'collectTextMap.js',
  'splitTextToChunks.js',
  'textIndex.js',
  'scrollGeometry.js',
  'progressAxis.js',
  'overlay.js',
  'statusFeedback.js',
  'feedbackContext.js',
  'highlightStyle.js',
  'optionDefaults.js',
  'wordMerge.js',
  'zh.js',
  'i18n.js',
  'local/userErrors.js',
  'cloudWait.js',
  'page-map.js',
  'tokenTip.js',
  'analyzeRun.js',
  'auto-sites.js',
  'auto-nudge.js',
  'content.js',
];

/**
 * 本世界 API 活着则可选调用 toggle/start；否则看 DOM 是否还有网页管线上次注入的痕迹。
 * live / stale / empty。重载后旧隔离世界互不可见，只能靠标记。
 * SYNC: content.js 的 data-ih-cs。PDF 入口节点由 entry.js 同 id 回收，不当 stale。
 * @param {'toggle' | 'start' | 'force' | ''} [method]
 * @param {string} [cloudModel] force 时钉住的云端模型 id；空则走当前偏好
 * @param {string} [trigger] auto | icon | menu | rerun | other
 * @returns {Promise<{ state: 'live' | 'stale' | 'empty', result?: unknown }>}
 */
async function pageCsPeek(tabId, method, cloudModel, trigger) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      args: [method || '', typeof cloudModel === 'string' ? cloudModel : '', typeof trigger === 'string' ? trigger : ''],
      func: (m, model, why) => {
        const demo = window.__IH_DEMO__;
        const pdf = window.__IH_PDF_ENTRY__;
        let live = false;
        try {
          live = typeof demo?.isLive === 'function' && !!demo.isLive();
        } catch {
          /* 作废 */
        }
        if (!live) {
          try {
            live = typeof pdf?.isLive === 'function' && !!pdf.isLive();
          } catch {
            /* 作废 */
          }
        }
        if (live) {
          if (m === 'start' && typeof demo?.start === 'function') {
            return { state: 'live', result: demo.start() };
          }
          if (m === 'force' && typeof demo?.force === 'function') {
            demo.force(model, why);
            return { state: 'live', result: true };
          }
          if (m === 'toggle' && typeof demo?.toggle === 'function') {
            demo.toggle(why);
            return { state: 'live', result: true };
          }
          return { state: 'live' };
        }
        const marked = document.documentElement.hasAttribute('data-ih-cs');
        return { state: marked ? 'stale' : 'empty' };
      },
    });
    const v = results?.[0]?.result;
    if (v?.state === 'live' || v?.state === 'stale') return v;
    return { state: 'empty' };
  } catch {
    return { state: 'empty' };
  }
}

const STALE_PAGE_MSG =
  'A previous version of Info Highlight is still on this page. Please refresh the page and try again.';
/** SYNC: analyzeRun.js → FORCE_BUSY_MSG */
const FORCE_BUSY_MSG =
  'Info Highlight is still analyzing this page. Try again when it finishes.';

async function pageAlert(tabId, msg) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (msg) => { alert(msg); },
      args: [msg],
    });
  } catch {
    /* 页上 alert 不了 */
  }
}

async function refuseStalePage(tabId) {
  await setBadgeError(tabId, 'refresh this page');
  await pageAlert(tabId, STALE_PAGE_MSG);
}

function clearBadge(tabId) {
  void chrome.action.setBadgeText({ text: '', tabId });
}

async function setBadgeError(tabId, brief) {
  try {
    IH_actionState.set(tabId, 'off');
    await chrome.action.setBadgeBackgroundColor({ color: '#c0392b', tabId });
    await chrome.action.setBadgeText({ text: '!', tabId });
    await chrome.action.setTitle({ title: `Info Highlight: ${brief}`, tabId });
  } catch {
    /* ignore */
  }
}

async function activateTab(tab, force, cloudModel, trigger) {
  if (!tab?.id) return;
  const pinned = force ? knownCloudModel(cloudModel) : '';
  const why = normalizeUsageTrigger(trigger) || (force ? 'rerun' : '');
  if (why) triggerByTab.set(tab.id, why);
  // optional file:// request 必须在手势同步阶段启动；前面不能有 await
  const fileHostPromise = IL_pdfSw.isFileUrl(tab.url) ? IL_pdfSw.requestFileHostFromGesture() : null;
  IL_setActionIconDotted(false);
  if (!force && IH_actionState.shouldIgnoreClick(tab.id)) return;
  if (force && IH_actionState.get(tab.id) === 'analyzing') {
    await pageAlert(tab.id, FORCE_BUSY_MSG);
    return;
  }
  try {
    const fresh = await chrome.tabs.get(tab.id);
    const url = fresh.url || tab.url || '';
    if (IL_pdfSw.isOwnViewerUrl(url)) {
      IH_actionState.markAnalyzingIfIdle(tab.id);
      const ok = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: force ? 'ih-pdf-force' : 'ih-pdf-toggle',
          tabId: tab.id,
          ...(pinned ? { cloudModel: pinned } : {}),
          ...(why ? { trigger: why } : {}),
        }, (res) => {
          resolve(!chrome.runtime.lastError && res?.ok === true);
        });
      });
      if (!ok) {
        await setBadgeError(tab.id, 'inject');
        return;
      }
      clearBadge(tab.id);
      return;
    }
    if (IL_isRestrictedUrl(url)) {
      console.warn('[Info Highlight] cannot run on this page:', url);
      await setBadgeError(tab.id, "can't run here — this page is protected");
      return;
    }
    const access = await IL_pdfSw.ensureFileUrlAccess(url, fileHostPromise);
    if (!access.ok) {
      await setBadgeError(tab.id, access.brief);
      return;
    }
    if (IL_pdfSw.isPdfUrl(url)) {
      const peek = await pageCsPeek(tab.id);
      if (peek.state === 'stale') {
        await refuseStalePage(tab.id);
        return;
      }
      await IL_pdfSw.injectEntry(tab.id);
      clearBadge(tab.id);
      return;
    }
    // 无 .pdf 后缀时先由页内按 Content-Type / 魔数确认，再退回网页管线
    {
      const peek = await pageCsPeek(tab.id, force ? 'force' : 'toggle', pinned, why);
      if (peek.state === 'stale') {
        await refuseStalePage(tab.id);
        return;
      }
      // result 表示页内 demo.toggle / force 已执行。仅 PDF 入口 live 时没有 result，要落到下面切按钮。
      if (peek.state === 'live' && peek.result) {
        manualTabs.add(tab.id);
        clearBadge(tab.id);
        return;
      }
    }
    if (await IL_pdfSw.injectEntryAndOffered(tab.id)) {
      clearBadge(tab.id);
      return;
    }
    IH_actionState.markAnalyzingIfIdle(tab.id);
    manualTabs.add(tab.id);
    IH_actionState.set(tab.id, 'analyzing');
    const okTab = await IL_injectWithRetry(tab.id, { css: CONTENT_CSS, js: CONTENT_JS }, {
      logLabel: 'Info Highlight',
      waitComplete: false,
    });
    const after = await pageCsPeek(tab.id, force ? 'force' : 'toggle', pinned, why);
    if (after.state !== 'live') {
      await setBadgeError(tab.id, 'inject');
      return;
    }
    console.info('[Info Highlight] injected into', okTab.url);
    clearBadge(tab.id);
  } catch (err) {
    try {
      if (await IL_pdfSw.injectEntryAndOffered(tab.id)) {
        clearBadge(tab.id);
        return;
      }
    } catch (pdfErr) {
      console.error('[Info Highlight] pdf-entry inject failed', pdfErr);
    }
    console.error('[Info Highlight] inject failed', err);
    await setBadgeError(tab.id, 'inject');
  }
}

const CONTEXT_MENU_ID = 'ih-highlight';
const FORCE_MENU_ID = 'ih-force-analyze';
const FORCE_MODEL_PREFIX = 'ih-force-model:';
const AUTO_MENU_ID = 'ih-auto-site';
const OPTIONS_MENU_ID = 'ih-options';
const ANALYZE_MENU_TITLE = tr('Analyze this page');
const FORCE_ANALYZE_MENU_TITLE = tr('Reanalyze this page');

function knownCloudModel(id) {
  if (typeof id !== 'string' || !id) return '';
  return IH_localState.CLOUD_MODELS.some((m) => m.id === id) ? id : '';
}

/** SYNC: page-map.js FADE_DEFAULT_NOTICE。没存过形式的升级用户，下次网页高亮时提醒一次。 */
const FADE_DEFAULT_NOTICE = 'ih_fade_default_notice';

async function armFadeDefaultNotice(details) {
  const paintKey = IH_highlightStyle.KEY_PAINT_STYLE;
  const cur = await chrome.storage.local.get([paintKey, FADE_DEFAULT_NOTICE]);
  const mark = cur[FADE_DEFAULT_NOTICE];
  if (mark === 'seen' || mark === 'pending') return;
  const stored = cur[paintKey];
  const hasStyle = IH_highlightStyle.PAINT_STYLES.includes(stored);
  if (details.reason === 'install' || hasStyle) {
    await chrome.storage.local.set({ [FADE_DEFAULT_NOTICE]: 'seen' });
    return;
  }
  if (details.reason === 'update') {
    await chrome.storage.local.set({ [FADE_DEFAULT_NOTICE]: 'pending' });
  }
}

function autoMenuTitle(host, on) {
  return on ? tr('Stop always analyzing {host}', { host }) : tr('Always analyze {host}', { host });
}

/** 人工点过图标的标签：自动分析别再插手，直到下次导航 */
const manualTabs = new Set();
/** SYNC: analyzeRun.js USAGE_TRIGGERS / normalizeUsageTrigger */
const USAGE_TRIGGERS = ['auto', 'icon', 'menu', 'rerun', 'other'];

function normalizeUsageTrigger(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return USAGE_TRIGGERS.includes(s) ? s : '';
}

/** tabId -> auto | icon | menu | rerun | other；PDF 首次自启时页内还不知道 */
const triggerByTab = new Map();
/** tabId -> 导航代数；reset 时 +1，过期的自动分析不再改状态 */
const autoGenByTab = new Map();
/** 同一 tabId 的 maybeAutoAnalyze 互斥：onActivated / onUpdated(complete) 可能几乎同时触发 */
const autoAnalyzeInFlight = new Set();

/**
 * 无 tabs 权限时只看得见已授权站点的 url；看不见即未授权，正好是要显示「添加」的情形。
 * @param {number} tabId
 */
async function syncAutoMenu(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const host = IH_autoSites.hostOf(tab?.url || '');
  if (!host) {
    // 看不见 url（未授权）或非 http(s)：标题用不到，点下去才从 pageUrl 取 host
    chrome.contextMenus.update(AUTO_MENU_ID, { title: tr('Always analyze this site') }, () => {
      void chrome.runtime.lastError;
    });
    return;
  }
  const on = await IH_autoSites.hasExact(host);
  chrome.contextMenus.update(AUTO_MENU_ID, { title: autoMenuTitle(host, on) }, () => {
    void chrome.runtime.lastError;
  });
}

async function toggleAutoSite(info, tabId, tabUrl) {
  // 网页右键带 pageUrl。图标菜单的点击参数是空的，host 用这次点击授予的 tab.url。
  const url = info.pageUrl || tabUrl || '';
  const host = IH_autoSites.hostOf(url);
  if (!host) throw new Error(`auto-site menu on unsupported url: ${url || '(none)'}`);
  // 手势同步阶段发起；已授权时不弹窗直接 true，故开关两向都先发它
  const requested = chrome.permissions.request({ origins: [IH_autoSites.originPattern(host)] });
  const wasOn = await IH_autoSites.hasExact(host);
  const granted = await requested;
  // 用户刚在菜单里表了态，之前点图标的操作不再压制自动分析
  manualTabs.delete(tabId);
  if (wasOn) {
    await IH_autoSites.remove(host);
  } else if (granted) {
    await IH_autoSites.add(host);
    await maybeAutoAnalyze(tabId);
  }
  await syncAutoMenu(tabId);
}

/** 网页里的脚本决定要问时，只负责把窗打开。选择由窗自己写存储。 */
const NUDGE_WIDTH = 540;
const NUDGE_HEIGHT = 360;
const WELCOME_WIDTH = 540;
const WELCOME_HEIGHT = 360;
let welcomeWindowId = null;
/** 打开引导页的选项页窗口；焦点回到该窗时再把引导页拉到前面 */
let welcomeHostWindowId = null;

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== welcomeWindowId) return;
  welcomeWindowId = null;
  welcomeHostWindowId = null;
});

/** @param {number | undefined} hostWindowId 选项页标签所在窗口 */
async function openWelcomeWindow(hostWindowId) {
  if (typeof hostWindowId !== 'number') throw new Error('Welcome window requires the options window');
  if (welcomeWindowId != null) {
    try {
      await chrome.windows.update(welcomeWindowId, { focused: true });
      return;
    } catch {
      welcomeWindowId = null;
      welcomeHostWindowId = null;
    }
  }
  const host = await chrome.windows.get(hostWindowId);
  /** @type {chrome.windows.CreateData} */
  const create = {
    url: chrome.runtime.getURL('welcome.html'),
    type: 'popup',
    width: WELCOME_WIDTH,
    height: WELCOME_HEIGHT,
    focused: true,
  };
  const pos = IH_initWindowBounds.clampPopupToHost(host, WELCOME_WIDTH, WELCOME_HEIGHT);
  if (pos) {
    create.left = pos.left;
    create.top = pos.top;
  }
  let win;
  try {
    win = await chrome.windows.create(create);
  } catch (err) {
    if (!IH_initWindowBounds.isBoundsError(err) || create.left == null) throw err;
    delete create.left;
    delete create.top;
    win = await chrome.windows.create(create);
  }
  if (win?.id == null) throw new Error('Welcome window create returned no id');
  welcomeWindowId = win.id;
  welcomeHostWindowId = hostWindowId;
}

async function openNudgeWindow(host) {
  /** @type {chrome.windows.CreateData} */
  const create = {
    url: chrome.runtime.getURL('auto-nudge.html') + `?host=${encodeURIComponent(host)}`,
    type: 'popup',
    width: NUDGE_WIDTH,
    height: NUDGE_HEIGHT,
    focused: true,
  };
  try {
    const browserWin = await chrome.windows.getLastFocused();
    const pos = IH_initWindowBounds.clampPopupToHost(browserWin, NUDGE_WIDTH, NUDGE_HEIGHT);
    if (pos) {
      create.left = pos.left;
      create.top = pos.top;
    }
  } catch {
    /* 没有宿主窗口时让浏览器自己放 */
  }
  try {
    const win = await chrome.windows.create(create);
    if (win?.id == null) throw new Error('Auto-nudge window create returned no id');
  } catch (err) {
    if (!IH_initWindowBounds.isBoundsError(err) || create.left == null) throw err;
    delete create.left;
    delete create.top;
    const win = await chrome.windows.create(create);
    if (win?.id == null) throw new Error('Auto-nudge window create returned no id');
  }
}

function resetAutoForTab(tabId) {
  manualTabs.delete(tabId);
  autoGenByTab.set(tabId, (autoGenByTab.get(tabId) || 0) + 1);
  if (IH_actionState.get(tabId) !== 'off') IH_actionState.set(tabId, 'off');
}

/**
 * 命中名单的前台、已 complete 的标签即可分析。PDF / file: 不进。
 * 重复触发是幂等的：页内已在跑返回 'busy'、已画好返回 'painted'，都不动它。
 * @param {number} tabId
 */
async function maybeAutoAnalyze(tabId) {
  // onActivated / onUpdated(complete) 可能几乎同时触发；不互斥会各自把 content.js 注入一遍，
  // 两份独立的页面管线各跑一次分析，对同一段正文重复发请求。
  if (autoAnalyzeInFlight.has(tabId)) return;
  autoAnalyzeInFlight.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active || tab.status !== 'complete' || manualTabs.has(tabId)) return;
    const url = tab.url || '';
    const host = IH_autoSites.hostOf(url);
    if (!host || IL_isRestrictedUrl(url) || IL_pdfSw.isPdfUrl(url)) return;
    if (!(await IH_autoSites.granted(host))) return;
    const gen = autoGenByTab.get(tabId) || 0;
    const stillCurrent = () => (autoGenByTab.get(tabId) || 0) === gen;
    try {
      triggerByTab.set(tabId, 'auto');
      const peek = await pageCsPeek(tabId, 'start');
      if (!stillCurrent()) return;
      if (peek.state === 'stale') {
        await refuseStalePage(tabId);
        return;
      }
      if (peek.state === 'live') {
        const started = peek.result;
        if (started === 'painted') IH_actionState.set(tabId, 'on');
        if (started && started !== 'busy') clearBadge(tabId);
        return;
      }
      IH_actionState.set(tabId, 'analyzing');
      await IL_injectWithRetry(tabId, { css: CONTENT_CSS, js: CONTENT_JS }, {
        logLabel: 'Info Highlight auto',
        waitComplete: false,
        isStale: () => !stillCurrent(),
      });
      if (!stillCurrent()) return;
      const after = await pageCsPeek(tabId, 'start');
      if (!stillCurrent()) return;
      if (after.state === 'live' && after.result) {
        clearBadge(tabId);
        return;
      }
      await setBadgeError(tabId, 'inject');
    } catch (err) {
      if (!stillCurrent()) return;
      if (String(err?.message || err).includes('navigation superseded')) {
        IH_actionState.set(tabId, 'off');
        return;
      }
      console.error('[Info Highlight] auto inject failed', err);
      await setBadgeError(tabId, 'inject');
    }
  } finally {
    autoAnalyzeInFlight.delete(tabId);
  }
}

chrome.action.onClicked.addListener((tab) => {
  void activateTab(tab, false, '', 'icon');
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncAutoMenu(tabId);
  void maybeAutoAnalyze(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 整页开始加载才 reset。地址变了或 DOM 变了不自动跟。
  if (changeInfo.status === 'loading') resetAutoForTab(tabId);
  if (tab.active && (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
    void syncAutoMenu(tabId);
  }
  if (changeInfo.status === 'complete') void maybeAutoAnalyze(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  IH_actionState.clear(tabId);
  manualTabs.delete(tabId);
  triggerByTab.delete(tabId);
  autoGenByTab.delete(tabId);
});

/** Chrome 界面语言只在重启浏览器后生效，跟着走 onStartup 重建一次即可。 */
function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: AUTO_MENU_ID,
      title: tr('Always analyze this site'),
      contexts: ['page', 'action'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    chrome.contextMenus.create({
      id: 'ih-auto-separator',
      type: 'separator',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: ANALYZE_MENU_TITLE,
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: FORCE_MENU_ID,
      title: FORCE_ANALYZE_MENU_TITLE,
      contexts: ['page', 'action'],
    });
    for (const m of IH_localState.CLOUD_MODELS) {
      chrome.contextMenus.create({
        id: FORCE_MODEL_PREFIX + m.id,
        title: `${FORCE_ANALYZE_MENU_TITLE} (${m.label})`,
        contexts: ['page'],
      });
    }
    chrome.contextMenus.create({
      id: 'ih-options-separator',
      type: 'separator',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: OPTIONS_MENU_ID,
      title: tr('Options'),
      contexts: ['page', 'action'],
    });
  });
}

chrome.runtime.onStartup.addListener(buildContextMenus);

chrome.runtime.onInstalled.addListener((details) => {
  buildContextMenus();

  void IL_optionsAttention.onInstalled(details, IL_OPTIONS_CATALOG);
  void armFadeDefaultNotice(details);
  IL_setActionIconDotted(true);
  IL_reportInstallOrUpdate(details, EXTENSION_ID);
  if (details.reason === 'install') {
    void chrome.tabs.create({
      url: chrome.runtime.getURL('options.html') + '?welcome',
    });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === OPTIONS_MENU_ID) {
    IL_setActionIconDotted(false);
    void chrome.runtime.openOptionsPage();
    return;
  }
  if (!tab?.id) return;
  // 用过菜单也算用过插件；Chrome 右键工具栏图标本身不发事件，只能在这里灭蓝点
  IL_setActionIconDotted(false);
  if (info.menuItemId === CONTEXT_MENU_ID) void activateTab(tab, false, '', 'menu');
  else if (info.menuItemId === FORCE_MENU_ID) void activateTab(tab, true, '', 'rerun');
  else if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith(FORCE_MODEL_PREFIX)) {
    const modelId = info.menuItemId.slice(FORCE_MODEL_PREFIX.length);
    if (!knownCloudModel(modelId)) return;
    void activateTab(tab, true, modelId, 'rerun');
  }
  // permissions.request 要手势，toggleAutoSite 里首句就发，别在这之前 await
  else if (info.menuItemId === AUTO_MENU_ID) void toggleAutoSite(info, tab.id, tab.url);
});

const ERROR_BODY_SNIPPET = 500;

function isJsonContentType(contentTypeHeader) {
  const ct = (contentTypeHeader || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json' || ct.endsWith('+json');
}

/** POST /api/analyze；站点成功体无 success=true，仅 success===false 视为失败。冷启动时这一次请求等到返回。 */
async function postAnalyze(text, model, tabId) {
  const url = analyzeUrl();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        text,
        privacy_mode: true,
        ...(IH_CONFIG.modalDebug ? { modal_debug: true } : {}),
      }),
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(msg)) {
      throw new Error('Cannot reach the analyze server. Try again later.');
    }
    throw err;
  }
  return await readAnalyzeResponse(res);
}

async function readAnalyzeResponse(res) {
  const raw = await res.text();
  const ctHeader = res.headers.get('Content-Type') || '';
  const ct = ctHeader.split(';')[0].trim().toLowerCase() || '(none)';
  const snippet = raw.length <= ERROR_BODY_SNIPPET ? raw : raw.slice(0, ERROR_BODY_SNIPPET - 1) + '…';

  if (!raw.trim()) {
    throw new Error(`HTTP ${res.status}: empty response`);
  }
  if (!isJsonContentType(ctHeader)) {
    throw new Error(`HTTP ${res.status}: expected application/json, got ${ct}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const why = e && e.message ? String(e.message) : 'parse failed';
    throw new Error(`HTTP ${res.status}: malformed JSON (${why}): ${snippet}`);
  }

  if (data?.success === false) {
    throw new Error(data.message || data.detail || `HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  return data;
}

/** 并发 createDocument 共用这一次 load；完成初次 page load 后才 settle。 */
let creating = null;

async function ensureOffscreen() {
  while (creating) await creating;
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: 'local/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run the local WebGPU language model for Info Highlight',
    })
    .catch((err) => {
      const msg = String(err?.message || err);
      if (/already exists|Only a single offscreen/i.test(msg)) return;
      throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

let localInflight = 0;

/** 已发出、还没进藏页的本机分析。一个标签最多一条。 */
const localWaiters = [];
let localDraining = false;

function pickLocalWaiter(waiters, activeTabId) {
  const i = waiters.findIndex((w) => activeTabId != null && w.tabId === activeTabId);
  return i >= 0 ? i : 0;
}

function focusedTabId() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(
    (tabs) => (tabs && tabs[0] ? tabs[0].id : null),
    () => null,
  );
}

/**
 * 同时只放行一条，已在等的激活标签优先。
 * 前台要等上一段回到页面才发下一段，空档里后台最多插进一段，所以前台至少大约一半。
 */
function runLocalAnalyze(tabId, run) {
  return new Promise((resolve, reject) => {
    localWaiters.push({ tabId, run, resolve, reject });
    void drainLocalAnalyze();
  });
}

async function drainLocalAnalyze() {
  if (localDraining) return;
  localDraining = true;
  try {
    while (localWaiters.length) {
      const activeId = await focusedTabId();
      const job = localWaiters.splice(pickLocalWaiter(localWaiters, activeId), 1)[0];
      try {
        job.resolve(await job.run());
      } catch (err) {
        job.reject(err);
      }
    }
  } finally {
    localDraining = false;
    if (localWaiters.length) void drainLocalAnalyze();
  }
}

function isOffscreenGone(err) {
  const msg = String(err?.message || err);
  return /Receiving end does not exist|Could not establish connection|The message port closed|no current offscreen/i.test(msg);
}

async function sendToEngine(payload) {
  const send = async () => {
    await ensureOffscreen();
    return chrome.runtime.sendMessage({ type: 'ih-local-engine', ...payload });
  };
  try {
    const res = await send();
    if (res != null) return res;
  } catch (err) {
    if (!isOffscreenGone(err)) throw err;
  }
  try {
    await destroyOffscreen();
  } catch (err) {
    if (!isOffscreenGone(err)) throw err;
  }
  const res = await send();
  if (res == null) throw new Error('local engine not ready');
  return res;
}

async function hasOffscreen() {
  return !!(chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument()));
}

function idleBlockReason() {
  if (localInflight > 0) return 'inflight';
  if (initBusy) return 'init';
  if (offerLock) return 'offer';
  return 'none';
}

async function destroyOffscreen() {
  if (creating) await creating;
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument();
  }
}

async function closeOffscreenIfIdle() {
  if (creating) await creating;
  if (idleBlockReason() !== 'none') return;
  await destroyOffscreen();
}

async function dropLocalModel() {
  await destroyOffscreen();
  await IH_localState.dropModelCache();
  await IH_localState.set({ ready: false });
  await IH_analyzeCache.dropAll();
}

/** 只打断还在下载的初始化；已经 init 成功则忽略。半成品留在 Cache。 */
async function cancelLocalInit() {
  if (!initCancellable) return;
  initCancellable = false;
  initGeneration += 1;
  initBusy = false;
  await destroyOffscreen();
}

async function probeAndStore() {
  let webgpu = await IH_localState.probeWebGPU();
  if (globalThis.navigator?.gpu == null) {
    const res = await sendToEngine({ cmd: 'probe' });
    if (!res?.ok) throw new Error(res?.error || 'WebGPU probe failed');
    webgpu = !!res.webgpu;
  }
  await IH_localState.set({ webgpuOk: webgpu });
  return webgpu;
}

/** @type {((engine: string) => void)[]} */
let initWaiters = [];
let initGeneration = 0;
let initWindowId = null;
/** Prepare 打开时的宿主窗；焦点回到该窗时再把 Prepare 拉到前面 */
let initHostWindowId = null;
let offerLock = null;
let initBusy = false;
let initCancellable = false;

/** Prepare 开着时通知选项页：暂停「新选项」看见计时 */
function notifyOptionsInitOverlay(active) {
  chrome.runtime.sendMessage({ type: 'ih-local-init-overlay', active: !!active }, () => {
    void chrome.runtime.lastError;
  });
}

function clearInitWindowId() {
  if (initWindowId == null) return;
  initWindowId = null;
  initHostWindowId = null;
  notifyOptionsInitOverlay(false);
}

function assignInitWindowId(id, hostId) {
  initWindowId = id;
  initHostWindowId = hostId ?? null;
  notifyOptionsInitOverlay(true);
}

/** 焦点回到打开弹窗时的宿主窗 → 再把弹窗拉到前面。两个都开着时 Prepare 优先。 */
function focusPopupIfHostFocused(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (windowId === initWindowId || windowId === welcomeWindowId) return;
  if (initWindowId != null && initHostWindowId != null && windowId === initHostWindowId) {
    void chrome.windows.update(initWindowId, { focused: true }).catch(() => {});
    return;
  }
  if (welcomeWindowId != null && welcomeHostWindowId != null && windowId === welcomeHostWindowId) {
    void chrome.windows.update(welcomeWindowId, { focused: true }).catch(() => {});
  }
}

chrome.windows.onFocusChanged.addListener(focusPopupIfHostFocused);

function resolveInitWaiters(engine) {
  const waiters = initWaiters;
  initWaiters = [];
  for (const w of waiters) w(engine);
}

async function resolveInitWithoutReady() {
  initGeneration += 1;
  await IH_localState.set({ ready: false });
  resolveInitWaiters(engineFrom(await IH_localState.get()));
}

async function refuseLocal() {
  initGeneration += 1;
  await IH_localState.set({ ready: false });
  resolveInitWaiters('local');
}

async function abandonInitWindow() {
  const id = initWindowId;
  clearInitWindowId();
  if (id == null) return;
  try {
    await chrome.windows.remove(id);
  } catch {
    /* already gone */
  }
}

async function createInitPopupWindow(create, hostId) {
  const win = await chrome.windows.create(create);
  if (win?.id == null) throw new Error('Init window create returned no id');
  assignInitWindowId(win.id, hostId);
  if (create.left == null || create.top == null) return initWindowId;
  try {
    await chrome.windows.update(win.id, { left: create.left, top: create.top, focused: true });
  } catch (err) {
    if (!IH_initWindowBounds.isBoundsError(err)) throw err;
    try {
      await chrome.windows.update(win.id, { focused: true });
    } catch (err2) {
      if (!IH_initWindowBounds.isBoundsError(err2)) throw err2;
    }
  }
  return initWindowId;
}

async function openInitWindow() {
  if (initWindowId != null) {
    try {
      await chrome.windows.update(initWindowId, { focused: true });
      notifyOptionsInitOverlay(true);
      return initWindowId;
    } catch {
      clearInitWindowId();
    }
  }
  const width = 540;
  const height = 420;
  /** @type {chrome.windows.CreateData} */
  const create = {
    url: chrome.runtime.getURL('local/init.html'),
    type: 'popup',
    width,
    height,
    focused: true,
  };
  /** @type {number | null} */
  let hostId = null;
  try {
    const host = await chrome.windows.getLastFocused();
    hostId = host?.id ?? null;
    const pos = IH_initWindowBounds.clampPopupToHost(host, width, height);
    if (pos) {
      create.left = pos.left;
      create.top = pos.top;
    }
  } catch {
    /* 没有宿主窗口时让浏览器自己放 */
  }
  try {
    return await createInitPopupWindow(create, hostId);
  } catch (err) {
    const canRetryWithoutPos =
      IH_initWindowBounds.isBoundsError(err) && create.left != null && create.top != null;
    await abandonInitWindow();
    if (!canRetryWithoutPos) throw err;
    delete create.left;
    delete create.top;
    try {
      return await createInitPopupWindow(create, hostId);
    } catch (err2) {
      await abandonInitWindow();
      throw err2;
    }
  }
}

async function openInitAndWait() {
  const windowId = await openInitWindow();
  return new Promise((resolve) => {
    initWaiters.push(resolve);
    function onRemoved(id) {
      if (id !== windowId) return;
      chrome.windows.onRemoved.removeListener(onRemoved);
      clearInitWindowId();
      void (async () => {
        const st = await IH_localState.get();
        // 下载中关掉（Hide）继续后台；已就绪则只关窗。
        // 仅本机：关窗等同拒绝，这次分析不再等。Auto / 云端不改偏好。
        if (st.ready || initBusy) return;
        if (initWaiters.length === 0) return;
        if (st.pref === IH_localState.PREF_LOCAL) {
          await refuseLocal();
          return;
        }
        await resolveInitWithoutReady();
      })();
    }
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

async function maybeOfferInitOnce() {
  const st = await IH_localState.get();
  if (st.ready) return;
  if (st.webgpuOk === false) return;
  let webgpu;
  try {
    webgpu = await probeAndStore();
  } catch (err) {
    console.warn('[Info Highlight] WebGPU probe failed', err);
    await IH_localState.set({ webgpuOk: false });
    return;
  }
  if (!webgpu) return;
  try {
    await openInitAndWait();
  } catch (err) {
    if (IH_initWindowBounds.isBoundsError(err)) {
      console.warn('[Info Highlight] Init popup bounds rejected; skip offering', err);
      return;
    }
    throw err;
  }
}

/** prepare：选项页点 Prepare。否则只有「仅本机」且权重未就绪才问。Auto 不弹。 */
async function maybeOfferInit(prepare = false) {
  if (!prepare) {
    const st = await IH_localState.get();
    if (st.pref !== IH_localState.PREF_LOCAL) return;
  }
  if (!offerLock) {
    offerLock = maybeOfferInitOnce().finally(async () => {
      offerLock = null;
      const st = await IH_localState.get();
      if (!st.ready) await closeOffscreenIfIdle();
    });
  }
  return offerLock;
}

function engineFrom(st) {
  if (st.pref === IH_localState.PREF_CLOUD) return 'cloud';
  if (st.pref === IH_localState.PREF_LOCAL) return 'local';
  return st.ready && st.webgpuOk !== false ? 'local' : 'cloud';
}

/**
 * @returns {Promise<{ tokens: unknown[], model: string, engine: 'local' | 'cloud' }>}
 */
async function fetchTokensWithAutoFallback(st, forceCloud, text, tabId, cloudModel) {
  const model = cloudModel || st.cloudModel;
  const primary = forceCloud ? 'cloud' : engineFrom(st);
  if (primary === 'cloud') {
    const got = await fetchTokens('cloud', text, model, tabId);
    return { ...got, engine: 'cloud' };
  }
  try {
    const got = await fetchTokens('local', text, model, tabId);
    return { ...got, engine: 'local' };
  } catch (err) {
    if (forceCloud || st.pref !== IH_localState.PREF_AUTO) throw err;
    if (IH_userErrors.isGpuRelated(err?.message || err)) await IH_localState.set({ webgpuOk: false });
    const got = await fetchTokens('cloud', text, model, tabId);
    return { ...got, engine: 'cloud' };
  }
}

async function resolveEngine() {
  return engineFrom(await IH_localState.get());
}

async function initEngine() {
  const st = await IH_localState.get();
  return sendToEngine({ cmd: 'init', hub: st.hub });
}

/** 选项页在开着时会实时收 ih-local-progress；这段静默重载完了也要报一声，否则页面卡在「正在下载」。 */
function notifyInitOutcome(outcome) {
  chrome.runtime.sendMessage({ type: 'ih-local-init-outcome', outcome }).catch(() => {});
}

async function fetchTokens(engine, text, cloudModel, tabId) {
  if (engine === 'local') {
    localInflight += 1;
    try {
      const status = await sendToEngine({ cmd: 'status' });
      if (!status?.ok) throw new Error(status?.error || 'local engine status failed');
      if (!status.loaded) {
        let loaded;
        try {
          loaded = await initEngine();
        } finally {
          notifyInitOutcome(loaded?.ok ? 'ok' : 'failed');
        }
        if (!loaded?.ok) throw new Error(loaded?.error || 'local model reload failed');
      }
      const res = await runLocalAnalyze(tabId, () => sendToEngine({ cmd: 'analyze', text }));
      if (!res?.ok) throw new Error(res?.error || 'local analyze failed');
      const tokens = res.result?.bpe_strings;
      if (!Array.isArray(tokens)) throw new Error('local analyze returned no tokens');
      const device = typeof res.result?.device === 'string' ? res.result.device.trim() : '';
      return { tokens, model: IH_localState.MODEL_ID, device };
    } finally {
      localInflight -= 1;
    }
  }
  const data = await postAnalyze(text, cloudModel, tabId);
  const tokens = data?.result?.bpe_strings;
  if (!Array.isArray(tokens)) throw new Error('Analyze returned no tokens');
  const raw = data?.result?.model;
  const model = typeof raw === 'string' && raw.trim() ? raw.trim() : cloudModel;
  const device = typeof data?.result?.device === 'string' ? data.result.device.trim() : '';
  return { tokens, model, device };
}

async function handleAnalyze(text, skipCache, forceCloud, tabId, cloudModel) {
  const pinned = knownCloudModel(cloudModel);
  if (pinned) forceCloud = true;
  if (!forceCloud) await maybeOfferInit();
  const st = await IH_localState.get();
  if (!forceCloud) {
    const blocked = IH_userErrors.localOnlyBlock(st);
    if (blocked) throw new Error(blocked);
  }
  let engine = forceCloud ? 'cloud' : engineFrom(st);
  let inferred = false;
  let model = engine === 'local' ? IH_localState.MODEL_ID : (pinned || st.cloudModel);
  let device = '';
  let tokens;
  try {
    tokens = await IH_analyzeCache.tokens(text, async () => {
      inferred = true;
      const got = await fetchTokensWithAutoFallback(st, forceCloud, text, tabId, pinned);
      if (got.model) model = got.model;
      if (got.device) device = got.device;
      engine = got.engine;
      return got.tokens;
    }, { skip: !!skipCache || !!pinned });
  } catch (err) {
    if (!forceCloud && st.pref === IH_localState.PREF_LOCAL) {
      if (IH_userErrors.isGpuRelated(err?.message || err)) await IH_localState.set({ webgpuOk: false });
      throw new Error(IH_userErrors.localOnlyFailure(err));
    }
    throw err;
  }
  return {
    data: {
      request: { text },
      result: {
        model,
        bpe_strings: tokens,
        ...(device ? { device } : {}),
      },
    },
    inferred,
    engine,
  };
}

/** 防止异常时钟或挂死上报炸开；约 24h。与 local-init duration 同档。 */
const MAX_DURATION_MS = 86_400_000;

function clampDurationMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), MAX_DURATION_MS);
}

/** 阶段性调试：分析结束 10s 后 offscreen 仍在（可随门面通道一起删除）。 */
async function postLocalEngineLinger(payload) {
  const body = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    event: 'unload_linger',
    loaded: !!payload.loaded,
    wait_ms: clampDurationMs(payload.wait_ms),
    blocked: payload.blocked === 'inflight' || payload.blocked === 'init' || payload.blocked === 'offer'
      ? payload.blocked
      : 'none',
  };
  const heap = Number(payload.js_heap_bytes);
  if (Number.isFinite(heap) && heap >= 0) body.js_heap_bytes = Math.round(heap);
  const client_id = await IL_getClientId().catch(() => null);
  if (client_id) body.client_id = client_id;
  IL_postKeepalive('/api/extension-local-engine', body);
}

/**
 * 上一段结束后闲置 10s：关藏页。正在推理/初始化/offer 则上报后不动。
 */
async function handleLinger(msg) {
  if (!(await hasOffscreen())) return;
  const blocked = idleBlockReason();
  void postLocalEngineLinger({
    loaded: msg?.loaded,
    js_heap_bytes: msg?.js_heap_bytes,
    wait_ms: msg?.wait_ms,
    blocked,
  });
  if (blocked !== 'none') return;
  await destroyOffscreen();
}

/** 上次已随用量上报的选项快照。没有这份键时，下一次分析会带上当前选项。 */
const OPTIONS_REPORTED_KEY = 'ih_options_reported';

function canonOptions(snap) {
  return JSON.stringify(Object.keys(snap).sort().map((k) => [k, snap[k]]));
}

/** 选项页上的选择，外加本机 WebGPU 探测。自动高亮站点只记条数。 */
async function readOptionsSnapshot() {
  const HS = IH_highlightStyle;
  const [raw, st, sites] = await Promise.all([
    chrome.storage.local.get(IH_optionDefaults),
    IH_localState.get(),
    IH_autoSites.list(),
  ]);
  const prefs = HS.normalizePrefs(raw);
  const webgpu = st.webgpuOk;
  return {
    ih_article_only: IH_optionStored('ih_article_only', raw.ih_article_only),
    show_progress: IH_optionStored('show_progress', raw.show_progress),
    show_token_tip: IH_optionStored('show_token_tip', raw.show_token_tip),
    ih_word_merge: IH_optionStored('ih_word_merge', raw.ih_word_merge),
    ih_paint_style: prefs.paintStyle,
    ih_highlight_color: prefs.highlightColor,
    ih_text_color: prefs.textColor,
    ih_max_highlight_alpha: prefs.maxAlphaDepth,
    ih_fade_min_pct: prefs.fadeMinPct,
    ih_fade_norm: prefs.fadeNorm,
    ih_fade_norm_pct: prefs.fadeNormPct,
    ih_two_tier: prefs.twoTier,
    ih_highlight_threshold_pct: prefs.thresholdPct,
    ih_analyze_pref: st.pref,
    ih_cloud_model: st.cloudModel,
    ih_model_hub: st.hub,
    ih_webgpu_ok: webgpu === true ? true : webgpu === false ? false : null,
    ih_local_ready: st.ready === true,
    auto_sites: sites.length,
  };
}

/** 与上次已报快照不同才返回；相同则 null。 */
async function changedOptionsSnapshot() {
  const snap = await readOptionsSnapshot();
  const prev = await chrome.storage.local.get(OPTIONS_REPORTED_KEY);
  const old = prev[OPTIONS_REPORTED_KEY];
  if (old && typeof old === 'object' && !Array.isArray(old) && canonOptions(old) === canonOptions(snap)) {
    return null;
  }
  return snap;
}

async function postUsageReport(body, tabId) {
  let engine = body?.engine;
  if (engine !== 'local' && engine !== 'cloud') {
    engine = await resolveEngine();
  }
  const outcome = body?.outcome;
  if (outcome !== 'ok' && outcome !== 'failed' && outcome !== 'cancelled') return;
  const segments = Math.max(0, Math.min(512, Number(body?.segments) || 0));
  if (segments < 1) return;
  const segments_ok = Math.max(0, Math.min(segments, Number(body?.segments_ok) || 0));
  const cached = Math.max(0, Math.min(segments, Number(body?.cached) || 0));
  const duration_ms = clampDurationMs(body?.duration_ms);
  const client_id = await IL_getClientId().catch(() => null);
  const model = typeof body?.model === 'string' ? body.model.trim().slice(0, 64) : '';
  const trigger = normalizeUsageTrigger(body?.trigger)
    || (tabId != null ? triggerByTab.get(tabId) : '')
    || 'other';
  const payload = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    engine,
    outcome,
    trigger,
    segments,
    segments_ok,
    cached,
    duration_ms,
  };
  if (model) payload.model = model;
  if (client_id) payload.client_id = client_id;
  if (outcome === 'failed') {
    const err = String(body?.error || body?.message || '').slice(0, 500);
    if (err) payload.error = err;
    const detail = body?.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) payload.detail = detail;
  }
  const options = await changedOptionsSnapshot();
  if (options) payload.options = options;
  IL_postKeepalive('/api/extension-usage', payload);
  if (options) await chrome.storage.local.set({ [OPTIONS_REPORTED_KEY]: options });
}

const AUTHOR_NOTE_MESSAGE_MAX = 4000;
const AUTHOR_NOTE_CONTACT_MAX = 200;

/** 选项页 About 留言。只带正文、可选联系方式和 client_id，不带页面。 */
async function postAuthorNote(msg) {
  const message = String(msg?.message ?? '').trim().slice(0, AUTHOR_NOTE_MESSAGE_MAX);
  if (!message) throw new Error('Missing message');
  const contact = String(msg?.contact ?? '').trim().slice(0, AUTHOR_NOTE_CONTACT_MAX);
  const client_id = await IL_getClientId();
  if (!client_id) throw new Error('Missing client id');
  const body = {
    message,
    extension: EXTENSION_ID,
    extension_version: chrome.runtime.getManifest().version,
    client_id,
  };
  if (contact) body.contact = contact;
  const res = await fetch(`${IL_API_BASE}/api/extension-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || data.stored === false) {
    throw new Error('Could not send');
  }
}

async function postLocalInitReport({ outcome, duration_ms, error }) {
  if (outcome !== 'ok' && outcome !== 'failed' && outcome !== 'cancelled') return;
  const st = await IH_localState.get();
  const hub =
    st.hub === IH_localState.HUB_HUGGINGFACE || st.hub === IH_localState.HUB_MODELSCOPE
      ? st.hub
      : null;
  const body = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    outcome,
    duration_ms: Math.max(0, Math.round(Number(duration_ms) || 0)),
    hub,
  };
  if (outcome !== 'ok' && error) body.error = String(error).slice(0, 500);
  const client_id = await IL_getClientId().catch(() => null);
  if (client_id) body.client_id = client_id;
  IL_postKeepalive('/api/extension-local-init', body);
}

async function handleAgree() {
  const gen = initGeneration;
  const t0 = Date.now();
  let outcome = 'ok';
  let error = null;
  const assertNotCancelled = () => {
    if (gen !== initGeneration) throw new Error('Cancelled');
  };
  initCancellable = true;
  try {
    assertNotCancelled();
    const webgpu = await probeAndStore();
    assertNotCancelled();
    if (!webgpu) throw new Error(IH_userErrors.gpuUnavailableShort());
    const res = await initEngine();
    initCancellable = false;
    if (!res?.ok) throw new Error(res?.error || 'local model init failed');
    const st = await IH_localState.get();
    const pref = st.pref === IH_localState.PREF_CLOUD ? IH_localState.PREF_AUTO : st.pref;
    await IH_localState.set({ pref, ready: true });
    await IH_analyzeCache.dropAll();
    resolveInitWaiters('local');
  } catch (err) {
    const cancelled = gen !== initGeneration || String(err?.message || err) === 'Cancelled';
    outcome = cancelled ? 'cancelled' : 'failed';
    error = cancelled ? 'Cancelled' : String(err?.message || err);
    throw cancelled ? new Error('Cancelled') : err;
  } finally {
    initCancellable = false;
    initBusy = false;
    void postLocalInitReport({ outcome, duration_ms: Date.now() - t0, error });
    notifyInitOutcome(outcome);
  }
}

async function handleStatus() {
  try {
    await probeAndStore();
  } catch {
    await IH_localState.set({ webgpuOk: false });
    await closeOffscreenIfIdle();
    return IH_localState.get();
  }
  try {
    const status = await sendToEngine({ cmd: 'status' });
    if (!status?.loaded) await closeOffscreenIfIdle();
  } catch {
    await closeOffscreenIfIdle();
  }
  return IH_localState.get();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (IL_pdfSw.handleMessage(msg, sender, sendResponse)) return true;
  if (
    msg?.type === 'ih-local-engine'
    || msg?.type === 'ih-local-progress'
    || msg?.type === 'ih-local-init-outcome'
  ) return;

  if (msg?.type === 'ih-action-state') {
    const tabId = sender.tab?.id;
    if (tabId && (msg.state === 'off' || msg.state === 'analyzing' || msg.state === 'on')) {
      IH_actionState.set(tabId, msg.state, msg.filled);
      clearBadge(tabId);
    }
    return;
  }

  if (msg?.type === 'ih-open-auto-nudge') {
    const host = IH_autoSites.parseHost(msg.host || '');
    if (host && !host.includes('*')) {
      void openNudgeWindow(host).finally(() => sendResponse());
      return true;
    }
    return;
  }

  if (msg?.type === 'ih-open-welcome') {
    openWelcomeWindow(sender.tab?.windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-local-linger') {
    handleLinger(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-local-status') {
    handleStatus()
      .then((data) => sendResponse({ ok: true, ...data, initOverlay: initWindowId != null }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-set-pref') {
    const pref = IH_localState.normalizePref(msg.pref);
    (async () => {
      if (pref === IH_localState.PREF_LOCAL) {
        const webgpu = await probeAndStore();
        if (!webgpu) throw new Error(IH_userErrors.setLocalPrefBlocked());
      }
      const prev = await resolveEngine();
      await IH_localState.set({ pref });
      if ((await resolveEngine()) !== prev) await IH_analyzeCache.dropAll();
      if (pref === IH_localState.PREF_LOCAL) await maybeOfferInit();
      sendResponse({ ok: true, pref });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-set-cloud-model') {
    const cloudModel = IH_localState.normalizeCloudModel(msg.model);
    (async () => {
      const prev = (await IH_localState.get()).cloudModel;
      await IH_localState.set({ cloudModel });
      if (cloudModel !== prev) await IH_analyzeCache.dropAll();
      sendResponse({ ok: true, cloudModel });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-set-hub') {
    const hub = IH_localState.normalizeHub(msg.hub);
    (async () => {
      const st = await IH_localState.get();
      if (st.hub !== hub) {
        await dropLocalModel();
        await IH_localState.set({ hub });
      }
      sendResponse({ ok: true, hub });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-open-init') {
    maybeOfferInit(true)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-agree') {
    initBusy = true;
    handleAgree()
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        const cancelled = String(err?.message || err) === 'Cancelled';
        if (!cancelled) {
          try {
            await resolveInitWithoutReady();
          } catch {
            resolveInitWaiters('cloud');
          }
        }
        sendResponse({ ok: false, cancelled, error: String(err?.message || err) });
      });
    return true;
  }
  if (msg?.type === 'ih-local-cancel-init') {
    cancelLocalInit()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-drop-model') {
    dropLocalModel()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-open-highlight-options') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '#highlight' });
    return;
  }

  if (msg?.type === 'ih-usage-report') {
    postUsageReport(msg, sender.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-author-note') {
    postAuthorNote(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'il-extension-feedback') {
    IL_postKeepalive(
      '/api/extension-feedback',
      {
        ...(msg.body && typeof msg.body === 'object' ? msg.body : {}),
        extension: EXTENSION_ID,
        extension_version: chrome.runtime.getManifest().version,
      },
    );
    return;
  }

  if (msg?.type !== 'ih-analyze') return;
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (!text) {
    sendResponse({ ok: false, error: 'Missing text' });
    return;
  }
  handleAnalyze(text, !!msg.skipCache, false, sender.tab?.id, msg.cloudModel)
    .then(({ data, inferred, engine }) => sendResponse({ ok: true, data, inferred, engine }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
