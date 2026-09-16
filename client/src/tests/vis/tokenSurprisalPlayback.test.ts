/**
 * 信息密度 token 扫描停留时间
 * 运行: cd client/src && npm run test:tokenSurprisalPlayback
 */
import {
    createTokenSurprisalPlaybackController,
    surprisalPlaybackDwellsMs,
    tokenSurprisalBits,
} from '../../shared/vis/tokenSurprisalPlayback';
import type { FrontendToken } from '../../shared/api/GLTR_API';

let passed = 0;
let failed = 0;

function assert(desc: string, cond: boolean) {
    if (cond) {
        console.log(`  ✓ ${desc}`);
        passed++;
    } else {
        console.error(`  ✗ ${desc}`);
        failed++;
    }
}

function assertEq<T>(desc: string, actual: T, expected: T) {
    assert(`${desc} (got ${String(actual)})`, actual === expected);
}

console.log('1. surprisalPlaybackDwellsMs');
assertEq('空', surprisalPlaybackDwellsMs([], 200).length, 0);

{
    const equal = surprisalPlaybackDwellsMs([0, 0, 0], 200);
    assert('全 0 每步 stepMs', equal[0] === 200 && equal[1] === 200 && equal[2] === 200);
}

{
    const dwells = surprisalPlaybackDwellsMs([1, 3], 200);
    assertEq('1 bit → 200ms', dwells[0], 200);
    assertEq('3 bit → 600ms', dwells[1], 600);
}

{
    const dwells = surprisalPlaybackDwellsMs([10, 0, 10], 200);
    assertEq('零权重为 0', dwells[1], 0);
    assertEq('10 bit → 2000ms', dwells[0], 2000);
    assertEq('10 bit 之二', dwells[2], 2000);
}

console.log('2. tokenSurprisalBits');
{
    const placeholder = { raw: 'x', offset: [0, 1], real_topk: [1, 1], pred_topk: [] } as FrontendToken;
    assertEq('语义占位 real_topk 不计 surprisal', tokenSurprisalBits(placeholder), 0);
}
{
    const tok = { raw: 'x', offset: [0, 1], real_topk: [1, 0.25], pred_topk: [['x', 0.25]] } as FrontendToken;
    assert('p=0.25 → 2 bits', Math.abs(tokenSurprisalBits(tok) - 2) < 1e-9);
}

console.log('3. playback skips 0-dwell');
{
    const shown: number[] = [];
    const ctrl = createTokenSurprisalPlaybackController({
        onShowToken: (i) => shown.push(i),
        onClear: () => {},
        onPhaseChange: () => {},
    });
    ctrl.start([0, 50, 0, 50]);
    assertEq('跳过前导 0，落在第一档正停留', shown[0], 1);
    ctrl.stop();
    assertEq('stop 后 idle', ctrl.getPhase(), 'idle');
}

console.log('4. resetPaused stays at start');
{
    const shown: number[] = [];
    const phases: string[] = [];
    const ctrl = createTokenSurprisalPlaybackController({
        onShowToken: (i) => shown.push(i),
        onClear: () => shown.push(-1),
        onPhaseChange: (p) => phases.push(p),
    });
    ctrl.start([20, 20, 20]);
    ctrl.resetPaused([20, 20, 20]);
    assertEq('resetPaused → paused', ctrl.getPhase(), 'paused');
    assertEq('index 回到 0', ctrl.getIndex(), 0);
    assert('phases 以 paused 结束', phases[phases.length - 1] === 'paused');
    ctrl.resume();
    assertEq('resume 从 paused 开播', ctrl.getPhase(), 'playing');
    ctrl.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
