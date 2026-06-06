import { tr } from '../../shared/lang/i18n-lite';
import type { HistogramExtent, HistogramExtentBound } from '../../shared/vis/Histogram';

export type { HistogramExtent, HistogramExtentBound };

/**
 * 直方图基础配置类型
 */
export interface HistogramBaseConfig {
  label: string;
  no_bins: number;
  extent: HistogramExtent;
  averageLabel?: string;
  showLeftInfinity?: boolean;
  showRightInfinity?: boolean;
  xAxisTickSkip?: number;
  /** x轴刻度凑整：true=仅显示 step 整数倍处的标签，false/undefined=显示全部 */
  xAxisTickRound?: boolean;
  yScaleType?: 'linear' | 'sqrt' | 'log';
}

/**
 * 散点图基础配置类型
 */
export interface ScatterPlotBaseConfig {
  xLabel: string;
  yLabel: string;
  label?: string;
}

/**
 * 获取 Token information 直方图配置（支持国际化）
 */
export const getTokenSurprisalHistogramConfig = (): HistogramBaseConfig => ({
  label: tr("information per token histogram"),
  no_bins: 19,
  extent: [0, 19],
  averageLabel: tr("bits/token"),
  showRightInfinity: true,
});

/**
 * 获取 Byte information 直方图配置（支持国际化）
 */
export const getByteSurprisalHistogramConfig = (): HistogramBaseConfig => ({
  label: tr("information per byte histogram"),
  no_bins: 13,
  extent: [0, 6.5],
  averageLabel: tr("bits/Byte"),
  showRightInfinity: true,
});

/**
 * 获取 ΔByte information 直方图配置（支持国际化）
 */
export const getDeltaByteSurprisalHistogramConfig = (): HistogramBaseConfig => ({
  label: tr("Δinformation per byte histogram"),
  no_bins: 20,
  xAxisTickSkip: 1,
  xAxisTickRound: true,
  extent: [-5, 5],
  averageLabel: tr("Δ bits/Byte"),
  showLeftInfinity: true,
  showRightInfinity: true,
});

/**
 * 获取 Information progress 散点图配置（支持国际化）
 */
export const getSurprisalProgressConfig = (): ScatterPlotBaseConfig => ({
  label: tr("information per token progress"),
  xLabel: tr("token index"),
  yLabel: tr("information (bits)"),
});

/**
 * 获取 semantic match progress 配置（支持国际化）
 * x 轴为字符偏移，y 轴为 chunk 匹配度
 */
export const getMatchScoreProgressConfig = (): ScatterPlotBaseConfig => ({
  label: tr("semantic match progress"),
  xLabel: tr("character offset"),
  yLabel: tr("chunk match degree"),
});

/**
 * 获取 Raw score normed 直方图配置（归一化 0-1）
 */
export const getRawScoreNormedHistogramConfig = (): HistogramBaseConfig => ({
  label: tr("semantic score histogram"),
  no_bins: 20,
  xAxisTickSkip: 1,
  xAxisTickRound: true,
  extent: [0, 1],
  yScaleType: 'sqrt',
});

