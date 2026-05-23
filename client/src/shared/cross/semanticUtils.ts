/**
 * 语义分析相关工具函数
 */

import type { BpeMergeReason } from '../../shared/api/GLTR_API';
import {
    type DigitMergePipelineOptions,
    digitMergeIndexGroupsByText,
    dropEmptyZeroWidthTokens,
    flattenMergePartsForDigitGroup,
    mergeSequentialOverlap,
    mergeSourcePartsForOverlapPair,
    sliceTextByCodePointOffsets,
} from './mergeTokenSpans';

/**
 * 合并/归一化管线中的原始强度：已写入 rawScore 时用其值，否则用 score。
 */
export function getAttentionRawScore<T extends { score: number }>(t: T): number {
    const ext = t as { rawScore?: number };
    return ext.rawScore !== undefined ? ext.rawScore : t.score;
}

/**
 * 将 score 归一化到 [0,1]；写入 rawScore（归一化前的强度，供 tooltip attentionRawScores）。
 * 语义 / 归因路径应在 **overlap 与 digit 合并并对原始 score 求和之后** 再调用，使 max 与合并后强度一致。
 * 若调用方已将「原始梯度」放在 rawScore、且 score 置 0（如未匹配块），则以 rawScore 作为 tooltip 保留值，仅用 score 参与 max 归一。
 */
export function normalizeTokenScores<T extends { score: number }>(tokens: T[]): Array<T & { rawScore: number }> {
    const max = Math.max(0, ...tokens.map((t) => t.score).filter(Number.isFinite));
    return tokens.map((t) => {
        const rawScore = getAttentionRawScore(t);
        if (max <= 0) {
            return { ...t, rawScore };
        }
        return { ...t, rawScore, score: t.score / max };
    });
}

const encoder = new TextEncoder();

/**
 * 返回 text 的 UTF-8 字节数（返回值单位：字节）。buf 为 encodeInto 的写入目标，其长度即上界。
 * 若 text 的真实字节数超过 buf.length，则返回 buf.length（而非精确值），调用方应据此判断"超限"。
 * 用 read < text.length 检测是否还有字符未写入，避免多字节字符边界恰好填满 buf 时的误判。
 */
export function getUtf8ByteLength(text: string, buf: Uint8Array): number {
    const { read, written } = encoder.encodeInto(text, buf);
    return read < text.length ? buf.length : written;
}


/** 从 start 起找下一段落结束位置（段落边界：≥2个连续换行符）。返回值包含尾部所有连续换行符；若无段落边界，返回 text.length。 */
function nextParagraphEnd(text: string, start: number): number {
    const nl = text.indexOf("\n\n", start);
    if (nl === -1) return text.length;
    let end = nl + 2;
    while (end < text.length && text[end] === "\n") end++;
    return end;
}

/** 从 start 起找下一行结束位置。连续换行算作一行（防止切断 BPE 分词）。 */
function nextLineEnd(text: string, start: number): number {
    const nl = text.indexOf("\n", start);
    if (nl === -1) return text.length;
    let end = nl + 1;
    while (end < text.length && text[end] === "\n") end++;
    return end;
}

/** 返回从 start 起累计 UTF-8 字节不超过 byteLimit 的最大字符索引（不切断代理对）。start：字符索引；byteLimit：UTF-8 字节数；返回值：字符索引。 */
export function charIndexForByteLimit(text: string, start: number, byteLimit: number): number {
    const buf = new Uint8Array(4);
    let bytes = 0;
    let i = start;
    while (i < text.length) {
        const cp = text.codePointAt(i)!;
        const charLen = cp > 0xFFFF ? 2 : 1;
        const byteLen = encoder.encodeInto(text.slice(i, i + charLen), buf).written;
        if (bytes + byteLen > byteLimit) break;
        bytes += byteLen;
        i += charLen;
    }
    return i;
}

// 纯中文文章：永远不会触碰英文标点，完全规避 . 的歧义问题
// 纯英文文章：前两组无命中，自然降级到英文标点，行为正确
// 中英混排时：划分效果会变差
const SEPARATOR_GROUPS: string[][] = [
    // 第一优先级：中文句子级
    ["。", "！", "？", "…"],
    // 第二优先级：中文子句级
    ["；", "，"],
    // 第三优先级：英文句子级
    [".", "!", "?"],
    // 第四优先级：英文子句级
    [";", ","],
    // 第五优先级：空格
    [" ", "\t"],
];

/**
 * 在 [start, maxEnd) 范围内，按 groups 优先级找最靠右的分隔符边界。
 * start、maxEnd、返回值：均为字符索引。同组内取最靠右的；找不到则尝试下一组；均无则回退到 maxEnd。
 */
export function findSplitPoint(text: string, start: number, maxEnd: number): number {
    const window = text.slice(start, maxEnd);
    for (const group of SEPARATOR_GROUPS) {
        let bestEnd = -1;
        for (const sep of group) {
            const i = window.lastIndexOf(sep);
            // 同组内取最靠右的
            if (i !== -1 && i + sep.length > bestEnd) bestEnd = i + sep.length;
        }
        if (bestEnd !== -1) return start + bestEnd;
        // 找不到则尝试下一组
    }
    // todo: 如果回退到字符单位的边界，切分后分词结果有可能和原文分词不一致，会报错。
    // todo: 其实英文句号、空格等作为边界也有可能有分词不一致问题，这里会是一个坑
    return maxEnd;
}

