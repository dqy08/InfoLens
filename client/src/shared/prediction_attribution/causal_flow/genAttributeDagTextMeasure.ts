import type { FrontendAnalyzeResult, FrontendToken } from '../../../shared/api/GLTR_API';
import { TokenPositionCalculator } from '../../../shared/vis/TokenPositionCalculator';
import { ZERO_WIDTH_FRAGMENT_PLACEHOLDER_PX } from '../../../shared/vis/types';
import type { TokenFragmentRect } from '../../../shared/vis/types';
import { visualizeSpecialChars } from '../../cross/tokenDisplayUtils';
import type { PromptTokenSpan } from './genAttributeDagPreprocess';

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
 */
export function createGenAttributeDagTextMeasure(measureRoot: HTMLElement): {
    reset(): void;
    setPrompt(promptText: string, spans: PromptTokenSpan[]): Map<string, GenAttrDagTokenGeom>;
    appendGeneratedToken(token: string, offset: [number, number]): GenAttrDagTokenGeom;
} {
    let fullText = '';
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

    return {
        reset(): void {
            fullText = '';
            bpeStrings = [];
            while (measureRoot.firstChild) measureRoot.removeChild(measureRoot.firstChild);
            calculator.resetIndex();
        },

        setPrompt(promptText: string, spans: PromptTokenSpan[]): Map<string, GenAttrDagTokenGeom> {
            fullText = promptText;
            bpeStrings = spans.map((s) => ({
                offset: s.offset,
                raw: s.raw,
                pred_topk: [],
            }));
            setMeasureText(fullText);

            const rd = buildAnalyzeResult(fullText, bpeStrings);
            const positions = positionsForAnalyzeResult(rd, 0);
            const out = new Map<string, GenAttrDagTokenGeom>();

            for (let i = 0; i < bpeStrings.length; i++) {
                const tok = bpeStrings[i]!;
                const frags = fragmentsForToken(positions, i);
                if (frags.length === 0) {
                    throw new Error(
                        `genAttributeDagTextMeasure: no layout fragment for prompt token index ${i} ` +
                            `(${offsetKey(tok.offset)})`
                    );
                }
                out.set(offsetKey(tok.offset), geomFromTokenFragments(frags, tok.raw));
            }
            return out;
        },

        appendGeneratedToken(token: string, offset: [number, number]): GenAttrDagTokenGeom {
            fullText += token;
            bpeStrings.push({ offset, raw: token, pred_topk: [] });
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
