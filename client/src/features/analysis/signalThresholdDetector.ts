/**
 * 信号阈值检测：自动找到「噪声/信号」边界
 *
 * 输入：raw score normed [0,1]
 *
 * API 分层：
 * - `findSignalThreshold`：仅截尾对数正态 + bin 扫描；任一步失败则返回 `null`（无 P90 回退）。
 * - `findSignalThresholdWithLog`：先调 `findSignalThreshold`；成功则原样返回；失败则用「全部有限 score」的 P90 作启发式阈值、
 *   `confidence=0`、`mu=0, sigma=1` 占位、`bins=[]`，并 `console.warn`；若无任何有效分数则 `null`。
 *
 * 算法概要（`findSignalThreshold`）：
 * 1. 预处理：丢弃非有限或 ≤ LN_EPS 的分数；排序后若 n < MIN_SAMPLE_SIZE 则返回 null。
 * 2. 迭代 0：用全部样本（P0=1）拟合截尾对数正态 (μ, σ)，从 startPercentile 分位 bin 起逐 bin 扫描
 *    - 每个 bin [τ_left, τ_right) 左闭右开：obsInBin = 该 bin 内观测计数，expInBin = n × (CDF(τ_right) - CDF(τ_left))
 *    - 纯噪声区：信号样本不在 bin 内 → excess ≈ 0
 *    - 到信号边界：bin 内出现超额样本 → excess 跃升
 *    - 不重叠扫描：bin 边界取相邻点几何均值（对数空间 midpoint），τ_right >= τ_left + MIN_BIN_WIDTH，obsInBin >= MIN_OBSERVED
 *    - 误报概率：cumulativeFalsePositiveProbability = ∏(1-Φ(excess_i))，excess>excessMin 时累积，否则重置
 *    - 当 cumulativeFalsePositiveProbability <= 1-SCAN_SATISFACTION_CONFIDENCE 时，取首次命中 bin 的左边界为阈值（保守）
 *    - 若全程无连续命中链，或链尾仍达不到早停置信度且无有效兜底，evaluateBins 返回 null
 * 3. 迭代 1..N：用 threshold 以下样本重拟合，再扫描；阈值变化不大则提前结束
 * 4. 任一轮出现以下任一情况则整条失败返回 null（不回退）：噪声样本数不足（refinement 时）、拟合失败、扫描无阈值、confidence < MIN_ACCEPTABLE_CONFIDENCE
 *
 * 与现有 lognormalFit 逻辑独立，未来可能替换现有拟合代码
 */

import { quantileSorted } from 'd3-array';
import { fitLogNormalTruncatedMLE, logNormalExpectedCountInInterval, normCdf, LN_EPS } from './lognormalFit';
import { computeFitQuality } from './fitQuality';

/** 扫描置信度阈值，达到此值即判定「确定找到」信号边界；默认 0.99999 */
const SCAN_SATISFACTION_CONFIDENCE = 0.99999;
/** 最小可接受置信度：每轮扫描得到 threshold 后若低于此值则整条失败；与 SCAN_SATISFACTION_CONFIDENCE（扫描早停）不同 */
const MIN_ACCEPTABLE_CONFIDENCE = 0.9;
/** excess 最小阈值，排除无意义随机波动；需 excess > 此值才计为命中 */
const EXCESS_MIN = 0.1;
const MIN_OBSERVED = 1; // 每个 bin 至少 N 个观测
const MIN_BIN_WIDTH = 0.01; // bin 最小宽度；边界取相邻点几何均值（对数空间 midpoint）
const MIN_SAMPLE_SIZE = 20;
const P0 = 1; // 迭代初始的样本拟合比例
const MAX_REFINE_ITER = 10;
const THRESHOLD_CONVERGE_EPS = 0.01; //迭代收敛阈值
/** 扫描起始分位，默认 0.5（从 50% 分位所在 bin 开始） */
const START_PERCENTILE_DEFAULT = 0.5;
/** expInBin 最小有效值，避免除零或数值不稳定 */
const EXP_IN_BIN_EPS = 1e-10;

/** 内部：evaluateBins 的中间结果，仅 threshold + confidence */
interface SignalThresholdScanResult {
    threshold: number;
    confidence: number;
}

/** 对外：findSignalThreshold 成功或 findSignalThresholdWithLog 的 P90 回退 */
export interface signalFitResult {
    threshold: number;
    /** 0~1：成功时为 1-误报概率（≥ MIN_ACCEPTABLE）；P90 回退时为 0 */
    confidence: number;
    /** 成功时为截尾对数正态 μ；P90 回退时为 0（占位，勿用于拟合曲线） */
    mu: number;
    /** 成功时为截尾对数正态 σ；P90 回退时为 1（占位） */
    sigma: number;
    /** 成功时为各 bin 的 expInBin 等；P90 回退为空数组 */
    bins: SignalThresholdBin[];
}

