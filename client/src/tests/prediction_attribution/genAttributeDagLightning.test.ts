/**
 * 闪电效果时序 / opacity 单元测试
 * 运行: cd client/src && npm run test:dagLightning
 */
import {
    clampLightningSlowMo,
    clampLightningThresholdTau,
    DAG_LIGHTNING_ANIMATION_BASE_MS,
    DAG_LIGHTNING_PHASES_MS,
    DAG_LIGHTNING_SLOW_MO_DEFAULT,
    lightningBoundaryAnimationDwellMs,
    lightningBoundaryFadeProgress,
    lightningBoundaryFrameDwellMs,
    lightningContentRevealProgress,
    lightningDagFlashOverlayOpacity,
    lightningEdgeRenderOpacity,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagEdgeRenderStrength';
import { DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS } from '../../shared/prediction_attribution/causal_flow/genAttributeDagPropagationPlaybackPacing';

function assertEq(label: string, actual: unknown, expected: unknown): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`  ✓ ${label}`);
}

function assertClose(label: string, actual: number, expected: number, eps = 1e-9): void {
    if (Math.abs(actual - expected) > eps) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`  ✓ ${label}`);
}

const B = DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS;

console.log('1. DAG_LIGHTNING_PHASES_MS');
assertEq(
    'phase 之和 = ANIMATION_BASE',
    DAG_LIGHTNING_PHASES_MS.reduce((a, c) => a + c, 0),
    DAG_LIGHTNING_ANIMATION_BASE_MS,
);
assertEq('ANIMATION_BASE = 边界基线 ×4', DAG_LIGHTNING_ANIMATION_BASE_MS, B * 4);

console.log('2. lightningBoundaryFrameDwellMs');
assertEq('无闪电 → 基线', lightningBoundaryFrameDwellMs(B, false), B);
assertEq('有闪电 slowMo=1 → 前奏 + 动画', lightningBoundaryFrameDwellMs(B, true, 1), B + DAG_LIGHTNING_ANIMATION_BASE_MS);
assertEq(
    '有闪电 slowMo=2 → 前奏 + 2×动画',
    lightningBoundaryFrameDwellMs(B, true, 2),
    B + DAG_LIGHTNING_ANIMATION_BASE_MS * 2,
);

console.log('3. lightningBoundaryAnimationDwellMs');
assertEq('无闪电', lightningBoundaryAnimationDwellMs(B, false), B);
assertEq('slowMo=3', lightningBoundaryAnimationDwellMs(B, true, 3), DAG_LIGHTNING_ANIMATION_BASE_MS * 3);

console.log('4. clampLightningSlowMo / clampLightningThresholdTau');
assertEq('slowMo 默认', clampLightningSlowMo(NaN), DAG_LIGHTNING_SLOW_MO_DEFAULT);
assertEq('slowMo 上限', clampLightningSlowMo(99), 10);
assertEq('tau 默认', clampLightningThresholdTau(NaN), 0.35);
assertEq('tau 下限', clampLightningThresholdTau(0), 0.05);

console.log('5. lightningEdgeRenderOpacity');
assertEq('strength≤0', lightningEdgeRenderOpacity(0, 0.35), 0);
assertClose('s=0.35 τ=0.35 → 1', lightningEdgeRenderOpacity(0.35, 0.35), 1);
assertClose('s=0.175 τ=0.35 → 0.5', lightningEdgeRenderOpacity(0.175, 0.35), 0.5);
assertClose('超 1 封顶', lightningEdgeRenderOpacity(1, 0.35), 1);

console.log('6. lightningBoundaryFadeProgress (slowMo=1)');
assertClose('t=0 峰值', lightningBoundaryFadeProgress(0, 1), 0);
assertClose('t=400 仍峰值', lightningBoundaryFadeProgress(400, 1), 0);
assertClose('t=500 衰减中段', lightningBoundaryFadeProgress(500, 1), 0.25);
assertClose('t=700 第二峰', lightningBoundaryFadeProgress(700, 1), 0);
assertClose('t=2000 稳态', lightningBoundaryFadeProgress(2000, 1), 1);

console.log('7. lightningBoundaryFadeProgress (slowMo=2)');
assertClose('墙钟 800ms → 相位 400ms 仍峰值', lightningBoundaryFadeProgress(800, 2), 0);

console.log('8. lightningContentRevealProgress');
assertClose('末段前为 0', lightningContentRevealProgress(799, 1), 0);
assertClose('末段中为 0.5', lightningContentRevealProgress(1400, 1), 0.5);
assertClose('末段末为 1', lightningContentRevealProgress(2000, 1), 1);

console.log('9. lightningDagFlashOverlayOpacity');
assertClose('hold 内为 1', lightningDagFlashOverlayOpacity(50, 1), 1);
assertClose('fade 中为 0.5', lightningDagFlashOverlayOpacity(150, 1), 0.5);
assertClose('结束后为 0', lightningDagFlashOverlayOpacity(250, 1), 0);

console.log('\nall passed');
