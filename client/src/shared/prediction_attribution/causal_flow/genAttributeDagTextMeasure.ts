import type { FrontendAnalyzeResult, FrontendToken } from '../../../shared/api/GLTR_API';
import { TokenPositionCalculator } from '../../../shared/vis/TokenPositionCalculator';
import { ZERO_WIDTH_FRAGMENT_PLACEHOLDER_PX } from '../../../shared/vis/types';
import type { TokenFragmentRect } from '../../../shared/vis/types';
import { visualizeSpecialChars } from '../../cross/tokenDisplayUtils';
import { isOffsetSpanFullyExcluded } from '../core/attributionDisplayModel';
import type { PromptTokenSpan } from './genAttributeDagPreprocess';

/**
 * 将 `deleteIntervals`（原始 offset）从 `text` 中删去，返回压缩后字符串。
 * 区间须有序（调用方保证），但函数内部也按 start 排序，保证健壮。
 */
export function compactText(text: string, deleteIntervals: [number, number][]): string {
    if (deleteIntervals.length === 0) return text;
    const sorted = [...deleteIntervals].sort((a, b) => a[0] - b[0]);
    let result = '';
    let cursor = 0;
    for (const [s, e] of sorted) {
        const cs = Math.max(cursor, 0);
        const ce = Math.min(e, text.length);
        if (s > cs) result += text.slice(cs, s);
        cursor = Math.max(cursor, ce);
    }
    if (cursor < text.length) result += text.slice(cursor);
    return result;
}

/**
 * 将原始 offset 映射到压缩后 offset。
 * 若 `orig` 落在某 deleteInterval 内部，返回该区间压缩后的起始点（左边界压缩结果）。
 * 须传入已合并（non-overlapping、有序）的区间；见 {@link mergeDeleteIntervals}。
 */
export function originalToCompacted(orig: number, deleteIntervals: [number, number][]): number {
    if (deleteIntervals.length === 0) return orig;
    let shift = 0;
    for (const [s, e] of deleteIntervals) {
        if (orig <= s) break;
        if (orig >= e) {
            shift += e - s;
        } else {
            // orig is inside a delete interval; clamp to interval start
            shift += orig - s;
            break;
        }
    }
    return orig - shift;
}

/**
 * 将 deleteIntervals 排序并合并重叠/相邻区间，保证传给 {@link originalToCompacted} 的区间不重叠。
 * {@link compactText} 通过 cursor 天然处理重叠，此函数让两者行为一致。
 */
function mergeDeleteIntervals(intervals: [number, number][]): [number, number][] {
    if (intervals.length <= 1) return [...intervals];
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [sorted[0]!];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1]!;
        const [s, e] = sorted[i]!;
        if (s <= last[1]) {
            last[1] = Math.max(last[1], e);
        } else {
            merged.push([s, e]);
        }
    }
    return merged;
}

export type GenAttrDagTokenGeom = {
    /** token 基础矩形（1× 尺寸）的中心坐标；同行 token 的 cy 相同，与 CI 缩放无关。 */
    cx: number;
    cy: number;
    width: number;
    height: number;
};

function offsetKey(off: [number, number]): string {
    return `${off[0]}_${off[1]}`;
}

function fragmentsForToken(
    positions: TokenFragmentRect[],
    tokenIndex: number
): TokenFragmentRect[] {
    const parts = positions.filter((p) => p.tokenIndex === tokenIndex);
    parts.sort((a, b) => a.fragmentIndex - b.fragmentIndex);
    return parts;
}

/**
 * raw 中含有在 visualizeSpecialChars 里会展开成更长标签的特殊字符
 * （控制字符 / 全角空格等），此时 displayLabel 比 raw 宽，需要最小宽保底。
 */
function hasExpandingSpecialChar(raw: string): boolean {
    return /[\x00-\x1f\x7f\u0085\u2028\u2029\u3000]/.test(raw);
}

/**
 * 估算 visualizeSpecialChars 后的标签宽度下限：
 * 直接按「显示字符数 × 常数」估算，简单稳定。
 */