export interface SignalThresholdBin {
    tauLeft: number;
    tauRight: number;
    obsInBin: number;
    expInBin: number;
}

/** 内部：bin 结构（tauLeft/tauRight/obsInBin）仅依赖 sorted，迭代间不变 */
interface BinStructure {
    tauLeft: number;
    tauRight: number;
    obsInBin: number;
}

const TAU_RIGHT_EPSILON = 1e-6;

const PERCENTILE_DIAGNOSTICS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1] as const;

/** P90 回退日志：原文首尾展示长度（UTF-16 码元） */
const FALLBACK_TEXT_HEAD_LEN = 24;
const FALLBACK_TEXT_TAIL_LEN = 24;

function concatTokenRawText(tokens: Array<{ raw?: string }>): string {
    return tokens.map((t) => t.raw ?? '').join('');
}

/** 日志用：总长 ≤ headLen+tailLen+1 时原样返回；否则前 headLen、换行、省略号、换行、后 tailLen */
function formatFallbackTextExcerpt(text: string, headLen: number, tailLen: number): string {
    const maxShort = headLen + tailLen + 1;
    if (text.length <= maxShort) {
        return `${text}`;
    }
    return `${text.slice(0, headLen)}\n……\n${text.slice(-tailLen)}`;
}

/** 计算 excess = (obs - exp) / sqrt(exp)，exp 过小时避免除零 */
function computeExcess(obsInBin: number, expInBin: number): number {
    if (expInBin <= EXP_IN_BIN_EPS) return obsInBin > 0 ? Infinity : 0;
    return (obsInBin - expInBin) / Math.sqrt(expInBin);
}

/** 打印不同分位数下的拟合结果，用于验证渐近一致性 */
function logPercentileDiagnostics(scores: number[]): void {
    const sorted = [...scores].sort((a, b) => a - b);
    const n = sorted.length;
    if (n < 2) return;
    const rows: Array<{ p: number; n: number; mu: number; sigma: number }> = [];
    for (const p of PERCENTILE_DIAGNOSTICS) {
        const pIdx = Math.max(1, Math.min(n, Math.round(n * p)));
        const noiseNorm = sorted.slice(0, pIdx);
        const tau = pIdx < n ? (sorted[pIdx - 1]! + sorted[pIdx]!) / 2 : sorted[pIdx - 1]!;
        const fit = fitLogNormalTruncatedMLE(noiseNorm, tau);
        if (fit) rows.push({ p, n: pIdx, mu: fit.mu, sigma: fit.sigma });
    }
    if (rows.length === 0) return;
    console.log('[signalThreshold] 渐近一致性诊断 (percentile → μ, σ)');
    for (const { p, n, mu, sigma } of rows) {
        console.log(`  p=${p} n=${n}: μ=${mu.toFixed(4)}, σ=${sigma.toFixed(4)}`);
    }
}
/** verbose 时打印完整 bin 扫描日志（独立于 evaluateBins，仅追加输出） */
function printBinScanLogs(bins: SignalThresholdBin[], excessMin: number): void {
    console.log('[signalThreshold] 完整扫描明细 τ_left | τ_right | obsInBin | expInBin | excess | binConf | hit | confidence');
    let cumulativeFalsePositiveProbability = 1;
    let firstHitTauLeft: number | null = null;
    for (const bin of bins) {
        const excess = computeExcess(bin.obsInBin, bin.expInBin);
        const hit = excess > excessMin;
        const binConfidence = normCdf(excess);
        if (hit) {
            if (firstHitTauLeft === null) firstHitTauLeft = bin.tauLeft;
            cumulativeFalsePositiveProbability *= 1 - binConfidence;
            const confidence = 1 - cumulativeFalsePositiveProbability;
            console.log(`[signalThreshold]   ${bin.tauLeft.toFixed(4)} | ${bin.tauRight.toFixed(4)} | ${String(bin.obsInBin).padStart(7)} | ${bin.expInBin.toFixed(1).padStart(8)} | ${excess.toFixed(2).padStart(6)} | ${binConfidence.toFixed(4)} | ✓ | ${confidence.toFixed(4)}`);
        } else {
            cumulativeFalsePositiveProbability = 1;
            firstHitTauLeft = null;
            console.log(`[signalThreshold]   ${bin.tauLeft.toFixed(4)} | ${bin.tauRight.toFixed(4)} | ${String(bin.obsInBin).padStart(7)} | ${bin.expInBin.toFixed(1).padStart(8)} | ${excess.toFixed(2).padStart(6)} | ${binConfidence.toFixed(4)} |   | -`);
        }
    }
}

