/**
 * Gen Attribute 演示用 UI：localStorage keys、默认值、clamp/format、readStored、persist。
 * DOM 读写与 apply 仍在页面入口；本模块只负责与存储/默认值相关的纯逻辑。
 */

import {
    clampDagEdgeTopPCoverage,
    DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagPreprocess';
import {
    clampDimInactiveTokensThreshold,
    DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagNodeDim';
import {
    clampLightningSlowMo,
    clampLightningThresholdTau,
    DAG_LIGHTNING_SLOW_MO_DEFAULT,
    DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagEdgeRenderStrength';
import {
    type DagLayoutMode,
    type DagRecursiveEdgeAnimationDirection,
    clampDagCompactness,
    DAG_COMPACTNESS_DEFAULT,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagView';
import {
    clampLinearArcAdjacentGap,
    LINEAR_ARC_ADJACENT_GAP_DEFAULT,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagViewLinearArcMode';
import { DAG_LAYOUT_TRANSITION_MS } from '../../shared/prediction_attribution/causal_flow/genAttributeDagLayoutTransition';
import {
    ATTEND_BURST_DEFAULT,
    QUERY_BURST_DEFAULT,
    clampAttendBurst,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagAttentionPlayback';
import type { GenAttrDemoUiOptions } from '../../shared/storage/genAttributeRunCache';
import {
    DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT,
    DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
} from '../../shared/prediction_attribution/core/attributionExcludePromptPatternsStorage';
import {
    lsGet,
    lsReadBool,
    lsReadEnum,
    lsReadNumber,
    lsRemove,
    lsSet,
    lsWriteBool,
    lsWriteString,
} from '../../shared/storage/localStorageHelpers';

export const GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY = 'info_radar_gen_attr_dag_measure_width';
export const GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY = 'info_radar_gen_attr_dag_layout_mode';
export const GEN_ATTR_DAG_LAYOUT_TRANSITION_STORAGE_KEY = 'info_radar_gen_attr_dag_layout_transition';
export const GEN_ATTR_DAG_LAYOUT_TRANSITION_S_STORAGE_KEY = 'info_radar_gen_attr_dag_layout_transition_s';
export const GEN_ATTR_DAG_MATRIX_TRANSPOSE_STORAGE_KEY = 'info_radar_gen_attr_dag_matrix_transpose';
export const GEN_ATTR_DAG_MATRIX_SWITCH_HORIZONTAL_LABEL_STORAGE_KEY =
    'info_radar_gen_attr_dag_matrix_switch_horizontal_label';
export const GEN_ATTR_DAG_MATRIX_SWITCH_VERTICAL_LABEL_STORAGE_KEY =
    'info_radar_gen_attr_dag_matrix_switch_vertical_label';
export const GEN_ATTR_DAG_MATRIX_PIN_SOURCE_STORAGE_KEY = 'info_radar_gen_attr_dag_matrix_pin_source';
export const GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY = 'info_radar_gen_attr_dag_playback_step_ms';
export const GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY = 'info_radar_gen_attr_dag_replay_pacing_mode';
export const GEN_ATTR_DAG_REPLAY_AUTO_ZOOM_STORAGE_KEY = 'info_radar_gen_attr_dag_replay_auto_zoom';
export const GEN_ATTR_DAG_DISABLE_SMART_STEP_TIME_STORAGE_KEY =
    'info_radar_gen_attr_dag_disable_smart_step_time';
export const GEN_ATTR_DAG_LIGHTNING_EFFECT_STORAGE_KEY = 'info_radar_gen_attr_dag_lightning_effect';
export const GEN_ATTR_DAG_LIGHTNING_THRESHOLD_STORAGE_KEY = 'info_radar_gen_attr_dag_lightning_threshold';
export const GEN_ATTR_DAG_LIGHTNING_SLOW_MO_STORAGE_KEY = 'info_radar_gen_attr_dag_lightning_slow_mo';
export const GEN_ATTR_DAG_LIGHTNING_SOUND_STORAGE_KEY = 'info_radar_gen_attr_dag_lightning_sound';
export const GEN_ATTR_DAG_FORWARD_SLIDE_SHARED_NODES_STORAGE_KEY =
    'info_radar_gen_attr_dag_forward_slide_shared_nodes';
export const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY = 'info_radar_gen_attr_dag_playback_total_s';
export const GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY = 'info_radar_gen_attr_dag_node_ci_visual_scale';
export const GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY =
    'info_radar_gen_attr_dag_decay_attribution_high_surprisal';
/** @deprecated 读取迁移用 */
export const GEN_ATTR_DAG_EDGE_WEAKEN_HIGH_SURPRISAL_STORAGE_KEY_LEGACY =
    'info_radar_gen_attr_dag_edge_weaken_high_surprisal';
export const GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY = 'info_radar_gen_attr_dag_hide_inactive_edges';
export const GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY =
    'info_radar_gen_attr_dag_show_downstream_influence';
export const GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY = 'info_radar_gen_attr_dag_recursive_attribution';
export const GEN_ATTR_DAG_RECURSIVE_EDGE_ANIMATION_DIRECTION_STORAGE_KEY =
    'info_radar_gen_attr_dag_recursive_edge_animation_direction';
export const GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY = 'info_radar_gen_attr_dag_hide_excluded_tokens';
export const GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_STORAGE_KEY = 'info_radar_gen_attr_dag_dim_inactive_tokens';
export const GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_THRESHOLD_STORAGE_KEY =
    'info_radar_gen_attr_dag_dim_inactive_tokens_threshold';
export const GEN_ATTR_DAG_DIM_INACTIVE_NOT_IN_ANIMATION_STORAGE_KEY =
    'info_radar_gen_attr_dag_dim_inactive_not_in_animation';
export const GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY = 'info_radar_gen_attr_dag_show_topk_on_selected';
export const GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY =
    'info_radar_gen_attr_dag_linear_arc_adjacent_gap';
export const GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY = 'info_radar_gen_attr_dag_compactness';
export const GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY = 'info_radar_gen_attr_dag_edge_top_p_coverage';
/** 仅此页：与 Attribution 的 `exclude_tokens` 无关。 */
export const GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY = 'info_radar_gen_attr_exclude_prompt_patterns';
export const GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY =
    'info_radar_gen_attr_exclude_prompt_patterns_enabled';
export const GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY = 'info_radar_gen_attr_exclude_generated_patterns';
export const GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY =
    'info_radar_gen_attr_exclude_generated_patterns_enabled';
export const GEN_ATTR_DELETE_PROMPT_PATTERNS_STORAGE_KEY = 'info_radar_gen_attr_delete_prompt_patterns';
export const GEN_ATTR_DELETE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY =
    'info_radar_gen_attr_delete_prompt_patterns_enabled';

/** 步进回放节奏：`total`＝整段剩余回放总时长内均分间隔；`step`＝固定每步间隔（ms）。 */
export type DagReplayPacingMode = 'total' | 'step';

export const GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT = 500;
export const GEN_ATTR_DAG_MEASURE_WIDTH_MIN = 200;
export const GEN_ATTR_DAG_MEASURE_WIDTH_MAX = 4000;

export const GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT = 200;
export const GEN_ATTR_DAG_PLAYBACK_STEP_MS_MIN = 0;
export const GEN_ATTR_DAG_PLAYBACK_STEP_MS_MAX = 10000;

export const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT = 7;
export const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MIN = 1;
export const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MAX = 3600;
/** 手输总量化的步长；原生 step=1 箭头在 `input` 里另取整。 */
export const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STEP = 0.1;

export const GEN_ATTR_DAG_LAYOUT_TRANSITION_S_DEFAULT = DAG_LAYOUT_TRANSITION_MS / 1000;
export const GEN_ATTR_DAG_LAYOUT_TRANSITION_S_MIN = 0.1;
export const GEN_ATTR_DAG_LAYOUT_TRANSITION_S_MAX = 30;
export const GEN_ATTR_DAG_LAYOUT_TRANSITION_S_STEP = 0.1;

export const GEN_ATTR_DAG_SIMULATE_ATTENTION_STORAGE_KEY = 'info_radar_gen_attr_dag_simulate_attention';
export const GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY = 'info_radar_gen_attr_dag_skip_prefill';
export const GEN_ATTR_DAG_PREFILL_STYLE_STORAGE_KEY = 'info_radar_gen_attr_dag_prefill_style';
/** @deprecated 读取兼容；新写入用 {@link GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY} */
export const GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY_LEGACY = 'info_radar_gen_attr_dag_skip_prompt_attention';
export const GEN_ATTR_DAG_ATTEND_MS_STORAGE_KEY = 'info_radar_gen_attr_dag_attend_ms';
export const GEN_ATTR_DAG_FFN_RATIO_STORAGE_KEY = 'info_radar_gen_attr_dag_ffn_ratio';
export const GEN_ATTR_DAG_ATTEND_BURST_STORAGE_KEY = 'info_radar_gen_attr_dag_attend_burst';
export const GEN_ATTR_DAG_QUERY_BURST_STORAGE_KEY = 'info_radar_gen_attr_dag_query_burst';
export const GEN_ATTR_DAG_HIDE_ARROWS_DURING_ATTENTION_STORAGE_KEY =
    'info_radar_gen_attr_dag_hide_arrows_during_attention';
export const GEN_ATTR_DAG_ATTEND_MS_DEFAULT = 33;
export const GEN_ATTR_DAG_ATTEND_MS_MIN = 1;
export const GEN_ATTR_DAG_ATTEND_MS_MAX = 5000;
export const GEN_ATTR_DAG_FFN_RATIO_DEFAULT = 3;
export const GEN_ATTR_DAG_FFN_RATIO_MIN = 0;
export const GEN_ATTR_DAG_FFN_RATIO_MAX = 20;

/** 与无 demoUiOptions 本地缓存时「读出默认」对齐，供重置与可读性单一的来源 */
export const DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS: GenAttrDemoUiOptions = {
    layoutMode: 'text-flow',
    layoutTransitionEnabled: true,
    layoutTransitionDurationS: GEN_ATTR_DAG_LAYOUT_TRANSITION_S_DEFAULT,
    measureWidthPx: GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT,
    dagCompactness: DAG_COMPACTNESS_DEFAULT,
    linearArcAdjacentGapPx: LINEAR_ARC_ADJACENT_GAP_DEFAULT,
    hideExcludedTokens: false,
    dimInactiveTokens: false,
    dimInactiveTokensThreshold: DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
    dimInactiveNotDuringAnimation: false,
    edgeTopPCoverage: DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
    nodeCiVisualScaleEnabled: false,
    decayAttributionToHighSurprisalTargetEnabled: false,
    hideInactiveEdges: false,
    showDownstreamInfluence: false,
    recursiveAttributionEnabled: false,
    recursiveEdgeBatchAnimationDirection: 'forward',
    forwardSlideSharedNodes: false,
    showTokenInfoOnSelected: false,
    replayPacingMode: 'total',
    replayAutoZoom: false,
    disableSmartStepTime: false,
    lightningEffect: false,
    lightningThresholdTau: DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT,
    lightningSlowMo: DAG_LIGHTNING_SLOW_MO_DEFAULT,
    lightningSound: false,
    playbackTotalS: GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT,
    playbackStepMs: GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT,
    simulateAttentionCost: false,
    skipPrefillAttention: false,
    prefillStyle: 'random',
    attendMs: GEN_ATTR_DAG_ATTEND_MS_DEFAULT,
    ffnRatioAttend: GEN_ATTR_DAG_FFN_RATIO_DEFAULT,
    attendBurst: ATTEND_BURST_DEFAULT,
    queryBurst: QUERY_BURST_DEFAULT,
    hideArrowsDuringAttention: false,
    excludePromptPatternsEnabled: true,
    excludePromptPatternsText: DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
    excludeGeneratedPatternsEnabled: true,
    excludeGeneratedPatternsText: DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT,
    deletePromptPatternsEnabled: false,
    deletePromptPatternsText: '',
};
export function clampDagMeasureWidth(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_MEASURE_WIDTH_MIN,
        Math.min(GEN_ATTR_DAG_MEASURE_WIDTH_MAX, Math.round(n))
    );
}
export function readStoredDagMeasureWidth(): number {
    return lsReadNumber(GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY, GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT, {
        clamp: clampDagMeasureWidth,
    });
}
export function readStoredDagCompactness(): number {
    return lsReadNumber(GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY, DAG_COMPACTNESS_DEFAULT, {
        parse: 'float',
        clamp: clampDagCompactness,
    });
}
export function readStoredDagEdgeTopPCoverage(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY,
        DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
        { parse: 'float', clamp: clampDagEdgeTopPCoverage },
    );
}
export function readStoredDagLinearArcAdjacentGap(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY,
        LINEAR_ARC_ADJACENT_GAP_DEFAULT,
        { clamp: clampLinearArcAdjacentGap },
    );
}
export function clampDagPlaybackStepMs(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_PLAYBACK_STEP_MS_MIN,
        Math.min(GEN_ATTR_DAG_PLAYBACK_STEP_MS_MAX, Math.round(n))
    );
}
export function readStoredDagPlaybackStepMs(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY,
        GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT,
        { clamp: clampDagPlaybackStepMs },
    );
}
export function clampDagPlaybackTotalS(n: number): number {
    const stepped =
        Math.round(n / GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STEP) * GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STEP;
    return Math.max(
        GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MIN,
        Math.min(GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MAX, stepped),
    );
}
export function formatDagPlaybackTotalS(n: number): string {
    const s = clampDagPlaybackTotalS(n);
    return Number.isInteger(s) ? String(s) : s.toFixed(1);
}
export function readStoredDagPlaybackTotalS(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY,
        GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT,
        { parse: 'float', clamp: clampDagPlaybackTotalS },
    );
}
export function readStoredDagReplayPacingMode(): DagReplayPacingMode {
    return lsReadEnum(
        GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY,
        ['total', 'step'] as const,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.replayPacingMode,
    );
}
export function readStoredDagReplayAutoZoom(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_REPLAY_AUTO_ZOOM_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.replayAutoZoom,
        { encoding: '1' },
    );
}
export function readStoredDagDisableSmartStepTime(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_DISABLE_SMART_STEP_TIME_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.disableSmartStepTime,
        { encoding: '1' },
    );
}
export function readStoredDagLightningEffect(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_LIGHTNING_EFFECT_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.lightningEffect,
        { encoding: '1' },
    );
}
export function readStoredDagLightningThresholdTau(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_LIGHTNING_THRESHOLD_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.lightningThresholdTau,
        { parse: 'float', clamp: clampLightningThresholdTau },
    );
}
export function readStoredDagLightningSlowMo(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_LIGHTNING_SLOW_MO_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.lightningSlowMo,
        { clamp: clampLightningSlowMo },
    );
}
export function readStoredDagLightningSound(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_LIGHTNING_SOUND_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.lightningSound,
        { encoding: '1' },
    );
}
export function readStoredDagLayoutMode(): DagLayoutMode {
    return lsReadEnum(
        GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY,
        ['text-flow', 'linear-arc', 'linear-arc-step-down', 'spiral', 'attribution-matrix'] as const,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.layoutMode,
    );
}
export function clampDagLayoutTransitionS(n: number): number {
    const stepped =
        Math.round(n / GEN_ATTR_DAG_LAYOUT_TRANSITION_S_STEP) * GEN_ATTR_DAG_LAYOUT_TRANSITION_S_STEP;
    return Math.max(
        GEN_ATTR_DAG_LAYOUT_TRANSITION_S_MIN,
        Math.min(GEN_ATTR_DAG_LAYOUT_TRANSITION_S_MAX, stepped),
    );
}
export function formatDagLayoutTransitionS(n: number): string {
    const s = clampDagLayoutTransitionS(n);
    return Number.isInteger(s) ? String(s) : s.toFixed(1);
}
export function readStoredDagLayoutTransitionEnabled(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_LAYOUT_TRANSITION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.layoutTransitionEnabled,
        { encoding: '1' },
    );
}
export function readStoredDagLayoutTransitionS(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_LAYOUT_TRANSITION_S_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.layoutTransitionDurationS,
        { parse: 'float', clamp: clampDagLayoutTransitionS },
    );
}
export function readStoredDagMatrixTranspose(): boolean {
    return lsReadBool(GEN_ATTR_DAG_MATRIX_TRANSPOSE_STORAGE_KEY, false, { encoding: '1' });
}
export function readStoredDagMatrixSwitchHorizontalLabel(): boolean {
    return lsReadBool(GEN_ATTR_DAG_MATRIX_SWITCH_HORIZONTAL_LABEL_STORAGE_KEY, false, {
        encoding: '1',
    });
}
export function readStoredDagMatrixSwitchVerticalLabel(): boolean {
    return lsReadBool(GEN_ATTR_DAG_MATRIX_SWITCH_VERTICAL_LABEL_STORAGE_KEY, false, {
        encoding: '1',
    });
}
export function readStoredDagMatrixPinSource(): boolean {
    return lsReadBool(GEN_ATTR_DAG_MATRIX_PIN_SOURCE_STORAGE_KEY, false, { encoding: '1' });
}
export function clampAttendMs(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_ATTEND_MS_MIN,
        Math.min(GEN_ATTR_DAG_ATTEND_MS_MAX, Math.round(n)),
    );
}
export function clampFfnRatio(n: number): number {
    if (!Number.isFinite(n)) return GEN_ATTR_DAG_FFN_RATIO_DEFAULT;
    return Math.max(
        GEN_ATTR_DAG_FFN_RATIO_MIN,
        Math.min(GEN_ATTR_DAG_FFN_RATIO_MAX, Math.round(n)),
    );
}
export function readStoredSimulateAttentionCost(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_SIMULATE_ATTENTION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.simulateAttentionCost,
        { encoding: '1' },
    );
}
export function readStoredSkipPrefillAttention(): boolean {
    const legacy = lsGet(GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY_LEGACY);
    if (legacy !== null) return legacy === '1';
    return lsReadBool(
        GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.skipPrefillAttention,
        { encoding: '1' },
    );
}
export function readStoredPrefillStyle(): 'plain' | 'random' {
    const raw = lsGet(GEN_ATTR_DAG_PREFILL_STYLE_STORAGE_KEY);
    if (raw === 'plain') return 'plain';
    if (raw === 'random') return 'random';
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.prefillStyle;
}
export function readStoredAttendMs(): number {
    return lsReadNumber(GEN_ATTR_DAG_ATTEND_MS_STORAGE_KEY, GEN_ATTR_DAG_ATTEND_MS_DEFAULT, {
        parse: 'int',
        clamp: clampAttendMs,
    });
}
export function readStoredFfnRatioAttend(): number {
    return lsReadNumber(GEN_ATTR_DAG_FFN_RATIO_STORAGE_KEY, GEN_ATTR_DAG_FFN_RATIO_DEFAULT, {
        parse: 'int',
        clamp: clampFfnRatio,
    });
}
export function readStoredAttendBurst(): number {
    return lsReadNumber(GEN_ATTR_DAG_ATTEND_BURST_STORAGE_KEY, ATTEND_BURST_DEFAULT, {
        parse: 'int',
        clamp: clampAttendBurst,
    });
}
export function readStoredQueryBurst(): number {
    return lsReadNumber(GEN_ATTR_DAG_QUERY_BURST_STORAGE_KEY, QUERY_BURST_DEFAULT, {
        parse: 'int',
        clamp: clampAttendBurst,
    });
}
export function readStoredHideArrowsDuringAttention(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_HIDE_ARROWS_DURING_ATTENTION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.hideArrowsDuringAttention,
        { encoding: '1' },
    );
}
export function readStoredDagNodeCiVisualScale(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.nodeCiVisualScaleEnabled,
        { encoding: '1' },
    );
}
export function readStoredDagDecayAttributionToHighSurprisalTarget(): boolean {
    const v = lsGet(GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY);
    if (v !== null) return v === '1';
    const legacy = lsGet(GEN_ATTR_DAG_EDGE_WEAKEN_HIGH_SURPRISAL_STORAGE_KEY_LEGACY);
    if (legacy !== null) return legacy === '1';
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.decayAttributionToHighSurprisalTargetEnabled;
}
export function readStoredDagHideInactiveEdges(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.hideInactiveEdges,
        { encoding: '1' },
    );
}
export function readStoredDagShowDownstreamInfluence(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.showDownstreamInfluence,
        { encoding: '1' },
    );
}
export function readStoredDagDimInactiveTokens(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.dimInactiveTokens,
        { encoding: '1' },
    );
}
export function readStoredDagDimInactiveTokensThreshold(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_THRESHOLD_STORAGE_KEY,
        DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
        { parse: 'float', clamp: clampDimInactiveTokensThreshold },
    );
}
export function readStoredDagDimInactiveNotDuringAnimation(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_DIM_INACTIVE_NOT_IN_ANIMATION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.dimInactiveNotDuringAnimation,
        { encoding: '1' },
    );
}
export function readStoredDagRecursiveAttribution(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.recursiveAttributionEnabled,
        { encoding: '1' },
    );
}
export function readStoredDagRecursiveEdgeAnimationDirection(): DagRecursiveEdgeAnimationDirection {
    return lsReadEnum(
        GEN_ATTR_DAG_RECURSIVE_EDGE_ANIMATION_DIRECTION_STORAGE_KEY,
        ['backward', 'forward'] as const,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.recursiveEdgeBatchAnimationDirection,
    );
}
export function readStoredDagForwardSlideSharedNodes(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_FORWARD_SLIDE_SHARED_NODES_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.forwardSlideSharedNodes,
        { encoding: '1' },
    );
}
export function readStoredDagHideExcludedTokens(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.hideExcludedTokens,
        { encoding: '1' },
    );
}
export function readStoredDagShowTopkOnSelected(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.showTokenInfoOnSelected,
        { encoding: '1' },
    );
}
export function genAttrDemoUiOptionsMatchesDefaults(current: GenAttrDemoUiOptions): boolean {
    const base = DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS;
    for (const key of Object.keys(base) as (keyof GenAttrDemoUiOptions)[]) {
        const c = current[key];
        const b = base[key];
        if (typeof c === 'number' && typeof b === 'number') {
            if (Math.abs(c - b) >= 1e-6) return false;
        } else if (c !== b) {
            return false;
        }
    }
    return true;
}
/**
 * 演示 UI 控件 id ↔ localStorage 键：面板委托识别、批量清除 LS。
 * 新增控件须同步改：本表、`persistGenAttrDemoUiOptionsToLocalStorage`、
 * 页面侧 `readGenAttrDemoUiOptionsFromControls` / `applyGenAttrDemoUiOptionsSnap`、
 * {@link DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS}（不含 Model、Max tokens、prompt 正文）。
 */
