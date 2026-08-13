/**
 * InfoLens semantic find core — shared by webpage + PDF.
 * Document model via DocumentAdapter (`doc`); paint/search/UI live here.
 *
 * 范围 / Enter / 灰区：
 *   Enter = 开火并离开输入；翻匹配只用上下按钮（不绑键：留在输入则预览与结果灰打架）
 *   灰：聚焦未搜 = 预览（全文整篇 / 从当前位置则窗前灰+虚线）；开搜或失焦 = 窗前∪前沿后
 *   Enter 每次开窗只画这一火（同窗已有匹配则只跳转）；搜索优先级见 runSearch
 *   进度图横轴 = 文档 Y；跳转目标 Y @ 焦点线，高亮块顶不高于 CHUNK_START_MAX_Y_RATIO
 *
 * 绘制（性能差一个数量级以上，勿混用）：
 * - 网页：CSS Custom Highlight（只绑 Range；不做 getClientRects、不插 overlay DOM）。
 *   复杂宿主页上整段 Range.getClientRects 可达秒级；Highlight 通常亚毫秒～数毫秒。
 * - PDF：#il-overlay-host 盖层（Range → getClientRects → 绝对定位 div）。canvas 含字形，
 *   不宜用字下 Highlight 红底；几何测量须克制（增量、勿无谓全量）。
 *
 * token：网页 = ::highlight(il-token-*)；PDF = 红下划线（doc.tokenPaintMode）。
 * gray：网页 = ::highlight(il-gray)；PDF = .il-gray-mask（可多段）。根外不置灰。
 *   事实界 analyzedGrayCp + progressOriginCp → grayPrefixEndCp / graySuffixStartCp。
 * underline / pending-underline：网页 = ::highlight 蓝下划线；PDF = overlay 蓝条。
 * pending：fill 前等待染色；keywords 成功（含空 token_attention）后拆掉；失败则留下。
 * keywords：新扩展打 /api/v2/analyze-semantic-keywords；旧路径留给旧扩展。
 *
 * IL_CONFIG.domDebug：点击后只抽正文并下划线，便于目测提取范围（不唤起 Find bar）。
 */