/** bin 边界取相邻点几何均值（对数空间 midpoint），τ_right >= τ_left + MIN_BIN_WIDTH，obsInBin >= MIN_OBSERVED；仅依赖 sorted，迭代间不变 */
function formBinStructures(sorted: number[]): BinStructure[] {
    const n = sorted.length;
    const mids: number[] = [];
    for (let i = 0; i < n - 1; i++) mids.push(Math.sqrt(sorted[i]! * sorted[i + 1]!));
    const structures: BinStructure[] = [];
    let tauLeft = sorted[0]! - TAU_RIGHT_EPSILON;

    while (tauLeft < sorted[n - 1]!) {
        let midIdx = mids.findIndex((m) => m >= tauLeft + MIN_BIN_WIDTH);
        let tauRight = midIdx >= 0 ? mids[midIdx]! : sorted[n - 1]! + TAU_RIGHT_EPSILON;

        let leftIdx = sorted.findIndex((v) => v >= tauLeft);
        let rightIdx = midIdx >= 0 ? sorted.findIndex((v) => v >= tauRight) : -1;
        let obsInBin = leftIdx < 0 ? 0 : rightIdx < 0 ? n - leftIdx : rightIdx - leftIdx;

        while (obsInBin < MIN_OBSERVED && midIdx >= 0 && midIdx < mids.length - 1) {
            midIdx++;
            tauRight = mids[midIdx]!;
            rightIdx = sorted.findIndex((v) => v >= tauRight);
            obsInBin = leftIdx < 0 ? 0 : rightIdx < 0 ? n - leftIdx : rightIdx - leftIdx;
        }
        if (obsInBin < MIN_OBSERVED) {
            tauRight = sorted[n - 1]! + TAU_RIGHT_EPSILON;
            rightIdx = -1;
            obsInBin = leftIdx < 0 ? 0 : n - leftIdx;
            if (obsInBin < MIN_OBSERVED) break;
        }

        structures.push({ tauLeft, tauRight, obsInBin });
        tauLeft = tauRight;
        if (tauRight >= sorted[n - 1]! + TAU_RIGHT_EPSILON) break;
    }
    return structures;
}

/** 遍历 bin 结构，按需计算 expInBin，返回阈值结果；通过 obsInBin 累积找到 startPercentile 分位对应 bin，从该 bin 开始扫描 */
function evaluateBins(
    structures: BinStructure[],
    n: number,
    mu: number,
    sigma: number,
    excessMin: number,
    confidenceThreshold: number,
    verbose: boolean,
    startPercentile: number
): SignalThresholdScanResult | null {
    let cumulativeFalsePositiveProbability = 1;
    let firstHitTauLeft: number | null = null;

    const K = Math.min(Math.floor((n - 1) * startPercentile), n - 1);
    let cumSum = 0;
    let startIdx = 0;
    for (let i = 0; i < structures.length; i++) {
        if (K < cumSum + structures[i]!.obsInBin) {
            startIdx = i;
            break;
        }
        cumSum += structures[i]!.obsInBin;
    }
    const structuresToScan = structures.slice(startIdx);

    if (verbose) {
        console.log('[signalThreshold] 扫描明细 τ_left | τ_right | obsInBin | expInBin | excess | binConf | hit | confidence');
    }

    for (const s of structuresToScan) {
        const expInBin = logNormalExpectedCountInInterval(s.tauLeft, s.tauRight, n, mu, sigma);
        const excess = computeExcess(s.obsInBin, expInBin);
        const hit = excess > excessMin;
        const binConfidence = normCdf(excess);

        if (hit) {
            if (firstHitTauLeft === null) firstHitTauLeft = s.tauLeft;
            cumulativeFalsePositiveProbability *= 1 - binConfidence;
            const confidence = 1 - cumulativeFalsePositiveProbability;
            if (verbose) {
                console.log(`[signalThreshold]   ${s.tauLeft.toFixed(4)} | ${s.tauRight.toFixed(4)} | ${String(s.obsInBin).padStart(7)} | ${expInBin.toFixed(1).padStart(8)} | ${excess.toFixed(2).padStart(6)} | ${binConfidence.toFixed(4)} | ✓ | ${confidence.toFixed(4)}`);
            }
            if (confidence >= confidenceThreshold) {
                return { threshold: firstHitTauLeft, confidence };
            }
        } else {
            cumulativeFalsePositiveProbability = 1;
            firstHitTauLeft = null;
            if (verbose) {
                console.log(`[signalThreshold]   ${s.tauLeft.toFixed(4)} | ${s.tauRight.toFixed(4)} | ${String(s.obsInBin).padStart(7)} | ${expInBin.toFixed(1).padStart(8)} | ${excess.toFixed(2).padStart(6)} | ${binConfidence.toFixed(4)} |   | -`);
            }
        }
    }

    if (firstHitTauLeft !== null) {
        return { threshold: firstHitTauLeft, confidence: 1 - cumulativeFalsePositiveProbability };
    }
    return null;
}

