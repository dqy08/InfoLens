/**
 * runAttentionPlayback RAF 状态机
 * 运行: cd client/src && npx tsx tests/prediction_attribution/runAttentionPlayback.test.ts
 */
import { runAttentionPlayback } from '../../shared/prediction_attribution/causal_flow/runAttentionPlayback';

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean): void {
    if (cond) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.log(`  ✗ ${label}`);
    }
}

function assertEq<T>(label: string, actual: T, expected: T): void {
    assert(label, actual === expected);
}

type RafFrame = { cb: FrameRequestCallback; id: number };
let rafQueue: RafFrame[] = [];
let nextRafId = 1;
let mockNow = 0;
const FRAME_MS = 16;

const originalRaf = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;

function installMockRaf(): void {
    rafQueue = [];
    mockNow = 0;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        const id = nextRafId++;
        rafQueue.push({ cb, id });
        return id;
    };
    globalThis.cancelAnimationFrame = (id: number): void => {
        rafQueue = rafQueue.filter((f) => f.id !== id);
    };
}

function restoreMockRaf(): void {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
}

/** 推进 mock 时间并执行当前排队的 rAF（每帧 FRAME_MS）。 */
function flushRafFrames(maxFrames: number): void {
    for (let i = 0; i < maxFrames && rafQueue.length > 0; i++) {
        mockNow += FRAME_MS;
        const frame = rafQueue.shift()!;
        frame.cb(mockNow);
    }
}

console.log('0. dwell0：首帧空 litIds，dwell 后才开始扫');
{
    installMockRaf();
    try {
        const highlights: Array<{ lit: string; query: string | null }> = [];
        runAttentionPlayback({
            plan: { kind: 'decode', round: { queryTokenId: 'q', scanIds: ['a', 'q'] } },
            config: { attendMs: 10, ffnRatio: 2, attendBurst: 1 },
            setHighlight: (s) => {
                if (s) highlights.push({ lit: s.litIds.join(','), query: s.queryTokenId });
            },
            onDone: () => {},
        });
        assertEq('dwell0 frame first', highlights[0]?.lit, '');
        assertEq('dwell0 no query stroke', highlights[0]?.query, null);
        flushRafFrames(1);
        assertEq('still dwell0 before ffn dwell elapses', highlights.length, 1);
        flushRafFrames(2);
        assertEq('sweep starts after dwell0 (ffnRatio×attendMs)', highlights.some((h) => h.lit === 'a'), true);
    } finally {
        restoreMockRaf();
    }
}

console.log('0b. skipLeadDwell0：无 dwell0 首帧，直接扫');
{
    installMockRaf();
    try {
        const highlights: Array<{ lit: string; query: string | null }> = [];
        runAttentionPlayback({
            plan: { kind: 'decode', round: { queryTokenId: 'q', scanIds: ['a', 'q'] } },
            config: { attendMs: 10, ffnRatio: 2, attendBurst: 1 },
            skipLeadDwell0: true,
            setHighlight: (s) => {
                if (s) highlights.push({ lit: s.litIds.join(','), query: s.queryTokenId });
            },
            onDone: () => {},
        });
        assertEq('first frame already sweeping', highlights[0]?.lit, 'a');
    } finally {
        restoreMockRaf();
    }
}

console.log('1. gen 单 token：onGenAppear 在 onDone 之前，且 onDone 会触发');
{
    installMockRaf();
    try {
        let appeared = false;
        let done = false;
        runAttentionPlayback({
            plan: { kind: 'decode', round: { queryTokenId: 'q', scanIds: ['q'] } },
            config: { attendMs: 10, ffnRatio: 2 },
            setHighlight: () => {},
            onGenAppear: () => {
                appeared = true;
            },
            onDone: () => {
                done = true;
            },
        });
        flushRafFrames(20);
        assert('onGenAppear fired', appeared);
        assert('onDone fired after post-FFN', done);
        assert('no pending rAF after complete', rafQueue.length === 0);
    } finally {
        restoreMockRaf();
    }
}

console.log('2. attendOnly：attend 结束后 onDone，不经 FFN');
{
    installMockRaf();
    try {
        let done = false;
        runAttentionPlayback({
            plan: {
                kind: 'prefill',
                rounds: [{ queryTokenId: 'a', scanIds: ['a', 'b'] }],
            },
            config: { attendMs: 10, ffnRatio: 2 },
            setHighlight: () => {},
            onDone: () => {
                done = true;
            },
        });
        flushRafFrames(20);
        assert('prefill single attendOnly round completes', done);
    } finally {
        restoreMockRaf();
    }
}

