/**
 * InfoLens semantic find — feasibility content script.
 * Validates: article extract ↔ DOM map, API call, token paint, chunk underline.
 *
 * token / truncated：CSS Custom Highlight API（不改 DOM；truncated 为 CanvasText×Canvas 统一灰）。
 * underline（导航）/ pending-underline：#il-overlay-host 盖层，可叠画；统一蓝。
 * pending：fill 前是「等待染色」；fill 后若无红色 token，则留下作为 chunk 级匹配标记（有 token 才拆）。
 *
 * IL_CONFIG.domDebug：点击后只抽正文并下划线，便于目测提取范围（不唤起 Find bar）。
 */
(() => {
  // 已注入过：依赖齐全则只 reopen；缺 merge 副本说明上次注入过期（未重载扩展），拆掉重装
  if (window.__IL_SEMANTIC_DEMO__) {
    if (typeof globalThis.IL_mergeTokenSpansFullyForRendering === 'function') {
      window.__IL_SEMANTIC_DEMO__.open();
      return;
    }
    try {
      window.__IL_SEMANTIC_DEMO__.destroy();
    } catch {
      /* ignore */
    }
    window.__IL_SEMANTIC_DEMO__ = undefined;
  }

  const CFG = globalThis.IL_CONFIG || {
    apiBase: 'http://127.0.0.1:5001',
    chunkBytes: 800,
    maxChunks: 3,
    matchThreshold: 0.1,
    submode: 'hybrid',
    // SYNC 默认：站内 signal-fit 失败回退 P90；扩展用分位近似（见 prepareChunkTokens）
    pwScorePercentile: 0.9,
    domDebug: true,
    // 扩展侧节奏：默认 false = 无匹配时跟随、首个匹配后停下并划线（站内 demo 已无 Follow UI）
    followSearching: false,
  };
  const DOM_DEBUG = !!CFG.domDebug;

  // SYNC: client/src/shared/cross/SurprisalColorConfig.ts → SURPRISAL_RED / MAX_ALPHA（色值见 content.css ::highlight）
  /** token 背景量化档数（::highlight(il-token-0..15)） */
  const TOKEN_LEVELS = 16;
  const HL_TOKEN_PREFIX = 'il-token-';
  const HL_TRUNCATED = 'il-truncated';
  // SYNC: client/src/shared/vis/constants.ts → HIGHLIGHT_CONSTANTS
  const CHUNK_HIGHLIGHT_HOLD_MS = 200;
  const CHUNK_HIGHLIGHT_FADE_MS = 1400;
  // SYNC: client/src/shared/vis/GLTR_Text_Box.ts → scrollToUnicodeCharOffset 默认 viewportYRatio
  const CHUNK_JUMP_VIEWPORT_Y_RATIO = 0.2;
  // 分块语义搜索：最快节奏下限——两次渲染之间至少间隔这么久（无论是否有滚动）
  const CHUNK_SEARCH_MIN_CYCLE_MS = 500;
  // 有后续滚动时：染色后先停留一半，另一半留给滚动 settle；无滚动（已 park）时整段都算这里，见下方用法
  const CHUNK_SEARCH_HOLD_MS = CHUNK_SEARCH_MIN_CYCLE_MS / 2;
  const CHUNK_SEARCH_FOLLOW_VIEWPORT_Y_RATIO = 0.6;
  // 自动滚动落点（预滚到下一块 / 首次命中跳转）至少展示这么久，再进入下一块渲染
  const CHUNK_SEARCH_SCROLL_SETTLE_MS = CHUNK_SEARCH_MIN_CYCLE_MS / 2;

  /** @type {{ node: Text, start: number, end: number }[]} */
  let pieces = [];
  /** pieces 的节点集合缓存，供 mutationTouchesPieces 做 O(1) 命中判断，避免逐条 mutation 都线性扫 pieces */
  /** @type {Set<Text>} */
  let pieceNodeSet = new Set();
  let extractedText = '';
  /** @type {{ start: number, end: number, matchDegree: number }[]} */
  let matchedChunks = [];
  /** @type {{ start: number, end: number, matchDegree: number }[]} */
  let semanticMatchProgress = [];
  /** 进度条分母（码点数）：maxChunks 截断时用实际搜索覆盖长度，而非全文长度；0 = 未搜索，回退全文 */
  let progressTextLength = 0;
  /** @type {{ tone: string, label: string, detail: string } | null} */
  let lastStatusMeta = null;
  let statusFeedbackSent = false;
  let statusFeedbackHideTimer = 0;
  /** @type {{ query: string, contentChunkCount: number, truncated: boolean, windowEnd: number } | null} */
  let lastSearchMeta = null;
  let selectedProgressChunkStart = null;
  let hoveredProgressChunkStart = null;
  let matchIndex = -1;
  /**
   * 逻辑区间（去重键）；与 DOM 节点分离。
   * token：CSS Highlight；underline / pending-underline：overlay rect（reflow 时按 spec 重绘）。
   * @type {{ kind: 'token' | 'underline' | 'pending-underline', cp0: number, cp1: number, level?: number }[]}
   */
  let paintSpecs = [];
  /** @type {HTMLElement[]} underline / pending-underline DOM */
  let overlayEls = [];
  /** 未分析后缀置灰：已分析码点终点；null = 无置灰 */
  let truncatedAnalyzedCpEnd = null;
  /**
   * 长度 1 的搜索结果缓存（含 Stop 半成品）。close 清高亮但保留；
   * open 时若输入与正文未变则还原，避免重复请求。
   * @type {null | {
   *   query: string,
   *   text: string,
   *   paintSpecs: typeof paintSpecs,
   *   matchedChunks: typeof matchedChunks,
   *   semanticMatchProgress: typeof semanticMatchProgress,
   *   progressTextLength: number,
   *   matchIndex: number,
   *   truncatedAnalyzedCpEnd: number | null,
   *   selectedProgressChunkStart: number | null,
   *   status: typeof lastStatusMeta,
   *   searchMeta: typeof lastSearchMeta,
   * }}
   */
  let lastResult = null;
  /** @type {Element | null} 正文根（定滚动根用） */
  let extractRoot = null;
  /** @type {HTMLElement | null} underline 叠层宿主 + 布局监听哨兵 */
  let paintMount = null;
  /** @type {Element | null} 曾被设为 relative 的节点 */
  let paintPosTarget = null;
  /** 若曾把 paintPosTarget 从 static 改为 relative，清理时还原 */
  let paintPosRestore = null;
  /** @type {ResizeObserver | null} */
  let paintResizeObserver = null;
  /** 监听正文子树的文字改写（如翻译插件原地换字），弥补 ResizeObserver 只对尺寸变化敏感的盲区 */
  /** @type {MutationObserver | null} */
  let contentMutationObserver = null;
  /** 正文可能变了（mutation）；为 true 才值得全量 collectTextMap */
  let contentDirty = false;
  let scrollSyncTimer = 0;
  let searching = false;
  let abortWanted = false;
  /** 每次成功进入搜索 +1；finally 仅当仍是本轮 epoch 时清 searching，防并发误关 */
  let searchEpoch = 0;
  let reflowQueued = false;
  let underlineHoldTimer = 0;
  let underlineFadeTimer = 0;
  /** @type {(() => void) | null} */
  let scrollEndCancel = null;
  let underlineFadeGen = 0;
  let chunkSearchAutoScrollUserCancelled = false;
  /** @type {(() => void) | undefined} */
  let chunkSearchAutoScrollCleanup;

  /**
   * fill_blank 串行（在途最多 1）+ 匹配差背压：
   * pending = 排队 + 在飞；count 可超前至多 FILL_MATCH_LAG 个未完成 fill，再多则等。
   * 相对旧 hybrid（单块内 count→await fill 串行），异步 fill 会与 count 预取叠跑，
   * 增加额外并发（FETCH_AHEAD=1 时最坏约 2×count + 1×fill）。
   */
  const FILL_MATCH_LAG = 2;
  /** @type {(() => Promise<void>)[]} */
  const fillBlankQueue = [];
  let fillBlankBusy = false;
  /** @type {(() => void)[]} */
  let fillLagWaiters = [];
  /** 与 searchEpoch 分离：Continue 抬 epoch 不该作废上一批未完成的 fill */
  let fillGen = 0;

  function fillPendingCount() {
    return fillBlankQueue.length + (fillBlankBusy ? 1 : 0);
  }

  function wakeFillLagWaiters() {
    const waiters = fillLagWaiters.splice(0);
    for (const w of waiters) w();
  }

  function notifyFillLagWaiters() {
    if (fillPendingCount() >= FILL_MATCH_LAG) return;
    wakeFillLagWaiters();
  }

  function clearFillBlankQueue() {
    fillBlankQueue.length = 0;
    fillGen += 1;
    // 停止/重置须无条件唤醒，不可等在途 fill 降 pending
    wakeFillLagWaiters();
  }

  /** pending 降到 < FILL_MATCH_LAG 后再继续（允许再入队一个） */
  function waitUntilFillLagOk() {
    if (fillPendingCount() < FILL_MATCH_LAG) return Promise.resolve();
    return new Promise((resolve) => {
      fillLagWaiters.push(resolve);
    });
  }

  /** @param {(gen: number) => Promise<void>} job */
  function enqueueFillBlank(job) {
    const gen = fillGen;
    fillBlankQueue.push(() => job(gen));
    pumpFillBlankQueue();
  }

  function pumpFillBlankQueue() {
    if (fillBlankBusy) return;
    const job = fillBlankQueue.shift();
    if (!job) {
      notifyFillLagWaiters();
      return;
    }
    fillBlankBusy = true;
    Promise.resolve()
      .then(() => job())
      .catch((err) => {
        console.error('[InfoLens] fill_blank queue', err?.message || err);
      })
      .finally(() => {
        fillBlankBusy = false;
        notifyFillLagWaiters();
        pumpFillBlankQueue();
      });
  }

  // ---------- extract（纯文本查看器 / Readability 定根；后者失败不回退） ----------

  function pickArticleRoot() {
    const find = globalThis.IL_findArticleRoot;
    if (typeof find !== 'function') {
      throw new Error('IL_findArticleRoot missing — inject articleRoot.js before content.js');
    }
    return find(document);
  }

  function collectTextMap(root) {
    const out = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'SVG') {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.closest('#il-find-root, #il-overlay-host, [data-il-underline]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const value = n.nodeValue;
      const start = text.length;
      text += value;
      out.push({ node: n, start, end: text.length });
    }
    return { text, pieces: out, root };
  }

  function setPieces(newPieces) {
    pieces = newPieces;
    pieceNodeSet = new Set(pieces.map((p) => p.node));
  }

  function refreshExtract() {
    clearOverlays();
    const root = pickArticleRoot();
    extractRoot = root;
    ensurePaintMount(root);
    const mapped = collectTextMap(root);
    extractedText = mapped.text;
    setPieces(mapped.pieces);
    contentDirty = false;
    matchedChunks = [];
    semanticMatchProgress = [];
    matchIndex = -1;
    return { root, length: extractedText.length };
  }

  // ---------- offsets (API = code points; piece map = UTF-16) ----------

  function cpToUtf16(str, cpIndex) {
    let i = 0;
    let cps = 0;
    while (cps < cpIndex && i < str.length) {
      const cp = str.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      cps += 1;
    }
    return i;
  }

  function utf16ToCp(str, utf16Index) {
    let i = 0;
    let cps = 0;
    while (i < utf16Index && i < str.length) {
      const cp = str.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      cps += 1;
    }
    return cps;
  }

  function findPiece(utf16Offset) {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = pieces[mid];
      if (utf16Offset < p.start) hi = mid - 1;
      else if (utf16Offset >= p.end) lo = mid + 1;
      else return p;
    }
    return null;
  }

  function findPieceIndex(utf16Offset) {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = pieces[mid];
      if (utf16Offset < p.start) hi = mid - 1;
      else if (utf16Offset >= p.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /** 最近块级容器；跨块的 Range 会让 getClientRects 多出整块盒子 */
  function nearestBlock(node, cache) {
    let el = node.parentElement;
    while (el) {
      const cached = cache?.get(el);
      if (cached !== undefined) return cached;
      const display = getComputedStyle(el).display;
      if (
        display === 'block' ||
        display === 'flex' ||
        display === 'grid' ||
        display === 'list-item' ||
        display === 'table' ||
        display === 'table-row' ||
        display === 'table-cell' ||
        display === 'flow-root'
      ) {
        cache?.set(el, el);
        return el;
      }
      el = el.parentElement;
    }
    return document.body;
  }

  /** 整段 Range（滚动定位等）；绘制请用 rangesFromCpOffsets */
  function rangeFromCpOffsets(cp0, cp1) {
    if (!extractedText || cp1 <= cp0) return null;
    const u0 = cpToUtf16(extractedText, cp0);
    const u1 = cpToUtf16(extractedText, cp1);
    if (u1 <= u0) return null;

    const startPiece = findPiece(u0);
    const endPiece = findPiece(u1 - 1);
    if (!startPiece || !endPiece) return null;
    if (!startPiece.node.isConnected || !endPiece.node.isConnected) return null;

    const range = document.createRange();
    try {
      range.setStart(startPiece.node, u0 - startPiece.start);
      range.setEnd(endPiece.node, u1 - endPiece.start);
    } catch {
      return null;
    }
    return range;
  }

  /**
   * 按块级容器切开，避免单个 Range 跨 <p> 等时 getClientRects 叠出双线。
   * @returns {Range[]}
   */
  function rangesFromCpOffsets(cp0, cp1) {
    if (!extractedText || cp1 <= cp0) return [];
    const u0 = cpToUtf16(extractedText, cp0);
    const u1 = cpToUtf16(extractedText, cp1);
    if (u1 <= u0) return [];

    let i = findPieceIndex(u0);
    if (i < 0) return [];

    const blockCache = new WeakMap();
    /** @type {Range[]} */
    const out = [];
    /** @type {Range | null} */
    let cur = null;
    /** @type {Element | null} */
    let curBlock = null;

    for (; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.start >= u1) break;
      if (!p.node.isConnected) continue;
      const seg0 = Math.max(u0, p.start);
      const seg1 = Math.min(u1, p.end);
      if (seg1 <= seg0) continue;
      // 纯空白片段不画（空白行等）；截断当前 Range，避免跨过空白仍被 setEnd 包进区间
      if (!/\S/.test(extractedText.slice(seg0, seg1))) {
        if (cur && !cur.collapsed) out.push(cur);
        cur = null;
        curBlock = null;
        continue;
      }

      const block = nearestBlock(p.node, blockCache);
      try {
        if (!cur || block !== curBlock) {
          if (cur && !cur.collapsed) out.push(cur);
          cur = document.createRange();
          cur.setStart(p.node, seg0 - p.start);
          cur.setEnd(p.node, seg1 - p.start);
          curBlock = block;
        } else {
          cur.setEnd(p.node, seg1 - p.start);
        }
      } catch {
        if (cur && !cur.collapsed) out.push(cur);
        cur = null;
        curBlock = null;
      }
    }
    if (cur && !cur.collapsed) out.push(cur);
    return out;
  }

  // ---------- chunking（SYNC 副本：splitTextToChunks.js ← semanticUtils.splitTextToChunks） ----------

  function splitChunks(text, byteLimit) {
    const split = globalThis.IL_splitTextToChunks;
    if (typeof split !== 'function') {
      throw new Error('IL_splitTextToChunks missing — inject splitTextToChunks.js before content.js');
    }
    return split(text, byteLimit).map((c) => ({
      start: c.startOffset,
      end: c.startOffset + c.text.length,
      text: c.text,
    }));
  }

  /** 全空白 chunk 不送 API / 不作为语义匹配目标 */
  function chunkHasContent(chunk) {
    return /\S/.test(chunk.text);
  }

  // ---------- paint：token/truncated = CSS Highlight；underline = overlay host ----------

  /** score∈(0,1] → 0..TOKEN_LEVELS-1；≤0 不画 */
  function scoreToLevel(score01) {
    if (!Number.isFinite(score01) || !(score01 > 0)) return -1;
    const t = Math.max(0, Math.min(1, score01));
    return Math.min(TOKEN_LEVELS - 1, Math.floor(t * TOKEN_LEVELS));
  }

  /**
   * SYNC: client/src/shared/cross/textStatistics.ts → computeP90（同插值：index = (n-1)*p；站内固定 p=0.9）
   * @param {number[]} values
   * @param {number} p 0~1
   * @returns {number | null}
   */
  function computePercentile(values, p) {
    if (!values?.length) return null;
    if (!(p >= 0 && p <= 1)) {
      throw new Error(`pwScorePercentile must be in [0,1], got ${p}`);
    }
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return null;
    const index = (n - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /**
   * SYNC 语义（近似）：
   * - merge/normalize：client/src/shared/controllers/semanticSearchController.ts
   *   + semanticUtils.mergeTokenSpansFullyForRendering / normalizeTokenScores
   * - pw_score：client/src/features/analysis/visualizationUpdater.ts
   *   → pw_score = score×P_pw×matchDegree（P_pw：score>τ→1）
   * - τ：站内为 signal-fit（失败回退 P90）；扩展无 fit，用可配置分位代替（默认 0.9 ≈ P90）
   */
  function prepareChunkTokens(tokenAttention, chunkText, matchDegree) {
    const merge = globalThis.IL_mergeTokenSpansFullyForRendering;
    const normalize = globalThis.IL_normalizeTokenScores;
    if (typeof merge !== 'function' || typeof normalize !== 'function') {
      throw new Error(
        'IL_mergeTokenSpansFullyForRendering missing — reload this extension in chrome://extensions, then click the icon again'
      );
    }
    const normalized = normalize(merge(tokenAttention || [], chunkText));
    const p = CFG.pwScorePercentile ?? 0.9;
    const tau = computePercentile(
      normalized.map((t) => t.score),
      p
    );
    if (tau == null) return [];
    const degree = Number.isFinite(matchDegree) ? matchDegree : 0;
    return normalized.map((t) => ({
      ...t,
      score: t.score > tau ? t.score * degree : 0,
    }));
  }

  function isScrollableEl(el) {
    if (!(el instanceof Element)) return false;
    const st = getComputedStyle(el);
    const y = st.overflowY;
    const x = st.overflowX;
    const canY =
      (y === 'auto' || y === 'scroll' || y === 'overlay') && el.scrollHeight > el.clientHeight + 1;
    const canX =
      (x === 'auto' || x === 'scroll' || x === 'overlay') && el.scrollWidth > el.clientWidth + 1;
    return canY || canX;
  }

  /** 正文所在的最近滚动根（仅用于监听 scrollend） */
  function findScrollRoot(from) {
    let node = from instanceof Element ? from : from?.parentElement;
    while (node && node !== document.documentElement) {
      if (isScrollableEl(node)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function stopPaintLayoutWatch() {
    paintResizeObserver?.disconnect();
    paintResizeObserver = null;
    contentMutationObserver?.disconnect();
    contentMutationObserver = null;
    if (scrollSyncTimer) {
      clearTimeout(scrollSyncTimer);
      scrollSyncTimer = 0;
    }
  }

  /**
   * 只关心落在已提取文本节点（pieces）上的变动，忽略正文里跟已提取内容无关的动态
   * （广告刷新、评论计数、相关阅读懒加载等）。本扩展自己挂的 overlay/下划线 DOM 从不
   * 包含任何 pieces 节点，天然会被判定为不相关，无需再单独过滤。
   */
  function mutationTouchesPieces(record) {
    if (record.type === 'characterData') {
      return pieceNodeSet.has(record.target);
    }
    const changed = [...record.addedNodes, ...record.removedNodes];
    if (changed.some((n) => pieceNodeSet.has(n))) return true;
    // 兜底：整段容器（含某个已提取节点）被摘除/替换，命中率低，允许退化为线性扫描
    return changed.some((n) => n.nodeType === 1 && pieces.some((p) => n.contains(p.node)));
  }

  function releasePaintMount() {
    stopPaintLayoutWatch();
    if (paintMount) {
      paintMount.remove();
      paintMount = null;
    }
    if (paintPosTarget && paintPosRestore !== null) {
      paintPosTarget.style.position = paintPosRestore;
    }
    paintPosTarget = null;
    paintPosRestore = null;
  }

  /** underline 叠层挂在正文根内；与字同滚动，停稳后再重测坐标 */
  function ensurePaintMount(articleRoot) {
    if (paintMount?.isConnected && paintMount.parentElement === articleRoot) return paintMount;

    releasePaintMount();

    const st = getComputedStyle(articleRoot);
    if (st.position === 'static') {
      paintPosTarget = articleRoot;
      paintPosRestore = articleRoot.style.position;
      articleRoot.style.position = 'relative';
    }

    const host = document.createElement('div');
    host.id = 'il-overlay-host';
    articleRoot.appendChild(host);
    paintMount = host;
    startPaintLayoutWatch(articleRoot);
    return paintMount;
  }

  /** 视口 rect → 相对 #il-overlay-host */
  function clientRectToMountPos(rect) {
    if (!paintMount) throw new Error('paint mount missing');
    const hr = paintMount.getBoundingClientRect();
    return {
      x: rect.left - hr.left,
      y: rect.bottom - 2 - hr.top,
    };
  }

  function requireHighlightApi() {
    if (!CSS.highlights || typeof Highlight !== 'function') {
      throw new Error('CSS Custom Highlight API missing');
    }
  }

  /** 注册 il-token-0..15 / il-truncated；已存在则复用 */
  function ensureHighlightRegistry() {
    requireHighlightApi();
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      const name = HL_TOKEN_PREFIX + i;
      if (!CSS.highlights.has(name)) {
        const h = new Highlight();
        h.priority = i;
        CSS.highlights.set(name, h);
      }
    }
    if (!CSS.highlights.has(HL_TRUNCATED)) {
      const h = new Highlight();
      h.priority = TOKEN_LEVELS + 1;
      CSS.highlights.set(HL_TRUNCATED, h);
    }
  }

  function clearTokenHighlights() {
    if (!CSS.highlights) return;
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      CSS.highlights.get(HL_TOKEN_PREFIX + i)?.clear();
    }
  }

  function clearAllCustomHighlights() {
    clearTokenHighlights();
    CSS.highlights?.get(HL_TRUNCATED)?.clear();
  }

  /** 把 cp 区间加到指定 Highlight（按块切开，跳过纯空白） */
  function addCpRangeToHighlight(highlight, cp0, cp1) {
    for (const range of rangesFromCpOffsets(cp0, cp1)) {
      if (!/\S/.test(range.toString())) continue;
      highlight.add(range);
    }
  }

  function renderTokenHighlights() {
    ensureHighlightRegistry();
    clearTokenHighlights();
    for (const s of paintSpecs) {
      if (s.kind !== 'token') continue;
      const level = s.level;
      if (level == null || level < 0 || level >= TOKEN_LEVELS) continue;
      const h = CSS.highlights.get(HL_TOKEN_PREFIX + level);
      if (!h) throw new Error(`highlight missing: ${HL_TOKEN_PREFIX}${level}`);
      addCpRangeToHighlight(h, s.cp0, s.cp1);
    }
  }

  function applyTruncatedHighlight() {
    ensureHighlightRegistry();
    const h = CSS.highlights.get(HL_TRUNCATED);
    if (!h) throw new Error('highlight missing: il-truncated');
    h.clear();
    if (truncatedAnalyzedCpEnd == null || !extractedText || !extractRoot?.isConnected) return;
    const fullCp = utf16ToCp(extractedText, extractedText.length);
    const cp0 = Math.max(0, Math.min(truncatedAnalyzedCpEnd, fullCp));
    if (cp0 >= fullCp) return;
    addCpRangeToHighlight(h, cp0, fullCp);
  }

  /** SYNC: client/src/shared/vis/GLTR_Text_Box.ts → cancelChunkHighlightFade */
  function cancelUnderlineFade() {
    underlineFadeGen += 1;
    if (underlineHoldTimer) {
      clearTimeout(underlineHoldTimer);
      underlineHoldTimer = 0;
    }
    if (underlineFadeTimer) {
      clearTimeout(underlineFadeTimer);
      underlineFadeTimer = 0;
    }
    scrollEndCancel?.();
    scrollEndCancel = null;
  }

  function clearOverlays() {
    cancelUnderlineFade();
    endChunkSearchAutoScroll();
    clearTruncatedHighlight();
    clearTokenHighlights();
    clearOverlayEls();
    paintSpecs = [];
    releasePaintMount();
    extractRoot = null;
  }

  const STATUS_FEEDBACK_ICON =
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 L9.5 2.5 L5.5 10 L5 7 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const STATUS_HEART_ICON =
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.2 C6 10.2 1.8 7.4 1.8 4.6 C1.8 3.2 2.9 2.2 4.2 2.2 C5.1 2.2 5.7 2.7 6 3.3 C6.3 2.7 6.9 2.2 7.8 2.2 C9.1 2.2 10.2 3.2 10.2 4.6 C10.2 7.4 6 10.2 6 10.2 Z" fill="currentColor"/></svg>';

  function resetStatusFeedbackButton() {
    const btn = /** @type {HTMLButtonElement | null} */ (ui$('semantic_find_status_feedback'));
    if (!btn) return;
    btn.hidden = false;
    btn.disabled = false;
    btn.classList.remove('is-thanks');
    btn.innerHTML = STATUS_FEEDBACK_ICON;
    btn.title = 'Report this error to the author';
    btn.setAttribute('aria-label', 'Report this error to the author');
  }

  function clearFindStatus() {
    const el = ui$('semantic_find_status');
    const textEl = ui$('semantic_find_status_text');
    if (statusFeedbackHideTimer) {
      clearTimeout(statusFeedbackHideTimer);
      statusFeedbackHideTimer = 0;
    }
    lastStatusMeta = null;
    statusFeedbackSent = false;
    resetStatusFeedbackButton();
    setStatusContinueVisible(false);
    if (!el) return;
    el.hidden = true;
    if (textEl) {
      textEl.replaceChildren();
      textEl.removeAttribute('title');
    }
  }

  /**
   * 有未分析 chunk 时可续跑：Failed / Stopped 半截，或 maxChunks 截断后的下一批。
   * 需已有进度（n>0）；首块即失败用 Enter 重开即可，不必 Continue。
   */
  function canResumeSearch() {
    const query =
      /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.value?.trim() || '';
    if (!query || !lastSearchMeta || lastSearchMeta.query !== query) return false;
    if (!extractRoot?.isConnected) return false;
    const n = semanticMatchProgress.length;
    if (n <= 0) return false;
    return n < (lastSearchMeta.contentChunkCount ?? 0);
  }

  function setStatusContinueVisible(on) {
    const btn = /** @type {HTMLButtonElement | null} */ (ui$('semantic_find_status_continue'));
    if (btn) btn.hidden = !on;
  }

  /**
   * Status strip under bar / progress.
   * @param {string} label short prefix (Failed / Note / Stopped)
   * @param {string} detail reason or explanation
   * @param {{ tone?: 'error' | 'info' }} [opts]
   */
  function showFindStatus(label, detail, opts) {
    const el = ui$('semantic_find_status');
    const textEl = ui$('semantic_find_status_text');
    if (!el || !textEl) return;
    if (statusFeedbackHideTimer) {
      clearTimeout(statusFeedbackHideTimer);
      statusFeedbackHideTimer = 0;
    }
    const tone = opts?.tone === 'error' ? 'error' : 'info';
    const head = String(label || '').trim() || (tone === 'error' ? 'Failed' : 'Note');
    const body = String(detail || '').trim();
    const text = body ? `${head} · ${body}` : head;
    const labelEl = document.createElement('span');
    labelEl.className =
      tone === 'error' ? 'semantic-find-status-label is-error' : 'semantic-find-status-label';
    labelEl.textContent = head;
    textEl.replaceChildren(labelEl, ...(body ? [document.createTextNode(` · ${body}`)] : []));
    textEl.title = text;
    lastStatusMeta = { tone, label: head, detail: body };
    statusFeedbackSent = false;
    // 仅 Failed 可上报；Stopped / 截断 Note 不需要反馈按钮
    if (tone === 'error') resetStatusFeedbackButton();
    else {
      const btn = /** @type {HTMLButtonElement | null} */ (ui$('semantic_find_status_feedback'));
      if (btn) btn.hidden = true;
    }
    el.hidden = false;
    setStatusContinueVisible(canResumeSearch());
  }

  /** Task failure; reason from backend message or local error text */
  function showFindError(reason) {
    showFindStatus('Failed', reason || 'Request failed', { tone: 'error' });
  }

  function buildFeedbackBody() {
    const status = lastStatusMeta || { tone: 'info', label: 'Note', detail: '' };
    return {
      status,
      page_url: location.href,
      query: lastSearchMeta?.query
        || /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.value?.trim()
        || '',
      config: {
        apiBase: CFG.apiBase,
        chunkBytes: CFG.chunkBytes,
        maxChunks: CFG.maxChunks,
        matchThreshold: CFG.matchThreshold,
        submode: CFG.submode,
        pwScorePercentile: CFG.pwScorePercentile,
        followSearching: !!CFG.followSearching,
      },
      progress: {
        content_chunks: lastSearchMeta?.contentChunkCount ?? 0,
        analyzed_chunks: semanticMatchProgress.length,
        matched_chunks: matchedChunks.length,
        truncated: !!lastSearchMeta?.truncated,
      },
      user_agent: navigator.userAgent,
    };
  }

  function sendStatusFeedback() {
    if (!lastStatusMeta || statusFeedbackSent) return;
    statusFeedbackSent = true;
    chrome.runtime.sendMessage(
      {
        type: 'il-extension-feedback',
        apiBase: CFG.apiBase,
        body: buildFeedbackBody(),
      },
      () => {
        void chrome.runtime.lastError; // fire-and-forget
      }
    );
    const btn = /** @type {HTMLButtonElement | null} */ (ui$('semantic_find_status_feedback'));
    if (btn) {
      btn.disabled = true;
      btn.classList.add('is-thanks');
      btn.innerHTML = STATUS_HEART_ICON;
      btn.removeAttribute('title');
      btn.setAttribute('aria-label', 'Thanks');
    }
    if (statusFeedbackHideTimer) clearTimeout(statusFeedbackHideTimer);
    // 红心稍后收起；状态条保留，由用户手动 ×
    statusFeedbackHideTimer = window.setTimeout(() => {
      statusFeedbackHideTimer = 0;
      const b = /** @type {HTMLButtonElement | null} */ (ui$('semantic_find_status_feedback'));
      if (!b || !statusFeedbackSent) return;
      b.hidden = true;
      b.classList.remove('is-thanks');
      b.innerHTML = STATUS_FEEDBACK_ICON;
    }, 3000);
  }

  /**
   * 清当前会话的渲染与搜索进度。
   * @param {{ clearCache?: boolean }} [options] clearCache=true 时连 lastResult 一并丢弃（改 query / giveUp）
   */
  function resetSearchSession({ clearCache = false } = {}) {
    clearFillBlankQueue();
    clearOverlays();
    clearFindStatus();
    matchedChunks = [];
    semanticMatchProgress = [];
    progressTextLength = 0;
    lastSearchMeta = null;
    selectedProgressChunkStart = null;
    hoveredProgressChunkStart = null;
    matchIndex = -1;
    if (clearCache) lastResult = null;
    updateNav();
    renderSemanticMatchProgress();
  }

  /**
   * 正文被第三方（如翻译插件）意外改写、或提取根本身被替换/移除时的止损：
   * 不尝试修复或用旧偏移套新文本，直接放弃本次结果，回到未搜索状态（等价于清空输入框）。
   * 下次搜索会走 refreshExtract() 全量重新提取，天然恢复正常。
   */
  function giveUp() {
    abortWanted = true;
    resetSearchSession({ clearCache: true });
    setSearching(false);
  }

  /** 覆盖写入长度 1 结果缓存（含状态条；specs 浅拷贝，避免后续 clear 连带清空） */
  function snapshotLastResult(query) {
    if (!query) return;
    // 无结果（含「只有错误」）：不更新缓存。注意搜索开头会 setTruncatedHighlight(0)，
    // 0 不是 null，不能当「已有分析进度」。
    if (
      paintSpecs.length === 0 &&
      matchedChunks.length === 0 &&
      semanticMatchProgress.length === 0 &&
      !(truncatedAnalyzedCpEnd > 0)
    ) {
      return;
    }
    lastResult = {
      query,
      text: extractedText,
      // pending 可兼作 chunk 级匹配标记（无红色 token 时保留），须随快照
      paintSpecs: paintSpecs.map((s) => ({ ...s })),
      matchedChunks: matchedChunks.map((c) => ({ ...c })),
      semanticMatchProgress: semanticMatchProgress.map((c) => ({ ...c })),
      progressTextLength,
      matchIndex,
      truncatedAnalyzedCpEnd,
      selectedProgressChunkStart,
      status: lastStatusMeta ? { ...lastStatusMeta } : null,
      searchMeta: lastSearchMeta ? { ...lastSearchMeta } : null,
    };
  }

  /** @returns {boolean} 是否已还原 */
  function tryRestoreLastResult(query) {
    if (!lastResult || !query) return false;
    if (query !== lastResult.query || extractedText !== lastResult.text) return false;
    paintSpecs = lastResult.paintSpecs.map((s) => ({ ...s }));
    matchedChunks = lastResult.matchedChunks.map((c) => ({ ...c }));
    semanticMatchProgress = lastResult.semanticMatchProgress.map((c) => ({ ...c }));
    progressTextLength = lastResult.progressTextLength;
    matchIndex = lastResult.matchIndex;
    selectedProgressChunkStart = lastResult.selectedProgressChunkStart ?? null;
    lastSearchMeta = lastResult.searchMeta ? { ...lastResult.searchMeta } : null;
    if (lastResult.truncatedAnalyzedCpEnd != null) {
      setTruncatedHighlight(lastResult.truncatedAnalyzedCpEnd);
    }
    renderAllSpecs({
      preserveUnderline: paintSpecs.some((s) => s.kind === 'underline'),
    });
    updateNav();
    renderSemanticMatchProgress();
    if (lastResult.status) {
      showFindStatus(lastResult.status.label, lastResult.status.detail, {
        tone: lastResult.status.tone === 'error' ? 'error' : 'info',
      });
    }
    return true;
  }

  /**
   * ChatGPT 等会在滚动时改布局/换节点；滚动停稳或尺寸变化后按需重绑 Range / 重测 underline。
   * 无 mutation 且 pieces 仍 connected 时跳过全量 collectTextMap（滚动热路径）。
   */
  function syncPaintAfterLayout() {
    if (!extractRoot?.isConnected) {
      // 提取根本身被换掉/摘除（如翻译插件重建了整个容器）：有残留结果才需要放弃，否则什么都没画，无需处理
      if (
        paintSpecs.length > 0 ||
        truncatedAnalyzedCpEnd != null ||
        matchedChunks.length > 0 ||
        semanticMatchProgress.length > 0
      ) {
        giveUp();
      }
      return;
    }
    if (paintSpecs.length === 0 && truncatedAnalyzedCpEnd == null) return;

    const stale = pieces.some((p) => !p.node.isConnected);
    // 无 mutation 且节点仍在：跳过全页 collectTextMap，但仍重测 underline（resize/reflow）
    if (!contentDirty && !stale) {
      renderAllSpecs({
        preserveUnderline: paintSpecs.some((s) => s.kind === 'underline'),
      });
      return;
    }

    const mapped = collectTextMap(extractRoot);
    contentDirty = false;
    if (mapped.text !== extractedText) {
      // DOM_DEBUG 只是目测提取范围的调试预览，永远反映"当前"文本，文本变了就重新按当前内容分块展示
      if (DOM_DEBUG) {
        extractedText = mapped.text;
        setPieces(mapped.pieces);
        if (!extractedText.trim()) {
          clearOverlayEls();
          clearAllCustomHighlights();
          return;
        }
        const allChunks = splitChunks(extractedText, CFG.chunkBytes).filter(chunkHasContent);
        matchedChunks = allChunks.map((chunk) => ({
          start: utf16ToCp(extractedText, chunk.start),
          end: utf16ToCp(extractedText, chunk.end),
          matchDegree: 1,
        }));
        matchIndex = -1;
        paintAllUnderlines();
        return;
      }
      // 正文内容真的变了（非仅节点重排）：旧的语义偏移量已经和新文本对不上，放弃而不是套用错位渲染
      giveUp();
      return;
    }
    if (stale) {
      // 内容没变、只是节点被重新挂载（如虚拟滚动列表换节点）：重绑节点引用即可，照常渲染
      setPieces(mapped.pieces);
    }
    renderAllSpecs({
      preserveUnderline: paintSpecs.some((s) => s.kind === 'underline'),
    });
  }

  function scheduleSyncPaintAfterLayout() {
    if (scrollSyncTimer) clearTimeout(scrollSyncTimer);
    scrollSyncTimer = window.setTimeout(() => {
      scrollSyncTimer = 0;
      syncPaintAfterLayout();
    }, 120);
  }

  function startPaintLayoutWatch(articleRoot) {
    stopPaintLayoutWatch();
    paintResizeObserver = new ResizeObserver(() => scheduleSyncPaintAfterLayout());
    paintResizeObserver.observe(articleRoot);
    const scrollRoot = findScrollRoot(articleRoot);
    if (scrollRoot && scrollRoot !== document.documentElement && scrollRoot !== document.body) {
      paintResizeObserver.observe(scrollRoot);
    }
    // 尺寸不变的原地换字（翻译插件常见）不会触发 ResizeObserver，靠这个置脏再走同一套 sync
    contentMutationObserver = new MutationObserver((records) => {
      if (!records.some(mutationTouchesPieces)) return;
      contentDirty = true;
      scheduleSyncPaintAfterLayout();
    });
    contentMutationObserver.observe(articleRoot, { childList: true, characterData: true, subtree: true });
  }

  function specKey(s) {
    return `${s.kind}|${s.cp0}|${s.cp1}|${s.level ?? ''}`;
  }

  function upsertSpec(spec) {
    const key = specKey(spec);
    const i = paintSpecs.findIndex((s) => specKey(s) === key);
    if (i >= 0) paintSpecs[i] = spec;
    else paintSpecs.push(spec);
  }

  /** underline 盖层：data-il-underline=nav|pending，供 preserve/fade 识别（不依赖 className 全等） */
  function appendUnderlineRect(rect, kind) {
    if (!paintMount) throw new Error('paint mount missing');
    const el = document.createElement('div');
    const pending = kind === 'pending-underline';
    el.className = pending ? 'il-chunk-underline-pending' : 'il-chunk-underline';
    el.dataset.ilUnderline = pending ? 'pending' : 'nav';
    const { x, y } = clientRectToMountPos(rect);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${rect.width}px`;
    paintMount.appendChild(el);
    overlayEls.push(el);
  }

  /** @param {'nav' | 'pending'} role */
  function clearOverlayRole(role) {
    overlayEls = overlayEls.filter((el) => {
      if (el.dataset.ilUnderline !== role) return true;
      el.remove();
      return false;
    });
  }

  function clearOverlayEls(options) {
    const preserveUnderline = options?.preserveUnderline === true;
    if (!preserveUnderline) {
      for (const el of overlayEls) el.remove();
      overlayEls = [];
      return;
    }
    // SYNC: GLTR_Text_Box.clearHighlight({ preserveChunkInterval: true }) — 留蓝导航线 DOM（含 fade）
    clearOverlayRole('pending');
  }

  function paintUnderlineSpec(spec) {
    for (const range of rangesFromCpOffsets(spec.cp0, spec.cp1)) {
      if (!/\S/.test(range.toString())) continue;
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        appendUnderlineRect(r, spec.kind);
      }
    }
  }

  /**
   * 只重画一类下划线（不动 token / truncated / 另一类线）。
   * @param {'underline' | 'pending-underline'} kind
   */
  function renderUnderlinesOfKind(kind) {
    const role = kind === 'pending-underline' ? 'pending' : 'nav';
    if (!extractRoot?.isConnected) {
      clearOverlayRole(role);
      return;
    }
    ensurePaintMount(extractRoot);
    clearOverlayRole(role);
    for (const s of paintSpecs) {
      if (s.kind === kind) paintUnderlineSpec(s);
    }
  }

  /**
   * 全量：token + truncated + 下划线。仅用于重绑/还原/reflow 等必须整表一致的场景。
   * @param {{ preserveUnderline?: boolean }} [options]
   *   preserveUnderline：不拆蓝导航线 DOM（hold/fade 不被流式更新打断）
   */
  function renderAllSpecs(options) {
    if (!extractRoot?.isConnected) return 0;
    ensurePaintMount(extractRoot);
    renderTokenHighlights();
    applyTruncatedHighlight();
    if (options?.preserveUnderline !== true) renderUnderlinesOfKind('underline');
    renderUnderlinesOfKind('pending-underline');
    return overlayEls.length;
  }

  function paintSpec(kind, cp0, cp1, level) {
    const before = paintSpecs.length;
    const spec = kind === 'token' ? { kind, cp0, cp1, level } : { kind, cp0, cp1 };
    upsertSpec(spec);
    return paintSpecs.length > before ? 1 : 0;
  }

  function clearTruncatedHighlight() {
    truncatedAnalyzedCpEnd = null;
    CSS.highlights?.get(HL_TRUNCATED)?.clear();
  }

  /**
   * SYNC：站内 truncated-text 只改字色。
   * 扩展：::highlight(il-truncated)，统一灰 = CanvasText × Canvas（不跟各段自身字色）。
   */
  function setTruncatedHighlight(analyzedCpEnd) {
    truncatedAnalyzedCpEnd = analyzedCpEnd;
    applyTruncatedHighlight();
  }

  function scheduleReflow() {
    if (reflowQueued) return;
    reflowQueued = true;
    requestAnimationFrame(() => {
      reflowQueued = false;
      renderAllSpecs({
        preserveUnderline: paintSpecs.some((s) => s.kind === 'underline'),
      });
    });
  }

  /** DOM 调试：画出全部提取 chunk 下划线（非语义 match 导航） */
  function paintAllUnderlines() {
    cancelUnderlineFade();
    paintSpecs = paintSpecs.filter((s) => s.kind !== 'underline');
    matchedChunks.forEach((c) => {
      upsertSpec({ kind: 'underline', cp0: c.start, cp1: c.end });
    });
    renderUnderlinesOfKind('underline');
  }

  /**
   * SYNC: client/src/shared/vis/GLTR_Text_Box.ts → setChunkCharRangeHighlight
   * 语义导航只画当前 match 一条下划线（paintAllUnderlines 仅 DOM 调试，非站内语义行为）
   */
  function setCurrentUnderline(chunk) {
    cancelUnderlineFade();
    paintSpecs = paintSpecs.filter((s) => s.kind !== 'underline');
    if (chunk) {
      upsertSpec({ kind: 'underline', cp0: chunk.start, cp1: chunk.end });
    }
    renderUnderlinesOfKind('underline');
  }

  /**
   * SYNC: client/src/shared/vis/HighlightManager.ts → fadeOutCharIntervalUnderlines
   * + GLTR_Text_Box.fadeCurrentChunkHighlight
   */
  function fadeCurrentUnderline() {
    const gen = ++underlineFadeGen;
    const fadingProgressChunkStart = selectedProgressChunkStart;
    // 只 fade 导航线；等待线独立，不在此列。进度线保持选中蓝，等 fade 结束再变红。
    const lines = overlayEls.filter((el) => el.dataset.ilUnderline === 'nav');
    if (!lines.length) {
      paintSpecs = paintSpecs.filter((s) => s.kind !== 'underline');
      if (fadingProgressChunkStart != null) {
        selectedProgressChunkStart = null;
        renderSemanticMatchProgress();
      }
      return;
    }
    for (const el of lines) {
      el.style.transition = '';
      el.style.opacity = '1';
    }
    requestAnimationFrame(() => {
      if (gen !== underlineFadeGen) return;
      for (const el of lines) {
        el.style.transition = `opacity ${CHUNK_HIGHLIGHT_FADE_MS}ms ease-out`;
        el.style.opacity = '0';
      }
      underlineFadeTimer = window.setTimeout(() => {
        underlineFadeTimer = 0;
        if (gen !== underlineFadeGen) return;
        paintSpecs = paintSpecs.filter((s) => s.kind !== 'underline');
        clearOverlayRole('nav');
        if (selectedProgressChunkStart === fadingProgressChunkStart) {
          selectedProgressChunkStart = null;
          renderSemanticMatchProgress();
        }
      }, CHUNK_HIGHLIGHT_FADE_MS);
    });
  }

  /**
   * SYNC: client/src/shared/core/waitForSmoothScrollEnd.ts
   * 等滚动停稳或确认未滚动；勿仅依赖 scrollend（无位移时常不触发 → 空等 maxWait）。
   */
  /**
   * SYNC: client/src/shared/core/waitForSmoothScrollEnd.ts
   * scrollend + 两帧后位置未变则结束 + maxWait；勿仅依赖 scrollend。
   */
  function waitForSmoothScrollEnd(target, onDone, maxWaitMs = 5000) {
    let settled = false;
    const getTop = () => (target === window ? window.scrollY : target.scrollTop);
    const startTop = getTop();

    const settle = () => {
      if (settled) return;
      settled = true;
      dispose();
      onDone();
    };

    const onScrollEnd = () => settle();
    const dispose = () => {
      window.clearTimeout(timeoutId);
      target.removeEventListener('scrollend', onScrollEnd);
    };

    target.addEventListener('scrollend', onScrollEnd, { once: true });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (Math.abs(getTop() - startTop) < 1) settle();
      });
    });
    const timeoutId = window.setTimeout(settle, maxWaitMs);

    return () => {
      settled = true;
      dispose();
    };
  }

  /**
   * SYNC: client/src/shared/vis/GLTR_Text_Box.ts → scrollToUnicodeCharOffset
   * （宿主页用 findScrollRoot 代替站内 panel）
   */
  function scrollToCpOffset(cp0, onScrollEnd, viewportYRatio = CHUNK_JUMP_VIEWPORT_Y_RATIO) {
    scrollEndCancel?.();
    scrollEndCancel = null;
    requestAnimationFrame(() => {
      const range = rangeFromCpOffsets(cp0, cp0 + 1) || rangeFromCpOffsets(cp0, Math.max(cp0 + 1, cp0));
      let rect = null;
      if (range) {
        rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          const rects = range.getClientRects();
          rect = rects.length ? rects[0] : null;
        }
      }
      if (!rect || !extractRoot) {
        onScrollEnd?.();
        return;
      }
      const scrollRoot = findScrollRoot(extractRoot);
      const isWindow =
        scrollRoot === document.scrollingElement ||
        scrollRoot === document.documentElement ||
        scrollRoot === document.body;
      if (isWindow) {
        const y = window.scrollY + rect.top - window.innerHeight * viewportYRatio;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
        if (onScrollEnd) scrollEndCancel = waitForSmoothScrollEnd(window, onScrollEnd);
        return;
      }
      const panel = /** @type {HTMLElement} */ (scrollRoot);
      const panelRect = panel.getBoundingClientRect();
      const topInPanel = rect.top - panelRect.top + panel.scrollTop;
      const target = topInPanel - panel.clientHeight * viewportYRatio;
      const maxScroll = Math.max(0, panel.scrollHeight - panel.clientHeight);
      panel.scrollTo({ top: Math.max(0, Math.min(target, maxScroll)), behavior: 'smooth' });
      if (onScrollEnd) scrollEndCancel = waitForSmoothScrollEnd(panel, onScrollEnd);
    });
  }

  /** SYNC: GLTR_Text_Box.scrollToChunkStart（视口 0.2） */
  function scrollToChunkStart(cp0, onScrollEnd) {
    scrollToCpOffset(cp0, onScrollEnd, CHUNK_JUMP_VIEWPORT_Y_RATIO);
  }

  /** 分块搜索进行中：滚到 chunk 起点（视口 0.6）；站内 demo 已去掉跟随，仅扩展使用 */
  function followSearchingChunk(cp0) {
    if (chunkSearchAutoScrollUserCancelled) return;
    scrollToCpOffset(cp0, undefined, CHUNK_SEARCH_FOLLOW_VIEWPORT_Y_RATIO);
  }

  /** 分块搜索：wheel/touch 取消自动跟随；站内 demo 已去掉，仅扩展使用 */
  function beginChunkSearchAutoScroll() {
    endChunkSearchAutoScroll();
    chunkSearchAutoScrollUserCancelled = false;
    if (!extractRoot) return;
    const scrollRoot = findScrollRoot(extractRoot);
    const isWindow =
      scrollRoot === document.scrollingElement ||
      scrollRoot === document.documentElement ||
      scrollRoot === document.body;
    const target = isWindow ? window : scrollRoot;
    const opts = { passive: true, capture: true };
    const onUserScroll = () => {
      if (chunkSearchAutoScrollUserCancelled) return;
      chunkSearchAutoScrollUserCancelled = true;
      scrollEndCancel?.();
      scrollEndCancel = null;
    };
    target.addEventListener('wheel', onUserScroll, opts);
    target.addEventListener('touchstart', onUserScroll, opts);
    chunkSearchAutoScrollCleanup = () => {
      target.removeEventListener('wheel', onUserScroll, opts);
      target.removeEventListener('touchstart', onUserScroll, opts);
    };
  }

  function endChunkSearchAutoScroll() {
    chunkSearchAutoScrollCleanup?.();
    chunkSearchAutoScrollCleanup = undefined;
    chunkSearchAutoScrollUserCancelled = false;
  }

  function delayMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * SYNC: client/src/shared/vis/GLTR_Text_Box.ts → jumpToChunkHighlight
   * + client/src/features/analysis/semanticFindBar.ts → jumpTo
   * 下划线 → 滚到起点 → hold → fade
   */
  function jumpToMatch(index) {
    if (!matchedChunks.length) return;
    const n = matchedChunks.length;
    matchIndex = ((index % n) + n) % n;
    revealChunk(matchedChunks[matchIndex]);
    updateNav();
  }

  /**
   * 选中并展示一个 chunk：进度图线变蓝 + 下划线 → 滚到起点 → hold → 下划线 fade；
   * 进度线保持蓝至 fade 结束再恢复红。
   * 由「点击进度线」（selectProgressChunk）和「上下按钮跳转」（jumpToMatch）共用，
   * 保证两者对进度图选中态的表现始终一致。
   */
  function revealChunk(chunk) {
    setCurrentUnderline(chunk);
    selectedProgressChunkStart = chunk.start;
    renderSemanticMatchProgress();
    // 导航态需要跟着刷新快照，否则关闭再打开搜索栏时，下划线（回退到旧快照）
    // 会和进度图选中线（读实时变量）错位
    if (lastResult) snapshotLastResult(lastResult.query);
    scrollToChunkStart(chunk.start, () => {
      underlineHoldTimer = window.setTimeout(() => {
        underlineHoldTimer = 0;
        fadeCurrentUnderline();
      }, CHUNK_HIGHLIGHT_HOLD_MS);
    });
  }

  // ---------- API ----------

  /** 底层 JSON 请求（submode 须为后端合法值，不可传 hybrid） */
  function analyzeSemanticRaw(query, text, opts) {
    const body = {
      query,
      text,
      stream: false,
      privacy_mode: true,
      ...(opts?.submode ? { submode: opts.submode } : {}),
      ...(opts?.fullMatchDegreeOnly ? { full_match_degree_only: true } : {}),
    };
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'il-analyze-semantic',
          apiBase: CFG.apiBase,
          body,
        },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!resp?.ok) reject(new Error(resp?.error || 'request failed'));
          else resolve(resp.data);
        }
      );
    });
  }

  /**
   * SYNC: client GLTR_API.analyzeSemantic — hybrid 为前端组合：
   * count(full_match_degree_only) 即返回；达阈值时由调用方异步 fill_blank 染色（等待线）。
   * 注意：异步 fill 相对「count 后 await fill」会增加与后续 count 的额外并发。
   */
  async function analyzeSemantic(query, text) {
    const submode = CFG.submode || 'hybrid';
    if (submode === 'hybrid') {
      const r1 = await analyzeSemanticRaw(query, text, {
        submode: 'count',
        fullMatchDegreeOnly: true,
      });
      if (r1?.success === false) return r1;
      return { ...r1, token_attention: [] };
    }
    return analyzeSemanticRaw(query, text, { submode });
  }

  /** hybrid：拆掉某 chunk 的等待线（只动 pending overlay） */
  function clearPendingUnderline(cp0, cp1) {
    paintSpecs = paintSpecs.filter(
      (s) => !(s.kind === 'pending-underline' && s.cp0 === cp0 && s.cp1 === cp1)
    );
    renderUnderlinesOfKind('pending-underline');
  }

  /**
   * 把 token_attention 写入 paintSpecs（仅 score>0），并直接挂上 Highlight（不碰下划线）。
   * @returns {number} 实际上色的 token 段数；0 表示没有染色
   */
  function paintChunkTokens(tokenAttention, chunkText, chunkCpStart, degree) {
    const tokens = prepareChunkTokens(tokenAttention || [], chunkText, degree);
    ensureHighlightRegistry();
    let n = 0;
    for (const t of tokens) {
      if (!t.offset || !(t.score > 0)) continue;
      const [a, b] = t.offset;
      const level = scoreToLevel(t.score);
      if (level < 0) continue;
      const cp0 = chunkCpStart + a;
      const cp1 = chunkCpStart + b;
      paintSpec('token', cp0, cp1, level);
      const h = CSS.highlights.get(HL_TOKEN_PREFIX + level);
      if (!h) throw new Error(`highlight missing: ${HL_TOKEN_PREFIX}${level}`);
      addCpRangeToHighlight(h, cp0, cp1);
      n += 1;
    }
    return n;
  }

  // ---------- UI（同源 HTML/CSS，Shadow DOM 隔离宿主页样式） ----------

  const STOP_ICON =
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor"/></svg>';

  const HOST_CSS = `
:host {
  all: initial;
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 2147483646;
  display: block;
  pointer-events: none;
}
.semantic-find-bar-host {
  position: static;
  margin: 0;
  padding: 0;
  z-index: auto;
}
.semantic-find-bar {
  pointer-events: auto;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
`;

  /** @type {ShadowRoot | null} */
  let uiShadow = null;
  let barWired = false;
  /** 串行化首次构建，避免双击工具栏时 barWired 抢跑 */
  /** @type {Promise<HTMLElement> | null} */
  let barReady = null;

  function ui$(id) {
    return uiShadow?.getElementById(id) ?? null;
  }

  function uiQuery(sel) {
    return uiShadow?.querySelector(sel) ?? null;
  }

  function resolveBarTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyBarTheme(bar) {
    if (!bar) return;
    bar.setAttribute('data-theme', resolveBarTheme());
  }

  function watchBarTheme(bar) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => applyBarTheme(bar);
    mq.addEventListener('change', onScheme);
  }

  // ---------- 输入历史（对齐站内 queryHistory：聚焦/输入弹出、过滤、点选回填并搜索） ----------
  const HISTORY_KEY = 'il_semantic_find_history';
  const HISTORY_MAX = 8;
  /** @type {string[]} */
  let historyList = [];
  /** @type {Promise<void> | null} */
  let historyReady = null;

  function ensureHistory() {
    if (!historyReady) {
      historyReady = chrome.storage.local.get(HISTORY_KEY).then((data) => {
        const raw = data[HISTORY_KEY];
        historyList = Array.isArray(raw)
          ? raw.filter((s) => typeof s === 'string').slice(0, HISTORY_MAX)
          : [];
      });
    }
    return historyReady;
  }

  function persistHistory() {
    return chrome.storage.local.set({ [HISTORY_KEY]: historyList });
  }

  function saveHistory(query) {
    if (!query) return;
    historyList = [query, ...historyList.filter((s) => s !== query)].slice(0, HISTORY_MAX);
    void persistHistory();
  }

  function removeHistory(query) {
    historyList = historyList.filter((s) => s !== query);
    void persistHistory();
  }

  function hideHistoryDropdown() {
    ui$('semantic_find_history_dropdown')?.classList.remove('is-visible');
  }

  function renderHistoryDropdown() {
    const dropdown = ui$('semantic_find_history_dropdown');
    const input = /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'));
    if (!dropdown || !input || searching) {
      hideHistoryDropdown();
      return;
    }
    // 列表过滤：与站内一致不 trim；完全匹配当前输入的候选不展示
    const filter = (input.value ?? '').toLowerCase();
    const filtered = historyList.filter((s) => {
      const sLower = s.toLowerCase();
      if (sLower === filter) return false;
      return !filter || sLower.includes(filter);
    });
    dropdown.innerHTML = '';
    if (filtered.length === 0) {
      hideHistoryDropdown();
      return;
    }
    for (const q of filtered) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'history-text';
      span.textContent = q;
      span.title = q;
      span.addEventListener('click', () => {
        hideHistoryDropdown();
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        void runSearch();
      });
      const btn = document.createElement('button');
      btn.className = 'demo-delete-btn';
      btn.type = 'button';
      btn.textContent = '×';
      btn.title = 'Remove';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeHistory(q);
        renderHistoryDropdown();
      });
      li.appendChild(span);
      li.appendChild(btn);
      dropdown.appendChild(li);
    }
    dropdown.classList.add('is-visible');
  }

  function wireBar() {
    if (barWired) return;
    const findInput = /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'));
    if (!findInput) throw new Error('find bar input missing');
    barWired = true;

    void ensureHistory();

    ui$('semantic_find_prev')?.addEventListener('click', () =>
      jumpToMatch(matchIndex < 0 ? matchedChunks.length - 1 : matchIndex - 1)
    );
    ui$('semantic_find_next')?.addEventListener('click', () =>
      jumpToMatch(matchIndex < 0 ? 0 : matchIndex + 1)
    );
    ui$('semantic_find_close')?.addEventListener('click', () => close());
    ui$('semantic_find_status_close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearFindStatus();
    });
    ui$('semantic_find_status_feedback')?.addEventListener('click', (e) => {
      e.stopPropagation();
      sendStatusFeedback();
    });
    ui$('semantic_find_status_continue')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void runSearch({ resume: true });
    });
    ui$('semantic_find_clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (searching) {
        // 立刻空闲 UI；旧轮靠 abortWanted 退出主循环。不清 fill：已匹配块继续染色，Continue 可接上
        abortWanted = true;
        wakeFillLagWaiters();
        setSearching(false);
        // 不等主循环退出：可续跑时立刻给出 Stopped + Continue（与循环尾部分支同条件）
        if (canResumeSearch()) {
          updateNav();
          showFindStatus('Stopped', 'Search paused');
        }
        return;
      }
      findInput.value = '';
      findInput.dispatchEvent(new Event('input', { bubbles: true }));
      findInput.focus();
    });
    findInput.addEventListener('focus', () => {
      void ensureHistory().then(renderHistoryDropdown);
    });
    findInput.addEventListener('input', () => {
      if (searching) return;
      // 输入框内容一变（无论是手改还是点 × 清空），旧的渲染状态即视为过期，统一清掉
      resetSearchSession({ clearCache: true });
      syncClearButton(false);
      if (uiShadow?.activeElement === findInput) renderHistoryDropdown();
    });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        hideHistoryDropdown();
        void runSearch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    document.addEventListener('click', (e) => {
      const bar = ui$('semantic_find_bar');
      if (!bar || e.composedPath().includes(bar)) return;
      hideHistoryDropdown();
    });
  }

  function syncClearButton(searchingOn) {
    const btn = ui$('semantic_find_clear');
    const input = /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'));
    if (!btn) return;
    if (searchingOn) {
      btn.classList.add('is-stop', 'is-visible');
      btn.innerHTML = STOP_ICON;
      btn.title = 'Stop';
      btn.setAttribute('aria-label', 'Stop');
    } else {
      btn.classList.remove('is-stop');
      btn.textContent = '×';
      btn.title = 'Clear';
      btn.setAttribute('aria-label', 'Clear');
      btn.classList.toggle('is-visible', (input?.value ?? '').length > 0);
    }
  }

  async function buildBar() {
    let host = document.getElementById('il-find-root');
    const existing = /** @type {HTMLElement | null} */ (
      host?.shadowRoot?.getElementById('semantic_find_bar') ?? null
    );
    if (existing) {
      uiShadow = host.shadowRoot;
      applyBarTheme(existing);
      wireBar();
      return existing;
    }
    // 上次构建失败可能留下空 host
    host?.remove();

    host = document.createElement('div');
    host.id = 'il-find-root';
    document.documentElement.appendChild(host);
    uiShadow = host.attachShadow({ mode: 'open' });

    try {
      const [cssText, html] = await Promise.all([
        fetch(chrome.runtime.getURL('ui/semantic-find-bar.css')).then((r) => {
          if (!r.ok) throw new Error(`failed to load find bar css (${r.status})`);
          return r.text();
        }),
        fetch(chrome.runtime.getURL('ui/semantic-find-bar.html')).then((r) => {
          if (!r.ok) throw new Error(`failed to load find bar html (${r.status})`);
          return r.text();
        }),
      ]);

      const style = document.createElement('style');
      style.textContent = HOST_CSS + '\n' + cssText;
      uiShadow.appendChild(style);

      const wrap = document.createElement('div');
      wrap.innerHTML = html.trim();
      const bar = /** @type {HTMLElement} */ (wrap.firstElementChild);
      if (!bar) throw new Error('find bar html empty');
      applyBarTheme(bar);
      watchBarTheme(bar);
      uiShadow.appendChild(bar);

      wireBar();
      return bar;
    } catch (err) {
      host.remove();
      uiShadow = null;
      barWired = false;
      throw err;
    }
  }

  function ensureBar() {
    if (!barReady) {
      barReady = buildBar().catch((err) => {
        barReady = null;
        throw err;
      });
    }
    return barReady;
  }

  function updateNav() {
    const prev = /** @type {HTMLButtonElement | null} */ (ui$('semantic_find_prev'));
    const next = /** @type {HTMLButtonElement | null} */ (ui$('semantic_find_next'));
    const disabled = matchedChunks.length === 0;
    if (prev) prev.disabled = disabled;
    if (next) next.disabled = disabled;
  }

  /** 简版 semantic match progress：全文位置 × chunk 匹配度。 */
  function renderSemanticMatchProgress() {
    const chart = ui$('semantic_match_progress');
    const lines = ui$('semantic_match_progress_lines');
    if (!(chart instanceof SVGSVGElement) || !(lines instanceof SVGGElement)) return;

    const hidden = semanticMatchProgress.length === 0 || extractedText.length === 0;
    chart.toggleAttribute('hidden', hidden);
    if (hidden) {
      lines.replaceChildren();
      return;
    }

    const width = Math.max(100, Math.round(chart.clientWidth));
    const height = Math.max(42, Math.round(chart.clientHeight));
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const x0 = 4;
    const x1 = width - 4;
    const y0 = height - 7;
    const y1 = 4;
    const textLength = progressTextLength || [...extractedText].length;
    const groupsByStart = new Map(
      [...lines.children]
        .filter((el) => el instanceof SVGGElement && el.dataset.progressStart != null)
        .map((el) => [Number(el.dataset.progressStart), el])
    );
    const liveStarts = new Set();

    for (const chunk of semanticMatchProgress) {
      const degree = Math.max(0, Math.min(1, Number(chunk.matchDegree) || 0));
      const start = x0 + ((x1 - x0) * chunk.start) / textLength;
      const end = x0 + ((x1 - x0) * chunk.end) / textLength;
      const y = y0 - (y0 - y1) * degree;
      liveStarts.add(chunk.start);
      let group = groupsByStart.get(chunk.start);
      if (!group) {
        group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.dataset.progressStart = String(chunk.start);

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.classList.add('semantic-match-progress-line');
        group.appendChild(line);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.classList.add('semantic-match-progress-label');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('hidden', '');
        group.appendChild(label);

        const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hitArea.classList.add('semantic-match-progress-hit-area');
        hitArea.addEventListener('mouseenter', () => {
          setHoveredProgressChunk(chunk.start);
        });
        hitArea.addEventListener('mouseleave', () => {
          if (hoveredProgressChunkStart === chunk.start) setHoveredProgressChunk(null);
        });
        hitArea.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.blur();
          selectProgressChunk(chunk.start);
        });
        group.appendChild(hitArea);
        lines.appendChild(group);
      }

      const line = /** @type {SVGPathElement} */ (group.querySelector('.semantic-match-progress-line'));
      const label = /** @type {SVGTextElement} */ (group.querySelector('.semantic-match-progress-label'));
      const hitArea = /** @type {SVGRectElement} */ (group.querySelector('.semantic-match-progress-hit-area'));
      line.classList.toggle('is-below-threshold', degree < CFG.matchThreshold);
      line.classList.toggle('is-selected', selectedProgressChunkStart === chunk.start);
      line.classList.toggle('is-hovered', hoveredProgressChunkStart === chunk.start);
      const lineStart = start;
      const lineEnd = end;
      line.setAttribute('d', `M${lineStart} ${y}H${lineEnd}`);
      label.setAttribute('x', String((start + end) / 2));
      label.setAttribute('y', String(Math.max(y1 + 10, y - 4)));
      label.textContent = `${Math.round(degree * 100)}%`;
      label.toggleAttribute('hidden', hoveredProgressChunkStart !== chunk.start);
      hitArea.setAttribute('x', String(start));
      hitArea.setAttribute('y', String(y1));
      hitArea.setAttribute('width', String(Math.max(0.35, end - start)));
      hitArea.setAttribute('height', String(y0 - y1));
    }
    for (const [start, group] of groupsByStart) {
      if (!liveStarts.has(start)) group.remove();
    }
  }

  function setHoveredProgressChunk(start) {
    if (hoveredProgressChunkStart === start) return;
    const lines = ui$('semantic_match_progress_lines');
    if (!(lines instanceof SVGGElement)) return;
    const previous = hoveredProgressChunkStart;
    hoveredProgressChunkStart = start;
    for (const chunkStart of [previous, start]) {
      if (chunkStart == null) continue;
      const group = [...lines.children].find((el) => el.dataset.progressStart === String(chunkStart));
      group
        ?.querySelector('.semantic-match-progress-line')
        ?.classList.toggle('is-hovered', chunkStart === start);
      const label = group?.querySelector('.semantic-match-progress-label');
      label?.toggleAttribute('hidden', chunkStart !== start);
    }
  }

  function selectProgressChunk(start) {
    const chunk = semanticMatchProgress.find((item) => item.start === start);
    if (!chunk) return;
    if (selectedProgressChunkStart === start) {
      selectedProgressChunkStart = null;
      setCurrentUnderline(null);
      renderSemanticMatchProgress();
      if (lastResult) snapshotLastResult(lastResult.query);
    } else {
      revealChunk(chunk);
    }
  }

  function setSearching(on) {
    searching = on;
    const chromeBar = uiQuery('.semantic-find-bar');
    chromeBar?.classList.toggle('is-searching', on);
    const input = /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'));
    if (input) {
      input.readOnly = on;
      if (on) input.blur();
    }
    ui$('semantic_find_history_dropdown')?.classList.remove('is-visible');
    chromeBar?.classList.remove('is-input-active');
    syncClearButton(on);
    // 搜索结束时若正文仍脏（例如 debounce 未到期），补一次 sync
    if (!on && contentDirty) scheduleSyncPaintAfterLayout();
  }

  /**
   * @param {{ resume?: boolean }} [opts] resume=true：保留已有进度，从下一未分析 chunk 继续（Enter 仍重开）
   */
  async function runSearch(opts) {
    if (searching) return;
    const resume = !!opts?.resume;
    const query = /** @type {HTMLInputElement} */ (ui$('semantic_find_input'))?.value?.trim() || '';
    if (!query) {
      return;
    }
    if (resume && !canResumeSearch()) return;

    // 必须在任何 await 之前占住 searching + epoch，否则连按会 concurrent 多轮：
    // 旧轮 finally 清掉 searching，新轮仍在跑 → 有报错、像在搜、却没有停止按钮。
    const epoch = ++searchEpoch;
    abortWanted = false;
    if (!resume) clearFillBlankQueue();
    setSearching(true);
    setStatusContinueVisible(false);

    try {
      await ensureHistory();
      if (epoch !== searchEpoch) return;
      saveHistory(query);

      // 产品决策：扩展保留预取/hold/follow；站内 demo 刻意简化为「上色 → 结束跳首个匹配」（见 semanticSearchController），两边不必对齐。
      // followSearching=true 全程跟随；false=无 match 前跟随、首个 match 停靠划线
      const followAll = !!CFG.followSearching;
      /** @type {{ start: number, end: number, text: string }[]} */
      let allChunks;
      let resumeFrom = 0;
      let analyzedCpEnd = 0;
      let parkedOnFirstMatch = false;

      if (resume) {
        clearFindStatus();
        if (!extractRoot?.isConnected) {
          resetSearchSession({ clearCache: true });
          if (epoch === searchEpoch) showFindError('Page content changed; start a new search');
          return;
        }
        // 不可走 refreshExtract：它会清 overlays/进度。只复测正文是否仍一致并重绑节点。
        const mapped = collectTextMap(extractRoot);
        contentDirty = false;
        if (mapped.text !== extractedText) {
          resetSearchSession({ clearCache: true });
          if (epoch === searchEpoch) showFindError('Page content changed; start a new search');
          return;
        }
        setPieces(mapped.pieces);
        const contentChunks = splitChunks(extractedText, CFG.chunkBytes).filter(chunkHasContent);
        resumeFrom = semanticMatchProgress.length;
        if (resumeFrom >= contentChunks.length) return;
        // 中断续跑沿用旧窗口；截断后续跑再开一批
        const prevEnd = lastSearchMeta.windowEnd ?? 0;
        const windowEnd =
          resumeFrom < prevEnd ? prevEnd : resumeFrom + CFG.maxChunks;
        allChunks = contentChunks.slice(0, windowEnd);
        analyzedCpEnd =
          truncatedAnalyzedCpEnd ??
          (resumeFrom > 0 ? semanticMatchProgress[resumeFrom - 1].end : 0);
        parkedOnFirstMatch = !followAll && matchedChunks.length > 0;
        lastSearchMeta = {
          query,
          contentChunkCount: contentChunks.length,
          truncated: contentChunks.length > allChunks.length,
          windowEnd: allChunks.length,
        };
        progressTextLength = allChunks.length
          ? utf16ToCp(extractedText, allChunks[allChunks.length - 1].end)
          : 0;
        // 分母变大：已完成竖线重标定到新窗口（仍全部绘制）
        renderSemanticMatchProgress();
      } else {
        resetSearchSession();

        try {
          refreshExtract();
        } catch (err) {
          console.error('[InfoLens] extract aborted:', err?.message || err);
          if (epoch === searchEpoch) showFindError(err?.message || err);
          return;
        }
        if (!extractedText.trim()) {
          console.error('[InfoLens] no article text found');
          if (epoch === searchEpoch) showFindError('No article text found');
          return;
        }

        // 全空白 chunk 不送 API；先滤再截断，避免 maxChunks 被空白占满
        const contentChunks = splitChunks(extractedText, CFG.chunkBytes).filter(chunkHasContent);
        allChunks = contentChunks.slice(0, CFG.maxChunks);
        lastSearchMeta = {
          query,
          contentChunkCount: contentChunks.length,
          truncated: contentChunks.length > allChunks.length,
          windowEnd: allChunks.length,
        };
        progressTextLength = allChunks.length
          ? utf16ToCp(extractedText, allChunks[allChunks.length - 1].end)
          : 0;

        // SYNC：站内 truncated-text — 搜索开始全文置灰，随已分析边界后移恢复原色
        setTruncatedHighlight(0);
      }

      beginChunkSearchAutoScroll();

      // 双循环流水线：抓取循环只管领先渲染 FETCH_AHEAD 步尽早发请求，不含任何延迟；
      // 渲染循环按 chunk 顺序消费结果、维持 CHUNK_SEARCH_MIN_CYCLE_MS 展示节奏——二者互不阻塞，
      // 停留只影响「多久展示下一块」，不再卡住下一次请求的发出时机
      const FETCH_AHEAD = 1;
      const pendingChunkResults = new Map();
      let fetchCursor = resumeFrom;
      const stillThisSearch = () => epoch === searchEpoch && !abortWanted;
      const prefetchChunk = (idx) => {
        const p = analyzeSemantic(query, allChunks[idx].text);
        p.catch(() => {}); // 真正的错误仍会在被 await 时抛出，这里只是防止预取阶段的悬空 rejection 噪音
        pendingChunkResults.set(idx, p);
      };
      const advanceFetch = (renderIndex) => {
        while (stillThisSearch() && fetchCursor < allChunks.length && fetchCursor <= renderIndex + FETCH_AHEAD) {
          prefetchChunk(fetchCursor);
          fetchCursor++;
        }
      };
      advanceFetch(resumeFrom); // 预热：从续跑点起抓取 [resumeFrom, resumeFrom+FETCH_AHEAD]

      try {
        for (let i = resumeFrom; i < allChunks.length; i++) {
          if (!stillThisSearch()) break;
          const chunk = allChunks[i];
          const res = await pendingChunkResults.get(i);
          pendingChunkResults.delete(i);
          if (!stillThisSearch()) break;

          const degree = res.full_match_degree ?? 0;
          // SYNC: semanticSearchController — matched = degree >= threshold；未匹配块不上色
          const matched = degree >= CFG.matchThreshold;
          const chunkCpStart = utf16ToCp(extractedText, chunk.start);
          const chunkCpEnd = utf16ToCp(extractedText, chunk.end);
          analyzedCpEnd = Math.max(analyzedCpEnd, chunkCpEnd);
          semanticMatchProgress.push({
            start: chunkCpStart,
            end: chunkCpEnd,
            matchDegree: degree,
          });
          renderSemanticMatchProgress();

          // 跟随判定用「本块入列前」是否已有匹配
          const hadMatchBefore = matchedChunks.length > 0;
          // 未勾选 Follow：首个匹配处停下并划线；勾选则全程跟随，结束再跳首个匹配
          const willJump = !followAll && matched && !parkedOnFirstMatch;

          if (matched) {
            matchedChunks.push({
              start: chunkCpStart,
              end: chunkCpEnd,
              matchDegree: degree,
            });
          }

          const isHybrid = (CFG.submode || 'hybrid') === 'hybrid';
          // hybrid：count 后即推进主流程；fill_blank 异步染色（相对整包 await，增加与 count 的额外并发）
          // 非 hybrid：token 随本次结果同步上色
          if (matched && isHybrid) {
            upsertSpec({ kind: 'pending-underline', cp0: chunkCpStart, cp1: chunkCpEnd });
            renderUnderlinesOfKind('pending-underline');
          } else if (matched) {
            paintChunkTokens(res.token_attention, chunk.text, chunkCpStart, degree);
          }
          // count 完即恢复灰字/画等待线；fill 背压只推迟入队与下一块，不挡本块 hold/jump
          setTruncatedHighlight(analyzedCpEnd);

          // followThis = followAll || !hadMatchBefore；willJump 块滚动延后到 hold 后（扩展节奏，非站内）
          if ((followAll || !hadMatchBefore) && !willJump) {
            followSearchingChunk(chunkCpStart);
          }
          // 每块后快照：close 中途清高亮时仍保留上一版
          snapshotLastResult(query);

          // 渲染完立即放行抓取循环（不等 hold），避免网络/服务器因停留而空闲
          advanceFetch(i + 1);

          // 首个匹配块也要先经过与其它块一致的 hold，再触发自动滚动，
          // 避免着色刚出现就被立刻滚走——即使命中的正好是最后一块
          const nextIndex = i + 1;
          // shouldFollow = followAll || !hasMatch；park 后不再滚动/settle，hold 撑满 MIN_CYCLE（扩展节奏）
          const willSettleAfterHold =
            willJump || (nextIndex < allChunks.length && (followAll || !parkedOnFirstMatch));
          const holdMs = willSettleAfterHold ? CHUNK_SEARCH_HOLD_MS : CHUNK_SEARCH_MIN_CYCLE_MS;
          if (willJump || nextIndex < allChunks.length) {
            await delayMs(holdMs);
            if (!stillThisSearch()) break;
          }
          if (willJump) {
            jumpToMatch(0);
            parkedOnFirstMatch = true;
            // 跳转落点同样要停留够 CHUNK_SEARCH_SCROLL_SETTLE_MS，避免划线刚定位就被下一块的渲染打断
            await delayMs(CHUNK_SEARCH_SCROLL_SETTLE_MS);
            if (!stillThisSearch()) break;
          }

          // hold/jump 已完成后再等 fill 空位，避免首个匹配等待线出现后被背压卡住才开始滚
          if (matched && isHybrid) {
            await waitUntilFillLagOk();
            if (!stillThisSearch()) break;
            enqueueFillBlank(async (gen) => {
              if (gen !== fillGen) return;
              try {
                const r2 = await analyzeSemanticRaw(query, chunk.text, { submode: 'fill_blank' });
                if (gen !== fillGen) return;
                if (!extractRoot?.isConnected) return;
                // 有红色 token → 拆 pending；否则留下 = chunk 级匹配标记（失败/无色同理）
                const painted = paintChunkTokens(
                  r2.token_attention,
                  chunk.text,
                  chunkCpStart,
                  degree
                );
                if (painted > 0) clearPendingUnderline(chunkCpStart, chunkCpEnd);
                snapshotLastResult(query);
              } catch (err) {
                // 无 token 可画：pending 留下表示本 chunk 已匹配
                console.error('[InfoLens] fill_blank', err?.message || err);
              }
            });
          }

          if (nextIndex < allChunks.length && (followAll || !parkedOnFirstMatch)) {
            const nextChunk = allChunks[nextIndex];
            followSearchingChunk(utf16ToCp(extractedText, nextChunk.start));
            // 滚动后的新位置也要停留够 CHUNK_SEARCH_SCROLL_SETTLE_MS，
            // 否则分析过快时会出现「刚滚过去就立刻变色」的突变感；抓取循环已提前放行，不受影响
            await delayMs(CHUNK_SEARCH_SCROLL_SETTLE_MS);
            if (!stillThisSearch()) break;
          }
        }
      } finally {
        endChunkSearchAutoScroll();
      }

      if (epoch !== searchEpoch) return;

      if (extractRoot != null) {
        setTruncatedHighlight(analyzedCpEnd);
        if (!abortWanted) {
          if (matchedChunks.length && !parkedOnFirstMatch) jumpToMatch(0);
          else updateNav();
          if (lastSearchMeta?.truncated) {
            showFindStatus(
              'Note',
              `Text too long; analyzing first ${allChunks.length} of ${lastSearchMeta.contentChunkCount} chunks`
            );
          }
        }
        // abort：Stopped/Continue 已在 Stop 点击时展示，此处只收尾 truncated + 下方 snapshot
      }
      snapshotLastResult(query);
    } catch (err) {
      // 过期轮次 / 用户主动停止：失败不得打到当前 UI（否则会出现「一边报错一边新搜索在跑」）
      if (epoch !== searchEpoch || abortWanted) {
        console.error('[InfoLens]', err?.message || err);
        return;
      }
      console.error('[InfoLens]', err?.message || err);
      updateNav();
      showFindError(err?.message || err);
      snapshotLastResult(query);
    } finally {
      // 仅本轮结束时清 searching；过期轮次不能关掉仍在跑的新一轮
      if (epoch === searchEpoch) {
        setSearching(false);
        abortWanted = false;
      }
    }
  }

  /** 目测提取：按 chunk 分块，走 paintAllUnderlines；定根失败则放弃 */
  function previewExtractUnderlines() {
    let info;
    try {
      info = refreshExtract();
    } catch (err) {
      clearOverlays();
      extractedText = '';
      setPieces([]);
      matchedChunks = [];
      matchIndex = -1;
      console.error('[InfoLens] extract aborted:', err?.message || err);
      return null;
    }
    if (!extractedText.trim()) {
      console.error('[InfoLens] extract aborted: empty article text');
      return info;
    }
    const allChunks = splitChunks(extractedText, CFG.chunkBytes).filter(chunkHasContent);
    matchedChunks = allChunks.map((chunk) => ({
      start: utf16ToCp(extractedText, chunk.start),
      end: utf16ToCp(extractedText, chunk.end),
      matchDegree: 1,
    }));
    matchIndex = -1;
    paintAllUnderlines();
    console.info(
      `[InfoLens] extract preview · ~${info.length} chars · ${allChunks.length} chunk(s) · ${overlayEls.length} rects`,
      { root: info.root, scrollRoot: findScrollRoot(info.root) }
    );
    return info;
  }

  async function open() {
    try {
      if (DOM_DEBUG) {
        // 再次点击：取消下划线
        if (paintSpecs.length > 0 || overlayEls.length > 0) {
          close();
          console.info('[InfoLens] extract preview cleared');
          return;
        }
        previewExtractUnderlines();
        return;
      }
      const bar = await ensureBar();
      if (!bar) throw new Error('find bar missing');
      bar.hidden = false;
      const input = /** @type {HTMLInputElement} */ (ui$('semantic_find_input'));
      // 仅同步 UI（× 按钮可见性），不走 'input' 统一清空路径：reopen 要保留上次渲染结果给下面 tryRestoreLastResult 用
      syncClearButton(false);
      input?.focus();
      input?.select();
      try {
        refreshExtract();
        renderSemanticMatchProgress();
        tryRestoreLastResult(input?.value?.trim() || '');
      } catch (err) {
        console.error('[InfoLens] extract aborted:', err?.message || err);
        throw err;
      }
    } catch (err) {
      console.error('[InfoLens]', err);
    }
  }

  function close() {
    abortWanted = true;
    // 先冻结输入对应的结果+状态条，再清 live；reopen 走 tryRestoreLastResult
    const query =
      /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.value?.trim() || '';
    if (query) snapshotLastResult(query);
    resetSearchSession();
    hideHistoryDropdown();
    const bar = ui$('semantic_find_bar');
    if (bar) {
      bar.hidden = true;
      uiQuery('.semantic-find-bar')?.classList.remove('is-input-active', 'is-searching');
    }
    setSearching(false);
  }

  /** 上次注入已过期（重装扩展未刷新页面）需整个丢弃时调用：close() 之外，摘掉本实例注册在 window 上的监听器 */
  function destroy() {
    close();
    window.removeEventListener('scroll', scheduleSyncPaintAfterLayout, true);
    window.removeEventListener('scrollend', syncPaintAfterLayout, true);
    window.removeEventListener('resize', scheduleReflow);
    window.visualViewport?.removeEventListener('resize', scheduleReflow);
  }

  // underline 与正文同层滚动；token/truncated 为 CSS Highlight。布局漂移时重绑 Range / 重测 underline。
  window.addEventListener('scroll', scheduleSyncPaintAfterLayout, true);
  window.addEventListener('scrollend', syncPaintAfterLayout, true);
  window.addEventListener('resize', () => {
    scheduleReflow();
    renderSemanticMatchProgress();
  });
  window.visualViewport?.addEventListener('resize', scheduleReflow);

  window.__IL_SEMANTIC_DEMO__ = { open, close, destroy };
  void open();
})();