function estimateExpandedLabelWidthFloorPx(raw: string): number {
    const APPROX_CHAR_WIDTH_PX = 10;
    const displayLabel = visualizeSpecialChars(raw, {
        spaceDotExceptBeforeAsciiLetterOrNumber: true,
        omitHexInCodePointLabel: true,
    });
    const displayLen = Array.from(displayLabel).length;
    return Math.max(displayLen * APPROX_CHAR_WIDTH_PX, 1);
}

/** 纯换行 token 的零宽/占位 fragment 本身就是它的几何语义。 */
function isLineBreakOnlyToken(raw: string): boolean {
    return /^[\n\r\u0085\u2028\u2029]+$/.test(raw);
}

/**
 * 移动端 WebKit 会在「换行后的首个 token」前返回一个上一行行尾的零宽 rect。
 * 这个 rect 不是 token 的可见字形；若用它作 DAG 锚点，节点会被放回上一行。
 *
 * 解法：测量层保留 Range 原始宽度；DAG 几何层按 token 语义处理。
 * - 纯换行 token：零宽 fragment 表示换行自身的位置，保留。
 * - 其它 token：过滤 width=0 的幽灵片，只用真实可见 fragment 对齐 DAG 节点。
 */
function fragmentsForDagGeom(
    frags: TokenFragmentRect[],
    raw: string
): TokenFragmentRect[] {
    if (isLineBreakOnlyToken(raw)) {
        return frags;
    }
    const visible = frags.filter((f) => f.width > 0);
    return visible.length > 0 ? visible : frags;
}

/** 只有在 DAG 需要展示零宽换行 token 时，才给它一个最小可视宽度。 */
function widthForDagGeom(frag: TokenFragmentRect): number {
    return frag.width > 0 ? frag.width : ZERO_WIDTH_FRAGMENT_PLACEHOLDER_PX;
}

/**
 * 起点取参与几何的首 fragment；非换行 token 会先排除 Range 的零宽占位 fragment。
 * 宽度为参与几何的 fragment 宽度之和，高度取首片高度。
 */
function geomFromTokenFragments(frags: TokenFragmentRect[], raw: string): GenAttrDagTokenGeom {
    if (frags.length === 0) {
        throw new Error('genAttributeDagTextMeasure: geomFromTokenFragments called with no fragments');
    }
    const geomFrags = fragmentsForDagGeom(frags, raw);
    const first = geomFrags[0]!;
    const hFirst = Math.max(first.height, 1);
    const geomWidthSum = geomFrags.reduce((s, f) => s + widthForDagGeom(f), 0);
    const expandedFloor = hasExpandingSpecialChar(raw)
        ? estimateExpandedLabelWidthFloorPx(raw)
        : 1;
    const widthSum = Math.max(geomWidthSum, expandedFloor);
    return {
        cx: first.x + widthSum / 2,
        cy: first.y + hFirst / 2,
        width: widthSum,
        height: hFirst,
    };
}

function buildAnalyzeResult(
    originalText: string,
    bpe_strings: FrontendToken[]
): FrontendAnalyzeResult {
    return {
        model: null,
        error: null,
        bpe_strings,
        originalTokens: bpe_strings.map((t) => ({ ...t })),
        bpeBpeMergedTokens: bpe_strings.map((t) => ({ ...t })),
        originalText,
    };
}

/**
 * 不可见测量层：与 LMF 相同思路，用 {@link TokenPositionCalculator} + Range 得到 token 几何；
 * 非换行 token 会忽略 Range 的零宽占位 fragment。宽、高见 {@link geomFromTokenFragments}。
 *
 * @param deleteIntervals 原始 prompt offset 删除区间（`[start, end)`），落入区间的 prompt token
 *   不会出现在返回的 Map 中，且其对应文本在测量层内被物理压缩（不占布局空间）。
 *   多轮场景下可在 {@link setDeleteIntervals} 中随新 input 区扩展（已有区间不变）。
 */