console.log('3. random prefill playback');
{
    installMockRaf();
    try {
        const highlights: Array<{ kv?: readonly string[]; lit: string; query: string | null }> = [];
        let done = false;
        let appeared = false;
        runAttentionPlayback({
            plan: {
                kind: 'prefill',
                rounds: [
                    { queryTokenId: 'a', scanIds: ['a', 'b'] },
                    { queryTokenId: 'b', scanIds: ['a', 'b'] },
                    { queryTokenId: 'c', scanIds: ['a', 'b', 'c'] },
                ],
            },
            config: { attendMs: 10, ffnRatio: 2, attendBurst: 1, queryBurst: 1, prefillStyle: 'random' },
            setHighlight: (s) => {
                if (s) highlights.push({ kv: s.kvEstablishedQueryIds, lit: s.litIds.join(','), query: s.queryTokenId });
            },
            onGenAppear: () => {
                appeared = true;
            },
            onDone: () => {
                done = true;
            },
        });
        flushRafFrames(200);
        assert('completes', done);
        assert('two prefill frames', highlights.length >= 2);
        assert(
            'post-random dwell: kv only, no active query',
            highlights.some((h) => h.query === null && (h.kv?.length ?? 0) === 2),
        );
        const ffnBefore = highlights.filter((h) => h.query === 'c' && (h.kv?.length ?? 0) > 0);
        assert('kv kept during round c attend/ffn-before', ffnBefore.length > 0);
        assert('onGenAppear fires after pre-gen ffn', appeared);
    } finally {
        restoreMockRaf();
    }
}

console.log('3b. random prefill query burst batches');
{
    installMockRaf();
    try {
        const highlights: Array<{ kv?: readonly string[]; query: string | null; queries?: readonly string[] }> = [];
        runAttentionPlayback({
            plan: {
                kind: 'prefill',
                rounds: [
                    { queryTokenId: 'a', scanIds: ['a', 'b'] },
                    { queryTokenId: 'b', scanIds: ['a', 'b'] },
                    { queryTokenId: 'c', scanIds: ['a', 'b', 'c'] },
                ],
            },
            config: { attendMs: 10, ffnRatio: 2, attendBurst: 1, queryBurst: 2, prefillStyle: 'random' },
            setHighlight: (s) => {
                if (s) {
                    highlights.push({
                        kv: s.kvEstablishedQueryIds,
                        query: s.queryTokenId,
                        queries: s.queryTokenIds,
                    });
                }
            },
            onDone: () => {},
        });
        flushRafFrames(200);
        const batched = highlights.find(
            (h) =>
                h.query === null &&
                h.queries != null &&
                h.kv != null &&
                h.kv.includes('a') &&
                h.kv.includes('b'),
        );
        assert('one batch frame establishes a,b with null query', batched != null);
        assert(
            'batch exposes active queryTokenIds',
            batched != null &&
                new Set(batched.queries).size === 2 &&
                batched.queries.includes('a') &&
                batched.queries.includes('b'),
        );
    } finally {
        restoreMockRaf();
    }
}

console.log('4. plain prefill accumulates kv outlines');
{
    installMockRaf();
    try {
        const highlights: Array<{ kv?: readonly string[]; query: string | null; phase: string }> = [];
        let appeared = false;
        runAttentionPlayback({
            plan: {
                kind: 'prefill',
                rounds: [
                    { queryTokenId: 'a', scanIds: ['a'] },
                    { queryTokenId: 'b', scanIds: ['a', 'b'] },
                    { queryTokenId: 'c', scanIds: ['a', 'b', 'c'] },
                ],
            },
            config: { attendMs: 10, ffnRatio: 2, attendBurst: 10, prefillStyle: 'plain' },
            setHighlight: (s) => {
                if (s) highlights.push({ kv: s.kvEstablishedQueryIds, query: s.queryTokenId, phase: s.phase });
            },
            onGenAppear: () => {
                appeared = true;
            },
            onDone: () => {},
        });
        flushRafFrames(200);
        const roundB = highlights.find((h) => h.query === 'b' && h.phase === 'attend');
        assert('round b sees kv a', roundB?.kv?.join(',') === 'a');
        const roundCAttend = highlights.filter((h) => h.query === 'c' && h.phase === 'attend');
        assert('round c attend has kv a,b', roundCAttend.some((h) => h.kv?.join(',') === 'a,b'));
        const preGenFfn = highlights.filter(
            (h) => h.query === 'c' && h.phase === 'ffn' && (h.kv?.length ?? 0) > 0,
        );
        assert('pre-gen ffn dwell keeps kv', preGenFfn.length > 0);
        assert('onGenAppear fires after pre-gen ffn', appeared);
    } finally {
        restoreMockRaf();
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
