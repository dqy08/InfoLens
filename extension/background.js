/**
 * 工具栏点击 / 快捷键 / 右键菜单 → 注入 content（activeTab 手势）。
 * 语义 API：SW fetch，依赖服务端 CORS（见 run.py CORSMiddleware）。
 * PDF：http(s) 页内读字节；file://：详情页开「允许访问文件网址」后，在点图标手势里
 * 静默 permissions.request(optional file://)（Chrome 对 file:// 不弹系统窗）→ SW fetch → IndexedDB → 查看器。
 */

importScripts('config.js');
importScripts('pdf/stash-db.js');

const FILE_ORIGIN = 'file:///*';

const CONTENT_CSS = ['content.css'];
const CONTENT_JS = [
  'config.js',
  'vendor/Readability.js',
  'articleRoot.js',
  'collectTextMap.js',
  'splitTextToChunks.js',
  'semantic/page-document.js',
  'semantic/find.js',
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
  // Web Store：主 frame 常无法注入
  if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
  if (u.hostname === 'chromewebstore.google.com') return true;
  return false;
}

/** URL 路径以 .pdf 结尾（含 file:）；无后缀 PDF 靠「网页注入失败 → 再试 pdf-entry」 */
function isPdfUrl(url) {
  if (!url) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isFileUrl(url) {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

async function openFileAccessHelp(reason, detail) {
  const url = new URL(chrome.runtime.getURL('pdf/file-access.html'));
  if (reason) url.searchParams.set('reason', reason);
  if (detail) url.searchParams.set('detail', detail);
  await chrome.tabs.create({ url: url.href });
}

/** 「允许访问文件网址」是否已开；API 异常视为未开（优先走说明页，勿静默当已授权） */
async function hasFileToggle() {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch (err) {
    console.warn('[InfoLens] isAllowedFileSchemeAccess failed', err);
    return false;
  }
}

/**
 * optional file:// 须在用户手势同步栈里 request（任何 await 之前），否则直接 false。
 * 对 file:// Chrome 不会弹系统授权窗：开关已开则常静默成功；未开则失败。
 * @returns {Promise<{ granted: boolean, detail?: string }>}
 */
function requestFileHostFromGesture() {
  return chrome.permissions
    .request({ origins: [FILE_ORIGIN] })
    .then((granted) => ({ granted }))
    .catch((err) => {
      const detail = String(err?.message || err);
      console.warn('[InfoLens] permissions.request failed', detail);
      return { granted: false, detail };
    });
}

/**
 * file:// 注入前：未开开关 → 说明页；已开则等待手势里启动的静默 optional request。
 * @param {string} url
 * @param {Promise<{ granted: boolean, detail?: string }>|null} fileHostPromise 点击瞬间启动的 request；为 null 则只认已授权
 */
async function ensureFileUrlAccess(url, fileHostPromise) {
  if (!isFileUrl(url)) return true;

  if (!(await hasFileToggle())) {
    console.warn('[InfoLens] file:// needs Allow access to file URLs');
    await setBadgeError('file access');
    try {
      await openFileAccessHelp();
    } catch (err) {
      console.error('[InfoLens] open file-access help failed', err);
    }
    return false;
  }

  let granted = false;
  let detail = '';
  if (fileHostPromise) {
    const result = await fileHostPromise;
    granted = result.granted;
    detail = result.detail || '';
  } else {
    try {
      granted = await chrome.permissions.contains({ origins: [FILE_ORIGIN] });
    } catch {
      granted = false;
    }
  }
  if (!granted) {
    console.warn('[InfoLens] optional file:// permission not granted');
    await setBadgeError('file permission');
    try {
      await openFileAccessHelp('permission', detail);
    } catch (err) {
      console.error('[InfoLens] open file-access help failed', err);
    }
    return false;
  }
  return true;
}

/** 是否自家 PDF 查看器扩展页（chrome-extension://<自身id>/pdf/viewer.html） */
function isOwnPdfViewerUrl(url) {
  if (!url) return false;
  const selfUrl = chrome.runtime.getURL('pdf/viewer.html');
  // 精确前缀匹配：避免误判同域下其它扩展页
  return url === selfUrl || url.startsWith(selfUrl + '?') || url.startsWith(selfUrl + '#');
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

/**
 * PDF 页：注入入口脚本（浮出「打开 InfoLens PDF 查看器」按钮）。
 * 与语义管线不同——PDF 顶层是 Chrome viewer 宿主页，不注入 content.js。
 */
async function injectPdfEntry(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ['pdf/entry.js'],
  });
}

/** 注入并等待页内探测：是否真的挂上入口（非 PDF 页为 false，勿当成成功） */
async function injectPdfEntryAndOffered(tabId) {
  await injectPdfEntry(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: async () => {
      const p = window.__IL_PDF_ENTRY_RESULT__;
      if (p != null && typeof p.then === 'function') return !!(await p);
      return !!document.getElementById('il-pdf-entry');
    },
  });
  return !!results?.[0]?.result;
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
  // query：普通网页 / 自家 PDF viewer 预填浮条；Chrome PDF 宿主页只出入口按钮（无浮条）
  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  let freshUrl = tab.url || '';

  // optional file:// request 必须在手势同步阶段启动；前面不能有 await
  const fileHostPromise = isFileUrl(freshUrl) ? requestFileHostFromGesture() : null;

  // 手势当下立刻读一次 url；无 url 时仍尝试 get（activeTab 授权后）
  try {
    const fresh = await chrome.tabs.get(tab.id);
    freshUrl = fresh.url || tab.url || '';

    // 自家 PDF 查看器：与网页一样 open 浮条（有选区则预填）；关靠条内 × / Esc
    if (isOwnPdfViewerUrl(freshUrl)) {
      await chrome.tabs
        .sendMessage(tab.id, { type: 'il-pdf-open-bar', query })
        .catch(() => {
          /* 查看器页未加载完/未监听则忽略 */
        });
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    if (isRestrictedUrl(freshUrl)) {
      console.warn('[InfoLens] cannot run on this page:', freshUrl);
      await setBadgeError('bad page');
      return;
    }
    if (!(await ensureFileUrlAccess(freshUrl, isFileUrl(freshUrl) ? fileHostPromise : null))) return;
    if (isPdfUrl(freshUrl)) {
      await injectPdfEntry(tab.id);
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    // 无 .pdf 后缀时，先由页内按 Content-Type / 魔数确认；不能等普通注入失败，
    // 因为 Chrome 的 PDF 宿主页在部分版本仍允许注入 content.js，届时会误开搜索条。
    if (await injectPdfEntryAndOffered(tab.id)) {
      await chrome.action.setBadgeText({ text: '' });
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
    // 无 .pdf 后缀的 PDF（如 arxiv）：content 注入常失败；仅当页内确认是 PDF 并挂上入口才算成功
    try {
      if (await injectPdfEntryAndOffered(tab.id)) {
        await chrome.action.setBadgeText({ text: '' });
        return;
      }
    } catch (pdfErr) {
      console.error('[InfoLens] pdf-entry inject failed', pdfErr);
    }
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

  if (
    msg?.type === 'il-pdf-upload-start' ||
    msg?.type === 'il-pdf-upload-chunk' ||
    msg?.type === 'il-pdf-upload-finish'
  ) {
    (async () => {
      try {
        const id = typeof msg.id === 'string' ? msg.id : '';
        if (!id) throw new Error('PDF upload id missing');
        if (msg.type === 'il-pdf-upload-start') {
          if (typeof globalThis.IL_pdfStashStartUpload !== 'function') {
            throw new Error('PDF stash upload API missing');
          }
          await globalThis.IL_pdfStashStartUpload({ id, fileName: msg.fileName });
        } else if (msg.type === 'il-pdf-upload-chunk') {
          if (typeof globalThis.IL_pdfStashAppendUploadChunk !== 'function') {
            throw new Error('PDF stash upload API missing');
          }
          await globalThis.IL_pdfStashAppendUploadChunk({
            id,
            index: msg.index,
            base64: msg.base64,
            byteLength: msg.byteLength,
          });
        } else {
          if (typeof globalThis.IL_pdfStashFinishUpload !== 'function') {
            throw new Error('PDF stash upload API missing');
          }
          await globalThis.IL_pdfStashFinishUpload({
            id,
            chunkCount: msg.chunkCount,
            byteLength: msg.byteLength,
          });
          const viewer = chrome.runtime.getURL('pdf/viewer.html');
          await chrome.tabs.create({ url: `${viewer}?id=${encodeURIComponent(id)}` });
        }
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[InfoLens] pdf upload failed', err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'il-open-pdf-viewer') {
    // file://：页内无法 fetch，SW 读 sender.tab.url（点图标时已 request optional file://
    // +「允许访问文件网址」）；本地只多这一类 optional，与 http 路径不对称是刻意的。
    let data = msg.data;
    if (ArrayBuffer.isView(data)) {
      data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    const fileName = typeof msg.fileName === 'string' && msg.fileName.trim() ? msg.fileName.trim() : 'document.pdf';
    const id = crypto.randomUUID();
    (async () => {
      try {
        if (!(data instanceof ArrayBuffer) || data.byteLength < 5) {
          const tabUrl = sender.tab?.url || '';
          if (!isFileUrl(tabUrl)) {
            throw new Error('missing pdf data');
          }
          if (!(await hasFileToggle())) {
            try {
              await openFileAccessHelp();
            } catch {
              /* ignore */
            }
            throw new Error('Allow access to file URLs is off — enable it in chrome://extensions');
          }
          const hasHost = await chrome.permissions.contains({ origins: [FILE_ORIGIN] });
          if (!hasHost) {
            // 打开按钮手势到不了 SW 的 request；再点工具栏图标走静默 optional grant
            throw new Error('Local file permission missing — click the InfoLens toolbar icon once, then retry');
          }
          let res;
          try {
            res = await fetch(tabUrl);
          } catch (err) {
            throw new Error(`Cannot read local PDF (${String(err?.message || err)})`);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.arrayBuffer();
          const head = new Uint8Array(data, 0, Math.min(4, data.byteLength));
          if (
            head.byteLength < 4 ||
            head[0] !== 0x25 ||
            head[1] !== 0x50 ||
            head[2] !== 0x44 ||
            head[3] !== 0x46
          ) {
            throw new Error('not a PDF');
          }
        }
        if (typeof globalThis.IL_pdfStashPut !== 'function') {
          throw new Error('PDF stash API missing');
        }
        await globalThis.IL_pdfStashPut({ id, data, fileName });
        const viewer = chrome.runtime.getURL('pdf/viewer.html');
        await chrome.tabs.create({ url: `${viewer}?id=${encodeURIComponent(id)}` });
        sendResponse({ ok: true, id });
      } catch (err) {
        console.error('[InfoLens] pdf stash failed', err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
});
