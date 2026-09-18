/**
 * 工具栏点击 / 右键菜单 → 注入 content（activeTab 手势）。已注入则 toggle。
 * 分析：本机 WebGPU（已就绪）或 IH_CONFIG.apiBase/api/analyze。
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
importScripts('init-window-bounds.js');
importScripts('action-state.js');

const EXTENSION_ID = 'info-highlight';

if (!globalThis.IH_CONFIG || typeof IH_CONFIG.apiBase !== 'string' || !IH_CONFIG.apiBase) {
  throw new Error('IH_CONFIG.apiBase missing — inject config.js before background.js');
}
if (!globalThis.IH_localState) throw new Error('IH_localState missing');
if (!globalThis.IH_analyzeCache) throw new Error('IH_analyzeCache missing');
if (!globalThis.IH_initWindowBounds) throw new Error('IH_initWindowBounds missing');
if (!globalThis.IH_actionState) throw new Error('IH_actionState missing');
if (!globalThis.IH_autoSites) throw new Error('IH_autoSites missing');

if (IL_reportsEnabled(IH_CONFIG)) {
  IL_prepareClientIdReporting(EXTENSION_ID, IH_CONFIG.apiBase);
}

function analyzeUrl() {
  return `${String(IH_CONFIG.apiBase).replace(/\/$/, '')}/api/analyze`;
}

const CONTENT_CSS = ['content.css'];
const CONTENT_JS = [
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
  'highlightStyle.js',
  'page-map.js',
  'tokenTip.js',
  'analyzeRun.js',
  'content.js',
];

/**
 * 已注入则调页内 API；未注入返回 false（注入后要再调一次，content.js 不自启）。
 * @param {'toggle' | 'start'} method
 * @returns {Promise<false | true | 'busy' | 'painted'>} start 的 'busy' / 'painted' = 页内已有一轮在跑 / 已画好
 */
async function callPageApi(tabId, method) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      args: [method],
      func: (m) => {
        const api = window.__IH_DEMO__;
        if (!api) return false;
        if (m === 'start') return api.start();
        api[m]();
        return true;
      },
    });
    return results?.[0]?.result ?? false;
  } catch {
    return false;
  }
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

