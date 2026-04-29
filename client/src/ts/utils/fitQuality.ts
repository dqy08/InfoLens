/**
 * 拟合质量计算（纯数学，无 Node 依赖）
 */

import { logNormalCdf } from './lognormalFit';

/**
 * 计算截尾对数正态在拟合区间内的拟合质量（仅用拟合数据）
 * @returns { maxDiff, rmse, maxDiffIdx } maxDiff = max|CDF_trunc - ECDF|，rmse = sqrt(mean(diff²))
 */
export function computeFitQuality(
    noise: number[],
    tau: number,
    mu: number,
    sigma: number
): { maxDiff: number; rmse: number; maxDiffIdx: number } {
    const nNoise = noise.length;
    if (nNoise < 1) return { maxDiff: NaN, rmse: NaN, maxDiffIdx: -1 };
    const F_tau = logNormalCdf(tau, mu, sigma);
    const cdfTrunc = (x: number) =>
        x <= 0 ? 0 : x >= tau ? 1 : logNormalCdf(x, mu, sigma) / F_tau;

    let maxDiff = 0;
    let maxDiffIdx = 0;
    let sumSqDiff = 0;
    for (let i = 0; i < nNoise; i++) {
        const x = noise[i]!;
        const ecdf = (i + 1) / nNoise;
        const cdf = cdfTrunc(x);
        const diff = cdf - ecdf;
        if (Math.abs(diff) > maxDiff) {
            maxDiff = Math.abs(diff);
            maxDiffIdx = i;
        }
        sumSqDiff += diff * diff;
    }
    const rmse = Math.sqrt(sumSqDiff / nNoise);
    return { maxDiff, rmse, maxDiffIdx };
}
