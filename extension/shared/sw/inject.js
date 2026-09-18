/**
 * 网页 content 注入：等加载完、瞬时 frame 错误重试。
 * 调用方提供 CSS/JS 清单和日志前缀；是否已注入、PDF 入口仍由各插件自己判断。
 */
globalThis.IL_sleep = function IL_sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
};

/** 等到 status=complete；已 complete 则立即返回最新 tab */
globalThis.IL_waitTabComplete = async function IL_waitTabComplete(tabId, timeoutMs = 20000) {
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
};

globalThis.IL_isTransientFrameError = function IL_isTransientFrameError(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes('Frame with ID') ||
    msg.includes('No frame with id') ||
    msg.includes('Frame does not exist') ||
    msg.includes('The tab was closed') ||
    msg.includes('cannot be scripted now')
  );
};

/**
 * @param {number} tabId
 * @param {{ css: string[], js: string[] }} files
 */
globalThis.IL_injectOnce = async function IL_injectOnce(tabId, files) {
  // 显式 frameIds:[0]，避免对已消失子 frame 误操作；主文档未就绪时由上层重试
  await chrome.scripting.insertCSS({
    target: { tabId, frameIds: [0] },
    files: files.css,
  });
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: files.js,
  });
};

/**
 * @param {number} tabId
 * @param {{ css: string[], js: string[] }} files
 * @param {{
 *   logLabel?: string,
 *   waitComplete?: boolean,
 *   isStale?: () => boolean,
 * }} opts
 * waitComplete 默认 true；点图标 / 自动分析传 false，转圈未结束也能注入。
 * isStale 为真则中止（导航已换代），避免把脚本打进下一页或清掉下一轮状态。
 */
globalThis.IL_injectWithRetry = async function IL_injectWithRetry(tabId, files, opts) {
  const logLabel = opts?.logLabel || 'extension';
  const waitComplete = opts?.waitComplete !== false;
  const isStale = typeof opts?.isStale === 'function' ? opts.isStale : () => false;
  let lastErr;
  const attempts = waitComplete ? 4 : 8;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (isStale()) throw new Error('inject aborted: navigation superseded');
    try {
      const tab = waitComplete ? await IL_waitTabComplete(tabId) : await chrome.tabs.get(tabId);
      if (isStale()) throw new Error('inject aborted: navigation superseded');
      if (IL_isRestrictedUrl(tab.url)) {
        throw new Error(`restricted page: ${tab.url || '(no url)'}`);
      }
      if (tab.discarded) {
        await chrome.tabs.reload(tabId);
        if (waitComplete) await IL_waitTabComplete(tabId);
      }
      await IL_injectOnce(tabId, files);
      if (isStale()) throw new Error('inject aborted: navigation superseded');
      return tab;
    } catch (err) {
      lastErr = err;
      if (isStale() || String(err?.message || err).includes('navigation superseded')) throw err;
      if (!IL_isTransientFrameError(err) || attempt === attempts) throw err;
      console.warn(`[${logLabel}] inject attempt ${attempt} failed, retry…`, err?.message || err);
      await IL_sleep(100 * attempt);
    }
  }
  throw lastErr;
};
