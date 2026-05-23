import { tr } from '../../shared/lang/i18n-lite';

/** 归一后的展示类别（内部用，与 API 字符串无强耦合） */
export type GenerationEndDisplayKind = 'eos' | 'length_limit' | 'stopped' | 'error';

export function generationEndReasonLabel(kind: GenerationEndDisplayKind): string {
    switch (kind) {
        case 'eos':
            return tr('EOS reached');
        case 'length_limit':
            return tr('Maximum length reached');
        case 'stopped':
            return tr('Stopped');
        case 'error':
            return tr('Error');
        default: {
            const _exhaustive: never = kind;
            return _exhaustive;
        }
    }
}

/**
 * 产生方统一采用 OpenAI completions `finish_reason` _subset_ + `error`：
 * Chat 服务端返回值、Causal Flow 循环结束、缓存 `completionReason` 均使用同一套字符串。
 */
export const COMPLETION_FINISH_REASONS = ['stop', 'length', 'abort', 'error'] as const;

export type CompletionFinishReason = (typeof COMPLETION_FINISH_REASONS)[number];

/** 旧版 Causal Flow 曾写入的别名（仅读写兼容，新写入均为 {@link COMPLETION_FINISH_REASONS}） */
const LEGACY_FINISH_TO_CANONICAL: Record<string, CompletionFinishReason> = {
    eos: 'stop',
    max_tokens: 'length',
    aborted: 'abort',
};

const FINISH_REASON_TO_DISPLAY: Record<CompletionFinishReason, GenerationEndDisplayKind> = {
    stop: 'eos',
    length: 'length_limit',
    abort: 'stopped',
    error: 'error',
};

export function isCompletionFinishReason(s: string): s is CompletionFinishReason {
    return (COMPLETION_FINISH_REASONS as readonly string[]).includes(s);
}

/** demo JSON / IndexedDB 里可能出现的 completionReason 值（含旧别名） */
export function isKnownPersistedCompletionReason(s: string): boolean {
    return isCompletionFinishReason(s) || s in LEGACY_FINISH_TO_CANONICAL;
}

/** 将旧别名转为规范词；已是规范词或非别名则原样返回（如 OpenAI `content_filter`）。 */
export function canonicalizeCompletionFinishReason(raw: string): string {
    const r = raw.trim();
    if (!r) return r;
    if (isCompletionFinishReason(r)) return r;
    return LEGACY_FINISH_TO_CANONICAL[r] ?? r;
}

/**
 * Completions `finish_reason` 与 Causal Flow 结束原因 → 展示文案。
 * 未识别的非空值原样返回（不翻译）。
 */
export function completionFinishReasonLabel(finishReason: string | null | undefined): string {
    const r = (finishReason ?? '').trim();
    if (!r) return '';
    const c = canonicalizeCompletionFinishReason(r);
    if (isCompletionFinishReason(c)) {
        return generationEndReasonLabel(FINISH_REASON_TO_DISPLAY[c]);
    }
    return r;
}
