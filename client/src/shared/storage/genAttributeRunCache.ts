import type { ToolConfig } from '../../features/chat/toolConfig';
import type { DagLayoutMode } from '../prediction_attribution/causal_flow/genAttributeDagView';
import type { TokenGenStep } from '../prediction_attribution/causal_flow/tokenGenAttributionRunner';
import type { PromptTokenSpan } from '../prediction_attribution/causal_flow/genAttributeDagPreprocess';
import {
    canonicalizeCompletionFinishReason,
    isCompletionFinishReason,
    isKnownPersistedCompletionReason,
    type CompletionFinishReason,
} from '../cross/generationEndReasonLabel';
import {
    buildContentKeyFromBusinessKey,
    getByContentKey,
    listMru,
    type CachedHistoryListRow,
    removeByContentKey,
    touchByContentKey,
    upsertEntry,
} from './cachedHistoryStore';

const NAMESPACE = 'gen_attr';
const MAX_ENTRIES = 50;

/** 生成时左侧输入面板的状态快照，随缓存一起存储，加载缓存时据此还原输入模式与内容。 */
export type GenAttrRunDraft = {
    mode: 'raw' | 'chat';
    /** 生成所用的 model 槽位 */
    model?: string;
    /** 生成时的 maxTokens 上限 */
    maxTokens?: number;
    /** chat 模式：system prompt 原文 */
    system?: string;
    /** chat 模式：user prompt 原文 */
    user?: string;
    /** chat 模式：是否启用 system prompt */
    useSystem?: boolean;
    /** chat 模式：是否启用 Qwen3 thinking chat template */
    enableThinking?: boolean;
    /** chat 模式：是否向 chat template 注入 tool config schema */
    toolCallingEnabled?: boolean;
    /** chat 模式：多轮 mock tool calling */
    multiTurnEnabled?: boolean;
    /** chat 模式：tool config（与 Chat 页 draft 同源结构） */
    toolConfig?: ToolConfig;
    /** Teacher forcing 续写原文；非空则表示已启用 teacher forcing。旧缓存无此字段时从根级 teacherForcingContinuation 降级读取。 */
    teacherForcing?: string;
    /** teacher forcing 结束后是否停止（而非继续 top-1 生成）。 */
    stopAfterTeacherForcing?: boolean;
};

/**
 * Payload 中与 **正文 / demo UI 选项** 中的 UI 无关的内容（一次 run 的 JSON 主体）：
 * - **Key 语义**（去重哈希）单独由 {@link GenAttrCacheKey} 表示并排他参与 `contentKey`；
 * - UI 控件快照见可选字段 {@link GenAttrCachedRun.demoUiOptions}（仅导出 demo）。
 */
export type GenAttrCachedRunContentFields = {
    initialContext: string;
    steps: TokenGenStep[];
    /** 完整 prompt token spans（offset + raw），与 /api/tokenize 同源；旧缓存无此字段时由调用方从 step 0 归因降级。 */
    promptSpans?: PromptTokenSpan[];
    /** 与 OpenAI `finish_reason` 子集一致，见 {@link CompletionFinishReason} */
    completionReason?: CompletionFinishReason;
    /** 生成时输入面板快照；旧缓存无此字段时回退到 raw 模式展示 initialContext。 */
    draft?: GenAttrRunDraft;
};

/**
 * Gen Attribute 页 **演示用 UI** 快照（DAG 几何与勾选、回放节奏、归因排除正则等；与正文 key 无关）。
 * **Export demo** 写入完整对象；加载时可为 {@link Partial}，缺失键在 demo 加载路径以默认值补齐。
 */
