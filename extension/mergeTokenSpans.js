/**
 * SYNC 副本（demo 不抽共享包；改站内源请同步本文件）：
 * - client/src/shared/cross/mergeTokenSpans.ts（几何合并）
 * - client/src/shared/cross/semanticUtils.ts → mergeTokenSpansFullyForRendering / normalizeTokenScores
 */
globalThis.IL_mergeTokenSpansFullyForRendering = (function () {
  function sliceTextByCodePointOffsets(text, start, end) {
    const chars = Array.from(text || '');
    if (chars.length === 0) return '';
    const boundedStart = Math.max(0, Math.min(start, chars.length));
    const boundedEnd = Math.max(boundedStart, Math.min(end, chars.length));
    if (boundedStart >= boundedEnd) return '';
    return chars.slice(boundedStart, boundedEnd).join('');
  }

  function dropEmptyZeroWidthTokens(tokens) {
    return tokens.filter((t) => {
      const [s, e] = t.offset;
      return !(s === e && (t.raw ?? '') === '');
    });
  }

  function isAsciiDigitCodePoint(c) {
    return c.length === 1 && c >= '0' && c <= '9';
  }

  function asciiDigitSpanRangesByCodePoint(text) {
    const chars = Array.from(text || '');
    const n = chars.length;
    const spans = [];
    let i = 0;
    while (i < n) {
      if (!isAsciiDigitCodePoint(chars[i])) {
        i++;
        continue;
      }
      const digitStart = i;
      let k = i;
      while (k < n && isAsciiDigitCodePoint(chars[k])) k++;
      const start = digitStart > 0 && chars[digitStart - 1] === ' ' ? digitStart - 1 : digitStart;
      spans.push([start, k]);
      i = k;
    }
    return spans;
  }

  function tokenIndicesCoveringSpan(tokens, ms, me) {
    const n = tokens.length;
    let k = 0;
    while (k < n && tokens[k].offset[1] <= ms) k++;
    if (k >= n) return null;
    if (tokens[k].offset[0] !== ms) return null;

    const idxs = [];
    while (k < n) {
      const [ts, te] = tokens[k].offset;
      if (ts < ms || te > me) return null;
      idxs.push(k);
      if (te === me) return idxs;
      k++;
      if (k >= n) return null;
      if (tokens[k].offset[0] !== te) return null;
    }
    return null;
  }

  function digitMergeIndexGroupsByText(originalText, tokens) {
    const n = tokens.length;
    if (n === 0) return [];

    const spans = asciiDigitSpanRangesByCodePoint(originalText);
    const spanTag = new Array(n).fill(null);
    let nextSid = 0;

    for (const [ms, me] of spans) {
      const idxs = tokenIndicesCoveringSpan(tokens, ms, me);
      if (!idxs || idxs.length < 2) continue;
      const sid = nextSid++;
      for (const ti of idxs) {
        if (spanTag[ti] !== null) {
          const t = tokens[ti];
          throw new Error(
            `digitMerge: token index ${ti} falls in two digit spans (offset=[${t.offset[0]},${t.offset[1]}), prior span id=${spanTag[ti]})`
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
        i++;
        continue;
      }
      const g = [i];
      i++;
      while (i < n && spanTag[i] === sid) {
        g.push(i);
        i++;
      }
      groups.push(g);
    }
    return groups;
  }

  function mergeSequentialOverlap(tokens, options) {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    const { getOffset, cloneForStep, mergeOverlappingPair, sliceMergedRaw } = options;
    const out = [];
    let current = cloneForStep(tokens[0]);
    for (let k = 1; k < tokens.length; k++) {
      const next = cloneForStep(tokens[k]);
      const [curStart] = getOffset(next);
      const [cs, ce] = getOffset(current);
      const prevEnd = ce;
      let overlapping = curStart < prevEnd;
      if (!overlapping && cs === ce) {
        const [ns, ne] = getOffset(next);
        if (ns <= cs && cs < ne) overlapping = true;
        else if (ns === ne && ns === cs) overlapping = true;
      }
      if (overlapping) {
        const end = Math.max(prevEnd, getOffset(next)[1]);
        const mergedOffset = [getOffset(current)[0], end];
        const mergedRaw = sliceMergedRaw(mergedOffset[0], end);
        current = mergeOverlappingPair(current, next, mergedOffset, mergedRaw);
      } else {
        out.push(current);
        current = next;
      }
    }
    out.push(current);
    return out;
  }

  function mergeTokenSpansForRendering(tokens, text) {
    if (tokens.length === 0) return tokens;
    const prepared = dropEmptyZeroWidthTokens(tokens);
    if (prepared.length === 0) return prepared;
    return mergeSequentialOverlap(prepared, {
      getOffset: (t) => t.offset,
      cloneForStep: (t) => ({ ...t, offset: [t.offset[0], t.offset[1]] }),
      sliceMergedRaw: (start, end) => sliceTextByCodePointOffsets(text, start, end),
      mergeOverlappingPair: (current, next, mergedOffset, mergedRaw) => ({
        ...current,
        offset: mergedOffset,
        raw: mergedRaw,
        score: current.score + next.score,
      }),
    });
  }

  function mergeTokenDigitSpans(tokens, text) {
    const mergeGroups = digitMergeIndexGroupsByText(text, tokens);
    return mergeGroups.map((group) => {
      if (group.length === 1) return tokens[group[0]];
      const first = tokens[group[0]];
      const last = tokens[group[group.length - 1]];
      const mergedRaw = sliceTextByCodePointOffsets(text, first.offset[0], last.offset[1]);
      const mergedScore = group.reduce((sum, idx) => sum + tokens[idx].score, 0);
      return {
        ...first,
        offset: [first.offset[0], last.offset[1]],
        raw: mergedRaw,
        score: mergedScore,
      };
    });
  }

  /** @param {{ digitMerge?: boolean }} [options] */
  function mergeTokenSpansFullyForRendering(tokens, text, options) {
    const overlapped = mergeTokenSpansForRendering(tokens, text);
    if (options && options.digitMerge === false) return overlapped;
    return mergeTokenDigitSpans(overlapped, text);
  }

  function getTokenRawScore(t) {
    return t.rawScore !== undefined ? t.rawScore : t.score;
  }

  function normalizeTokenScores(tokens) {
    const max = Math.max(0, ...tokens.map((t) => t.score).filter(Number.isFinite));
    return tokens.map((t) => {
      const rawScore = getTokenRawScore(t);
      if (max <= 0) return { ...t, rawScore };
      return { ...t, rawScore, score: t.score / max };
    });
  }

  globalThis.IL_normalizeTokenScores = normalizeTokenScores;
  return mergeTokenSpansFullyForRendering;
})();