async function activateTab(tab) {
  if (!tab?.id) return;
  // optional file:// request 必须在手势同步阶段启动；前面不能有 await
  const fileHostPromise = IL_pdfSw.isFileUrl(tab.url) ? IL_pdfSw.requestFileHostFromGesture() : null;
  IL_setActionIconDotted(false);
  if (IH_actionState.shouldIgnoreClick(tab.id)) return;
  try {
    const fresh = await chrome.tabs.get(tab.id);
    const url = fresh.url || tab.url || '';
    if (IL_pdfSw.isOwnViewerUrl(url)) {
      IH_actionState.markAnalyzingIfIdle(tab.id);
      chrome.runtime.sendMessage({ type: 'ih-pdf-toggle', tabId: tab.id }, () => {
        void chrome.runtime.lastError;
      });
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
      await IL_pdfSw.injectEntry(tab.id);
      clearBadge(tab.id);
      return;
    }
    // 无 .pdf 后缀时先由页内按 Content-Type / 魔数确认，再退回网页管线
    if (await IL_pdfSw.injectEntryAndOffered(tab.id)) {
      clearBadge(tab.id);
      return;
    }
    IH_actionState.markAnalyzingIfIdle(tab.id);
    manualTabs.add(tab.id);
    if (await callPageApi(tab.id, 'toggle')) {
      clearBadge(tab.id);
      return;
    }
    IH_actionState.set(tab.id, 'analyzing');
    const okTab = await IL_injectWithRetry(tab.id, { css: CONTENT_CSS, js: CONTENT_JS }, {
      logLabel: 'Info Highlight',
      waitComplete: false,
    });
    await callPageApi(tab.id, 'toggle');
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
const AUTO_MENU_ID = 'ih-auto-site';
const ANALYZE_MENU_TITLE = 'Analyze this page';

function autoMenuTitle(host, on) {
  return on ? `Stop always analyzing ${host}` : `Always analyze ${host}`;
}

/** 开始加载后等一会再做尝试轮：太早正文还没出来，白跑一趟 */
const AUTO_LOADING_DELAY_MS = 1500;
/** 人工点过图标的标签：自动分析别再插手，直到下次导航 */
const manualTabs = new Set();
/** tabId -> 导航代数；reset 时 +1，过期的自动分析不再改状态 */
const autoGenByTab = new Map();

/**
 * 无 tabs 权限时只看得见已授权站点的 url；看不见即未授权，正好是要显示「添加」的情形。
 * @param {number} tabId
 */
async function syncAutoMenu(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const host = IH_autoSites.hostOf(tab?.url || '');
  if (!host) {
    // 看不见 url（未授权）或非 http(s)：标题用不到，点下去才从 pageUrl 取 host
    chrome.contextMenus.update(AUTO_MENU_ID, { title: 'Always analyze this site' }, () => {
      void chrome.runtime.lastError;
    });
    return;
  }
  const on = await IH_autoSites.hasExact(host);
  chrome.contextMenus.update(AUTO_MENU_ID, { title: autoMenuTitle(host, on) }, () => {
    void chrome.runtime.lastError;
  });
}

async function toggleAutoSite(info, tabId) {
  // 菜单项限定 http(s)，取不到 host 说明有别的问题
  const host = IH_autoSites.hostOf(info.pageUrl || '');
  if (!host) throw new Error(`auto-site menu on unsupported url: ${info.pageUrl || '(none)'}`);
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

/** 导航开始：丢掉本页自动分析进度，否则 analyzing 会挡住下一页 */
function resetAutoForTab(tabId) {
  manualTabs.delete(tabId);
  autoGenByTab.set(tabId, (autoGenByTab.get(tabId) || 0) + 1);
  if (IH_actionState.get(tabId) !== 'off') IH_actionState.set(tabId, 'off');
}

/**
 * 命中名单的前台标签即可分析。PDF / file: 不进。
 * 重复触发是幂等的：页内已在跑返回 'busy'、已画好返回 'painted'，都不动它。
 * 加载中失败由页内按 readyState 决定静默与否；这里的注入失败同理，看 tab.status。
 * @param {number} tabId
 */
async function maybeAutoAnalyze(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active || manualTabs.has(tabId)) return;
  const url = tab.url || '';
  const host = IH_autoSites.hostOf(url);
  if (!host || IL_isRestrictedUrl(url) || IL_pdfSw.isPdfUrl(url)) return;
  if (!(await IH_autoSites.granted(host))) return;
  const gen = autoGenByTab.get(tabId) || 0;
  const stillCurrent = () => (autoGenByTab.get(tabId) || 0) === gen;
  try {
    const started = await callPageApi(tabId, 'start');
    if (!stillCurrent()) return;
    if (started === 'busy') return;
    if (started === 'painted') {
      IH_actionState.set(tabId, 'on');
      clearBadge(tabId);
      return;
    }
    if (!started) {
      // 注入要等一会，先把图标切成分析中；已注入的那条路由页内自己上报
      IH_actionState.set(tabId, 'analyzing');
      await IL_injectWithRetry(tabId, { css: CONTENT_CSS, js: CONTENT_JS }, {
        logLabel: 'Info Highlight auto',
        waitComplete: false,
        isStale: () => !stillCurrent(),
      });
      if (!stillCurrent()) return;
      await callPageApi(tabId, 'start');
    }
    if (!stillCurrent()) return;
    clearBadge(tabId);
  } catch (err) {
    if (!stillCurrent()) return;
    IH_actionState.set(tabId, 'off');
    if (String(err?.message || err).includes('navigation superseded')) return;
    console.error('[Info Highlight] auto inject failed', err);
    // 加载中注入失败多半是 frame 还没就绪，下一轮还会来；加载完了还失败才值得提示
    const fresh = await chrome.tabs.get(tabId).catch(() => null);
    if (fresh?.status === 'complete') await setBadgeError(tabId, 'inject');
  }
}

chrome.action.onClicked.addListener((tab) => {
  void activateTab(tab);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncAutoMenu(tabId);
  void maybeAutoAnalyze(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 整页开始加载才 reset。地址变了（DOM 往往也变）与 complete 之后正文变了同一回事：不自动跟。
  if (changeInfo.status === 'loading') resetAutoForTab(tabId);
  if (tab.active && (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
    void syncAutoMenu(tabId);
  }
  if (changeInfo.status === 'complete') {
    // 定稿：已在跑/已画完则在 complete 核对正文；之后不再核
    void (async () => {
      await maybeAutoAnalyze(tabId);
      await maybeRecheckContent(tabId);
    })();
    return;
  }
  if (changeInfo.status !== 'loading') return;
  // 加载中先试一次：正文往往已在，没出来也不打扰，等 complete 再来
  const gen = autoGenByTab.get(tabId) || 0;
  setTimeout(() => {
    if ((autoGenByTab.get(tabId) || 0) !== gen) return;
    void maybeAutoAnalyze(tabId);
  }, AUTO_LOADING_DELAY_MS);
});

/** complete 时：页内已有分析则对比正文，变了清掉重跑（重复段走缓存）。 */
async function maybeRecheckContent(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const api = window.__IH_DEMO__;
        if (!api || typeof api.recheck !== 'function') return null;
        return api.recheck();
      },
    });
    if (results?.[0]?.result === 'rerun') {
      console.info('[Info Highlight] complete recheck: article text changed, re-analyzing');
    }
  } catch {
    /* 未注入或无权 */
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  IH_actionState.clear(tabId);
  manualTabs.delete(tabId);
  autoGenByTab.delete(tabId);
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: ANALYZE_MENU_TITLE,
      contexts: ['page', 'selection'],
    });
    chrome.contextMenus.create({
      id: AUTO_MENU_ID,
      title: 'Always analyze this site',
      contexts: ['page', 'selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  });

  void IL_optionsAttention.onInstalled(details, IL_OPTIONS_CATALOG);
  IL_setActionIconDotted(true);
  if (IL_reportsEnabled(IH_CONFIG)) {
    IL_reportInstallOrUpdate(details, EXTENSION_ID, IH_CONFIG.apiBase);
  }
  if (details.reason === 'install') {
    void chrome.tabs.create({
      url: chrome.runtime.getURL('options.html') + '?prepare=1',
    });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  // 用过菜单也算用过插件；Chrome 右键工具栏图标本身不发事件，只能在这里灭蓝点
  IL_setActionIconDotted(false);
  if (info.menuItemId === CONTEXT_MENU_ID) void activateTab(tab);
  // permissions.request 要手势，toggleAutoSite 里首句就发，别在这之前 await
  else if (info.menuItemId === AUTO_MENU_ID) void toggleAutoSite(info, tab.id);
});

const ERROR_BODY_SNIPPET = 500;

function isJsonContentType(contentTypeHeader) {
  const ct = (contentTypeHeader || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json' || ct.endsWith('+json');
}

/** POST /api/analyze；站点成功体无 success=true，仅 success===false 视为失败。 */
async function postAnalyze(text) {
  const url = analyzeUrl();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'default',
        text,
        privacy_mode: IH_CONFIG.privacyMode !== false,
      }),
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(msg)) {
      throw new Error(`Cannot reach ${IH_CONFIG.apiBase}`);
    }
    throw err;
  }
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