export type GenAttrDemoUiOptions = {
    layoutMode: DagLayoutMode;
    measureWidthPx: number;
    dagCompactness: number;
    linearArcAdjacentGapPx: number;
    hideExcludedTokens: boolean;
    /** Causal Flow：按 Attribution share (Total) 将低份额节点降至 0.1。 */
    dimInactiveTokens: boolean;
    dimInactiveTokensThreshold: number;
    /** Dim inactive 开启时：传播动画播放/暂停期间不 dim，结束或停止后恢复。 */
    dimInactiveNotDuringAnimation: boolean;
    edgeTopPCoverage: number;
    nodeCiVisualScaleEnabled: boolean;
    decayAttributionToHighSurprisalTargetEnabled: boolean;
    hideInactiveEdges: boolean;
    showDownstreamInfluence: boolean;
    /** 因果流模式（UI: Causal Flow Mode ↯；与 `recursiveAttribution*` 同义）。 */
    recursiveAttributionEnabled: boolean;
    /** 传播链播放方向（▶ 在传播模式下、有用户焦点时）。 */
    recursiveEdgeBatchAnimationDirection: 'backward' | 'forward';
    /** 是否显示 token tooltip（UI: Show token tooltip；`showTokenInfoOnSelected`）。 */
    showTokenInfoOnSelected: boolean;
    replayPacingMode: 'total' | 'step';
    /** 步进重放（▶）每步是否自动 fit 视口。 */
    replayAutoZoom: boolean;
    playbackTotalS: number;
    playbackStepMs: number;
    /** 删除 prompt token（物理移除，不占布局）：使能与正则文本（`info_radar_gen_attr_delete_prompt_*`）。 */
    deletePromptPatternsEnabled: boolean;
    deletePromptPatternsText: string;
    /** 排除 prompt token 归因：使能与正则文本（仅 Gen Attribute，`info_radar_gen_attr_exclude_prompt_*`）。 */
    excludePromptPatternsEnabled: boolean;
    excludePromptPatternsText: string;
    /** 排除生成 token 归因：使能与正则文本（`info_radar_gen_attr_exclude_generated_*`）。 */
    excludeGeneratedPatternsEnabled: boolean;
    excludeGeneratedPatternsText: string;
    /** DAG 选中节点（offset id：`"${start}_${end}"`）；无选中时为 `null`。 */
    selectedNodeId?: string | null;
};

/** 单条记录 JSON：内容字段 + 可选 `demoUiOptions`（仅导出 demo 写入）。 */
export type GenAttrCachedRun = GenAttrCachedRunContentFields & {
    demoUiOptions?: Partial<GenAttrDemoUiOptions>;
};

/**
 * 缓存业务 **key 字段**：涵盖所有影响 `steps` 内容的生成参数（决定 `contentKey`）。
 * 原则：draft 中存储的可变参数均纳入 key，同参数不同结果不应互相覆盖。
 */
export type GenAttrCacheKey = {
    initialContext: string;
    model: string;
    maxTokens: number;
    /** teacher forcing 续写文本，无则省略 */
    teacherForcing?: string;
    /** teacher forcing 用尽后是否停止，仅在 teacherForcing 非空时有意义 */
    stopAfterTeacherForcing?: boolean;
    /** 多轮 mock tool calling 开启时的 tool config fingerprint（含 mock_results） */
    toolConfigFingerprint?: string;
};

/** 规范化 key，去除对结果无影响的冗余字段，保证相同语义的 key 生成相同 hash。 */
function normalizeKey(key: GenAttrCacheKey): object {
    const tf = key.teacherForcing && key.teacherForcing.length > 0 ? key.teacherForcing : undefined;
    return {
        initialContext: key.initialContext,
        model: key.model,
        maxTokens: key.maxTokens,
        ...(tf !== undefined ? { teacherForcing: tf, stopAfterTeacherForcing: key.stopAfterTeacherForcing ?? false } : {}),
        ...(key.toolConfigFingerprint !== undefined
            ? { toolConfigFingerprint: key.toolConfigFingerprint }
            : {}),
    };
}

function keyHash(key: GenAttrCacheKey): string {
    return buildContentKeyFromBusinessKey(normalizeKey(key));
}

/** 构造「内容字段」：供 IndexedDB `save` 与导出 demo 的共有主体（不含 demo UI）。 */
export function buildGenAttrCachedRunContentPayload(params: {
    initialContext: string;
    steps: TokenGenStep[];
    promptSpans: PromptTokenSpan[];
    completionReason?: CompletionFinishReason;
    draft?: GenAttrRunDraft;
}): GenAttrCachedRunContentFields {
    const { initialContext, steps, promptSpans, completionReason, draft } = params;
    let reasonToStore: CompletionFinishReason | undefined;
    if (completionReason !== undefined) {
        const c = canonicalizeCompletionFinishReason(completionReason);
        if (!isCompletionFinishReason(c)) {
            throw new Error(`gen_attr cache: invalid completionReason: ${completionReason}`);
        }
        reasonToStore = c;
    }
    return {
        initialContext,
        steps,
        ...(promptSpans.length > 0 ? { promptSpans } : {}),
        ...(reasonToStore !== undefined ? { completionReason: reasonToStore } : {}),
        ...(draft !== undefined ? { draft } : {}),
    };
}