(() => {
  /**
   * @param {ReturnType<typeof IL_createPageDocumentAdapter>} doc
   * @param {{ barTop?: string }} [uiOpts]
   */
  globalThis.IL_createSemanticFind = function IL_createSemanticFind(doc, uiOpts = {}) {
  if (!doc || typeof doc.refresh !== 'function') {
    throw new Error('IL_createSemanticFind: document adapter required');
  }
  if (!globalThis.IL_CONFIG) {
    throw new Error('IL_CONFIG missing — inject config.js before semantic/find.js');
  }
  if (!globalThis.IL_analyzeCache) {
    throw new Error('IL_analyzeCache missing — inject semantic/analyzeCache.js before find.js');
  }
  if (typeof doc.paintOffsetFromCaret !== 'function') {
    throw new Error('paintOffsetFromCaret missing on document adapter');
  }
  const CFG = globalThis.IL_CONFIG;
  const DOM_DEBUG = !!CFG.domDebug;

  // SYNC: client/src/shared/cross/SurprisalColorConfig.ts → SURPRISAL_RED / MAX_ALPHA（色值见 content.css）
  /** token 背景量化档数（il-token-0..15） */
  const TOKEN_LEVELS = 16;
  const HL_TOKEN_PREFIX = 'il-token-';
  const HL_GRAY = 'il-gray';
  const HL_UNDERLINE = 'il-underline';
  const HL_PENDING_UNDERLINE = 'il-pending-underline';
  // 扩展：蓝线只有一段可见时长（无站内 hold→fade 两段；网页 Highlight / PDF overlay 一致）
  const CHUNK_HIGHLIGHT_HOLD_MS = 1000;
  /** 视口焦点线（读位置）：跳转先把目标 Y 对到此线；↑↓ / 开搜收口同线。 */
  const VIEWPORT_FOCUS_Y_RATIO = 0.5;
  /** 高亮块顶在视口中的最高位置（不高于此；大块阅读保底）。 */
  const CHUNK_START_MAX_Y_RATIO = 0.2;
  /** 进度图水平跨度下限（块线 / 热区 / 视口带；极短段略放大）。 */
  const PROGRESS_MIN_WIDTH_PX = 2;
  // SYNC: client/src/shared/core/constants.ts → SEMANTIC_CHUNK_BYTES；算法见 splitTextToChunks.js
  // 已知问题：与后端 SEMANTIC_RUNTIME_CONFIGS 的 max_token_length（300~1000 token，按平台）无联动。
  // 数字/标点/代码等 token 密度高的内容，800 字节可能超出后端 token 限，被静默截断（仅日志提示），
  // 导致该 chunk 的相关度判断只基于截断后的前缀 —— 后果是漏检，非误报。无法靠调大固定 token 数根治。
  const CHUNK_BYTES = 800;
  // 一次请求的 texts 上限。SYNC: 门面 MULTI_CHUNK_MAX
  const MAX_CHUNKS_PER_SEARCH = 32;
  // 无匹配时自动续批上限（含 Enter/Continue 的第一批）。以后可做成 IL_CONFIG。
  const MAX_AUTO_CONTINUE_BATCHES = 8;
  // 流空闲兜底：门面端挂起（既不回流也不结束）时避免 promise 永久挂起 → 搜索卡死。
  // 以「空闲」判超时：每次收到流数据 row 都重置计时器（有进展不算超时）；
  // 只有连续 idle 超过此值（含连接建立后首行迟迟不来）才判死：超过 20s 无新数据即放弃。
  const STREAM_IDLE_MS = 20000;

  /** @type {{ start: number, end: number, matchDegree: number }[]} */
  let matchedChunks = [];
  /**
   * 进度图：全量已分析块。
   * hasKeywords=true 才画红（keywords 已回且有可上色段）；相关等待中 / 无词 / 未过阈值均为灰，高度仍跟 matchDegree。
   * @type {{ start: number, end: number, matchDegree: number, hasKeywords?: boolean }[]}
   */
  let semanticMatchProgress = [];
  /** 搜索起点（码点）：窗口首块起点（全文也是第一内容块，不必是 0）；只驱动灰前缀，不进进度图横轴 */
  let progressOriginCp = 0;
  /** 块在滚动内容中的 Y（布局/提取变化时清空；纯滚动可复用） */
  let progressChunkContentY = new Map();
  /** 当前正文的有内容切块；text 一变即失效 */
  let contentChunksCache = null;
  /** @type {{ tone: string, label: string, detail: string, error_detail?: string, resumable?: boolean, feedbackSent: boolean, el: HTMLElement }[]} */
  let statusEntries = [];
  /** @type {{ query: string, contentChunkCount: number, truncated: boolean, windowStart: number } | null} */
  let lastSearchMeta = null;
  /** true = 从视口焦点线附近最近块边界起搜；false = 全文从首块 */
  let searchFromCurrent = false;
  /** 焦点线最近一次命中的码点；未命中时沿用，避免预览闪成整篇全亮 */
  let lastFocusPaintCp = null;
  /** 本轮搜索是否已处理过 HF 慢速提示（展示或叉掉后均不再弹出） */
  let slowBackendNoticeShown = false;
  /** 进度图跳转高亮：覆盖当前跳转 Y 的块；hold 结束或未跳转为空 */
  let selectedProgressChunkStarts = new Set();
  let hoveredProgressChunkStart = null;
  /** 本轮 runSearch 是否已因首个匹配跳转过（流式首匹配立即跳，结束后避免重复滚动） */
  let firstMatchJumped = false;
  let matchIndex = -1;
  /**
   * 逻辑区间（去重键）；与 DOM 节点分离。
   * token：CSS Highlight 或红下划线（PDF）；underline / pending-underline：网页 Highlight / PDF overlay。
   * @type {{ kind: 'token' | 'underline' | 'pending-underline', cp0: number, cp1: number, level?: number }[]}
   */
  let paintSpecs = [];
  /** @type {HTMLElement[]} token / underline / pending-underline DOM */
  let overlayEls = [];
  /** 搜索进度灰界（事实）：已分析到的码点；null = 本轮无进度灰 */
  let analyzedGrayCp = null;
  /** 画出的灰前缀终点（不含）：[0, grayPrefixEndCp)；null/0 = 无前缀灰 */
  let grayPrefixEndCp = null;
  /** 画出的灰后缀起点：[graySuffixStartCp, end)；null = 无后缀灰 */
  let graySuffixStartCp = null;
  /** 网页灰后缀已加入 Highlight 的 Range；suffix 只前移时收缩，不重建剩余全文 */
  let graySuffixRanges = [];
  /** @type {number | null} */
  let graySuffixPaintedAt = null;
  /** @type {number | null} */
  let grayPrefixPaintedAt = null;
  /**
   * 长度 1 的搜索结果缓存（含 Stop 半成品）。close 清高亮但保留；
   * open 时若输入与正文未变则还原，避免重复请求。
   * @type {null | {
   *   query: string,
   *   text: string,
   *   paintSpecs: typeof paintSpecs,
   *   matchedChunks: typeof matchedChunks,
   *   semanticMatchProgress: typeof semanticMatchProgress,
   *   progressOriginCp: number,
   *   matchIndex: number,
   *   analyzedGrayCp: number | null,
   *   selectedProgressChunkStarts: number[],
   *   statuses: Array<{ tone: string, label: string, detail: string, error_detail?: string, resumable?: boolean }>,
   *   searchMeta: typeof lastSearchMeta,
   * }}
  */
  let lastResult = null;
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
  let underlineHoldTimer = 0;
  /** 每次跳转或清理递增，使已排队的滚动回调失效。 */
  let revealGeneration = 0;

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
        // 入队时捕获 signal：abort() 会立刻 resetAbort 换新控制器；若 exec 时再读
        // abortCtrl.signal，已出队的微任务会拿到未中止的新信号，Stop 后仍继续打上游。
        const signal = abortCtrl.signal;
        queue.push({
          exec: async () => {
            try {
              await job(g, signal);
            } catch (err) {
              if (isAbortErr(err)) return;
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
  // relevance：本窗一次（缓存前缀本地回放，send 仅未缓存后缀 ≤32）；keywords 自有在途上限。
  const MAX_KEYWORDS_IN_FLIGHT = 4; // keywords 在途（池并发）
  /** 与 searchEpoch 分离：Stop/Continue 不该作废已匹配块的 keywords */
  const keywordsPool = createPool(MAX_KEYWORDS_IN_FLIGHT);

  // ---------- extract（经 DocumentAdapter） ----------

  function refreshExtract() {
    clearOverlays();
    const info = doc.refresh();
    matchedChunks = [];
    semanticMatchProgress = [];
    selectedProgressChunkStarts = new Set();
    matchIndex = -1;
    progressChunkContentY = new Map();
    lastFocusPaintCp = null;
    return { root: info.root, length: info.length };
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

  /** 正文不变则复用切块（滚动预览热路径） */
  function splitContentChunks() {
    const text = doc.getText();
    if (contentChunksCache && contentChunksCache.text === text) return contentChunksCache.chunks;
    if (contentChunksCache) progressChunkContentY = new Map();
    contentChunksCache = {
      text,
      chunks: splitChunks(text, CHUNK_BYTES).filter(chunkHasContent),
    };
    return contentChunksCache.chunks;
  }

  // ---------- paint：token / gray / underline（网页 Highlight；PDF overlay） ----------

  /** PDF：canvas 含字形，用红下划线 overlay；网页：CSS Highlight（无几何测量） */
  function usesTokenOverlay() {
    return doc.tokenPaintMode?.() === 'token-underline';
  }

  /**
   * 是否用 overlay 画蓝线。与 usesTokenOverlay 同判据：PDF 是，网页否。
   * 网页必须走 ::highlight——整 chunk 的 getClientRects 在重 DOM 上可至秒级；Highlight 只绑 Range。
   */
  function usesUnderlineOverlay() {
    return usesTokenOverlay();
  }

  /** score∈(0,1] → 0..TOKEN_LEVELS-1；≤0 不画 */
  function scoreToLevel(score01) {
    if (!Number.isFinite(score01) || !(score01 > 0)) return -1;
    const t = Math.max(0, Math.min(1, score01));
    return Math.min(TOKEN_LEVELS - 1, Math.floor(t * TOKEN_LEVELS));
  }

  function requireHighlightApi() {
    if (!CSS.highlights || typeof Highlight !== 'function') {
      throw new Error('CSS Custom Highlight API missing');
    }
  }

  /** 注册 il-token-0..15 / il-gray / 蓝线；已存在则复用（PDF token 走下划线时仍注册 gray） */
  function ensureHighlightRegistry() {
    requireHighlightApi();
    if (!usesTokenOverlay()) {
      for (let i = 0; i < TOKEN_LEVELS; i++) {
        const name = HL_TOKEN_PREFIX + i;
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
      if (!CSS.highlights.has(HL_PENDING_UNDERLINE)) {
        const h = new Highlight();
        h.priority = TOKEN_LEVELS + 3;
        CSS.highlights.set(HL_PENDING_UNDERLINE, h);
      }
    }
    if (!CSS.highlights.has(HL_GRAY)) {
      const h = new Highlight();
      h.priority = TOKEN_LEVELS + 1;
      CSS.highlights.set(HL_GRAY, h);
    }
  }

  function clearTokenOverlays() {
    overlayEls = overlayEls.filter((el) => {
      if (el.dataset.ilTokenLevel == null) return true;
      el.remove();
      return false;
    });
  }

  function clearTokenHighlights() {
    clearTokenOverlays();
    if (!CSS.highlights) return;
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      CSS.highlights.get(HL_TOKEN_PREFIX + i)?.clear();
    }
  }

  function clearAllCustomHighlights() {
    clearTokenHighlights();
    CSS.highlights?.get(HL_GRAY)?.clear();
    CSS.highlights?.get(HL_UNDERLINE)?.clear();
    CSS.highlights?.get(HL_PENDING_UNDERLINE)?.clear();
  }

  /** 把 cp 区间加到指定 Highlight（按块切开，跳过纯空白） */
  function addCpRangeToHighlight(highlight, cp0, cp1) {
    for (const range of doc.rangesFromOffsets(cp0, cp1)) {
      if (!/\S/.test(range.toString())) continue;
      highlight.add(range);
    }
  }

  /** PDF token 红下划线：与蓝导航线同定位（clientRectToMountPos） */
  function appendTokenUnderline(rect, level) {
    if (!doc.getPaintMount()) throw new Error('paint mount missing');
    const el = document.createElement('div');
    el.className = 'il-token-underline';
    el.dataset.ilTokenLevel = String(level);
    const { x, y } = doc.clientRectToMountPos(rect);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${rect.width}px`;
    doc.getPaintMount().appendChild(el);
    overlayEls.push(el);
  }

  function paintTokenOverlaySpec(spec) {
    const level = spec.level;
    if (level == null || level < 0 || level >= TOKEN_LEVELS) return;
    for (const range of doc.rangesFromOffsets(spec.cp0, spec.cp1)) {
      if (!/\S/.test(range.toString())) continue;
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        appendTokenUnderline(r, level);
      }
    }
  }

  function renderTokenHighlights() {
    if (usesTokenOverlay()) {
      if (!doc.isConnected()) {
        clearTokenOverlays();
        return;
      }
      doc.ensurePaintMount();
      clearTokenOverlays();
      for (const s of paintSpecs) {
        if (s.kind !== 'token') continue;
        paintTokenOverlaySpec(s);
      }
      return;
    }
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

  function hasGrayPaint() {
    return (grayPrefixEndCp != null && grayPrefixEndCp > 0) || graySuffixStartCp != null;
  }

  /** @returns {[number, number][]} 半开区间 [cp0, cp1) */
  function grayPaintRanges() {
    if (!doc.getText() || !doc.isConnected()) return [];
    const fullCp = doc.getPaintLength();
    /** @type {[number, number][]} */
    const out = [];
    if (grayPrefixEndCp != null && grayPrefixEndCp > 0) {
      const end = Math.min(grayPrefixEndCp, fullCp);
      if (end > 0) out.push([0, end]);
    }
    if (graySuffixStartCp != null) {
      const start = Math.max(0, Math.min(graySuffixStartCp, fullCp));
      if (start < fullCp) out.push([start, fullCp]);
    }
    return out;
  }

  function resetGraySuffixRanges() {
    graySuffixRanges = [];
    graySuffixPaintedAt = null;
    grayPrefixPaintedAt = null;
  }

  /** 灰后缀起点前移：丢掉已分析段上的 Range，其余 setStart。失败则 false，由调用方全量重建。 */
  function tryShrinkGraySuffix(h, toCp) {
    const full = doc.getPaintLength();
    if (toCp >= full) {
      for (const r of graySuffixRanges) h.delete(r);
      graySuffixRanges = [];
      return true;
    }
    if (!graySuffixRanges.length) return false;
    const probe = doc.rangesFromOffsets(toCp, Math.min(full, toCp + 128));
    if (!probe.length) return false;
    const node = probe[0].startContainer;
    const offset = probe[0].startOffset;
    const keep = [];
    let i = 0;
    for (; i < graySuffixRanges.length; i++) {
      const r = graySuffixRanges[i];
      let cmp;
      try {
        cmp = r.comparePoint(node, offset);
      } catch {
        return false;
      }
      if (cmp > 0) {
        h.delete(r);
        continue;
      }
      if (cmp === 0) {
        try {
          r.setStart(node, offset);
        } catch {
          return false;
        }
        if (r.collapsed) h.delete(r);
        else keep.push(r);
        i += 1;
        break;
      }
      break;
    }
    for (; i < graySuffixRanges.length; i++) keep.push(graySuffixRanges[i]);
    graySuffixRanges = keep;
    return true;
  }

  function applyGrayHighlight() {
    if (usesTokenOverlay()) {
      // PDF：全文 Highlight 每块重建上万 Range（实测占 chunk UI ~90%）；改为遮罩 O(段数)
      CSS.highlights?.get(HL_GRAY)?.clear();
      resetGraySuffixRanges();
      applyGrayMaskPdf();
      return;
    }
    ensureHighlightRegistry();
    const h = CSS.highlights.get(HL_GRAY);
    if (!h) throw new Error('highlight missing: il-gray');
    if (
      grayPrefixPaintedAt === grayPrefixEndCp &&
      graySuffixPaintedAt != null &&
      graySuffixStartCp != null &&
      graySuffixStartCp > graySuffixPaintedAt &&
      tryShrinkGraySuffix(h, graySuffixStartCp)
    ) {
      graySuffixPaintedAt = graySuffixStartCp;
      return;
    }
    h.clear();
    resetGraySuffixRanges();
    const fullCp = doc.getPaintLength();
    for (const [cp0, cp1] of grayPaintRanges()) {
      const added = [];
      for (const range of doc.rangesFromOffsets(cp0, cp1)) {
        if (!/\S/.test(range.toString())) continue;
        h.add(range);
        added.push(range);
      }
      if (graySuffixStartCp != null && cp1 === fullCp) {
        graySuffixRanges = added;
        graySuffixPaintedAt = graySuffixStartCp;
      }
    }
    grayPrefixPaintedAt = grayPrefixEndCp;
  }

  /** PDF 未搜区：每段一块绝对定位半透明遮罩（前缀 + 后缀） */
  function applyGrayMaskPdf() {
    if (!doc.isConnected()) {
      removeGrayMaskPdf();
      return;
    }
    doc.ensurePaintMount();
    const mount = doc.getPaintMount();
    const root = doc.getRoot();
    if (!mount || !root) {
      removeGrayMaskPdf();
      return;
    }
    const ranges = grayPaintRanges();
    removeGrayMaskPdf();
    if (ranges.length === 0) return;

    const mountRect = mount.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const fullCp = doc.getPaintLength();
    for (const [cp0, cp1] of ranges) {
      const startRect = clientRectNearCp(cp0);
      const top = startRect ? startRect.top - mountRect.top : 0;
      let bottom;
      if (cp1 >= fullCp) {
        bottom = rootRect.bottom - mountRect.top;
      } else {
        const endRect = clientRectNearCp(cp1);
        bottom = endRect ? endRect.top - mountRect.top : rootRect.bottom - mountRect.top;
      }
      const height = Math.max(0, bottom - top);
      if (height < 1) continue;
      const mask = document.createElement('div');
      mask.className = 'il-gray-mask';
      mask.style.top = `${top}px`;
      mask.style.height = `${height}px`;
      mount.insertBefore(mask, mount.firstChild);
    }
  }

  function removeGrayMaskPdf() {
    const mount = doc.getPaintMount();
    if (!mount) return;
    mount.querySelectorAll('.il-gray-mask, #il-gray-mask').forEach((el) => el.remove());
  }

  /** 清掉范围预览分割线 */
  function clearScopeDivider() {
    document.getElementById('il-scope-divider')?.remove();
    document.getElementById('il-scope-divider-host')?.remove();
  }

  /**
   * 范围预览分割线：仅「从当前位置」预览；atCp = 待搜起点。
   * JS 只写 top（开搜首行顶之上半行高）；横向由 CSS 300vw 过冲，不测左右。
   * @param {number} atCp
   */
  function applyScopeDivider(atCp) {
    if (atCp == null || !doc.isConnected()) {
      clearScopeDivider();
      return;
    }
    const fullCp = doc.getPaintLength();
    const cp0 = Math.max(0, Math.min(atCp, fullCp));
    if (cp0 >= fullCp || !doc.getText()) {
      clearScopeDivider();
      return;
    }
    const startRect = clientRectNearCp(cp0);
    if (!startRect) {
      clearScopeDivider();
      return;
    }
    const y = startRect.top - startRect.height / 2;

    const scrollRoot = doc.findScrollRoot();

    /** @type {HTMLElement | null} */
    let parent;
    if (isWindowScrollRoot(scrollRoot)) {
      parent = document.getElementById('il-scope-divider-host');
      if (!parent) {
        parent = document.createElement('div');
        parent.id = 'il-scope-divider-host';
        document.body.appendChild(parent);
      }
    } else {
      document.getElementById('il-scope-divider-host')?.remove();
      doc.ensurePaintMount();
      parent = doc.getPaintMount();
    }
    if (!parent) {
      clearScopeDivider();
      return;
    }

    let el = document.getElementById('il-scope-divider');
    if (!el) {
      el = document.createElement('div');
      el.id = 'il-scope-divider';
    }
    if (el.parentElement !== parent) parent.appendChild(el);

    el.style.top = `${y - parent.getBoundingClientRect().top}px`;
  }

  /** 取消蓝线 hold 计时（换 chunk / 清高亮时） */
  function cancelUnderlineHold() {
    if (underlineHoldTimer) {
      clearTimeout(underlineHoldTimer);
      underlineHoldTimer = 0;
    }
  }

  /**
   * @param {{ releaseDoc?: boolean }} [options] releaseDoc=false：保留 extract（输入中清结果后仍要示意待搜范围）
   */
  function clearOverlays({ releaseDoc = true } = {}) {
    revealGeneration += 1;
    cancelUnderlineHold();
    analyzedGrayCp = null;
    grayPrefixEndCp = null;
    graySuffixStartCp = null;
    graySuffixRanges = [];
    graySuffixPaintedAt = null;
    grayPrefixPaintedAt = null;
    CSS.highlights?.get(HL_GRAY)?.clear();
    removeGrayMaskPdf();
    clearScopeDivider();
    unbindViewportFollowScrollTarget();
    clearTokenHighlights();
    // 网页蓝线走 CSS Highlight，不在 overlayEls / token 清理里
    CSS.highlights?.get(HL_UNDERLINE)?.clear();
    CSS.highlights?.get(HL_PENDING_UNDERLINE)?.clear();
    clearOverlayEls();
    paintSpecs = [];
    if (releaseDoc) doc.release();
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
   * 有未分析 chunk 时可续跑：Failed / Stopped 半截，或窗口截断后的下一批。
   * 需已有进度（n>0）；首块即失败无匹配时用 Enter 重开即可，不必 Continue。
   */
  function canResumeSearch() {
    const query =
      /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.value?.trim() || '';
    if (!query || !lastSearchMeta || lastSearchMeta.query !== query) return false;
    if (!doc.isConnected()) return false;
    const n = semanticMatchProgress.length;
    if (n <= 0) return false;
    const windowStart = lastSearchMeta.windowStart ?? 0;
    return windowStart + n < (lastSearchMeta.contentChunkCount ?? 0);
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
   * @param {{ clearCache?: boolean, releaseDoc?: boolean }} [options]
   *   clearCache=true 时连 lastResult 一并丢弃（改 query / giveUp）
   *   releaseDoc=false：保留 extract（仅输入中清结果后立刻重画范围预览）
   */
  function resetSearchSession({ clearCache = false, releaseDoc = true } = {}) {
    keywordsPool.invalidate();
    renderQueue.reset();
    clearOverlays({ releaseDoc });
    clearFindStatus();
    slowBackendNoticeShown = false;
    clearSlowBackendNotice();
    matchedChunks = [];
    semanticMatchProgress = [];
    progressOriginCp = 0;
    lastSearchMeta = null;
    selectedProgressChunkStarts = new Set();
    hoveredProgressChunkStart = null;
    firstMatchJumped = false;
    matchIndex = -1;
    if (clearCache) lastResult = null;
    updateNav();
    renderSemanticMatchProgress();
    syncScopeVisual();
  }

  function isFindInputFocused() {
    const input = /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'));
    return !!(input && uiShadow?.activeElement === input);
  }

  /** 灰区/虚线唯一派生：聚焦未搜 → 预览；开搜中或失焦 → 未搜区灰。 */
  function syncScopeVisual() {
    /** @type {number | null} */
    let nextPrefix = null;
    /** @type {number | null} */
    let nextSuffix = null;
    /** @type {number | null} */
    let dividerCp = null;
    const focused = isFindInputFocused();
    const ready = doc.isConnected() && !!doc.getText().trim();

    if (searching) {
      if (progressOriginCp > 0) nextPrefix = progressOriginCp;
      nextSuffix = analyzedGrayCp;
    } else if (focused && ready && searchFromCurrent) {
      const scopeStart = scopeStartCpFromViewport();
      if (scopeStart > 0) nextPrefix = scopeStart;
      if (scopeStart > 0 && scopeStart < doc.getPaintLength()) dividerCp = scopeStart;
    } else if (focused && ready) {
      nextSuffix = 0;
    } else if (analyzedGrayCp != null) {
      if (progressOriginCp > 0) nextPrefix = progressOriginCp;
      nextSuffix = analyzedGrayCp;
    }

    grayPrefixEndCp = nextPrefix;
    graySuffixStartCp = nextSuffix;
    applyGrayHighlight();
    if (dividerCp != null) applyScopeDivider(dividerCp);
    else clearScopeDivider();

    updateViewportFollowScrollBinding();
  }

  /** 视口某比例处的 clientY（window 或内部 scrollRoot） */
  function isWindowScrollRoot(scrollRoot) {
    return (
      scrollRoot === document.scrollingElement ||
      scrollRoot === document.documentElement ||
      scrollRoot === document.body
    );
  }

  function viewportYAtRatio(ratio) {
    const scrollRoot = doc.findScrollRoot();
    if (isWindowScrollRoot(scrollRoot)) return window.innerHeight * ratio;
    const panel = /** @type {HTMLElement} */ (scrollRoot);
    const panelRect = panel.getBoundingClientRect();
    return panelRect.top + panel.clientHeight * ratio;
  }

  /** 视口焦点线 Y（VIEWPORT_FOCUS_Y_RATIO） */
  function viewportFocusY() {
    return viewportYAtRatio(VIEWPORT_FOCUS_Y_RATIO);
  }

  /** 焦点线与提取根相交段的中点 X（viewport client） */
  function focusHitX() {
    const root = doc.getRoot();
    if (!root) return window.innerWidth / 2;
    const r = root.getBoundingClientRect();
    const scrollRoot = doc.findScrollRoot();
    let left = r.left;
    let right = r.right;
    if (isWindowScrollRoot(scrollRoot)) {
      left = Math.max(left, 0);
      right = Math.min(right, window.innerWidth);
    } else {
      const panel = /** @type {HTMLElement} */ (scrollRoot).getBoundingClientRect();
      left = Math.max(left, panel.left);
      right = Math.min(right, panel.right);
    }
    if (right < left) return (r.left + r.right) / 2;
    return (left + right) / 2;
  }

  function caretAt(x, y) {
    if (typeof document.caretPositionFromPoint === 'function') {
      const p = document.caretPositionFromPoint(x, y);
      if (p?.offsetNode) return { node: p.offsetNode, offset: p.offset };
    }
    if (typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(x, y);
      if (r?.startContainer) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }

  /** 焦点线上的 paint 码点；未命中则沿用上次，避免整篇闪亮 */
  function paintOffsetAtFocusLine() {
    const caret = caretAt(focusHitX(), viewportFocusY());
    const cp = caret && doc.paintOffsetFromCaret(caret.node, caret.offset);
    if (cp != null) return (lastFocusPaintCp = cp);
    return lastFocusPaintCp;
  }

  function contentChunkToPaint(c) {
    return { start: doc.toPaintOffset(c.start), end: doc.toPaintOffset(c.end) };
  }

  /** 最后一个 start ≤ cp 的块下标；没有则 -1。块按文档序。 */
  function lastChunkIndexAtOrBefore(chunks, cp, toPaint = (c) => c) {
    let lo = 0;
    let hi = chunks.length - 1;
    let landed = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (toPaint(chunks[mid]).start <= cp) {
        landed = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return landed;
  }

  /**
   * 开搜窗口起点：焦点线命中处附近最近块边界对应的 contentChunks 下标（0..length）。
   * 候选为所落块头 vs 下一块头；末块后 → length。
   */
  function scopeWindowStartFromViewport(contentChunks) {
    if (contentChunks.length === 0) return 0;
    const cp = paintOffsetAtFocusLine();
    if (cp == null) return 0;
    const landed = lastChunkIndexAtOrBefore(contentChunks, cp, contentChunkToPaint);
    if (landed < 0) return 0;
    const a = contentChunkToPaint(contentChunks[landed]);
    if (landed === contentChunks.length - 1) {
      return cp >= a.end ? contentChunks.length : landed;
    }
    const b = contentChunkToPaint(contentChunks[landed + 1]);
    return Math.abs(a.start - cp) <= Math.abs(b.start - cp) ? landed : landed + 1;
  }

  /** 当前视口开搜收口（码点）；无块或已过文末时为全文长（待搜区空，整篇前缀灰） */
  function scopeStartCpFromViewport() {
    const contentChunks = splitContentChunks();
    if (contentChunks.length === 0) return 0;
    const i = scopeWindowStartFromViewport(contentChunks);
    if (i >= contentChunks.length) return doc.getPaintLength();
    return doc.toPaintOffset(contentChunks[i].start);
  }

  /**
   * ↑↓ 锚点：焦点线相对已分析块的位置。
   * @returns {null | 'before' | 'after' | number} null=无进度；number=区内块 start
   */
  function progressAnchorFromViewport() {
    const n = semanticMatchProgress.length;
    if (n === 0) return null;
    const cp = paintOffsetAtFocusLine();
    if (cp == null) return 'before';
    const landed = lastChunkIndexAtOrBefore(semanticMatchProgress, cp);
    if (landed < 0) return 'before';
    if (landed === n - 1 && cp >= semanticMatchProgress[landed].end) return 'after';
    return semanticMatchProgress[landed].start;
  }

  /**
   * clientY → 滚动内容 Y（与 scrollTop 同一套坐标，不随滚动变）。
   * @param {number} clientY
   * @param {Element | null} [scrollRoot]
   */
  function contentYFromClientY(clientY, scrollRoot = doc.findScrollRoot()) {
    if (!scrollRoot || isWindowScrollRoot(scrollRoot)) return window.scrollY + clientY;
    const panel = /** @type {HTMLElement} */ (scrollRoot);
    return clientY - panel.getBoundingClientRect().top + panel.scrollTop;
  }

  /** 视口顶/底在滚动内容中的 Y */
  function scrollViewportContentY(scrollRoot = doc.findScrollRoot()) {
    if (!scrollRoot || isWindowScrollRoot(scrollRoot)) {
      return { top: window.scrollY, bottom: window.scrollY + window.innerHeight };
    }
    const panel = /** @type {HTMLElement} */ (scrollRoot);
    return { top: panel.scrollTop, bottom: panel.scrollTop + panel.clientHeight };
  }

  /**
   * 进度图横轴域：提取根在滚动内容里的 Y 跨度。
   * @returns {null | { y0: number, y1: number, span: number, scrollRoot: Element }}
   */
  function progressAxisYRange() {
    const root = doc.getRoot();
    if (!root) return null;
    const scrollRoot = doc.findScrollRoot();
    const rect = root.getBoundingClientRect();
    const y0 = contentYFromClientY(rect.top, scrollRoot);
    const y1 = contentYFromClientY(rect.bottom, scrollRoot);
    if (!(y1 > y0)) return null;
    return { y0, y1, span: y1 - y0, scrollRoot };
  }

  function progressXFromContentY(y, x0, x1, axis) {
    return x0 + ((x1 - x0) * (y - axis.y0)) / axis.span;
  }

  function progressContentYFromX(x, x0, x1, axis) {
    if (!(x1 > x0)) return axis.y0;
    const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
    return axis.y0 + t * axis.span;
  }

  /** 进度图点击的 clientX → 文档 Y（夹在横轴域内）。 */
  function progressContentYFromClientX(clientX) {
    const chart = ui$('semantic_match_progress');
    const axis = progressAxisYRange();
    if (!(chart instanceof SVGSVGElement) || !axis) return null;
    const ctm = chart.getScreenCTM();
    if (!ctm) return null;
    const x = new DOMPoint(clientX, 0).matrixTransform(ctm.inverse()).x;
    const width = Math.max(1, Math.round(chart.clientWidth));
    return progressContentYFromX(x, 4, width - 4, axis);
  }

  /** 覆盖该文档 Y 的已分析块（重叠则全部返回）。 */
  function chunksCoveringContentY(contentY, scrollRoot) {
    const hits = [];
    for (const chunk of semanticMatchProgress) {
      const cy = measureChunkContentY(chunk, scrollRoot);
      if (cy && cy.y0 <= contentY && contentY <= cy.y1) hits.push(chunk);
    }
    return hits;
  }

  /**
   * 块在滚动内容中的 Y（起止）；布局未变则走缓存。
   * @param {{ start: number, end: number }} chunk paint 码点
   * @param {Element | null} scrollRoot
   * @returns {null | { y0: number, y1: number }}
   */
  function measureChunkContentY(chunk, scrollRoot) {
    const hit = progressChunkContentY.get(chunk.start);
    if (hit) return hit;
    const startRect = clientRectNearCp(chunk.start);
    const endRect = clientRectNearCp(Math.max(chunk.start, chunk.end - 1));
    if (!startRect && !endRect) return null;
    const top = startRect || endRect;
    const bot = endRect || startRect;
    let y0 = contentYFromClientY(top.top, scrollRoot);
    let y1 = contentYFromClientY(bot.bottom, scrollRoot);
    if (y1 < y0) {
      const t = y0;
      y0 = y1;
      y1 = t;
    }
    const row = { y0, y1 };
    progressChunkContentY.set(chunk.start, row);
    return row;
  }

  /** 视口顶/底 → 进度图浅灰底（文档 Y 交集）；不相交则隐藏。只改 rect，不重画竖线。 */
  function applyProgressViewportBand() {
    const band = ui$('semantic_match_progress_viewport');
    const chart = ui$('semantic_match_progress');
    if (!(band instanceof SVGRectElement) || !(chart instanceof SVGSVGElement)) return;
    if (chart.hasAttribute('hidden')) {
      band.setAttribute('hidden', '');
      return;
    }
    const axis = progressAxisYRange();
    if (!axis) {
      band.setAttribute('hidden', '');
      return;
    }
    const view = scrollViewportContentY(axis.scrollRoot);
    const startY = Math.max(axis.y0, view.top);
    const endY = Math.min(axis.y1, view.bottom);
    if (!(startY < endY)) {
      band.setAttribute('hidden', '');
      return;
    }
    const width = Math.max(1, Math.round(chart.clientWidth));
    const height = Math.max(1, Math.round(chart.clientHeight));
    const x0 = 4;
    const x1 = width - 4;
    const xStart = progressXFromContentY(startY, x0, x1, axis);
    const xEnd = progressXFromContentY(endY, x0, x1, axis);
    band.removeAttribute('hidden');
    band.setAttribute('x', String(xStart));
    band.setAttribute('y', '0');
    band.setAttribute('width', String(Math.max(PROGRESS_MIN_WIDTH_PX, xEnd - xStart)));
    band.setAttribute('height', String(height));
  }

  /** 只改进度图 is-selected，不触发布局重算 */
  function applyProgressSelectedClass() {
    const lines = ui$('semantic_match_progress_lines');
    if (!(lines instanceof SVGGElement)) return;
    for (const el of lines.children) {
      if (!(el instanceof SVGGElement) || el.dataset.progressStart == null) continue;
      const start = Number(el.dataset.progressStart);
      el.querySelector('.semantic-match-progress-line')?.classList.toggle(
        'is-selected',
        selectedProgressChunkStarts.has(start)
      );
    }
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
    // 全文重建后旧偏移全作废：清 UI 快照。请求缓存按文本哈希，正文变了自然 miss，不必清。
    resetSearchSession({ clearCache: true });
    progressChunkContentY = new Map();
    contentChunksCache = null;
    setSearching(false);
  }

  /** 覆盖写入长度 1 结果缓存（含状态条；specs 浅拷贝，避免后续 clear 连带清空） */
  function snapshotLastResult(query) {
    if (!query) return;
    // 无结果（含「只有错误」）：不更新缓存。开搜会 setGrayHighlight(窗口起点)；
    // 仅当灰边界已越过 progressOriginCp（至少分析完一块）才视为有进度。
    if (
      paintSpecs.length === 0 &&
      matchedChunks.length === 0 &&
      semanticMatchProgress.length === 0 &&
      !(analyzedGrayCp != null && analyzedGrayCp > progressOriginCp)
    ) {
      return;
    }
    lastResult = {
      query,
      text: doc.getText(),
      // pending 等待线随快照；红线靠 semanticMatchProgress.hasKeywords（keywords 确认有色后才红）
      paintSpecs: paintSpecs.map((s) => ({ ...s })),
      matchedChunks: matchedChunks.map((c) => ({ ...c })),
      semanticMatchProgress: semanticMatchProgress.map((c) => ({ ...c })),
      progressOriginCp,
      matchIndex,
      analyzedGrayCp,
      selectedProgressChunkStarts: [...selectedProgressChunkStarts],
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

  /** 还原上次结果。不等门面 epoch，与开搜一样用当时已有的版本信息。 @returns {boolean} 是否已还原 */
  function tryRestoreLastResult(query) {
    if (!lastResult || !query) return false;
    if (query !== lastResult.query || doc.getText() !== lastResult.text) return false;
    paintSpecs = lastResult.paintSpecs.map((s) => ({ ...s }));
    matchedChunks = lastResult.matchedChunks.map((c) => ({ ...c }));
    semanticMatchProgress = lastResult.semanticMatchProgress.map((c) => ({ ...c }));
    progressOriginCp = lastResult.progressOriginCp ?? 0;
    matchIndex = lastResult.matchIndex;
    selectedProgressChunkStarts = new Set(lastResult.selectedProgressChunkStarts ?? []);
    lastSearchMeta = lastResult.searchMeta ? { ...lastResult.searchMeta } : null;
    if (lastResult.analyzedGrayCp != null) analyzedGrayCp = lastResult.analyzedGrayCp;
    syncScopeVisual();
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
   * 布局变化后同步高亮：ChatGPT 等会在滚动时改 DOM；尺寸变化也会改几何。
   * 无 mutation 且 pieces 仍 connected 时跳过 collectTextMap，且不重绑 CSS Highlight（只重测线）。
   */
  function syncPaintAfterLayout() {
    if (!doc.isConnected()) {
      // 提取根本身被换掉/摘除（如翻译插件重建了整个容器）：有残留结果才需要放弃，否则什么都没画，无需处理
      if (
        paintSpecs.length > 0 ||
        hasGrayPaint() ||
        matchedChunks.length > 0 ||
        semanticMatchProgress.length > 0
      ) {
        giveUp();
      }
      return;
    }
    if (paintSpecs.length === 0 && !hasGrayPaint()) {
      if (searching || semanticMatchProgress.length > 0) {
        progressChunkContentY = new Map();
        renderSemanticMatchProgress();
      }
      return;
    }

    const stale = doc.piecesStale();
    // 无 mutation 且节点仍在：Highlight Range 仍有效；overlay（PDF 红线 / 蓝线）重测
    if (!doc.isContentDirty() && !stale) {
      remeasureUnderlines({
        preserveUnderline: paintSpecs.some((s) => s.kind === 'underline'),
      });
      if (hasGrayPaint() && usesTokenOverlay()) applyGrayMaskPdf();
      progressChunkContentY = new Map();
      renderSemanticMatchProgress();
      return;
    }

    const mapped = doc.recollectMap();
    doc.clearContentDirty();
    if (mapped.text !== doc.getText()) {
      // DOM_DEBUG 只是目测提取范围的调试预览，永远反映"当前"文本，文本变了就重新按当前内容分块展示
      if (DOM_DEBUG) {
        doc.applyRecollected(mapped, { replaceText: true });
        if (!doc.getText().trim()) {
          clearOverlayEls();
          clearAllCustomHighlights();
          return;
        }
        const allChunks = splitContentChunks();
        matchedChunks = allChunks.map((chunk) => ({
          start: doc.toPaintOffset(chunk.start),
          end: doc.toPaintOffset(chunk.end),
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
      doc.applyRecollected(mapped, { replaceText: false });
    }
    renderAllSpecs({
      preserveUnderline: paintSpecs.some((s) => s.kind === 'underline'),
    });
    progressChunkContentY = new Map();
    renderSemanticMatchProgress();
  }

  /**
   * 滚动专用：overlay 与正文同层时，相对坐标不随滚动变。
   * 仅当 mutation（dirty）或节点摘挂（stale）时才落入 syncPaintAfterLayout。
   * 纯滚动跳过 remesure，避免长文/多 pending 时主线程空转。
   */
  function syncPaintAfterScroll() {
    if (!doc.isConnected()) {
      if (
        paintSpecs.length > 0 ||
        hasGrayPaint() ||
        matchedChunks.length > 0 ||
        semanticMatchProgress.length > 0
      ) {
        giveUp();
      }
      return;
    }
    if (paintSpecs.length === 0 && !hasGrayPaint()) return;
    if (!doc.isContentDirty() && !doc.piecesStale()) return;
    syncPaintAfterLayout();
  }

  let scrollPaintTimer = 0;
  let scopePreviewScrollRaf = 0;
  let progressViewportScrollRaf = 0;
  /** @type {EventTarget | null} 非 window 的 scrollRoot：范围预览跟手 ∪ 进度图视口带 */
  let viewportFollowScrollTarget = null;

  function scheduleScopePreviewFromScroll() {
    if (!isFindInputFocused() || !searchFromCurrent || searching) return;
    if (scopePreviewScrollRaf) return;
    scopePreviewScrollRaf = requestAnimationFrame(() => {
      scopePreviewScrollRaf = 0;
      syncScopeVisual();
    });
  }

  /** 滚动时只更新进度图视口带，不重画竖线、不改选中态 */
  function scheduleProgressViewportFromScroll() {
    if (semanticMatchProgress.length === 0 && !searching) return;
    if (progressViewportScrollRaf) return;
    progressViewportScrollRaf = requestAnimationFrame(() => {
      progressViewportScrollRaf = 0;
      applyProgressViewportBand();
    });
  }

  function scheduleViewportFollowFromScroll() {
    scheduleScopePreviewFromScroll();
    scheduleProgressViewportFromScroll();
  }

  function unbindViewportFollowScrollTarget() {
    if (!viewportFollowScrollTarget) return;
    viewportFollowScrollTarget.removeEventListener('scroll', scheduleViewportFollowFromScroll);
    viewportFollowScrollTarget = null;
  }

  /** 内部 scrollRoot 跟手：范围预览或进度图视口带任一需要时绑定 */
  function updateViewportFollowScrollBinding() {
    const needScope = isFindInputFocused() && searchFromCurrent && !searching;
    const needProgress = searching || semanticMatchProgress.length > 0;
    if (!needScope && !needProgress) {
      unbindViewportFollowScrollTarget();
      return;
    }
    const root = doc.findScrollRoot();
    const needsTarget = !!(root && !isWindowScrollRoot(root));
    if (!needsTarget) {
      unbindViewportFollowScrollTarget();
      return;
    }
    if (viewportFollowScrollTarget === root) return;
    unbindViewportFollowScrollTarget();
    viewportFollowScrollTarget = root;
    root.addEventListener('scroll', scheduleViewportFollowFromScroll, { passive: true });
  }

  function scheduleSyncPaintAfterScroll() {
    if (scrollPaintTimer) clearTimeout(scrollPaintTimer);
    scrollPaintTimer = window.setTimeout(() => {
      scrollPaintTimer = 0;
      syncPaintAfterScroll();
    }, 120);
    scheduleViewportFollowFromScroll();
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
  function appendUnderlineRect(rect, kind, cp0, cp1) {
    if (!doc.getPaintMount()) throw new Error('paint mount missing');
    const el = document.createElement('div');
    const pending = kind === 'pending-underline';
    el.className = pending ? 'il-chunk-underline-pending' : 'il-chunk-underline';
    el.dataset.ilUnderline = pending ? 'pending' : 'nav';
    // 按 chunk 区间标记，便于增量拆除（避免全量重画剩余 pending）
    el.dataset.ilCp0 = String(cp0);
    el.dataset.ilCp1 = String(cp1);
    const { x, y } = doc.clientRectToMountPos(rect);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${rect.width}px`;
    doc.getPaintMount().appendChild(el);
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
    // SYNC: GLTR_Text_Box.clearHighlight({ preserveChunkInterval: true }) — 留蓝导航线 DOM（hold 中）
    clearOverlayRole('pending');
  }

  function paintUnderlineSpec(spec) {
    for (const range of doc.rangesFromOffsets(spec.cp0, spec.cp1)) {
      if (!/\S/.test(range.toString())) continue;
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        appendUnderlineRect(r, spec.kind, spec.cp0, spec.cp1);
      }
    }
  }

  /**
   * 只重画一类下划线（不动 token / gray / 另一类线）。
   * 网页：CSS Highlight（无 getClientRects）；PDF：overlay。
   * @param {'underline' | 'pending-underline'} kind
   */
  function renderUnderlinesOfKind(kind) {
    if (!usesUnderlineOverlay()) {
      ensureHighlightRegistry();
      const name = kind === 'pending-underline' ? HL_PENDING_UNDERLINE : HL_UNDERLINE;
      const h = CSS.highlights.get(name);
      if (!h) throw new Error(`highlight missing: ${name}`);
      h.clear();
      if (!doc.isConnected()) return;
      for (const s of paintSpecs) {
        if (s.kind !== kind) continue;
        addCpRangeToHighlight(h, s.cp0, s.cp1);
      }
      return;
    }
    const role = kind === 'pending-underline' ? 'pending' : 'nav';
    if (!doc.isConnected()) {
      clearOverlayRole(role);
      return;
    }
    doc.ensurePaintMount();
    clearOverlayRole(role);
    for (const s of paintSpecs) {
      if (s.kind === kind) paintUnderlineSpec(s);
    }
  }

  /**
   * 只重测依赖 getClientRects 的 overlay（PDF 红下划线 + 蓝线）。
   * CSS Highlight 的 Range 随节点走，几何变时不必重绑。
   * @param {{ preserveUnderline?: boolean }} [options]
   *   preserveUnderline：不拆蓝导航线 DOM（hold 不被流式更新打断）
   */
  function remeasureUnderlines(options) {
    if (usesTokenOverlay()) renderTokenHighlights();
    if (options?.preserveUnderline !== true) renderUnderlinesOfKind('underline');
    renderUnderlinesOfKind('pending-underline');
  }

  /**
   * 全量：token + gray + 下划线。仅用于节点重绑 / 还原等必须整表一致的场景。
   * 网页 token 在此画；PDF token 由 remeasureUnderlines 画（避免与之重复清+重绘）。
   * @param {{ preserveUnderline?: boolean }} [options]
   */
  function renderAllSpecs(options) {
    if (!doc.isConnected()) return 0;
    doc.ensurePaintMount();
    if (!usesTokenOverlay()) renderTokenHighlights();
    applyGrayHighlight();
    remeasureUnderlines(options);
    return overlayEls.length;
  }

  function paintSpec(kind, cp0, cp1, level) {
    const before = paintSpecs.length;
    const spec = kind === 'token' ? { kind, cp0, cp1, level } : { kind, cp0, cp1 };
    upsertSpec(spec);
    return paintSpecs.length > before ? 1 : 0;
  }

  /**
   * SYNC：站内 .gray-text 只改字色。
   * 扩展：写入分析灰界事实，再由 syncScopeVisual 派生展示。
   */
  function setGrayHighlight(analyzedCpEnd) {
    analyzedGrayCp = analyzedCpEnd;
    syncScopeVisual();
  }

  function scheduleReflow() {
    if (reflowQueued) return;
    reflowQueued = true;
    requestAnimationFrame(() => {
      reflowQueued = false;
      // resize：Highlight Range 仍有效；overlay（PDF 红线 / 蓝线）需重测
      remeasureUnderlines({
        preserveUnderline: paintSpecs.some((s) => s.kind === 'underline'),
      });
      syncScopeVisual();
    });
  }

  /** DOM 调试：画出全部提取 chunk 下划线（非语义 match 导航） */
  function paintAllUnderlines() {
    cancelUnderlineHold();
    paintSpecs = paintSpecs.filter((s) => s.kind !== 'underline');
    matchedChunks.forEach((c) => {
      upsertSpec({ kind: 'underline', cp0: c.start, cp1: c.end });
    });
    renderUnderlinesOfKind('underline');
  }

  /**
   * SYNC: client/src/shared/vis/GLTR_Text_Box.ts → setChunkCharRangeHighlight
   * 语义导航下划线：↑↓ 一条；进度图点选可多条（覆盖同一 Y 的块）。
   */
  function setCurrentUnderlines(chunks) {
    cancelUnderlineHold();
    paintSpecs = paintSpecs.filter((s) => s.kind !== 'underline');
    selectedProgressChunkStarts = new Set();
    for (const chunk of chunks) {
      upsertSpec({ kind: 'underline', cp0: chunk.start, cp1: chunk.end });
      selectedProgressChunkStarts.add(chunk.start);
    }
    applyProgressSelectedClass();
    renderUnderlinesOfKind('underline');
  }

  /** hold 到期：清导航蓝线（正文下划线 + 进度图选中；网页 Highlight / PDF overlay 同效，无渐隐） */
  function clearCurrentUnderline() {
    paintSpecs = paintSpecs.filter((s) => s.kind !== 'underline');
    if (usesUnderlineOverlay()) clearOverlayRole('nav');
    else CSS.highlights?.get(HL_UNDERLINE)?.clear();
    if (selectedProgressChunkStarts.size) {
      selectedProgressChunkStarts = new Set();
      applyProgressSelectedClass();
    }
    if (lastResult) snapshotLastResult(lastResult.query);
  }

  /**
   * 取 cp 附近可用于滚动定位的可视 rect。
   * 正文起点（第一个 chunk）常有前导换行/空白：单码点 Range 的 getClientRects 为空，
   * 若仍用 rangesFromOffsets(cp0, cp0+1) 会直接放弃滚动；下划线绘制已用
   * rangesFromOffsets 跳过空白，故会出现「点了进度条有线但不跳转」。
   */
  function clientRectNearCp(cp0) {
    if (!doc.getText() || cp0 < 0) return null;
    const fullCp = doc.getPaintLength();
    if (cp0 >= fullCp) return null;
    const probeEnd = Math.min(fullCp, cp0 + 128);
    for (const range of doc.rangesFromOffsets(cp0, probeEnd)) {
      if (!/\S/.test(range.toString())) continue;
      for (const r of range.getClientRects()) {
        if (r.width >= 1 && r.height >= 1) return r;
      }
    }
    return null;
  }

  /** 把文档 Y 滚到视角 viewportYRatio 处（window/panel 归一）。 */
  function computedScrollTopAtContentY(contentY, scrollRoot, viewportYRatio) {
    if (isWindowScrollRoot(scrollRoot)) {
      const ideal = contentY - window.innerHeight * viewportYRatio;
      const maxScroll = Math.max(
        0,
        (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight
      );
      return { target: window, top: Math.max(0, Math.min(ideal, maxScroll)) };
    }
    const panel = /** @type {HTMLElement} */ (scrollRoot);
    const maxScroll = Math.max(0, panel.scrollHeight - panel.clientHeight);
    return {
      target: panel,
      top: Math.max(0, Math.min(contentY - panel.clientHeight * viewportYRatio, maxScroll)),
    };
  }

  function scrollToContentY(contentY, highlightChunks) {
    if (contentY == null || !doc.getRoot()) return;
    const scrollRoot = doc.findScrollRoot();
    const focus = computedScrollTopAtContentY(
      contentY,
      scrollRoot,
      VIEWPORT_FOCUS_Y_RATIO
    );
    let top = focus.top;
    if (highlightChunks && highlightChunks.length) {
      let startY = null;
      for (const chunk of highlightChunks) {
        const cy = measureChunkContentY(chunk, scrollRoot);
        if (cy && (startY == null || cy.y0 < startY)) startY = cy.y0;
      }
      if (startY != null) {
        const clamp = computedScrollTopAtContentY(
          startY,
          scrollRoot,
          CHUNK_START_MAX_Y_RATIO
        );
        top = Math.min(top, clamp.top);
      }
    }
    focus.target.scrollTo({ top, behavior: 'auto' });
  }

  /**
   * 流式逐块展示：数据到达即滚动定位。
   * 项：{ start, end, reveal }，起止为 paint 码点；reveal=true 时该块还附带完整展示
   * （跳转 + 进度图 + 导航态 + 下划线 hold），当前仅首个匹配块用。
   * 灰字/等待线/keywords 上色均由主循环实时处理，不进本路径。
   */
  function enqueueFollow(item) {
    if (item.reveal) {
      const m = matchedChunks.find((c) => c.start === item.start);
      if (m) revealChunk(m);
    } else {
      const scrollRoot = doc.findScrollRoot();
      const nextRect = clientRectNearCp(item.end);
      if (nextRect) {
        scrollToContentY(contentYFromClientY(nextRect.top, scrollRoot));
      } else {
        const cy = measureChunkContentY(
          { start: item.start, end: item.end },
          scrollRoot
        );
        if (cy) scrollToContentY(cy.y1);
      }
    }
  }

  /**
   * SYNC: client/src/shared/vis/GLTR_Text_Box.ts → jumpToChunkHighlight
   * + client/src/features/analysis/semanticFindBar.ts → jumpTo
   * 下划线 → 滚到块中点 Y → hold 后清除
   */
  function jumpToMatch(index) {
    if (!matchedChunks.length) return;
    const n = matchedChunks.length;
    matchIndex = ((index % n) + n) % n;
    revealChunk(matchedChunks[matchIndex]);
    updateNav();
  }

  /** 本次若开火的窗口起点（码点）；对应 runSearch.windowStart 那一块。 */
  function intendedSearchStartCp() {
    if (searchFromCurrent) return scopeStartCpFromViewport();
    const contentChunks = splitContentChunks();
    if (contentChunks.length === 0) return 0;
    return doc.toPaintOffset(contentChunks[0].start);
  }

  /** 同 query、同窗、已有从该起点的匹配：只跳转，避免清空再画闪一下。 */
  function sameWindowHasMatch(startCp) {
    const query =
      /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.value?.trim() || '';
    if (!query || lastSearchMeta?.query !== query) return false;
    if (!doc.isConnected()) return false;
    const contentChunks = splitContentChunks();
    const windowStart = searchFromCurrent ? scopeWindowStartFromViewport(contentChunks) : 0;
    if (windowStart !== (lastSearchMeta.windowStart ?? 0)) return false;
    return matchedChunks.some((c) => c.start >= startCp);
  }

  /**
   * 按焦点线现算上下导航目标。
   * 区外：首块前 / 末块后循环；区内：落在匹配上则 ±1，落在灰块上则按插入点。
   */
  function navigateMatch(delta) {
    if (!matchedChunks.length) return;

    const anchor =
      semanticMatchProgress.length > 0 ? progressAnchorFromViewport() : null;

    if (anchor === 'before') {
      jumpToMatch(delta < 0 ? -1 : 0);
      return;
    }
    if (anchor === 'after') {
      jumpToMatch(delta < 0 ? matchedChunks.length - 1 : matchedChunks.length);
      return;
    }
    if (typeof anchor !== 'number') {
      jumpToMatch(matchIndex < 0 ? (delta < 0 ? matchedChunks.length - 1 : 0) : matchIndex + delta);
      return;
    }

    const currentIndex = matchedChunks.findIndex((chunk) => chunk.start === anchor);
    if (currentIndex >= 0) {
      jumpToMatch(currentIndex + delta);
      return;
    }

    const nextIndex = matchedChunks.findIndex((chunk) => chunk.start > anchor);
    const insertionIndex = nextIndex < 0 ? matchedChunks.length : nextIndex;
    jumpToMatch(delta < 0 ? insertionIndex - 1 : insertionIndex);
  }

  /**
   * 跳到文档 Y，再高亮。高亮未传则取盖住该 Y 的块；↑↓ 显式传入当前块。
   * 滚动：目标 Y @ 焦点线；若高亮块顶会高过 20% 视口，则把最顶块顶下调到 20%。
   * @param {number | null} contentY
   * @param {{ start: number, end: number }[]} [highlightChunks]
   */
  function revealAtContentY(contentY, highlightChunks) {
    const generation = ++revealGeneration;
    cancelUnderlineHold();
    clearCurrentUnderline();
    const scrollRoot = doc.findScrollRoot();
    const chunks =
      highlightChunks === undefined
        ? contentY != null
          ? chunksCoveringContentY(contentY, scrollRoot)
          : []
        : highlightChunks;
    const matched = chunks.find((c) => matchedChunks.some((m) => m.start === c.start));
    if (matched) matchIndex = matchedChunks.findIndex((item) => item.start === matched.start);
    requestAnimationFrame(() => {
      if (contentY != null) scrollToContentY(contentY, chunks);
      if (generation !== revealGeneration || !doc.isConnected()) return;
      setCurrentUnderlines(chunks);
      if (chunks.length === 0) return;
      underlineHoldTimer = window.setTimeout(() => {
        underlineHoldTimer = 0;
        clearCurrentUnderline();
      }, CHUNK_HIGHLIGHT_HOLD_MS);
    });
  }

  /** ↑↓ / 首匹配：目标 Y = 块中点（否则块顶已在 50%，20% 保底不会触发），高亮这一块。 */
  function revealChunk(chunk) {
    const cy = measureChunkContentY(chunk, doc.findScrollRoot());
    revealAtContentY(cy ? (cy.y0 + cy.y1) / 2 : null, [chunk]);
  }

  // ---------- API ----------

  /** 用户取消（abort signal）的兜底错误：message 为展示文案，errorDetail 进反馈 */
  function abortStreamError(label) {
    const err = new Error('search stopped');
    err.name = 'AbortError';
    err.errorDetail = `${label} stream cancelled by user`;
    return err;
  }

  function isAbortErr(err) {
    return err != null && (err.name === 'AbortError' || err.message === 'search stopped');
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
          if (msg.kind) err.kind = String(msg.kind);
          if (msg.error_detail) err.errorDetail = String(msg.error_detail);
          finish(reject, err);
          closePort();
        }
      });
      if (signal) {
        if (signal.aborted) {
          // 先 settle 再 disconnect：否则 onDisconnect 会抢先 reject 成「连接中断」
          finish(reject, abortStreamError('relevance'));
          closePort();
        } else {
          signal.addEventListener(
            'abort',
            () => {
              finish(reject, abortStreamError('relevance'));
              closePort();
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
          if (msg.kind) err.kind = String(msg.kind);
          if (msg.error_detail) err.errorDetail = String(msg.error_detail);
          finish(reject, err);
          closePort();
        }
      });
      if (signal) {
        if (signal.aborted) {
          finish(reject, abortStreamError('keywords'));
          closePort();
        } else {
          signal.addEventListener(
            'abort',
            () => {
              finish(reject, abortStreamError('keywords'));
              closePort();
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

  /** hybrid：拆掉某 chunk 的等待线（只动该区间 pending；网页 Highlight 整表重绑仍很便宜） */
  function clearPendingUnderline(cp0, cp1) {
    paintSpecs = paintSpecs.filter(
      (s) => !(s.kind === 'pending-underline' && s.cp0 === cp0 && s.cp1 === cp1)
    );
    if (!usesUnderlineOverlay()) {
      renderUnderlinesOfKind('pending-underline');
      return;
    }
    const key0 = String(cp0);
    const key1 = String(cp1);
    overlayEls = overlayEls.filter((el) => {
      if (el.dataset.ilUnderline !== 'pending') return true;
      if (el.dataset.ilCp0 !== key0 || el.dataset.ilCp1 !== key1) return true;
      el.remove();
      return false;
    });
  }

  /**
   * 把单个 v2 keyword 高亮 run 写入 paintSpecs，并即时上色（增量）。
   * Worker 已完成定位 / uniquify 定档 / REPEAT_DIM 压暗；score 为 (0,1]，直接乘 matchDegree。
   * @param {{offset: [number, number], raw: string, score: number}} t
   * @param {number} chunkCpStart
   * @param {number} matchDegree
   * @returns {number} 实际上色的 token 段数；0 表示没有染色
   */
  function paintTokenRun(t, chunkCpStart, matchDegree) {
    if (!keywordRunPaintable(t, chunkCpStart, matchDegree)) return 0;
    const degree = Number.isFinite(matchDegree) ? matchDegree : 0;
    const [a, b] = t.offset;
    const level = scoreToLevel((t.score > 0 ? t.score : 0) * degree);
    const cp0 = chunkCpStart + a;
    const cp1 = chunkCpStart + b;
    paintSpec('token', cp0, cp1, level);
    if (usesTokenOverlay()) {
      doc.ensurePaintMount();
      paintTokenOverlaySpec({ kind: 'token', cp0, cp1, level });
      return 1;
    }
    ensureHighlightRegistry();
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

  const barTop = uiOpts.barTop ?? '12px';
  const HOST_CSS = `
:host {
  all: initial;
  position: fixed;
  top: ${barTop};
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

    ui$('semantic_match_progress')?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      /** @type {HTMLInputElement | null} */ (ui$('semantic_find_input'))?.blur();
      const contentY = progressContentYFromClientX(event.clientX);
      if (contentY == null) return;
      revealAtContentY(contentY);
    });
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
    });
    // 输入区选项：mousedown 不让 button 抢焦点，并 focus 输入（vscode「option click → fix focus」）
    const inputWrap = findInput.closest('.semantic-find-bar-input-wrap');
    inputWrap?.addEventListener('mousedown', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button') : null;
      if (!btn || !inputWrap.contains(btn)) return;
      e.preventDefault();
      findInput.focus();
    });
    ui$('semantic_find_scope')?.addEventListener('click', (e) => {
      e.stopPropagation();
      searchFromCurrent = !searchFromCurrent;
      syncScopeToggleButton();
      syncScopeVisual();
    });
    syncScopeToggleButton();
    findInput.addEventListener('focus', () => {
      void ensureHistory().then(renderHistoryDropdown);
      syncScopeVisual();
    });
    findInput.addEventListener('blur', () => {
      syncScopeVisual();
    });
    findInput.addEventListener('input', () => {
      if (searching) return;
      // 输入框内容一变（无论是手改还是点 × 清空），旧的渲染状态即视为过期，统一清掉
      // releaseDoc=false：仍聚焦时要立刻重画范围预览，避免每键 Readability
      resetSearchSession({ clearCache: true, releaseDoc: false });
      syncClearButton(false);
      if (uiShadow?.activeElement === findInput) renderHistoryDropdown();
    });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        const startCp = intendedSearchStartCp();
        if (startCp >= doc.getPaintLength()) return;
        hideHistoryDropdown();
        if (sameWindowHasMatch(startCp)) {
          const idx = matchedChunks.findIndex((c) => c.start >= startCp);
          if (idx >= 0) jumpToMatch(idx);
        } else if (!searching) {
          void runSearch();
        }
        findInput.blur();
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

  /**
   * 实测 position:fixed 的含块（与 left/right/top/bottom:0 的探针同坐标系）。
   * 不能用 documentElement.clientWidth：页面给 html 设 margin 时它会偏小（如 marxists.org），
   * 拖拽夹紧会出现右侧死区。
   */
  function measureFixedViewport() {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;top:0;right:0;bottom:0;visibility:hidden;pointer-events:none;margin:0;border:0;padding:0;';
    document.documentElement.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }

  /**
   * 拖非可点区域移动整块 Find UI；不持久化。
   * 默认 CSS 是 right/top；按下后改用 left/top 承接当前视觉位置（rect 恒等，无 viewport 反推）。
   * 必须写 right:'auto' 盖掉 :host 的 right，否则 left+right 同时生效会把 host 拉宽。
   */
  function wireBarDrag() {
    const barEl = uiQuery('.semantic-find-bar');
    const host = document.getElementById('il-find-root');
    if (!barEl || !host) return;

    const DRAG_EXEMPT = 'button, input, textarea, select, a, .semantic-search-history-dropdown';
    /** @type {{ pointerId: number, startX: number, startY: number, originLeft: number, originTop: number, width: number, height: number, vpLeft: number, vpTop: number, vpRight: number, vpBottom: number } | null} */
    let drag = null;

    barEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!(e.target instanceof Element)) return;
      if (e.target.closest(DRAG_EXEMPT)) return;

      const rect = host.getBoundingClientRect();
      const vp = measureFixedViewport();
      host.style.position = 'fixed';
      host.style.right = 'auto';
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;

      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originLeft: rect.left,
        originTop: rect.top,
        width: rect.width,
        height: rect.height,
        vpLeft: vp.left,
        vpTop: vp.top,
        vpRight: vp.right,
        vpBottom: vp.bottom,
      };
      barEl.classList.add('is-dragging');
      barEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    barEl.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const maxLeft = Math.max(drag.vpLeft, drag.vpRight - drag.width);
      const maxTop = Math.max(drag.vpTop, drag.vpBottom - drag.height);
      const left = Math.min(maxLeft, Math.max(drag.vpLeft, drag.originLeft + (e.clientX - drag.startX)));
      const top = Math.min(maxTop, Math.max(drag.vpTop, drag.originTop + (e.clientY - drag.startY)));
      host.style.left = `${left}px`;
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

  function syncScopeToggleButton() {
    const btn = ui$('semantic_find_scope');
    if (!btn) return;
    btn.classList.toggle('is-from-current', searchFromCurrent);
    btn.setAttribute('aria-pressed', searchFromCurrent ? 'true' : 'false');
    const label = searchFromCurrent
      ? 'Search from current position'
      : 'Search entire document';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  /** 页面级 #il-find-root 已被另一份扩展占用（隔离世界互不可见，只能靠 DOM 标记） */
  const OTHER_IL_MSG =
    'Another InfoLens is already on this page. Please refresh the page and try again.';
  /** PDF 无嵌入文本（扫描件等）；与 pdf-document.js 抛错文案对齐 */
  const PDF_NO_TEXT_MSG =
    'No extractable text in this PDF (image-only / scanned pages are not supported)';

  function isPdfNoTextError(err) {
    const msg = String(err?.message || err);
    return msg === 'PDF page text empty' || msg === 'PDF page text missing';
  }

  function showPdfNoTextNotice() {
    showFindStatus('Note', PDF_NO_TEXT_MSG, { tone: 'info', resumable: false });
  }

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

  function progressChartLayout(chart) {
    const width = Math.max(1, Math.round(chart.clientWidth));
    const height = Math.max(1, Math.round(chart.clientHeight));
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    return {
      x0: 4,
      x1: width - 4,
      y0: height - 7,
      y1: 4,
      axis: progressAxisYRange(),
    };
  }

  function upsertProgressLine(lines, layout, chunk, cy, nextCy, group) {
    const { x0, x1, y0, y1, axis } = layout;
    const degree = Math.max(0, Math.min(1, Number(chunk.matchDegree) || 0));
    const abut = !!(nextCy && nextCy.y0 > cy.y0);
    const yStart = Math.max(axis.y0, Math.min(axis.y1, cy.y0));
    const yEnd = Math.max(axis.y0, Math.min(axis.y1, abut ? nextCy.y0 : cy.y1));
    const start = progressXFromContentY(yStart, x0, x1, axis);
    const end = progressXFromContentY(yEnd, x0, x1, axis);
    const y = y0 - (y0 - y1) * degree;
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
      hitEl.addEventListener('mouseenter', () => {
        setHoveredProgressChunk(chunk.start);
      });
      hitEl.addEventListener('mouseleave', () => {
        if (hoveredProgressChunkStart === chunk.start) setHoveredProgressChunk(null);
      });
      group.appendChild(hitEl);
      lines.appendChild(group);
    }
    const line = /** @type {SVGPathElement} */ (group.querySelector('.semantic-match-progress-line'));
    const label = /** @type {SVGTextElement} */ (group.querySelector('.semantic-match-progress-label'));
    const hitArea = /** @type {SVGRectElement} */ (group.querySelector('.semantic-match-progress-hit-area'));
    const showMatchRed = degree >= CFG.matchThreshold && !!chunk.hasKeywords;
    line.classList.toggle('is-gray', !showMatchRed);
    line.classList.toggle('is-selected', selectedProgressChunkStarts.has(chunk.start));
    line.classList.toggle('is-hovered', hoveredProgressChunkStart === chunk.start);
    const lineEnd = abut ? Math.max(start, end) : Math.max(start + PROGRESS_MIN_WIDTH_PX, end);
    line.setAttribute('d', `M${start} ${y}H${lineEnd}`);
    label.setAttribute('x', String((start + lineEnd) / 2));
    label.setAttribute('y', String(Math.max(y1 + 10, y - 4)));
    label.textContent = `Match: ${Math.round(degree * 100)}%`;
    label.toggleAttribute('hidden', hoveredProgressChunkStart !== chunk.start);
    hitArea.setAttribute('x', String(start));
    hitArea.setAttribute('y', String(y1));
    hitArea.setAttribute('width', String(lineEnd - start));
    hitArea.setAttribute('height', String(y0 - y1));
  }

  /** 简版 semantic match progress：文档 Y × chunk 匹配度。 */
  function renderSemanticMatchProgress() {
    const chart = ui$('semantic_match_progress');
    const lines = ui$('semantic_match_progress_lines');
    if (!(chart instanceof SVGSVGElement) || !(lines instanceof SVGGElement)) return;

    // 空进度框架只在一个「新搜索请求已发出、本地就绪、等待首个 chunk 回流」的窗口期显示：
    // 仅当正在搜索(searching)且尚无任何 chunk 结果时亮出；否则隐藏（正文为空、或搜索已结束/未开始）。
    const hidden =
      doc.getText().length === 0 ||
      (semanticMatchProgress.length === 0 && !searching);
    chart.toggleAttribute('hidden', hidden);
    if (hidden) {
      lines.replaceChildren();
      ui$('semantic_match_progress_viewport')?.setAttribute('hidden', '');
      updateViewportFollowScrollBinding();
      return;
    }

    const layout = progressChartLayout(chart);
    const groupsByStart = new Map(
      [...lines.children]
        .filter((el) => el instanceof SVGGElement && el.dataset.progressStart != null)
        .map((el) => [Number(el.dataset.progressStart), el])
    );
    const liveStarts = new Set();
    const rows = [];
    if (layout.axis) {
      for (const chunk of semanticMatchProgress) {
        const cy = measureChunkContentY(chunk, layout.axis.scrollRoot);
        if (cy) rows.push({ chunk, cy });
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const { chunk, cy } = rows[i];
      liveStarts.add(chunk.start);
      upsertProgressLine(lines, layout, chunk, cy, rows[i + 1]?.cy, groupsByStart.get(chunk.start));
    }
    for (const [start, group] of groupsByStart) {
      if (!liveStarts.has(start)) group.remove();
    }
    updateViewportFollowScrollBinding();
    applyProgressViewportBand();
  }

  /** 流式追加最后一根线，并按邻接补上一根。量不到几何则退回全量。 */
  function appendSemanticMatchProgress() {
    const chart = ui$('semantic_match_progress');
    const lines = ui$('semantic_match_progress_lines');
    if (!(chart instanceof SVGSVGElement) || !(lines instanceof SVGGElement)) return;
    const n = semanticMatchProgress.length;
    if (n === 0 || chart.hasAttribute('hidden')) {
      renderSemanticMatchProgress();
      return;
    }
    const layout = progressChartLayout(chart);
    if (!layout.axis) {
      renderSemanticMatchProgress();
      return;
    }
    const last = semanticMatchProgress[n - 1];
    const cy = measureChunkContentY(last, layout.axis.scrollRoot);
    if (!cy) {
      renderSemanticMatchProgress();
      return;
    }
    if (n > 1) {
      const prev = semanticMatchProgress[n - 2];
      const prevCy = measureChunkContentY(prev, layout.axis.scrollRoot);
      if (prevCy) {
        const prevGroup = [...lines.children].find(
          (el) => el instanceof SVGGElement && el.dataset.progressStart === String(prev.start)
        );
        upsertProgressLine(lines, layout, prev, prevCy, cy, prevGroup);
      }
    }
    upsertProgressLine(lines, layout, last, cy, null, null);
    applyProgressViewportBand();
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
    if (!on && doc.isContentDirty()) doc.scheduleLayoutSync();
    // 结束/停止时重绘进度图：把「等待首 chunk」的空框架收起（hidden 判据依赖 searching）
    if (!on) renderSemanticMatchProgress();
    syncScopeVisual();
  }

  /**
   * 从起点按缓存规则一次定窗：已缓存前缀本地回放，从第一个洞起最多 MAX_CHUNKS_PER_SEARCH 块。
   * @param {string} query
   * @param {{ start: number, end: number, text: string }[]} fromStart
   * @returns {Promise<{ chunks: { start: number, end: number, text: string }[], degrees: (number | undefined)[] }>}
   */
  async function takeSearchWindow(query, fromStart) {
    const { n, degrees } = await globalThis.IL_analyzeCache.windowPlan(
      query,
      fromStart.map((c) => c.text),
      CFG.matchThreshold,
      MAX_CHUNKS_PER_SEARCH
    );
    return { chunks: fromStart.slice(0, n), degrees };
  }

  /**
   * 多目标优化之字典序目标优化（目标之间存在硬优先级）：
   * 一次搜索。字典序目标（先比上一条，打平才比下一条）：
   * 1. 至少找到一个匹配；除非真的没有，或已经打满 8 次网络请求
   * 2. 少发起网络请求；除非还没有找到匹配
   * 3. 窗口尽量宽；除非需要发起更多的网络请求
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

      /** @type {{ start: number, end: number, text: string }[]} */
      let allChunks;
      let resumeFrom = 0;
      let analyzedCpEnd = 0;
      let batchResume = resume;
      let batchesDone = 0;

      while (batchesDone < MAX_AUTO_CONTINUE_BATCHES) {
        batchesDone += 1;

        if (batchResume) {
          clearFindStatus();
          if (!doc.isConnected()) {
            resetSearchSession({ clearCache: true });
            if (epoch === searchEpoch) showFindError('Page content changed; start a new search');
            return;
          }
          // 不可走 refreshExtract：它会清 overlays/进度。只复测正文是否仍一致并重绑节点。
          if (!doc.rebindIfUnchanged()) {
            resetSearchSession({ clearCache: true });
            if (epoch === searchEpoch) showFindError('Page content changed; start a new search');
            return;
          }
        } else {
          resetSearchSession();
          try {
            refreshExtract();
          } catch (err) {
            console.error('[InfoLens] extract aborted:', err?.message || err);
            if (epoch === searchEpoch) {
              if (isPdfNoTextError(err)) showPdfNoTextNotice();
              else showFindError(err?.message || err, { errorDetail: err?.errorDetail });
            }
            return;
          }
          if (!doc.getText().trim()) {
            console.error('[InfoLens] no article text found');
            if (epoch === searchEpoch) showFindError('No article text found');
            return;
          }
        }

        const contentChunks = splitContentChunks();
        const startAbs = batchResume
          ? (lastSearchMeta?.windowStart ?? 0) + semanticMatchProgress.length
          : searchFromCurrent
            ? scopeWindowStartFromViewport(contentChunks)
            : 0;
        if (startAbs >= contentChunks.length) return;

        const taken = await takeSearchWindow(query, contentChunks.slice(startAbs));
        if (epoch !== searchEpoch || abortWanted) break;
        allChunks = taken.chunks;
        if (!allChunks.length) return;

        const originAbs = batchResume ? (lastSearchMeta.windowStart ?? startAbs) : startAbs;
        lastSearchMeta = {
          query,
          contentChunkCount: contentChunks.length,
          truncated: startAbs + allChunks.length < contentChunks.length,
          windowStart: originAbs,
        };
        if (batchResume) {
          firstMatchJumped = false;
          analyzedCpEnd =
            analyzedGrayCp ??
            (semanticMatchProgress.length > 0
              ? semanticMatchProgress[semanticMatchProgress.length - 1].end
              : progressOriginCp);
        } else {
          progressOriginCp = doc.toPaintOffset(allChunks[0].start);
          analyzedCpEnd = progressOriginCp;
          setGrayHighlight(progressOriginCp);
        }

        // --- 段1：relevance（本窗一次；缓存前缀本地回放，send 仅未缓存后缀 ≤32）---
        const stillThisSearch = () => epoch === searchEpoch && !abortWanted;
        /** @type {Map<number, { resolve: Function, reject: Function }>} 每片 settle 句柄（row 到达即 resolve） */
        const chunkSettle = new Map();
        /** @type {Map<number, Promise<object>>} 每片就绪 promise（consume 用） */
        const perChunkReady = new Map();
        let relevanceStarted = false;
        const deferChunk = (idx) => {
          const d = {};
          const p = new Promise((resolve, reject) => {
            d.resolve = resolve;
            d.reject = reject;
          });
          // 主循环只 await 当前片；整批失败会 reject 其余片，出生即接住避免 Uncaught
          p.catch(() => {});
          perChunkReady.set(idx, p);
          chunkSettle.set(idx, d);
        };
        const ensureRelevance = () => {
          if (relevanceStarted) return;
          relevanceStarted = true;
          const start = resumeFrom;
          const end = allChunks.length;
          const texts = [];
          for (let k = start; k < end; k++) {
            texts.push(allChunks[k].text);
            deferChunk(k);
          }
          const p = globalThis.IL_analyzeCache.relevance(
            query,
            texts,
            (n, fullMatchDegree) => {
              const real = start + (n - 1);
              const d = chunkSettle.get(real);
              if (d) {
                chunkSettle.delete(real);
                d.resolve({ full_match_degree: fullMatchDegree });
              }
            },
            sessionAbortCtrl.signal,
            analyzeSemanticV2
          );
          p.catch((err) => {
            // 整批失败：reject 所有未就绪片（不静默挂起）。
            // network/inference（网络/上游不可用）是用户该知道的，透传门面用户文案；
            // internal（我方未预期/格式异常）屏蔽具体原因，落中性文案。
            // 用户停止 / 流取消：reject 只为解开未就绪片，不是失败。
            const stopped = abortWanted || isAbortErr(err);
            if (!stopped) {
              console.error('[InfoLens][relevance] batch error:', err?.message, 'detail=', err?.errorDetail);
            }
            const userMessage =
              (err?.kind === 'network' || err?.kind === 'inference') &&
              err?.message != null &&
              String(err.message).trim()
                ? String(err.message).trim()
                : null;
            for (let k = start; k < end; k++) {
              const d = chunkSettle.get(k);
              if (d) {
                chunkSettle.delete(k);
                if (stopped) {
                  d.reject(err);
                  continue;
                }
                const e = new Error(
                  userMessage != null ? userMessage : `relevance v2 request failed for chunk ${k}`
                );
                if (err?.errorDetail) e.errorDetail = String(err.errorDetail);
                d.reject(e);
              }
            }
          });
        };

        /** 渲染按序取走（该片 row 就绪即返回，不等待整批） */
        const consumeRelevance = (idx) => {
          ensureRelevance();
          return perChunkReady.get(idx);
        };

        // --- 段2：keywords（渲染匹配后投递；池内消费，不反压段1）---
        const enqueueKeywords = (chunkIndex, chunk, chunkCpStart, degree) => {
          keywordsPool.schedule(async (jobGen, signal) => {
            if (jobGen !== keywordsPool.gen) return;
            // 增量上色计数（逐条 run 到达即累计）
            let painted = 0;
            try {
              // 新扩展走 v2 流式（逐词增量上色）；旧扩展仍打旧 JSON 路径由门面双轨隔离
              await globalThis.IL_analyzeCache.keywords(
                query,
                chunk.text,
                (run) => {
                  if (jobGen !== keywordsPool.gen) return;
                  if (!doc.isConnected()) return;
                  painted += renderQueue.pushRun(run, chunkCpStart, degree);
                },
                signal,
                analyzeKeywordsV2
              );
              if (jobGen !== keywordsPool.gen) return;
              if (!doc.isConnected()) return;
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
              // 收尾清理：无论如何先 release，避免 renderQueue 卡在 current 上（abort/giveUp 也走这里）
              renderQueue.release(chunkCpStart, false);
              // 用户停止 / 过期轮次：reject 只为收尾，不是失败
              if (
                jobGen !== keywordsPool.gen ||
                epoch !== searchEpoch ||
                abortWanted ||
                isAbortErr(err)
              )
                return;
              // 失败：pending 留下 + chunk 级 Failed；整轮不中断
              console.error('[InfoLens] keywords', err?.message || err);
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

        let deferredFollow = null;
        const absorbRelevanceRow = (i, chunk, degree, deferPaint) => {
          // SYNC: semanticSearchController — matched = degree >= threshold；未匹配块不上色
          const matched = degree >= CFG.matchThreshold;
          const chunkCpStart = doc.toPaintOffset(chunk.start);
          const chunkCpEnd = doc.toPaintOffset(chunk.end);
          analyzedCpEnd = Math.max(analyzedCpEnd, chunkCpEnd);
          semanticMatchProgress.push({
            start: chunkCpStart,
            end: chunkCpEnd,
            matchDegree: degree,
          });
          if (!deferPaint) {
            appendSemanticMatchProgress();
            setGrayHighlight(analyzedCpEnd);
          }

          if (matched) {
            matchedChunks.push({
              start: chunkCpStart,
              end: chunkCpEnd,
              matchDegree: degree,
            });
            const pendingSpec = { kind: 'pending-underline', cp0: chunkCpStart, cp1: chunkCpEnd };
            upsertSpec(pendingSpec);
            if (doc.isConnected()) {
              if (usesUnderlineOverlay()) {
                doc.ensurePaintMount();
                paintUnderlineSpec(pendingSpec);
              } else {
                ensureHighlightRegistry();
                const h = CSS.highlights.get(HL_PENDING_UNDERLINE);
                if (!h) throw new Error('highlight missing: il-pending-underline');
                addCpRangeToHighlight(h, pendingSpec.cp0, pendingSpec.cp1);
              }
            }
            renderQueue.enqueue(chunkCpStart, chunkCpEnd);
            enqueueKeywords(i, chunk, chunkCpStart, degree);
          }
          if (!firstMatchJumped) {
            if (matched) firstMatchJumped = true;
            const item = matched
              ? { start: chunkCpStart, end: chunkCpEnd, reveal: true }
              : { start: chunkCpStart, end: chunkCpEnd };
            if (deferPaint) deferredFollow = item;
            else enqueueFollow(item);
          }
          if (!deferPaint) snapshotLastResult(query);
        };

        let prefixLen = 0;
        while (
          prefixLen < taken.degrees.length &&
          Number.isFinite(taken.degrees[prefixLen])
        ) {
          prefixLen += 1;
        }
        for (let i = 0; i < prefixLen; i++) {
          if (!stillThisSearch()) break;
          absorbRelevanceRow(i, allChunks[i], taken.degrees[i], true);
        }
        if (prefixLen > 0 && stillThisSearch()) {
          renderSemanticMatchProgress();
          setGrayHighlight(analyzedCpEnd);
          if (deferredFollow) enqueueFollow(deferredFollow);
          snapshotLastResult(query);
        }
        if (epoch !== searchEpoch || abortWanted) break;

        resumeFrom = prefixLen;
        if (stillThisSearch() && resumeFrom < allChunks.length) {
          ensureRelevance();
        }
        if (prefixLen === 0 && stillThisSearch() && allChunks.length) {
          const first = allChunks[0];
          const cy = measureChunkContentY(
            { start: doc.toPaintOffset(first.start), end: doc.toPaintOffset(first.end) },
            doc.findScrollRoot()
          );
          if (cy) scrollToContentY(cy.y0);
          renderSemanticMatchProgress();
        }

        for (let i = resumeFrom; i < allChunks.length; i++) {
          if (!stillThisSearch()) break;
          const chunk = allChunks[i];
          let res;
          try {
            res = await consumeRelevance(i);
          } catch (err) {
            if (abortWanted || isAbortErr(err)) break;
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
          absorbRelevanceRow(i, chunk, res.full_match_degree ?? 0);
        }

        if (epoch !== searchEpoch || abortWanted) break;
        // 有匹配或范围已尽：停在本批。0 匹配且未尽：自动下一批（while 上限 MAX_AUTO_CONTINUE_BATCHES）。
        if (matchedChunks.length > 0 || !canResumeSearch()) break;
        batchResume = true;
      }

      if (epoch !== searchEpoch) return;

      if (doc.getRoot() != null) {
        if (!abortWanted) {
          // 首匹配已在流式阶段立即跳转过，此处只收尾导航态
          updateNav();
          if (lastSearchMeta?.truncated) {
            // 本轮完成以 keywords 全部落地（含染色）为准，不能提前到 relevance 完成时提示：
            // 提前提示会让用户立刻 Continue，而旧 keywords 仍在池内排队，renderQueue 按块
            // 顺序推进，新匹配块的等待线→红染会被旧块拖住延迟暴露。故提醒等 whenIdle 之后。
            await keywordsPool.whenIdle();
            if (epoch !== searchEpoch || abortWanted) return;
            showFindStatus('Note', 'paused by single-search limit');
          }
        }
        // abort：Stopped/Continue 已在 Stop 点击时展示，此处只收尾 truncated + 下方 snapshot
      }
      snapshotLastResult(query);
    } catch (err) {
      // 过期轮次 / 用户主动停止：reject 只为收尾，不得打到当前 UI / 控制台
      if (epoch !== searchEpoch || abortWanted || isAbortErr(err)) return;
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
      doc.replaceTextAndPieces('', []);
      matchedChunks = [];
      matchIndex = -1;
      console.error('[InfoLens] extract aborted:', err?.message || err);
      return null;
    }
    if (!doc.getText().trim()) {
      console.error('[InfoLens] extract aborted: empty article text');
      return info;
    }
    const allChunks = splitContentChunks();
    matchedChunks = allChunks.map((chunk) => ({
      start: doc.toPaintOffset(chunk.start),
      end: doc.toPaintOffset(chunk.end),
      matchDegree: 1,
    }));
    matchIndex = -1;
    paintAllUnderlines();
    console.info(
      `[InfoLens] extract preview · ~${info.length} chars · ${allChunks.length} chunk(s) · ${overlayEls.length} rects`,
      { root: info.root, scrollRoot: doc.findScrollRoot() }
    );
    return info;
  }

  /** 打开栏时问门面缓存 epoch；失败沿用上次 */
  function fetchCacheVersion() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'il-analyze-semantic-version', apiBase: CFG.apiBase },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!resp?.ok) {
            reject(new Error(resp?.error || 'cache version check failed'));
            return;
          }
          resolve({ relevance: resp.relevance, keywords: resp.keywords });
        }
      );
    });
  }

  async function syncAnalyzeCacheModel() {
    try {
      await globalThis.IL_analyzeCache.syncRemoteModel(fetchCacheVersion);
    } catch (err) {
      console.error('[InfoLens] cache version check:', err?.message || err);
    }
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
      // 不等待：还原上次结果、随后开搜都只用当时已有的 epoch 决定是否走缓存
      void syncAnalyzeCacheModel();
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
        // extract/还原之后再派生灰区/虚线
        syncScopeVisual();
      } catch (err) {
        console.error('[InfoLens] extract aborted:', err?.message || err);
        if (isPdfNoTextError(err)) {
          showPdfNoTextNotice();
          return;
        }
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

  /** 拖过后是 inline left/top：缩窗时夹回 fixed 含块，避免飞出看不见 */
  function clampBarIntoViewport() {
    const host = document.getElementById('il-find-root');
    // 仅拖拽后写过 inline left（right 为 auto）；默认 CSS right/top 不夹
    if (!host || !host.style.left) return;
    const rect = host.getBoundingClientRect();
    const vp = measureFixedViewport();
    const maxLeft = Math.max(vp.left, vp.right - rect.width);
    const maxTop = Math.max(vp.top, vp.bottom - rect.height);
    const nextLeft = Math.min(maxLeft, Math.max(vp.left, rect.left));
    const nextTop = Math.min(maxTop, Math.max(vp.top, rect.top));
    if (nextLeft === rect.left && nextTop === rect.top) return;
    host.style.right = 'auto';
    host.style.left = `${nextLeft}px`;
    host.style.top = `${nextTop}px`;
  }

  /** 上次注入已过期（重装扩展未刷新页面）需整个丢弃时调用：close() 之外，摘掉本实例注册在 window 上的监听器 */
  function destroy() {
    close();
    doc.stopLayoutWatch();
    unbindViewportFollowScrollTarget();
    if (scopePreviewScrollRaf) {
      cancelAnimationFrame(scopePreviewScrollRaf);
      scopePreviewScrollRaf = 0;
    }
    if (progressViewportScrollRaf) {
      cancelAnimationFrame(progressViewportScrollRaf);
      progressViewportScrollRaf = 0;
    }
    if (scrollPaintTimer) {
      clearTimeout(scrollPaintTimer);
      scrollPaintTimer = 0;
    }
    window.removeEventListener('scroll', scheduleSyncPaintAfterScroll, true);
    window.removeEventListener('scrollend', syncPaintAfterScroll, true);
    window.removeEventListener('resize', scheduleReflow);
    window.visualViewport?.removeEventListener('resize', scheduleReflow);
  }

  // underline 与正文同层滚动；token/gray 为 CSS Highlight。布局漂移时重绑 Range / 重测 underline。
  // ResizeObserver → syncPaintAfterLayout（含稳定布局下的 remesure）。
  // scroll：仅 dirty/stale 时同步；纯滚动跳过 remesure（网页长文与 PDF 同理）。
  doc.startLayoutWatch({
    onContentMaybeChanged: syncPaintAfterLayout,
  });
  window.addEventListener('scroll', scheduleSyncPaintAfterScroll, true);
  window.addEventListener('scrollend', syncPaintAfterScroll, true);
  window.addEventListener('resize', () => {
    scheduleReflow();
    progressChunkContentY = new Map();
    renderSemanticMatchProgress();
    clampBarIntoViewport();
  });
  window.visualViewport?.addEventListener('resize', scheduleReflow);

  function toggle(prefillQuery) {
    const bar = ui$('semantic_find_bar');
    if (bar && !bar.hidden) close();
    else void open(prefillQuery);
  }

  return { open, close, destroy, toggle };
  };
})();
