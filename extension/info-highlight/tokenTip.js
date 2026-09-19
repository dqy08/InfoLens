/**
 * Token 悬停面板：网页 token 只绑 ::highlight、没有 DOM 可挂事件，
 * 故由 caretPositionFromPoint 反查指针下的字，再按码点偏移二分到 token。
 * 内容取站点 tooltip 的精简版：token 文字 + 信息量一行 + Top-K 条形图；底部另附本轮 result.model。
 * SYNC: client/src/shared/vis/ToolTip.ts → 行文案、d3.format('.3g') 数值格式与右下偏移
 * SYNC: client/src/shared/cross/topkChartUtils.ts → 行结构、省略行、条形与百分比
 */
globalThis.IH_tokenTip ||= (function () {
  const TIP_ID = 'ih-token-tip';
  /** 面板与命中字之间的留白（px） */
  const OFFSET_PX = 15;
  const DISPLAY_TOPK = 10;
  /**
   * 站点是正文 12pt、tooltip 9pt；插件的正文是宿主页的，故按命中处字号乘同一比例。
   * SYNC: client/src/css/components/_lmf-readout.scss → lmf-readout-text 的 12pt
   */
  const TIP_FONT_RATIO = 9 / 12;
  /** 面板内尺寸一律以 em 计，随字号等比；换算基准为站点的 9pt = 12px */
  const MAX_BAR_WIDTH_EM = 5;
  const BAR_CELL_WIDTH_EM = 9.17;

  /**
   * 宿主的样式必须走内联：宿主本身是宿主页 DOM 里的一个 div，页面的 `div {…}` 规则
   * 在宿主这一层压过影子树里的 `:host`，只有内联声明能稳赢（`!important` 除外）。
   * `all: initial` 挡住宿主页可继承属性（字体、letter-spacing 等）漏进影子树。
   * SYNC: extension/semantic-highlight/semantic/find.js → HOST_CSS
   */
  const HOST_STYLE =
    'all: initial; position: fixed; inset: 0; z-index: 2147483646;' +
    ' display: block; pointer-events: none;';

  /**
   * 配色随插件自己的浮层，不跟站点主题变量。
   * SYNC: client/src/css/pages/_app-pages.scss → .tooltip / .currentToken
   */
  const TIP_CSS = `
.panel {
  position: absolute;
  /* 站点 .tooltip 的 16rem（=256px）按 9pt 折成 em，随字号同比放缩 */
  max-width: min(21.3em, calc(100vw - 24px));
  padding: 0.417em;
  box-sizing: border-box;
  border: 1.5px solid #5f6368;
  border-radius: 5px;
  background: #3c4043;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.28);
  color: #e8eaed;
  font: 500 1em/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  user-select: none;
  overflow-wrap: break-word;
}
/* 等宽以便分辨连续的 · */
.token {
  margin-bottom: 0.333em;
  color: #ff6666;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.label { color: #9aa0a6; }
.model {
  margin-top: 0.5em;
  color: #7e868c;
  font-size: 0.75em;
  font-weight: 400;
}

/* 命中 token 在正文里的蓝框；::highlight() 只能改字色底色，画不了边框，故用覆盖层
 * SYNC: client/src/css/pages/_app-pages.scss → .token:hover 的 outline / box-shadow */
.box {
  position: absolute;
  border-radius: 6px;
  outline: 2px solid #5c8dff;
  box-shadow: 0 0 5px rgba(92, 141, 255, 0.8), 0 0 9px rgba(92, 141, 255, 0.8);
}

/* SYNC: client/src/css/pages/_app-pages.scss → .predictions-table 下各 .topk-chart-* */
.topk {
  display: table;
  table-layout: fixed;
  margin-top: 0.333em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.topk-row { display: table-row; }
.topk-row.is-selected { color: #ff6666; }
.topk-ellipsis {
  display: block;
  padding-left: 2.5em;
  font-weight: bold;
}
.topk-bar-cell {
  display: table-cell;
  padding-left: 0.417em;
  vertical-align: baseline;
}
.topk-bar-fill {
  display: inline-block;
  height: 0.833em;
  background-color: currentColor;
  vertical-align: middle;
}
.topk-token-cell {
  display: table-cell;
  padding-right: 0.417em;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* 浮层浅色：与 shared/ui/overlay.css 进度图 / 状态条同一套边框底色 */
@media (prefers-color-scheme: light) {
  .panel {
    border-color: #dadce0;
    background: #fff;
    color: #333;
    box-shadow: 0 1px 3px rgba(60, 64, 67, 0.22), 0 4px 8px rgba(60, 64, 67, 0.15);
  }
  .token { color: #933; }
  .label { color: #666; }
  .model { color: #9aa0a6; }
  .topk-row.is-selected { color: #933; }
  .box {
    outline-color: #1e6fff;
    box-shadow: 0 0 5px rgba(30, 111, 255, 0.6), 0 0 9px rgba(30, 111, 255, 0.6);
  }
}
`;

  /** @type {HTMLElement | null} 影子宿主；铺满视口，面板与蓝框都是它的绝对定位子节点 */
  let host = null;
  /** @type {ShadowRoot | null} */
  let shadow = null;
  /** @type {HTMLElement | null} */
  let panel = null;
  /** @type {HTMLElement[]} 命中 token 的蓝框，跨行时一行一个 */
  let boxEls = [];

  /** @type {{ text: string, pieces: Array<{ node: Text, start: number, end: number }> } | null} */
  let mapped = null;
  /** @type {ReturnType<typeof globalThis.IL_createTextIndex> | null} */
  let idx = null;
  /** @type {Map<Text, { start: number, end: number }>} */
  let pieceOf = new Map();
  /** 按 offset 升序（段按序分析），供二分 */
  let tokens = [];
  let raf = 0;
  /** @type {{ x: number, y: number } | null} */
  let pointer = null;
  /** 正在展示的 token；指针仍在同一 token 上时不重绘 */
  let shown = null;
  /** 本轮分析返回的 result.model；全局一份，不进 token */
  let modelName = '';
  /** options.js 的 show_token_tip；默认开 */
  let enabled = true;
  chrome.storage?.local?.get({ show_token_tip: true }, (res) => {
    enabled = res?.show_token_tip !== false;
  });
  chrome.storage?.onChanged?.addListener((changes) => {
    if ('show_token_tip' in changes) {
      enabled = changes.show_token_tip.newValue !== false;
      if (!enabled) hide();
    }
  });

  /** 与 d3.format('.3g') 同：3 位有效数字，指数越界时转科学计数 */
  function sig3(v) {
    const exp = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(v)));
    return exp < -4 || exp >= 3 ? v.toExponential(2) : v.toPrecision(3);
  }

  /**
   * SYNC: client/src/shared/cross/tokenDisplayUtils.ts → visualizeSpecialChars
   * 空白与站点同标签；其余控制/格式字符标码点。不搬站点那张可打印白名单。
   */
  function visualize(text) {
    return Array.from(
      text
        .replace(/\r\n/g, '[CRLF]')
        .replace(/\n/g, '[LF]')
        .replace(/\r/g, '[CR]')
        .replace(/\t/g, '[TAB]')
        .replace(/\u3000/g, '[FS]')
        .replace(/ /g, '·'),
      (ch) => (/[\p{Cc}\p{Cf}]/u.test(ch)
        ? `[${ch.codePointAt(0).toString(16).toLowerCase().padStart(4, '0')}]`
        : ch),
    ).join('');
  }

  /** 挂在 documentElement 上：body 可能被宿主页 transform，fixed 会退化成相对 body 定位 */
  function ensurePanel() {
    if (panel) return panel;
    host = document.createElement('div');
    host.id = TIP_ID;
    host.style.cssText = HOST_STYLE;
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TIP_CSS;
    panel = document.createElement('div');
    panel.className = 'panel';
    shadow.append(style, panel);
    document.documentElement.appendChild(host);
    return panel;
  }

  /** 从文档摘掉宿主；不靠 display:none（页面 `div { display:… !important }` 能盖过内联）。 */
  function dropHost() {
    host?.remove();
    host = null;
    shadow = null;
    panel = null;
    boxEls = [];
    document.querySelectorAll(`#${TIP_ID}`).forEach((el) => el.remove());
  }

  function hide() {
    shown = null;
    pointer = null;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    dropHost();
  }

  function appendRow(parent, label, value) {
    const row = document.createElement('div');
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = ` ${value}`;
    row.append(l, v);
    parent.appendChild(row);
  }

  /** 前 DISPLAY_TOPK 名；实际 token 不在其中时补一行省略号再补它自己 */
  function topkRows(tok) {
    const rows = tok.pred_topk.slice(0, DISPLAY_TOPK).map(([token, prob]) => ({ token, prob }));
    if (!rows.length || !tok.raw || tok.p == null) return rows;
    if (rows.some((r) => r.token === tok.raw)) return rows;
    return [...rows, { token: null, prob: 0 }, { token: tok.raw, prob: tok.p }];
  }

  /**
   * SYNC: client/src/shared/cross/topkChartUtils.ts → probabilitiesEffectivelyEqual
   * real_topk 与 pred_topk 各自舍入，不能用 ===。
   */
  function probsEq(a, b) {
    if (a === b) return true;
    const d = Math.abs(a - b);
    return d < 1e-12 || d / Math.max(Math.abs(a), Math.abs(b), 1e-15) < 1e-9;
  }

  /** 红色高亮行：token 与概率都对上的第一行，否则只按 token 对的第一行 */
  function selectedRow(rows, tok) {
    const both = rows.findIndex((r) => r.token === tok.raw && probsEq(r.prob, tok.p));
    return both >= 0 ? both : rows.findIndex((r) => r.token === tok.raw);
  }

  function appendTopk(parent, tok) {
    const rows = topkRows(tok);
    if (!rows.length) return;
    const selected = selectedRow(rows, tok);
    const table = document.createElement('div');
    table.className = 'topk';
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      if (r.token === null) {
        row.className = 'topk-ellipsis';
        row.textContent = '⋮';
        table.appendChild(row);
        return;
      }
      row.className = i === selected ? 'topk-row is-selected' : 'topk-row';
      const barCell = document.createElement('div');
      barCell.className = 'topk-bar-cell';
      barCell.style.width = `${BAR_CELL_WIDTH_EM}em`;
      const fill = document.createElement('span');
      fill.className = 'topk-bar-fill';
      fill.style.width = `${r.prob * MAX_BAR_WIDTH_EM}em`;
      const pct = document.createElement('span');
      pct.textContent = ` ${sig3(r.prob * 100)}%`;
      barCell.append(fill, pct);
      const tokenCell = document.createElement('div');
      tokenCell.className = 'topk-token-cell';
      tokenCell.textContent = visualize(r.token);
      row.append(barCell, tokenCell);
      table.appendChild(row);
    });
    parent.appendChild(table);
  }

  /** @param {Element} textEl 命中字所在元素，面板字号按它的正文字号折算 */
  function render(tok, textEl) {
    const el = ensurePanel();
    host.style.fontSize = `${parseFloat(getComputedStyle(textEl).fontSize) * TIP_FONT_RATIO}px`;
    el.replaceChildren();
    const head = document.createElement('div');
    head.className = 'token';
    head.textContent = visualize(tok.raw);
    el.appendChild(head);
    const bits = globalThis.IH_tokenBits(tok);
    if (bits != null) appendRow(el, 'information:', `${sig3(bits)} bits`);
    appendTopk(el, tok);
    if (modelName) {
      const foot = document.createElement('div');
      foot.className = 'model';
      foot.textContent = modelName;
      el.appendChild(foot);
    }
  }

  /** 默认贴命中字的右下；越界则翻到左 / 上 */
  function place(rect) {
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    let x = rect.right + OFFSET_PX;
    let y = rect.bottom + OFFSET_PX;
    if (x + w > window.innerWidth) x = Math.max(5, rect.left - w - OFFSET_PX);
    if (y + h > window.innerHeight) y = Math.max(5, rect.top - h - OFFSET_PX);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  }

  /**
   * 命中 token 在正文里描蓝框；宿主铺满视口，故直接用 client rect 坐标。
   * @returns {DOMRect | null} 首行的框，供面板贴靠
   */
  function drawBoxes(u0, u1) {
    for (const el of boxEls) el.remove();
    boxEls = [];
    let first = null;
    for (const range of globalThis.IH_rangesFromUtf16(mapped.pieces, mapped.text, u0, u1)) {
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const box = document.createElement('div');
        box.className = 'box';
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        shadow.appendChild(box);
        boxEls.push(box);
        first ||= rect;
      }
    }
    return first;
  }

  /**
   * caret 会吸附到最近的字（页边空白、行尾之外也返回），故用指针是否真落在字盒内复核。
   * 指针在字的右半时 caret 给的是后一个位置，两侧都试。
   */
  function charUnderPoint(node, caretOffset, x, y) {
    for (const start of [caretOffset, caretOffset - 1]) {
      if (start < 0 || start + 1 > node.length) continue;
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, start + 1);
      for (const rect of r.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return { start, rect };
        }
      }
    }
    return null;
  }

  /** @param {number} cp 全文码点偏移 */
  function tokenAtCp(cp) {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const off = tokens[mid].offset;
      if (cp < off[0]) hi = mid - 1;
      else if (cp >= off[1]) lo = mid + 1;
      else return tokens[mid];
    }
    return null;
  }

  function update() {
    raf = 0;
    if (!enabled || !pointer || !mapped) return hide();
    const { x, y } = pointer;
    const pos = document.caretPositionFromPoint(x, y);
    const node = pos?.offsetNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return hide();
    const piece = pieceOf.get(node);
    if (!piece) return hide();
    const hit = charUnderPoint(node, pos.offset, x, y);
    if (!hit) return hide();
    const tok = tokenAtCp(idx.utf16ToCp(piece.start + hit.start));
    if (!tok) return hide();
    if (tok === shown) return;
    shown = tok;
    render(tok, node.parentElement);
    // 贴 token 的框而非命中的那个字，指针在同一 token 上移动时面板不动
    place(drawBoxes(idx.cpToUtf16(tok.offset[0]), idx.cpToUtf16(tok.offset[1])) ?? hit.rect);
  }

  function onMove(e) {
    // 按住拖动：划选文字或中键滚屏，此时不该打扰；松开后下一次移动自会重新出现
    if (e.buttons) return hide();
    pointer = { x: e.clientX, y: e.clientY };
    if (!raf) raf = requestAnimationFrame(update);
  }

  /** @param {string} name 本轮 `result.model` */
  function setModel(name) {
    modelName = typeof name === 'string' ? name.trim() : '';
  }

  /** @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }> }} next */
  function bind(next) {
    modelName = '';
    mapped = next;
    idx = globalThis.IL_createTextIndex(next.text);
    pieceOf = new Map(next.pieces.map((p) => [p.node, p]));
    tokens = [];
    // 缺 API 只关面板，热力图照画
    if (typeof document.caretPositionFromPoint !== 'function') return;
    document.addEventListener('pointermove', onMove, { capture: true, passive: true });
    document.addEventListener('scroll', hide, { capture: true, passive: true });
    document.documentElement.addEventListener('pointerleave', hide, { capture: true, passive: true });
    window.addEventListener('resize', hide);
  }

  /** @param {Array<{ offset: [number, number], pred_topk?: unknown }>} next 全文码点坐标，与 paintTokens 同一批。无 pred_topk 的是磁盘缓存条，不进面板。 */
  function add(next) {
    if (!mapped) throw new Error('IH_tokenTip.add before bind');
    for (const tok of next) {
      if (Array.isArray(tok.pred_topk)) tokens.push(tok);
    }
  }

  function clear() {
    document.removeEventListener('pointermove', onMove, { capture: true });
    document.removeEventListener('scroll', hide, { capture: true });
    document.documentElement.removeEventListener('pointerleave', hide, { capture: true });
    window.removeEventListener('resize', hide);
    hide();
    mapped = null;
    idx = null;
    pieceOf = new Map();
    tokens = [];
    modelName = '';
  }

  return { bind, add, clear, setModel };
})();
