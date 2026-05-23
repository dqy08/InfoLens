/**
 * BPE 与 token_attention 共用的 offset 几何：overlap 顺序扫描与 digit 下标分组。
 * 概率相乘 / score 求和等聚合语义由各自调用方在合并回调中实现。
 *
 * offset 语义：与 dataValidation.validateTokenConsistency 一致，均为 `Array.from(text)` 下标（Unicode 码点），非 UTF-16 码元。
 */

/** overlap 后是否再按原文数字段合并；默认合并 */
export type DigitMergePipelineOptions = {
    digitMerge?: boolean;
};

/** 与全链路 token offset 一致：码点个数（含增补平面字符计 1）。 */
export function codePointLength(text: string): number {
    return Array.from(text || '').length;
}

/**
 * 按码点下标 [start, end) 取子串；与校验、合并管线一致。
 */
export function sliceTextByCodePointOffsets(text: string, start: number, end: number): string {
    const chars = Array.from(text || '');
    if (chars.length === 0) return '';
    const boundedStart = Math.max(0, Math.min(start, chars.length));
    const boundedEnd = Math.max(boundedStart, Math.min(end, chars.length));
    if (boundedStart >= boundedEnd) return '';
    return chars.slice(boundedStart, boundedEnd).join('');
}

/**
 * Overlap 合并前：丢弃码点零宽且 `raw` 为空（缺省视为空）的条目。BPE 与 attention 共用。
 */
export function dropEmptyZeroWidthTokens<T extends { offset: [number, number]; raw?: string }>(tokens: T[]): T[] {
    return tokens.filter((t) => {
        const [s, e] = t.offset;
        return !(s === e && (t.raw ?? '') === '');
    });
}

function isAsciiDigitCodePoint(c: string): boolean {
    return c.length === 1 && c >= '0' && c <= '9';
}

/**
 * 在原文上按码点扫描，得到互不相交的「数字段」区间 `[start, end)`：
 * 语义为 **0 或 1 个 ASCII 空格** + 连续 ASCII 数字 `[0-9]+`。
 * 若干空格紧邻数字时，仅**紧贴数字前的那一个空格**入段（例如 `"   123"` → 段为 `" 123"`，不含前导多余空格）。
 */
export function asciiDigitSpanRangesByCodePoint(text: string): [number, number][] {
    const chars = Array.from(text || '');
    const n = chars.length;
    const spans: [number, number][] = [];
    let i = 0;
    while (i < n) {
        if (!isAsciiDigitCodePoint(chars[i]!)) {
            i++;
            continue;
        }
        const digitStart = i;
        let k = i;
        while (k < n && isAsciiDigitCodePoint(chars[k]!)) k++;
        const start = digitStart > 0 && chars[digitStart - 1] === ' ' ? digitStart - 1 : digitStart;
        spans.push([start, k]);
        i = k;
    }
    return spans;
}

/**
 * 在 `tokens` 中找出若干**连续整 token**，使其 offset 并集**恰好**为 `[ms, me)`（与段两端对齐、中间无缝）。
 * 若任一端落在某 token 内部（无法只用完整 token 铺满），返回 null。
 */
function tokenIndicesCoveringSpan<T extends { offset: [number, number] }>(tokens: T[], ms: number, me: number): number[] | null {
    const n = tokens.length;
    let k = 0;
    while (k < n && tokens[k]!.offset[1] <= ms) k++;
    if (k >= n) return null;
    if (tokens[k]!.offset[0] !== ms) return null;

    const idxs: number[] = [];
    while (k < n) {
        const [ts, te] = tokens[k]!.offset;
        if (ts < ms || te > me) return null;
        idxs.push(k);
        if (te === me) return idxs;
        k++;
        if (k >= n) return null;
        if (tokens[k]!.offset[0] !== te) return null;
    }
    return null;
}

/**
 * digit 合并分组：由原文码点上的数字段决定，与 BPE 如何切 `raw` 无关。
 * 若某数字段无法用若干连续**整 token** 恰好铺满（常见于空格段与前后 token 边界不一致），则**跳过该段**的合并，不抛错。
 */
