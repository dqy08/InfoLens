/**
 * 正文提取 + 码点偏移 → Range；网页 token 只绑 CSS Custom Highlight（勿 getClientRects）。
 * PDF 的 canvas 已含字形，底色会盖在字上，token 改画 overlay 红线（paintTokens 的 overlay）。
 * 进度图量段 Y 例外，想法来自 extension/semantic-highlight/semantic/find.js（横轴=文档 Y / 视口带 / 点击跳转）。
 *
 * 段：切分力度 = 语义 800 字节 × 倍数。每次送 1 段前文 + 本段（1:1），只画本段。
 * 骑在段界上的 BPE token：offset 裁进本段，不画进前文、也不丢掉本段侧。
 * 进度图：竖轴默认 4–8 bit；分析中亮空框，段回了加线；不自动跟滚。
 */
(() => {
  /** SYNC: client/src/shared/core/constants.ts → SEMANTIC_CHUNK_BYTES */
  const UNIT_BYTES = 800;
  const UNIT_MULTIPLIER = 2;
  const CONTEXT_UNITS = 1;
  const TOKEN_LEVELS = 16;
  const HL_PREFIX = 'ih-token-';
  /** SYNC: extension/semantic-highlight/semantic/find.js → HL_UNDERLINE（命名空间 ih-，避免和语义插件互踩） */
  const HL_UNDERLINE = 'ih-underline';
  const HOST_ID = 'ih-progress-host';
  const ERROR_ID = 'ih-error';
  /** SYNC: client/src/shared/cross/surprisalMath.ts → REFERENCE_MAX_SURPRISAL_BITS */
  const MAX_SURPRISAL_BITS = 18;
  const PROGRESS_BITS_MIN = 4;
  const PROGRESS_BITS_MAX = 8;
  /** SYNC: extension/semantic-highlight/semantic/find.js → PROGRESS_MIN_WIDTH_PX / VIEWPORT_FOCUS_Y_RATIO / CHUNK_START_MAX_Y_RATIO */
  const PROGRESS_MIN_WIDTH_PX = 2;
  const VIEWPORT_FOCUS_Y_RATIO = 0.5;
  const CHUNK_START_MAX_Y_RATIO = 0.2;
  const SELECT_HOLD_MS = 1000;
  /** shared/page/scrollGeometry.js：滚动容器与文档 Y 的换算 */
  const geo = () => globalThis.IL_scrollGeometry;

  function requireFns() {
    if (typeof globalThis.IL_findArticleRoot !== 'function') {
      throw new Error('IL_findArticleRoot missing — inject articleRoot.js first');
    }
    if (typeof globalThis.IL_collectTextMap !== 'function') {
      throw new Error('IL_collectTextMap missing — inject collectTextMap.js first');
    }
  }

  function extractPage() {
    requireFns();
    const root = globalThis.IL_findArticleRoot(document);
    const mapped = globalThis.IL_collectTextMap(root);
    if (!mapped.text || !mapped.pieces.length) {
      throw new Error('No article text');
    }
    return mapped;
  }

  /** @param {string} text */
  function splitSegments(text) {
    const split = globalThis.IL_splitTextToChunks;
    if (typeof split !== 'function') {
      throw new Error('IL_splitTextToChunks missing — inject splitTextToChunks.js first');
    }
    return split(text, UNIT_BYTES * UNIT_MULTIPLIER).map((raw) => ({
      start: raw.startOffset,
      end: raw.startOffset + raw.text.length,
      text: raw.text,
    }));
  }

  /**
   * 请求文本 = 原文连续切片（前文 + 本段），避免拼段造成新的 BPE 边界。
   * @param {string} text
   * @param {{ start: number, end: number, text: string }[]} segs
   * @param {number} i
   */
  function segmentWindow(text, segs, i) {
    if (i < 0 || i >= segs.length) throw new Error('segment index out of range');
    const idx = globalThis.IL_createTextIndex(text);
    const ctxFrom = Math.max(0, i - CONTEXT_UNITS);
    const utf16Start = segs[ctxFrom].start;
    return {
      requestText: text.slice(utf16Start, segs[i].end),
      originCp: idx.utf16ToCp(utf16Start),
      segStartCp: idx.utf16ToCp(segs[i].start),
      segEndCp: idx.utf16ToCp(segs[i].end),
    };
  }

  /**
   * 请求坐标 → 全文码点；只保留与本段相交的部分。
   * @param {Array<{ offset: [number, number] }>} tokens
   * @param {{ originCp: number, segStartCp: number, segEndCp: number }} win
   */
  function tokensInSegment(tokens, win) {
    const out = [];
    for (const tok of tokens) {
      const off = tok.offset;
      if (!Array.isArray(off) || off.length < 2) {
        throw new Error('Analyze token missing offset');
      }
      const s = off[0] + win.originCp;
      const e = off[1] + win.originCp;
      const c0 = Math.max(s, win.segStartCp);
      const c1 = Math.min(e, win.segEndCp);
      if (c1 <= c0) continue;
      out.push({ ...tok, offset: [c0, c1] });
    }
    return out;
  }

  /**
   * @param {{ node: Text, start: number, end: number }[]} pieces
   * @param {string} text
   * @param {number} u0
   * @param {number} u1
   * @returns {Range[]}
   */
  function rangesFromUtf16(pieces, text, u0, u1) {
    if (u1 <= u0) return [];
    let i = globalThis.IL_findPieceIndex(pieces, u0);
    if (i < 0) return [];
    const out = [];
    for (; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.start >= u1) break;
      if (!p.node.isConnected) continue;
      const seg0 = Math.max(u0, p.start);
      const seg1 = Math.min(u1, p.end);
      if (seg1 <= seg0) continue;
      if (!/\S/.test(text.slice(seg0, seg1))) continue;
      const r = document.createRange();
      r.setStart(p.node, seg0 - p.start);
      r.setEnd(p.node, seg1 - p.start);
      if (!r.collapsed) out.push(r);
    }
    return out;
  }

  function requireHighlightApi() {
    if (!CSS.highlights || typeof Highlight !== 'function') {
      throw new Error('CSS Custom Highlight API missing');
    }
  }

  function ensureHighlightRegistry() {
    requireHighlightApi();
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      const name = HL_PREFIX + i;
      if (!CSS.highlights.has(name)) {
        const h = new Highlight();
        h.priority = i;
        CSS.highlights.set(name, h);
      }
    }
    if (!CSS.highlights.has(HL_UNDERLINE)) {
      const h = new Highlight();
      h.priority = TOKEN_LEVELS + 2;
      CSS.highlights.set(HL_UNDERLINE, h);
    }
  }

  function clearUnderline() {
    CSS.highlights?.get(HL_UNDERLINE)?.clear();
  }

  /**
   * SYNC: extension/semantic-highlight/semantic/find.js → setCurrentUnderlines / addCpRangeToHighlight
   * @param {{ start: number, end: number }[]} chunks
   */
  function paintUnderlines(chunks) {
    ensureHighlightRegistry();
    const h = CSS.highlights.get(HL_UNDERLINE);
    if (!h) throw new Error(`highlight missing: ${HL_UNDERLINE}`);
    h.clear();
    if (!progressMapped || !progressIdx) return;
    for (const chunk of chunks) {
      const u0 = progressIdx.cpToUtf16(chunk.start);
      const u1 = progressIdx.cpToUtf16(chunk.end);
      for (const range of rangesFromUtf16(progressMapped.pieces, progressMapped.text, u0, u1)) {
        if (!/\S/.test(range.toString())) continue;
        h.add(range);
      }
    }
  }

  /**
   * PDF：canvas 已含字形，::highlight 底色会盖在字上，token 改画 overlay 红线。
   * 缩放后 viewer 会 replaceChildren 掉整棵页树，这些线随之消失，重画即自愈。
   * @type {HTMLElement[]}
   */
  let tokenOverlayEls = [];

  function clearTokenOverlays() {
    for (const el of tokenOverlayEls) el.remove();
    tokenOverlayEls = [];
  }

  /** 线相对 root 定位；粗细与上移由 pdf/viewer.css 按 --il-pdf-scale 给 */
  function tokenOverlayContext(root) {
    if (!root) throw new Error('token overlay root missing');
    return {
      root,
      rect: root.getBoundingClientRect(),
      scale: globalThis.IL_pdfTextLayer.scaleOf(root),
    };
  }

  function appendTokenUnderline(rect, level, ctx) {
    const pos = globalThis.IL_pdfTextLayer.underlinePos(rect, ctx.rect, ctx.scale);
    const el = document.createElement('div');
    el.className = 'il-token-underline';
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.style.width = `${rect.width}px`;
    el.style.backgroundColor = `rgba(255, 71, 64, ${(level + 1) / TOKEN_LEVELS})`;
    ctx.root.appendChild(el);
    tokenOverlayEls.push(el);
  }

  function clearHighlights() {
    clearTokenOverlays();
    if (!CSS.highlights) return;
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      CSS.highlights.get(HL_PREFIX + i)?.clear();
    }
    clearUnderline();
  }

  /**
   * classic = token bits（站点默认 tokenRenderStyle）。
   * @param {{ p?: number | null, real_topk?: [number, number] | null }} tok
   * @returns {number | null}
   */
  function tokenBits(tok) {
    const p = Number.isFinite(tok?.p) ? tok.p : tok?.real_topk?.[1];
    if (!Number.isFinite(p) || p <= 0) return null;
    return -Math.log2(Math.max(p, Number.EPSILON));
  }

  /** @param {{ p?: number | null, real_topk?: [number, number] | null }} tok */
  function tokenLevel(tok) {
    const bits = tokenBits(tok);
    if (bits == null) return -1;
    const t = Math.max(0, Math.min(1, bits / MAX_SURPRISAL_BITS));
    const level = Math.min(TOKEN_LEVELS - 1, Math.floor(t * TOKEN_LEVELS));
    return level < 1 ? -1 : level;
  }

  /** @param {Array<{ real_topk?: [number, number] | null }>} tokens */
  function averageBits(tokens) {
    let sum = 0;
    let n = 0;
    for (const tok of tokens) {
      const bits = tokenBits(tok);
      if (bits == null) continue;
      sum += bits;
      n += 1;
    }
    return n ? sum / n : null;
  }

  /**
   * @param {Array<{ offset: [number, number], raw?: string, real_topk?: [number, number] | null }>} tokens
   * @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root?: Element }} mapped
   * @param {{ append?: boolean, overlay?: boolean }} [opts] overlay：PDF 画红线，不用 ::highlight 底色
   * @returns {number}
   */
  function paintTokens(tokens, mapped, opts) {
    ensureHighlightRegistry();
    if (!opts?.append) clearHighlights();
    const overlay = opts?.overlay ? tokenOverlayContext(mapped.root) : null;
    const idx = globalThis.IL_createTextIndex(mapped.text);
    let painted = 0;
    for (const tok of tokens) {
      const level = tokenLevel(tok);
      if (level < 0) continue;
      const off = tok.offset;
      if (!Array.isArray(off) || off.length < 2) {
        throw new Error('Analyze token missing offset');
      }
      const u0 = idx.cpToUtf16(off[0]);
      const u1 = idx.cpToUtf16(off[1]);
      const h = overlay ? null : CSS.highlights.get(HL_PREFIX + level);
      if (!overlay && !h) throw new Error(`highlight missing: ${HL_PREFIX}${level}`);
      for (const range of rangesFromUtf16(mapped.pieces, mapped.text, u0, u1)) {
        if (!/\S/.test(range.toString())) continue;
        if (!overlay) {
          h.add(range);
          painted += 1;
          continue;
        }
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          appendTokenUnderline(r, level, overlay);
          painted += 1;
        }
      }
    }
    return painted;
  }

  function shortError(msg) {
    let t = String(msg || 'Analyze failed').replace(/\s+/g, ' ').trim();
    if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(t)) {
      t = 'Cannot reach http://localhost:5001';
    }
    return t.length > 120 ? t.slice(0, 119) + '…' : t;
  }

  function noticeEl() {
    const host = ensureHost();
    let el = host.querySelector('#' + ERROR_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ERROR_ID;
      host.appendChild(el);
    }
    el.replaceChildren();
    el.removeAttribute('hidden');
    return el;
  }

  function showError(msg) {
    const el = noticeEl();
    el.classList.remove('is-paused');
    el.textContent = shortError(msg);
  }

  /** SYNC: extension/semantic-highlight/semantic/find.js → showFindStatus('Paused', 'Continue to search more') */
  function showPaused(onContinue) {
    const el = noticeEl();
    el.classList.add('is-paused');
    const text = document.createElement('span');
    text.textContent = 'Paused · Continue to search more';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Continue';
    btn.addEventListener('click', onContinue);
    el.append(text, btn);
  }

  function clearError() {
    document.getElementById(ERROR_ID)?.remove();
  }

  /** @type {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element } | null} */
  let progressMapped = null;
  /** @type {ReturnType<typeof globalThis.IL_createTextIndex> | null} */
  let progressIdx = null;
  /** @type {{ start: number, end: number, bits: number }[]} */
  let progressRows = [];
  /** 全文段（码点），供邻段 Y 衔接；未分析的也量 */
  let progressSegs = [];
  let progressSearching = false;
  let progressEnabled = false;
  chrome.storage?.local?.get({ show_progress: false }, (res) => {
    progressEnabled = !!res?.show_progress;
  });
  chrome.storage?.onChanged?.addListener((changes) => {
    if ('show_progress' in changes) {
      progressEnabled = !!changes.show_progress.newValue;
      renderProgress();
    }
  });
  /** @type {Map<number, { y0: number, y1: number }>} */
  let progressYCache = new Map();
  /** @type {Set<number>} */
  let selectedStarts = new Set();
  /** @type {number | null} */
  let hoveredStart = null;
  let selectHoldTimer = 0;
  let hostWired = false;
  let windowFollowBound = false;
  /** @type {Element | null} */
  let innerScrollBound = null;
  let viewportRaf = 0;

  function findScrollRoot() {
    return geo().findScrollRoot(progressMapped?.root);
  }

  function progressAxisYRange() {
    return geo().axisYRange(progressMapped?.root, findScrollRoot());
  }

  function clientRectNearCp(cp0) {
    if (!progressMapped || !progressIdx || cp0 < 0) return null;
    const fullCp = progressIdx.utf16ToCp(progressMapped.text.length);
    if (cp0 >= fullCp) return null;
    const u0 = progressIdx.cpToUtf16(cp0);
    const u1 = progressIdx.cpToUtf16(Math.min(fullCp, cp0 + 128));
    for (const range of rangesFromUtf16(progressMapped.pieces, progressMapped.text, u0, u1)) {
      if (!/\S/.test(range.toString())) continue;
      for (const r of range.getClientRects()) {
        if (r.width >= 1 && r.height >= 1) return r;
      }
    }
    return null;
  }

  function measureChunkContentY(chunk, scrollRoot) {
    const hit = progressYCache.get(chunk.start);
    if (hit) return hit;
    const startRect = clientRectNearCp(chunk.start);
    const endRect = clientRectNearCp(Math.max(chunk.start, chunk.end - 1));
    if (!startRect && !endRect) return null;
    const top = startRect || endRect;
    const bot = endRect || startRect;
    let y0 = geo().contentYFromClientY(top.top, scrollRoot);
    let y1 = geo().contentYFromClientY(bot.bottom, scrollRoot);
    if (y1 < y0) {
      const t = y0;
      y0 = y1;
      y1 = t;
    }
    const row = { y0, y1 };
    progressYCache.set(chunk.start, row);
    return row;
  }

  function measureNextContentY(chunk, scrollRoot) {
    for (const row of progressSegs) {
      if (row.start > chunk.start) return measureChunkContentY(row, scrollRoot);
    }
    return null;
  }

  /** 进度图横轴占用的文档 Y：与竖线 abut 一致（接到下一段顶，含图/空档）。 */
  function axisYFromBoxes(cy, nextCy) {
    if (!cy) return null;
    if (nextCy && nextCy.y0 > cy.y0) return { y0: cy.y0, y1: nextCy.y0 };
    return cy;
  }

  function chunksCoveringContentY(contentY, scrollRoot) {
    const hits = [];
    for (const chunk of progressRows) {
      const cy = axisYFromBoxes(
        measureChunkContentY(chunk, scrollRoot),
        measureNextContentY(chunk, scrollRoot),
      );
      if (cy && cy.y0 <= contentY && contentY <= cy.y1) hits.push(chunk);
    }
    return hits;
  }

  function scrollToContentY(contentY, highlightChunks) {
    const root = progressMapped?.root;
    if (contentY == null || !root) return;
    const scrollRoot = findScrollRoot();
    const focus = geo().scrollTopAtContentY(contentY, scrollRoot, VIEWPORT_FOCUS_Y_RATIO);
    let top = focus.top;
    if (highlightChunks.length) {
      let startY = null;
      for (const chunk of highlightChunks) {
        const cy = measureChunkContentY(chunk, scrollRoot);
        if (cy && (startY == null || cy.y0 < startY)) startY = cy.y0;
      }
      if (startY != null) {
        top = Math.min(
          top,
          geo().scrollTopAtContentY(startY, scrollRoot, CHUNK_START_MAX_Y_RATIO).top,
        );
      }
    }
    focus.target.scrollTo({ top, behavior: 'auto' });
  }

  function applyProgressSelectedClass() {
    const lines = document.getElementById('ih-progress-lines');
    if (!(lines instanceof SVGGElement)) return;
    for (const el of lines.children) {
      if (!(el instanceof SVGGElement) || el.dataset.progressStart == null) continue;
      el.querySelector('.ih-progress-line')?.classList.toggle(
        'is-selected',
        selectedStarts.has(Number(el.dataset.progressStart)),
      );
    }
  }

  function clearSelected() {
    if (selectHoldTimer) {
      clearTimeout(selectHoldTimer);
      selectHoldTimer = 0;
    }
    clearUnderline();
    if (!selectedStarts.size) return;
    selectedStarts = new Set();
    applyProgressSelectedClass();
  }

  function revealAtContentY(contentY) {
    clearSelected();
    const scrollRoot = findScrollRoot();
    const chunks = contentY != null ? chunksCoveringContentY(contentY, scrollRoot) : [];
    requestAnimationFrame(() => {
      if (contentY != null) scrollToContentY(contentY, chunks);
      selectedStarts = new Set(chunks.map((c) => c.start));
      applyProgressSelectedClass();
      paintUnderlines(chunks);
      if (!chunks.length) return;
      selectHoldTimer = window.setTimeout(() => {
        selectHoldTimer = 0;
        clearSelected();
      }, SELECT_HOLD_MS);
    });
  }

  function chartEls() {
    const chart = document.getElementById('ih-progress');
    const lines = document.getElementById('ih-progress-lines');
    const band = document.getElementById('ih-progress-viewport');
    if (!(chart instanceof SVGSVGElement) || !(lines instanceof SVGGElement) || !(band instanceof SVGRectElement)) {
      return null;
    }
    return { chart, lines, band };
  }

  function progressChartLayout(chart) {
    const width = Math.max(1, Math.round(chart.clientWidth));
    const height = Math.max(1, Math.round(chart.clientHeight));
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    return { x0: 4, x1: width - 4, y0: height - 7, y1: 4, axis: progressAxisYRange() };
  }

  function setHoveredProgress(start) {
    if (hoveredStart === start) return;
    const ui = chartEls();
    if (!ui) return;
    const previous = hoveredStart;
    hoveredStart = start;
    for (const chunkStart of [previous, start]) {
      if (chunkStart == null) continue;
      const group = [...ui.lines.children].find((el) => el.dataset.progressStart === String(chunkStart));
      group?.querySelector('.ih-progress-line')?.classList.toggle('is-hovered', chunkStart === start);
      group?.querySelector('.ih-progress-label')?.toggleAttribute('hidden', chunkStart !== start);
    }
  }

  function upsertProgressLine(layout, chunk, cy, nextCy, group) {
    const ui = chartEls();
    if (!ui) return;
    const { x0, x1, y0, y1, axis } = layout;
    if (!axis) return;
    if (!nextCy) nextCy = measureNextContentY(chunk, axis.scrollRoot);
    const degree = Math.max(
      0,
      Math.min(1, (chunk.bits - PROGRESS_BITS_MIN) / (PROGRESS_BITS_MAX - PROGRESS_BITS_MIN)),
    );
    const axisY = axisYFromBoxes(cy, nextCy);
    const abut = !!(nextCy && nextCy.y0 > cy.y0);
    const yStart = Math.max(axis.y0, Math.min(axis.y1, axisY.y0));
    const yEnd = Math.max(axis.y0, Math.min(axis.y1, axisY.y1));
    const start = geo().xFromContentY(yStart, x0, x1, axis);
    const end = geo().xFromContentY(yEnd, x0, x1, axis);
    if (!group) {
      group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.dataset.progressStart = String(chunk.start);
      const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      lineEl.classList.add('ih-progress-line');
      group.appendChild(lineEl);
      const labelEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      labelEl.classList.add('ih-progress-label');
      labelEl.setAttribute('text-anchor', 'middle');
      labelEl.setAttribute('hidden', '');
      group.appendChild(labelEl);
      const hitEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hitEl.classList.add('ih-progress-hit');
      hitEl.addEventListener('mouseenter', () => setHoveredProgress(chunk.start));
      hitEl.addEventListener('mouseleave', () => {
        if (hoveredStart === chunk.start) setHoveredProgress(null);
      });
      group.appendChild(hitEl);
      ui.lines.appendChild(group);
    }
    const line = /** @type {SVGPathElement} */ (group.querySelector('.ih-progress-line'));
    const label = /** @type {SVGTextElement} */ (group.querySelector('.ih-progress-label'));
    const hitArea = /** @type {SVGRectElement} */ (group.querySelector('.ih-progress-hit'));
    line.classList.toggle('is-selected', selectedStarts.has(chunk.start));
    line.classList.toggle('is-hovered', hoveredStart === chunk.start);
    const lineEnd = abut ? Math.max(start, end) : Math.max(start + PROGRESS_MIN_WIDTH_PX, end);
    const y = y0 - (y0 - y1) * degree;
    line.setAttribute('d', `M${start} ${y}H${lineEnd}`);
    label.setAttribute('x', String((start + lineEnd) / 2));
    label.setAttribute('y', String(Math.max(y1 + 10, y - 4)));
    label.textContent = `${chunk.bits.toFixed(1)} bits`;
    label.toggleAttribute('hidden', hoveredStart !== chunk.start);
    hitArea.setAttribute('x', String(start));
    hitArea.setAttribute('y', String(y1));
    hitArea.setAttribute('width', String(lineEnd - start));
    hitArea.setAttribute('height', String(y0 - y1));
  }

  function applyProgressViewportBand() {
    const ui = chartEls();
    if (!ui) return;
    if (ui.chart.hasAttribute('hidden')) {
      ui.band.setAttribute('hidden', '');
      return;
    }
    const axis = progressAxisYRange();
    if (!axis) {
      ui.band.setAttribute('hidden', '');
      return;
    }
    const view = geo().viewportContentY(axis.scrollRoot);
    const startY = Math.max(axis.y0, view.top);
    const endY = Math.min(axis.y1, view.bottom);
    if (!(startY < endY)) {
      ui.band.setAttribute('hidden', '');
      return;
    }
    const width = Math.max(1, Math.round(ui.chart.clientWidth));
    const height = Math.max(1, Math.round(ui.chart.clientHeight));
    const x0 = 4;
    const x1 = width - 4;
    const xStart = geo().xFromContentY(startY, x0, x1, axis);
    const xEnd = geo().xFromContentY(endY, x0, x1, axis);
    ui.band.removeAttribute('hidden');
    ui.band.setAttribute('x', String(xStart));
    ui.band.setAttribute('y', '0');
    ui.band.setAttribute('width', String(Math.max(PROGRESS_MIN_WIDTH_PX, xEnd - xStart)));
    ui.band.setAttribute('height', String(height));
  }

  function scheduleViewportBand() {
    if (progressRows.length === 0 && !progressSearching) return;
    if (viewportRaf) return;
    viewportRaf = requestAnimationFrame(() => {
      viewportRaf = 0;
      applyProgressViewportBand();
    });
  }

  function unbindInnerScroll() {
    if (!innerScrollBound) return;
    innerScrollBound.removeEventListener('scroll', scheduleViewportBand);
    innerScrollBound = null;
  }

  function unbindFollow() {
    if (windowFollowBound) {
      window.removeEventListener('scroll', scheduleViewportBand, true);
      window.removeEventListener('resize', onProgressResize);
      windowFollowBound = false;
    }
    unbindInnerScroll();
  }

  function onProgressResize() {
    progressYCache = new Map();
    renderProgress();
  }

  function bindFollow() {
    const need = progressEnabled && (progressSearching || progressRows.length > 0);
    if (!need) {
      unbindFollow();
      return;
    }
    if (!windowFollowBound) {
      window.addEventListener('scroll', scheduleViewportBand, { passive: true, capture: true });
      window.addEventListener('resize', onProgressResize);
      windowFollowBound = true;
    }
    const root = findScrollRoot();
    if (!root || geo().isWindowScrollRoot(root)) {
      unbindInnerScroll();
      return;
    }
    if (innerScrollBound === root) return;
    unbindInnerScroll();
    innerScrollBound = root;
    root.addEventListener('scroll', scheduleViewportBand, { passive: true });
  }

  function renderProgress() {
    const ui = chartEls();
    if (!ui) return;
    if (!progressEnabled) {
      ui.chart.setAttribute('hidden', '');
      ui.band.setAttribute('hidden', '');
      ui.lines.replaceChildren();
      unbindFollow();
      return;
    }
    const hidden = progressRows.length === 0 && !progressSearching;
    ui.chart.toggleAttribute('hidden', hidden);
    if (progressRows.length === 0) {
      ui.lines.replaceChildren();
      if (hidden) ui.band.setAttribute('hidden', '');
      bindFollow();
      if (!hidden) applyProgressViewportBand();
      return;
    }
    const layout = progressChartLayout(ui.chart);
    const groupsByStart = new Map(
      [...ui.lines.children]
        .filter((el) => el instanceof SVGGElement && el.dataset.progressStart != null)
        .map((el) => [Number(el.dataset.progressStart), el]),
    );
    const liveStarts = new Set();
    const rows = [];
    if (layout.axis) {
      for (const chunk of progressRows) {
        const cy = measureChunkContentY(chunk, layout.axis.scrollRoot);
        if (cy) rows.push({ chunk, cy });
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const { chunk, cy } = rows[i];
      liveStarts.add(chunk.start);
      upsertProgressLine(layout, chunk, cy, rows[i + 1]?.cy, groupsByStart.get(chunk.start));
    }
    for (const [start, group] of groupsByStart) {
      if (!liveStarts.has(start)) group.remove();
    }
    bindFollow();
    applyProgressViewportBand();
  }

  function onChartPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const ui = chartEls();
    const axis = progressAxisYRange();
    if (!ui || !axis) return;
    const ctm = ui.chart.getScreenCTM();
    if (!ctm) return;
    const x = new DOMPoint(event.clientX, 0).matrixTransform(ctm.inverse()).x;
    const width = Math.max(1, Math.round(ui.chart.clientWidth));
    revealAtContentY(geo().contentYFromX(x, 4, width - 4, axis));
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = HOST_ID;
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chart.id = 'ih-progress';
    chart.setAttribute('viewBox', '0 0 100 100');
    chart.setAttribute('aria-label', 'Information progress');
    chart.setAttribute('hidden', '');
    const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    band.id = 'ih-progress-viewport';
    band.setAttribute('hidden', '');
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    lines.id = 'ih-progress-lines';
    chart.append(band, lines);
    host.appendChild(chart);
    document.documentElement.appendChild(host);
    if (!hostWired) {
      hostWired = true;
      chart.addEventListener('pointerdown', onChartPointerDown);
    }
    return host;
  }

  /**
   * @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element }} mapped
   * @param {{ start: number, end: number }[]} segs
   */
  function bindProgress(mapped, segs) {
    progressMapped = mapped;
    progressIdx = globalThis.IL_createTextIndex(mapped.text);
    progressYCache = new Map();
    progressRows = [];
    progressSegs = segs.map((s) => ({
      start: progressIdx.utf16ToCp(s.start),
      end: progressIdx.utf16ToCp(s.end),
    }));
    selectedStarts = new Set();
    hoveredStart = null;
    ensureHost();
    renderProgress();
  }

  function setProgressSearching(on) {
    progressSearching = !!on;
    ensureHost();
    renderProgress();
  }

  /**
   * @param {Array<{ real_topk?: [number, number] | null }>} tokens
   * @param {{ start: number, end: number }} seg
   */
  function appendProgress(tokens, seg) {
    if (!progressMapped || !progressIdx) {
      throw new Error('IH_appendProgress before IH_bindProgress');
    }
    const bits = averageBits(tokens);
    if (bits == null) return;
    progressRows.push({
      start: progressIdx.utf16ToCp(seg.start),
      end: progressIdx.utf16ToCp(seg.end),
      bits,
    });
    renderProgress();
  }

  function clearProgress() {
    progressSearching = false;
    progressMapped = null;
    progressIdx = null;
    progressRows = [];
    progressSegs = [];
    progressYCache = new Map();
    selectedStarts = new Set();
    hoveredStart = null;
    if (selectHoldTimer) {
      clearTimeout(selectHoldTimer);
      selectHoldTimer = 0;
    }
    if (viewportRaf) {
      cancelAnimationFrame(viewportRaf);
      viewportRaf = 0;
    }
    unbindFollow();
    hostWired = false;
    clearUnderline();
    document.getElementById(HOST_ID)?.remove();
  }

  globalThis.IH_extractPage = extractPage;
  globalThis.IH_splitSegments = splitSegments;
  globalThis.IH_segmentWindow = segmentWindow;
  globalThis.IH_tokensInSegment = tokensInSegment;
  globalThis.IH_paintTokens = paintTokens;
  globalThis.IH_tokenBits = tokenBits;
  globalThis.IH_rangesFromUtf16 = rangesFromUtf16;
  globalThis.IH_clearHighlights = clearHighlights;
  globalThis.IH_showError = showError;
  globalThis.IH_showPaused = showPaused;
  globalThis.IH_clearError = clearError;
  globalThis.IH_bindProgress = bindProgress;
  globalThis.IH_setProgressSearching = setProgressSearching;
  globalThis.IH_appendProgress = appendProgress;
  globalThis.IH_clearProgress = clearProgress;
})();
