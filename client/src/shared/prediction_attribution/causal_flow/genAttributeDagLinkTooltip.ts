/**
 * DAG 边 / 节点归因 tooltip 文案（SVG `<title>` 与 matrix 格 HUD 同源）。
 * 纯格式化：不拥有图状态或 DOM。
 */
import * as d3 from 'd3';
import { visualizeSpecialChars } from '../../cross/tokenDisplayUtils';
import { formatTopkTooltipProbabilityPercent } from '../../cross/topkChartUtils';
import { DAG_MIN_ATTRIBUTION_SHARE } from './genAttributeDagEdgeDisplay';

const TOOLTIP_NA = 'N/A';

const DAG_LINK_TOOLTIP_LABEL_OPTS = { spaceDotExceptBeforeAsciiLetterOrNumber: true as const };

/** 边原生 `<title>` 中互信息率 α 的展示。 */
export function formatMutualInformationRatioForTooltip(miRatio: number | undefined): string {
    if (miRatio === undefined || !Number.isFinite(miRatio)) return TOOLTIP_NA;
    return formatTopkTooltipProbabilityPercent(miRatio);
}

function isPositiveFiniteShare(share: number | undefined): share is number {
    return typeof share === 'number' && Number.isFinite(share) && share > 0;
}

export function formatTooltipAttributionScore(normalizedScore: number | undefined): string {
    if (normalizedScore === undefined || !Number.isFinite(normalizedScore)) return TOOLTIP_NA;
    return normalizedScore.toFixed(3);
}

/** 直接归因份额的展示：L1 份额 × 目标真实 MI（与弱化开关无关，仅供读数）。 */
export function formatTooltipDirectAttributionShare(
    attributionShare: number | undefined,
    miRatio: number | undefined,
): string {
    if (!isPositiveFiniteShare(attributionShare)) return TOOLTIP_NA;
    if (miRatio === undefined || !Number.isFinite(miRatio)) return TOOLTIP_NA;
    return formatTopkTooltipProbabilityPercent(attributionShare * miRatio);
}

export function formatTooltipRecursiveAttributionShare(share: number | undefined): string {
    if (share === undefined || !Number.isFinite(share)) return TOOLTIP_NA;
    return formatAttributionSharePercentForTooltip(share);
}

/** 节点 tooltip 归因份额：低于阈值时显示 `< x%`。 */
export function formatAttributionSharePercentForTooltip(share: number): string {
    const thresholdLabel = d3.format('.1g')(DAG_MIN_ATTRIBUTION_SHARE * 100) + '%';
    if (!Number.isFinite(share) || share < DAG_MIN_ATTRIBUTION_SHARE) {
        return `< ${thresholdLabel}`;
    }
    return formatTopkTooltipProbabilityPercent(share);
}

export function formatTooltipLinkStrength(strength: number): string {
    return Number.isFinite(strength) ? strength.toFixed(3) : TOOLTIP_NA;
}

/** 节点 id 为 `start_end`，用于原生 `<title>` 文案 */
export function formatNodeOffsetRange(id: string): string {
    const i = id.indexOf('_');
    if (i <= 0) return id;
    const a = id.slice(0, i);
    const b = id.slice(i + 1);
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return id;
    return `[${a}, ${b})`;
}

export type DagLinkTitleNode = {
    id: string;
    label: string;
};

/**
 * 边当前显示状态快照；与 stroke 一并刷新 `<title>` / matrix HUD。
 */
export type DagLinkTitleSnapshot = {
    normalizedScore?: number;
    mutualInformationRatio?: number;
    attributionShare?: number;
    alignmentNote?: string;
    src: DagLinkTitleNode;
    tgt: DagLinkTitleNode;
    /** 递归链入边上的传播份额；不在链上时为 undefined。 */
    recursiveAttributionShare?: number;
    linkStrength: number;
};

/** 边 tooltip 指标行（SVG `<title>` 与 matrix 格 HUD 同源）。 */
export function buildLinkTitleMetricRows(snapshot: DagLinkTitleSnapshot): {
    staticRows: Array<{ label: string; value: string }>;
    dynamicRows: Array<{ label: string; value: string }>;
    alignmentNote?: string;
} {
    return {
        staticRows: [
            {
                label: 'Attribution score:',
                value: formatTooltipAttributionScore(snapshot.normalizedScore),
            },
            {
                label: 'Target MI ratio:',
                value: formatMutualInformationRatioForTooltip(snapshot.mutualInformationRatio),
            },
            {
                label: 'Attribution share (Adjacent):',
                value: formatTooltipDirectAttributionShare(
                    snapshot.attributionShare,
                    snapshot.mutualInformationRatio,
                ),
            },
        ],
        alignmentNote: snapshot.alignmentNote,
        dynamicRows: [
            {
                label: 'Attribution share (Propagated):',
                value: formatTooltipRecursiveAttributionShare(snapshot.recursiveAttributionShare),
            },
            {
                label: 'Link strength:',
                value: formatTooltipLinkStrength(snapshot.linkStrength),
            },
        ],
    };
}

export function buildLinkTitleText(snapshot: DagLinkTitleSnapshot): string {
    const { staticRows, dynamicRows, alignmentNote } = buildLinkTitleMetricRows(snapshot);
    const staticMetrics = staticRows.map((r) => `${r.label} ${r.value}`);
    if (alignmentNote) staticMetrics.push(alignmentNote);

    const metrics = [
        staticMetrics.join('\n'),
        '',
        ...dynamicRows.map((r) => `${r.label} ${r.value}`),
    ];

    return [
        `From:\n${visualizeSpecialChars(snapshot.src.label, DAG_LINK_TOOLTIP_LABEL_OPTS)}\nOffset: ${formatNodeOffsetRange(snapshot.src.id)}`,
        `To:\n${visualizeSpecialChars(snapshot.tgt.label, DAG_LINK_TOOLTIP_LABEL_OPTS)}\nOffset: ${formatNodeOffsetRange(snapshot.tgt.id)}`,
        metrics.join('\n'),
    ].join('\n\n');
}