/**
 * 仅 **Export demo** 使用：在内容字段上附加 **demoUiOptions** 全量（history 不得调用）。
 */
export function buildGenAttrExportedDemoPayload(
    params: {
        initialContext: string;
        steps: TokenGenStep[];
        promptSpans: PromptTokenSpan[];
        completionReason?: CompletionFinishReason;
        draft?: GenAttrRunDraft;
        demoUiOptions: GenAttrDemoUiOptions;
    }
): GenAttrCachedRun {
    const { demoUiOptions, ...contentParams } = params;
    return { ...buildGenAttrCachedRunContentPayload(contentParams), demoUiOptions };
}

function isValidPromptSpansPayload(v: unknown): boolean {
    if (!Array.isArray(v)) return false;
    for (const item of v) {
        if (item == null || typeof item !== 'object') return false;
        const o = item as Record<string, unknown>;
        const off = o.offset;
        if (!Array.isArray(off) || off.length !== 2) return false;
        if (typeof off[0] !== 'number' || !Number.isFinite(off[0])) return false;
        if (typeof off[1] !== 'number' || !Number.isFinite(off[1])) return false;
        if (typeof o.raw !== 'string') return false;
        if (o.token_id !== undefined && (typeof o.token_id !== 'number' || !Number.isFinite(o.token_id))) {
            return false;
        }
    }
    return true;
}

function isValidGenAttrRunDraftPayload(v: unknown): boolean {
    if (v == null || typeof v !== 'object') return false;
    const d = v as Record<string, unknown>;
    if (d.mode !== 'raw' && d.mode !== 'chat') return false;
    if (d.model !== undefined && typeof d.model !== 'string') return false;
    if (d.maxTokens !== undefined && (typeof d.maxTokens !== 'number' || !Number.isFinite(d.maxTokens))) {
        return false;
    }
    if (d.system !== undefined && typeof d.system !== 'string') return false;
    if (d.user !== undefined && typeof d.user !== 'string') return false;
    if (d.useSystem !== undefined && typeof d.useSystem !== 'boolean') return false;
    if (d.teacherForcing !== undefined && typeof d.teacherForcing !== 'string') return false;
    if (d.stopAfterTeacherForcing !== undefined && typeof d.stopAfterTeacherForcing !== 'boolean') {
        return false;
    }
    if (d.multiTurnEnabled !== undefined && typeof d.multiTurnEnabled !== 'boolean') {
        return false;
    }
    return true;
}

function migrateStepInputRanges(step: TokenGenStep): TokenGenStep {
    if (Array.isArray(step.inputRanges) && step.inputRanges.length > 0) {
        return step;
    }
    const pe = step.promptRegionEnd;
    return { ...step, inputRanges: [[0, pe]] };
}

function migrateGenAttrCachedRun(rec: GenAttrCachedRun): GenAttrCachedRun {
    let changed = false;
    const steps = rec.steps.map((step) => {
        const migrated = migrateStepInputRanges(step);
        if (migrated !== step) changed = true;
        return migrated;
    });
    return changed ? { ...rec, steps } : rec;
}

function isDagLayoutModePayload(v: unknown): v is DagLayoutMode {
    return (
        v === 'text-flow' ||
        v === 'linear-arc' ||
        v === 'linear-arc-step-down' ||
        v === 'spiral'
    );
}