/**
 * 合并 token_attention 中因 BPE overlap 产生的重叠 token（offset 几何合并与 mergeTokensForRendering 一致）。
 *
 * BPE overlap 多为 tokenizer 的 offset 与字边界不对齐所致：相邻条目的 raw / offset 在表层可能看起来「重叠」，
 * 但底层仍是按 tokenizer 位置各不相同的嵌入与梯度；并非同一条底层数据被算了两次。
 *
 * 输入须为 API 的原始 `score`（梯度范数）；重叠时 **相加**。归一化到 [0,1] 须在合并之后由 normalizeTokenScores 统一做。
 *
 * 与 BPE 一致：先 {@link dropEmptyZeroWidthTokens}，再 {@link mergeSequentialOverlap}（含零宽落在下一区间内之合并）。
 */
export function mergeAttentionTokensForRendering<T extends { offset: [number, number]; raw: string; score: number }>(
    tokens: T[],
    text: string
): T[] {
    if (tokens.length === 0) return tokens;
    const prepared = dropEmptyZeroWidthTokens(tokens);
    if (prepared.length === 0) return prepared;
    return mergeSequentialOverlap(prepared, {
        getOffset: (t) => t.offset,
        cloneForStep: (t) => ({ ...t, offset: [t.offset[0], t.offset[1]] as [number, number] }) as T,
        sliceMergedRaw: (start, end) => sliceTextByCodePointOffsets(text, start, end),
        mergeOverlappingPair: (current, next, mergedOffset, mergedRaw) =>
            ({
                ...current,
                offset: mergedOffset,
                raw: mergedRaw,
                score: current.score + next.score,
                bpe_merge_parts: mergeSourcePartsForOverlapPair(text, current, next),
                bpe_merged: 'overlap' satisfies BpeMergeReason,
            }) as T,
    });
}

/**
 * Digit 合并：与 {@link mergeBpeDigitTokens} 相同分组规则（{@link digitMergeIndexGroupsByText}），对 attention 的 `score` **求和**（BPE 侧为概率相乘）。
 */
export function mergeAttentionDigitTokens<T extends { offset: [number, number]; raw: string; score: number }>(
    tokens: T[],
    text: string
): T[] {
    const mergeGroups = digitMergeIndexGroupsByText(text, tokens);
    return mergeGroups.map((group) => {
        if (group.length === 1) {
            return tokens[group[0]!]!;
        }
        const first = tokens[group[0]!]!;
        const last = tokens[group[group.length - 1]!]!;
        const mergedRaw = sliceTextByCodePointOffsets(text, first.offset[0], last.offset[1]);
        const mergedScore = group.reduce((sum, idx) => sum + tokens[idx]!.score, 0);
        return {
            ...first,
            offset: [first.offset[0], last.offset[1]] as [number, number],
            raw: mergedRaw,
            score: mergedScore,
            bpe_merge_parts: flattenMergePartsForDigitGroup(group, tokens),
            bpe_merged: 'digit' satisfies BpeMergeReason,
        } as T;
    });
}

/**
 * 语义 / 归因 attention 的统一合并：先 overlap（与 BPE 几何一致），可选再 digit；归一化由调用方 {@link normalizeTokenScores} 完成。
 */
export function mergeAttentionTokensFullyForRendering<T extends { offset: [number, number]; raw: string; score: number }>(
    tokens: T[],
    text: string,
    options: DigitMergePipelineOptions = {}
): T[] {
    const overlapped = mergeAttentionTokensForRendering(tokens, text);
    if (options.digitMerge === false) {
        return overlapped;
    }
    return mergeAttentionDigitTokens(overlapped, text);
}

/** bytesPerChunk：UTF-8 字节数；startOffset：字符索引。 */
export function splitTextToChunks(text: string, bytesPerChunk: number): Array<{ text: string; startOffset: number }> {
    if (bytesPerChunk <= 0) {
        throw new Error("分块字节上限必须大于 0，当前值: " + bytesPerChunk);
    }
    if (text.includes("\r")) {
        throw new Error("文本包含 \\r (CR) 换行符，当前仅支持 \\n (LF)。");
    }
    const chunks: Array<{ text: string; startOffset: number }> = [];
    let pos = 0; // 字符索引
    const encodeBuf = new Uint8Array(bytesPerChunk + 1); // +1 使超长行 written>bytesPerChunk，wouldExceed 恒为 true
    while (pos < text.length) {
        let chunkEnd = pos; // 字符索引
        let chunkBytes = 0; // UTF-8 字节数
        outer: while (chunkEnd < text.length) {
            const paragEnd = nextParagraphEnd(text, chunkEnd);
            const paragBytes = getUtf8ByteLength(text.slice(chunkEnd, paragEnd), encodeBuf);
            if (chunkBytes > 0 && chunkBytes + paragBytes > bytesPerChunk) break;
            if (chunkBytes === 0 && paragBytes > bytesPerChunk) {
                // 段落超限，降级到行模式：贪婪消费行直到 chunk 满或段落结束
                while (chunkEnd < paragEnd) {
                    const lineEnd = nextLineEnd(text, chunkEnd);
                    const lineBytes = getUtf8ByteLength(text.slice(chunkEnd, lineEnd), encodeBuf);
                    if (lineBytes > bytesPerChunk) {
                        const maxEnd = charIndexForByteLimit(text, chunkEnd, bytesPerChunk);
                        chunkEnd = findSplitPoint(text, chunkEnd, maxEnd);
                        break outer;
                    }
                    if (chunkBytes > 0 && chunkBytes + lineBytes > bytesPerChunk) break outer;
                    chunkBytes += lineBytes;
                    chunkEnd = lineEnd;
                }
                continue outer; // 段落内所有行已贪婪填充，继续评估下一段落
            }
            chunkBytes += paragBytes;
            chunkEnd = paragEnd;
        }
        chunks.push({ text: text.slice(pos, chunkEnd), startOffset: pos });
        pos = chunkEnd;
    }
    return chunks;
}
