/**
 * PDF 页入口（叠加在 PDF 顶层网页上）。
 * Chrome 的内置 PDF viewer 封装在 <embed> 里，content script 无法进入其内部，
 * 但可以在其宿主网页上叠元素（Dark Reader 同类做法）。
 * background 注入本脚本后，先页内轻量确认是 PDF 再浮出按钮；
 * http(s)：页内 fetch（保留网站登录态）后分块 Base64 交 SW 暂存，避免跨上下文传 ArrayBuffer；
 * file://：页内无法 fetch，交 SW 读 tab URL（需「允许访问文件网址」；optional file:// 在点工具栏图标时 request）。
 * SW 写入 IndexedDB 后打开 pdf/viewer.html?id=…。
 * 再次点击图标则切换按钮显隐。
 * 探测结果挂 window.__IL_PDF_ENTRY_RESULT__（Promise<boolean>），供 SW 判断是否真的露出入口。
 */
(() => {
  const existing = document.getElementById('il-pdf-entry');
  if (existing) {
    // 同一次加载：点图标只切换显隐。扩展重载后 runtime id 对不上 → 拆掉重建。
    if (existing.dataset.ilExtensionId === chrome.runtime.id) {
      existing.hidden = !existing.hidden;
      window.__IL_PDF_ENTRY_RESULT__ = Promise.resolve(true);
      return;
    }
    existing.remove();
    document.getElementById('il-pdf-entry-style')?.remove();
  }

  /** %PDF 魔数 */
  function isPdfMagicBytes(u8) {
    return !!u8 && u8.byteLength >= 4 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46;
  }

  function isPdfMagic(buf) {
    if (!buf || buf.byteLength < 4) return false;
    return isPdfMagicBytes(new Uint8Array(buf, 0, 4));
  }

  function isPdfContentType(res) {
    const ct = (res.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
    return ct === 'application/pdf' || ct.endsWith('+pdf') || ct.endsWith('/pdf');
  }

  /**
   * 是否值得露出入口：.pdf 后缀直接过；否则页内 fetch，看 Content-Type 或首包魔数（非 PDF 立即 cancel，避免拖全文）。
   */
  async function shouldOffer() {
    try {
      if (/\.pdf$/i.test(new URL(location.href).pathname)) return true;
    } catch {
      /* continue */
    }
    try {
      const res = await fetch(location.href);
      if (isPdfContentType(res)) {
        try {
          res.body?.cancel();
        } catch {
          /* ignore */
        }
        return true;
      }
      if (!res.body) return false;
      const reader = res.body.getReader();
      try {
        const { value } = await reader.read();
        return isPdfMagicBytes(value);
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
      }
    } catch {
      return false;
    }
  }

  function fileNameFromHref(href) {
    try {
      const u = new URL(href);
      const raw = decodeURIComponent(u.pathname.split('/').pop() || '');
      return raw || u.hostname || 'document.pdf';
    } catch {
      return 'document.pdf';
    }
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp?.ok) {
          reject(new Error(resp?.error || 'open failed'));
          return;
        }
        resolve(resp);
      });
    });
  }

  /** 页内再取一遍 PDF 字节；网络失败时试 HTTP 缓存（Chrome 已打开过该 PDF 时常有） */
  async function fetchPdfBytes(href) {
    async function once(cache) {
      const res = await fetch(href, cache ? { cache } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      if (!isPdfMagic(data)) throw new Error('not a PDF');
      return data;
    }
    try {
      return await once();
    } catch (first) {
      try {
        return await once('force-cache');
      } catch {
        throw first;
      }
    }
  }

  const UPLOAD_CHUNK_BYTES = 192 * 1024;

  function base64FromBytes(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function uploadPdf(data, fileName) {
    const id = crypto.randomUUID();
    await sendMessage({ type: 'il-pdf-upload-start', id, fileName });
    const bytes = new Uint8Array(data);
    let index = 0;
    for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.length));
      await sendMessage({
        type: 'il-pdf-upload-chunk',
        id,
        index,
        base64: base64FromBytes(chunk),
        byteLength: chunk.byteLength,
      });
      index += 1;
    }
    await sendMessage({
      type: 'il-pdf-upload-finish',
      id,
      chunkCount: index,
      byteLength: data.byteLength,
    });
  }

  function mountButton() {
    if (!document.getElementById('il-pdf-entry-style')) {
      const style = document.createElement('style');
      style.id = 'il-pdf-entry-style';
      style.textContent = `
        #il-pdf-entry {
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 2147483647;
        }
        #il-pdf-entry button {
          font: 13px/1 system-ui, sans-serif;
          padding: 9px 13px;
          border: 1px solid rgba(0,0,0,.2);
          border-radius: 6px;
          background: #fff;
          color: #111;
          box-shadow: 0 2px 8px rgba(0,0,0,.18);
          cursor: pointer;
        }
        #il-pdf-entry button:hover:not(:disabled) { background: #f2f2f2; }
        #il-pdf-entry button:disabled { opacity: 0.7; cursor: default; }
      `;
      document.documentElement.appendChild(style);
    }

    const host = document.createElement('div');
    host.id = 'il-pdf-entry';
    host.dataset.ilExtensionId = chrome.runtime.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    const DEFAULT_LABEL = 'Open with InfoLens PDF viewer';
    btn.textContent = DEFAULT_LABEL;
    btn.addEventListener('click', () => {
      void (async () => {
        btn.disabled = true;
        btn.textContent = 'Opening…';
        btn.removeAttribute('title');
        try {
          const fileName = fileNameFromHref(location.href);
          // file://：页内无法读，交 SW；http(s)：页内读并分块上传，保留网站登录态。
          const data = location.protocol === 'file:' ? null : await fetchPdfBytes(location.href);
          if (data) await uploadPdf(data, fileName);
          else await sendMessage({ type: 'il-open-pdf-viewer', fileName });
          host.hidden = true;
          btn.textContent = DEFAULT_LABEL;
        } catch (err) {
          console.error('[InfoLens][pdf-entry]', err);
          const detail = String(err?.message || err);
          // 重载扩展后旧按钮仍在：runtime 已断，需再点工具栏图标重新注入
          if (/Extension context invalidated/i.test(detail)) {
            btn.textContent = 'Extension reloaded — click the toolbar icon again';
          } else {
            btn.textContent = 'Failed — click to retry';
            btn.title = detail;
          }
        } finally {
          btn.disabled = false;
        }
      })();
    });
    host.appendChild(btn);
    document.documentElement.appendChild(host);
  }

  async function offer() {
    if (!(await shouldOffer())) return false;
    // 探测期间若再次注入，可能已有节点
    if (document.getElementById('il-pdf-entry')) return true;
    mountButton();
    return true;
  }

  window.__IL_PDF_ENTRY_RESULT__ = offer();
})();