/**
 * 从 raw score normed 数组自动检测信号阈值（内部会丢弃 ≤ LN_EPS 的样本后再算 n 与拟合）
 * @param rawScoresNormed 归一化分数 [0,1]
 * @param verbose 是否输出详细日志，默认 false
 * @returns 成功时返回完整结果 { threshold, confidence, mu, sigma, bins }；任一轮失败（见文件头）时返回 null
 */
export function findSignalThreshold(
    rawScoresNormed: number[],
    verbose = false
): signalFitResult | null {
    const values = rawScoresNormed.filter(
        (s) => typeof s === 'number' && isFinite(s) && s > LN_EPS
    );
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;

    if (n < MIN_SAMPLE_SIZE) {
        if (verbose) console.log('[signalThreshold] 样本不足 n<', MIN_SAMPLE_SIZE, '，跳过');
        return null;
    }

    const p0 = P0;
    const splitIdx = Math.max(1, Math.min(n, Math.round(n * p0)));
    if (verbose) console.log('[signalThreshold] n=', n, 'splitIdx=', splitIdx);

    let result: SignalThresholdScanResult | null = null;
    let lastFit = { mu: 0, sigma: 0 };
    const binStructures = formBinStructures(sorted);

    for (let iter = 0; iter <= MAX_REFINE_ITER; iter++) {
        if (iter > 0 && result === null) return null;
        const thresholdForNoise = result?.threshold ?? 0;
        const noiseSamples = iter === 0
            ? sorted.slice(0, splitIdx)
            : sorted.filter((x) => x <= thresholdForNoise);
        const tauBoundary = iter === 0
            ? (splitIdx < n ? (sorted[splitIdx - 1]! + sorted[splitIdx]!) / 2 : sorted[splitIdx - 1]!)
            : thresholdForNoise;

        if (iter > 0 && noiseSamples.length < MIN_SAMPLE_SIZE) {
            if (verbose) console.log('[signalThreshold] 迭代', iter, '失败：噪声样本数<', MIN_SAMPLE_SIZE);
            return null;
        }

        if (verbose && iter === 0) {
            const nInit = noiseSamples.length;
            const minN = noiseSamples[0]!, maxN = noiseSamples[nInit - 1]!;
            const midN = noiseSamples[Math.floor(nInit / 2)]!;
            console.log('[signalThreshold] 迭代 0 噪声样本 n=', nInit, 'min=', minN.toFixed(4), 'max=', maxN.toFixed(4), 'median=', midN.toFixed(4));
        }

        const fit = fitLogNormalTruncatedMLE(noiseSamples, tauBoundary);
        if (fit === null) {
            if (verbose) console.log('[signalThreshold] 迭代', iter, '失败：拟合失败');
            return null;
        }
        lastFit = { mu: fit.mu, sigma: fit.sigma };

        const q = computeFitQuality(noiseSamples, tauBoundary, fit.mu, fit.sigma);
        if (verbose) {
            console.log('[signalThreshold] 迭代', iter, '拟合 μ=', fit.mu.toFixed(4), 'σ=', fit.sigma.toFixed(4), '| maxDiff=', q.maxDiff.toFixed(4), 'RMSE=', q.rmse.toFixed(4));
            if (iter === 0) {
                console.log('[signalThreshold] 迭代', iter, '从', (START_PERCENTILE_DEFAULT * 100).toFixed(0), '% 分位 bin 开始扫描 (excess>', EXCESS_MIN, ', confidence>=', SCAN_SATISFACTION_CONFIDENCE, ')');
            }
        }

        const scanResult = evaluateBins(binStructures, n, fit.mu, fit.sigma, EXCESS_MIN, SCAN_SATISFACTION_CONFIDENCE, verbose, START_PERCENTILE_DEFAULT);
        if (scanResult === null) {
            if (verbose) console.log('[signalThreshold] 迭代', iter, '失败：未检测到阈值');
            return null;
        }

        if (scanResult.confidence < MIN_ACCEPTABLE_CONFIDENCE) {
            console.warn(
                '[signalThreshold] 迭代',
                iter,
                '失败：confidence <',
                MIN_ACCEPTABLE_CONFIDENCE,
                '。当前',
                scanResult.confidence.toFixed(4)
            );
            return null;
        }

        const savedThreshold = result?.threshold;
        result = scanResult;

        if (iter > 0 && savedThreshold !== undefined) {
            const delta = Math.abs(result.threshold - savedThreshold);
            if (verbose) {
                console.log('[signalThreshold] 迭代', iter, '新阈值=', result.threshold.toFixed(4), 'confidence=', result.confidence.toFixed(2), 'delta=', delta.toFixed(6));
            }
            if (delta < THRESHOLD_CONVERGE_EPS) {
                if (verbose) console.log('[signalThreshold] 迭代', iter, '收敛，最终阈值=', result.threshold.toFixed(4));
                break;
            }
            if (iter === MAX_REFINE_ITER && verbose) {
                console.log('[signalThreshold] 达到最大迭代次数，最终阈值=', result.threshold.toFixed(4));
            }
        } else if (verbose) {
            console.log('[signalThreshold] 迭代 0 检测到阈值', result.threshold.toFixed(4), 'confidence=', result.confidence.toFixed(2));
        }
    }

    const bins: SignalThresholdBin[] = binStructures.map((s) => ({
        ...s,
        expInBin: logNormalExpectedCountInInterval(s.tauLeft, s.tauRight, n, lastFit.mu, lastFit.sigma),
    }));
    if (verbose && bins.length > 0) {
        printBinScanLogs(bins, EXCESS_MIN);
        logPercentileDiagnostics(values);
    }
    if (result === null) return null;
    return { ...result, mu: lastFit.mu, sigma: lastFit.sigma, bins };
}