export function createGenAttributeDagTextMeasure(
    measureRoot: HTMLElement,
    deleteIntervals: [number, number][] = [],
): {
    reset(): void;
    isEmpty(): boolean;
    /** 扩展删除区间（如多轮追加 input 区）；须在 {@link appendInputSpans} 前调用。 */
    setDeleteIntervals(intervals: [number, number][]): void;
    setPrompt(promptText: string, spans: PromptTokenSpan[]): Map<string, GenAttrDagTokenGeom>;
    /** 在已有全文（含已生成 output token）末尾追加 input spans，不重置测量状态。 */
    appendInputSpans(layoutText: string, newSpans: PromptTokenSpan[]): Map<string, GenAttrDagTokenGeom>;
    appendGeneratedToken(token: string, offset: [number, number]): GenAttrDagTokenGeom;
} {
    // 合并重叠区间，保证 originalToCompacted 与 compactText 行为一致。
    let mergedDeleteIntervals = mergeDeleteIntervals(deleteIntervals);
    /** 当前测量层中的完整文本（prompt 前缀已压缩 + 生成 token 原样拼接）。 */
    let fullText = '';
    /**
     * 最近一次 input 同步时 `layoutWire` 在原始坐标系下的长度（`setPrompt` 为 prompt 长度；
     * `appendInputSpans` 为含 tool response 等的全长）。供 {@link appendGeneratedToken} 锚定生成区起点。
     */
    let layoutAnchorLength = 0;
    /** 与 {@link layoutAnchorLength} 同锚点、经 delete 压缩后的坐标长度。 */
    let compactedLayoutAnchorLength = 0;
    let bpeStrings: FrontendToken[] = [];
    const calculator = new TokenPositionCalculator(measureRoot);

    function setMeasureText(text: string): void {
        while (measureRoot.firstChild) measureRoot.removeChild(measureRoot.firstChild);
        measureRoot.appendChild(document.createTextNode(text));
        calculator.resetIndex();
    }

    function positionsForAnalyzeResult(
        rd: FrontendAnalyzeResult,
        fromTokenIndex = 0
    ): TokenFragmentRect[] {
        return calculator.calculateTokenPositions(rd, fromTokenIndex);
    }

    /** 将原始 prompt offset 映射到压缩坐标系；offset 超出 prompt 区域时保持原始偏移。 */
    function toCompacted(orig: number): number {
        return originalToCompacted(orig, mergedDeleteIntervals);
    }

    return {
        reset(): void {
            fullText = '';
            layoutAnchorLength = 0;
            compactedLayoutAnchorLength = 0;
            bpeStrings = [];
            while (measureRoot.firstChild) measureRoot.removeChild(measureRoot.firstChild);
            calculator.resetIndex();
        },

        isEmpty(): boolean {
            return fullText === '';
        },

        setDeleteIntervals(intervals: [number, number][]): void {
            mergedDeleteIntervals = mergeDeleteIntervals(intervals);
        },

        setPrompt(promptText: string, spans: PromptTokenSpan[]): Map<string, GenAttrDagTokenGeom> {
            // 将被删区间字符物理移除，DOM 里不留空洞。
            const compactedPrompt = compactText(promptText, mergedDeleteIntervals);
            layoutAnchorLength = promptText.length;
            compactedLayoutAnchorLength = compactedPrompt.length;
            fullText = compactedPrompt;

            // 过滤掉被删 span（调用方也会跳过，双重保险）。
            const keptSpans = spans.filter(
                ({ offset: [s, e] }) => !isOffsetSpanFullyExcluded(s, e, mergedDeleteIntervals),
            );
            // bpeStrings 使用压缩坐标系 offset，TokenPositionCalculator 在压缩文本上定位。
            bpeStrings = keptSpans.map((sp) => ({
                offset: [toCompacted(sp.offset[0]), toCompacted(sp.offset[1])] as [number, number],
                raw: sp.raw,
                pred_topk: [],
            }));
            setMeasureText(fullText);

            const rd = buildAnalyzeResult(fullText, bpeStrings);
            const positions = positionsForAnalyzeResult(rd, 0);
            const out = new Map<string, GenAttrDagTokenGeom>();

            for (let i = 0; i < keptSpans.length; i++) {
                const origSpan = keptSpans[i]!;
                const frags = fragmentsForToken(positions, i);
                if (frags.length === 0) {
                    throw new Error(
                        `genAttributeDagTextMeasure: no layout fragment for prompt token index ${i} ` +
                            `(${offsetKey(origSpan.offset)})`
                    );
                }
                // 对外 key 仍用原始 offset，API 契约不变。
                out.set(offsetKey(origSpan.offset), geomFromTokenFragments(frags, origSpan.raw));
            }
            return out;
        },

        appendInputSpans(layoutText: string, newSpans: PromptTokenSpan[]): Map<string, GenAttrDagTokenGeom> {
            if (newSpans.length === 0) return new Map();
            // 多轮场景下，本方法在轮间边界（appendGeneratedToken 之后）调用，layoutText 须为当前全文的延伸。
            const compactedLayout = compactText(layoutText, mergedDeleteIntervals);
            if (!compactedLayout.startsWith(fullText)) {
                throw new Error(
                    'genAttributeDagTextMeasure: appendInputSpans layoutText must extend current fullText prefix',
                );
            }
            layoutAnchorLength = layoutText.length;
            compactedLayoutAnchorLength = compactedLayout.length;
            fullText = compactedLayout;

            const keptNew = newSpans.filter(
                ({ offset: [s, e] }) => !isOffsetSpanFullyExcluded(s, e, mergedDeleteIntervals),
            );
            const startIdx = bpeStrings.length;
            for (const s of keptNew) {
                bpeStrings.push({
                    offset: [toCompacted(s.offset[0]), toCompacted(s.offset[1])] as [number, number],
                    raw: s.raw,
                    pred_topk: [],
                });
            }
            setMeasureText(fullText);

            const rd = buildAnalyzeResult(fullText, bpeStrings);
            const positions = positionsForAnalyzeResult(rd, startIdx);
            const out = new Map<string, GenAttrDagTokenGeom>();

            for (let i = startIdx; i < bpeStrings.length; i++) {
                const origSpan = keptNew[i - startIdx]!;
                const frags = fragmentsForToken(positions, i);
                if (frags.length === 0) {
                    throw new Error(
                        `genAttributeDagTextMeasure: no layout fragment for appended input token index ${i} ` +
                            `(${offsetKey(origSpan.offset)})`,
                    );
                }
                out.set(offsetKey(origSpan.offset), geomFromTokenFragments(frags, origSpan.raw));
            }
            return out;
        },

        appendGeneratedToken(token: string, offset: [number, number]): GenAttrDagTokenGeom {
            // offset[0] 是原始坐标系下该 token 在全文中的起点（= context.length at generation time）。
            // 映射到压缩坐标系：自 layoutAnchor 之后的生成区无 delete，按锚点相对偏移平移。
            const generatedRelative = offset[0] - layoutAnchorLength;
            const compactedStart = compactedLayoutAnchorLength + generatedRelative;
            const compactedOffset: [number, number] = [compactedStart, compactedStart + token.length];

            fullText += token;
            bpeStrings.push({ offset: compactedOffset, raw: token, pred_topk: [] });
            setMeasureText(fullText);

            const rd = buildAnalyzeResult(fullText, bpeStrings);
            const from = bpeStrings.length - 1;
            const positions = positionsForAnalyzeResult(rd, from);
            const frags = fragmentsForToken(positions, from);
            if (frags.length === 0) {
                throw new Error(
                    `genAttributeDagTextMeasure: no layout fragment for generated token (${offsetKey(offset)})`
                );
            }
            return geomFromTokenFragments(frags, token);
        },
    };
}

export type TrailingSuffixLineAnchor = {
    /** 与 text-flow 节点 `cx/cy` 同系的测量层坐标（相对 measureRoot 左上角）。 */
    x: number;
    y: number;
};

/**
 * 测量层全文末尾换行后 suffix 的首行左上角（不持久修改测量文本）。
 * 与 {@link createGenAttributeDagTextMeasure} 的 Range 布局同源。
 */
export function measureTrailingSuffixLineAnchor(
    measureRoot: HTMLElement,
    suffix: string,
): TrailingSuffixLineAnchor {
    const textNode = measureRoot.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        throw new Error(
            'genAttributeDagTextMeasure: measureTrailingSuffixLineAnchor requires a single text child',
        );
    }
    const tn = textNode as Text;
    const original = tn.data;
    tn.data = `${original}\n${suffix}`;
    try {
        const suffixStart = original.length + 1;
        const range = document.createRange();
        range.setStart(tn, suffixStart);
        range.setEnd(tn, suffixStart + suffix.length);
        const rect = range.getBoundingClientRect();
        const rootRect = measureRoot.getBoundingClientRect();
        return {
            x: rect.left - rootRect.left,
            y: rect.top - rootRect.top,
        };
    } finally {
        tn.data = original;
    }
}