export function digitMergeIndexGroupsByText<T extends { offset: [number, number] }>(
    originalText: string,
    tokens: T[]
): number[][] {
    const n = tokens.length;
    if (n === 0) return [];

    const spans = asciiDigitSpanRangesByCodePoint(originalText);
    const spanTag: (number | null)[] = new Array(n).fill(null);
    let nextSid = 0;

    for (const [ms, me] of spans) {
        const idxs = tokenIndicesCoveringSpan(tokens, ms, me);
        if (!idxs) {
            continue;
        }
        if (idxs.length < 2) continue;

        const sid = nextSid++;
        for (const ti of idxs) {
            if (spanTag[ti] !== null) {
                const t = tokens[ti]!;
                const prevSid = spanTag[ti];
                throw new Error(
                    `digitMerge: token 下标 ${ti} 重复落入两段数字区间（offset=[${t.offset[0]},${t.offset[1]})，先前段 id=${prevSid}）`
                );
            }
            spanTag[ti] = sid;
        }
    }

    const groups: number[][] = [];
    let i = 0;
    while (i < n) {
        const sid = spanTag[i]!;
        if (sid === null) {
            groups.push([i]);
            i++;
            continue;
        }
        const g: number[] = [i];
        i++;
        while (i < n && spanTag[i] === sid) {
            g.push(i);
            i++;
        }
        groups.push(g);
    }
    return groups;
}

export type SequentialOverlapOptions<T> = {
    getOffset: (t: T) => [number, number];
    cloneForStep: (t: T) => T;
    mergeOverlappingPair: (current: T, next: T, mergedOffset: [number, number], mergedRaw: string) => T;
    /** 码点下标切片，见 {@link sliceTextByCodePointOffsets} */
    sliceMergedRaw: (start: number, end: number) => string;
};

/**
 * 顺序扫描 overlap：与既有 mergeBpeOverlapTokens / mergeAttentionTokensForRendering 行为一致。
 *
 * 合并条件（满足其一即与下一 token 合并，合并步骤相同）：
 * - **区间重叠**：`next` 起点 &lt; `current` 右端（`curStart &lt; prevEnd`）。
 * - **零宽落在下一区间内**：`current` 为码点零宽 `(p,p)`，且 `next` 为 `[ns,ne)` 满足 `ns ≤ p &lt; ne`。
 * - **同一点连续零宽**：`current` 与 `next` 均为 `(p,p)`，先折叠成一条零宽（概率相乘 / score 相加等由 `mergeOverlappingPair` 决定），再与后续正宽 token 按上一条合并。
 *
 * 零宽若无法与下一 token 合并，则照常推进；**末尾未合并的零宽**原样输出，不抛错。
 */
export function mergeSequentialOverlap<T>(tokens: T[], options: SequentialOverlapOptions<T>): T[] {
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return [];
    }
    const { getOffset, cloneForStep, mergeOverlappingPair, sliceMergedRaw } = options;

    const out: T[] = [];
    let current = cloneForStep(tokens[0]!);
    for (let k = 1; k < tokens.length; k++) {
        const next = cloneForStep(tokens[k]!);
        const [curStart] = getOffset(next);
        const [cs, ce] = getOffset(current);
        const prevEnd = ce;
        let overlapping = curStart < prevEnd;
        if (!overlapping && cs === ce) {
            const [ns, ne] = getOffset(next);
            if (ns <= cs && cs < ne) {
                overlapping = true;
            } else if (ns === ne && ns === cs) {
                overlapping = true;
            }
        }
        if (overlapping) {
            const end = Math.max(prevEnd, getOffset(next)[1]);
            const mergedOffset: [number, number] = [getOffset(current)[0], end];
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

/**
 * overlap 合并一步：拼接「合并前子片段」的 raw 列表（BPE 与 attention 共用）。
 */
export function mergeSourcePartsForOverlapPair<T extends { offset: [number, number]; bpe_merge_parts?: string[] }>(
    text: string,
    current: T,
    next: T
): string[] {
    const curParts =
        current.bpe_merge_parts ?? [sliceTextByCodePointOffsets(text, current.offset[0], current.offset[1])];
    const nextParts =
        next.bpe_merge_parts ?? [sliceTextByCodePointOffsets(text, next.offset[0], next.offset[1])];
    return [...curParts, ...nextParts];
}

/**
 * digit 合并：组内各 token 的子片段串联（子 token 若已由 overlap 合并则保留其 `bpe_merge_parts`）。
 */
export function flattenMergePartsForDigitGroup<T extends { raw: string; bpe_merge_parts?: string[] }>(
    group: number[],
    tokens: T[]
): string[] {
    return group.flatMap((idx) => {
        const tok = tokens[idx]!;
        return tok.bpe_merge_parts ?? [tok.raw];
    });
}