function isValidDemoUiOptionsPayload(v: unknown): v is Partial<GenAttrDemoUiOptions> {
    if (v == null || typeof v !== 'object') return false;
    const d = v as Record<string, unknown>;
    if (d.layoutMode !== undefined && !isDagLayoutModePayload(d.layoutMode)) return false;
    if (d.measureWidthPx !== undefined && (typeof d.measureWidthPx !== 'number' || !Number.isFinite(d.measureWidthPx))) {
        return false;
    }
    if (d.dagCompactness !== undefined && (typeof d.dagCompactness !== 'number' || !Number.isFinite(d.dagCompactness))) {
        return false;
    }
    if (
        d.linearArcAdjacentGapPx !== undefined &&
        (typeof d.linearArcAdjacentGapPx !== 'number' || !Number.isFinite(d.linearArcAdjacentGapPx))
    ) {
        return false;
    }
    if (d.hideExcludedTokens !== undefined && typeof d.hideExcludedTokens !== 'boolean') return false;
    if (d.dimInactiveTokens !== undefined && typeof d.dimInactiveTokens !== 'boolean') return false;
    if (
        d.dimInactiveTokensThreshold !== undefined &&
        (typeof d.dimInactiveTokensThreshold !== 'number' ||
            !Number.isFinite(d.dimInactiveTokensThreshold))
    ) {
        return false;
    }
    if (
        d.dimInactiveNotDuringAnimation !== undefined &&
        typeof d.dimInactiveNotDuringAnimation !== 'boolean'
    ) {
        return false;
    }
    if (
        d.edgeTopPCoverage !== undefined &&
        (typeof d.edgeTopPCoverage !== 'number' || !Number.isFinite(d.edgeTopPCoverage))
    ) {
        return false;
    }
    if (d.nodeCiVisualScaleEnabled !== undefined && typeof d.nodeCiVisualScaleEnabled !== 'boolean') {
        return false;
    }
    if (
        d.decayAttributionToHighSurprisalTargetEnabled !== undefined &&
        typeof d.decayAttributionToHighSurprisalTargetEnabled !== 'boolean'
    ) {
        return false;
    }
    const legacyDecay = (d as { edgeWeakenHighSurprisalEnabled?: unknown }).edgeWeakenHighSurprisalEnabled;
    if (legacyDecay !== undefined && typeof legacyDecay !== 'boolean') {
        return false;
    }
    if (d.hideInactiveEdges !== undefined && typeof d.hideInactiveEdges !== 'boolean') return false;
    if (
        d.showDownstreamInfluence !== undefined &&
        typeof d.showDownstreamInfluence !== 'boolean'
    ) {
        return false;
    }
    if (
        d.recursiveAttributionEnabled !== undefined &&
        typeof d.recursiveAttributionEnabled !== 'boolean'
    ) {
        return false;
    }
    if (
        d.recursiveEdgeBatchAnimationDirection !== undefined &&
        d.recursiveEdgeBatchAnimationDirection !== 'backward' &&
        d.recursiveEdgeBatchAnimationDirection !== 'forward'
    ) {
        return false;
    }
    if (
        d.showTokenInfoOnSelected !== undefined &&
        typeof d.showTokenInfoOnSelected !== 'boolean'
    ) {
        return false;
    }
    if (d.replayPacingMode !== undefined && d.replayPacingMode !== 'total' && d.replayPacingMode !== 'step') {
        return false;
    }
    if (d.replayAutoZoom !== undefined && typeof d.replayAutoZoom !== 'boolean') {
        return false;
    }
    if (d.playbackTotalS !== undefined && (typeof d.playbackTotalS !== 'number' || !Number.isFinite(d.playbackTotalS))) {
        return false;
    }
    if (d.playbackStepMs !== undefined && (typeof d.playbackStepMs !== 'number' || !Number.isFinite(d.playbackStepMs))) {
        return false;
    }
    if (
        d.deletePromptPatternsEnabled !== undefined &&
        typeof d.deletePromptPatternsEnabled !== 'boolean'
    ) {
        return false;
    }
    if (d.deletePromptPatternsText !== undefined && typeof d.deletePromptPatternsText !== 'string') {
        return false;
    }
    if (
        d.excludePromptPatternsEnabled !== undefined &&
        typeof d.excludePromptPatternsEnabled !== 'boolean'
    ) {
        return false;
    }
    if (d.excludePromptPatternsText !== undefined && typeof d.excludePromptPatternsText !== 'string') {
        return false;
    }
    if (
        d.excludeGeneratedPatternsEnabled !== undefined &&
        typeof d.excludeGeneratedPatternsEnabled !== 'boolean'
    ) {
        return false;
    }
    if (
        d.excludeGeneratedPatternsText !== undefined &&
        typeof d.excludeGeneratedPatternsText !== 'string'
    ) {
        return false;
    }
    if (
        d.selectedNodeId !== undefined &&
        d.selectedNodeId !== null &&
        typeof d.selectedNodeId !== 'string'
    ) {
        return false;
    }
    return true;
}

