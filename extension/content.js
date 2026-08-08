/**
 * InfoLens semantic find — feasibility content script.
 * Validates: article extract ↔ DOM map, API call, token paint, chunk underline.
 *
 * token / truncated：CSS Custom Highlight API（不改 DOM；truncated 为 CanvasText×Canvas 统一灰）。
 * underline（导航）/ pending-underline：#il-overlay-host 盖层，可叠画；统一蓝。
 * pending：fill 前是「等待染色」；keywords 成功（含空 token_attention）后拆掉；失败则留下。
 * keywords：新扩展打 /api/v2/analyze-semantic-keywords（边缘远程，无重叠可上色）；旧路径留给旧扩展。
 *
 * IL_CONFIG.domDebug：点击后只抽正文并下划线，便于目测提取范围（不唤起 Find bar）。
 */
(() => {
  // 已注入过：直接 reopen
  if (window.__IL_SEMANTIC_DEMO__) {
    window.__IL_SEMANTIC_DEMO__.open();
    return;
  }

  if (!globalThis.IL_CONFIG) {
    throw new Error('IL_CONFIG missing — inject config.js before content.js');
  }
  const CFG = globalThis.IL_CONFIG;
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
  /** 流式逐块跟随的跳转节流间隔：跨刷新率统一。 */
  const CHUNK_SEARCH_FOLLOW_STEP_MS = 66;
  // SYNC: client/src/shared/core/constants.ts → SEMANTIC_CHUNK_BYTES；算法见 splitTextToChunks.js
  // 已知问题：与后端 SEMANTIC_RUNTIME_CONFIGS 的 max_token_length（300~1000 token，按平台）无联动。
  // 数字/标点/代码等 token 密度高的内容，800 字节可能超出后端 token 限，被静默截断（仅日志提示），
  // 导致该 chunk 的相关度判断只基于截断后的前缀 —— 后果是漏检，非误报。无法靠调大固定 token 数根治。
  const CHUNK_BYTES = 800;
  // 语义搜索一次最多覆盖的 chunk 数（超长文章只搜前 N 块）；SYNC: 门面 MULTI_CHUNK_MAX / RELEVANCE_BATCH
  const MAX_CHUNKS_PER_SEARCH = 32;
  // 流空闲兜底：门面端挂起（既不回流也不结束）时避免 promise 永久挂起 → 搜索卡死。
  // 以「空闲」判超时：每次收到流数据 row 都重置计时器（有进展不算超时）；
  // 只有连续 idle 超过此值（含连接建立后首行迟迟不来）才判死：超过 10s 无新数据即放弃。
  const STREAM_IDLE_MS = 10000;

  /** @type {{ node: Text, start: number, end: number }[]} */
  let pieces = [];
  /** pieces 的节点集合缓存，供 mutationTouchesPieces 做 O(1) 命中判断，避免逐条 mutation 都线性扫 pieces */
  /** @type {Set<Text>} */
  let pieceNodeSet = new Set();
  let extractedText = '';
  /**
   * 补充平面字符（占 2 个 UTF-16 单元）的码点下标，升序、通常很稀。
   * utf16 = cp +（该 cp 之前的补充字符个数）；无补充时两套下标恒等。
   * @type {number[]}
   */
  let suppCpIndices = [];
  /** extractedText 的码点长度（建表时一并缓存） */
  let extractedCpLength = 0;
  /** @type {{ start: number, end: number, matchDegree: number }[]} */
  let matchedChunks = [];
  /**
   * 进度图：全量已分析块。
   * hasKeywords=true 才画红（keywords 已回且有可上色段）；相关等待中 / 无词 / 未过阈值均为灰，高度仍跟 matchDegree。
   * @type {{ start: number, end: number, matchDegree: number, hasKeywords?: boolean }[]}
   */
  let semanticMatchProgress = [];
  /** 进度条分母（码点数）：MAX_CHUNKS_PER_SEARCH 截断时用实际搜索覆盖长度，而非全文长度；0 = 未搜索，回退全文 */
  let progressTextLength = 0;
  /** @type {{ tone: string, label: string, detail: string, error_detail?: string, resumable?: boolean, feedbackSent: boolean, el: HTMLElement }[]} */
  let statusEntries = [];
  /** @type {{ query: string, contentChunkCount: number, truncated: boolean, windowEnd: number } | null} */
  let lastSearchMeta = null;
  /** 本轮搜索是否已处理过 HF 慢速提示（展示或叉掉后均不再弹出） */
  let slowBackendNoticeShown = false;
  let selectedProgressChunkStart = null;
  let hoveredProgressChunkStart = null;
  /** 本轮 runSearch 是否已因首个匹配跳转过（流式首匹配立即跳，结束后避免重复滚动） */
  let firstMatchJumped = false;
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
  *   statuses: Array<{ tone: string, label: string, detail: string, error_detail?: string, resumable?: boolean }>,
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
  /**
   * 本轮搜索的在途流取消句柄（relevance 批量 + keywords 共用）。运行搜索轮次时在 runSearch 开头重建；
   * Stop/×/giveUp/close 通过 abort() 立即断开 content↔background 的 port → background abort 门面流（终止 OpenRouter），
   * 不等主循环自然退出（主循环可能挂在 await 上，若只靠 abortWanted 会延迟到下一次结果回流才退出）。
   */
  let sessionAbortCtrl = new AbortController();
  let reflowQueued = false;
  /** 跟手跟随节流的"上次放行时刻"（性能时钟）。循环启动时重置为 0，使首帧必放行。 */
  let lastFollowFrameAt = 0;
  /** 待展示的滚动队列（cp + 序号）。数据到达即入队（不影响数据/请求节奏），
   * 由 RAF 循环每 CHUNK_SEARCH_FOLLOW_STEP_MS 出队一个逐个滚动，保证每块都轮到展示。 */
  const followQueue = [];
  /** 消费循环的 RAF id；0 表示循环未在跑。存 id 以便 start/reset 时取消旧循环，
   * 从根上避免布尔防重入在旧循环未退出时被强制复位导致的并行双循环。 */
  let followRafId = 0;
  let underlineHoldTimer = 0;
  let underlineFadeTimer = 0;
  let underlineFadeGen = 0;

  /**
   * 在途上限 concurrency 的任务池；多出的在前端短队列等。
   * 供 keywords 段消费；relevance 段自管有界缓冲，不用此池。
   * @param {number} concurrency
   */
  function createPool(concurrency) {
    /** @type {{ exec: () => Promise<void> }[]} */
    const queue = [];
    let active = 0;
    let gen = 0;
    /** 当前 round 的中止控制器；`abort()` 立即中止在途，下一轮 `invalidate()`/`abort()` 重建为新鲜信号 */
    let abortCtrl = new AbortController();
    /** 等待池空闲（无排队、无在途）的 resolve 集合 */
    let idleResolvers = [];

    /** 结束当前 round 的中止信号，为下一轮换新 */
    function resetAbort() {
      abortCtrl = new AbortController();
    }

    function checkIdle() {
      if (queue.length !== 0 || active !== 0) return;
      const rs = idleResolvers;
      idleResolvers = [];
      for (const r of rs) r();
    }

    function pump() {
      while (active < concurrency && queue.length) {
        const item = queue.shift();
        active++;
        Promise.resolve()
          .then(() => item.exec())
          .catch(() => {})
          .finally(() => {
            active--;
            checkIdle();
            pump();
          });
      }
    }

    return {
      /** @param {(gen: number, signal: AbortSignal) => Promise<void>} job */
      schedule(job) {
        const g = gen;
        queue.push({
          exec: async () => {
            try {
              await job(g, abortCtrl.signal);
            } catch (err) {
              console.error('[InfoLens] pool job', err?.message || err);
            }
          },
        });
        pump();
      },
      /** 丢弃未开工；在途跑完但 job 内比对 gen 作废 */
      invalidate() {
        gen += 1;
        resetAbort();
        queue.length = 0;
        checkIdle();
      },
      /** 立即中止所有在途任务（OpenRouter 断连）；并作废排队。
       * 不 bump gen：让已中止的在途任务走完正常 clean 路径（renderQueue.release 等收尾），
       * 仅靠 signal 断流；次轮 `invalidate()` 会 bump gen + 换新信号。 */
      abort() {
        abortCtrl.abort();
        resetAbort();
        queue.length = 0;
        checkIdle();
      },
      /** 仅换新中止信号（供 Continue 复用同一池时，避免旧已中止信号影响新一批任务不 abort） */
      resetAbortSignal() {
        resetAbort();
      },
      /** 当前已入队任务全部结束（队列空且无在途）时 resolve；立即空闲则同步 resolve */
      whenIdle() {
        return new Promise((resolve) => {
          if (queue.length === 0 && active === 0) {
            resolve();
            return;
          }
          idleResolvers.push(resolve);
        });
      },
      get gen() {
        return gen;
      },
    };
  }

  // 分块搜索两段流水线（渲染身兼两职：上段消费者 + 下段生产者）：
  //   [relevance 生产] ──► [渲染] ──匹配任务──► [keywords 消费]
  // relevance：V2 按 ≤32 块成批请求，渲染按序消费每片；keywords 自有在途上限。
  const MAX_KEYWORDS_IN_FLIGHT = 4; // keywords 在途（池并发）
  /** 与 searchEpoch 分离：Stop/Continue 不该作废已匹配块的 keywords */
  const keywordsPool = createPool(MAX_KEYWORDS_IN_FLIGHT);

  // ---------- extract（纯文本查看器 / Readability 定根；后者失败不回退） ----------

  function pickArticleRoot() {
    const find = globalThis.IL_findArticleRoot;
    if (typeof find !== 'function') {
      throw new Error('IL_findArticleRoot missing — inject articleRoot.js before content.js');
    }
    return find(document);
  }

  function collectTextMap(root) {
    const fn = globalThis.IL_collectTextMap;
    if (typeof fn !== 'function') {
      throw new Error('IL_collectTextMap missing — inject collectTextMap.js before content.js');
    }
    return fn(root);
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
    setExtractedText(mapped.text);
    setPieces(mapped.pieces);
    contentDirty = false;
    matchedChunks = [];
    semanticMatchProgress = [];
    selectedProgressChunkStart = null;
    matchIndex = -1;
    return { root, length: extractedText.length };
  }

  // ---------- offsets (API = code points; piece map = UTF-16) ----------

  /** 写入 extractedText 并重建补充字符稀疏表（仅此处改正文缓存） */
  function setExtractedText(text) {
    extractedText = text || '';
    const supp = [];
    let cps = 0;
    for (let i = 0; i < extractedText.length; ) {
      const cp = extractedText.codePointAt(i);
      const w = cp > 0xffff ? 2 : 1;
      if (w === 2) supp.push(cps);
      i += w;
      cps += 1;
    }
    suppCpIndices = supp;
    extractedCpLength = cps;
  }

  /** 有序数组中严格小于 x 的个数 */
  function countBefore(sorted, x) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function cpToUtf16(cpIndex) {
    const cp = cpIndex < 0 ? 0 : cpIndex > extractedCpLength ? extractedCpLength : cpIndex;
    return cp + countBefore(suppCpIndices, cp);
  }

  function utf16ToCp(utf16Index) {
    const u =
      utf16Index < 0
        ? 0
        : utf16Index > extractedText.length
          ? extractedText.length
          : utf16Index;
    // 与从头扫描一致：统计 start < u 的码点数 = u −（下标 < u 的低代理个数）
    // 补充字符 k 的低代理下标 = supp[k] + k + 1
    let lo = 0;
    let hi = suppCpIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (suppCpIndices[mid] + mid + 1 < u) lo = mid + 1;
      else hi = mid;
    }
    return u - lo;
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
    const u0 = cpToUtf16(cp0);
    const u1 = cpToUtf16(cp1);
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
    const u0 = cpToUtf16(cp0);
    const u1 = cpToUtf16(cp1);
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
    const fullCp = extractedCpLength;
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
  }

  function clearOverlays() {
    cancelUnderlineFade();
    resetFollowQueue();
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

  function resetFeedbackButton(btn) {
    if (!btn) return;
    btn.hidden = false;
    btn.disabled = false;
    btn.classList.remove('is-thanks');
    btn.innerHTML = STATUS_FEEDBACK_ICON;
    btn.title = 'Report this to the author';
    btn.setAttribute('aria-label', 'Report this to the author');
  }

  function markFeedbackThanks(btn) {
    if (!btn) return;
    btn.disabled = true;
    btn.classList.add('is-thanks');
    btn.innerHTML = STATUS_HEART_ICON;
    btn.removeAttribute('title');
    btn.setAttribute('aria-label', 'Thanks');
    // 红心稍后收起；条本身保留，由用户手动 ×
    window.setTimeout(() => {
      if (!btn.isConnected || !btn.classList.contains('is-thanks')) return;
      btn.hidden = true;
      btn.classList.remove('is-thanks');
      btn.innerHTML = STATUS_FEEDBACK_ICON;
    }, 3000);
  }

  /**
   * @param {{ tone: string, label: string, detail: string }} status
   * @param {HTMLButtonElement | null} btn
   */
  function sendFeedback(status, btn) {
    if (!status || !btn || btn.disabled) return;
    btn.disabled = true;
    chrome.runtime.sendMessage(
      {
        type: 'il-extension-feedback',
        apiBase: CFG.apiBase,
        body: buildFeedbackBody(status),
      },
      () => {
        void chrome.runtime.lastError; // fire-and-forget
      }
    );
    markFeedbackThanks(btn);
  }

  /** 反馈文案以 HTML 为准，避免与 DOM 双份漂移 */
  function backendNoticeFeedbackStatus() {
    const detail = uiQuery('.semantic-find-backend-notice-text')?.textContent?.trim() || '';
    if (!detail) throw new Error('backend notice text missing');
    return { tone: 'info', label: 'Note', detail };
  }

  function clearFindStatus() {
    statusEntries = [];
    const list = ui$('semantic_find_status_list');
    if (list) list.replaceChildren();
  }

  /** 进度条下：HF 慢速提示（与 Failed/Note 状态条独立；持续显示，叉掉后本轮不再出现）。
   * 注：显示入口 noteBackend 已于 v2 化时移除（relevance/keywords v2 均不再回调 hf backend）；
   * 提示条 UI 与 slowBackendNoticeShown 状态往返保留，供未来接入「慢速备份服务器」提示时复用。 */
  function clearSlowBackendNotice() {
    const el = ui$('semantic_find_backend_notice');
    if (el) el.hidden = true;
  }

  /**
   * 有未分析 chunk 时可续跑：Failed / Stopped 半截，或 MAX_CHUNKS_PER_SEARCH 截断后的下一批。
   * 需已有进度（n>0）；首块即失败无匹配时用 Enter 重开即可，不必 Continue。
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

  function refreshStatusContinueButtons() {
    const show = canResumeSearch();
    for (const entry of statusEntries) {
      const btn = entry.el.querySelector('.semantic-find-status-continue');
      if (!(btn instanceof HTMLButtonElement)) continue;
      // Failed / Stopped / 截断 Note 可续跑；chunk 级 keywords 失败 resumable=false 不挂
      const allow =
        show &&
        entry.resumable !== false &&
        (entry.label === 'Failed' ||
          entry.label === 'Stopped' ||
          entry.label === 'Note');
      btn.hidden = !allow;
    }
  }

  function statusEntryKey(tone, label, detail) {
    return `${tone}\0${label}\0${detail}`;
  }

  /**
   * 追加一条状态条（同文案不重复）；样式复用原 Failed/Note strip。
   * @param {string} label short prefix (Failed / Note / Stopped)
   * @param {string} detail reason or explanation（用户可见）
   * @param {{ tone?: 'error' | 'info', errorDetail?: string, resumable?: boolean }} [opts]
   *   errorDetail 仅进反馈，不展示；resumable===false 时不挂 Continue（chunk 级 keywords 失败）
   */
  function showFindStatus(label, detail, opts) {
    const list = ui$('semantic_find_status_list');
    if (!list) return;
    const tone = opts?.tone === 'error' ? 'error' : 'info';
    const head = String(label || '').trim() || (tone === 'error' ? 'Failed' : 'Note');
    const body = String(detail || '').trim();
    const key = statusEntryKey(tone, head, body);
    if (statusEntries.some((e) => statusEntryKey(e.tone, e.label, e.detail) === key)) {
      refreshStatusContinueButtons();
      return;
    }

    const errorDetail =
      opts?.errorDetail != null && String(opts.errorDetail).trim()
        ? String(opts.errorDetail).trim()
        : undefined;
    const resumable = opts?.resumable !== false;

    const el = document.createElement('div');
    el.className = 'semantic-find-strip semantic-find-status';
    el.setAttribute('role', 'status');

    const textEl = document.createElement('span');
    textEl.className = 'semantic-find-status-text';
    const labelEl = document.createElement('span');
    labelEl.className =
      tone === 'error' ? 'semantic-find-status-label is-error' : 'semantic-find-status-label';
    labelEl.textContent = head;
    textEl.replaceChildren(labelEl, ...(body ? [document.createTextNode(` · ${body}`)] : []));
    textEl.title = body ? `${head} · ${body}` : head;

    const actions = document.createElement('div');
    actions.className = 'semantic-find-status-actions';

    const feedbackBtn = document.createElement('button');
    feedbackBtn.type = 'button';
    feedbackBtn.className = 'semantic-find-status-feedback';
    feedbackBtn.title = 'Report this to the author';
    feedbackBtn.setAttribute('aria-label', 'Report this to the author');
    if (tone === 'error') resetFeedbackButton(feedbackBtn);
    else feedbackBtn.hidden = true;

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'semantic-find-status-continue';
    continueBtn.title = 'Continue search';
    continueBtn.setAttribute('aria-label', 'Continue search');
    continueBtn.textContent = 'Continue';
    continueBtn.hidden = true;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'semantic-find-status-close';
    closeBtn.title = 'Dismiss';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '×';

    actions.append(feedbackBtn, continueBtn, closeBtn);
    el.append(textEl, actions);
    list.appendChild(el);

    statusEntries.push({
      tone,
      label: head,
      detail: body,
      ...(errorDetail ? { error_detail: errorDetail } : {}),
      resumable,
      feedbackSent: false,
      el,
    });
    refreshStatusContinueButtons();
  }

  /** Task failure; reason 用户可见；errorDetail 仅反馈 */
  function showFindError(reason, opts) {
    showFindStatus('Failed', reason || 'Request failed', {
      tone: 'error',
      errorDetail: opts?.errorDetail,
      resumable: opts?.resumable,
    });
  }

  /**
   * 失败 chunk 上下文写入已有 error_detail（后端原样落库，无需新字段）。
   * @param {string} stage
   * @param {number} chunkIndex
   * @param {{ text?: string, start?: number, end?: number }} chunk
   * @param {string} [tech]
   */
  function formatChunkErrorDetail(stage, chunkIndex, chunk, tech) {
    const lines = [
      `stage=${stage}`,
      `chunk_index=${chunkIndex}`,
      `chunk_start=${typeof chunk?.start === 'number' ? chunk.start : ''}`,
      `chunk_end=${typeof chunk?.end === 'number' ? chunk.end : ''}`,
      '--- chunk ---',
      chunk?.text != null ? String(chunk.text) : '',
    ];
    const t = tech != null ? String(tech).trim() : '';
    if (t) lines.push('--- error ---', t);
    return lines.join('\n');
  }

  /** @param {{ tone: string, label: string, detail: string }} status */
  function buildFeedbackBody(status) {
    return {
      status: status || { tone: 'info', label: 'Note', detail: '' },
      page_url: location.href,
      query: lastSearchMeta?.query
        || /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.value?.trim()
        || '',
      config: {
        apiBase: CFG.apiBase,
        chunkBytes: CHUNK_BYTES,
        matchThreshold: CFG.matchThreshold,
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

  /** @param {{ tone: string, label: string, detail: string, error_detail?: string, feedbackSent: boolean, el: HTMLElement }} entry */
  function sendStatusFeedbackForEntry(entry, btn) {
    if (!entry || entry.feedbackSent) return;
    entry.feedbackSent = true;
    sendFeedback(
      {
        tone: entry.tone,
        label: entry.label,
        detail: entry.detail,
        ...(entry.error_detail ? { error_detail: entry.error_detail } : {}),
      },
      btn
    );
  }

  function dismissStatusEntry(entry) {
    const i = statusEntries.indexOf(entry);
    if (i < 0) return;
    statusEntries.splice(i, 1);
    entry.el.remove();
    refreshStatusContinueButtons();
  }

  /**
   * 清当前会话的渲染与搜索进度。
   * @param {{ clearCache?: boolean }} [options] clearCache=true 时连 lastResult 一并丢弃（改 query / giveUp）
   */
  function resetSearchSession({ clearCache = false } = {}) {
    keywordsPool.invalidate();
    renderQueue.reset();
    clearOverlays();
    clearFindStatus();
    slowBackendNoticeShown = false;
    clearSlowBackendNotice();
    matchedChunks = [];
    semanticMatchProgress = [];
    progressTextLength = 0;
    lastSearchMeta = null;
    selectedProgressChunkStart = null;
    hoveredProgressChunkStart = null;
    firstMatchJumped = false;
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
    sessionAbortCtrl.abort();
    keywordsPool.abort();
    // 全文重建后旧偏移全作废：清干净并丢弃缓存，下次搜索全量重提
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
      // pending 等待线随快照；红线靠 semanticMatchProgress.hasKeywords（keywords 确认有色后才红）
      paintSpecs: paintSpecs.map((s) => ({ ...s })),
      matchedChunks: matchedChunks.map((c) => ({ ...c })),
      semanticMatchProgress: semanticMatchProgress.map((c) => ({ ...c })),
      progressTextLength,
      matchIndex,
      truncatedAnalyzedCpEnd,
      selectedProgressChunkStart,
      statuses: statusEntries.map((e) => ({
        tone: e.tone,
        label: e.label,
        detail: e.detail,
        ...(e.error_detail ? { error_detail: e.error_detail } : {}),
        ...(e.resumable === false ? { resumable: false } : {}),
      })),
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
    clearFindStatus();
    const statuses = lastResult.statuses || (lastResult.status ? [lastResult.status] : []);
    for (const s of statuses) {
      showFindStatus(s.label, s.detail, {
        tone: s.tone === 'error' ? 'error' : 'info',
        errorDetail: s.error_detail,
        resumable: s.resumable,
      });
    }
    return true;
  }

  /**
   * ChatGPT 等会在滚动时改布局/换节点；滚动停稳或尺寸变化后按需重绑 Range / 重测 underline。
   * 无 mutation 且 pieces 仍 connected 时跳过 collectTextMap，且不重绑 CSS Highlight（只重测线）。
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
    // 无 mutation 且节点仍在：Highlight Range 仍有效，只重测依赖 getClientRects 的 underline
    if (!contentDirty && !stale) {
      remeasureUnderlines({
        preserveUnderline: paintSpecs.some((s) => s.kind === 'underline'),
      });
      return;
    }

    const mapped = collectTextMap(extractRoot);
    contentDirty = false;
    if (mapped.text !== extractedText) {
      // DOM_DEBUG 只是目测提取范围的调试预览，永远反映"当前"文本，文本变了就重新按当前内容分块展示
      if (DOM_DEBUG) {
        setExtractedText(mapped.text);
        setPieces(mapped.pieces);
        if (!extractedText.trim()) {
          clearOverlayEls();
          clearAllCustomHighlights();
          return;
        }
        const allChunks = splitChunks(extractedText, CHUNK_BYTES).filter(chunkHasContent);
        matchedChunks = allChunks.map((chunk) => ({
          start: utf16ToCp(chunk.start),
          end: utf16ToCp(chunk.end),
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
   * 只重测 underline（不动 token / truncated Highlight）。
   * 滚动停稳、resize 等几何可能变、节点未换时用这条路径。
   * @param {{ preserveUnderline?: boolean }} [options]
   *   preserveUnderline：不拆蓝导航线 DOM（hold/fade 不被流式更新打断）
   */
  function remeasureUnderlines(options) {
    if (options?.preserveUnderline !== true) renderUnderlinesOfKind('underline');
    renderUnderlinesOfKind('pending-underline');
  }

  /**
   * 全量：token + truncated + 下划线。仅用于节点重绑 / 还原等必须整表一致的场景。
   * @param {{ preserveUnderline?: boolean }} [options]
   */
  function renderAllSpecs(options) {
    if (!extractRoot?.isConnected) return 0;
    ensurePaintMount(extractRoot);
    renderTokenHighlights();
    applyTruncatedHighlight();
    remeasureUnderlines(options);
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
      // resize 只改几何：Highlight 无需重绑，只重测 underline
      remeasureUnderlines({
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
    // 只 fade 导航线；等待线独立，不在此列。当前 chunk 状态不随正文下划线淡出。
    const lines = overlayEls.filter((el) => el.dataset.ilUnderline === 'nav');
    if (!lines.length) {
      paintSpecs = paintSpecs.filter((s) => s.kind !== 'underline');
      if (lastResult) snapshotLastResult(lastResult.query);
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
        // 下划线已淡出，但当前 chunk 仍由进度图蓝线和导航逻辑保留。
        if (lastResult) snapshotLastResult(lastResult.query);
      }, CHUNK_HIGHLIGHT_FADE_MS);
    });
  }

  /**
   * 取 cp 附近可用于滚动定位的可视 rect。
   * 正文起点（第一个 chunk）常有前导换行/空白：单码点 Range 的 getClientRects 为空，
   * 若仍用 rangeFromCpOffsets(cp0, cp0+1) 会直接放弃滚动；下划线绘制已用
   * rangesFromCpOffsets 跳过空白，故会出现「点了进度条有线但不跳转」。
   */
  function clientRectNearCp(cp0) {
    if (!extractedText || cp0 < 0) return null;
    const fullCp = extractedCpLength;
    if (cp0 >= fullCp) return null;
    const probeEnd = Math.min(fullCp, cp0 + 128);
    for (const range of rangesFromCpOffsets(cp0, probeEnd)) {
      if (!/\S/.test(range.toString())) continue;
      for (const r of range.getClientRects()) {
        if (r.width >= 1 && r.height >= 1) return r;
      }
    }
    return null;
  }

  /** 计算 rect 顶部滚到视角 viewportYRatio 处所需的位置（window/panel 归一）。共用一份滚动数学。 */
  function computedScrollTop(rect, scrollRoot, viewportYRatio) {
    if (
      scrollRoot === document.scrollingElement ||
      scrollRoot === document.documentElement ||
      scrollRoot === document.body
    ) {
      const ideal = window.scrollY + rect.top - window.innerHeight * viewportYRatio;
      const maxScroll = Math.max(
        0,
        (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight
      );
      return { target: window, top: Math.max(0, Math.min(ideal, maxScroll)) };
    }
    const panel = /** @type {HTMLElement} */ (scrollRoot);
    const panelRect = panel.getBoundingClientRect();
    const topInPanel = rect.top - panelRect.top + panel.scrollTop;
    const maxScroll = Math.max(0, panel.scrollHeight - panel.clientHeight);
    return {
      target: panel,
      top: Math.max(0, Math.min(topInPanel - panel.clientHeight * viewportYRatio, maxScroll)),
    };
  }

  /**
   * SYNC: client/src/shared/vis/GLTR_Text_Box.ts → scrollToUnicodeCharOffset
   * （宿主页用 findScrollRoot 代替站内 panel）即时定位，滚后回调立即可用。
   */
  function scrollToCpOffset(cp0, onScrollEnd, viewportYRatio = CHUNK_JUMP_VIEWPORT_Y_RATIO) {
    requestAnimationFrame(() => {
      const rect = clientRectNearCp(cp0);
      if (!rect || !extractRoot) {
        onScrollEnd?.();
        return;
      }
      const { target, top } = computedScrollTop(rect, findScrollRoot(extractRoot), viewportYRatio);
      target.scrollTo({ top, behavior: 'auto' });
      onScrollEnd?.();
    });
  }

  /** SYNC: GLTR_Text_Box.scrollToChunkStart（视口 0.2） */
  function scrollToChunkStart(cp0, onScrollEnd) {
    scrollToCpOffset(cp0, onScrollEnd, CHUNK_JUMP_VIEWPORT_Y_RATIO);
  }

  /** 按视口 0.2 即时定位滚动到 cp（无动画、无回调）。供跟手跟随循环逐步追赶目标用。 */
  function applyScrollToCp(cp0, rect) {
    const { target, top } = computedScrollTop(
      rect,
      findScrollRoot(extractRoot),
      CHUNK_JUMP_VIEWPORT_Y_RATIO
    );
    target.scrollTo({ top, behavior: 'auto' });
  }

  /** 清空待展示队列并取消消费循环。start/stop/clear 时调用，避免旧循环残留导致并行双循环。 */
  function resetFollowQueue() {
    followQueue.length = 0;
    if (followRafId) {
      cancelAnimationFrame(followRafId);
      followRafId = 0;
    }
  }

  /**
   * 流式逐块展示：把 chunk 展示动作压入待展示队列。
   * 不阻塞、不 await —— 数据到达即入队，独立 RAF 循环每 CHUNK_SEARCH_FOLLOW_STEP_MS
   * 出队一个展示，保证每块逐个滚动，且数据流水线（relevance 消费 / keywords 发起）不受影响。
   * 队列项：{ cp, reveal }，cp 为待滚动到的 chunk 起点；reveal=true 时该块还附带完整展示
   * （跳转 + 进度图 + 导航态 + 下划线 show/hold/fade），当前仅首个匹配块用。
   * 灰字/等待线/keywords 上色均由主循环实时处理，不进本队列。
   */
  function enqueueFollow(item) {
    followQueue.push(item);
    if (!followRafId) {
      // 重置为 0：performance.now() 恒 >> 步长，首帧必放行，第一项立即展示
      lastFollowFrameAt = 0;
      followLoopTick();
    }
  }

  /** 跟手滚动循环的一帧：距上次放行 ≥ 步长才出队一个展示；队列空则停下。用单一 RAF id 自续，便于取消。 */
  function followLoopTick() {
    followRafId = requestAnimationFrame((now) => {
      if (now - lastFollowFrameAt >= CHUNK_SEARCH_FOLLOW_STEP_MS) {
        lastFollowFrameAt = now;
        const item = followQueue.shift();
        if (item.reveal) {
          // 首个匹配块：与进度图点击共用 revealChunk 展示（画线/选中态/快照），不需导航更新
          const m = matchedChunks.find((c) => c.start === item.cp);
          if (m) revealChunk(m);
        } else {
          const rect = clientRectNearCp(item.cp);
          if (rect && extractRoot) applyScrollToCp(item.cp, rect);
        }
      }
      if (followQueue.length) followLoopTick();
      else followRafId = 0;
    });
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

  /** 当前输入是否与最近一次搜索的 query 一致。 */
  function queryMatchesCurrentResults() {
    const query =
      /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.value?.trim() || '';
    return !!query && lastSearchMeta?.query === query;
  }

  /**
   * 从当前进度图位置计算上下导航的目标。
   * 点击了低于阈值的 chunk 时，也应从该位置继续，而不是回到旧的 matchIndex。
   */
  function navigateMatch(delta) {
    if (!matchedChunks.length) return;

    if (selectedProgressChunkStart == null) {
      jumpToMatch(matchIndex < 0 ? (delta < 0 ? matchedChunks.length - 1 : 0) : matchIndex + delta);
      return;
    }

    const currentIndex = matchedChunks.findIndex(
      (chunk) => chunk.start === selectedProgressChunkStart
    );
    if (currentIndex >= 0) {
      jumpToMatch(currentIndex + delta);
      return;
    }

    const nextIndex = matchedChunks.findIndex(
      (chunk) => chunk.start > selectedProgressChunkStart
    );
    const insertionIndex = nextIndex < 0 ? matchedChunks.length : nextIndex;
    jumpToMatch(delta < 0 ? insertionIndex - 1 : insertionIndex);
  }

  /**
   * 选中并展示一个 chunk：进度图线变蓝 + 下划线 → 滚到起点 → hold → 下划线 fade。
   * 当前 chunk 状态持续保留，进度图点击与上下按钮共用。
   * 由「点击进度线」（selectProgressChunk）和「上下按钮跳转」（jumpToMatch）共用，
   * 保证两者对进度图选中态的表现始终一致。
   */
  function revealChunk(chunk) {
    setCurrentUnderline(chunk);
    selectedProgressChunkStart = chunk.start;
    matchIndex = matchedChunks.findIndex((item) => item.start === chunk.start);
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

  /** 用户取消（abort signal）的兜底错误：message 为展示文案，errorDetail 进反馈 */
  function abortStreamError(label) {
    const err = new Error('search stopped');
    err.errorDetail = `${label} stream cancelled by user`;
    return err;
  }

  /**
   * stream port 的兜底收尾：正常 result/error/abort 会 settle 并清定时器；
   * 通道意外断开（扩展重载 / background 回收 / SW 崩溃）时无 error 事件可收，
   * 门面持续无进展（连首行都不来）则视为挂起——两种情况都要让 promise 落地，避免主循环 / renderQueue 永久挂起。
   * 以「空闲」判超时：业务层每收到一条数据 row 就调 touch() 重置计时器，有进展不算超时；
   * 超时/断线时 reject 的 Error.message 为用户友好文案（直接展示），errorDetail 为诊断信息（仅进反馈）。
   * 返回 { finish, closePort, touch }（finish 已处理竞态）。
   * @param {(data?: unknown) => void} reject  兜底（断开/超时）统一走 reject
   */
  function guardStreamPromise(port, idleMs, label, reject) {
    let settled = false;
    let idleTimer = 0;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      fn(v);
    };
    const closePort = () => {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        const err = new Error(`search response stalled — no new data for ${idleMs / 1000}s`);
        err.errorDetail = `${label} stream: no event within ${idleMs}ms idle window`;
        finish(reject, err);
        closePort();
      }, idleMs);
    };
    port.onDisconnect.addListener(() => {
      const err = new Error(`search connection was interrupted`);
      err.errorDetail = `${label} stream closed unexpectedly`;
      finish(reject, err);
    });
    armIdle();
    return { finish, closePort, touch: armIdle };
  }

  /**
   * 远程 relevance V2 流式：一次请求整组连续切片（≤32），经 Port 逐行收每片 degree。
   * SYNC: 门面 /api/v2/analyze-semantic-relevance（SSE：type:row / type:result / type:error）。
   * 每片结果经 onRow 实时回调（full_match_degree）；type:result 仅作本批收尾信号。
   * @param {string} query
   * @param {string[]} texts
   * @param {(n: number, fullMatchDegree: number) => void} onRow  每收到一片 row 即回调（per-result 及时呈现）
   * @param {AbortSignal} [signal]  取消则断开 port → background abort 门面流（终止 OpenRouter）
   * @returns {Promise<void>}  resolve 于 type:result，reject 于 type:error
   */
  function analyzeSemanticV2(query, texts, onRow, signal) {
    const body = {
      query,
      texts,
      privacy_mode: CFG.privacyMode !== false,
    };
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'relevance-stream' });
      const { finish, closePort, touch } = guardStreamPromise(port, STREAM_IDLE_MS, 'relevance', reject);
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'row') {
          touch(); // 有进展重置空闲计时
          onRow?.(msg.n, msg.full_match_degree ?? 0);
        } else if (msg.type === 'result') {
          finish(resolve);
          closePort();
        } else if (msg.type === 'error') {
          const err = new Error(msg.message || 'request failed');
          if (msg.error_detail) err.errorDetail = String(msg.error_detail);
          finish(reject, err);
          closePort();
        }
      });
      if (signal) {
        if (signal.aborted) {
          closePort();
          finish(reject, abortStreamError('relevance'));
        } else {
          signal.addEventListener(
            'abort',
            () => {
              closePort();
              // 取消 = 流结束，走 reject 让主循环 catch 正常收尾（resolve 会让整片永远 pending）
              finish(reject, abortStreamError('relevance'));
            },
            { once: true }
          );
        }
      }
      port.postMessage({
        apiBase: CFG.apiBase,
        path: '/api/v2/analyze-semantic-relevance',
        body,
      });
    });
  }

  /**
   * 远程 keywords V2 流式：一次请求一个 chunk，经 Port 逐条收高亮 run。
   * SYNC: 门面 /api/v2/analyze-semantic-keywords（SSE：type:row {offset,raw,score} / type:result / type:error）。
   * 每个 run 经 onRun 实时回调（增量上色）；type:result 仅作本块收尾信号。
   * @param {string} query
   * @param {string} text
   * @param {(run: {offset: [number, number], raw: string, score: number}) => void} onRun
   * @param {AbortSignal} [signal]  取消则断开 port → background abort 门面流
   * @returns {Promise<void>}  resolve 于 type:result，reject 于 type:error
   */
  function analyzeKeywordsV2(query, text, onRun, signal) {
    const body = {
      query,
      text,
      stream: true,
      privacy_mode: CFG.privacyMode !== false,
    };
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'relevance-stream' });
      const { finish, closePort, touch } = guardStreamPromise(port, STREAM_IDLE_MS, 'keywords', reject);
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'row') {
          touch(); // 有进展重置空闲计时
          onRun?.({ offset: msg.offset, raw: msg.raw, score: msg.score ?? 0 });
        } else if (msg.type === 'result') {
          finish(resolve);
          closePort();
        } else if (msg.type === 'error') {
          const err = new Error(msg.message || 'request failed');
          if (msg.error_detail) err.errorDetail = String(msg.error_detail);
          finish(reject, err);
          closePort();
        }
      });
      if (signal) {
        if (signal.aborted) {
          closePort();
          finish(reject, abortStreamError('keywords'));
        } else {
          signal.addEventListener(
            'abort',
            () => {
              closePort();
              // 取消 = 流结束，走 reject 让 job 的 catch 正常收尾（release + 不落快照）
              finish(reject, abortStreamError('keywords'));
            },
            { once: true }
          );
        }
      }
      port.postMessage({
        apiBase: CFG.apiBase,
        path: '/api/v2/analyze-semantic-keywords',
        body,
      });
    });
  }

  /** hybrid：拆掉某 chunk 的等待线（只动 pending overlay） */
  function clearPendingUnderline(cp0, cp1) {
    paintSpecs = paintSpecs.filter(
      (s) => !(s.kind === 'pending-underline' && s.cp0 === cp0 && s.cp1 === cp1)
    );
    renderUnderlinesOfKind('pending-underline');
  }

  /**
   * 把单个 v2 keyword 高亮 run 写入 paintSpecs，并即时挂上 Highlight（增量上色）。
   * Worker 已完成定位 / uniquify 定档 / REPEAT_DIM 压暗；score 为 (0,1]，直接乘 matchDegree。
   * @param {{offset: [number, number], raw: string, score: number}} t
   * @param {number} chunkCpStart
   * @param {number} matchDegree
   * @returns {number} 实际上色的 token 段数；0 表示没有染色
   */
  function paintTokenRun(t, chunkCpStart, matchDegree) {
    ensureHighlightRegistry();
    if (!keywordRunPaintable(t, chunkCpStart, matchDegree)) return 0;
    const degree = Number.isFinite(matchDegree) ? matchDegree : 0;
    const [a, b] = t.offset;
    const level = scoreToLevel((t.score > 0 ? t.score : 0) * degree);
    const cp0 = chunkCpStart + a;
    const cp1 = chunkCpStart + b;
    paintSpec('token', cp0, cp1, level);
    const h = CSS.highlights.get(HL_TOKEN_PREFIX + level);
    if (!h) throw new Error(`highlight missing: ${HL_TOKEN_PREFIX}${level}`);
    addCpRangeToHighlight(h, cp0, cp1);
    return 1;
  }

  /** 该 keyword run 是否具备可上色性（score 定档后非空） */
  function keywordRunPaintable(t, chunkCpStart, matchDegree) {
    if (!t.offset) return false;
    const degree = Number.isFinite(matchDegree) ? matchDegree : 0;
    const score = (t.score > 0 ? t.score : 0) * degree;
    if (!(score > 0)) return false;
    return scoreToLevel(score) >= 0;
  }

  // ---------- 顺序渲染队列（仅 UI 层）：chunk 内流式，chunk 间按序 -------------
  // 底层 keywords 数据流仍完全并发（池在途 4）；此处只决定「run 何时上色」与
  // 「蓝线何时拆」。同一时刻只渲染队首 chunk，其余 chunk 的 run 先缓冲，轮到刷出；
  // 蓝线在该 chunk 渲染完成（全部 run 上色完毕、轮到它）时拆，与上色时序一致，
  // 避免并发返回顺序导致的「线先消失、色后到」。
  const renderQueue = {
    /** 按序等待/进行中的 chunk：{start, end, result}；result=undefined 未完、true 成功、false 失败 */
    items: [],
    /** 正在上色的 chunk（队首）；null = 队列空 */
    current: null,
    /** start → 该块已缓冲 run（{t, chunkCpStart, degree}）；轮到该块时一次性刷出 */
    buffered: new Map(),

    /** 匹配 chunk 入队并记录区间；队列原为空则立即开始上色 */
    enqueue(start, end) {
      this.items.push({ start, end });
      if (this.current == null) this.advance();
    },

    /**
     * 从队首推进上色：循环处理已完成的块。块的「完成」= 数据到齐（result 非空），
     * 此刻该块全部 run 已拿到，一次刷完即为渲染完成，随即便拆它的蓝线。
     * 数据未完的块则停在队首等 release：先刷已到手部分、设为 current（流式上色，蓝线保留）。
     */
    advance() {
      while (this.items.length) {
        const item = this.items[0];
        const runs = this.buffered.get(item.start) || [];
        if (runs.length) this.buffered.delete(item.start);
        if (item.result == null) {
          // 数据未到齐：刷出已缓冲部分，保持其为 current 流式等待（蓝线暂不拆）
          for (const r of runs) paintTokenRun(r.t, item.start, r.degree);
          this.current = item;
          return;
        }
        // 数据齐全：一次上完该块全部 run（=渲染完成），此刻才拆它的蓝线
        for (const r of runs) paintTokenRun(r.t, item.start, r.degree);
        if (item.result === true) clearPendingUnderline(item.start, item.end);
        this.items.shift();
      }
      this.current = null;
    },

    /** 标记某块数据流结束（成功/失败），并尝试推进 */
    release(start, success) {
      const item = start === this.current?.start
        ? this.current
        : this.items.find((e) => e.start === start);
      if (!item) return;
      item.result = success !== false;
      if (start === this.current?.start) this.advance();
    },

    /**
     * run 上色入队：属于当前块则实时上色，否则缓冲等轮到。
     * 无论走哪条路都返回「是否可上色」，供块内统计染红进度线。
     * @returns {number} 0|1（可上色即 1）
     */
    pushRun(t, chunkCpStart, degree) {
      if (!keywordRunPaintable(t, chunkCpStart, degree)) return 0;
      if (this.current?.start === chunkCpStart) {
        paintTokenRun(t, chunkCpStart, degree);
      } else {
        let runs = this.buffered.get(chunkCpStart);
        if (!runs) {
          runs = [];
          this.buffered.set(chunkCpStart, runs);
        }
        runs.push({ t, chunkCpStart, degree });
      }
      return 1;
    },

    /** 新搜索/重置：清空队列状态 */
    reset() {
      this.items.length = 0;
      this.current = null;
      this.buffered.clear();
    },
  };

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
  /* 与内容同宽，避免 left+right 同时非 auto 时 host 被拉满视口（拖拽测宽也会错） */
  width: max-content;
  max-width: calc(100vw - 32px);
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

    ui$('semantic_find_prev')?.addEventListener('click', () => navigateMatch(-1));
    ui$('semantic_find_next')?.addEventListener('click', () => navigateMatch(1));
    ui$('semantic_find_close')?.addEventListener('click', () => close());
    ui$('semantic_find_status_list')?.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button') : null;
      if (!btn) return;
      const strip = btn.closest('.semantic-find-status');
      const entry = statusEntries.find((x) => x.el === strip);
      if (!entry) return;
      e.stopPropagation();
      if (btn.classList.contains('semantic-find-status-close')) {
        dismissStatusEntry(entry);
        return;
      }
      if (btn.classList.contains('semantic-find-status-feedback')) {
        sendStatusFeedbackForEntry(entry, /** @type {HTMLButtonElement} */ (btn));
        return;
      }
      if (btn.classList.contains('semantic-find-status-continue')) {
        void runSearch({ resume: true });
      }
    });
    ui$('semantic_find_backend_notice_close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      slowBackendNoticeShown = true;
      clearSlowBackendNotice();
    });
    ui$('semantic_find_backend_notice_feedback')?.addEventListener('click', (e) => {
      e.stopPropagation();
      sendFeedback(
        backendNoticeFeedbackStatus(),
        /** @type {HTMLButtonElement | null} */ (e.currentTarget)
      );
    });
    ui$('semantic_find_clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (searching) {
        // 立刻空闲 UI；旧轮靠 abortWanted 退出主循环。立即断开所有在途流
        // （relevance+keywords），background abort → 门面取消 OpenRouter，不继续烧
        abortWanted = true;
        sessionAbortCtrl.abort();
        keywordsPool.abort();
        // 中止跟随滚动：清空队列并取消循环，已入队的 chunk/match 项不再出队（含 stop 后才不会触发 jumpToMatch）
        resetFollowQueue();
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
      // 输入框 Enter：与上次搜索 query 一致 → 上下翻匹配（无匹配则空操作）；
      // 否则开搜并停在首个匹配，之后再 Enter 即在匹配间跳转（对齐 Chrome Find 心智）。
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        hideHistoryDropdown();
        if (queryMatchesCurrentResults()) {
          navigateMatch(e.shiftKey ? -1 : 1);
        } else if (!searching) {
          void runSearch();
        }
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
    wireBarDrag();
  }

  /** 拖非可点区域（边距/分隔线等）移动整块 Find UI；用 right/top（默认右上角），不持久化 */
  function wireBarDrag() {
    const barEl = uiQuery('.semantic-find-bar');
    const host = document.getElementById('il-find-root');
    if (!barEl || !host) return;

    const DRAG_EXEMPT = 'button, input, textarea, select, a, .semantic-search-history-dropdown';
    /** @type {{ pointerId: number, startX: number, startY: number, originRight: number, originTop: number, width: number, height: number } | null} */
    let drag = null;

    barEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!(e.target instanceof Element)) return;
      if (e.target.closest(DRAG_EXEMPT)) return;

      const rect = host.getBoundingClientRect();
      const right = window.innerWidth - rect.right;
      host.style.left = '';
      host.style.right = `${right}px`;
      host.style.top = `${rect.top}px`;

      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originRight: right,
        originTop: rect.top,
        width: rect.width,
        height: rect.height,
      };
      barEl.classList.add('is-dragging');
      barEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    barEl.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      // 右移 → right 减小
      const maxRight = Math.max(0, window.innerWidth - drag.width);
      const maxTop = Math.max(0, window.innerHeight - drag.height);
      const right = Math.min(
        maxRight,
        Math.max(0, drag.originRight - (e.clientX - drag.startX)),
      );
      const top = Math.min(maxTop, Math.max(0, drag.originTop + (e.clientY - drag.startY)));
      host.style.right = `${right}px`;
      host.style.top = `${top}px`;
    });

    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag = null;
      barEl.classList.remove('is-dragging');
      if (barEl.hasPointerCapture(e.pointerId)) barEl.releasePointerCapture(e.pointerId);
    };
    barEl.addEventListener('pointerup', endDrag);
    barEl.addEventListener('pointercancel', endDrag);
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

  /** 页面级 #il-find-root 已被另一份扩展占用（隔离世界互不可见，只能靠 DOM 标记） */
  const OTHER_IL_MSG =
    'Another InfoLens is already on this page. Please refresh the page and try again.';

  async function buildBar() {
    let host = document.getElementById('il-find-root');
    // 已有 host 且不是本扩展标记的（含旧版无标记）→ 报错放弃，不复用、不偷偷重建
    if (host && host.dataset.ilExtensionId !== chrome.runtime.id) {
      throw new Error(OTHER_IL_MSG);
    }
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
    host.dataset.ilExtensionId = chrome.runtime.id;
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

    // 空进度框架只在一个「新搜索请求已发出、本地就绪、等待首个 chunk 回流」的窗口期显示：
    // 仅当正在搜索(searching)且尚无任何 chunk 结果时亮出；否则隐藏（正文为空、或搜索已结束/未开始）。
    const hidden =
      extractedText.length === 0 ||
      (semanticMatchProgress.length === 0 && !searching);
    chart.toggleAttribute('hidden', hidden);
    if (hidden) {
      lines.replaceChildren();
      return;
    }

    const width = Math.max(1, Math.round(chart.clientWidth));
    const height = Math.max(1, Math.round(chart.clientHeight));
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const x0 = 4;
    const x1 = width - 4;
    const y0 = height - 7;
    const y1 = 4;
    const textLength = progressTextLength || extractedCpLength;
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
      // 红 = 过阈值且 keywords 已确认有可上色段；否则灰（等待 / 无词 / 未过阈值）
      const showMatchRed =
        degree >= CFG.matchThreshold && !!chunk.hasKeywords;
      line.classList.toggle('is-gray', !showMatchRed);
      line.classList.toggle('is-selected', selectedProgressChunkStart === chunk.start);
      line.classList.toggle('is-hovered', hoveredProgressChunkStart === chunk.start);
      const lineStart = start;
      const lineEnd = end;
      line.setAttribute('d', `M${lineStart} ${y}H${lineEnd}`);
      label.setAttribute('x', String((start + end) / 2));
      label.setAttribute('y', String(Math.max(y1 + 10, y - 4)));
      label.textContent = `Match: ${Math.round(degree * 100)}%`;
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
    // 再次点击当前 chunk 保持选中状态，不做 toggle。
    revealChunk(chunk);
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
    // 结束/停止时重绘进度图：把「等待首 chunk」的空框架收起（hidden 判据依赖 searching）
    if (!on) renderSemanticMatchProgress();
  }

  /**
   * @param {{ resume?: boolean }} [opts] resume=true：保留已有进度，从下一未分析 chunk 继续
   */
  async function runSearch(opts) {
    if (searching) return;
    const resume = !!opts?.resume;
    const query = /** @type {HTMLInputElement} */ (ui$('semantic_find_input'))?.value?.trim() || '';
    if (!query) {
      return;
    }
    if (resume && !canResumeSearch()) return;

    resetFollowQueue();

    // 必须在任何 await 之前占住 searching + epoch，否则连按会 concurrent 多轮：
    // 旧轮 finally 清掉 searching，新轮仍在跑 → 有报错、像在搜、却没有停止按钮。
    const epoch = ++searchEpoch;
    abortWanted = false;
    // 本轮的流式 cancel 句柄（模块级）：Stop/×/giveUp/close（abortWanted）或本轮收尾时断开 in-flight port →
    // background abort → 门面取消 OpenRouter。新轮重建，避免旧轮已 abort 的信号影响新一轮。
    sessionAbortCtrl = new AbortController();
    // 重开须在 await 前作废旧 keywords，避免 ensureHistory 窗口内旧任务仍落笔；Continue 保留
    if (!resume) keywordsPool.invalidate();
    else keywordsPool.resetAbortSignal(); // Continue 复用池：换新信号，避免沿用上一轮已 abort 的信号
    setSearching(true);
    refreshStatusContinueButtons();

    try {
      await ensureHistory();
      if (epoch !== searchEpoch) return;
      saveHistory(query);

      // 流式逐块展示：每块统一入队（滚动定位），由 RAF 循环按 CHUNK_SEARCH_FOLLOW_STEP_MS 节奏播放；
      // 黑字/等待线/renderQueue/keywords 仍实时处理，遮挡滚动播放的缓冲，不反压。
      /** @type {{ start: number, end: number, text: string }[]} */
      let allChunks;
      let resumeFrom = 0;
      let analyzedCpEnd = 0;

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
        const contentChunks = splitChunks(extractedText, CHUNK_BYTES).filter(chunkHasContent);
        // Continue 只从「已判定完成的块之后」继续（resumeFrom = semanticMatchProgress.length）。
        // 关键词分析约定：已完成的保留；stop 时被中止、尚未染完的那一块 keywords 不补染——
        // 它已进入 semanticMatchProgress，会被这里越过，此处有意跳过（用户取舍：中断小概率，简单优先）。
        resumeFrom = semanticMatchProgress.length;
        if (resumeFrom >= contentChunks.length) return;
        // 续跑重置首匹配跳转：本轮新分析出首个匹配 chunk 时重新跳转高亮
        firstMatchJumped = false;
        // 中断续跑沿用旧窗口；截断后续跑再开一批
        const prevEnd = lastSearchMeta.windowEnd ?? 0;
        const windowEnd =
          resumeFrom < prevEnd ? prevEnd : resumeFrom + MAX_CHUNKS_PER_SEARCH;
        allChunks = contentChunks.slice(0, windowEnd);
        analyzedCpEnd =
          truncatedAnalyzedCpEnd ??
          (resumeFrom > 0 ? semanticMatchProgress[resumeFrom - 1].end : 0);
        lastSearchMeta = {
          query,
          contentChunkCount: contentChunks.length,
          truncated: contentChunks.length > allChunks.length,
          windowEnd: allChunks.length,
        };
        progressTextLength = allChunks.length
          ? utf16ToCp(allChunks[allChunks.length - 1].end)
          : 0;
        // 分母变大：已完成竖线重标定到新窗口（仍全部绘制）
        renderSemanticMatchProgress();
      } else {
        resetSearchSession();

        try {
          refreshExtract();
        } catch (err) {
          console.error('[InfoLens] extract aborted:', err?.message || err);
          if (epoch === searchEpoch) showFindError(err?.message || err, { errorDetail: err?.errorDetail });
          return;
        }
        if (!extractedText.trim()) {
          console.error('[InfoLens] no article text found');
          if (epoch === searchEpoch) showFindError('No article text found');
          return;
        }

        // 全空白 chunk 不送 API；先滤再截断，避免 MAX_CHUNKS_PER_SEARCH 被空白占满
        const contentChunks = splitChunks(extractedText, CHUNK_BYTES).filter(chunkHasContent);
        allChunks = contentChunks.slice(0, MAX_CHUNKS_PER_SEARCH);
        lastSearchMeta = {
          query,
          contentChunkCount: contentChunks.length,
          truncated: contentChunks.length > allChunks.length,
          windowEnd: allChunks.length,
        };
        progressTextLength = allChunks.length
          ? utf16ToCp(allChunks[allChunks.length - 1].end)
          : 0;

        // SYNC：站内 truncated-text — 搜索开始全文置灰，随已分析边界后移恢复原色
        setTruncatedHighlight(0);
      }

      // --- 段1：relevance（V2 批量：≤RELEVANCE_BATCH 组成一请求，渲染按序消费每片）---
      const stillThisSearch = () => epoch === searchEpoch && !abortWanted;
      const RELEVANCE_BATCH = 32; // SYNC: 门面 MULTI_CHUNK_MAX（texts 上限）
      /** @type {Map<number, { resolve: Function, reject: Function }>} 每片 settle 句柄（row 到达即 resolve） */
      const chunkSettle = new Map();
      /** @type {Map<number, Promise<object>>} 每片就绪 promise（consume 用） */
      const perChunkReady = new Map();
      /** @type {Map<number, Promise<object>>} 批起始 idx → 整批 promise（仅错误传播/收尾） */
      const relevanceBatchPromises = new Map();
      const batchStart = (idx) =>
        resumeFrom + Math.floor((idx - resumeFrom) / RELEVANCE_BATCH) * RELEVANCE_BATCH;
      const deferChunk = (idx) => {
        const d = {};
        perChunkReady.set(
          idx,
          new Promise((resolve, reject) => {
            d.resolve = resolve;
            d.reject = reject;
          })
        );
        chunkSettle.set(idx, d);
      };
      const ensureRelevanceBatch = (idx) => {
        const start = batchStart(idx);
        if (relevanceBatchPromises.has(start)) return;
        const end = Math.min(start + RELEVANCE_BATCH, allChunks.length);
        const texts = [];
        for (let k = start; k < end; k++) {
          texts.push(allChunks[k].text);
          deferChunk(k);
        }
        const p = analyzeSemanticV2(query, texts, (n, fullMatchDegree) => {
          const real = start + (n - 1);
          const d = chunkSettle.get(real);
          if (d) {
            chunkSettle.delete(real);
            d.resolve({ full_match_degree: fullMatchDegree });
          }
        }, sessionAbortCtrl.signal);
        p.catch((err) => {
          // 整批失败：reject 所有未就绪片（不静默挂起）；透传 Worker 端 errorDetail，
          // 使反馈落库保留真实失败原因（如 missing count for block [1]）
          console.error('[InfoLens][relevance] batch error:', err?.message, 'detail=', err?.errorDetail);
          for (let k = start; k < end; k++) {
            const d = chunkSettle.get(k);
            if (d) {
              chunkSettle.delete(k);
              const e = new Error(`relevance v2 request failed for chunk ${k}`);
              if (err?.errorDetail) e.errorDetail = String(err.errorDetail);
              d.reject(e);
            }
          }
        });
        relevanceBatchPromises.set(start, p);
      };

      /** 渲染按序取走（该片 row 就绪即返回，不等待整批） */
      const consumeRelevance = (idx) => {
        ensureRelevanceBatch(idx);
        return perChunkReady.get(idx);
      };
      // 预热首批：渲染推进前先发请求，与首块渲染等待并行
      if (stillThisSearch() && resumeFrom < allChunks.length) {
        ensureRelevanceBatch(resumeFrom);
        // 搜索开始即即时定位到本批首个待分析 chunk 起点（通常是正文开头），让用户感知「开始了」；
        // 即时定位，不与逐块跟随互相叠加
        const chunkStartRect = clientRectNearCp(utf16ToCp(allChunks[resumeFrom].start));
        if (chunkStartRect && extractRoot) {
          applyScrollToCp(utf16ToCp(allChunks[resumeFrom].start), chunkStartRect);
        }
      }
      // 本地处理与请求均已发出：此刻起只等对方回流。先亮出空进度图（0 根线）占位，
      // 表明本地已就绪、不报错，剩下的只是等待首个 chunk 结果；随逐片结果到达实时点亮。
      renderSemanticMatchProgress();

      // --- 段2：keywords（渲染匹配后投递；池内消费，不反压段1）---
      const enqueueKeywords = (chunkIndex, chunk, chunkCpStart, degree) => {
        keywordsPool.schedule(async (jobGen, signal) => {
          if (jobGen !== keywordsPool.gen) return;
          // 增量上色计数（逐条 run 到达即累计）
          let painted = 0;
          try {
            // 新扩展走 v2 流式（逐词增量上色）；旧扩展仍打旧 JSON 路径由门面双轨隔离
            await analyzeKeywordsV2(
              query,
              chunk.text,
              (run) => {
                if (jobGen !== keywordsPool.gen) return;
                if (!extractRoot?.isConnected) return;
                painted += renderQueue.pushRun(run, chunkCpStart, degree);
              },
              signal
            );
            if (jobGen !== keywordsPool.gen) return;
            if (!extractRoot?.isConnected) return;
            if (abortWanted) {
              // 被中止的流最终落地：只做收尾 release，不渲染/不落快照，避免残留本轮中途态
              renderQueue.release(chunkCpStart, false);
              return;
            }
            // 有可上色段才把进度线染红（此前保持灰）。↑↓ 仍跟 relevance，不 demote。
            // 蓝线由 renderQueue.advance（该块数据齐全、真正上色完毕）时拆，见顺序渲染队列。
            if (painted > 0) {
              const row = semanticMatchProgress.find((c) => c.start === chunkCpStart);
              if (row) row.hasKeywords = true;
              renderSemanticMatchProgress();
            }
            // 标记数据流成功结束并推进队列（见 renderQueue.release）
            renderQueue.release(chunkCpStart, true);
            snapshotLastResult(query);
          } catch (err) {
            // 失败：pending 留下 + chunk 级 Failed；整轮不中断
            console.error('[InfoLens] keywords', err?.message || err);
            // 收尾清理：无论如何先 release，避免 renderQueue 卡在 current 上（abort/giveUp 也走这里）
            renderQueue.release(chunkCpStart, false);
            if (jobGen !== keywordsPool.gen || epoch !== searchEpoch || abortWanted) return;
            // 失败：保留蓝线（pending），但标记 done 避免队列卡住
            const reason = err?.message != null ? String(err.message).trim() : '';
            const tech = err?.errorDetail != null ? String(err.errorDetail).trim() : '';
            // Failed · Keyword analysis on chunk N · <具体原因>
            const detail = reason
              ? `Keyword analysis on chunk ${chunkIndex} · ${reason}`
              : `Keyword analysis on chunk ${chunkIndex}`;
            showFindError(detail, {
              errorDetail: formatChunkErrorDetail(
                'keywords',
                chunkIndex,
                chunk,
                tech || undefined
              ),
              resumable: false,
            });
            snapshotLastResult(query);
          }
        });
      };

      for (let i = resumeFrom; i < allChunks.length; i++) {
        if (!stillThisSearch()) break;
        const chunk = allChunks[i];
        let res;
        try {
          res = await consumeRelevance(i);
        } catch (err) {
          const tech =
            err?.errorDetail != null ? String(err.errorDetail).trim() : '';
          const wrapped = new Error(
            err?.message != null && String(err.message).trim()
              ? `Relevance on chunk ${i} · ${String(err.message).trim()}`
              : `Relevance on chunk ${i}`
          );
          wrapped.errorDetail = formatChunkErrorDetail(
            'relevance',
            i,
            chunk,
            tech || undefined
          );
          throw wrapped;
        }
        if (!stillThisSearch()) break;

        const degree = res.full_match_degree ?? 0;
        // SYNC: semanticSearchController — matched = degree >= threshold；未匹配块不上色
        const matched = degree >= CFG.matchThreshold;
        const chunkCpStart = utf16ToCp(chunk.start);
        const chunkCpEnd = utf16ToCp(chunk.end);
        analyzedCpEnd = Math.max(analyzedCpEnd, chunkCpEnd);
        semanticMatchProgress.push({
          start: chunkCpStart,
          end: chunkCpEnd,
          matchDegree: degree,
        });
        renderSemanticMatchProgress();
        // 灰字（已分析边界）随数据到达实时推进
        setTruncatedHighlight(analyzedCpEnd);

        // 流式逐块展示：首匹配之前的块逐个入队跟随；遇到首个匹配块则入队一个 reveal 项
        // （自带定位 + 完整展示）并停止入队——之后不再入任何项，视口停留首匹配，后续块不滚动跟随
        if (!firstMatchJumped) {
          if (matched) {
            firstMatchJumped = true;
            enqueueFollow({ cp: chunkCpStart, reveal: true });
          } else {
            enqueueFollow({ cp: chunkCpStart });
          }
        }

        if (matched) {
          matchedChunks.push({
            start: chunkCpStart,
            end: chunkCpEnd,
            matchDegree: degree,
          });
          // 匹配：先画等待线；keywords 异步返回后拆线并上色（不反压段1渲染节奏）
          upsertSpec({ kind: 'pending-underline', cp0: chunkCpStart, cp1: chunkCpEnd });
          renderUnderlinesOfKind('pending-underline');
          // 顺序渲染：匹配 chunk 入队（首块即出队开始上色，红按块顺序推进）
          renderQueue.enqueue(chunkCpStart, chunkCpEnd);
          // keywords 请求立即发出（不进队列）：利用逐块展示的缓冲期掩饰首个匹配的关键词延迟
          enqueueKeywords(i, chunk, chunkCpStart, degree);
        }
        // 每块后快照：close 中途清高亮时仍保留上一版
        snapshotLastResult(query);
      }

      if (epoch !== searchEpoch) return;

      if (extractRoot != null) {
        if (!abortWanted) {
          // 首匹配已在流式阶段立即跳转过；结束仅当全程无匹配时收尾导航态
          if (matchedChunks.length && !firstMatchJumped) jumpToMatch(0);
          else updateNav();
          if (lastSearchMeta?.truncated) {
            // 本轮完成以 keywords 全部落地（含染色）为准，不能提前到 relevance 完成时提示：
            // 提前提示会让用户立刻 Continue，而旧 keywords 仍在池内排队，renderQueue 按块
            // 顺序推进，新匹配块的等待线→红染会被旧块拖住延迟暴露。故提醒等 whenIdle 之后。
            await keywordsPool.whenIdle();
            if (epoch !== searchEpoch || abortWanted) return;
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
      showFindError(err?.message || err, { errorDetail: err?.errorDetail });
      snapshotLastResult(query);
    } finally {
      // 仍处本轮：把本轮的流收尾断掉。epoch 不匹配时（新轮已重建 sessionAbortCtrl），
      // 不得误 abort 新一轮的在途流，只清旧轮的 port（它们已在 reset/keywordsPool.invalidate 时断开）。
      if (epoch === searchEpoch) sessionAbortCtrl.abort();
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
      setExtractedText('');
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
    const allChunks = splitChunks(extractedText, CHUNK_BYTES).filter(chunkHasContent);
    matchedChunks = allChunks.map((chunk) => ({
      start: utf16ToCp(chunk.start),
      end: utf16ToCp(chunk.end),
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

  /** @param {string} [prefillQuery] 右键选区预填；有值则写入输入框且不自动搜 */
  async function open(prefillQuery) {
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
      const prefill =
        typeof prefillQuery === 'string' ? prefillQuery.trim() : '';
      if (prefill && input) {
        input.value = prefill;
        // 走 input 路径：清旧结果、同步 ×；不自动搜
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // 仅同步 UI（× 按钮可见性），不走 'input' 统一清空路径：reopen 要保留上次渲染结果给下面 tryRestoreLastResult 用
        syncClearButton(false);
      }
      input?.focus();
      input?.select();
      try {
        refreshExtract();
        renderSemanticMatchProgress();
        if (!prefill) tryRestoreLastResult(input?.value?.trim() || '');
      } catch (err) {
        console.error('[InfoLens] extract aborted:', err?.message || err);
        throw err;
      }
    } catch (err) {
      console.error('[InfoLens]', err);
      const msg = String(err?.message || err);
      if (msg === OTHER_IL_MSG) alert(msg);
    }
  }

  function close() {
    abortWanted = true;
    // 立即断开在途流（relevance+keywords），background abort → 门面取消 OpenRouter
    sessionAbortCtrl.abort();
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
    resetBarPosition();
    setSearching(false);
  }

  /** 关闭后回到默认右上角；不持久化拖拽位置 */
  function resetBarPosition() {
    const host = document.getElementById('il-find-root');
    if (!host) return;
    host.style.left = '';
    host.style.top = '';
    host.style.right = '';
  }

  /** 拖过后是固定 right/top：缩窗时夹回视口（贴右侧收），避免飞出看不见 */
  function clampBarIntoViewport() {
    const host = document.getElementById('il-find-root');
    // 仅拖拽后写过 inline right/top；默认 CSS right/top 不夹
    if (!host || (!host.style.right && !host.style.top)) return;
    const rect = host.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    const maxRight = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    const nextRight = Math.min(maxRight, Math.max(0, right));
    const nextTop = Math.min(maxTop, Math.max(0, rect.top));
    if (nextRight === right && nextTop === rect.top) return;
    host.style.left = '';
    host.style.right = `${nextRight}px`;
    host.style.top = `${nextTop}px`;
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
    clampBarIntoViewport();
  });
  window.visualViewport?.addEventListener('resize', scheduleReflow);

  window.__IL_SEMANTIC_DEMO__ = { open, close, destroy };
  void open();
})();
