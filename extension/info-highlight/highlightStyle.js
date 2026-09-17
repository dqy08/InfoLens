/**
 * 高亮色阶与两档密度：纯函数 + storage 默认值。
 * RGB 与站点 SurprisalColorConfig 同步；maxAlpha 可配（默认 0.5 ≈ 站点 weaken）。
 */
globalThis.IH_highlightStyle ||= (function () {
  const TOKEN_LEVELS = 16;
  /** SYNC: client/src/shared/cross/surprisalMath.ts → REFERENCE_MAX_SURPRISAL_BITS */
  const MAX_SURPRISAL_BITS = 18;
  /** SYNC: SurprisalColorConfig → SURPRISAL_RED_RGB */
  const SURPRISAL_RED_RGB = '255, 71, 64';

  const KEY_TWO_TIER = 'ih_two_tier';
  const KEY_THRESHOLD_PCT = 'ih_highlight_threshold_pct';
  /** 用户侧强度 5–100%；100% = 改动前默认 maxAlpha（不可再强） */
  const KEY_MAX_ALPHA_DEPTH = 'ih_max_highlight_alpha';

  const INTENSITY_MIN = 5;
  const INTENSITY_MAX = 100;
  /** SYNC: surprisalColorWeakenManager → WEAKENED_SURPRISAL_MAX_ALPHA */
  const CAP_ALPHA = 0.5;

  /** chrome.storage.local 默认；强度整数，运行时 (pct/100)*CAP_ALPHA → maxAlpha */
  const STORAGE_DEFAULTS = {
    [KEY_TWO_TIER]: false,
    [KEY_THRESHOLD_PCT]: 25,
    [KEY_MAX_ALPHA_DEPTH]: 100,
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

  function depthToMaxAlpha(depth) {
    return (clampMaxAlphaDepth(depth) / 100) * CAP_ALPHA;
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
    };
  }

  /**
   * 写入 --ih-token-*；网页 ::highlight 即时跟随，无需重绑 Range。
   * @param {HTMLElement} [root]
   * @param {number} maxAlpha
   * @param {boolean} twoTier
   */
  function applyCssVars(root, maxAlpha, twoTier) {
    const el = root || document.documentElement;
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      const a = alphaForLevel(i, maxAlpha, twoTier);
      el.style.setProperty(`--ih-token-${i}`, `rgba(${SURPRISAL_RED_RGB}, ${a})`);
    }
  }

  return {
    TOKEN_LEVELS,
    MAX_SURPRISAL_BITS,
    SURPRISAL_RED_RGB,
    KEY_TWO_TIER,
    KEY_THRESHOLD_PCT,
    KEY_MAX_ALPHA_DEPTH,
    INTENSITY_MIN,
    INTENSITY_MAX,
    CAP_ALPHA,
    STORAGE_DEFAULTS,
    clampThresholdPct,
    clampMaxAlphaDepth,
    depthToMaxAlpha,
    thresholdBits,
    formatThresholdLabel,
    formatDepthLabel,
    alphaForLevel,
    tokenLevelFromBits,
    normalizePrefs,
    applyCssVars,
  };
})();
