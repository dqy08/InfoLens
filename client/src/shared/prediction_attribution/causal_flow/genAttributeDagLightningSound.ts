import lightningStrikeCrackUrl from '../../../assets/audio/lightning-strike-crack.mp3';
import thunderRumbleBgUrl from '../../../assets/audio/thunder-rumble-bg.mp3';

/** 回击与背景雷声共用播放音量 [0, 1]。 */
const DAG_LIGHTNING_SOUND_VOLUME = 0.35;
/** 雷击相对闪电画面的延迟（ms）：模拟声波传播；此期间背景闷雷继续，再切换为回击音。 */
const DAG_LIGHTNING_STRIKE_DELAY_MS = 1000;
/** 背景雷声淡入/淡出时长（s）；避免增益阶跃与 AudioContext suspend 引起咔哒声。 */
const RUMBLE_FADE_S = 0.07;

export type DagLightningSoundController = {
    /** 闷雷继续播放，延迟后再停闷雷并回击；用于传播末帧闪电切换。 */
    scheduleStrikeAfterRumbleDelay(): void;
    /** 延迟回击（不播闷雷）；用于勾选闪电效果预览。 */
    scheduleStrikeDelay(): void;
    /** 取消已调度、尚未执行的回击切换。 */
    cancelPendingStrike(): void;
    startRumbleLoop(): void;
    pauseRumble(): void;
    /** 停止并重置背景雷声；不回击音。 */
    stopRumble(): void;
    dispose(): void;
};

export function createDagLightningSoundController(): DagLightningSoundController {
    let strike: HTMLAudioElement | null = null;

    let rumbleContext: AudioContext | null = null;
    let rumbleBuffer: AudioBuffer | null = null;
    let rumbleDecodePromise: Promise<AudioBuffer> | null = null;
    let rumbleSource: AudioBufferSourceNode | null = null;
    let rumbleGain: GainNode | null = null;
    let rumblePlaying = false;
    /** gain 已淡出到 0，但 BufferSource 仍在循环（用于暂停/闪电切换后快速淡入）。 */
    let rumbleMuted = false;
    let rumbleStopTimer: ReturnType<typeof setTimeout> | null = null;
    let strikeDelayTimer: ReturnType<typeof setTimeout> | null = null;

    function cancelPendingStrike(): void {
        if (strikeDelayTimer != null) {
            clearTimeout(strikeDelayTimer);
            strikeDelayTimer = null;
        }
    }

    function playStrikeNow(): void {
        try {
            const a = ensureStrike();
            a.currentTime = 0;
            void a.play().catch(() => {});
        } catch {
            // 静默失败：自动播放策略或环境不支持时不影响动画
        }
    }

    function ensureStrike(): HTMLAudioElement {
        if (strike == null) {
            strike = new Audio(lightningStrikeCrackUrl);
            strike.preload = 'auto';
            strike.volume = DAG_LIGHTNING_SOUND_VOLUME;
        }
        return strike;
    }

    function ensureRumbleContext(): AudioContext {
        if (rumbleContext == null) {
            const Ctx = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (Ctx == null) throw new Error('AudioContext unavailable');
            rumbleContext = new Ctx();
        }
        return rumbleContext;
    }

    function ensureRumbleBuffer(ctx: AudioContext): Promise<AudioBuffer> {
        if (rumbleBuffer != null) return Promise.resolve(rumbleBuffer);
        if (rumbleDecodePromise == null) {
            rumbleDecodePromise = fetch(thunderRumbleBgUrl)
                .then((res) => res.arrayBuffer())
                .then((arr) => ctx.decodeAudioData(arr))
                .then((buf) => {
                    rumbleBuffer = buf;
                    return buf;
                });
        }
        return rumbleDecodePromise;
    }

    function clearRumbleStopTimer(): void {
        if (rumbleStopTimer != null) {
            clearTimeout(rumbleStopTimer);
            rumbleStopTimer = null;
        }
    }

    function tearDownRumbleSourceNow(): void {
        clearRumbleStopTimer();
        if (rumbleSource != null) {
            try {
                rumbleSource.stop();
            } catch {
                // already stopped
            }
            rumbleSource.disconnect();
            rumbleSource = null;
        }
        rumbleGain?.disconnect();
        rumbleGain = null;
        rumbleMuted = false;
    }

    function scheduleRumbleGain(target: number): void {
        if (rumbleGain == null || rumbleContext == null) return;
        const t = rumbleContext.currentTime;
        const g = rumbleGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(target, t + RUMBLE_FADE_S);
    }

    function fadeOutAndStopRumble(): void {
        if (rumbleSource == null) {
            rumblePlaying = false;
            rumbleMuted = false;
            return;
        }
        scheduleRumbleGain(0);
        rumblePlaying = false;
        rumbleMuted = true;
        clearRumbleStopTimer();
        rumbleStopTimer = setTimeout(() => {
            rumbleStopTimer = null;
            if (rumbleMuted) tearDownRumbleSourceNow();
        }, Math.ceil(RUMBLE_FADE_S * 1000) + 20);
    }

    async function startRumbleLoopAsync(): Promise<void> {
        try {
            const ctx = ensureRumbleContext();
            if (ctx.state === 'suspended') await ctx.resume();

            if (rumbleSource != null && rumbleMuted) {
                clearRumbleStopTimer();
                scheduleRumbleGain(DAG_LIGHTNING_SOUND_VOLUME);
                rumblePlaying = true;
                rumbleMuted = false;
                return;
            }
            if (rumblePlaying && rumbleSource != null) return;

            const buffer = await ensureRumbleBuffer(ctx);
            tearDownRumbleSourceNow();
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            const gain = ctx.createGain();
            const t = ctx.currentTime;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(DAG_LIGHTNING_SOUND_VOLUME, t + RUMBLE_FADE_S);
            source.connect(gain);
            gain.connect(ctx.destination);
            source.start(0);
            rumbleSource = source;
            rumbleGain = gain;
            rumblePlaying = true;
            rumbleMuted = false;
        } catch {
            rumblePlaying = false;
        }
    }

    function scheduleStrikeDelay(): void {
        cancelPendingStrike();
        strikeDelayTimer = setTimeout(() => {
            strikeDelayTimer = null;
            playStrikeNow();
        }, DAG_LIGHTNING_STRIKE_DELAY_MS);
    }

    function scheduleStrikeAfterRumbleDelay(): void {
        cancelPendingStrike();
        strikeDelayTimer = setTimeout(() => {
            strikeDelayTimer = null;
            pauseRumble();
            playStrikeNow();
        }, DAG_LIGHTNING_STRIKE_DELAY_MS);
    }

    function startRumbleLoop(): void {
        void startRumbleLoopAsync();
    }

    function pauseRumble(): void {
        if (rumbleSource == null || rumblePlaying === false) return;
        clearRumbleStopTimer();
        scheduleRumbleGain(0);
        rumblePlaying = false;
        rumbleMuted = true;
    }

    function stopRumble(): void {
        fadeOutAndStopRumble();
    }

    function dispose(): void {
        cancelPendingStrike();
        tearDownRumbleSourceNow();
        rumblePlaying = false;
        void rumbleContext?.close();
        rumbleContext = null;
        rumbleBuffer = null;
        rumbleDecodePromise = null;
        if (strike != null) {
            strike.pause();
            strike.currentTime = 0;
        }
        strike = null;
    }

    return { scheduleStrikeAfterRumbleDelay, scheduleStrikeDelay, cancelPendingStrike, startRumbleLoop, pauseRumble, stopRumble, dispose };
}
