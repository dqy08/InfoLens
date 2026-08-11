/**
 * InfoLens PDF viewer。
 * 用法：?id=<stash id>（pdf/entry 读字节 → SW 写入 IndexedDB；本页只从 IDB 读）。
 * 渲染全部页；每页 textLayer 按版面阅读序重排 DOM 并拼接，按几何间距补空格/换行；
 * 页间 \\n。插入的空白不进 itemOffsets（高亮映回时自然跳过）。
 * 供语义搜索与原生选区/复制（均走阅读序，不按 PDF 内容流绘制序）。
 * 浏览对齐 Chrome 内置 PDF：Automatic Zoom 默认、预设 ±、Fit to page / width、全屏；
 * 页码只读显示（不做跳转）。
 */

(() => {
  const statusEl = document.getElementById("il-pv-status");
  const pageEl = document.getElementById("il-pv-page");
  const totalEl = document.getElementById("il-pv-total");
  const zoomLabelEl = document.getElementById("il-pv-zoom-label");
  const scrollRoot = document.getElementById("il-pv-scroll");
  const pagesHost = document.getElementById("il-pv-pages");
  const btnZoomOut = /** @type {HTMLButtonElement} */ (document.getElementById("il-pv-zoom-out"));
  const btnZoomIn = /** @type {HTMLButtonElement} */ (document.getElementById("il-pv-zoom-in"));
  const btnFit = /** @type {HTMLButtonElement} */ (document.getElementById("il-pv-fit"));
  const btnFullscreen = /** @type {HTMLButtonElement} */ (document.getElementById("il-pv-fullscreen"));

  /** 设备像素比上限，2 就够细腻，避免 4K/5K 屏上超大 canvas */
  const MAX_PIXEL_RATIO = 2;
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 4;
  /** 与 Chrome PDF viewer 常用预设档接近 */
  const PRESET_ZOOMS = [
    0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  ];
  /** scroll 内边距：与 css #il-pv-scroll padding 对齐，供 fit 计算 */
  const SCROLL_PAD_X = 20;
  const SCROLL_PAD_Y = 32;

  /** 暴露给语义搜索的全文数据（全页拼接）。ready 后即可消费。 */
  let pdfData = null;

  let pdf = null;
  let total = 0;
  /** @type {HTMLElement[]} 页容器，下标 0 = 第 1 页 */
  let pageWraps = [];
  /** 首页 scale:1 视口，供 fit / 统一各页 scale */
  let baseViewport = null;
  let currentScale = 1;
  /** @type {'auto' | 'page' | 'width' | 'custom'} */
  let fitMode = "auto";
  /**
   * Fit 按钮展示「下一次点击」的动作（对齐 Chrome viewer_toolbar.fittingType_）。
   * 默认 Automatic Zoom 打开后，首次点击应为 Fit to page。
   * @type {'page' | 'width'}
   */
  let fitNextOffer = "page";
  let busy = false;
  /** 避免 fit 模式下 fullscreen 触发的重渲叠加以用户手势 */
  let renderGen = 0;

  /** 仅错误时露出状态条；正常加载/就绪信息走 document.title / 页码区 */
  function setError(text) {
    if (!text) {
      statusEl.textContent = "";
      statusEl.hidden = true;
      statusEl.classList.remove("is-error");
      return;
    }
    statusEl.textContent = text;
    statusEl.hidden = false;
    statusEl.classList.add("is-error");
  }

  function updateZoomLabel() {
    zoomLabelEl.textContent = `${Math.round(currentScale * 100)}%`;
  }

  /** Chromium PDF icons.html path（Material Symbols） */
  const ICON_FIT_PAGE =
    "M263.72-96Q234-96 213-117.15T192-168v-624q0-29.7 21.16-50.85Q234.32-864 264.04-864h432.24Q726-864 747-842.85T768-792v624q0 29.7-21.16 50.85Q725.68-96 695.96-96H263.72ZM696-168v-624H264v624h432Zm0-624H264h432ZM360-600h240L480-720 360-600Zm120 360 120-120H360l120 120Z";
  const ICON_FIT_WIDTH =
    "M168-192q-29.7 0-50.85-21.16Q96-234.32 96-264.04v-432.24Q96-726 117.15-747T168-768h624q29.7 0 50.85 21.16Q864-725.68 864-695.96v432.24Q864-234 842.85-213T792-192H168Zm624-504H168v432h624v-432Zm-624 0v432-432Zm192 336v-240L240-480l120 120Zm360-120L600-600v240l120-120Z";
  const ICON_FS_ENTER =
    "M120-120v-200h80v120h120v80H120Zm520 0v-80h120v-120h80v200H640ZM120-640v-200h200v80H200v120h-80Zm640 0v-120H640v-80h200v200h-80Z";
  const ICON_FS_EXIT =
    "M264-144v-120H144v-72h192v192h-72Zm360 0v-192h192v72H696v120h-72ZM144-624v-72h120v-120h72v192H144Zm480 0v-192h72v120h120v72H624Z";

  /** 更新 Fit 按钮图标/tooltip 为下一次动作 */
  function updateFitButtonUi() {
    const offerPage = fitNextOffer === "page";
    const path = document.getElementById("il-pv-fit-path");
    if (path) path.setAttribute("d", offerPage ? ICON_FIT_PAGE : ICON_FIT_WIDTH);
    const tip = offerPage ? "Fit to page" : "Fit to width";
    btnFit.title = tip;
    btnFit.setAttribute("aria-label", tip);
  }

  function setBusy(next) {
    busy = next;
    const disable = next || !pdf;
    for (const btn of [btnZoomOut, btnZoomIn, btnFit, btnFullscreen]) {
      btn.disabled = disable;
    }
    if (!disable) {
      btnZoomOut.disabled = currentScale <= MIN_SCALE + 1e-6;
      btnZoomIn.disabled = currentScale >= MAX_SCALE - 1e-6;
    }
  }

  function clampScale(scale) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  }

  function fitWidthScale() {
    if (!baseViewport) return 1;
    const available = Math.max(40, scrollRoot.clientWidth - SCROLL_PAD_X);
    return clampScale(available / baseViewport.width);
  }

  function fitHeightScale() {
    if (!baseViewport) return 1;
    const available = Math.max(40, scrollRoot.clientHeight - SCROLL_PAD_Y);
    return clampScale(available / baseViewport.height);
  }

  /** Chrome Fit to page：整页落入视口（宽高都约束） */
  function fitPageScale() {
    return clampScale(Math.min(fitWidthScale(), fitHeightScale()));
  }

  /**
   * Chrome Automatic Zoom：fit-to-width，但不超过 100%（不默认放大）。
   * 对应 Chromium Viewport.fitToNone：min(defaultZoom=1, fitWidth)。
   */
  function automaticZoomScale() {
    return clampScale(Math.min(1, fitWidthScale()));
  }

  /** 下一档预设缩放（Chrome ± 行为） */
  function nextPresetZoom(direction) {
    if (direction < 0) {
      let next = PRESET_ZOOMS[0];
      for (const z of PRESET_ZOOMS) {
        if (z < currentScale - 1e-6) next = z;
      }
      return next;
    }
    let next = PRESET_ZOOMS[PRESET_ZOOMS.length - 1];
    for (let i = PRESET_ZOOMS.length - 1; i >= 0; i--) {
      if (PRESET_ZOOMS[i] > currentScale + 1e-6) next = PRESET_ZOOMS[i];
    }
    return next;
  }

  /**
   * 渲染一页：canvas + textLayer。挂到 parent（可为 DocumentFragment，离屏拼装）。
   * @param {number} index pdf.js 页码（从 1 起）
   * @param {number} scale 与首页统一的缩放
   * @param {ParentNode} parent
   * @returns {Promise<{ wrap: HTMLElement, items: { div: HTMLElement, x: number, y: number, h: number, w: number }[] }>}
   */
  async function renderPage(index, scale, parent) {
    const wrap = document.createElement("div");
    wrap.className = "il-pv-page";
    wrap.dataset.pageNumber = String(index);
    parent.appendChild(wrap);

    const page = await pdf.getPage(index);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.className = "il-pv-canvas";
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    // backing store 按 DPR 放大；必须同步 transform，否则只画在位图左上角
    canvas.width = Math.round(viewport.width * dpr);
    canvas.height = Math.round(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    wrap.appendChild(canvas);

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    textLayerDiv.style.setProperty("--scale-factor", String(viewport.scale));
    wrap.appendChild(textLayerDiv);

    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform,
    }).promise;
    const textContent = await page.getTextContent({
      disableNormalization: true,
      includeMarkedContent: false,
    });
    const textDivs = [];
    await pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
      textDivs,
    }).promise;

    /** @type {{ div: HTMLElement, x: number, y: number, h: number, w: number }[]} */
    const used = [];
    for (let i = 0; i < textDivs.length; i++) {
      const div = textDivs[i];
      if (!div.textContent) continue;
      const item = textContent.items[i];
      const tr = item && item.transform;
      // PDF 用户空间：y 向上；无 transform 时落到 (0,0)，仍参与拼接
      used.push({
        div,
        x: tr ? tr[4] : 0,
        y: tr ? tr[5] : 0,
        h: (item && item.height) || (tr ? Math.hypot(tr[2], tr[3]) : 0) || 0,
        w: (item && item.width) || 0,
      });
    }
    // 内容流顺序 ≠ 阅读顺序（如先画完全页项目符号再画正文）；按版面位置重排。
    used.sort(compareReadingOrder);
    // DOM 同步为阅读序：原生选区/复制按 DOM 走，否则会圈到内容流里夹着的列表符等。
    // 丢掉 pdf.js 按内容流插的 br，按阅读邻接在换行处重插（绝对定位画面不变）。
    const frag = document.createDocumentFragment();
    for (let j = 0; j < used.length; j++) {
      if (j > 0 && gapWhitespace(used[j - 1], used[j]) === "\n") {
        const br = document.createElement("br");
        br.setAttribute("role", "presentation");
        frag.appendChild(br);
      }
      frag.appendChild(used[j].div);
    }
    textLayerDiv.replaceChildren(frag);
    return { wrap, items: used };
  }

  /**
   * 阅读序（PDF 用户空间）：先上后下（y 降序）；|Δy| 小于行容差视为同行再比 x。
   * 容差取两 item 高度较小者的一半，兜底 2 单元（符号与同行正文基线常差几 pt）。
   */
  function compareReadingOrder(a, b) {
    const eps = lineEps(a, b);
    if (Math.abs(a.y - b.y) > eps) return b.y - a.y;
    return a.x - b.x;
  }

  function lineEps(a, b) {
    return Math.max(2, 0.5 * Math.min(a.h || 8, b.h || 8));
  }

  /**
   * 相邻 item 之间应插入的空白：换行 → \\n；同行且间隙够大 → 空格；否则不插。
   * 阈值约 0.1×字号，与 pdf.js addFakeSpaces 的 spaceInFlowMin 同量级。
   * @returns {' ' | '\n' | ''}
   */
  function gapWhitespace(prev, cur) {
    if (Math.abs(prev.y - cur.y) > lineEps(prev, cur)) return "\n";
    const gap = cur.x - (prev.x + (prev.w || 0));
    const spaceMin = 0.1 * Math.min(prev.h || 8, cur.h || 8);
    if (gap > spaceMin) return " ";
    return "";
  }

  /** 视口内最靠上的一页 → 工具条页码 */
  function pageNumberFromScroll() {
    if (!pageWraps.length) return 1;
    const top = scrollRoot.getBoundingClientRect().top + 8;
    let best = 1;
    for (let i = 0; i < pageWraps.length; i++) {
      const rect = pageWraps[i].getBoundingClientRect();
      if (rect.bottom > top + 24) {
        best = i + 1;
        break;
      }
      best = i + 1;
    }
    return best;
  }

  function syncPageFromScroll() {
    if (busy || !pageWraps.length) return;
    const n = pageNumberFromScroll();
    const label = String(n);
    if (pageEl.textContent === label) return;
    pageEl.textContent = label;
  }

  function captureScrollAnchor() {
    const page = pageNumberFromScroll();
    const wrap = pageWraps[page - 1];
    if (!wrap) return { page: 1, offset: 0 };
    const offset = wrap.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
    return { page, offset };
  }

  function restoreScrollAnchor(anchor) {
    const wrap = pageWraps[anchor.page - 1];
    if (!wrap) return;
    const now = wrap.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
    scrollRoot.scrollTop += now - anchor.offset;
  }

  function publishPdfData(data, { initial }) {
    pdfData = data;
    window.__IL_PDF_DATA__ = data;
    if (initial) {
      window.dispatchEvent(new CustomEvent("il-pdf-ready", { detail: data }));
    } else {
      // 原子替换后再通知：旧 DOM 保留到换页完成，避免 ResizeObserver 半空态
      window.dispatchEvent(new CustomEvent("il-pdf-rerendered", { detail: data }));
    }
  }

  /**
   * 按 scale 全页重渲并重建语义映射（pageText 与 scale 无关，仅 textDivs 更新）。
   * 离屏拼装 DocumentFragment，完成后再一次换上——缩放时不闪空、不逐页冒出。
   * 中途被更新 gen 取消时丢弃 fragment，旧页保持不动。
   * @param {number} scale
   * @param {{ fitMode?: 'auto' | 'page' | 'width' | 'custom', preserveAnchor?: boolean, initial?: boolean }} [opts]
   */
  async function renderAll(scale, opts = {}) {
    if (!pdf || !baseViewport) return;
    const gen = ++renderGen;
    const preserveAnchor = opts.preserveAnchor !== false && pageWraps.length > 0;
    const anchor = preserveAnchor ? captureScrollAnchor() : { page: 1, offset: 0 };
    const nextScale = clampScale(scale);
    if (opts.fitMode) fitMode = opts.fitMode;

    setBusy(true);

    const fragment = document.createDocumentFragment();
    /** @type {HTMLElement[]} */
    const nextWraps = [];
    /** @type {string[]} */
    const textParts = [];
    /** @type {{ start: number, end: number }[]} */
    const itemOffsets = [];
    /** @type {HTMLElement[]} */
    const allDivs = [];
    let pos = 0;

    try {
      for (let i = 1; i <= total; i++) {
        if (gen !== renderGen) return;
        const { wrap, items } = await renderPage(i, nextScale, fragment);
        nextWraps.push(wrap);

        if (i > 1) {
          textParts.push("\n");
          pos += 1;
        }
        for (let j = 0; j < items.length; j++) {
          const it = items[j];
          const t = it.div.textContent || "";
          if (j > 0) {
            let ws = gapWhitespace(items[j - 1], it);
            const prevT = items[j - 1].div.textContent || "";
            if (ws === " " && (/\s$/.test(prevT) || /^\s/.test(t))) ws = "";
            if (ws === "\n" && /\n$/.test(prevT)) ws = "";
            if (ws) {
              textParts.push(ws);
              pos += ws.length;
            }
          }
          textParts.push(t);
          itemOffsets.push({ start: pos, end: pos + t.length });
          allDivs.push(it.div);
          pos += t.length;
        }
      }
      if (gen !== renderGen) return;

      pagesHost.replaceChildren(fragment);
      pageWraps = nextWraps;
      currentScale = nextScale;
      // 下划线粗细/偏移随 viewport scale（见 viewer.css / pdf-document clientRectToMountPos）
      pagesHost.style.setProperty("--il-pdf-scale", String(nextScale));
      publishPdfData(
        {
          pageCount: total,
          pageText: textParts.join(""),
          itemOffsets,
          textDivs: allDivs,
          pagesRoot: pagesHost,
        },
        { initial: !!opts.initial }
      );

      pageEl.textContent = String(anchor.page);
      if (preserveAnchor) restoreScrollAnchor(anchor);
      else {
        scrollRoot.scrollTop = 0;
        pageEl.textContent = "1";
      }
      updateZoomLabel();
    } finally {
      if (gen === renderGen) setBusy(false);
    }
  }

  /**
   * @param {'auto' | 'page' | 'width'} mode
   * @param {{ advanceOffer?: boolean }} [opts] advanceOffer：用户点击切换时翻到另一侧
   */
  async function applyFit(mode, opts = {}) {
    if (!pdf || busy) return;
    const scale =
      mode === "page" ? fitPageScale() : mode === "auto" ? automaticZoomScale() : fitWidthScale();
    await renderAll(scale, { fitMode: mode });
    if (opts.advanceOffer && (mode === "page" || mode === "width")) {
      fitNextOffer = mode === "page" ? "width" : "page";
      updateFitButtonUi();
    }
  }

  /** 单按钮：执行当前展示的动作，再翻到另一侧 */
  async function fitToggle() {
    if (!pdf || busy) return;
    await applyFit(fitNextOffer, { advanceOffer: true });
  }

  async function applyZoomPreset(direction) {
    if (!pdf || busy) return;
    await renderAll(nextPresetZoom(direction), { fitMode: "custom" });
  }

  /**
   * 用已到手的 PDF 字节打开（不按 URL 拉取，故无需 host_permissions）。
   * @param {ArrayBuffer} data
   * @param {string} [fileName]
   */
  async function loadFromData(data, fileName) {
    try {
      setError("");
      setBusy(true);
      pagesHost.replaceChildren();
      pageWraps = [];
      pdfData = null;
      pageEl.textContent = "—";
      totalEl.textContent = "";
      if (fileName) document.title = fileName;

      pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(data),
        isEvalSupported: false,
      }).promise;
      total = pdf.numPages;
      totalEl.textContent = `/${total}`;
      baseViewport = (await pdf.getPage(1)).getViewport({ scale: 1 });

      await renderAll(automaticZoomScale(), { fitMode: "auto", preserveAnchor: false, initial: true });
      fitNextOffer = "page";
      updateFitButtonUi();
    } catch (err) {
      console.error(err);
      pdf = null;
      setBusy(false);
      setError(`Cannot open PDF: ${err?.name || err}`);
    }
  }

  function setFullscreenUi(on) {
    const path = document.getElementById("il-pv-fs-path");
    if (path) path.setAttribute("d", on ? ICON_FS_EXIT : ICON_FS_ENTER);
    btnFullscreen.title = on ? "Exit full screen" : "Full screen";
    btnFullscreen.setAttribute("aria-label", btnFullscreen.title);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    void document.documentElement.requestFullscreen?.();
  }

  function wireControls() {
    scrollRoot.addEventListener("scroll", () => syncPageFromScroll(), { passive: true });
    btnZoomOut.addEventListener("click", () => void applyZoomPreset(-1));
    btnZoomIn.addEventListener("click", () => void applyZoomPreset(1));
    btnFit.addEventListener("click", () => void fitToggle());
    btnFullscreen.addEventListener("click", () => toggleFullscreen());

    document.addEventListener("fullscreenchange", () => {
      const on = !!document.fullscreenElement;
      setFullscreenUi(on);
      // auto / fit 模式下视口变了再算一次；± 保持用户比例
      if (pdf && !busy && (fitMode === "auto" || fitMode === "page" || fitMode === "width")) {
        void applyFit(fitMode);
      }
    });

    scrollRoot.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        if (!pdf) return;
        // busy 时也要 preventDefault，否则缩放重渲期间滚轮会漏成上下滚动
        e.preventDefault();
        if (busy) return;
        void applyZoomPreset(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );
  }

  function main() {
    if (!window.pdfjsLib) {
      setError("pdf.js failed to load");
      return;
    }
    if (typeof globalThis.IL_pdfStashGet !== "function") {
      setError("PDF stash API missing");
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "../vendor/pdfjs/pdf.worker.min.js";

    const params = new URLSearchParams(location.search);
    const id = params.get("id");
    if (!id) {
      setError("Missing PDF (open from the page entry button)");
      return;
    }
    history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
    wireControls();
    void (async () => {
      try {
        void globalThis.IL_pdfStashCleanup?.();
        const entry = await globalThis.IL_pdfStashGet(id);
        if (!entry?.data) {
          setError("PDF missing or cleaned up (re-open from the original page)");
          return;
        }
        await loadFromData(entry.data, entry.fileName || "document.pdf");
      } catch (err) {
        setError(String(err?.message || err));
      }
    })();
  }

  main();
})();
