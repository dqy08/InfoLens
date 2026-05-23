/**
 * DAG 区间对齐层（纯函数，无副作用）。
 *
 * 背景：后端 `token_attribution[].offset` 依据「当前 context 上 tokenizer 的 piece 切分」给出，
 * 而 DAG 节点依据「每步生成累加的 token 字符串」建立；两套切分在子词边界上可能不一致：
 * - 合并型：piece 覆盖历史上多步分别生成的相邻节点（如 `"如下"` 覆盖 `"如"`+`"下"`）。
 * - 拆分型：同一历史节点区间被当前 tokenizer 拆成多条 piece。
 * - 交叉型：非整齐边界的重叠（极少见）。
 *
 * 本模块把一条 piece 的 `[attrStart, attrEnd)` 映射到已存在 DAG 节点集合上，按「字符长度占比」分权。
 * 对齐完成后，以 nodeId 为键把 piece 的 score 聚合（Σ piece.score × weight），再经
 * {@link ./genAttributeDagPreprocess excludeNodeAggregatedEntries}（prompt / 已生成区 exclude）与
 * {@link ./genAttributeDagPreprocess phase2RankAndSparsify}，在「节点/展示单元」语义上做筛选。
 *
 * 任何非 `exact` 的对齐都会打一条 warn，便于观测 tokenizer 行为与 DAG 节点粒度的偏离。
 */

/** 对齐层需要的节点最小信息（与 view 中 DagNode 的子集） */
export type NodeInterval = {
    id: string;
    start: number;
    end: number;
    /** 节点显示字符串（仅用于聚合后输出 `raw`，不参与匹配） */
    label: string;
};

/** 归因 piece 在某节点区间上的权重份额（Σ weight = 1，除非 `empty`） */
export type NodeAssignment = {
    nodeId: string;
    weight: number;
};

/**
 * 对齐分类：
 * - `exact`：piece 区间与某节点区间完全一致（常态，无 warn）。
 * - `contained`：piece 严格落入某节点内部（拆分型；1 条 piece → 1 个节点，weight=1）。
 * - `union`：piece 区间恰好等于若干相邻节点区间的并集（合并型；如「如下」）。
 * - `overlap`：既不 exact / contained / union 的重叠（非整齐边界，按重叠字符数分权）。
 * - `empty`：与任何节点均无重叠（一般不应发生）。
 */
export type AlignmentCase = 'exact' | 'contained' | 'union' | 'overlap' | 'empty';

export type ResolveResult = {
    assignments: NodeAssignment[];
    kase: AlignmentCase;
};

/**
 * 按 `[attrStart, attrEnd)` 在 `sortedNodes`（按 `start` 升序、互不重叠）上求重叠节点。
 * 返回的每条 `{nodeId, weight}` 的 `weight = 重叠字符数 / attr 长度`，Σweight=1（除 `empty`）。
 */
export function resolveAttrOffsetToNodes(
    sortedNodes: ReadonlyArray<NodeInterval>,
    attrStart: number,
    attrEnd: number,
): ResolveResult {
    if (attrEnd <= attrStart) return { assignments: [], kase: 'empty' };

    const overlapping: Array<{ node: NodeInterval; overlap: number }> = [];
    for (const n of sortedNodes) {
        if (n.end <= attrStart) continue;
        if (n.start >= attrEnd) break;
        const s = Math.max(n.start, attrStart);
        const e = Math.min(n.end, attrEnd);
        if (e > s) overlapping.push({ node: n, overlap: e - s });
    }
    if (overlapping.length === 0) return { assignments: [], kase: 'empty' };

    const attrLen = attrEnd - attrStart;
    const assignments: NodeAssignment[] = overlapping.map(({ node, overlap }) => ({
        nodeId: node.id,
        weight: overlap / attrLen,
    }));

    if (overlapping.length === 1) {
        const only = overlapping[0]!.node;
        if (only.start === attrStart && only.end === attrEnd) {
            return { assignments, kase: 'exact' };
        }
        return { assignments, kase: 'contained' };
    }

    const first = overlapping[0]!.node;
    const last = overlapping[overlapping.length - 1]!.node;
    const coversExactly = first.start === attrStart && last.end === attrEnd;
    let contiguous = coversExactly;
    if (contiguous) {
        for (let i = 0; i < overlapping.length - 1; i++) {
            if (overlapping[i]!.node.end !== overlapping[i + 1]!.node.start) {
                contiguous = false;
                break;
            }
        }
    }
    return { assignments, kase: contiguous ? 'union' : 'overlap' };
}

/** 聚合层输入：piece 级（offset 来自后端 `token_attribution`） */
export type PieceEntry = {
    offset: [number, number];
    raw: string;
    score: number;
};

/** 聚合层输出：按节点聚合后的条目（携带 `nodeId`，`offset`/`raw` 取自节点） */
export type NodeAggregatedEntry = {
    nodeId: string;
    offset: [number, number];
    raw: string;
    /** Σ(piece.score × weight)，保留负值/0 的可能性交给下游按 `Math.max(0,·)` 处理 */
    score: number;
    /**
     * 每条非 `exact` piece 贡献到该节点时追加一行，与 `console.warn` 输出整行一致（含 `[genAttributeDagView.align]` 前缀）。
     */
    alignmentTooltipLines?: string[];
};

