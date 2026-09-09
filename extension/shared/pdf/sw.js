/**
 * PDF 流程的 service worker 半边：与 shared/pdf/entry.js 的消息协议、file:// 权限闸门、
 * 入口脚本注入、打开查看器。两个插件走同一条流程，分叉点在 pdf/viewer.html 挂哪个功能脚本。
 * importScripts 引入（须排在 pdf/stash-db.js 之后）；挂 globalThis.IL_pdfSw。
 */
(() => {
  const FILE_ORIGIN = 'file:///*';

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
      console.warn('[InfoLens][pdf-sw] isAllowedFileSchemeAccess failed', err);
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
        console.warn('[InfoLens][pdf-sw] permissions.request failed', detail);
        return { granted: false, detail };
      });
  }

  /**
   * file:// 注入前：未开开关 → 说明页；已开则等待手势里启动的静默 optional request。
   * 失败时只开说明页，badge 之类的提示交调用方按 brief 处理。
   * @param {string} url
   * @param {Promise<{ granted: boolean, detail?: string }>|null} fileHostPromise 点击瞬间启动的 request；为 null 则只认已授权
   * @returns {Promise<{ ok: boolean, brief?: string }>}
   */
  async function ensureFileUrlAccess(url, fileHostPromise) {
    if (!isFileUrl(url)) return { ok: true };

    if (!(await hasFileToggle())) {
      console.warn('[InfoLens][pdf-sw] file:// needs Allow access to file URLs');
      await openFileAccessHelp().catch((err) => console.error('[InfoLens][pdf-sw] open help failed', err));
      return { ok: false, brief: 'file access' };
    }

    let granted = false;
    let detail = '';
    if (fileHostPromise) {
      ({ granted, detail = '' } = await fileHostPromise);
    } else {
      granted = await chrome.permissions.contains({ origins: [FILE_ORIGIN] }).catch(() => false);
    }
    if (!granted) {
      console.warn('[InfoLens][pdf-sw] optional file:// permission not granted');
      await openFileAccessHelp('permission', detail).catch((err) =>
        console.error('[InfoLens][pdf-sw] open help failed', err)
      );
      return { ok: false, brief: 'file permission' };
    }
    return { ok: true };
  }

  /** 是否自家 PDF 查看器扩展页（chrome-extension://<自身id>/pdf/viewer.html） */
  function isOwnViewerUrl(url) {
    if (!url) return false;
    const self = chrome.runtime.getURL('pdf/viewer.html');
    // 精确前缀匹配：避免误判同域下其它扩展页
    return url === self || url.startsWith(self + '?') || url.startsWith(self + '#');
  }

  /**
   * PDF 页：注入入口脚本（浮出「用 InfoLens PDF 查看器打开」按钮）。
   * 与网页管线不同——PDF 顶层是 Chrome viewer 宿主页，不注入 content。
   */
  async function injectEntry(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['pdf/entry.js'],
    });
  }

  /** 注入并等待页内探测：是否真的挂上入口（非 PDF 页为 false，勿当成成功） */
  async function injectEntryAndOffered(tabId) {
    await injectEntry(tabId);
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

  async function openViewer(id) {
    const viewer = chrome.runtime.getURL('pdf/viewer.html');
    await chrome.tabs.create({ url: `${viewer}?id=${encodeURIComponent(id)}` });
  }

  const UPLOAD_TYPES = new Set(['il-pdf-upload-start', 'il-pdf-upload-chunk', 'il-pdf-upload-finish']);

  /** http(s)：入口页持有站点会话，页内分块 Base64 上传，SW 只做持久化 */
  async function handleUpload(msg) {
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (!id) throw new Error('PDF upload id missing');
    if (msg.type === 'il-pdf-upload-start') {
      await globalThis.IL_pdfStashStartUpload({ id, fileName: msg.fileName });
      return;
    }
    if (msg.type === 'il-pdf-upload-chunk') {
      await globalThis.IL_pdfStashAppendUploadChunk({
        id,
        index: msg.index,
        base64: msg.base64,
        byteLength: msg.byteLength,
      });
      return;
    }
    await globalThis.IL_pdfStashFinishUpload({
      id,
      chunkCount: msg.chunkCount,
      byteLength: msg.byteLength,
    });
    await openViewer(id);
  }

  /**
   * file://：页内无法 fetch，改由 SW 读 sender.tab.url（点图标时已 request optional file://
   * +「允许访问文件网址」）；本地只多这一类 optional，与 http 路径不对称是刻意的。
   */
  async function handleOpenLocal(msg, sender) {
    const tabUrl = sender.tab?.url || '';
    if (!isFileUrl(tabUrl)) throw new Error(`not a local file: ${tabUrl || '(no url)'}`);
    if (!(await hasFileToggle())) {
      await openFileAccessHelp().catch(() => {
        /* ignore */
      });
      throw new Error('Allow access to file URLs is off — enable it in chrome://extensions');
    }
    if (!(await chrome.permissions.contains({ origins: [FILE_ORIGIN] }))) {
      // 按钮的点击手势到不了 SW 的 request；再点工具栏图标走静默 optional grant
      throw new Error('Local file permission missing — click the toolbar icon once, then retry');
    }
    let res;
    try {
      res = await fetch(tabUrl);
    } catch (err) {
      throw new Error(`Cannot read local PDF (${String(err?.message || err)})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    const head = new Uint8Array(data, 0, Math.min(4, data.byteLength));
    if (head.byteLength < 4 || head[0] !== 0x25 || head[1] !== 0x50 || head[2] !== 0x44 || head[3] !== 0x46) {
      throw new Error('not a PDF');
    }
    const id = crypto.randomUUID();
    const fileName = typeof msg.fileName === 'string' && msg.fileName.trim() ? msg.fileName.trim() : 'document.pdf';
    await globalThis.IL_pdfStashPut({ id, data, fileName });
    await openViewer(id);
  }

  /**
   * 接管 entry.js 发来的消息。
   * @returns {boolean} 是否已接管；调用方据此从 onMessage 监听器 return true 保持通道
   */
  function handleMessage(msg, sender, sendResponse) {
    const upload = UPLOAD_TYPES.has(msg?.type);
    if (!upload && msg?.type !== 'il-open-pdf-viewer') return false;
    (async () => {
      try {
        if (upload) await handleUpload(msg);
        else await handleOpenLocal(msg, sender);
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[InfoLens][pdf-sw]', msg.type, err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  globalThis.IL_pdfSw = {
    isPdfUrl,
    isFileUrl,
    isOwnViewerUrl,
    requestFileHostFromGesture,
    ensureFileUrlAccess,
    injectEntry,
    injectEntryAndOffered,
    handleMessage,
  };
})();