export const GEN_ATTR_DEMO_UI_PERSIST_SPECS: ReadonlyArray<{
    readonly controlId: string;
    readonly storageKey: string;
}> = [
    { controlId: 'gen_attr_dag_layout_mode', storageKey: GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY },
    { controlId: 'gen_attr_dag_layout_transition', storageKey: GEN_ATTR_DAG_LAYOUT_TRANSITION_STORAGE_KEY },
    {
        controlId: 'gen_attr_dag_layout_transition_s',
        storageKey: GEN_ATTR_DAG_LAYOUT_TRANSITION_S_STORAGE_KEY,
    },
    { controlId: 'gen_attr_dag_compactness', storageKey: GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY },
    { controlId: 'gen_attr_dag_measure_width', storageKey: GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY },
    { controlId: 'gen_attr_dag_linear_arc_interval', storageKey: GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY },
    { controlId: 'gen_attr_dag_node_ci_visual_scale', storageKey: GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY },
    {
        controlId: 'gen_attr_dag_decay_attribution_high_surprisal',
        storageKey: GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY,
    },
    { controlId: 'gen_attr_dag_recursive_attribution', storageKey: GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY },
    {
        controlId: 'gen_attr_dag_recursive_edge_animation_direction',
        storageKey: GEN_ATTR_DAG_RECURSIVE_EDGE_ANIMATION_DIRECTION_STORAGE_KEY,
    },
    { controlId: 'gen_attr_dag_dim_inactive_tokens', storageKey: GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_STORAGE_KEY },
    {
        controlId: 'gen_attr_dag_dim_inactive_tokens_threshold',
        storageKey: GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_THRESHOLD_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_dim_inactive_not_in_animation',
        storageKey: GEN_ATTR_DAG_DIM_INACTIVE_NOT_IN_ANIMATION_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_show_downstream_influence',
        storageKey: GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY,
    },
    { controlId: 'gen_attr_dag_edge_top_p_coverage', storageKey: GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY },
    { controlId: 'gen_attr_dag_hide_inactive_edges', storageKey: GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY },
    { controlId: 'gen_attr_dag_hide_excluded_tokens', storageKey: GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY },
    { controlId: 'gen_attr_dag_show_topk_on_selected', storageKey: GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY },
    { controlId: 'gen_attr_dag_replay_mode', storageKey: GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY },
    { controlId: 'gen_attr_dag_replay_auto_zoom', storageKey: GEN_ATTR_DAG_REPLAY_AUTO_ZOOM_STORAGE_KEY },
    {
        controlId: 'gen_attr_dag_disable_smart_step_time',
        storageKey: GEN_ATTR_DAG_DISABLE_SMART_STEP_TIME_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_lightning_effect',
        storageKey: GEN_ATTR_DAG_LIGHTNING_EFFECT_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_lightning_threshold',
        storageKey: GEN_ATTR_DAG_LIGHTNING_THRESHOLD_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_lightning_slow_mo',
        storageKey: GEN_ATTR_DAG_LIGHTNING_SLOW_MO_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_lightning_sound',
        storageKey: GEN_ATTR_DAG_LIGHTNING_SOUND_STORAGE_KEY,
    },
    { controlId: 'gen_attr_dag_playback_total_s', storageKey: GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY },
    { controlId: 'gen_attr_dag_playback_step_ms', storageKey: GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY },
    {
        controlId: 'gen_attr_dag_simulate_attention_cost',
        storageKey: GEN_ATTR_DAG_SIMULATE_ATTENTION_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_skip_prefill',
        storageKey: GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_prefill_style',
        storageKey: GEN_ATTR_DAG_PREFILL_STYLE_STORAGE_KEY,
    },
    { controlId: 'gen_attr_dag_attend_ms', storageKey: GEN_ATTR_DAG_ATTEND_MS_STORAGE_KEY },
    { controlId: 'gen_attr_dag_ffn_ratio', storageKey: GEN_ATTR_DAG_FFN_RATIO_STORAGE_KEY },
    { controlId: 'gen_attr_dag_attend_burst', storageKey: GEN_ATTR_DAG_ATTEND_BURST_STORAGE_KEY },
    { controlId: 'gen_attr_dag_query_burst', storageKey: GEN_ATTR_DAG_QUERY_BURST_STORAGE_KEY },
    {
        controlId: 'gen_attr_dag_hide_arrows_during_attention',
        storageKey: GEN_ATTR_DAG_HIDE_ARROWS_DURING_ATTENTION_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_dag_forward_slide_shared_nodes',
        storageKey: GEN_ATTR_DAG_FORWARD_SLIDE_SHARED_NODES_STORAGE_KEY,
    },
    {
        controlId: 'gen_attr_delete_prompt_patterns_enable',
        storageKey: GEN_ATTR_DELETE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
    },
    { controlId: 'gen_attr_delete_prompt_patterns', storageKey: GEN_ATTR_DELETE_PROMPT_PATTERNS_STORAGE_KEY },
    {
        controlId: 'gen_attr_exclude_prompt_patterns_enable',
        storageKey: GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
    },
    { controlId: 'gen_attr_exclude_prompt_patterns', storageKey: GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY },
    {
        controlId: 'gen_attr_exclude_generated_patterns_enable',
        storageKey: GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY,
    },
    { controlId: 'gen_attr_exclude_generated_patterns', storageKey: GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY },
];