async function sendToEngine(payload) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ type: 'ih-local-engine', ...payload });
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

/** 焦点回到打开 Prepare 时的宿主窗 → 再把 Prepare 拉到前面 */
function focusInitIfHostFocused(windowId) {
  if (initWindowId == null || initHostWindowId == null) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (windowId === initWindowId) return;
  if (windowId !== initHostWindowId) return;
  void chrome.windows.update(initWindowId, { focused: true }).catch(() => {});
}

chrome.windows.onFocusChanged.addListener(focusInitIfHostFocused);

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
  const st = await IH_localState.get();
  if (st.pref === IH_localState.PREF_LOCAL) {
    await IH_localState.set({ ready: false });
    resolveInitWaiters('local');
    return;
  }
  await IH_localState.set({ pref: IH_localState.PREF_CLOUD, ready: false });
  resolveInitWaiters('cloud');
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
        // 下载中关掉（Hide）继续后台；已就绪则只关窗。其余等同拒绝，避免下一段分析再弹。
        if (st.ready || initBusy) return;
        if (initWaiters.length === 0) return;
        await refuseLocal();
      })();
    }
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

async function maybeOfferInitOnce() {
  const st = await IH_localState.get();
  if (st.pref === IH_localState.PREF_CLOUD) return;
  if (st.ready) return;
  if (st.webgpuOk === false) return;
  let webgpu;
  try {
    webgpu = await probeAndStore();
  } catch (err) {
    console.warn('[Info Highlight] WebGPU probe failed', err);
    await IH_localState.set({ webgpuOk: false });
    if (st.pref === IH_localState.PREF_LOCAL) {
      throw new Error(
        `On-device WebGPU probe failed: ${String(err?.message || err)}. On-device only is selected, so cloud will not be used.`,
      );
    }
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

function maybeOfferInit() {
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
  return st.ready ? 'local' : 'cloud';
}

function localOnlyBlockReason(st) {
  if (st.pref !== IH_localState.PREF_LOCAL) return '';
  if (st.webgpuOk === false) {
    return 'On-device WebGPU is unavailable. On-device only is selected, so cloud will not be used.';
  }
  if (!st.ready) {
    return 'On-device model is not ready. On-device only is selected, so cloud will not be used. Prepare the on-device model first.';
  }
  return '';
}

async function resolveEngine() {
  return engineFrom(await IH_localState.get());
}

async function initEngine() {
  const st = await IH_localState.get();
  return sendToEngine({ cmd: 'init', hub: st.hub });
}

async function fetchTokens(engine, text) {
  if (engine === 'local') {
    localInflight += 1;
    try {
      const status = await sendToEngine({ cmd: 'status' });
      if (!status?.ok) throw new Error(status?.error || 'local engine status failed');
      if (!status.loaded) {
        const loaded = await initEngine();
        if (!loaded?.ok) throw new Error(loaded?.error || 'local model reload failed');
      }
      const res = await sendToEngine({ cmd: 'analyze', text });
      if (!res?.ok) throw new Error(res?.error || 'local analyze failed');
      const tokens = res.result?.bpe_strings;
      if (!Array.isArray(tokens)) throw new Error('local analyze returned no tokens');
      return tokens;
    } finally {
      localInflight -= 1;
    }
  }
  const data = await postAnalyze(text);
  const tokens = data?.result?.bpe_strings;
  if (!Array.isArray(tokens)) throw new Error('Analyze returned no tokens');
  return tokens;
}

async function handleAnalyze(text) {
  await maybeOfferInit();
  const st = await IH_localState.get();
  const blocked = localOnlyBlockReason(st);
  if (blocked) throw new Error(blocked);
  const engine = engineFrom(st);
  let inferred = false;
  let tokens;
  try {
    tokens = await IH_analyzeCache.tokens(text, async () => {
      inferred = true;
      return fetchTokens(engine, text);
    });
  } catch (err) {
    if (st.pref === IH_localState.PREF_LOCAL) {
      throw new Error(`On-device analysis failed: ${String(err?.message || err)}`);
    }
    throw err;
  }
  return {
    data: {
      request: { text },
      result: {
        model: engine === 'local' ? IH_localState.MODEL_ID : undefined,
        bpe_strings: tokens,
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
  if (!IL_reportsEnabled(IH_CONFIG)) return;
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
  const client_id = await IL_getClientId(IH_CONFIG.apiBase).catch(() => null);
  if (client_id) body.client_id = client_id;
  IL_postKeepalive('/api/extension-local-engine', body, IH_CONFIG.apiBase);
}

/**
 * 上一段结束后闲置 10s：写 KV 并关藏页。正在推理/初始化则当新任务，不动。
 */
async function handleLinger(msg) {
  if (localInflight > 0 || initBusy) return;
  if (!(await hasOffscreen())) return;
  const blocked = idleBlockReason();
  void postLocalEngineLinger({
    loaded: msg?.loaded,
    js_heap_bytes: msg?.js_heap_bytes,
    wait_ms: msg?.wait_ms,
    blocked,
  });
  await destroyOffscreen();
}

/** 阶段性调试：分析失败原因（可随门面通道一起删除）。不写入 /api/extension-usage。 */
async function postAnalysisFailReport({ engine, error, segments, duration_ms, detail }) {
  if (!IL_reportsEnabled(IH_CONFIG)) return;
  const msg = String(error || '').slice(0, 500);
  if (!msg) return;
  const body = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    outcome: 'failed',
    error: msg,
    duration_ms: clampDurationMs(duration_ms),
  };
  if (engine === 'local' || engine === 'cloud') body.engine = engine;
  const n = Math.max(0, Math.min(512, Number(segments) || 0));
  if (n >= 1) body.segments = n;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) body.detail = detail;
  IL_postKeepalive('/api/extension-analysis-fail', body, IH_CONFIG.apiBase);
}

async function postUsageReport(body) {
  if (!IL_reportsEnabled(IH_CONFIG)) return;
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
  const client_id = await IL_getClientId(IH_CONFIG.apiBase).catch(() => null);
  // 正式用量 POST 只计数字段；error/detail 不得进入 keepalive body
  const payload = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    engine,
    outcome,
    segments,
    segments_ok,
    cached,
    duration_ms,
  };
  if (client_id) payload.client_id = client_id;
  IL_postKeepalive('/api/extension-usage', payload, IH_CONFIG.apiBase);
  if (outcome === 'failed') {
    void postAnalysisFailReport({
      engine,
      error: body?.error || body?.message,
      segments,
      duration_ms,
      detail: body?.detail,
    });
  }
}

async function postLocalInitReport({ outcome, duration_ms, error }) {
  if (!IL_reportsEnabled(IH_CONFIG)) return;
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
  IL_postKeepalive('/api/extension-local-init', body, IH_CONFIG.apiBase);
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
    if (!webgpu) throw new Error('WebGPU is unavailable');
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
    chrome.runtime.sendMessage({ type: 'ih-local-init-outcome', outcome }).catch(() => {});
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
      IH_actionState.set(tabId, msg.state);
      clearBadge(tabId);
    }
    return;
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
      const prev = await resolveEngine();
      await IH_localState.set({ pref });
      if ((await resolveEngine()) !== prev) await IH_analyzeCache.dropAll();
      sendResponse({ ok: true, pref });
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
    maybeOfferInit()
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
  if (msg?.type === 'ih-local-refuse') {
    refuseLocal()
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

  if (msg?.type === 'ih-usage-report') {
    postUsageReport(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type !== 'ih-analyze') return;
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (!text) {
    sendResponse({ ok: false, error: 'Missing text' });
    return;
  }
  handleAnalyze(text)
    .then(({ data, inferred, engine }) => sendResponse({ ok: true, data, inferred, engine }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
