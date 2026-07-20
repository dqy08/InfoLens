import type { AnalysisData, FrontendAnalyzeResult } from '../../shared/api/GLTR_API';
import type { TextStats, DiffStats } from '../../shared/cross/textStatistics';
import type { GLTR_Text_Box } from '../../shared/vis/GLTR_Text_Box';
import type { Histogram } from '../../shared/vis/Histogram';
import type { ScatterPlot } from '../../shared/vis/ScatterPlot';

/**
 * Demo 列数据。
 * - id: 规范化路径（Map key / data-column-id）
 * - DOM 元素 id: toSafeId(id)
 */
export type DemoColumnData = {
    id: string;
    demoPath: string;
    demoName: string;
    data: AnalysisData | null;
    enhancedResult?: FrontendAnalyzeResult | null;
    stats: TextStats | null;
    diffStats?: DiffStats | null;
    error: string | null;
    originalText?: string;
    lmfInstance?: GLTR_Text_Box;
    histograms: {
        stats_frac: Histogram | null;
        stats_byte_frac: Histogram | null;
        stats_surprisal_progress: ScatterPlot | null;
    };
};