/** 对齐层 warn / {@link formatAlignmentPieceLine} 的上下文（用于日志与边 tooltip），无副作用。 */
export type AlignWarnContext = {
    /** 当前步下标（与 view `stepProcessed` 一致） */
    step?: number;
    /** target token 便于定位 */
    targetToken?: string;
};

/** `console.warn` 与边 tooltip 共用的前缀。 */
export const GEN_ATTR_DAG_ALIGN_LOG_PREFIX = '[genAttributeDagView.align]';

/**
 * 与 `console.warn` 正文同构（不含前缀）；完整一行见 {@link formatAlignmentWarnLine}。
 */
export function formatAlignmentPieceLine(
    kase: AlignmentCase,
    as: number,
    ae: number,
    attr: PieceEntry,
    assignments: ReadonlyArray<NodeAssignment>,
    warnCtx?: AlignWarnContext,
): string {
    const ctx =
        (warnCtx?.step !== undefined ? ` step=${warnCtx.step}` : '') +
        (warnCtx?.targetToken !== undefined ? ` target="${warnCtx.targetToken}"` : '');
    const detail = assignments.length
        ? assignments.map((a) => `${a.nodeId}×${a.weight.toFixed(3)}`).join(', ')
        : '(none)';
    return `${kase} attr=[${as},${ae}) "${attr.raw}" score=${attr.score}${ctx} → ${detail}`;
}

/** 与 `console.warn` 输出整行一致（前缀 + {@link formatAlignmentPieceLine}）。 */
export function formatAlignmentWarnLine(
    kase: AlignmentCase,
    as: number,
    ae: number,
    attr: PieceEntry,
    assignments: ReadonlyArray<NodeAssignment>,
    warnCtx?: AlignWarnContext,
): string {
    return `${GEN_ATTR_DAG_ALIGN_LOG_PREFIX} ${formatAlignmentPieceLine(kase, as, ae, attr, assignments, warnCtx)}`;
}

/** 同一 `(kase, attr 区间)` 在多步中重复出现时只打一次 warn；新一次生成前请 {@link clearGenAttributeDagAlignmentWarnDedupe}。 */
const alignmentWarnOnceKeys = new Set<string>();

function alignmentWarnDedupeKey(kase: AlignmentCase, as: number, ae: number): string {
    return `${kase}\0${as}\0${ae}`;
}

/** 在 DAG 清空/新一轮生成开始时调用，避免跨会话永远抑制同类 warn。 */
export function clearGenAttributeDagAlignmentWarnDedupe(): void {
    alignmentWarnOnceKeys.clear();
}

/**
 * 对每条 piece 做 {@link resolveAttrOffsetToNodes}，按 nodeId 聚合 `score = Σ piece.score × weight`。
 * 非 `exact` 分类触发 `console.warn`（含 kase / attr 区间 / raw / score / 分配结果）；同一 `(kase,[as,ae))` 在一次运行内只 warn 一次。
 * 返回条目的次序按「聚合中首次出现的 nodeId」；下游 phase2 会按 score 重新排序。
 */
export function alignAndAggregateByNode(
    entries: ReadonlyArray<PieceEntry>,
    nodes: ReadonlyArray<NodeInterval>,
    warnCtx?: AlignWarnContext,
): NodeAggregatedEntry[] {
    const sorted = nodes.slice().sort((a, b) => a.start - b.start);
    const byNodeId = new Map<string, NodeInterval>();
    for (const n of sorted) byNodeId.set(n.id, n);

    const acc = new Map<string, NodeAggregatedEntry>();
    const order: string[] = [];

    for (const attr of entries) {
        const [as, ae] = attr.offset;
        const { assignments, kase } = resolveAttrOffsetToNodes(sorted, as, ae);
        const warnLine =
            kase !== 'exact'
                ? formatAlignmentWarnLine(kase, as, ae, attr, assignments, warnCtx)
                : null;
        if (warnLine !== null) {
            const dedupeKey = alignmentWarnDedupeKey(kase, as, ae);
            if (!alignmentWarnOnceKeys.has(dedupeKey)) {
                alignmentWarnOnceKeys.add(dedupeKey);
                // eslint-disable-next-line no-console
                console.warn(warnLine);
            }
        }
        const pieceAdjusted = kase !== 'exact';
        for (const a of assignments) {
            const node = byNodeId.get(a.nodeId);
            if (!node) continue;
            const delta = attr.score * a.weight;
            const existing = acc.get(a.nodeId);
            if (existing) {
                existing.score += delta;
                if (pieceAdjusted && warnLine !== null) {
                    if (!existing.alignmentTooltipLines) {
                        existing.alignmentTooltipLines = [];
                    }
                    existing.alignmentTooltipLines.push(warnLine);
                }
            } else {
                acc.set(a.nodeId, {
                    nodeId: a.nodeId,
                    offset: [node.start, node.end],
                    raw: node.label,
                    score: delta,
                    alignmentTooltipLines: pieceAdjusted && warnLine !== null ? [warnLine] : undefined,
                });
                order.push(a.nodeId);
            }
        }
    }

    return order.map((id) => acc.get(id)!);
}
