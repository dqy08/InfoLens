/**
 * 高亮色阶、两档密度、绘制形式：纯函数 + storage 默认值。
 * RGB 与站点 SurprisalColorConfig 同步；100% 强度的 alpha 见 PAINT_CAP。
 */
globalThis.IH_highlightStyle ||= (function () {
  const TOKEN_LEVELS = 16;
  /** SYNC: client/src/shared/cross/surprisalMath.ts → REFERENCE_MAX_SURPRISAL_BITS */
  const MAX_SURPRISAL_BITS = 18;
  /** SYNC: SurprisalColorConfig → SURPRISAL_RED_RGB；色相滑条的 S/L 锁在这颗红上 */
  const SURPRISAL_RED_RGB = '255, 71, 64';

  const KEY_TWO_TIER = 'ih_two_tier';
  const KEY_THRESHOLD_PCT = 'ih_highlight_threshold_pct';
  /** 用户侧强度 5–150%；100% = PAINT_CAP[该表面实际形式]，再高按比例加深，α 上限 1 */
  const KEY_MAX_ALPHA_DEPTH = 'ih_max_highlight_alpha';
  const KEY_PAINT_STYLE = 'ih_paint_style';
  const KEY_HIGHLIGHT_COLOR = 'ih_highlight_color';
  const KEY_TEXT_COLOR = 'ih_text_color';

  const PAINT_BLOCK = 'block';
  const PAINT_UNDERLINE = 'underline';
  const PAINT_TEXT = 'text';
  const PAINT_STYLES = Object.freeze([PAINT_BLOCK, PAINT_UNDERLINE, PAINT_TEXT]);
  /** 表面画不了所选形式时回退。PDF 色块会盖住 canvas 字形；字色也改不了 canvas。 */
  const PAINT_FALLBACK = Object.freeze({
    pdf: Object.freeze({ [PAINT_BLOCK]: PAINT_UNDERLINE, [PAINT_TEXT]: PAINT_UNDERLINE }),
  });

  const INTENSITY_MIN = 5;
  const INTENSITY_MAX = 150;
  /** 各形式 100% 强度对应的 alpha。色块 SYNC: surprisalColorWeakenManager → WEAKENED_SURPRISAL_MAX_ALPHA */
  const PAINT_CAP = Object.freeze({
    [PAINT_BLOCK]: 0.5,
    [PAINT_UNDERLINE]: 1,
    [PAINT_TEXT]: 1,
  });
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
    [KEY_HIGHLIGHT_COLOR]: 0,
    [KEY_TEXT_COLOR]: 'red',
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

  function depthToMaxAlpha(depth, paintStyle, surface) {
    return Math.min(
      1,
      (clampMaxAlphaDepth(depth) / 100) * capAlpha(resolvePaintStyle(paintStyle, surface)),
    );
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

  function parseRgbParts(rgb) {
    const p = String(rgb).split(',').map((s) => Number(s.trim()));
    if (p.length < 3 || p.some((n) => !Number.isFinite(n))) {
      throw new Error(`bad rgb: ${rgb}`);
    }
    return p;
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s, l };
  }

  function hslToRgb(h, s, l) {
    const hue = ((Number(h) % 360) + 360) % 360;
    const f = (n) => {
      const k = (n + hue / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [
      Math.round(f(0) * 255),
      Math.round(f(8) * 255),
      Math.round(f(4) * 255),
    ];
  }

  const RED_HSL = rgbToHsl(...parseRgbParts(SURPRISAL_RED_RGB));
  /** 与默认红同一档：够见、不发白。色相滑条只动 H。 */
  const HIGHLIGHT_S = RED_HSL.s;
  const HIGHLIGHT_L = RED_HSL.l;
  const HUE_RED = Math.round(RED_HSL.h);
  const HUE_MIN = 0;
  const HUE_MAX = 359;
  STORAGE_DEFAULTS[KEY_HIGHLIGHT_COLOR] = HUE_RED;

  /** 色相轴上的典型色（约 30° 一档）；琥珀/金并进橙与黄，玫红并进红。 */
  const COLOR_HUE = Object.freeze({
    red: 0,
    orange: 30,
    yellow: 60,
    lime: 90,
    green: 120,
    teal: 150,
    cyan: 180,
    azure: 210,
    blue: 240,
    purple: 270,
    magenta: 300,
    pink: 330,
  });
  const COLOR_IDS = Object.freeze(Object.keys(COLOR_HUE));
  /** 无色相：中性灰，靠 alpha 在深浅底上显形；不进色相滑条。 */
  const COLOR_INK = 'ink';
  const RGB_INK = '128, 128, 128';
  const LEGACY_COLOR_HUE = Object.freeze({
    ...COLOR_HUE,
    amber: 30,
    gold: 60,
    rose: 0,
  });

  function hueForColorId(id) {
    return Object.hasOwn(COLOR_HUE, id) ? COLOR_HUE[id] : HUE_RED;
  }

  function wrapHue(n) {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) return HUE_RED;
    return ((x % 360) + 360) % 360;
  }

  function isInk(v) {
    return v === COLOR_INK;
  }

  function normalizeHighlightHue(v) {
    if (typeof v === 'string' && Object.hasOwn(LEGACY_COLOR_HUE, v)) return LEGACY_COLOR_HUE[v];
    return wrapHue(v);
  }

  function normalizeHighlightColor(v) {
    return isInk(v) ? COLOR_INK : normalizeHighlightHue(v);
  }

  function rgbForHue(v) {
    const [r, g, b] = hslToRgb(normalizeHighlightHue(v), HIGHLIGHT_S, HIGHLIGHT_L);
    return `${r}, ${g}, ${b}`;
  }

  function rgbForColor(v) {
    if (isInk(v)) return RGB_INK;
    return rgbForHue(v);
  }

  /**
   * 字色终点：红绿蓝。红、蓝钉在相对亮度 ≈ 0.18（对白/对黑约 4.5）；
   * 绿在同一明度会发闷，单独抬到 ≈ 0.38，白底对比会弱一些。
   * 彩度取该明度、该色相在 sRGB 内的上沿。
   */
  const TEXT_COLOR = Object.freeze({
    red: '234, 0, 33',
    green: '0, 191, 67',
    blue: '0, 114, 233',
  });
  const TEXT_COLOR_IDS = Object.freeze(Object.keys(TEXT_COLOR));

  function normalizeTextColor(v) {
    return Object.hasOwn(TEXT_COLOR, v) ? v : 'red';
  }

  function rgbForTextColor(id) {
    return TEXT_COLOR[normalizeTextColor(id)];
  }

  function hueTrackCss() {
    const parts = [];
    for (let i = 0; i <= 12; i++) {
      parts.push(`rgb(${rgbForHue(i * 30)}) ${(i / 12) * 100}%`);
    }
    return `linear-gradient(to right, ${parts.join(', ')})`;
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
      highlightColor: normalizeHighlightColor(
        raw?.[KEY_HIGHLIGHT_COLOR] ?? STORAGE_DEFAULTS[KEY_HIGHLIGHT_COLOR],
      ),
      textColor: normalizeTextColor(
        raw?.[KEY_TEXT_COLOR] ?? STORAGE_DEFAULTS[KEY_TEXT_COLOR],
      ),
    };
  }

  /**
   * 写入色阶变量与 --ih-token-pct-*。
   * @param {HTMLElement} [root]
   * @param {{ twoTier: boolean, maxAlphaDepth: number, paintStyle: string, highlightColor?: number | string, textColor?: string }} prefs
   */
  function applyCssVars(root, prefs) {
    const el = root || document.documentElement;
    const paintStyle = normalizePaintStyle(prefs.paintStyle);
    const text = paintStyle === PAINT_TEXT;
    const rgb = text ? rgbForTextColor(prefs.textColor) : rgbForColor(prefs.highlightColor);
    const underline = paintStyle === PAINT_UNDERLINE;
    const maxAlpha = depthToMaxAlpha(prefs.maxAlphaDepth, paintStyle);
    el.style.setProperty('--ih-highlight-rgb', rgb);
    el.style.setProperty('--ih-paint-deco', underline ? 'underline' : 'none');
    el.style.setProperty('--ih-underline-thickness', `${UNDERLINE_THICKNESS * 100}%`);
    el.style.setProperty('--ih-underline-offset', `${UNDERLINE_OFFSET * 100}%`);
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      const a = alphaForLevel(i, maxAlpha, !!prefs.twoTier);
      const color = `rgba(${rgb}, ${a})`;
      el.style.setProperty(`--ih-token-${i}`, color);
      el.style.setProperty(`--ih-token-bg-${i}`, underline || text ? 'transparent' : color);
      if (text) el.style.setProperty(`--ih-token-pct-${i}`, `${a * 100}%`);
      else el.style.removeProperty(`--ih-token-pct-${i}`);
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
    HIGHLIGHT_S,
    HIGHLIGHT_L,
    HUE_RED,
    HUE_MIN,
    HUE_MAX,
    COLOR_IDS,
    COLOR_INK,
    TEXT_COLOR_IDS,
    KEY_TWO_TIER,
    KEY_THRESHOLD_PCT,
    KEY_MAX_ALPHA_DEPTH,
    KEY_PAINT_STYLE,
    KEY_HIGHLIGHT_COLOR,
    KEY_TEXT_COLOR,
    PAINT_BLOCK,
    PAINT_UNDERLINE,
    PAINT_TEXT,
    PAINT_STYLES,
    INTENSITY_MIN,
    INTENSITY_MAX,
    PAINT_CAP,
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
    normalizeHighlightHue,
    normalizeHighlightColor,
    isInk,
    hueForColorId,
    rgbForHue,
    rgbForColor,
    normalizeTextColor,
    rgbForTextColor,
    hueTrackCss,
    resolvePaintStyle,
    alphaForLevel,
    tokenLevelFromBits,
    normalizePrefs,
    applyCssVars,
    underlineOverlayBox,
  };
})();
