/**
 * 高亮色阶、两档密度、绘制形式：纯函数 + storage 默认值。
 * RGB 与站点 SurprisalColorConfig 同步；100% 强度的 alpha 见 PAINT_CAP。
 */
globalThis.IH_highlightStyle ||= (function () {
  const TOKEN_LEVELS = 16;
  /** SYNC: client/src/shared/cross/surprisalMath.ts → REFERENCE_MAX_SURPRISAL_BITS */
  const MAX_SURPRISAL_BITS = 18;
  /** SYNC: SurprisalColorConfig → SURPRISAL_RED_RGB */
  const SURPRISAL_RED_RGB = '255, 71, 64';

  const KEY_TWO_TIER = 'ih_two_tier';
  const KEY_THRESHOLD_PCT = 'ih_highlight_threshold_pct';
  /** 用户侧强度 5–100%；100% = PAINT_CAP[该表面实际形式] */
  const KEY_MAX_ALPHA_DEPTH = 'ih_max_highlight_alpha';
  const KEY_PAINT_STYLE = 'ih_paint_style';

  const PAINT_BLOCK = 'block';
  const PAINT_UNDERLINE = 'underline';
  const PAINT_STYLES = Object.freeze([PAINT_BLOCK, PAINT_UNDERLINE]);
  /** 表面画不了所选形式时回退。PDF 色块会盖住 canvas 字形。 */
  const PAINT_FALLBACK = Object.freeze({
    pdf: Object.freeze({ [PAINT_BLOCK]: PAINT_UNDERLINE }),
  });

  const INTENSITY_MIN = 5;
  const INTENSITY_MAX = 100;
  /** 各形式 100% 强度对应的 alpha。色块 SYNC: surprisalColorWeakenManager → WEAKENED_SURPRISAL_MAX_ALPHA */
  const PAINT_CAP = Object.freeze({
    [PAINT_BLOCK]: 0.5,
    [PAINT_UNDERLINE]: 1,
  });
  /** 网页深色压彩度。PDF 纸面仍是白底，不乘。 */
  const DARK_ALPHA_SCALE = 0.8;
  /** 下划线相对 used font-size（16px 时网页 = 2px 粗 / 3px 距） */
  const UNDERLINE_THICKNESS = 0.125;
  const UNDERLINE_OFFSET = 0.1875;
  /** PDF overlay：rect.bottom 低于基线，相对盒底再上移（16px 时 1px） */
  const UNDERLINE_OVERLAY_LIFT = 0.0625;

  /** chrome.storage.local 默认；强度整数，运行时 (pct/100)*PAINT_CAP[resolve 后形式] → maxAlpha */
  const STORAGE_DEFAULTS = {
    [KEY_TWO_TIER]: false,
    [KEY_THRESHOLD_PCT]: 25,
    [KEY_MAX_ALPHA_DEPTH]: 100,
    [KEY_PAINT_STYLE]: PAINT_BLOCK,
  };

  function clampInt(n, lo, hi) {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
  }

  function clampThresholdPct(n) {
    return clampInt(n, 0, 100);
  }

  function clampMaxAlphaDepth(n) {
    return clampInt(n, INTENSITY_MIN, INTENSITY_MAX);
  }

  function capAlpha(paintStyle) {
    return PAINT_CAP[normalizePaintStyle(paintStyle)];
  }

  function schemeDark() {
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    return !!(mq && mq.matches);
  }

  function depthToMaxAlpha(depth, paintStyle, surface) {
    const a = (clampMaxAlphaDepth(depth) / 100) * capAlpha(resolvePaintStyle(paintStyle, surface));
    if (surface === 'pdf' || !schemeDark()) return a;
    return a * DARK_ALPHA_SCALE;
  }

  /** @param {() => void} onChange */
  function watchColorScheme(onChange) {
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq || typeof mq.addEventListener !== 'function') return;
    mq.addEventListener('change', onChange);
  }

  function thresholdBits(pct) {
    return (clampThresholdPct(pct) / 100) * MAX_SURPRISAL_BITS;
  }

  function formatThresholdLabel(pct) {
    const p = clampThresholdPct(pct);
    const bits = thresholdBits(p);
    const bitStr = Number.isInteger(bits) ? String(bits) : (Math.round(bits * 10) / 10).toFixed(1);
    return `${p}% (${bitStr} bit)`;
  }

  function formatDepthLabel(depth) {
    return `${clampMaxAlphaDepth(depth)}%`;
  }

  function normalizePaintStyle(v) {
    return PAINT_STYLES.includes(v) ? v : PAINT_BLOCK;
  }

  /**
   * @param {string} requested
   * @param {string} surface `'web'` | `'pdf'`
   */
  function resolvePaintStyle(requested, surface) {
    const style = normalizePaintStyle(requested);
    return PAINT_FALLBACK[surface]?.[style] ?? style;
  }

  /**
   * @param {number} level 0..TOKEN_LEVELS-1
   * @param {number} maxAlpha
   * @param {boolean} twoTier
   */
  function alphaForLevel(level, maxAlpha, twoTier) {
    if (twoTier) return level === TOKEN_LEVELS - 1 ? maxAlpha : 0;
    return (level / TOKEN_LEVELS) * maxAlpha;
  }

  /**
   * @param {number} bits
   * @param {{ twoTier: boolean, thresholdPct: number }} prefs
   * @returns {number} level，或 -1 表示不画
   */
  function tokenLevelFromBits(bits, prefs) {
    if (!Number.isFinite(bits)) return -1;
    if (prefs.twoTier) {
      return bits >= thresholdBits(prefs.thresholdPct) ? TOKEN_LEVELS - 1 : -1;
    }
    const t = Math.max(0, Math.min(1, bits / MAX_SURPRISAL_BITS));
    const level = Math.min(TOKEN_LEVELS - 1, Math.floor(t * TOKEN_LEVELS));
    return level < 1 ? -1 : level;
  }

  /** @param {Record<string, unknown>} raw storage get 结果 */
  function normalizePrefs(raw) {
    return {
      twoTier: !!(raw?.[KEY_TWO_TIER] ?? STORAGE_DEFAULTS[KEY_TWO_TIER]),
      thresholdPct: clampThresholdPct(
        raw?.[KEY_THRESHOLD_PCT] ?? STORAGE_DEFAULTS[KEY_THRESHOLD_PCT],
      ),
      maxAlphaDepth: clampMaxAlphaDepth(
        raw?.[KEY_MAX_ALPHA_DEPTH] ?? STORAGE_DEFAULTS[KEY_MAX_ALPHA_DEPTH],
      ),
      paintStyle: normalizePaintStyle(
        raw?.[KEY_PAINT_STYLE] ?? STORAGE_DEFAULTS[KEY_PAINT_STYLE],
      ),
    };
  }

  /**
   * 写入 --ih-token-* / --ih-token-bg-* / --ih-paint-deco；网页 ::highlight 即时跟随，无需重绑 Range。
   * @param {HTMLElement} [root]
   * @param {{ twoTier: boolean, maxAlphaDepth: number, paintStyle: string }} prefs
   */
  function applyCssVars(root, prefs) {
    const el = root || document.documentElement;
    const paintStyle = normalizePaintStyle(prefs.paintStyle);
    const underline = paintStyle === PAINT_UNDERLINE;
    const maxAlpha = depthToMaxAlpha(prefs.maxAlphaDepth, paintStyle);
    el.style.setProperty('--ih-paint-deco', underline ? 'underline' : 'none');
    el.style.setProperty('--ih-underline-thickness', `${UNDERLINE_THICKNESS * 100}%`);
    el.style.setProperty('--ih-underline-offset', `${UNDERLINE_OFFSET * 100}%`);
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      const a = alphaForLevel(i, maxAlpha, !!prefs.twoTier);
      const color = `rgba(${SURPRISAL_RED_RGB}, ${a})`;
      el.style.setProperty(`--ih-token-${i}`, color);
      el.style.setProperty(`--ih-token-bg-${i}`, underline ? 'transparent' : color);
    }
  }

  /**
   * PDF overlay：text layer 的 client rect 贴字形底；线贴盒底内侧再上移 UNDERLINE_OVERLAY_LIFT。
   * 粗细 = 字盒高 × UNDERLINE_THICKNESS。
   * @param {{ left: number, bottom: number, width: number, height: number }} rect
   * @param {{ left: number, top: number }} hostRect
   */
  function underlineOverlayBox(rect, hostRect) {
    const thickness = rect.height * UNDERLINE_THICKNESS;
    const lift = rect.height * UNDERLINE_OVERLAY_LIFT;
    return {
      x: rect.left - hostRect.left,
      y: rect.bottom - hostRect.top - thickness - lift,
      width: rect.width,
      height: thickness,
    };
  }

  return {
    TOKEN_LEVELS,
    MAX_SURPRISAL_BITS,
    SURPRISAL_RED_RGB,
    KEY_TWO_TIER,
    KEY_THRESHOLD_PCT,
    KEY_MAX_ALPHA_DEPTH,
    KEY_PAINT_STYLE,
    PAINT_BLOCK,
    PAINT_UNDERLINE,
    PAINT_STYLES,
    INTENSITY_MIN,
    INTENSITY_MAX,
    PAINT_CAP,
    DARK_ALPHA_SCALE,
    UNDERLINE_THICKNESS,
    UNDERLINE_OFFSET,
    UNDERLINE_OVERLAY_LIFT,
    STORAGE_DEFAULTS,
    clampThresholdPct,
    clampMaxAlphaDepth,
    capAlpha,
    depthToMaxAlpha,
    watchColorScheme,
    thresholdBits,
    formatThresholdLabel,
    formatDepthLabel,
    normalizePaintStyle,
    resolvePaintStyle,
    alphaForLevel,
    tokenLevelFromBits,
    normalizePrefs,
    applyCssVars,
    underlineOverlayBox,
  };
})();
