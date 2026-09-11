/**
 * 工具栏点击 → 注入 content（activeTab 手势）。已注入则 toggle。
 * 分析：SW fetch IH_CONFIG.apiBase/api/analyze（prod / 本机由 config.js 决定；依赖服务端 CORS，无 API host_permissions）。
 * PDF：整条流程在 pdf/sw.js（共享），本文件只负责在网页管线里的何处插入它。
 */

importScripts('sw/restricted-url.js');
importScripts('config.js');
importScripts('pdf/stash-db.js');
importScripts('pdf/sw.js');

if (!globalThis.IH_CONFIG || typeof IH_CONFIG.apiBase !== 'string' || !IH_CONFIG.apiBase) {
  throw new Error('IH_CONFIG.apiBase missing — inject config.js before background.js');
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
  'page-map.js',
  'tokenTip.js',
  'cache/ring-store.js',
  'analyzeCache.js',
  'content.js',
];

async function toggleIfInjected(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const api = window.__IH_DEMO__;
        if (!api) return false;
        api.toggle();
        return true;
      },
    });
    return !!results?.[0]?.result;
  } catch {
    return false;
  }
}

async function injectOnce(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId, frameIds: [0] },
    files: CONTENT_CSS,
  });
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: CONTENT_JS,
  });
}

async function activateTab(tab) {
  if (!tab?.id) return;
  // optional file:// request 必须在手势同步阶段启动；前面不能有 await
  const fileHostPromise = IL_pdfSw.isFileUrl(tab.url) ? IL_pdfSw.requestFileHostFromGesture() : null;
  const fresh = await chrome.tabs.get(tab.id);
  const url = fresh.url || tab.url || '';
  if (IL_pdfSw.isOwnViewerUrl(url)) {
    chrome.runtime.sendMessage({ type: 'ih-pdf-toggle', tabId: tab.id }, () => {
      void chrome.runtime.lastError;
    });
    return;
  }
  if (IL_isRestrictedUrl(url)) {
    console.warn('[Info Highlight] cannot run on this page:', url);
    return;
  }
  if (!(await IL_pdfSw.ensureFileUrlAccess(url, fileHostPromise)).ok) return;
  if (IL_pdfSw.isPdfUrl(url)) {
    await IL_pdfSw.injectEntry(tab.id);
    return;
  }
  // 无 .pdf 后缀时先由页内按 Content-Type / 魔数确认，再退回网页管线
  if (await IL_pdfSw.injectEntryAndOffered(tab.id)) return;
  if (await toggleIfInjected(tab.id)) return;
  await injectOnce(tab.id);
}

chrome.action.onClicked.addListener((tab) => {
  activateTab(tab).catch((err) => {
    console.error('[Info Highlight] activate failed', err);
  });
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
      body: JSON.stringify({ model: 'default', text }),
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (IL_pdfSw.handleMessage(msg, sender, sendResponse)) return true;

  if (msg?.type !== 'ih-analyze') return;
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (!text) {
    sendResponse({ ok: false, error: 'Missing text' });
    return;
  }
  postAnalyze(text)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