export const GEN_ATTR_DEMO_UI_CONTROL_IDS = new Set(GEN_ATTR_DEMO_UI_PERSIST_SPECS.map((s) => s.controlId));

export const GEN_ATTR_DEMO_UI_LOCAL_STORAGE_KEYS: readonly string[] = GEN_ATTR_DEMO_UI_PERSIST_SPECS.map(
    (s) => s.storageKey,
);
export function isGenAttrDemoUiControl(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && GEN_ATTR_DEMO_UI_CONTROL_IDS.has(target.id);
}
export function removeGenAttrDemoUiOptionsFromLocalStorage(): void {
    for (const k of GEN_ATTR_DEMO_UI_LOCAL_STORAGE_KEYS) {
        lsRemove(k);
    }
}
export function persistGenAttrDemoUiOptionsToLocalStorage(snap: GenAttrDemoUiOptions): void {
    lsWriteString(GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY, snap.layoutMode);
    lsWriteBool(GEN_ATTR_DAG_LAYOUT_TRANSITION_STORAGE_KEY, snap.layoutTransitionEnabled, '1');
    lsSet(GEN_ATTR_DAG_LAYOUT_TRANSITION_S_STORAGE_KEY, String(snap.layoutTransitionDurationS));
    lsSet(GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY, String(snap.measureWidthPx));
    lsSet(GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY, String(snap.dagCompactness));
    lsSet(GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY, String(snap.linearArcAdjacentGapPx));
    lsSet(GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY, String(snap.edgeTopPCoverage));
    lsWriteBool(GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY, snap.hideExcludedTokens, '1');
    lsWriteBool(GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_STORAGE_KEY, snap.dimInactiveTokens, '1');
    lsSet(GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_THRESHOLD_STORAGE_KEY, String(snap.dimInactiveTokensThreshold));
    lsWriteBool(
        GEN_ATTR_DAG_DIM_INACTIVE_NOT_IN_ANIMATION_STORAGE_KEY,
        snap.dimInactiveNotDuringAnimation,
        '1',
    );
    lsWriteBool(GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY, snap.nodeCiVisualScaleEnabled, '1');
    lsWriteBool(
        GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY,
        snap.decayAttributionToHighSurprisalTargetEnabled,
        '1',
    );
    lsWriteBool(GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY, snap.hideInactiveEdges, '1');
    lsWriteBool(GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY, snap.showDownstreamInfluence, '1');
    lsWriteBool(GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY, snap.recursiveAttributionEnabled, '1');
    lsWriteString(
        GEN_ATTR_DAG_RECURSIVE_EDGE_ANIMATION_DIRECTION_STORAGE_KEY,
        snap.recursiveEdgeBatchAnimationDirection,
    );
    lsWriteBool(GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY, snap.showTokenInfoOnSelected, '1');
    lsWriteString(GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY, snap.replayPacingMode);
    lsWriteBool(GEN_ATTR_DAG_REPLAY_AUTO_ZOOM_STORAGE_KEY, snap.replayAutoZoom, '1');
    lsWriteBool(GEN_ATTR_DAG_DISABLE_SMART_STEP_TIME_STORAGE_KEY, snap.disableSmartStepTime, '1');
    lsWriteBool(GEN_ATTR_DAG_LIGHTNING_EFFECT_STORAGE_KEY, snap.lightningEffect, '1');
    lsSet(GEN_ATTR_DAG_LIGHTNING_THRESHOLD_STORAGE_KEY, String(snap.lightningThresholdTau));
    lsSet(GEN_ATTR_DAG_LIGHTNING_SLOW_MO_STORAGE_KEY, String(snap.lightningSlowMo));
    lsWriteBool(GEN_ATTR_DAG_LIGHTNING_SOUND_STORAGE_KEY, snap.lightningSound, '1');
    lsWriteBool(
        GEN_ATTR_DAG_FORWARD_SLIDE_SHARED_NODES_STORAGE_KEY,
        snap.forwardSlideSharedNodes,
        '1',
    );
    lsSet(GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY, String(snap.playbackTotalS));
    lsSet(GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY, String(snap.playbackStepMs));
    lsWriteBool(GEN_ATTR_DAG_SIMULATE_ATTENTION_STORAGE_KEY, snap.simulateAttentionCost, '1');
    lsWriteBool(GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY, snap.skipPrefillAttention, '1');
    lsWriteString(GEN_ATTR_DAG_PREFILL_STYLE_STORAGE_KEY, snap.prefillStyle);
    lsSet(GEN_ATTR_DAG_ATTEND_MS_STORAGE_KEY, String(snap.attendMs));
    lsSet(GEN_ATTR_DAG_FFN_RATIO_STORAGE_KEY, String(snap.ffnRatioAttend));
    lsSet(GEN_ATTR_DAG_ATTEND_BURST_STORAGE_KEY, String(snap.attendBurst));
    lsSet(GEN_ATTR_DAG_QUERY_BURST_STORAGE_KEY, String(snap.queryBurst));
    lsWriteBool(
        GEN_ATTR_DAG_HIDE_ARROWS_DURING_ATTENTION_STORAGE_KEY,
        snap.hideArrowsDuringAttention,
        '1',
    );
    lsSet(GEN_ATTR_DELETE_PROMPT_PATTERNS_STORAGE_KEY, snap.deletePromptPatternsText);
    lsWriteBool(GEN_ATTR_DELETE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY, snap.deletePromptPatternsEnabled, '1');
    lsSet(GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY, snap.excludePromptPatternsText);
    lsWriteBool(GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY, snap.excludePromptPatternsEnabled, '1');
    lsSet(GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY, snap.excludeGeneratedPatternsText);
    lsWriteBool(
        GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY,
        snap.excludeGeneratedPatternsEnabled,
        '1',
    );
}
export function mergeGenAttrDemoUiOptionsWithDefaults(
    snap?: Partial<GenAttrDemoUiOptions>
): GenAttrDemoUiOptions {
    return { ...DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS, ...snap };
}
