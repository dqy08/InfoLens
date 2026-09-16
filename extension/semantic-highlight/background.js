/**
 * 工具栏点击 / 快捷键 / 右键菜单 → 注入 content（activeTab 手势）。
 * 语义 API：SW fetch，依赖服务端 CORS（见 run.py CORSMiddleware）。
 * PDF：整条流程在 pdf/sw.js（共享），本文件只负责在网页管线里的何处插入它。
 */

importScripts('sw/restricted-url.js');
importScripts('sw/install-dot.js');
importScripts('sw/lifecycle-events.js');
importScripts('sw/inject.js');
importScripts('config.js');
importScripts('pdf/stash-db.js');
importScripts('pdf/sw.js');

const EXTENSION_ID = 'semantic-highlight';

const CONTENT_CSS = ['content.css'];
const CONTENT_JS = [
  'config.js',
  'vendor/Readability.js',
  'extractRootPatches.js',
  'articleRoot.js',
  'collectTextMap.js',
  'splitTextToChunks.js',
  'textIndex.js',
  'scrollGeometry.js',
  'progressAxis.js',
  'overlay.js',
  'semantic/page-document.js',
  'cache/ring-store.js',
  'semantic/analyzeCache.js',
  'semantic/find.js',
  'content.js',
];

/** 页内已有实例则只 open（叉掉后再点只是显示，不重注入） */
async function openIfInjected(tabId, query) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (q) => {
        const api = window.__IL_SEMANTIC_DEMO__;
        if (!api) return false;
        api.open(q || undefined);
        return true;
      },
      args: [typeof query === 'string' ? query : ''],
    });
    return !!results?.[0]?.result;
  } catch {
    return false;
  }
}

function clearBadge(tabId) {
  void chrome.action.setBadgeText({ text: '', tabId });
  void chrome.action.setTitle({ title: 'InfoLens Semantic Find', tabId });
}

async function setBadgeError(tabId, brief) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#c0392b', tabId });
    await chrome.action.setBadgeText({ text: '!', tabId });
    await chrome.action.setTitle({ title: `InfoLens: ${brief}`, tabId });
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
  // query：普通网页 / 自家 PDF viewer 预填浮条；Chrome PDF 宿主页只出入口按钮（无浮条）
  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  let freshUrl = tab.url || '';

  // optional file:// request 必须在手势同步阶段启动；前面不能有 await
  const fileHostPromise = IL_pdfSw.isFileUrl(freshUrl) ? IL_pdfSw.requestFileHostFromGesture() : null;
  IL_setActionIconDotted(false);

  // 手势当下立刻读一次 url；无 url 时仍尝试 get（activeTab 授权后）
  try {
    const fresh = await chrome.tabs.get(tab.id);
    freshUrl = fresh.url || tab.url || '';

    // 自家 PDF 查看器：与网页一样 open 浮条（有选区则预填）；关靠条内 × / Esc
    if (IL_pdfSw.isOwnViewerUrl(freshUrl)) {
      await chrome.tabs
        .sendMessage(tab.id, { type: 'il-pdf-open-bar', query })
        .catch(() => {
          /* 查看器页未加载完/未监听则忽略 */
        });
      clearBadge(tab.id);
      return;
    }

    if (IL_isRestrictedUrl(freshUrl)) {
      console.warn('[InfoLens] cannot run on this page:', freshUrl);
      await setBadgeError(tab.id, 'bad page');
      return;
    }
    if (await openIfInjected(tab.id, query)) {
      clearBadge(tab.id);
      return;
    }
    const access = await IL_pdfSw.ensureFileUrlAccess(freshUrl, fileHostPromise);
    if (!access.ok) {
      await setBadgeError(tab.id, access.brief);
      return;
    }
    if (IL_pdfSw.isPdfUrl(freshUrl)) {
      await IL_pdfSw.injectEntry(tab.id);
      clearBadge(tab.id);
      return;
    }

    // 无 .pdf 后缀时，先由页内按 Content-Type / 魔数确认；不能等普通注入失败，
    // 因为 Chrome 的 PDF 宿主页在部分版本仍允许注入 content.js，届时会误开搜索条。
    if (await IL_pdfSw.injectEntryAndOffered(tab.id)) {
      clearBadge(tab.id);
      return;
    }

    const okTab = await IL_injectWithRetry(tab.id, { css: CONTENT_CSS, js: CONTENT_JS }, { logLabel: 'InfoLens' });
    console.info('[InfoLens] injected into', okTab.url);
    if (query) await openIfInjected(tab.id, query);
    clearBadge(tab.id);
  } catch (err) {
    // 无 .pdf 后缀的 PDF（如 arxiv）：content 注入常失败；仅当页内确认是 PDF 并挂上入口才算成功
    try {
      if (await IL_pdfSw.injectEntryAndOffered(tab.id)) {
        clearBadge(tab.id);
        return;
      }
    } catch (pdfErr) {
      console.error('[InfoLens] pdf-entry inject failed', pdfErr);
    }
    console.error('[InfoLens] inject failed', err);
    console.error('[InfoLens] tip: use a normal http(s) article tab (not chrome://, PDF, Web Store); reload extension, then click again after the page finishes loading.');
    await setBadgeError(tab.id, 'inject');
  }
}

const CONTEXT_MENU_ID = 'il-semantic-search';

IL_setUninstallSurveyUrl(EXTENSION_ID);

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Search with Semantic Highlight',
      contexts: ['page', 'selection'],
    });
  });

  IL_maybeShowInstallDot(details);
  IL_reportInstallOrUpdate(details, EXTENSION_ID, IL_CONFIG?.apiBase);
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
 * 读 API JSON 响应；要求 HTTP ok 且 body.success === true。
 * @returns {{ data: object, backend: string | null }}
 */
async function readJsonApi(res) {
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
 * POST JSON；要求 HTTP ok 且 body.success === true（避免 2xx HTML/空对象被当成成功）。
 * 先读正文；仅 Content-Type 为 JSON 时再 parse（平台 HTML 错误页等在 parse 前失败）。
 */
async function postJsonApi(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJsonApi(res);
}

async function getJsonApi(url) {
  const res = await fetch(url);
  return readJsonApi(res);
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
        if (ac.signal.aborted || err?.name === 'AbortError') return;
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'il-open-options') {
    (async () => {
      try {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'il-analyze-semantic-version') {
    (async () => {
      try {
        const apiBase = msg.apiBase || IL_CONFIG.apiBase;
        const { data } = await getJsonApi(
          `${String(apiBase).replace(/\/$/, '')}/api/v2/analyze-semantic-version`
        );
        const relevance = data.relevance;
        const keywords = data.keywords;
        if (!Number.isInteger(relevance) || relevance < 1 || !Number.isInteger(keywords) || keywords < 1) {
          throw apiHttpError('version response missing integer');
        }
        sendResponse({ ok: true, relevance, keywords });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

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
    IL_postKeepalive(
      '/api/extension-feedback',
      {
        ...(msg.body && typeof msg.body === 'object' ? msg.body : {}),
        extension_version: chrome.runtime.getManifest().version,
      },
      msg.apiBase || IL_CONFIG?.apiBase
    );
    return;
  }

  if (IL_pdfSw.handleMessage(msg, sender, sendResponse)) return true;
});