/** 读取 window.signalThresholdVerbose，默认 false */
function getVerboseFromWindow(): boolean {
    return !!(typeof window !== 'undefined' && (window as Window & { signalThresholdVerbose?: boolean }).signalThresholdVerbose);
}

/**
 * findSignalThreshold 的封装：调用后打印 [signalThreshold] 日志并返回结果。
 * 检测失败时返回 P90 分位为阈值的启发式结果（confidence=0，与成功拟合的 confidence≥MIN_ACCEPTABLE 区分），无有效分数时返回 null。
 */
export function findSignalThresholdWithLog(
    tokens: Array<{ score: number; raw?: string }>,
    verbose = getVerboseFromWindow()
): signalFitResult | null {
    const rawScoresNormed = tokens.map(t => t.score).filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
    if (rawScoresNormed.length === 0) {
        console.warn('[signalThreshold] 无有效分数，跳过阈值');
        return null;
    }

    const result = findSignalThreshold(rawScoresNormed, verbose);
    if (result !== null) {
        if (verbose) {
            const t = result.threshold;
            const below = rawScoresNormed.filter((s) => s < t).length;
            const quantile = below / rawScoresNormed.length;
            console.log(
                '[signalThreshold]',
                `threshold=${t.toFixed(4)} confidence=${result.confidence.toFixed(2)} (quantile=${quantile.toFixed(4)}, ${below}/${rawScoresNormed.length} below) μ=${result.mu.toFixed(4)} σ=${result.sigma.toFixed(4)}`
            );
        }
        return result;
    }

    const sorted = [...rawScoresNormed].sort((a, b) => a - b);
    const p90 = quantileSorted(sorted, 0.9);
    const below = rawScoresNormed.filter((s) => s < p90).length;
    const quantile = below / rawScoresNormed.length;

    const rawText = concatTokenRawText(tokens);
    const textHint =
        rawText.length > 0
            ? ` | ${formatFallbackTextExcerpt(rawText, FALLBACK_TEXT_HEAD_LEN, FALLBACK_TEXT_TAIL_LEN)}`
            : '';
    console.warn(
        `[signalThreshold] 自动阈值检测失败，已使用 P90 分位作为启发式阈值（confidence=0）${textHint}`
    );
    if (verbose) {
        console.log(
            '[signalThreshold]',
            `threshold=${p90.toFixed(4)} (P90 fallback) confidence=0.00 (quantile=${quantile.toFixed(4)}, ${below}/${rawScoresNormed.length} below) 无截尾对数正态拟合`
        );
    }

    return {
        threshold: p90,
        confidence: 0,
        mu: 0,
        sigma: 1,
        bins: [],
    };
}
