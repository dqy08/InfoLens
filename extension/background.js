/**
 * 工具栏点击 → 注入 content（activeTab 手势）。
 * API 走 SW fetch：不声明 host_permissions，依赖服务端 CORS（见 run.py CORSMiddleware）。
 */

importScripts('config.js');

const CONTENT_CSS = ['content.css'];
const CONTENT_JS = [
  'config.js',
  'vendor/Readability.js',
  'articleRoot.js',
  'collectTextMap.js',
  'splitTextToChunks.js',
  'mergeTokenSpans.js',
  'content.js',
];

function isRestrictedUrl(url) {
  if (!url) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const proto = u.protocol;
  if (
    proto === 'chrome:' ||
    proto === 'chrome-extension:' ||
    proto === 'chrome-search:' ||
    proto === 'chrome-untrusted:' ||
    proto === 'devtools:' ||
    proto === 'edge:' ||
    proto === 'about:' ||
    proto === 'view-source:'
  ) {
    return true;
  }
  // Chrome PDF viewer / Web Store：主 frame 常无法注入
  if (proto === 'file:' && /\.pdf$/i.test(u.pathname)) return true;
  if (/\.pdf$/i.test(u.pathname)) return true;
  if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
  if (u.hostname === 'chromewebstore.google.com') return true;
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等到 status=complete；已 complete 则立即返回最新 tab */
async function waitTabComplete(tabId, timeoutMs = 20000) {
  const cur = await chrome.tabs.get(tabId);
  if (cur.status === 'complete') return cur;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`tab ${tabId} load timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.get(tabId).then(resolve, reject);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function isTransientFrameError(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes('Frame with ID') ||
    msg.includes('No frame with id') ||
    msg.includes('Frame does not exist') ||
    msg.includes('The tab was closed') ||
    msg.includes('cannot be scripted now')
  );
}

async function injectOnce(tabId) {
  // 显式 frameIds:[0]，避免对已消失子 frame 误操作；主文档未就绪时由上层重试
  await chrome.scripting.insertCSS({
    target: { tabId, frameIds: [0] },
    files: CONTENT_CSS,
  });
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: CONTENT_JS,
  });
}

async function injectWithRetry(tabId) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const tab = await waitTabComplete(tabId);
      if (isRestrictedUrl(tab.url)) {
        throw new Error(`restricted page: ${tab.url || '(no url)'}`);
      }
      // 丢弃休眠的 tab：先激活再注
      if (tab.discarded) {
        await chrome.tabs.reload(tabId);
        await waitTabComplete(tabId);
      }
      await injectOnce(tabId);
      return tab;
    } catch (err) {
      lastErr = err;
      if (!isTransientFrameError(err) || attempt === 4) throw err;
      console.warn(`[InfoLens] inject attempt ${attempt} failed, retry…`, err?.message || err);
      await sleep(100 * attempt);
    }
  }
  throw lastErr;
}

async function setBadgeError(brief) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: `InfoLens: ${brief}` });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'InfoLens Semantic Find' });
    }, 5000);
  } catch {
    /* ignore */
  }
}

async function activateTab(tab) {
  if (!tab?.id) return;

  // 手势当下立刻读一次 url；无 url 时仍尝试 get（activeTab 授权后）
  try {
    const fresh = await chrome.tabs.get(tab.id);
    if (isRestrictedUrl(fresh.url || tab.url)) {
      const url = fresh.url || tab.url || '(empty)';
      console.warn('[InfoLens] cannot run on this page:', url);
      await setBadgeError('bad page');
      return;
    }

    const okTab = await injectWithRetry(tab.id);
    console.info('[InfoLens] injected into', okTab.url);
    await chrome.action.setBadgeText({ text: '' });
  } catch (err) {
    console.error('[InfoLens] inject failed', err);
    console.error('[InfoLens] tip: use a normal http(s) article tab (not chrome://, PDF, Web Store); reload extension, then click again after the page finishes loading.');
    await setBadgeError('inject');
  }
}

chrome.action.onClicked.addListener(activateTab);

/**
 * POST JSON；要求 HTTP ok 且 body.success === true（避免 2xx HTML/空对象被当成成功）。
 * @returns {{ data: object, backend: string | null }} backend = X-Infolens-Backend（hf|accel）
 */
async function postJsonApi(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}: invalid JSON`);
  }
  if (!res.ok || data?.success !== true) {
    const detail = data?.message || data?.detail || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const backend = res.headers.get('X-Infolens-Backend');
  return { data, backend: backend || null };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'il-analyze-semantic') {
    (async () => {
      try {
        const apiBase = msg.apiBase || IL_CONFIG.apiBase;
        const path = msg.path || '/api/analyze-semantic';
        const { data, backend } = await postJsonApi(
          `${String(apiBase).replace(/\/$/, '')}${path}`,
          msg.body
        );
        sendResponse({ ok: true, data, backend });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'il-extension-feedback') {
    (async () => {
      try {
        const apiBase = msg.apiBase || IL_CONFIG.apiBase;
        const body = {
          ...(msg.body && typeof msg.body === 'object' ? msg.body : {}),
          extension_version: chrome.runtime.getManifest().version,
        };
        const { data } = await postJsonApi(
          `${String(apiBase).replace(/\/$/, '')}/api/extension-feedback`,
          body
        );
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
});
