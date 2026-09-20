/**
 * 浏览器词切分（Intl.Segmenter）→ 恰好铺满一词的连续整 token 合成一块，供着色。
 * offset 与 Analyze 一致：Unicode 码点下标。对不齐则不合并。信息量（bit）相加。
 */
globalThis.IH_mergeWordTokens ||= (function () {
  function utf16ToCp(text, utf16Index) {
    const s = text || '';
    const limit = Math.max(0, Math.min(utf16Index, s.length));
    let i = 0;
    let cps = 0;
    while (i < limit) {
      const cp = s.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      cps += 1;
    }
    return cps;
  }

  function sliceByCp(text, start, end) {
    const chars = Array.from(text || '');
    const a = Math.max(0, Math.min(start, chars.length));
    const b = Math.max(a, Math.min(end, chars.length));
    return chars.slice(a, b).join('');
  }

  function tokenProb(tok) {
    if (Number.isFinite(tok?.p)) return tok.p;
    const p = tok?.real_topk?.[1];
    return Number.isFinite(p) ? p : null;
  }

  function bitsFromProb(p) {
    return -Math.log2(Math.max(p, Number.EPSILON));
  }

  /**
   * 连续整 token 恰好铺满 [ms, me)。对不齐返回 null。
   * SYNC: client/src/shared/cross/mergeTokenSpans.ts → tokenIndicesCoveringSpan
   */
  function tokenIndicesCoveringSpan(tokens, ms, me) {
    const n = tokens.length;
    let k = 0;
    while (k < n && tokens[k].offset[1] <= ms) k += 1;
    if (k >= n) return null;
    if (tokens[k].offset[0] !== ms) return null;
    const idxs = [];
    while (k < n) {
      const [ts, te] = tokens[k].offset;
      if (ts < ms || te > me) return null;
      idxs.push(k);
      if (te === me) return idxs;
      k += 1;
      if (k >= n) return null;
      if (tokens[k].offset[0] !== te) return null;
    }
    return null;
  }

  /**
   * 词级区间：isWordLike 段；紧贴词前的一个 ASCII 空格并入段（BPE 常把空格粘在下一 token 上）。
   */
  function wordLikeSpansByCodePoint(text) {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
      throw new Error('Intl.Segmenter missing');
    }
    const s = text || '';
    const chars = Array.from(s);
    const spans = [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const { segment, index, isWordLike } of segmenter.segment(s)) {
      if (!isWordLike) continue;
      const start = utf16ToCp(s, index);
      const end = utf16ToCp(s, index + segment.length);
      const lo = start > 0 && chars[start - 1] === ' ' ? start - 1 : start;
      spans.push([lo, end]);
    }
    return spans;
  }

  function mergeIndexGroups(text, tokens) {
    const n = tokens.length;
    if (n === 0) return [];
    const spanTag = new Array(n).fill(null);
    let nextSid = 0;
    for (const [ms, me] of wordLikeSpansByCodePoint(text)) {
      const idxs = tokenIndicesCoveringSpan(tokens, ms, me);
      if (!idxs || idxs.length < 2) continue;
      const sid = nextSid;
      nextSid += 1;
      for (const ti of idxs) {
        if (spanTag[ti] !== null) {
          const t = tokens[ti];
          throw new Error(
            `wordMerge: token index ${ti} falls in two word spans (offset=[${t.offset[0]},${t.offset[1]}), prior span id=${spanTag[ti]})`,
          );
        }
        spanTag[ti] = sid;
      }
    }
    const groups = [];
    let i = 0;
    while (i < n) {
      const sid = spanTag[i];
      if (sid === null) {
        groups.push([i]);
        i += 1;
        continue;
      }
      const g = [i];
      i += 1;
      while (i < n && spanTag[i] === sid) {
        g.push(i);
        i += 1;
      }
      groups.push(g);
    }
    return groups;
  }

  function mergeGroup(group, tokens, text) {
    if (group.length === 1) return tokens[group[0]];
    const first = tokens[group[0]];
    const last = tokens[group[group.length - 1]];
    let sum = 0;
    let n = 0;
    for (const idx of group) {
      const p = tokenProb(tokens[idx]);
      if (p == null) continue;
      sum += bitsFromProb(p);
      n += 1;
    }
    const merged = {
      offset: [first.offset[0], last.offset[1]],
      raw: sliceByCp(text, first.offset[0], last.offset[1]),
    };
    if (n) {
      const p = 2 ** -sum;
      merged.p = p;
      merged.real_topk = [0, p];
    }
    return merged;
  }

  /**
   * @param {Array<{ offset: [number, number], p?: number, real_topk?: [number, number] | null, raw?: string }>} tokens
   * @param {string} text
   */
  function mergeWordTokens(tokens, text) {
    const list = Array.isArray(tokens) ? tokens : [];
    return mergeIndexGroups(text, list).map((group) => mergeGroup(group, list, text));
  }

  return mergeWordTokens;
})();
