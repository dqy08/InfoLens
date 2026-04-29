/**
 * 对数正态噪声拟合（纯数学，无依赖）
 * 供 visualizationUpdater 使用，可独立在 Node 中测试
 */

export const LN_EPS = 1e-10;

/** 标准正态 CDF Φ(x)，Abramowitz & Stegun 26.2.17 近似 */
export function normCdf(x: number): number {
    if (x <= -6) return 0;
    if (x >= 6) return 1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1 / (1 + p * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x / 2);
    return 0.5 * (1 + sign * y);
}

/** 对数正态 CDF：F(x) = Φ((log(x) - μ) / σ)，x > 0 */
export function logNormalCdf(x: number, mu: number, sigma: number): number {
    if (x <= 0) return 0;
    return normCdf((Math.log(x) - mu) / sigma);
}

/** 区间 [a, b) 在 log-normal(μ,σ) 下的期望计数：n × (CDF(b) - CDF(a)) */
export function logNormalExpectedCountInInterval(
    a: number, b: number, n: number, mu: number, sigma: number
): number {
    return n * (logNormalCdf(b, mu, sigma) - logNormalCdf(a, mu, sigma));
}

/** 对数正态 PDF：f(x) = φ((log(x)-μ)/σ) / (xσ)，x > 0 */
export function logNormalPdf(x: number, mu: number, sigma: number): number {
    if (x <= 0 || sigma <= 0) return 0;
    const z = (Math.log(x) - mu) / sigma;
    return normPdf(z) / (x * sigma);
}

/** 标准正态 PDF φ(x) */
function normPdf(x: number): number {
    return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

/** 逆 Mills 比率 λ(α) = φ(α)/Φ(α)，α → −∞ 时近似 |α| */
function millsRatio(alpha: number): number {
    const Phi = normCdf(alpha);
    if (Phi < 1e-300) return Math.abs(alpha);
    return normPdf(alpha) / Phi;
}

/**
 * 截尾对数正态 MLE（右截尾于 τ）
 * 导出供测试对比 tau=max(samples) vs tau=固定值
 */
export function fitLogNormalTruncatedMLE(
    noiseScores: number[],
    tau: number
): { mu: number; sigma: number } | null {
    const n = noiseScores.length;
    if (n < 2 || tau <= LN_EPS) return null;

    const T = Math.log(tau);
    const logData = noiseScores.map(x => Math.log(x));
    const ybar = logData.reduce((a, b) => a + b, 0) / n;
    const s2 = logData.reduce((a, x) => a + (x - ybar) ** 2, 0) / n;
    const s = Math.sqrt(s2);
    if (s <= 0 || !isFinite(s)) return null;

    const delta = T - ybar;

    const F = (alpha: number): number => {
        const lam = millsRatio(alpha);
        if (!isFinite(lam)) return delta > 0 ? -1 : 1;
        const g = alpha + lam;
        const h = 1 - lam * g;
        if (h <= 0) return NaN;
        return g - (delta / s) * Math.sqrt(h);
    };

    const lo0 = -8, hi0 = delta / s + 8;
    const Flo = F(lo0), Fhi = F(hi0);
    if (!isFinite(Flo) || !isFinite(Fhi) || Flo * Fhi > 0) return null;

    let lo = lo0, hi = hi0, Flo_cur = Flo;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const Fmid = F(mid);
        if (!isFinite(Fmid) || (hi - lo) < 1e-12) break;
        if (Flo_cur * Fmid <= 0) { hi = mid; }
        else { lo = mid; Flo_cur = Fmid; }
    }

    const alpha = (lo + hi) / 2;
    const lam = millsRatio(alpha);
    if (!isFinite(lam)) return null;
    const h = 1 - lam * (alpha + lam);
    if (h <= 0) return null;

    const sigma = s / Math.sqrt(h);
    const mu = ybar + sigma * lam;
    if (!isFinite(sigma) || sigma <= 0 || !isFinite(mu)) return null;
    return { mu, sigma };
}

/*
 * todo: 未知原因的偏差现象：
 * Monte Carlo 下 E[μ̂] 随 n 减小单调增大（系统性正偏），而非围绕真值的随机波动。
> inforadar@0.1.0 test:lognormal:tau
> npx tsx ts/utils/lognormalFit.tauBoundary.test.ts
=== 截尾对数正态拟合硬指标测试 ===

真实参数: μ=-2, σ=0.8, τ=1
Monte Carlo 500 次，fitLogNormalNoiseExpectedCounts percentile=0.9

n      | E[μ̂]    E[σ̂]    Δμ      Δσ
-------|------------------------------
 1600 | -1.9977  0.8013  0.0023  0.0013
  800 | -1.9950  0.8023  0.0050  0.0023
  400 | -1.9910  0.8054  0.0090  0.0054
  200 | -1.9851  0.8059  0.0149  0.0059
  100 | -1.9722  0.8096  0.0278  0.0096
   50 | -1.9541  0.8056  0.0459  0.0056
 */

/**
 * 从 (μ, σ) 计算直方图各 bin 的期望计数
 */
export function computeExpectedCounts(
    mu: number,
    sigma: number,
    extent: [number, number],
    noBins: number,
    n: number
): number[] {
    const binWidth = (extent[1] - extent[0]) / noBins;
    const expectedCounts: number[] = [];
    for (let i = 0; i < noBins; i++) {
        const a = extent[0] + i * binWidth;
        const b = extent[0] + (i + 1) * binWidth;
        const p = logNormalCdf(b, mu, sigma) - logNormalCdf(a, mu, sigma);
        expectedCounts.push(n * p);
    }
    return expectedCounts;
}