/**
 * 打包 demo JSON 与 Cached history 负载对齐：`steps` 仅要求非空数组（细粒度由运行时承担）。
 */
export function isValidGenAttrCachedRunPayload(v: unknown): v is GenAttrCachedRun {
    if (v == null || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    if (typeof o.initialContext !== 'string' || !Array.isArray(o.steps) || o.steps.length === 0) {
        return false;
    }
    if (o.completionReason !== undefined) {
        if (typeof o.completionReason !== 'string' || !isKnownPersistedCompletionReason(o.completionReason)) {
            return false;
        }
    }
    if (o.promptSpans !== undefined && !isValidPromptSpansPayload(o.promptSpans)) {
        return false;
    }
    if (o.draft !== undefined && !isValidGenAttrRunDraftPayload(o.draft)) {
        return false;
    }
    if (o.demoUiOptions !== undefined && !isValidDemoUiOptionsPayload(o.demoUiOptions)) {
        return false;
    }
    return true;
}

/**
 * 加载 demo 与加载 IndexedDB 历史共用的入口：`unknown` → 合法则返回记录，否则打日志并返回 `undefined`。
 */
export function parseGenAttrCachedRunPayload(
    raw: unknown,
    contextForLog?: string
): GenAttrCachedRun | undefined {
    if (!isValidGenAttrCachedRunPayload(raw)) {
        const suffix =
            contextForLog !== undefined && contextForLog.length > 0 ? ` (${contextForLog})` : '';
        console.warn(`[genAttributeRunCache] invalid GenAttrCachedRun payload${suffix}`);
        return undefined;
    }
    return migrateGenAttrCachedRun(raw);
}

export async function save(
    key: GenAttrCacheKey,
    steps: TokenGenStep[],
    promptSpans: PromptTokenSpan[],
    status: 'partial' | 'complete' = steps.length > 0 ? 'partial' : 'complete',
    completionReason?: CompletionFinishReason,
    draft?: GenAttrRunDraft
): Promise<{ contentKey: string }> {
    const { initialContext } = key;
    const payload = buildGenAttrCachedRunContentPayload({
        initialContext,
        steps,
        promptSpans,
        completionReason,
        draft,
    });
    return upsertEntry({
        namespace: NAMESPACE,
        businessKeyJson: JSON.stringify(normalizeKey(key)),
        listLabel: initialContext,
        payload,
        status,
        maxEntries: MAX_ENTRIES,
    });
}

export async function get(key: GenAttrCacheKey): Promise<GenAttrCachedRun | undefined> {
    const row = await getByContentKey<GenAttrCachedRun>(NAMESPACE, keyHash(key));
    if (!row) return undefined;
    return parseGenAttrCachedRunPayload(row.payload, 'get(GenAttrCacheKey)');
}

export async function getCachedEntryByContentKey(raw: string): Promise<GenAttrCachedRun | undefined> {
    if (!raw) return undefined;
    const row = await getByContentKey<GenAttrCachedRun>(NAMESPACE, raw);
    if (!row) return undefined;
    return parseGenAttrCachedRunPayload(row.payload, `contentKey=${raw}`);
}

/** 与 upsert 写入键一致；`?content=` 应使用 save 返回值或 MRU 的 contentKey，勿在 UI 层单独调用 */
export function buildCachedContentUrlParam(key: GenAttrCacheKey): string {
    return keyHash(key);
}

export async function removeCachedEntryByContentKey(contentKey: string): Promise<void> {
    await removeByContentKey(NAMESPACE, contentKey);
}

export async function touchCachedEntryByContentKey(contentKey: string): Promise<void> {
    await touchByContentKey(NAMESPACE, contentKey);
}

export async function listCachedHistoryRows(): Promise<CachedHistoryListRow[]> {
    const rows = await listMru<GenAttrCachedRun>(NAMESPACE);
    return rows.map((r) => ({ contentKey: r.contentKey, listLabel: r.listLabel }));
}
