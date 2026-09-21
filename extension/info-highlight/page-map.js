/**
 * 正文提取 + 码点偏移 → Range；网页 token 只绑 CSS Custom Highlight（勿 getClientRects）。
 * PDF：canvas 已含字形；色块会盖在字上、字色也改不了 canvas，resolvePaintStyle 回退成 overlay 红线（粗细随字盒高）。
 * 进度图量段 Y 例外，想法来自 extension/semantic-highlight/semantic/find.js（横轴=文档 Y / 视口带 / 点击跳转）。
 *
 * 段：切分力度 = 语义 800 字节 × 倍数。每次送 1 段前文 + 本段（1:1），只画本段。
 * 太短则左文不够、预测不准；太长则单次内存/耗时上去、首块上色更晚。约 400 token/段、800 token/窗，离 max_length=2000 仍宽裕，不必对齐本机 128 / 远程 256 的推理切块。
 * 骑在段界上的 BPE token：offset 裁进本段，不画进前文、也不丢掉本段侧。
 * 进度图：竖轴默认 4–8 bit；分析中亮空框，段回了加线；后一段从上一线终点起；不自动跟滚。
 */
(() => {
  if (!globalThis.IH_highlightStyle) {
    throw new Error('IH_highlightStyle missing — inject highlightStyle.js first');
  }
  if (typeof globalThis.IH_mergeWordTokens !== 'function') {
    throw new Error('IH_mergeWordTokens missing — inject wordMerge.js first');
  }
  const HS = globalThis.IH_highlightStyle;
  /** SYNC: client/src/shared/core/constants.ts → SEMANTIC_CHUNK_BYTES */
  const UNIT_BYTES = 800;
  const UNIT_MULTIPLIER = 2;
  const CONTEXT_UNITS = 1;
  const TOKEN_LEVELS = HS.TOKEN_LEVELS;
  const HL_PREFIX = 'ih-token-';
  /** SYNC: extension/semantic-highlight/semantic/find.js → HL_UNDERLINE（命名空间 ih-，避免和语义插件互踩） */
  const HL_UNDERLINE = 'ih-underline';
  const HOST_ID = 'ih-progress-host';
  const HOST_CSS = `
:host {
  all: initial;
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 2147483646;
  display: block;
  width: max-content;
  max-width: calc(100vw - 32px);
  pointer-events: none;
}
.semantic-find-bar-host {
  position: static;
  margin: 0;
  padding: 0;
  width: 338px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  box-sizing: border-box;
  pointer-events: none;
}
.semantic-match-progress {
  margin-top: 0;
  height: 36px;
}
.semantic-match-progress[hidden] + .semantic-find-status-list > :first-child {
  margin-top: 0;
}
`;
  /** SYNC: client/src/shared/cross/surprisalMath.ts → REFERENCE_MAX_SURPRISAL_BITS */
  const MAX_SURPRISAL_BITS = HS.MAX_SURPRISAL_BITS;
  const PROGRESS_BITS_MIN = 4;
  const PROGRESS_BITS_MAX = 8;
  /** SYNC: extension/semantic-highlight/semantic/find.js → PROGRESS_MIN_WIDTH_PX / VIEWPORT_FOCUS_Y_RATIO / CHUNK_START_MAX_Y_RATIO */
  const PROGRESS_MIN_WIDTH_PX = 2;
  const VIEWPORT_FOCUS_Y_RATIO = 0.5;
  const CHUNK_START_MAX_Y_RATIO = 0.2;
  const SELECT_HOLD_MS = 1000;
  /** shared/page/scrollGeometry.js：滚动容器与文档 Y 的换算 */
  const geo = () => globalThis.IL_scrollGeometry;
  const progressAxis = globalThis.IL_progressAxis;
  if (!progressAxis) throw new Error('IL_progressAxis missing — inject progressAxis.js first');

  function requireOverlay() {
    if (!globalThis.IL_overlay) throw new Error('IL_overlay missing — inject overlay.js first');
    return globalThis.IL_overlay;
  }

  function requireFns() {
    if (typeof globalThis.IL_findArticleRoot !== 'function') {
      throw new Error('IL_findArticleRoot missing — inject articleRoot.js first');
    }
    if (typeof globalThis.IL_collectTextMap !== 'function') {
      throw new Error('IL_collectTextMap missing — inject collectTextMap.js first');
    }
  }

  const KEY_ARTICLE_ONLY = 'ih_article_only';
  const KEY_WORD_MERGE = 'ih_word_merge';
  let articleOnly = true;
  let wordMerge = false;

  function extractPage() {
    requireFns();
    const root = globalThis.IL_findArticleRoot(document, {
      articleOnly: globalThis.IH_OPTIONS_PAGE ? false : articleOnly,
    });
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
  /**
   * 单 piece 上建 Range；节点失效或偏移越界则跳过（不抛），便于动态页局部放弃。
   */
  function rangeForPiece(p, text, seg0, seg1) {
    if (!p?.node?.isConnected) return null;
    const nodeText = p.node.nodeValue ?? p.node.data;
    if (nodeText == null) return null;
    const nodeLen = nodeText.length;
    const startOff = seg0 - p.start;
    const endOff = seg1 - p.start;
    if (startOff < 0 || endOff > nodeLen || endOff <= startOff) return null;
    if (!/\S/.test(text.slice(seg0, seg1))) return null;
    const r = document.createRange();
    try {
      r.setStart(p.node, startOff);
      r.setEnd(p.node, endOff);
    } catch {
      return null;
    }
    return r.collapsed ? null : r;
  }

  function rangesFromUtf16(pieces, text, u0, u1) {
    if (u1 <= u0) return [];
    let i = globalThis.IL_findPieceIndex(pieces, u0);
    if (i < 0) return [];
    const out = [];
    for (; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.start >= u1) break;
      const seg0 = Math.max(u0, p.start);
      const seg1 = Math.min(u1, p.end);
      if (seg1 <= seg0) continue;
      const r = rangeForPiece(p, text, seg0, seg1);
      if (r) out.push(r);
    }
    return out;
  }

  function requireHighlightApi() {
    if (!CSS.highlights || typeof Highlight !== 'function') {
      throw new Error('CSS Custom Highlight API missing');
    }
  }

  function originCssColor(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) throw new Error('origin color: no element');
    const c = getComputedStyle(el).color;
    if (!c) throw new Error('origin color empty');
    return c;
  }

  function tokenHighlightNames() {
    const keys = CSS.highlights.keys?.();
    if (!keys) {
      return Array.from({ length: TOKEN_LEVELS }, (_, i) => HL_PREFIX + i);
    }
    return [...keys].filter((name) => name.startsWith(HL_PREFIX));
  }

  function textFgSheet() {
    let el = document.getElementById('ih-text-fg-css');
    if (el) return el.sheet;
    el = document.createElement('style');
    el.id = 'ih-text-fg-css';
    document.documentElement.appendChild(el);
    return el.sheet;
  }

  /** 字色/淡去规则写死了当时的原文色；主题变了必须丢掉再画。 */
  function forgetTextFg() {
    document.getElementById('ih-text-fg-css')?.remove();
    if (!CSS.highlights?.delete) return;
    const base = new RegExp(`^${HL_PREFIX}\\d+$`);
    for (const name of tokenHighlightNames()) {
      if (base.test(name)) continue;
      CSS.highlights.delete(name);
    }
  }

  /** 原文色/rgb 进 Highlight 名前先洗成合法标识，两处共用，改一处即全改 */
  function identForHighlightName(s) {
    return String(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function highlightForTextRange(range, level) {
    const origin = originCssColor(range.startContainer);
    const rgb = HS.rgbForTextColor(highlightPrefs.textColor);
    const name = `${HL_PREFIX}${level}-${identForHighlightName(origin)}-${identForHighlightName(rgb)}`;
    if (!CSS.highlights.has(name)) {
      const h = new Highlight();
      h.priority = level;
      CSS.highlights.set(name, h);
      const sheet = textFgSheet();
      sheet.insertRule(
        // 覆盖率：线性光 lerp。Oklab 会把前半段混成浑浊深色。
        `::highlight(${name}){background-color:transparent;color:color-mix(in srgb-linear,rgb(${rgb}) var(--ih-token-pct-${level}),${origin})}`,
        sheet.cssRules.length,
      );
    }
    const h = CSS.highlights.get(name);
    if (!h) throw new Error(`highlight missing: ${name}`);
    return h;
  }

  /** 淡去：只混原文色与透明，不引入高亮色；不透明度走 --ih-fade-pct-level。 */
  function highlightForFadeRange(range, level) {
    const origin = originCssColor(range.startContainer);
    const name = `${HL_PREFIX}fade-${level}-${identForHighlightName(origin)}`;
    if (!CSS.highlights.has(name)) {
      const h = new Highlight();
      h.priority = level;
      CSS.highlights.set(name, h);
      const fallback = HS.fadeOpacityForLevel(level, highlightPrefs.fadeMinPct) * 100;
      const sheet = textFgSheet();
      sheet.insertRule(
        `::highlight(${name}){background-color:transparent;color:color-mix(in srgb,${origin} var(--ih-fade-pct-${level},${fallback}%),transparent)}`,
        sheet.cssRules.length,
      );
    }
    const h = CSS.highlights.get(name);
    if (!h) throw new Error(`highlight missing: ${name}`);
    return h;
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

  /** @type {{ tokens: unknown[], mapped: { text: string, pieces: unknown[], root?: Element } | null, overlay: boolean }} */
  let paintBuf = { tokens: [], mapped: null, overlay: false };

  /** @type {{ twoTier: boolean, thresholdPct: number, maxAlphaDepth: number, fadeMinPct: number, paintStyle: string }} */
  let highlightPrefs = HS.normalizePrefs(HS.STORAGE_DEFAULTS);

  function tokenMaxAlpha() {
    return HS.depthToMaxAlpha(highlightPrefs.maxAlphaDepth, highlightPrefs.paintStyle, 'pdf');
  }

  function applyTokenColors() {
    HS.applyCssVars(document.documentElement, highlightPrefs);
  }

  function clearTokenOverlays() {
    for (const el of tokenOverlayEls) el.remove();
    tokenOverlayEls = [];
  }

  /** 清 token 画布（Highlight + PDF 线），保留进度下划线与 paintBuf */
  function clearTokenPaints() {
    clearTokenOverlays();
    if (!CSS.highlights) return;
    for (const name of tokenHighlightNames()) {
      CSS.highlights.get(name)?.clear();
    }
    forgetTextFg();
  }

  function tokenOverlayMount(root) {
    if (typeof root.querySelector !== 'function') return root;
    let host = root.querySelector('#ih-token-overlay');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'ih-token-overlay';
    root.appendChild(host);
    return host;
  }

  /** 线相对 pages root；粗细随字盒高，见 HS.underlineOverlayBox */
  function tokenOverlayContext(root) {
    if (!root) throw new Error('token overlay root missing');
    const mount = tokenOverlayMount(root);
    return {
      root: mount,
      rect: root.getBoundingClientRect(),
    };
  }

  function appendTokenUnderline(rect, level, ctx, parent) {
    const box = HS.underlineOverlayBox(rect, ctx.rect);
    const el = document.createElement('div');
    el.className = 'il-token-underline';
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.transform = 'none';
    const a = HS.alphaForLevel(
      level,
      tokenMaxAlpha(),
      highlightPrefs.twoTier,
    );
    el.style.backgroundColor = `rgba(${HS.rgbForColor(highlightPrefs.highlightColor)}, ${a})`;
    (parent || ctx.root).appendChild(el);
    tokenOverlayEls.push(el);
  }

  function rangeLive(range) {
    const a = range.startContainer;
    const b = range.endContainer;
    return !!(a && b && a.isConnected && b.isConnected && !range.collapsed);
  }

  /** 画完之后 DOM 再变：只丢掉映不回的 range，不重抽、不重画。只动本插件登记。 */
  function pruneDetachedHighlights() {
    if (!CSS.highlights) return;
    const visit = (h) => {
      if (!h || typeof h.delete !== 'function') return;
      for (const range of [...h]) {
        if (!rangeLive(range)) h.delete(range);
      }
    };
    for (const name of tokenHighlightNames()) visit(CSS.highlights.get(name));
    visit(CSS.highlights.get(HL_UNDERLINE));
  }

  let liveWatch = null;
  let liveWatchTimer = 0;

  function stopHighlightLiveWatch() {
    liveWatch?.disconnect();
    liveWatch = null;
    if (liveWatchTimer) {
      clearTimeout(liveWatchTimer);
      liveWatchTimer = 0;
    }
  }

  function watchHighlightLive() {
    stopHighlightLiveWatch();
    const root = document.documentElement;
    if (!root || typeof MutationObserver !== 'function') return;
    liveWatch = new MutationObserver(() => {
      if (liveWatchTimer) return;
      liveWatchTimer = window.setTimeout(() => {
        liveWatchTimer = 0;
        pruneDetachedHighlights();
      }, 120);
    });
    liveWatch.observe(root, { childList: true, subtree: true });
  }

  function clearHighlights() {
    stopHighlightLiveWatch();
    clearTokenPaints();
    clearUnderline();
    paintBuf = { tokens: [], mapped: null, overlay: false };
  }

  /**
   * classic = token bits（站点默认 tokenRenderStyle）。
   * SYNC: client/src/shared/core/Util.ts → calculateSurprisal（p≤0 用 EPSILON 托底）
   * @param {{ p?: number | null, real_topk?: [number, number] | null }} tok
   * @returns {number | null}
   */
  function tokenBits(tok) {
    const p = Number.isFinite(tok?.p) ? tok.p : tok?.real_topk?.[1];
    if (!Number.isFinite(p)) return null;
    return -Math.log2(Math.max(p, Number.EPSILON));
  }

  /** @param {{ p?: number | null, real_topk?: [number, number] | null }} tok */
  function tokenLevel(tok) {
    const bits = tokenBits(tok);
    if (bits == null) return -1;
    if (highlightPrefs.paintStyle === HS.PAINT_FADE) return HS.tokenLevelForFade(bits);
    return HS.tokenLevelFromBits(bits, highlightPrefs);
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

  function repaintFromBuffer() {
    const { tokens, mapped, overlay } = paintBuf;
    if (!mapped || !tokens.length) return;
    clearTokenPaints();
    paintBuf = { tokens: [], mapped: null, overlay: false };
    paintTokens(tokens, mapped, { append: false, overlay });
  }

  /**
   * @param {Array<{ offset: [number, number], raw?: string, real_topk?: [number, number] | null }>} tokens
   * @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root?: Element }} mapped
   * @param {{ append?: boolean, overlay?: boolean }} [opts] overlay：PDF 画红线，不用 ::highlight 底色
   * @returns {{ painted: number, tokens_in: number, tokens_skip_level: number, tokens_skip_empty_range: number }}
   */
  function paintTokens(tokens, mapped, opts) {
    ensureHighlightRegistry();
    if (!opts?.append) {
      clearTokenPaints();
      paintBuf = { tokens: [], mapped: null, overlay: false };
    }
    paintBuf.mapped = mapped;
    paintBuf.overlay = !!opts?.overlay;
    for (const tok of tokens) paintBuf.tokens.push(tok);

    const overlay = opts?.overlay ? tokenOverlayContext(mapped.root) : null;
    if (overlay && HS.resolvePaintStyle(highlightPrefs.paintStyle, 'pdf') !== HS.PAINT_UNDERLINE) {
      throw new Error('PDF paint fallback is underline only');
    }
    const idx = opts?.index || globalThis.IL_createTextIndex(mapped.text);
    const incoming = Array.isArray(tokens) ? tokens : [];
    const list = opts?.skipMerge ? incoming : tokensForPaint(incoming, mapped.text);
    const overlayParent = overlay ? document.createDocumentFragment() : null;
    const stats = {
      painted: 0,
      tokens_in: list.length,
      tokens_skip_level: 0,
      tokens_skip_empty_range: 0,
    };
    for (const tok of list) {
      const level = tokenLevel(tok);
      const fadePaint = !overlay && highlightPrefs.paintStyle === HS.PAINT_FADE;
      if (fadePaint ? level < 0 : level < 1) {
        stats.tokens_skip_level += 1;
        continue;
      }
      const off = tok.offset;
      if (!Array.isArray(off) || off.length < 2) {
        throw new Error('Analyze token missing offset');
      }
      const u0 = idx.cpToUtf16(off[0]);
      const u1 = idx.cpToUtf16(off[1]);
      const textPaint = !overlay && highlightPrefs.paintStyle === HS.PAINT_TEXT;
      const h = overlay || textPaint || fadePaint ? null : CSS.highlights.get(HL_PREFIX + level);
      if (!overlay && !textPaint && !fadePaint && !h) {
        throw new Error(`highlight missing: ${HL_PREFIX}${level}`);
      }
      let n = 0;
      for (const range of rangesFromUtf16(mapped.pieces, mapped.text, u0, u1)) {
        if (!/\S/.test(range.toString())) continue;
        if (!overlay) {
          (fadePaint
            ? highlightForFadeRange(range, level)
            : textPaint
              ? highlightForTextRange(range, level)
              : h
          ).add(range);
          n += 1;
          continue;
        }
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          appendTokenUnderline(r, level, overlay, overlayParent);
          n += 1;
        }
      }
      if (n === 0) stats.tokens_skip_empty_range += 1;
      else stats.painted += n;
    }
    if (overlayParent) overlay.root.appendChild(overlayParent);
    return stats;
  }

  function tokensForPaint(tokens, text) {
    const incoming = Array.isArray(tokens) ? tokens : [];
    return wordMerge ? globalThis.IH_mergeWordTokens(incoming, text) : incoming;
  }

  function applyHighlightPrefs(raw) {
    const next = HS.normalizePrefs(raw);
    // 淡去模式下强度/阈值/颜色行已隐藏，改它们不用重画；淡去量走 CSS 变量实时生效；切画法自会重画。
    const fadeInvolved = next.paintStyle === HS.PAINT_FADE
      || highlightPrefs.paintStyle === HS.PAINT_FADE;
    const levelChanged = !fadeInvolved && (
      next.twoTier !== highlightPrefs.twoTier
      || next.thresholdPct !== highlightPrefs.thresholdPct
    );
    const paintStyleChanged = next.paintStyle !== highlightPrefs.paintStyle;
    const alphaChanged = !fadeInvolved && (next.maxAlphaDepth !== highlightPrefs.maxAlphaDepth
      || paintStyleChanged);
    const colorChanged = !fadeInvolved && (next.highlightColor !== highlightPrefs.highlightColor
      || next.textColor !== highlightPrefs.textColor);
    highlightPrefs = next;
    applyTokenColors();
    if (
      levelChanged
      || paintStyleChanged
      || ((alphaChanged || colorChanged) && paintBuf.overlay)
      || (colorChanged && next.paintStyle === HS.PAINT_TEXT)
    ) {
      repaintFromBuffer();
    }
  }

  const prefsDefaults = {
    ...HS.STORAGE_DEFAULTS,
    [KEY_ARTICLE_ONLY]: true,
    [KEY_WORD_MERGE]: false,
  };

  const prefsReady = new Promise((resolve) => {
    const get = chrome.storage?.local?.get;
    if (typeof get !== 'function') {
      resolve();
      return;
    }
    get.call(chrome.storage.local, prefsDefaults, (res) => {
      applyHighlightPrefs(res);
      articleOnly = res?.[KEY_ARTICLE_ONLY] !== false;
      wordMerge = res?.[KEY_WORD_MERGE] === true;
      resolve();
    });
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area && area !== 'local') return;
    if (KEY_ARTICLE_ONLY in changes) {
      articleOnly = changes[KEY_ARTICLE_ONLY].newValue !== false;
    }
    if (KEY_WORD_MERGE in changes) {
      const next = changes[KEY_WORD_MERGE].newValue === true;
      if (next !== wordMerge) {
        wordMerge = next;
        if (paintBuf.mapped && paintBuf.tokens.length) repaintFromBuffer();
      }
    }
    if (
      !(HS.KEY_TWO_TIER in changes)
      && !(HS.KEY_THRESHOLD_PCT in changes)
      && !(HS.KEY_MAX_ALPHA_DEPTH in changes)
      && !(HS.KEY_FADE_MIN_PCT in changes)
      && !(HS.KEY_PAINT_STYLE in changes)
      && !(HS.KEY_HIGHLIGHT_COLOR in changes)
      && !(HS.KEY_TEXT_COLOR in changes)
    ) {
      return;
    }
    chrome.storage.local.get(HS.STORAGE_DEFAULTS, (res) => {
      applyHighlightPrefs(res);
    });
  });

  HS.watchColorScheme(() => {
    applyTokenColors();
    if (
      highlightPrefs.paintStyle !== HS.PAINT_TEXT
      && highlightPrefs.paintStyle !== HS.PAINT_FADE
    ) {
      return;
    }
    if (!paintBuf.mapped || !paintBuf.tokens.length) return;
    requestAnimationFrame(() => repaintFromBuffer());
  });

  function shortError(msg) {
    if (globalThis.IH_userErrors?.pageAnalyzeError) {
      return globalThis.IH_userErrors.pageAnalyzeError(msg);
    }
    let t = String(msg || 'Analyze failed').replace(/\s+/g, ' ').trim();
    if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(t)) {
      t = 'Cannot reach the analyze server';
    }
    return t.length > 120 ? t.slice(0, 119) + '…' : t;
  }

  async function noticeList() {
    await ensureHost();
    const list = ui$('ih-status-list');
    if (!list) throw new Error('ih-status-list missing');
    return list;
  }

  function attachErrorFeedback(el, userDetail) {
    const feedback = globalThis.IL_statusFeedback;
    const ctx = globalThis.IH_feedbackContext;
    if (!feedback || !ctx) return;
    const feedbackBtn = el.querySelector('.semantic-find-status-feedback');
    if (!(feedbackBtn instanceof HTMLButtonElement)) return;
    feedback.resetButton(feedbackBtn);
    feedbackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      feedback.sendReport(
        feedbackBtn,
        ctx.buildUserReport({ label: 'Failed', detail: userDetail }),
      );
    });
  }

  async function showError(msg) {
    const ctx = globalThis.IH_feedbackContext;
    if (ctx && !ctx.peek()) ctx.stashMinimal(msg, 'web');
    const userDetail = shortError(msg);
    const list = await noticeList();
    const el = requireOverlay().createStatus({
      label: 'Failed',
      detail: userDetail,
      tone: 'error',
      continueHidden: true,
      feedbackHidden: false,
      onClose: clearError,
    });
    attachErrorFeedback(el, userDetail);
    list.replaceChildren(el);
  }

  async function showPaused(onContinue) {
    const list = await noticeList();
    list.replaceChildren(requireOverlay().createStatus({
      label: 'Paused',
      detail: 'Continue to highlight more',
      continueHidden: false,
      feedbackHidden: true,
      onContinue: () => {
        clearError();
        onContinue();
      },
      onClose: clearError,
    }));
  }

  function clearError() {
    ui$('ih-status-list')?.replaceChildren();
  }

  /** @type {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element } | null} */
  let progressMapped = null;
  /** @type {ReturnType<typeof globalThis.IL_createTextIndex> | null} */
  let progressIdx = null;
  /** @type {{ start: number, end: number, bits: number }[]} */
  let progressRows = [];
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
  /** @type {ShadowRoot | null} */
  let uiShadow = null;
  /** @type {Promise<HTMLElement> | null} */
  let hostReady = null;
  let hostEpoch = 0;
  /** @type {Element | null} */
  let innerScrollBound = null;
  let viewportRaf = 0;

  function ui$(id) {
    return uiShadow?.getElementById(id) ?? null;
  }

  function findScrollRoot() {
    return geo().findScrollRoot(progressMapped?.root);
  }

  function progressAxisYRange() {
    return geo().axisYRange(progressMapped?.root, findScrollRoot());
  }

  /** 本插件的码点 → Range；几何见 shared/page/progressAxis.js */
  function rangesFromChunkCp(cp0, cp1) {
    if (!progressMapped || !progressIdx || cp1 <= cp0) return [];
    return rangesFromUtf16(
      progressMapped.pieces,
      progressMapped.text,
      progressIdx.cpToUtf16(cp0),
      progressIdx.cpToUtf16(cp1),
    );
  }

  function measureChunkContentY(chunk, scrollRoot) {
    return progressAxis.measureChunkContentY(chunk, scrollRoot, progressYCache, rangesFromChunkCp);
  }

  function tiledProgress(scrollRoot) {
    const rows = [];
    for (const chunk of progressRows) {
      const cy = measureChunkContentY(chunk, scrollRoot);
      if (cy) rows.push({ chunk, cy });
    }
    return progressAxis.tileProgressRows(rows);
  }

  function chunksCoveringContentY(contentY, scrollRoot) {
    const hits = [];
    for (const { chunk, axisY } of tiledProgress(scrollRoot)) {
      if (axisY.y0 <= contentY && contentY <= axisY.y1) hits.push(chunk);
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
    const lines = ui$('ih-progress-lines');
    if (!(lines instanceof SVGGElement)) return;
    for (const el of lines.children) {
      if (!(el instanceof SVGGElement) || el.dataset.progressStart == null) continue;
      el.querySelector('.semantic-match-progress-line')?.classList.toggle(
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
    const chart = ui$('ih-progress');
    const lines = ui$('ih-progress-lines');
    const band = ui$('ih-progress-viewport');
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
      group?.querySelector('.semantic-match-progress-line')?.classList.toggle('is-hovered', chunkStart === start);
      group?.querySelector('.semantic-match-progress-label')?.toggleAttribute('hidden', chunkStart !== start);
    }
  }

  function upsertProgressLine(layout, chunk, axisY, group) {
    const ui = chartEls();
    if (!ui) return;
    const { x0, x1, y0, y1, axis } = layout;
    if (!axis) return;
    const degree = Math.max(
      0,
      Math.min(1, (chunk.bits - PROGRESS_BITS_MIN) / (PROGRESS_BITS_MAX - PROGRESS_BITS_MIN)),
    );
    const yStart = Math.max(axis.y0, Math.min(axis.y1, axisY.y0));
    const yEnd = Math.max(axis.y0, Math.min(axis.y1, axisY.y1));
    const start = geo().xFromContentY(yStart, x0, x1, axis);
    const end = geo().xFromContentY(yEnd, x0, x1, axis);
    if (!group) {
      group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.dataset.progressStart = String(chunk.start);
      const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      lineEl.classList.add('semantic-match-progress-line');
      group.appendChild(lineEl);
      const labelEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      labelEl.classList.add('semantic-match-progress-label');
      labelEl.setAttribute('text-anchor', 'middle');
      labelEl.setAttribute('hidden', '');
      group.appendChild(labelEl);
      const hitEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hitEl.classList.add('semantic-match-progress-hit-area');
      hitEl.addEventListener('mouseenter', () => setHoveredProgress(chunk.start));
      hitEl.addEventListener('mouseleave', () => {
        if (hoveredStart === chunk.start) setHoveredProgress(null);
      });
      group.appendChild(hitEl);
      ui.lines.appendChild(group);
    }
    const line = /** @type {SVGPathElement} */ (group.querySelector('.semantic-match-progress-line'));
    const label = /** @type {SVGTextElement} */ (group.querySelector('.semantic-match-progress-label'));
    const hitArea = /** @type {SVGRectElement} */ (group.querySelector('.semantic-match-progress-hit-area'));
    line.classList.toggle('is-selected', selectedStarts.has(chunk.start));
    line.classList.toggle('is-hovered', hoveredStart === chunk.start);
    const lineEnd = end > start ? end : start + PROGRESS_MIN_WIDTH_PX;
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
    const tiled = layout.axis ? tiledProgress(layout.axis.scrollRoot) : [];
    for (const { chunk, axisY } of tiled) {
      liveStarts.add(chunk.start);
      upsertProgressLine(layout, chunk, axisY, groupsByStart.get(chunk.start));
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

  function attachExistingHost(host) {
    uiShadow = host.shadowRoot;
    if (!uiShadow) throw new Error('ih-progress-host shadow missing');
    return host;
  }

  async function buildHost(epoch) {
    const css = await requireOverlay().loadCss();
    if (epoch !== hostEpoch) throw new Error('ih-progress-host cleared');
    const existing = document.getElementById(HOST_ID);
    if (existing) return attachExistingHost(existing);
    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    uiShadow = shadow;
    const style = document.createElement('style');
    style.textContent = css + '\n' + HOST_CSS;
    const wrap = document.createElement('div');
    wrap.className = 'semantic-find-bar-host';
    const uiOverlay = requireOverlay();
    uiOverlay.applyTheme(wrap);
    uiOverlay.watchTheme(wrap);
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chart.id = 'ih-progress';
    chart.classList.add('semantic-match-progress');
    chart.setAttribute('viewBox', '0 0 100 100');
    chart.setAttribute('aria-label', 'Information progress');
    chart.setAttribute('hidden', '');
    const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    band.id = 'ih-progress-viewport';
    band.classList.add('semantic-match-progress-viewport');
    band.setAttribute('hidden', '');
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    lines.id = 'ih-progress-lines';
    chart.append(band, lines);
    const list = document.createElement('div');
    list.id = 'ih-status-list';
    list.className = 'semantic-find-status-list';
    wrap.append(chart, list);
    shadow.append(style, wrap);
    if (epoch !== hostEpoch) throw new Error('ih-progress-host cleared');
    document.documentElement.appendChild(host);
    if (!hostWired) {
      hostWired = true;
      chart.addEventListener('pointerdown', onChartPointerDown);
    }
    return host;
  }

  async function ensureHost() {
    const existing = document.getElementById(HOST_ID);
    if (existing) return attachExistingHost(existing);
    if (!hostReady) {
      const epoch = hostEpoch;
      hostReady = buildHost(epoch);
      hostReady.catch(() => {
        if (epoch === hostEpoch) hostReady = null;
      });
    }
    return hostReady;
  }

  /**
   * @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element }} mapped
   * @param {{ start: number, end: number }[]} segs
   */
  async function bindProgress(mapped, segs) {
    await prefsReady;
    progressMapped = mapped;
    progressIdx = globalThis.IL_createTextIndex(mapped.text);
    progressYCache = new Map();
    progressRows = [];
    selectedStarts = new Set();
    hoveredStart = null;
    await ensureHost();
    renderProgress();
  }

  async function setProgressSearching(on) {
    progressSearching = !!on;
    await ensureHost();
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
    uiShadow = null;
    hostEpoch += 1;
    hostReady = null;
    clearUnderline();
    document.getElementById(HOST_ID)?.remove();
  }

  globalThis.IH_extractPage = extractPage;
  globalThis.IH_prefsReady = prefsReady;
  globalThis.IH_watchHighlightLive = watchHighlightLive;
  globalThis.IH_pruneDetachedHighlights = pruneDetachedHighlights;
  globalThis.IH_splitSegments = splitSegments;
  globalThis.IH_segmentWindow = segmentWindow;
  globalThis.IH_tokensInSegment = tokensInSegment;
  globalThis.IH_paintTokens = paintTokens;
  globalThis.IH_tokensForPaint = tokensForPaint;
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
