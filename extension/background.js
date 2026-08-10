/**
 * 工具栏点击 / 快捷键 / 右键菜单 → 注入 content（activeTab 手势）。
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

/**
 * @param {chrome.tabs.Tab} tab
 * @param {{ query?: string }} [opts] query：右键选区预填，不自动搜
 */
async function activateTab(tab, opts = {}) {
  if (!tab?.id) return;
  const query = typeof opts.query === 'string' ? opts.query.trim() : '';

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
    if (query) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: (q) => {
          window.__IL_SEMANTIC_DEMO__?.open(q);
        },
        args: [query],
      });
    }
    await chrome.action.setBadgeText({ text: '' });
  } catch (err) {
    console.error('[InfoLens] inject failed', err);
    console.error('[InfoLens] tip: use a normal http(s) article tab (not chrome://, PDF, Web Store); reload extension, then click again after the page finishes loading.');
    await setBadgeError('inject');
  }
}

const CONTEXT_MENU_ID = 'il-semantic-search';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: chrome.i18n.getMessage('contextMenuSearch') || 'Search with Semantic Highlight',
      contexts: ['page', 'selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
  void activateTab(tab, {
    query: info.selectionText || '',
  });
});

chrome.action.onClicked.addListener((tab) => activateTab(tab));

const ERROR_BODY_SNIPPET = 500;

/** @param {string} contentTypeHeader */
function isJsonContentType(contentTypeHeader) {
  const ct = (contentTypeHeader || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json' || ct.endsWith('+json');
}

/**
 * @param {string} message 用户可见
 * @param {string} [detail] 仅反馈
 */
function apiHttpError(message, detail) {
  const err = new Error(message);
  if (detail != null && String(detail).trim()) err.errorDetail = String(detail).trim();
  return err;
}

/**
 * POST JSON；要求 HTTP ok 且 body.success === true（避免 2xx HTML/空对象被当成成功）。
 * 先读正文；仅 Content-Type 为 JSON 时再 parse（平台 HTML 错误页等在 parse 前失败）。
 * @returns {{ data: object, backend: string | null }} backend = X-Infolens-Backend（hf|accel）
 */
async function postJsonApi(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const ctHeader = res.headers.get('Content-Type') || '';
  const ct = ctHeader.split(';')[0].trim().toLowerCase() || '(none)';
  const snippet =
    raw.length <= ERROR_BODY_SNIPPET ? raw : raw.slice(0, ERROR_BODY_SNIPPET - 1) + '…';

  if (!raw.trim()) {
    throw apiHttpError(`HTTP ${res.status}: empty response`);
  }
  if (!isJsonContentType(ctHeader)) {
    throw apiHttpError(`HTTP ${res.status}: expected application/json, got ${ct}`, snippet);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const why = e && e.message ? String(e.message) : 'parse failed';
    throw apiHttpError(`HTTP ${res.status}: malformed JSON (${why})`, snippet);
  }

  if (!res.ok || data?.success !== true) {
    const message = data?.message || data?.detail || `HTTP ${res.status}`;
    const detail =
      data?.error_detail != null && String(data.error_detail).trim()
        ? String(data.error_detail).trim()
        : undefined;
    throw apiHttpError(message, detail);
  }
  const backend = res.headers.get('X-Infolens-Backend');
  return { data, backend: backend || null };
}

/**
 * 逐行消费 SSE 流：每 `data: {json}` 行回调一次事件对象。
 * 支持任意字节分块、帧跨块、残留冲刷、[DONE]。
 * @param {Response} res
 * @param {(ev: object) => void} onEvent
 * @param {AbortSignal} [signal]
 */
async function streamSse(res, onEvent, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const processLine = (line) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const payload = s.slice(5).trim();
    if (payload === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object') onEvent(parsed);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const l of lines) processLine(l);
  }
  if (buffer.trim()) processLine(buffer);
}

/**
 * 流式 relevance v2 通道：content 用 chrome.runtime.connect('relevance-stream') 建长连接，
 * 先 postMessage 请求；background fetch SSE，逐条事件（type:row/type:result/type:error）
 * 经 port.postMessage 推送，结束/出错时 disconnect。
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port?.name !== 'relevance-stream') return;
  const ac = new AbortController();
  let started = false;
  port.onMessage.addListener((msg) => {
    if (started) return;
    started = true;
    (async () => {
      try {
        const apiBase = msg?.apiBase || (typeof IL_CONFIG !== 'undefined' ? IL_CONFIG.apiBase : undefined);
        const path = msg?.path || '/api/v2/analyze-semantic-relevance';
        const res = await fetch(`${String(apiBase).replace(/\/$/, '')}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg?.body || {}),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          port.postMessage({
            type: 'error',
            success: false,
            kind: 'network',
            message: `HTTP ${res.status}`,
            error_detail: detail.slice(0, 500),
          });
          port.disconnect();
          return;
        }
        await streamSse(
          res,
          (ev) => {
            try {
              port.postMessage(ev);
            } catch {
              /* port 已断 */
            }
          },
          ac.signal
        );
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        console.error('[InfoLens][bg] relevance stream error:', err?.message, err);
        try {
          port.postMessage({
            type: 'error',
            success: false,
            kind: 'network',
            message: String(err?.message || err),
          });
          port.disconnect();
        } catch {
          /* ignore */
        }
      }
    })();
  });
  port.onDisconnect.addListener(() => ac.abort());
});

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
        const payload = { ok: false, error: String(err?.message || err) };
        if (err?.errorDetail) payload.error_detail = String(err.errorDetail);
        sendResponse(payload);
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
