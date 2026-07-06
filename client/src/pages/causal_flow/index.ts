import * as d3 from 'd3';
import '../../shared/core/d3-polyfill';
import '../../css/pages/causal_flow.scss';

import { initThemeManager } from '../../shared/ui/theme';
import { initLanguageManager } from '../../shared/ui/language';
import { initI18n, tr, trf } from '../../shared/lang/i18n-lite';
import { AdminManager } from '../../shared/cross/adminManager';
import { SettingsMenuManager } from '../../shared/cross/settingsMenuManager';
import { initChatPanelLayout } from '../../shared/ui/chat_panel_layout';
import { PANEL_SPLIT_STORAGE_KEY_GEN_ATTRIBUTE } from '../../shared/cross/panelSplitStorage';
import { TextInputController } from '../../shared/controllers/textInputController';
import { initializeCommonApp } from '../../shared/bootstrap';
import { registerPageBusy } from '../../shared/core/activitySession';
import { setPageOptsGetter } from '../../shared/core/clientActivityPing';
import { showAlertDialog } from '../../shared/ui/dialog';
import { createToast } from '../../shared/ui/toast';
import type { PredictionAttributeModelVariant } from '../../shared/prediction_attribution/core/attributionResultCache';
import {
    clampDagEdgeTopPCoverage,
    DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
    dagExcludeIntervalContextForReplay,
    extractPromptTokenSpans,
    filterPromptSpansInInputRanges,
    isDagGenStepTargetExcluded,
    normalizePromptTokenSpans,
    type PromptTokenSpan,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagPreprocess';
import {
    clampDimInactiveTokensThreshold,
    dimInactiveThresholdFractionToUiPercent,
    dimInactiveThresholdUiPercentToFraction,
    dimInactiveThresholdUiStepForPercent,
    DIM_INACTIVE_THRESHOLD_UI_PERCENT_DEFAULT,
    DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
    formatDimInactiveThresholdPercentForInput,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagNodeDim';
import {
    clampLightningSlowMo,
    clampLightningThresholdTau,
    DAG_LIGHTNING_SLOW_MO_DEFAULT,
    DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagEdgeRenderStrength';
import {
    initGenAttributeDagView,
    setDagNodeCiVisualScaleEnabled,
    setDagDecayAttributionToHighSurprisalTargetEnabled,
    type DagLayoutMode,
    type DagRecursiveEdgeAnimationDirection,
    clampDagCompactness,
    clampLinearArcAdjacentGap,
    DAG_COMPACTNESS_DEFAULT,
    LINEAR_ARC_ADJACENT_GAP_DEFAULT,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagView';
import type {
    DagPropagationPlaybackOptions,
    DagRecursiveEdgeReplayPacing,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagRecursiveEdgeAnimation';
import {
    ATTEND_BURST_DEFAULT,
    QUERY_BURST_DEFAULT,
    clampAttendBurst,
    genStepTargetNodeId,
    planForOutputGenEvent,
    resolveAttentionPlaybackConfig,
    type AttentionExcludeContext,
    type AttentionPlaybackConfig,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagAttentionPlayback';
import { runAttentionPlayback } from '../../shared/prediction_attribution/causal_flow/runAttentionPlayback';
import type { DagStepPlaybackEvent, DagStepPlaybackOutputGenPrep } from '../../shared/prediction_attribution/causal_flow/genAttributeDagStepPlayback';
import {
    buildDagStepPlaybackEvents,
    buildOutputGenLegacyPrepMs,
    isToolCallingBoundaryBetweenSteps,
    resolveDagStepPlaybackClocksFromPacing,
    resolveDagStepPlaybackStart,
    runDagStepPlaybackLoop,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagStepPlayback';
import {
    createHydratedTokenGenHandle,
    startTokenGenAttribution,
    type CharRange,
    type TokenGenAttributionHandle,
    type TokenGenStep,
} from '../../shared/prediction_attribution/causal_flow/tokenGenAttributionRunner';
import {
    runMultiTurnAttribution,
    type MultiTurnAttributionHandle,
} from '../../shared/prediction_attribution/causal_flow/multiTurnAttribution';
import { DEFAULT_MAX_NEW_TOKENS, parseMaxNewTokens } from '../../shared/cross/maxNewTokensConfig';
import { createCompletionOptionsRow } from '../../shared/cross/completionOptionsRow';
import { fetchTokenize } from '../../shared/prediction_attribution/core/predictionAttributeClient';
import { completionFinishReasonLabel, type CompletionFinishReason } from '../../shared/cross/generationEndReasonLabel';
import {
    buildGenAttrExportedDemoPayload,
    getCachedEntryByContentKey,
    listCachedHistoryRows,
    removeCachedEntryByContentKey,
    save,
    touchCachedEntryByContentKey,
    type GenAttrCachedRun,
    type GenAttrDemoUiOptions,
    type GenAttrCacheKey,
    type GenAttrRunDraft,
} from '../../shared/storage/genAttributeRunCache';
import {
    DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT,
    DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
} from '../../shared/prediction_attribution/core/attributionExcludePromptPatternsStorage';
import {
    bindExcludePatternsUi,
    syncEnableGatedTextInputVisibility,
} from '../../shared/prediction_attribution/core/excludePromptPatternsUi';
import { syncChatPromptPanelEnableGatedBody } from '../../features/chat/chatPromptPanelUi';
import { initCachedHistoryQueryDropdown, type CachedHistorySelectContext } from '../../shared/cross/cachedHistoryUi';
import {
    DEFAULT_CONTENT_URL_PARAM,
    DEFAULT_DEMO_URL_PARAM,
    readContentUrlParam,
    readDemoUrlParam,
    replaceContentUrlParam,
    replaceDemoUrlParam,
    runContentUrlHydrate,
} from '../../shared/cross/contentUrl';
import {
    fetchBundledGenAttributeDemoBySlug,
    getBundledGenAttributeDemoLabel,
    getBundledGenAttributeDemoList,
    isGenAttrRunPayloadValidForUi,
} from '../../features/causal_flow/bundledDemos';
import { extractErrorMessage } from '../../shared/core/errorUtils';
import { exportJsonFile } from '../../shared/storage/localFileIO';
import {
    GEN_ATTR_RAW_INPUT_HISTORY_KEY,
    GEN_ATTR_SYSTEM_INPUT_HISTORY_KEY,
    GEN_ATTR_TEACHER_FORCING_INPUT_HISTORY_KEY,
    GEN_ATTR_USER_INPUT_HISTORY_KEY,
    initQueryHistoryDropdown,
    saveHistory,
} from '../../shared/cross/queryHistory';
import {
    GEN_ATTR_ENABLE_THINKING_STORAGE_KEY,
    GEN_ATTR_ENABLE_TOOL_CALLING_STORAGE_KEY,
    GEN_ATTR_ENABLE_MULTI_TURN_STORAGE_KEY,
    GEN_ATTR_TOOL_CONFIG_STORAGE_KEY,
    GEN_ATTR_MAX_NEW_TOKENS_STORAGE_KEY,
    GEN_ATTR_MODEL_VARIANT_STORAGE_KEY,
    LS_SKIP_CHAT_TEMPLATE,
} from '../../features/chat/chatPromptTemplateMode';
import { postCompletionsPrompt, postCompletionsStop } from '../../shared/api/completionsClient';
import { createToolCallingOptionsRow } from '../../features/chat/toolCallingOptionsRow';
import {
    cloneToolConfig,
    toolConfigCacheKeyFields,
    toolConfigFingerprint,
    toolConfigToolsSchema,
} from '../../features/chat/toolConfig';
import {
    attachToolCallingPendingLine,
    MOCK_TOOL_STEP_DELAY_MS,
    type ToolCallingPendingLine,
} from '../../features/chat/toolCallingPendingUi';
import { updateApiUsageDisplay, updateModel, validateMetricsElements } from '../../shared/cross/textMetricsUpdater';
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

d3.selectAll('.loadersmall').style('display', 'none');

initI18n();

const showToast = createToast('#toast').show;

const GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY = 'info_radar_gen_attr_dag_measure_width';
const GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY = 'info_radar_gen_attr_dag_layout_mode';
const GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY = 'info_radar_gen_attr_dag_playback_step_ms';
const GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY = 'info_radar_gen_attr_dag_replay_pacing_mode';
const GEN_ATTR_DAG_REPLAY_AUTO_ZOOM_STORAGE_KEY = 'info_radar_gen_attr_dag_replay_auto_zoom';
const GEN_ATTR_DAG_DISABLE_SMART_STEP_TIME_STORAGE_KEY =
    'info_radar_gen_attr_dag_disable_smart_step_time';
const GEN_ATTR_DAG_LIGHTNING_EFFECT_STORAGE_KEY = 'info_radar_gen_attr_dag_lightning_effect';
const GEN_ATTR_DAG_LIGHTNING_THRESHOLD_STORAGE_KEY = 'info_radar_gen_attr_dag_lightning_threshold';
const GEN_ATTR_DAG_LIGHTNING_SLOW_MO_STORAGE_KEY = 'info_radar_gen_attr_dag_lightning_slow_mo';
const GEN_ATTR_DAG_LIGHTNING_SOUND_STORAGE_KEY = 'info_radar_gen_attr_dag_lightning_sound';
const GEN_ATTR_DAG_FORWARD_SLIDE_SHARED_NODES_STORAGE_KEY =
    'info_radar_gen_attr_dag_forward_slide_shared_nodes';
const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY = 'info_radar_gen_attr_dag_playback_total_s';
const GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY = 'info_radar_gen_attr_dag_node_ci_visual_scale';
const GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY =
    'info_radar_gen_attr_dag_decay_attribution_high_surprisal';
/** @deprecated 读取迁移用 */
const GEN_ATTR_DAG_EDGE_WEAKEN_HIGH_SURPRISAL_STORAGE_KEY_LEGACY =
    'info_radar_gen_attr_dag_edge_weaken_high_surprisal';
const GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY = 'info_radar_gen_attr_dag_hide_inactive_edges';
const GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY =
    'info_radar_gen_attr_dag_show_downstream_influence';
const GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY = 'info_radar_gen_attr_dag_recursive_attribution';
const GEN_ATTR_DAG_RECURSIVE_EDGE_ANIMATION_DIRECTION_STORAGE_KEY =
    'info_radar_gen_attr_dag_recursive_edge_animation_direction';
const GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY = 'info_radar_gen_attr_dag_hide_excluded_tokens';
const GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_STORAGE_KEY = 'info_radar_gen_attr_dag_dim_inactive_tokens';
const GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_THRESHOLD_STORAGE_KEY =
    'info_radar_gen_attr_dag_dim_inactive_tokens_threshold';
const GEN_ATTR_DAG_DIM_INACTIVE_NOT_IN_ANIMATION_STORAGE_KEY =
    'info_radar_gen_attr_dag_dim_inactive_not_in_animation';
const GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY = 'info_radar_gen_attr_dag_show_topk_on_selected';
const GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY =
    'info_radar_gen_attr_dag_linear_arc_adjacent_gap';
const GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY = 'info_radar_gen_attr_dag_compactness';
const GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY = 'info_radar_gen_attr_dag_edge_top_p_coverage';
/** 仅此页：与 Attribution 的 `exclude_tokens` 无关。 */
const GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY = 'info_radar_gen_attr_exclude_prompt_patterns';
const GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY =
    'info_radar_gen_attr_exclude_prompt_patterns_enabled';
const GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY = 'info_radar_gen_attr_exclude_generated_patterns';
const GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY =
    'info_radar_gen_attr_exclude_generated_patterns_enabled';
const GEN_ATTR_DELETE_PROMPT_PATTERNS_STORAGE_KEY = 'info_radar_gen_attr_delete_prompt_patterns';
const GEN_ATTR_DELETE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY =
    'info_radar_gen_attr_delete_prompt_patterns_enabled';

/** 步进回放节奏：`total`＝整段剩余回放总时长内均分间隔；`step`＝固定每步间隔（ms）。 */
type DagReplayPacingMode = 'total' | 'step';

const GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT = 500;
const GEN_ATTR_DAG_MEASURE_WIDTH_MIN = 200;
const GEN_ATTR_DAG_MEASURE_WIDTH_MAX = 4000;

const GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT = 200;
const GEN_ATTR_DAG_PLAYBACK_STEP_MS_MIN = 0;
const GEN_ATTR_DAG_PLAYBACK_STEP_MS_MAX = 10000;

const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT = 7;
const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MIN = 1;
const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MAX = 3600;
/** 手输总量化的步长；原生 step=1 箭头在 `input` 里另取整。 */
const GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STEP = 0.1;

const GEN_ATTR_DAG_SIMULATE_ATTENTION_STORAGE_KEY = 'info_radar_gen_attr_dag_simulate_attention';
const GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY = 'info_radar_gen_attr_dag_skip_prefill';
const GEN_ATTR_DAG_PREFILL_STYLE_STORAGE_KEY = 'info_radar_gen_attr_dag_prefill_style';
/** @deprecated 读取兼容；新写入用 {@link GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY} */
const GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY_LEGACY = 'info_radar_gen_attr_dag_skip_prompt_attention';
const GEN_ATTR_DAG_ATTEND_MS_STORAGE_KEY = 'info_radar_gen_attr_dag_attend_ms';
const GEN_ATTR_DAG_FFN_RATIO_STORAGE_KEY = 'info_radar_gen_attr_dag_ffn_ratio';
const GEN_ATTR_DAG_ACCUMULATIVE_HIGHLIGHT_STORAGE_KEY =
    'info_radar_gen_attr_dag_accumulative_highlight';
const GEN_ATTR_DAG_ATTEND_BURST_STORAGE_KEY = 'info_radar_gen_attr_dag_attend_burst';
const GEN_ATTR_DAG_QUERY_BURST_STORAGE_KEY = 'info_radar_gen_attr_dag_query_burst';
const GEN_ATTR_DAG_HIDE_ARROWS_DURING_ATTENTION_STORAGE_KEY =
    'info_radar_gen_attr_dag_hide_arrows_during_attention';
const GEN_ATTR_DAG_ATTEND_MS_DEFAULT = 40;
const GEN_ATTR_DAG_ATTEND_MS_MIN = 1;
const GEN_ATTR_DAG_ATTEND_MS_MAX = 5000;
const GEN_ATTR_DAG_FFN_RATIO_DEFAULT = 3;
const GEN_ATTR_DAG_FFN_RATIO_MIN = 0;
const GEN_ATTR_DAG_FFN_RATIO_MAX = 20;

/** 与无 demoUiOptions 本地缓存时「读出默认」对齐，供重置与可读性单一的来源 */
const DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS: GenAttrDemoUiOptions = {
    layoutMode: 'text-flow',
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
    prefillStyle: 'plain',
    attendMs: GEN_ATTR_DAG_ATTEND_MS_DEFAULT,
    ffnRatioAttend: GEN_ATTR_DAG_FFN_RATIO_DEFAULT,
    accumulativeHighlight: false,
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

const GENERATE_BTN_LABEL = 'Start';
const STOP_BTN_LABEL = 'Stop';

function createFlowId(): string {
    const timePart = Date.now().toString(36).slice(-6);
    const randPart = Math.random().toString(36).slice(2, 6);
    return `${timePart}-${randPart}`;
}

function clampDagMeasureWidth(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_MEASURE_WIDTH_MIN,
        Math.min(GEN_ATTR_DAG_MEASURE_WIDTH_MAX, Math.round(n))
    );
}

function readStoredDagMeasureWidth(): number {
    return lsReadNumber(GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY, GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT, {
        clamp: clampDagMeasureWidth,
    });
}

function readStoredDagCompactness(): number {
    return lsReadNumber(GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY, DAG_COMPACTNESS_DEFAULT, {
        parse: 'float',
        clamp: clampDagCompactness,
    });
}

function readStoredDagEdgeTopPCoverage(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY,
        DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
        { parse: 'float', clamp: clampDagEdgeTopPCoverage },
    );
}

function readStoredDagLinearArcAdjacentGap(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY,
        LINEAR_ARC_ADJACENT_GAP_DEFAULT,
        { clamp: clampLinearArcAdjacentGap },
    );
}

function clampDagPlaybackStepMs(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_PLAYBACK_STEP_MS_MIN,
        Math.min(GEN_ATTR_DAG_PLAYBACK_STEP_MS_MAX, Math.round(n))
    );
}

function readStoredDagPlaybackStepMs(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY,
        GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT,
        { clamp: clampDagPlaybackStepMs },
    );
}

function clampDagPlaybackTotalS(n: number): number {
    const stepped =
        Math.round(n / GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STEP) * GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STEP;
    return Math.max(
        GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MIN,
        Math.min(GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MAX, stepped),
    );
}

function formatDagPlaybackTotalS(n: number): string {
    const s = clampDagPlaybackTotalS(n);
    return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

function readDagPlaybackTotalSFromInput(): number {
    const raw = parseFloat(dagPlaybackTotalSInput?.value ?? '');
    return Number.isFinite(raw)
        ? clampDagPlaybackTotalS(raw)
        : GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT;
}

function commitDagPlaybackTotalSInput(): void {
    if (!dagPlaybackTotalSInput) return;
    dagPlaybackTotalSInput.value = formatDagPlaybackTotalS(readDagPlaybackTotalSFromInput());
}

function readStoredDagPlaybackTotalS(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY,
        GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT,
        { parse: 'float', clamp: clampDagPlaybackTotalS },
    );
}

function readStoredDagReplayPacingMode(): DagReplayPacingMode {
    return lsReadEnum(
        GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY,
        ['total', 'step'] as const,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.replayPacingMode,
    );
}

function readStoredDagReplayAutoZoom(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_REPLAY_AUTO_ZOOM_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.replayAutoZoom,
        { encoding: '1' },
    );
}

function readStoredDagDisableSmartStepTime(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_DISABLE_SMART_STEP_TIME_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.disableSmartStepTime,
        { encoding: '1' },
    );
}

function readStoredDagLightningEffect(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_LIGHTNING_EFFECT_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.lightningEffect,
        { encoding: '1' },
    );
}

function readStoredDagLightningThresholdTau(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_LIGHTNING_THRESHOLD_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.lightningThresholdTau,
        { parse: 'float', clamp: clampLightningThresholdTau },
    );
}

function readStoredDagLightningSlowMo(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_LIGHTNING_SLOW_MO_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.lightningSlowMo,
        { clamp: clampLightningSlowMo },
    );
}

function readStoredDagLightningSound(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_LIGHTNING_SOUND_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.lightningSound,
        { encoding: '1' },
    );
}

function readStoredDagLayoutMode(): DagLayoutMode {
    return lsReadEnum(
        GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY,
        ['text-flow', 'linear-arc', 'linear-arc-step-down', 'spiral'] as const,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.layoutMode,
    );
}

const bodyElement = d3.select('body').node() as Element;
const { totalSurprisalFormat, api, apiBase } = initializeCommonApp(undefined, bodyElement);
const apiBaseForRequests = apiBase;

const adminManager = AdminManager.getInstance();
api.setAdminToken(adminManager.isInAdminMode() ? adminManager.getAdminToken() : null);

// --- DOM ---
const rawTextField = d3.select('#gen_attr_raw_text');
const rawTextCountValue = d3.select('#gen_attr_raw_text_count_value');
const clearRawBtn = d3.select('#gen_attr_clear_raw_btn');
const pasteRawBtn = d3.select('#gen_attr_paste_raw_btn');
const rawHistoryBtn = document.getElementById('gen_attr_raw_history_btn');

const systemTextField = d3.select('#gen_attr_system_text');
const systemTextCountValue = d3.select('#gen_attr_system_text_count_value');
const clearSystemBtn = d3.select('#gen_attr_clear_system_btn');
const pasteSystemBtn = d3.select('#gen_attr_paste_system_btn');
const systemHistoryBtn = document.getElementById('gen_attr_system_history_btn');

const userTextField = d3.select('#gen_attr_user_text');
const userTextCountValue = d3.select('#gen_attr_user_text_count_value');
const clearUserBtn = d3.select('#gen_attr_clear_user_btn');
const pasteUserBtn = d3.select('#gen_attr_paste_user_btn');
const userHistoryBtn = document.getElementById('gen_attr_user_history_btn');

const teacherForcingTextField = d3.select('#gen_attr_teacher_forcing_text');
const teacherForcingTextCountValue = d3.select('#gen_attr_teacher_forcing_text_count_value');
const clearTeacherForcingBtn = d3.select('#gen_attr_clear_teacher_forcing_btn');
const pasteTeacherForcingBtn = d3.select('#gen_attr_paste_teacher_forcing_btn');
const teacherForcingHistoryBtn = document.getElementById('gen_attr_teacher_forcing_history_btn');

const rawInputPanel = document.getElementById('gen_attr_raw_input_panel');
const chatInputPanel = document.getElementById('gen_attr_chat_input_panel');
const skipChatTemplateInput = document.getElementById(
    'gen_attr_skip_chat_template'
) as HTMLInputElement | null;
const genAttrUseSystemPromptInput = document.getElementById(
    'gen_attr_use_system_prompt'
) as HTMLInputElement | null;
const genAttrSystemPromptPanel = document.getElementById('gen_attr_system_prompt_panel');
const genAttrTeacherForcingEnable = document.getElementById(
    'gen_attr_teacher_forcing_enable'
) as HTMLInputElement | null;
const genAttrTeacherForcingBlock = document.getElementById('gen_attr_teacher_forcing_block');
const genAttrStopAfterTeacherForcing = document.getElementById(
    'gen_attr_stop_after_teacher_forcing'
) as HTMLInputElement | null;
const genAttrEnableThinkingInput = document.getElementById(
    'gen_attr_enable_thinking'
) as HTMLInputElement | null;
const submitBtn = d3.select('#gen_attr_submit_btn');
const loaderSmall = d3.select('.loadersmall');
const metricUsage = d3.select('#gen_attr_metric_usage');
const metricModel = d3.select('#gen_attr_metric_model');
const genAttrResultsEl = d3.select('#results.gen-attr-results-surface');

const dagLayoutModeSelect = document.getElementById('gen_attr_dag_layout_mode') as HTMLSelectElement | null;
const dagMeasureWidthGroup = document.getElementById('gen_attr_dag_measure_width_group');
const dagCompactnessGroup = document.getElementById('gen_attr_dag_compactness_group');
const dagMeasureWidthInput = document.getElementById(
    'gen_attr_dag_measure_width'
) as HTMLInputElement | null;
const dagLinearArcIntervalGroup = document.getElementById('gen_attr_dag_linear_arc_interval_group');
const dagLinearArcIntervalInput = document.getElementById(
    'gen_attr_dag_linear_arc_interval'
) as HTMLInputElement | null;
const dagCompactnessInput = document.getElementById(
    'gen_attr_dag_compactness'
) as HTMLInputElement | null;
const dagEdgeTopPCoverageInput = document.getElementById(
    'gen_attr_dag_edge_top_p_coverage'
) as HTMLInputElement | null;
/** 步进回放：固定间隔（ms）或总时长（s），由 {@link DagReplayPacingMode} 选择。 */
const dagPlaybackStepMsInput = document.getElementById(
    'gen_attr_dag_playback_step_ms'
) as HTMLInputElement | null;
const dagReplayModeSelect = document.getElementById(
    'gen_attr_dag_replay_mode'
) as HTMLSelectElement | null;
const dagPlaybackTotalSInput = document.getElementById(
    'gen_attr_dag_playback_total_s'
) as HTMLInputElement | null;
const dagReplayTotalWrap = document.getElementById('gen_attr_dag_replay_total_wrap');
const dagReplayStepWrap = document.getElementById('gen_attr_dag_replay_step_wrap');
const dagReplayAutoZoomInput = document.getElementById(
    'gen_attr_dag_replay_auto_zoom',
) as HTMLInputElement | null;
const dagDisableSmartStepTimeWrap = document.getElementById(
    'gen_attr_dag_disable_smart_step_time_wrap',
);
const dagDisableSmartStepTimeInput = document.getElementById(
    'gen_attr_dag_disable_smart_step_time',
) as HTMLInputElement | null;
const dagLightningEffectInput = document.getElementById(
    'gen_attr_dag_lightning_effect',
) as HTMLInputElement | null;
const dagLightningThresholdInput = document.getElementById(
    'gen_attr_dag_lightning_threshold',
) as HTMLInputElement | null;
const dagLightningThresholdWrap = document.getElementById('gen_attr_dag_lightning_threshold_wrap');
const dagLightningSlowMoInput = document.getElementById(
    'gen_attr_dag_lightning_slow_mo',
) as HTMLInputElement | null;
const dagLightningSlowMoWrap = document.getElementById('gen_attr_dag_lightning_slow_mo_wrap');
const dagLightningOptionsRow = document.getElementById('gen_attr_dag_lightning_options_row');
const dagLightningSoundWrap = document.getElementById('gen_attr_dag_lightning_sound_wrap');
const dagLightningSoundInput = document.getElementById(
    'gen_attr_dag_lightning_sound',
) as HTMLInputElement | null;
const dagForwardSlideSharedNodesWrap = document.getElementById(
    'gen_attr_dag_forward_slide_prompt_wrap',
);
const dagForwardSlideSharedNodesInput = document.getElementById(
    'gen_attr_dag_forward_slide_shared_nodes',
) as HTMLInputElement | null;
const dagSimulateAttentionInput = document.getElementById(
    'gen_attr_dag_simulate_attention_cost',
) as HTMLInputElement | null;
const dagSkipPrefillWrap = document.getElementById('gen_attr_dag_skip_prefill_wrap');
const dagSkipPrefillInput = document.getElementById(
    'gen_attr_dag_skip_prefill',
) as HTMLInputElement | null;
const dagPrefillStyleWrap = document.getElementById('gen_attr_dag_prefill_style_wrap');
const dagPrefillStyleSelect = document.getElementById(
    'gen_attr_dag_prefill_style',
) as HTMLSelectElement | null;
const dagQueryBurstWrap = document.getElementById('gen_attr_dag_query_burst_wrap');
const dagQueryBurstInput = document.getElementById(
    'gen_attr_dag_query_burst',
) as HTMLInputElement | null;
const dagFfnRatioWrap = document.getElementById('gen_attr_dag_ffn_ratio_wrap');
const dagFfnRatioInput = document.getElementById(
    'gen_attr_dag_ffn_ratio',
) as HTMLInputElement | null;
const dagAccumulativeHighlightInput = document.getElementById(
    'gen_attr_dag_accumulative_highlight',
) as HTMLInputElement | null;
const dagAttendBurstInput = document.getElementById(
    'gen_attr_dag_attend_burst',
) as HTMLInputElement | null;
const dagHideArrowsDuringAttentionInput = document.getElementById(
    'gen_attr_dag_hide_arrows_during_attention',
) as HTMLInputElement | null;
const dagAttendMsInput = document.getElementById(
    'gen_attr_dag_attend_ms',
) as HTMLInputElement | null;
const dagReplayAttendWrap = document.getElementById('gen_attr_dag_replay_attend_wrap');
const dagAttentionCostRow = document.querySelector(
    '.gen-attr-dag-attention-cost-row',
) as HTMLElement | null;

/** 与 `#gen_attr_dag_replay_mode` 同步；非法或缺失时视为 `total`。 */
function currentDagReplayPacingMode(): DagReplayPacingMode {
    return dagReplayModeSelect?.value === 'step' ? 'step' : 'total';
}

/** DAG replay speed 控件 → 规范化节奏；生成回放、传播链动画、demo 导出共用。 */
function readDagReplayPacingFromControls(options?: { writeBack?: boolean }): DagRecursiveEdgeReplayPacing {
    const rawStep = parseInt(dagPlaybackStepMsInput?.value ?? '', 10);
    const stepMs = Number.isFinite(rawStep)
        ? clampDagPlaybackStepMs(rawStep)
        : readStoredDagPlaybackStepMs();
    const rawS = parseFloat(dagPlaybackTotalSInput?.value ?? '');
    const totalS = Number.isFinite(rawS)
        ? clampDagPlaybackTotalS(rawS)
        : readStoredDagPlaybackTotalS();
    if (options?.writeBack) {
        if (dagPlaybackStepMsInput) dagPlaybackStepMsInput.value = String(stepMs);
        if (dagPlaybackTotalSInput) dagPlaybackTotalSInput.value = formatDagPlaybackTotalS(totalS);
    }
    return {
        mode: currentDagReplayPacingMode(),
        stepMs,
        totalS,
        disableSmartStepTime: dagDisableSmartStepTimeInput?.checked ?? false,
    };
}

/** 切换下拉时更新 `hidden`；样式见 `.gen-attr-dag-replay-value-wrap:not([hidden])`。 */
function applyDagReplaySpeedUi(): void {
    const mode = currentDagReplayPacingMode();
    const sim = isAttentionSimulationConfigured();
    if (dagReplayTotalWrap) dagReplayTotalWrap.hidden = mode !== 'total';
    const showClassicStepMs = mode === 'step' && !sim;
    const showAttendMs = mode === 'step' && sim;
    if (dagReplayStepWrap) dagReplayStepWrap.hidden = !showClassicStepMs;
    if (dagReplayAttendWrap) dagReplayAttendWrap.hidden = !showAttendMs;
}

function clampAttendMs(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_ATTEND_MS_MIN,
        Math.min(GEN_ATTR_DAG_ATTEND_MS_MAX, Math.round(n)),
    );
}

function clampFfnRatio(n: number): number {
    if (!Number.isFinite(n)) return GEN_ATTR_DAG_FFN_RATIO_DEFAULT;
    return Math.max(
        GEN_ATTR_DAG_FFN_RATIO_MIN,
        Math.min(GEN_ATTR_DAG_FFN_RATIO_MAX, Math.round(n)),
    );
}

function readStoredSimulateAttentionCost(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_SIMULATE_ATTENTION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.simulateAttentionCost,
        { encoding: '1' },
    );
}

function readStoredSkipPrefillAttention(): boolean {
    const legacy = lsGet(GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY_LEGACY);
    if (legacy !== null) return legacy === '1';
    return lsReadBool(
        GEN_ATTR_DAG_SKIP_PREFILL_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.skipPrefillAttention,
        { encoding: '1' },
    );
}

function readStoredPrefillStyle(): 'plain' | 'random' {
    const raw = lsGet(GEN_ATTR_DAG_PREFILL_STYLE_STORAGE_KEY);
    return raw === 'random' ? 'random' : 'plain';
}

function readPrefillStyleFromControl(): 'plain' | 'random' {
    const v = dagPrefillStyleSelect?.value;
    return v === 'random' ? 'random' : 'plain';
}

function readStoredAttendMs(): number {
    return lsReadNumber(GEN_ATTR_DAG_ATTEND_MS_STORAGE_KEY, GEN_ATTR_DAG_ATTEND_MS_DEFAULT, {
        parse: 'int',
        clamp: clampAttendMs,
    });
}

function readStoredFfnRatioAttend(): number {
    return lsReadNumber(GEN_ATTR_DAG_FFN_RATIO_STORAGE_KEY, GEN_ATTR_DAG_FFN_RATIO_DEFAULT, {
        parse: 'int',
        clamp: clampFfnRatio,
    });
}

function readStoredAccumulativeHighlight(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_ACCUMULATIVE_HIGHLIGHT_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.accumulativeHighlight,
        { encoding: '1' },
    );
}

function readStoredAttendBurst(): number {
    return lsReadNumber(GEN_ATTR_DAG_ATTEND_BURST_STORAGE_KEY, ATTEND_BURST_DEFAULT, {
        parse: 'int',
        clamp: clampAttendBurst,
    });
}

function readStoredQueryBurst(): number {
    return lsReadNumber(GEN_ATTR_DAG_QUERY_BURST_STORAGE_KEY, QUERY_BURST_DEFAULT, {
        parse: 'int',
        clamp: clampAttendBurst,
    });
}

function readStoredHideArrowsDuringAttention(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_HIDE_ARROWS_DURING_ATTENTION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.hideArrowsDuringAttention,
        { encoding: '1' },
    );
}

/** 勾选 Simulate attention 且非 Causal Flow Mode。 */
function isAttentionSimulationConfigured(): boolean {
    return (dagSimulateAttentionInput?.checked ?? false) && !isCausalFlowModeEnabled();
}

function isCausalFlowModeEnabled(): boolean {
    return dagRecursiveAttributionInput?.checked ?? false;
}

function applyAttentionCostUi(): void {
    const causalFlow = isCausalFlowModeEnabled();
    if (dagAttentionCostRow) dagAttentionCostRow.hidden = causalFlow;
    const sim = isAttentionSimulationConfigured();
    if (dagFfnRatioWrap) dagFfnRatioWrap.hidden = !sim;
    if (dagSkipPrefillWrap) dagSkipPrefillWrap.hidden = !sim;
    const skipPrefill = readSkipPrefillAttentionFromControl();
    if (dagPrefillStyleWrap) dagPrefillStyleWrap.hidden = !sim || skipPrefill;
    const randomPrefill = readPrefillStyleFromControl() === 'random';
    if (dagQueryBurstWrap) dagQueryBurstWrap.hidden = !sim || skipPrefill || !randomPrefill;
    applyDagReplaySpeedUi();
}

function readSkipPrefillAttentionFromControl(): boolean {
    return dagSkipPrefillInput?.checked ?? readStoredSkipPrefillAttention();
}

function readAttendMsFromControl(): number {
    const raw = parseInt(dagAttendMsInput?.value ?? '', 10);
    return Number.isFinite(raw) ? clampAttendMs(raw) : readStoredAttendMs();
}

function readFfnRatioFromControl(): number {
    const raw = parseInt(dagFfnRatioInput?.value ?? '', 10);
    return Number.isFinite(raw) ? clampFfnRatio(raw) : readStoredFfnRatioAttend();
}

function readAccumulativeHighlightFromControl(): boolean {
    return dagAccumulativeHighlightInput?.checked ?? readStoredAccumulativeHighlight();
}

function readAttendBurstFromControl(): number {
    const raw = parseInt(dagAttendBurstInput?.value ?? '', 10);
    return Number.isFinite(raw) ? clampAttendBurst(raw) : readStoredAttendBurst();
}

function readQueryBurstFromControl(): number {
    const raw = parseInt(dagQueryBurstInput?.value ?? '', 10);
    return Number.isFinite(raw) ? clampAttendBurst(raw) : readStoredQueryBurst();
}

function readHideArrowsDuringAttentionFromControl(): boolean {
    return (
        dagHideArrowsDuringAttentionInput?.checked ?? readStoredHideArrowsDuringAttention()
    );
}

/** Simulate attention 已启用且勾选 Hide arrows 时，仅在注意力动画进行中隐藏边。 */
function effectiveHideArrowsDuringAttention(): boolean {
    return isAttentionSimulationConfigured() && readHideArrowsDuringAttentionFromControl();
}

function currentDagLayoutMode(): DagLayoutMode {
    const v = dagLayoutModeSelect?.value;
    if (v === 'linear-arc' || v === 'linear-arc-step-down' || v === 'spiral') return v;
    return 'text-flow';
}

function currentDagRecursiveEdgeAnimationDirection(): DagRecursiveEdgeAnimationDirection {
    return dagRecursiveEdgeAnimationDirectionSelect?.value === 'forward' ? 'forward' : 'backward';
}

function applyDagLayoutModeUi(): void {
    const mode = currentDagLayoutMode();
    if (dagCompactnessGroup) {
        /** text-flow / spiral 均使用 display-scale 驱动的节点宽高与边回缩；linear-arc 家族不适用。 */
        dagCompactnessGroup.hidden = mode === 'linear-arc' || mode === 'linear-arc-step-down';
    }
    if (dagMeasureWidthGroup) {
        dagMeasureWidthGroup.hidden = mode !== 'text-flow';
    }
    if (dagLinearArcIntervalGroup) {
        dagLinearArcIntervalGroup.hidden = mode !== 'linear-arc' && mode !== 'linear-arc-step-down';
    }
}

const dagHideExcludedTokensInput = document.getElementById(
    'gen_attr_dag_hide_excluded_tokens'
) as HTMLInputElement | null;
const dagShowTopkOnSelectedInput = document.getElementById(
    'gen_attr_dag_show_topk_on_selected'
) as HTMLInputElement | null;
const dagNodeCiVisualScaleInput = document.getElementById(
    'gen_attr_dag_node_ci_visual_scale'
) as HTMLInputElement | null;
const dagDecayAttributionHighSurprisalInput = document.getElementById(
    'gen_attr_dag_decay_attribution_high_surprisal'
) as HTMLInputElement | null;
const dagHideInactiveEdgesInput = document.getElementById(
    'gen_attr_dag_hide_inactive_edges'
) as HTMLInputElement | null;
const dagShowDownstreamInfluenceInput = document.getElementById(
    'gen_attr_dag_show_downstream_influence'
) as HTMLInputElement | null;
const dagShowDownstreamInfluenceGroup = document.getElementById(
    'gen_attr_dag_show_downstream_influence_group'
);
const dagRecursiveAttributionInput = document.getElementById(
    'gen_attr_dag_recursive_attribution'
) as HTMLInputElement | null;
const dagRecursiveEdgeAnimationDirectionGroup = document.getElementById(
    'gen_attr_dag_recursive_edge_animation_direction_group'
);
const dagRecursiveEdgeAnimationDirectionSelect = document.getElementById(
    'gen_attr_dag_recursive_edge_animation_direction'
) as HTMLSelectElement | null;
const dagDimInactiveTokensGroup = document.getElementById('gen_attr_dag_dim_inactive_tokens_group');
const dagDimInactiveTokensInput = document.getElementById(
    'gen_attr_dag_dim_inactive_tokens'
) as HTMLInputElement | null;
const dagDimInactiveTokensThresholdInput = document.getElementById(
    'gen_attr_dag_dim_inactive_tokens_threshold'
) as HTMLInputElement | null;
const dagDimInactiveNotInAnimationWrap = document.getElementById(
    'gen_attr_dag_dim_inactive_not_in_animation_wrap',
);
const dagDimInactiveNotInAnimationInput = document.getElementById(
    'gen_attr_dag_dim_inactive_not_in_animation',
) as HTMLInputElement | null;
const genAttrDeletePromptPatternsTa = document.getElementById(
    'gen_attr_delete_prompt_patterns',
) as HTMLTextAreaElement | null;
const genAttrDeletePromptPatternsEnable = document.getElementById(
    'gen_attr_delete_prompt_patterns_enable',
) as HTMLInputElement | null;
const genAttrExcludePromptPatternsTa = document.getElementById(
    'gen_attr_exclude_prompt_patterns'
) as HTMLTextAreaElement | null;
const genAttrExcludePromptPatternsEnable = document.getElementById(
    'gen_attr_exclude_prompt_patterns_enable'
) as HTMLInputElement | null;
const genAttrExcludeGeneratedPatternsTa = document.getElementById(
    'gen_attr_exclude_generated_patterns'
) as HTMLTextAreaElement | null;
const genAttrExcludeGeneratedPatternsEnable = document.getElementById(
    'gen_attr_exclude_generated_patterns_enable'
) as HTMLInputElement | null;
const genAttrResetUiOptionsBtn = document.getElementById(
    'gen_attr_reset_ui_options_btn',
) as HTMLButtonElement | null;
const completeReasonEl = d3.select('#gen_attr_complete_reason');

/** exclude / delete 正则生效变更：须 reset 全步重放；动态过程（DAG 忙）中不生效。exclude 不改节点几何，保留视口。 */
function onDagPatternsEffectiveChange(opts?: { refit?: boolean }): void {
    const h = runnerHandle;
    if (!h || h.tokenCount === 0) return;
    tryResetAndReplayDag(opts);
}

bindExcludePatternsUi({
    storageKeys: {
        textKey: GEN_ATTR_DELETE_PROMPT_PATTERNS_STORAGE_KEY,
        enabledKey: GEN_ATTR_DELETE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
    },
    textInput: genAttrDeletePromptPatternsTa,
    enableCheckbox: genAttrDeletePromptPatternsEnable,
    onEffectiveChange: () => onDagPatternsEffectiveChange(),
    defaultTextWhenKeyAbsent: '',
    defaultEnabledWhenKeyAbsent: false,
    skipLocalStoragePersist: true,
});
bindExcludePatternsUi({
    storageKeys: {
        textKey: GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY,
        enabledKey: GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
    },
    textInput: genAttrExcludePromptPatternsTa,
    enableCheckbox: genAttrExcludePromptPatternsEnable,
    onEffectiveChange: () => onDagPatternsEffectiveChange({ refit: false }),
    defaultTextWhenKeyAbsent: DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
    skipLocalStoragePersist: true,
});
bindExcludePatternsUi({
    storageKeys: {
        textKey: GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY,
        enabledKey: GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY,
    },
    textInput: genAttrExcludeGeneratedPatternsTa,
    enableCheckbox: genAttrExcludeGeneratedPatternsEnable,
    onEffectiveChange: () => onDagPatternsEffectiveChange({ refit: false }),
    defaultTextWhenKeyAbsent: DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT,
    skipLocalStoragePersist: true,
});

/** 与 DAG 同源：DAG 预处理按当前控件即时读取，不读 Attribution 的 localStorage。 */
function genAttrEffectiveDeletePromptPatternsText(): string {
    if (!genAttrDeletePromptPatternsEnable?.checked) return '';
    return genAttrDeletePromptPatternsTa?.value ?? '';
}

function genAttrEffectiveExcludePromptPatternsText(): string {
    if (!genAttrExcludePromptPatternsEnable?.checked) return '';
    return genAttrExcludePromptPatternsTa?.value ?? '';
}

function genAttrEffectiveExcludeGeneratedPatternsText(): string {
    if (!genAttrExcludeGeneratedPatternsEnable?.checked) return '';
    return genAttrExcludeGeneratedPatternsTa?.value ?? '';
}

const initialDagLayoutMode = readStoredDagLayoutMode();
if (dagLayoutModeSelect) dagLayoutModeSelect.value = initialDagLayoutMode;
applyDagLayoutModeUi();
const initialDagMeasureWidth = readStoredDagMeasureWidth();
if (dagMeasureWidthInput) dagMeasureWidthInput.value = String(initialDagMeasureWidth);
const initialDagCompactness = readStoredDagCompactness();
if (dagCompactnessInput) dagCompactnessInput.value = String(initialDagCompactness);
const initialDagEdgeTopPCoverage = readStoredDagEdgeTopPCoverage();
if (dagEdgeTopPCoverageInput) dagEdgeTopPCoverageInput.value = String(initialDagEdgeTopPCoverage);
const initialDagLinearArcGap = readStoredDagLinearArcAdjacentGap();
if (dagLinearArcIntervalInput) dagLinearArcIntervalInput.value = String(initialDagLinearArcGap);

// DAG 回放节奏：步长 / 总时长 / 模式下拉 — 自 localStorage 恢复后再同步展示哪块输入
const initialDagPlaybackStepMs = readStoredDagPlaybackStepMs();
if (dagPlaybackStepMsInput) dagPlaybackStepMsInput.value = String(initialDagPlaybackStepMs);
const initialDagReplayPacingMode = readStoredDagReplayPacingMode();
if (dagReplayModeSelect) dagReplayModeSelect.value = initialDagReplayPacingMode;
const initialDagPlaybackTotalS = readStoredDagPlaybackTotalS();
if (dagPlaybackTotalSInput) dagPlaybackTotalSInput.value = formatDagPlaybackTotalS(initialDagPlaybackTotalS);
const initialDagReplayAutoZoom = readStoredDagReplayAutoZoom();
if (dagReplayAutoZoomInput) dagReplayAutoZoomInput.checked = initialDagReplayAutoZoom;
const initialDagDisableSmartStepTime = readStoredDagDisableSmartStepTime();
if (dagDisableSmartStepTimeInput) {
    dagDisableSmartStepTimeInput.checked = initialDagDisableSmartStepTime;
}
const initialDagLightningEffect = readStoredDagLightningEffect();
if (dagLightningEffectInput) {
    dagLightningEffectInput.checked = initialDagLightningEffect;
}
syncLightningSuboptionsVisibility();
const initialDagLightningThresholdTau = readStoredDagLightningThresholdTau();
if (dagLightningThresholdInput) {
    dagLightningThresholdInput.value = String(initialDagLightningThresholdTau);
}
const initialDagLightningSlowMo = readStoredDagLightningSlowMo();
if (dagLightningSlowMoInput) {
    dagLightningSlowMoInput.value = String(initialDagLightningSlowMo);
}
const initialDagLightningSound = readStoredDagLightningSound();
if (dagLightningSoundInput) {
    dagLightningSoundInput.checked = initialDagLightningSound;
}
const initialSimulateAttention = readStoredSimulateAttentionCost();
if (dagSimulateAttentionInput) dagSimulateAttentionInput.checked = initialSimulateAttention;
const initialSkipPrefillAttention = readStoredSkipPrefillAttention();
if (dagSkipPrefillInput) {
    dagSkipPrefillInput.checked = initialSkipPrefillAttention;
}
const initialPrefillStyle = readStoredPrefillStyle();
if (dagPrefillStyleSelect) {
    dagPrefillStyleSelect.value = initialPrefillStyle;
}
const initialAttendMs = readStoredAttendMs();
if (dagAttendMsInput) dagAttendMsInput.value = String(initialAttendMs);
const initialFfnRatio = readStoredFfnRatioAttend();
if (dagFfnRatioInput) dagFfnRatioInput.value = String(initialFfnRatio);
const initialAccumulativeHighlight = readStoredAccumulativeHighlight();
if (dagAccumulativeHighlightInput) {
    dagAccumulativeHighlightInput.checked = initialAccumulativeHighlight;
}
const initialAttendBurst = readStoredAttendBurst();
if (dagAttendBurstInput) dagAttendBurstInput.value = String(initialAttendBurst);
const initialQueryBurst = readStoredQueryBurst();
if (dagQueryBurstInput) dagQueryBurstInput.value = String(initialQueryBurst);
const initialHideArrowsDuringAttention = readStoredHideArrowsDuringAttention();
if (dagHideArrowsDuringAttentionInput) {
    dagHideArrowsDuringAttentionInput.checked = initialHideArrowsDuringAttention;
}
applyAttentionCostUi();

const genAttrResultsNode = genAttrResultsEl.node() as HTMLElement | null;
function readStoredDagNodeCiVisualScale(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.nodeCiVisualScaleEnabled,
        { encoding: '1' },
    );
}
const initialDagNodeCiVisualScale = readStoredDagNodeCiVisualScale();
if (dagNodeCiVisualScaleInput) dagNodeCiVisualScaleInput.checked = initialDagNodeCiVisualScale;
setDagNodeCiVisualScaleEnabled(initialDagNodeCiVisualScale);
dagNodeCiVisualScaleInput?.addEventListener('change', () => {
    setDagNodeCiVisualScaleEnabled(dagNodeCiVisualScaleInput.checked);
    tryResetAndReplayDag();
});

function readStoredDagDecayAttributionToHighSurprisalTarget(): boolean {
    const v = lsGet(GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY);
    if (v !== null) return v === '1';
    const legacy = lsGet(GEN_ATTR_DAG_EDGE_WEAKEN_HIGH_SURPRISAL_STORAGE_KEY_LEGACY);
    if (legacy !== null) return legacy === '1';
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.decayAttributionToHighSurprisalTargetEnabled;
}
const initialDagDecayAttributionHighSurprisal = readStoredDagDecayAttributionToHighSurprisalTarget();
if (dagDecayAttributionHighSurprisalInput) {
    dagDecayAttributionHighSurprisalInput.checked = initialDagDecayAttributionHighSurprisal;
}
setDagDecayAttributionToHighSurprisalTargetEnabled(initialDagDecayAttributionHighSurprisal);
dagDecayAttributionHighSurprisalInput?.addEventListener('change', () => {
    setDagDecayAttributionToHighSurprisalTargetEnabled(dagDecayAttributionHighSurprisalInput.checked);
    tryResetAndReplayDag({ refit: false });
});

function applyDagHideInactiveEdges(hide: boolean): void {
    if (!genAttrResultsNode) return;
    genAttrResultsNode.classList.toggle('gen-attr-dag-hide-inactive-edges', hide);
}
function readStoredDagHideInactiveEdges(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.hideInactiveEdges,
        { encoding: '1' },
    );
}
const initialDagHideInactiveEdges = readStoredDagHideInactiveEdges();
if (dagHideInactiveEdgesInput) dagHideInactiveEdgesInput.checked = initialDagHideInactiveEdges;
applyDagHideInactiveEdges(initialDagHideInactiveEdges);
dagHideInactiveEdgesInput?.addEventListener('change', () => {
    applyDagHideInactiveEdges(dagHideInactiveEdgesInput.checked);
});

function readStoredDagShowDownstreamInfluence(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.showDownstreamInfluence,
        { encoding: '1' },
    );
}
const initialDagShowDownstreamInfluence = readStoredDagShowDownstreamInfluence();
if (dagShowDownstreamInfluenceInput) {
    dagShowDownstreamInfluenceInput.checked = initialDagShowDownstreamInfluence;
}
dagShowDownstreamInfluenceInput?.addEventListener('change', () => {
    dagHandle.setShowDownstreamInfluence(dagShowDownstreamInfluenceInput.checked);
});

function syncDimInactiveTokensThresholdInputUi(): void {
    const show = dagDimInactiveTokensInput?.checked ?? false;
    if (dagDimInactiveTokensThresholdInput) {
        dagDimInactiveTokensThresholdInput.disabled = !show;
    }
    if (dagDimInactiveNotInAnimationWrap) {
        dagDimInactiveNotInAnimationWrap.hidden = !show;
    }
}

function syncDimInactiveTokensThresholdControlStep(): void {
    if (!dagDimInactiveTokensThresholdInput) return;
    const raw = parseFloat(dagDimInactiveTokensThresholdInput.value);
    const percent = Number.isFinite(raw)
        ? raw
        : DIM_INACTIVE_THRESHOLD_UI_PERCENT_DEFAULT;
    dagDimInactiveTokensThresholdInput.step = dimInactiveThresholdUiStepForPercent(percent);
}

function setDimInactiveTokensThresholdControlFromFraction(fraction: number): void {
    if (!dagDimInactiveTokensThresholdInput) return;
    const percent = dimInactiveThresholdFractionToUiPercent(fraction);
    dagDimInactiveTokensThresholdInput.value = formatDimInactiveThresholdPercentForInput(percent);
    syncDimInactiveTokensThresholdControlStep();
}

function readDimInactiveTokensThresholdFromControl(): number {
    const raw = parseFloat(dagDimInactiveTokensThresholdInput?.value ?? '');
    return dimInactiveThresholdUiPercentToFraction(
        Number.isFinite(raw) ? raw : DIM_INACTIVE_THRESHOLD_UI_PERCENT_DEFAULT,
    );
}

function applyDagDimInactiveTokensFromControls(): void {
    dagHandle.setDimInactiveTokens(dagDimInactiveTokensInput?.checked ?? false);
    dagHandle.setDimInactiveTokensThreshold(readDimInactiveTokensThresholdFromControl());
    dagHandle.setDimInactiveNotDuringAnimation(
        dagDimInactiveNotInAnimationInput?.checked ?? false,
    );
}

/** DAG 用户传播焦点；`initGenAttributeDagView` 之前恒为 `null`。 */
let getDagUserFocusId: () => string | null = () => null;

/** 与右上角 ↯ 出现条件一致：因果流模式 + 已确立传播焦点。 */
function syncPropagationPlaybackControlsVisibility(): void {
    if (!dagDisableSmartStepTimeWrap && !dagLightningOptionsRow) {
        return;
    }
    const show = (dagRecursiveAttributionInput?.checked ?? false) && getDagUserFocusId() != null;
    if (dagDisableSmartStepTimeWrap) dagDisableSmartStepTimeWrap.hidden = !show;
    if (dagLightningOptionsRow) dagLightningOptionsRow.hidden = !show;
    syncLightningSuboptionsVisibility();
}

/** 闪电效果关闭时隐藏 τ / 慢放 / 雷声子选项。 */
function syncLightningSuboptionsVisibility(): void {
    const show = dagLightningEffectInput?.checked ?? false;
    if (dagLightningThresholdWrap) dagLightningThresholdWrap.hidden = !show;
    if (dagLightningSlowMoWrap) dagLightningSlowMoWrap.hidden = !show;
    if (dagLightningSoundWrap) dagLightningSoundWrap.hidden = !show;
}

/** 传播归因相关控件可见性：仅在适用时显示。 */
function applyDagRecursiveAttributionSubmodeUi(): void {
    const recursive = dagRecursiveAttributionInput?.checked ?? false;
    const forward = recursive && currentDagRecursiveEdgeAnimationDirection() === 'forward';
    if (dagShowDownstreamInfluenceGroup) {
        dagShowDownstreamInfluenceGroup.hidden = recursive;
    }
    if (dagRecursiveEdgeAnimationDirectionGroup) {
        dagRecursiveEdgeAnimationDirectionGroup.hidden = !recursive;
    }
    if (dagDimInactiveTokensGroup) {
        dagDimInactiveTokensGroup.hidden = !recursive;
    }
    if (dagForwardSlideSharedNodesWrap) {
        dagForwardSlideSharedNodesWrap.hidden = !forward;
    }
    syncPropagationPlaybackControlsVisibility();
    syncDimInactiveTokensThresholdInputUi();
    applyAttentionCostUi();
}

function readStoredDagDimInactiveTokens(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.dimInactiveTokens,
        { encoding: '1' },
    );
}

function readStoredDagDimInactiveTokensThreshold(): number {
    return lsReadNumber(
        GEN_ATTR_DAG_DIM_INACTIVE_TOKENS_THRESHOLD_STORAGE_KEY,
        DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
        { parse: 'float', clamp: clampDimInactiveTokensThreshold },
    );
}

function readStoredDagDimInactiveNotDuringAnimation(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_DIM_INACTIVE_NOT_IN_ANIMATION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.dimInactiveNotDuringAnimation,
        { encoding: '1' },
    );
}

function readStoredDagRecursiveAttribution(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.recursiveAttributionEnabled,
        { encoding: '1' },
    );
}
const initialDagRecursiveAttribution = readStoredDagRecursiveAttribution();
if (dagRecursiveAttributionInput) dagRecursiveAttributionInput.checked = initialDagRecursiveAttribution;

function readStoredDagRecursiveEdgeAnimationDirection(): DagRecursiveEdgeAnimationDirection {
    return lsReadEnum(
        GEN_ATTR_DAG_RECURSIVE_EDGE_ANIMATION_DIRECTION_STORAGE_KEY,
        ['backward', 'forward'] as const,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.recursiveEdgeBatchAnimationDirection,
    );
}

function readStoredDagForwardSlideSharedNodes(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_FORWARD_SLIDE_SHARED_NODES_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.forwardSlideSharedNodes,
        { encoding: '1' },
    );
}

const initialDagForwardSlideSharedNodes = readStoredDagForwardSlideSharedNodes();
if (dagForwardSlideSharedNodesInput) {
    dagForwardSlideSharedNodesInput.checked = initialDagForwardSlideSharedNodes;
}

function readDagLightningThresholdTauFromControl(): number {
    const raw = parseFloat(dagLightningThresholdInput?.value ?? '');
    return Number.isFinite(raw) ? clampLightningThresholdTau(raw) : readStoredDagLightningThresholdTau();
}

function readDagLightningSlowMoFromControl(): number {
    const raw = parseFloat(dagLightningSlowMoInput?.value ?? '');
    return Number.isFinite(raw) ? clampLightningSlowMo(raw) : readStoredDagLightningSlowMo();
}

function readDagPropagationPlaybackOptionsFromControls(): DagPropagationPlaybackOptions {
    return {
        forwardSlideSharedNodes: dagForwardSlideSharedNodesInput?.checked ?? false,
        lightningEffect: dagLightningEffectInput?.checked ?? false,
        lightningThresholdTau: readDagLightningThresholdTauFromControl(),
        lightningSlowMo: readDagLightningSlowMoFromControl(),
        lightningSound: dagLightningSoundInput?.checked ?? false,
    };
}

const initialDagRecursiveEdgeAnimationDirection = readStoredDagRecursiveEdgeAnimationDirection();
if (dagRecursiveEdgeAnimationDirectionSelect) {
    dagRecursiveEdgeAnimationDirectionSelect.value = initialDagRecursiveEdgeAnimationDirection;
}

const initialDagDimInactiveTokens = readStoredDagDimInactiveTokens();
const initialDagDimInactiveTokensThreshold = readStoredDagDimInactiveTokensThreshold();
const initialDagDimInactiveNotDuringAnimation = readStoredDagDimInactiveNotDuringAnimation();
if (dagDimInactiveTokensInput) dagDimInactiveTokensInput.checked = initialDagDimInactiveTokens;
if (dagDimInactiveNotInAnimationInput) {
    dagDimInactiveNotInAnimationInput.checked = initialDagDimInactiveNotDuringAnimation;
}
setDimInactiveTokensThresholdControlFromFraction(initialDagDimInactiveTokensThreshold);

applyDagRecursiveAttributionSubmodeUi();
syncDimInactiveTokensThresholdInputUi();
dagRecursiveAttributionInput?.addEventListener('change', () => {
    applyDagRecursiveAttributionSubmodeUi();
    dagHandle.setRecursiveAttributionEnabled(dagRecursiveAttributionInput.checked);
    applyHideArrowsDuringAttentionToDag();
});
dagRecursiveEdgeAnimationDirectionSelect?.addEventListener('change', () => {
    const direction = currentDagRecursiveEdgeAnimationDirection();
    dagRecursiveEdgeAnimationDirectionSelect.value = direction;
    applyDagRecursiveAttributionSubmodeUi();
    dagHandle.setRecursiveEdgeBatchAnimationDirection(direction);
});

dagDimInactiveTokensInput?.addEventListener('change', () => {
    syncDimInactiveTokensThresholdInputUi();
    applyDagDimInactiveTokensFromControls();
});

dagDimInactiveTokensThresholdInput?.addEventListener('input', () => {
    syncDimInactiveTokensThresholdControlStep();
});
dagDimInactiveTokensThresholdInput?.addEventListener('change', () => {
    const t = readDimInactiveTokensThresholdFromControl();
    setDimInactiveTokensThresholdControlFromFraction(t);
    applyDagDimInactiveTokensFromControls();
});

dagDimInactiveNotInAnimationInput?.addEventListener('change', () => {
    applyDagDimInactiveTokensFromControls();
});

function readStoredDagHideExcludedTokens(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.hideExcludedTokens,
        { encoding: '1' },
    );
}
const initialDagHideExcludedTokens = readStoredDagHideExcludedTokens();
if (dagHideExcludedTokensInput) dagHideExcludedTokensInput.checked = initialDagHideExcludedTokens;
function readStoredDagShowTopkOnSelected(): boolean {
    return lsReadBool(
        GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY,
        DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.showTokenInfoOnSelected,
        { encoding: '1' },
    );
}
const initialDagShowTopkOnSelected = readStoredDagShowTopkOnSelected();
if (dagShowTopkOnSelectedInput) dagShowTopkOnSelectedInput.checked = initialDagShowTopkOnSelected;
dagHideExcludedTokensInput?.addEventListener('change', () => {
    dagHandle.setHideExcludedTokens(dagHideExcludedTokensInput.checked);
});

dagShowTopkOnSelectedInput?.addEventListener('change', () => {
    dagHandle.setShowTokenInfoOnSelected(dagShowTopkOnSelectedInput.checked);
});

// DAG 回放节奏（与上节「DAG 测量宽度」无关；宽度 listener 在后文）
dagPlaybackStepMsInput?.addEventListener('change', () => {
    const raw = parseInt(dagPlaybackStepMsInput.value, 10);
    const ms = Number.isFinite(raw)
        ? clampDagPlaybackStepMs(raw)
        : GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT;
    dagPlaybackStepMsInput.value = String(ms);
});

dagReplayModeSelect?.addEventListener('change', () => {
    applyAttentionCostUi();
});

dagSimulateAttentionInput?.addEventListener('change', () => {
    applyAttentionCostUi();
    applyHideArrowsDuringAttentionToDag();
});

dagSkipPrefillInput?.addEventListener('change', () => {
    applyAttentionCostUi();
});

dagPrefillStyleSelect?.addEventListener('change', () => {
    applyAttentionCostUi();
});

dagAttendMsInput?.addEventListener('change', () => {
    if (!dagAttendMsInput) return;
    const raw = parseInt(dagAttendMsInput.value, 10);
    dagAttendMsInput.value = String(
        Number.isFinite(raw) ? clampAttendMs(raw) : GEN_ATTR_DAG_ATTEND_MS_DEFAULT,
    );
});

dagFfnRatioInput?.addEventListener('change', () => {
    if (dagFfnRatioInput) dagFfnRatioInput.value = String(readFfnRatioFromControl());
});

dagAttendBurstInput?.addEventListener('change', () => {
    if (dagAttendBurstInput) dagAttendBurstInput.value = String(readAttendBurstFromControl());
});

dagQueryBurstInput?.addEventListener('change', () => {
    if (dagQueryBurstInput) dagQueryBurstInput.value = String(readQueryBurstFromControl());
});

dagHideArrowsDuringAttentionInput?.addEventListener('change', () => {
    applyHideArrowsDuringAttentionToDag();
});

dagPlaybackTotalSInput?.addEventListener('input', (e) => {
    if (!dagPlaybackTotalSInput) return;
    if (!(e instanceof InputEvent) || (e.inputType !== 'increment' && e.inputType !== 'decrement')) {
        return;
    }
    const raw = parseFloat(dagPlaybackTotalSInput.value);
    if (!Number.isFinite(raw)) return;
    dagPlaybackTotalSInput.value = formatDagPlaybackTotalS(clampDagPlaybackTotalS(Math.round(raw)));
});

dagPlaybackTotalSInput?.addEventListener('change', () => {
    commitDagPlaybackTotalSInput();
});

dagPlaybackTotalSInput?.addEventListener('blur', () => {
    commitDagPlaybackTotalSInput();
});

function isSkipChatTemplate(): boolean {
    return skipChatTemplateInput?.checked ?? false;
}

const completionOptions = createCompletionOptionsRow({
    isSkipChatTemplate,
    metricModel,
    alertDialogTitle: tr('LLM Causal Flow'),
    onStateChange: () => syncSubmitButtonState(),
    adminMode: () => adminManager.isInAdminMode(),
    modelVariantStorageKey: GEN_ATTR_MODEL_VARIANT_STORAGE_KEY,
    maxNewTokensStorageKey: GEN_ATTR_MAX_NEW_TOKENS_STORAGE_KEY,
});

const {
    modelVariantSelect,
    maxTokensInput,
    currentModelVariant,
    currentMaxTokens,
    isMaxNewTokensInputValid: isCompletionMaxNewTokensInputValid,
    syncModelVariantUi,
    syncIdleModelMetric,
    syncMaxTokensUi,
    normalizeMaxTokensField: normalizeGenAttrMaxTokensField,
} = completionOptions;

const toolCallingOptions = createToolCallingOptionsRow({
    enableToolCallingStorageKey: GEN_ATTR_ENABLE_TOOL_CALLING_STORAGE_KEY,
    multiTurnStorageKey: GEN_ATTR_ENABLE_MULTI_TURN_STORAGE_KEY,
    toolConfigStorageKey: GEN_ATTR_TOOL_CONFIG_STORAGE_KEY,
    onStateChange: () => syncSubmitButtonState(),
});

const {
    isToolCallingEnabled,
    isMultiTurnEnabled,
    getCurrentToolConfig,
    isToolCallingConfigReady,
    restoreFromDraft: restoreToolCallingFromDraft,
} = toolCallingOptions;

setPageOptsGetter(() => {
    const mode = currentDagLayoutMode();
    return {
        layout_linear_arc: mode === 'linear-arc',
        layout_step_down: mode === 'linear-arc-step-down',
        layout_spiral: mode === 'spiral',
        causal_flow: dagRecursiveAttributionInput?.checked ?? false,
        causal_flow_anim_backward: currentDagRecursiveEdgeAnimationDirection() === 'backward',
        downstream: dagShowDownstreamInfluenceInput?.checked ?? false,
        token_tooltip: dagShowTopkOnSelectedInput?.checked ?? false,
        tool_use: isToolCallingEnabled(),
    };
});

function isGenAttrUseSystemPrompt(): boolean {
    return genAttrUseSystemPromptInput?.checked ?? true;
}

function isEnableThinking(): boolean {
    return genAttrEnableThinkingInput?.checked ?? false;
}

function useMultiTurnAttribution(): boolean {
    return !isSkipChatTemplate() && isToolCallingEnabled() && isMultiTurnEnabled();
}

function syncGenAttrSystemPromptSuppressedUi(): void {
    syncChatPromptPanelEnableGatedBody(genAttrSystemPromptPanel, isGenAttrUseSystemPrompt());
}

function syncPromptPanelVisibility(): void {
    const skip = isSkipChatTemplate();
    if (rawInputPanel) rawInputPanel.hidden = !skip;
    if (chatInputPanel) chatInputPanel.hidden = skip;
}

function getActivePromptValue(): string {
    if (isSkipChatTemplate()) {
        return (rawTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    }
    return (userTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
}

function setActivePromptValue(value: string): void {
    if (isSkipChatTemplate()) {
        rawTextField.property('value', value);
        rawTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }
    userTextField.property('value', value);
    userPromptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
}

function isGenAttrTeacherForcingUiOn(): boolean {
    return genAttrTeacherForcingEnable?.checked ?? false;
}

function isStopAfterTeacherForcingOn(): boolean {
    return genAttrStopAfterTeacherForcing?.checked ?? false;
}

/** 勾选 Teacher forcing 且续写非空时返回原文；未勾选或空串时返回 `undefined`。 */
function teacherForcingContinuationForRun(): string | undefined {
    if (!isGenAttrTeacherForcingUiOn()) return undefined;
    const t = (teacherForcingTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    return t.length > 0 ? t : undefined;
}

/** 与 IndexedDB `save` 使用同一快照逻辑（须在 `autoMoveFirstTeacherForcingTokenToPromptIfNeeded` 之后调用）。 */
function buildGenAttrRunDraftForCache(): GenAttrRunDraft {
    const teacherForcingText = teacherForcingContinuationForRun();
    const stopAfterTF = isStopAfterTeacherForcingOn();
    const maxTokens = currentMaxTokens();
    const tokenizeModel = currentModelVariant();
    const tfDraftFields =
        teacherForcingText !== undefined
            ? { teacherForcing: teacherForcingText, stopAfterTeacherForcing: stopAfterTF }
            : {};
    return isSkipChatTemplate()
        ? { mode: 'raw', model: tokenizeModel, maxTokens, ...tfDraftFields }
        : {
              mode: 'chat',
              model: tokenizeModel,
              maxTokens,
              system: systemPromptTextarea?.value ?? '',
              user: userPromptTextarea?.value ?? '',
              useSystem: isGenAttrUseSystemPrompt(),
              enableThinking: isEnableThinking(),
              toolCallingEnabled: isToolCallingEnabled(),
              multiTurnEnabled: isMultiTurnEnabled(),
              toolConfig: cloneToolConfig(getCurrentToolConfig()),
              ...tfDraftFields,
          };
}

function syncTeacherForcingRow(): void {
    if (genAttrTeacherForcingBlock) {
        genAttrTeacherForcingBlock.hidden = !isGenAttrTeacherForcingUiOn();
    }
}

new TextInputController({
    textField: rawTextField,
    textCountValue: rawTextCountValue,
    clearBtn: clearRawBtn,
    submitBtn,
    saveBtn: d3.select(null),
    pasteBtn: pasteRawBtn,
    totalSurprisalFormat,
    showAlertDialog,
});

new TextInputController({
    textField: systemTextField,
    textCountValue: systemTextCountValue,
    clearBtn: clearSystemBtn,
    submitBtn,
    saveBtn: d3.select(null),
    pasteBtn: pasteSystemBtn,
    totalSurprisalFormat,
    showAlertDialog,
});

new TextInputController({
    textField: userTextField,
    textCountValue: userTextCountValue,
    clearBtn: clearUserBtn,
    submitBtn,
    saveBtn: d3.select(null),
    pasteBtn: pasteUserBtn,
    totalSurprisalFormat,
    showAlertDialog,
});

new TextInputController({
    textField: teacherForcingTextField,
    textCountValue: teacherForcingTextCountValue,
    clearBtn: clearTeacherForcingBtn,
    submitBtn,
    saveBtn: d3.select(null),
    pasteBtn: pasteTeacherForcingBtn,
    totalSurprisalFormat,
    showAlertDialog,
});

/** （第 0 步先）setPromptTokenSpans →（按需 fit）→ update；view 内部负责 exclude / 对齐 / Top-N / β / cumP */
function pushDagFromPreprocess(
    step: TokenGenStep,
    stepIndex: number,
    fitOnFirstStep: boolean = true,
    excludeIntervalContext?: string,
): void {
    if (stepIndex === 0) {
        if (!dagHandle.hasPromptSpans()) {
            dagHandle.setPromptTokenSpans(extractPromptTokenSpans(step), step.context);
        }
        if (!dagHandle.isBatching() && fitOnFirstStep) {
            dagHandle.fitViewportToContent();
        }
    }
    dagHandle.update(step, excludeIntervalContext);
}

/**
 * ▶ 开始前将 DAG 对齐到 `genStepCount` 前缀（0 = 仅 prompt）。
 * 缓存/demo 加载后图常为全量 replay，须先裁到播放起点，避免 `update()` 重复节点抛错中断。
 */
function syncDagToPlaybackPrefix(
    steps: readonly TokenGenStep[],
    genStepCount: number,
    catalogSpans: PromptTokenSpan[],
    excludeIntervalContext: string,
): void {
    dagHandle.reset(true);
    if (steps.length === 0) return;
    syncDagInputLayerAtStep({
        catalogSpans,
        layoutWire: steps[0]!.context,
        inputRanges: steps[0]!.inputRanges,
    });
    for (let i = 0; i < genStepCount; i++) {
        if (i > 0 && isToolCallingBoundaryBetweenSteps(steps, i - 1)) {
            const step = steps[i]!;
            syncDagInputLayerAtStep({
                catalogSpans,
                layoutWire: step.context,
                inputRanges: step.inputRanges,
            });
        }
        pushDagFromPreprocess(steps[i]!, i, false, excludeIntervalContext);
    }
}

/** 下一步要 `pushDagFromPreprocess` 的步下标；与当前 DAG 前缀一致（暂停不重置） */
let dagPlaybackNextIndex = 0;
/** 暂停后恢复：跳过 prompt 段，从 `dagPlaybackNextIndex` 对应 gen 步继续。 */
let dagPlaybackPausedMidRun = false;

/** 在 {@link dagHandle} 初始化后赋值；回放 stop 等路径用 `?.hide()` 避免初始化顺序问题。 */
let toolCallingPendingLine: ToolCallingPendingLine | null = null;

/** 当前 run 的 token 归因步序；须在 `initGenAttributeDagView` 之前声明（init 会同步调用 `onDagCanPlay`） */
let runnerHandle: TokenGenAttributionHandle | null = null;
let multiTurnAttributionHandle: MultiTurnAttributionHandle | null = null;

/**
 * 当前 run 的累积 input token spans（prompt + tool response）；缓存与步进回放数据源。
 */
let currentRunPromptSpans: PromptTokenSpan[] = [];
/** 首轮 prompt input spans（不含 tool response）；供多轮编排拼接全量 input spans。 */
let initialPromptInputSpans: PromptTokenSpan[] = [];

/**
 * 按当前步的 `inputRanges` 与 `layoutWire` 同步 prompt 层（live 与 ▶ 共用）。
 * ▶ 在 prompt（t=0）与 tool response **内容出现**时调用；其后 1× 才等到下一 output gen。
 * `layoutWire` 为本步 `update` 之前的累积全文（即 `step.context`）。
 */
function syncDagInputLayerAtStep(opts: {
    catalogSpans: PromptTokenSpan[];
    layoutWire: string;
    inputRanges: CharRange[];
    fitViewport?: boolean;
}): void {
    const visible = filterPromptSpansInInputRanges(opts.catalogSpans, opts.inputRanges);
    dagHandle.setPromptTokenSpans(visible, opts.layoutWire, { inputRanges: opts.inputRanges });
    if (opts.fitViewport && !dagHandle.isBatching()) {
        dagHandle.fitViewportToContent();
    }
}

/**
 * 将 handle 中已存步序按序重放进 DAG（调用方负责先 {@link dagHandle.reset} 等）。
 * @param promptSpans prompt 层节点数据；在批内最先注入，与归因裁剪无关。
 *   未传入时从 step 0 归因降级（旧缓存 / 非生成路径兼容）。
 */
function replayRunnerStepsIntoDag(h: TokenGenAttributionHandle, catalogSpans?: PromptTokenSpan[]): void {
    if (h.tokenCount === 0) {
        dagPlaybackNextIndex = 0;
        dagPlaybackPausedMidRun = false;
        return;
    }
    const steps = h.getAllSteps();
    const catalog = catalogSpans ?? extractPromptTokenSpans(steps[0]!);
    const excludeCtx = dagExcludeIntervalContextForReplay(steps);
    // 整段回放期间中间帧不可见：批处理内只维护图数据，结束时统一刷一次 svg。
    dagHandle.beginBatch();
    try {
        // 从初始 prompt 出发，让 textMeasure 随 gen token 自然增长；轮间边界按需追加 tool response spans。
        syncDagInputLayerAtStep({
            catalogSpans: catalog,
            layoutWire: steps[0]!.context,
            inputRanges: steps[0]!.inputRanges,
        });
        steps.forEach((step, i) => {
            if (i > 0 && step.inputRanges.length > steps[i - 1]!.inputRanges.length) {
                syncDagInputLayerAtStep({
                    catalogSpans: catalog,
                    layoutWire: step.context,
                    inputRanges: step.inputRanges,
                });
            }
            pushDagFromPreprocess(step, i, true, excludeCtx);
        });
    } finally {
        dagHandle.endBatch();
    }
    dagPlaybackNextIndex = h.tokenCount;
}

/** 末 output gen 展示后的收尾模拟开销（ms）；步进队列已结束，纯 UI 特例。 */
const DAG_LAST_TOKEN_APPEARANCE_COST_MS = 500;

let dagPlaybackTimer: ReturnType<typeof setTimeout> | null = null;
let dagPlaybackCancel: (() => void) | null = null;
let dagLastTokenDwellTimer: ReturnType<typeof setTimeout> | null = null;
/** 本场 ▶ 注意力回放是否已播过会话首帧 dwell0（续播不重复）。 */
let dagAttentionLeadDwell0Consumed = false;

function cancelDagAttentionPlayback(): void {
    if (dagPlaybackCancel !== null) {
        dagPlaybackCancel();
        dagPlaybackCancel = null;
    }
}

function cancelDagLastTokenDwell(): void {
    if (dagLastTokenDwellTimer !== null) {
        clearTimeout(dagLastTokenDwellTimer);
        dagLastTokenDwellTimer = null;
    }
}

/**
 * 末 token 已展示后的统一延时调度（生成 onComplete、回放最后一步）。
 * 新调度会取消上一次 pending，避免与步进 `dagPlaybackTimer` 叠用同一字段。
 */
function scheduleDagLastTokenDwell(action: () => void, costMs: number = DAG_LAST_TOKEN_APPEARANCE_COST_MS): void {
    cancelDagLastTokenDwell();
    dagLastTokenDwellTimer = setTimeout(() => {
        dagLastTokenDwellTimer = null;
        action();
    }, costMs);
}

function stopDagPlayback(): void {
    if (dagPlaybackTimer !== null) {
        clearTimeout(dagPlaybackTimer);
        dagPlaybackTimer = null;
    }
    cancelDagAttentionPlayback();
    cancelDagLastTokenDwell();
    toolCallingPendingLine?.hide();
    dagHandle.setAttentionPlaybackHighlight(null);
    dagHandle.setDagPlaybackPlaying(false);
}

function buildAttentionExcludeContext(
    excludeIntervalContext: string,
    excludePromptPatternsText: string,
    excludeGeneratedPatternsText: string,
    deletePromptPatternsText: string,
): AttentionExcludeContext {
    return {
        excludeIntervalContext,
        excludePromptPatternsText,
        excludeGeneratedPatternsText,
        deletePromptPatternsText,
    };
}

function resolveAttentionAnimationConfig(
    pacing: DagRecursiveEdgeReplayPacing,
    clocks: ReturnType<typeof resolveDagStepPlaybackClocksFromPacing>,
): AttentionPlaybackConfig {
    return {
        ...resolveAttentionPlaybackConfig(
            pacing,
            readAttendMsFromControl(),
            readFfnRatioFromControl(),
            clocks.outputGenClockMs,
        ),
        accumulativeHighlight: readAccumulativeHighlightFromControl(),
        attendBurst: readAttendBurstFromControl(),
        queryBurst: readQueryBurstFromControl(),
        prefillStyle: readPrefillStyleFromControl(),
    };
}

function buildOutputGenPrep(
    events: readonly DagStepPlaybackEvent[],
    steps: readonly TokenGenStep[],
    clocks: ReturnType<typeof resolveDagStepPlaybackClocksFromPacing>,
    animationConfig: AttentionPlaybackConfig,
    ctx: AttentionExcludeContext,
    catalogSpans: PromptTokenSpan[],
    skipOutputGen: (stepIndex: number) => boolean,
    isStale: () => boolean,
    simulateAttention: boolean,
): DagStepPlaybackOutputGenPrep {
    const skipPrefill = readSkipPrefillAttentionFromControl();
    const legacyPrepMs = buildOutputGenLegacyPrepMs(events, clocks, skipOutputGen);
    return {
        resolve: (stepIndex) => {
            if (!simulateAttention) {
                return { plan: null, prepMs: legacyPrepMs.get(stepIndex) ?? 0 };
            }
            const plan = planForOutputGenEvent(
                steps,
                stepIndex,
                catalogSpans,
                ctx,
                skipOutputGen,
                skipPrefill,
            );
            return { plan, prepMs: 0 };
        },
        playAnimation: simulateAttention
            ? (stepIndex, plan, showGen, advance) => {
                  const skipLeadDwell0 = dagAttentionLeadDwell0Consumed;
                  if (!skipLeadDwell0) dagAttentionLeadDwell0Consumed = true;
                  runAttentionPlayback({
                      plan,
                      config: animationConfig,
                      skipLeadDwell0,
                      setHighlight: (state) => dagHandle.setAttentionPlaybackHighlight(state),
                      setCancel: (cancel) => {
                          dagPlaybackCancel = cancel;
                      },
                      isCancelled: isStale,
                      onGenAppear: () => {
                          showGen();
                          const genTokenId = genStepTargetNodeId(steps[stepIndex]!);
                          dagHandle.setAttentionPlaybackHighlight({
                              queryTokenId: genTokenId,
                              litIds: [genTokenId],
                              phase: 'ffn',
                          });
                      },
                      onDone: () => {
                          if (isStale()) return;
                          dagHandle.setAttentionPlaybackHighlight(null);
                          advance();
                      },
                  });
              }
            : undefined,
    };
}

function handleDagPlaybackToggle(wantPlay: boolean): void {
    const userFocusId = dagHandle.getUserFocusId();
    if (userFocusId != null) return;
    const h = runnerHandle;
    if (!wantPlay) {
        const steps = h?.getAllSteps();
        if (h && steps && dagPlaybackNextIndex < steps.length) {
            dagPlaybackPausedMidRun = true;
        }
        stopDagPlayback();
        return;
    }
    dagHandle.stopPropagationPlayback();
    if (!h || h.tokenCount === 0) return;
    if (dagPlaybackTimer !== null) {
        clearTimeout(dagPlaybackTimer);
        dagPlaybackTimer = null;
    }
    cancelDagAttentionPlayback();
    cancelDagLastTokenDwell();
    const steps = h.getAllSteps();
    if (dagPlaybackNextIndex >= steps.length) {
        // 保留 `layoutDirty`：用户 pan/zoom 后 Auto zoom 仍应停止 fit。
        dagHandle.reset(true);
        dagPlaybackNextIndex = 0;
        dagPlaybackPausedMidRun = false;
        dagAttentionLeadDwell0Consumed = false;
    }
    const resumeFromPause = dagPlaybackPausedMidRun;
    dagPlaybackPausedMidRun = false;
    if (!resumeFromPause && dagPlaybackNextIndex === 0) {
        dagAttentionLeadDwell0Consumed = false;
    }
    const excludeCtx = dagExcludeIntervalContextForReplay(steps);
    if (!resumeFromPause) {
        syncDagToPlaybackPrefix(
            steps,
            dagPlaybackNextIndex,
            currentRunPromptSpans,
            excludeCtx,
        );
    }
    const excludePromptPatternsText = genAttrEffectiveExcludePromptPatternsText();
    const excludeGeneratedPatternsText = genAttrEffectiveExcludeGeneratedPatternsText();
    const skipAppearanceCostForOutputGen = (stepIndex: number): boolean => {
        const step = steps[stepIndex];
        if (!step) return false;
        return isDagGenStepTargetExcluded(
            step,
            excludeCtx,
            excludePromptPatternsText,
            excludeGeneratedPatternsText,
        );
    };
    const pacing = readDagReplayPacingFromControls({ writeBack: true });
    const clocks = resolveDagStepPlaybackClocksFromPacing(steps, pacing);
    const includePrompt =
        !resumeFromPause &&
        dagPlaybackNextIndex === 0 &&
        currentRunPromptSpans.length > 0;
    const events = buildDagStepPlaybackEvents(steps, includePrompt);
    const start = resolveDagStepPlaybackStart(
        events,
        steps,
        dagPlaybackNextIndex,
        includePrompt,
    );
    dagHandle.setDagPlaybackPlaying(true);

    const isStalePlaybackHandle = (): boolean => {
        if (runnerHandle === h) return false;
        dagPlaybackTimer = null;
        dagHandle.setDagPlaybackPlaying(false);
        return true;
    };

    const finishDagPlayback = (): void => {
        cancelDagLastTokenDwell();
        dagPlaybackTimer = null;
        cancelDagAttentionPlayback();
        toolCallingPendingLine?.hide();
        dagHandle.setAttentionPlaybackHighlight(null);
        dagHandle.clearNodeSelection();
        dagHandle.setDagPlaybackPlaying(false);
    };

    if (start.eventIndex >= events.length) {
        finishDagPlayback();
        return;
    }

    const attentionCtx = buildAttentionExcludeContext(
        excludeCtx,
        excludePromptPatternsText,
        excludeGeneratedPatternsText,
        genAttrEffectiveDeletePromptPatternsText(),
    );
    const simulateAttention = isAttentionSimulationConfigured();
    const animationConfig = resolveAttentionAnimationConfig(pacing, clocks);
    const outputGenPrep = buildOutputGenPrep(
        events,
        steps,
        clocks,
        animationConfig,
        attentionCtx,
        currentRunPromptSpans,
        skipAppearanceCostForOutputGen,
        isStalePlaybackHandle,
        simulateAttention,
    );

    runDagStepPlaybackLoop({
        events,
        start,
        clocks,
        isStale: isStalePlaybackHandle,
        outputGenPrep,
        setTimer: (cb, delayMs) => {
            dagPlaybackTimer = setTimeout(() => {
                dagPlaybackTimer = null;
                cb();
            }, delayMs);
        },
        setToolPendingVisible: (visible) => {
            if (visible) toolCallingPendingLine?.show();
            else toolCallingPendingLine?.hide();
        },
        showPrompt: () => {
            const firstStep = steps[0]!;
            syncDagInputLayerAtStep({
                catalogSpans: currentRunPromptSpans,
                layoutWire: firstStep.context,
                inputRanges: firstStep.inputRanges,
            });
        },
        afterStepShown: () => {
            if (dagReplayAutoZoomInput?.checked) {
                dagHandle.fitViewportToContent();
            }
        },
        showToolResponse: (stepIndex) => {
            const step = steps[stepIndex]!;
            syncDagInputLayerAtStep({
                catalogSpans: currentRunPromptSpans,
                layoutWire: step.context,
                inputRanges: step.inputRanges,
            });
        },
        showOutputGen: (stepIndex) => {
            const playbackStep = steps[stepIndex]!;
            syncDagInputLayerAtStep({
                catalogSpans: currentRunPromptSpans,
                layoutWire: playbackStep.context,
                inputRanges: playbackStep.inputRanges,
            });
            pushDagFromPreprocess(playbackStep, stepIndex, false, excludeCtx);
        },
        onOutputGenShown: (stepIndex) => {
            dagPlaybackNextIndex = stepIndex + 1;
        },
        onAllOutputGensShown: () => {
            if (runnerHandle !== h) {
                dagHandle.setDagPlaybackPlaying(false);
                return;
            }
            toolCallingPendingLine?.hide();
            dagHandle.setDagPlaybackPlaying(false);
            dagHandle.clearNodeSelection();
        },
        skipAppearanceCostForOutputGen,
        ...(simulateAttention
            ? { toolResponseAppearanceCostMs: MOCK_TOOL_STEP_DELAY_MS }
            : {}),
    });
}

const dagHandle = initGenAttributeDagView(d3.select('#results'), {
    onDagPlaybackToggle: handleDagPlaybackToggle,
    onDagCanPlay: () => {
        const h = runnerHandle;
        return h != null && h.tokenCount > 0;
    },
    onDagRefresh: () => {
        stopDagPlayback();
        dagPlaybackPausedMidRun = false;
        const h = runnerHandle;
        if (!h) return;
        replayRunnerStepsIntoDag(h, currentRunPromptSpans.length > 0 ? currentRunPromptSpans : undefined);
    },
    layoutMode: initialDagLayoutMode,
    measureWidthPx: initialDagMeasureWidth,
    dagCompactness: initialDagCompactness,
    linearArcAdjacentGapPx: initialDagLinearArcGap,
    hideExcludedTokens: initialDagHideExcludedTokens,
    hideArrowsDuringAttention: effectiveHideArrowsDuringAttention(),
    dimInactiveTokens: initialDagDimInactiveTokens,
    dimInactiveTokensThreshold: initialDagDimInactiveTokensThreshold,
    dimInactiveNotDuringAnimation: initialDagDimInactiveNotDuringAnimation,
    showTokenInfoOnSelected: initialDagShowTopkOnSelected,
    showDownstreamInfluence: initialDagShowDownstreamInfluence,
    recursiveAttributionEnabled: initialDagRecursiveAttribution,
    recursiveEdgeBatchAnimationDirection: initialDagRecursiveEdgeAnimationDirection,
    getReplayPacing: () => readDagReplayPacingFromControls({ writeBack: true }),
    getPropagationPlaybackOptions: () => readDagPropagationPlaybackOptionsFromControls(),
    edgeTopPCoverage: initialDagEdgeTopPCoverage,
    onFullscreenError: (message) => showToast(message, 'error'),
    getEffectiveExcludePromptPatternsText: genAttrEffectiveExcludePromptPatternsText,
    getEffectiveExcludeGeneratedPatternsText: genAttrEffectiveExcludeGeneratedPatternsText,
    getEffectiveDeletePromptPatternsText: genAttrEffectiveDeletePromptPatternsText,
    onUserFocusChange: () => syncPropagationPlaybackControlsVisibility(),
});

function applyHideArrowsDuringAttentionToDag(): void {
    dagHandle.setHideArrowsDuringAttention(effectiveHideArrowsDuringAttention());
}

applyHideArrowsDuringAttentionToDag();
getDagUserFocusId = () => dagHandle.getUserFocusId();
syncPropagationPlaybackControlsVisibility();
dagLightningEffectInput?.addEventListener('change', () => {
    syncLightningSuboptionsVisibility();
    if (dagLightningEffectInput?.checked) {
        dagHandle.playLightningEffectPreview();
    } else {
        dagHandle.cancelLightningEffectPreview();
        dagHandle.refreshNodeLinkHighlight();
    }
});
dagLightningThresholdInput?.addEventListener('focus', () => dagHandle.enterLightningTauPreview());
dagLightningThresholdInput?.addEventListener('blur', () => dagHandle.exitLightningTauPreview());
dagLightningThresholdInput?.addEventListener('input', () => dagHandle.refreshNodeLinkHighlight());
dagLightningSlowMoInput?.addEventListener('input', () => dagHandle.refreshNodeLinkHighlight());
dagLightningSoundInput?.addEventListener('change', () => dagHandle.refreshNodeLinkHighlight());

toolCallingPendingLine = attachToolCallingPendingLine(
    document.querySelector('#results .gen-attr-dag-stack') as HTMLElement,
);

dagForwardSlideSharedNodesInput?.addEventListener('change', () => {
    dagHandle.refreshNodeLinkHighlight();
});

dagLayoutModeSelect?.addEventListener('change', () => {
    applyDagLayoutModeUi();
    dagHandle.setLayoutMode(currentDagLayoutMode());
});

/**
 * DAG 是否处于「不方便」状态：流式生成中或 DAG 播放中（含末 token dwell）。
 * 这些状态下改测量宽度只更新设置、不触发重绘，避免打断正在进行的流程/定时器状态机；
 * 否则（稳态显示已完成结果）则自动 reset + replay + fit 到新宽度。
 */
function isDagBusy(): boolean {
    return (
        inFlight ||
        dagPlaybackTimer !== null ||
        dagPlaybackCancel !== null ||
        dagLastTokenDwellTimer !== null ||
        dagHandle.isPropagationPlaybackEngaged()
    );
}

/**
 * 非忙状态下 reset + replay，按需 fit，供各设置项切换后复用。忙时为 no-op。
 * exclude / Top-P 等影响建边的选项变更后须走此路径（DAG exclude 在建边时定稿，见 genAttributeDagView）。
 * 生成或 ▶ 回放进行中（{@link isDagBusy}）时改 exclude 正则为 no-op，动态过程内对已建边不生效。
 * 默认保留 DAG 选中节点；整页重置 UI 等场景传 `preserveNodeSelection: false`。
 * `refit: false` 时 `reset(true)` 保留 pan/zoom（仅边集/样式类变更）。
 */
function tryResetAndReplayDag(opts?: { preserveNodeSelection?: boolean; refit?: boolean }): void {
    dagHandle.stopPropagationPlayback();
    if (isDagBusy()) return;
    const refit = opts?.refit !== false;
    const preserveSelection = opts?.preserveNodeSelection !== false;
    const preservedSelectedId = preserveSelection ? dagHandle.getSelectedNodeId() : null;
    const preservedUserFocusId = preserveSelection ? dagHandle.getUserFocusId() : null;
    const h = runnerHandle;
    dagHandle.reset(!refit);
    if (h && h.tokenCount > 0) {
        replayRunnerStepsIntoDag(h, currentRunPromptSpans.length > 0 ? currentRunPromptSpans : undefined);
    }
    if (refit) {
        dagHandle.fitViewportToContent();
    }
    if (preservedUserFocusId != null) {
        dagHandle.setUserFocusNodeId(preservedUserFocusId);
    } else if (preservedSelectedId != null) {
        dagHandle.setSelectedNodeId(preservedSelectedId);
    } else {
        dagHandle.clearNodeSelection();
    }
}

dagMeasureWidthInput?.addEventListener('change', () => {
    const raw = parseInt(dagMeasureWidthInput.value, 10);
    const w = Number.isFinite(raw)
        ? clampDagMeasureWidth(raw)
        : GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT;
    dagMeasureWidthInput.value = String(w);
    dagHandle.setMeasureWidthPx(w);
    tryResetAndReplayDag();
});

dagCompactnessInput?.addEventListener('change', () => {
    const raw = parseFloat(dagCompactnessInput.value);
    const c = Number.isFinite(raw) ? clampDagCompactness(raw) : DAG_COMPACTNESS_DEFAULT;
    dagCompactnessInput.value = String(c);
    dagHandle.setDagCompactness(c);
    tryResetAndReplayDag();
});

dagEdgeTopPCoverageInput?.addEventListener('change', () => {
    const raw = parseFloat(dagEdgeTopPCoverageInput.value);
    const c = Number.isFinite(raw)
        ? clampDagEdgeTopPCoverage(raw)
        : DAG_EDGE_TOP_P_COVERAGE_DEFAULT;
    dagEdgeTopPCoverageInput.value = String(c);
    dagHandle.setEdgeTopPCoverage(c);
    tryResetAndReplayDag({ refit: false });
});

dagLinearArcIntervalInput?.addEventListener('change', () => {
    const raw = parseInt(dagLinearArcIntervalInput.value, 10);
    const n = Number.isFinite(raw)
        ? clampLinearArcAdjacentGap(raw)
        : LINEAR_ARC_ADJACENT_GAP_DEFAULT;
    dagLinearArcIntervalInput.value = String(n);
    dagHandle.setLinearArcAdjacentGapPx(n, { skipRefit: isDagBusy() });
});

/** 读取当前演示用 UI（DAG 与排除正则等），供 Export demo 写入 `demoUiOptions`。 */
function readGenAttrDemoUiOptionsFromControls(): GenAttrDemoUiOptions {
    const rawW = parseInt(dagMeasureWidthInput?.value ?? '', 10);
    const measureWidthPx = Number.isFinite(rawW)
        ? clampDagMeasureWidth(rawW)
        : GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT;
    const rawC = parseFloat(dagCompactnessInput?.value ?? '');
    const dagCompactness = Number.isFinite(rawC)
        ? clampDagCompactness(rawC)
        : DAG_COMPACTNESS_DEFAULT;
    const rawGap = parseInt(dagLinearArcIntervalInput?.value ?? '', 10);
    const linearArcAdjacentGapPx = Number.isFinite(rawGap)
        ? clampLinearArcAdjacentGap(rawGap)
        : LINEAR_ARC_ADJACENT_GAP_DEFAULT;
    const rawTop = parseFloat(dagEdgeTopPCoverageInput?.value ?? '');
    const edgeTopPCoverage = Number.isFinite(rawTop)
        ? clampDagEdgeTopPCoverage(rawTop)
        : DAG_EDGE_TOP_P_COVERAGE_DEFAULT;
    const {
        mode: replayPacingMode,
        stepMs: playbackStepMs,
        totalS: playbackTotalS,
        disableSmartStepTime,
    } = readDagReplayPacingFromControls();
    return {
        layoutMode: currentDagLayoutMode(),
        measureWidthPx,
        dagCompactness,
        linearArcAdjacentGapPx,
        hideExcludedTokens: dagHideExcludedTokensInput?.checked ?? false,
        dimInactiveTokens: dagDimInactiveTokensInput?.checked ?? false,
        dimInactiveTokensThreshold: readDimInactiveTokensThresholdFromControl(),
        dimInactiveNotDuringAnimation: dagDimInactiveNotInAnimationInput?.checked ?? false,
        edgeTopPCoverage,
        nodeCiVisualScaleEnabled:
            dagNodeCiVisualScaleInput?.checked ?? DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.nodeCiVisualScaleEnabled,
        decayAttributionToHighSurprisalTargetEnabled:
            dagDecayAttributionHighSurprisalInput?.checked ??
            DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.decayAttributionToHighSurprisalTargetEnabled,
        hideInactiveEdges: dagHideInactiveEdgesInput?.checked ?? false,
        showDownstreamInfluence: dagShowDownstreamInfluenceInput?.checked ?? false,
        recursiveAttributionEnabled: dagRecursiveAttributionInput?.checked ?? false,
        recursiveEdgeBatchAnimationDirection: currentDagRecursiveEdgeAnimationDirection(),
        forwardSlideSharedNodes: dagForwardSlideSharedNodesInput?.checked ?? false,
        showTokenInfoOnSelected: dagShowTopkOnSelectedInput?.checked ?? false,
        replayPacingMode,
        replayAutoZoom: dagReplayAutoZoomInput?.checked ?? false,
        disableSmartStepTime,
        lightningEffect: dagLightningEffectInput?.checked ?? false,
        lightningThresholdTau: readDagLightningThresholdTauFromControl(),
        lightningSlowMo: readDagLightningSlowMoFromControl(),
        lightningSound: dagLightningSoundInput?.checked ?? false,
        playbackTotalS,
        playbackStepMs,
        simulateAttentionCost: dagSimulateAttentionInput?.checked ?? false,
        skipPrefillAttention: readSkipPrefillAttentionFromControl(),
        prefillStyle: readPrefillStyleFromControl(),
        attendMs: readAttendMsFromControl(),
        ffnRatioAttend: readFfnRatioFromControl(),
        accumulativeHighlight: readAccumulativeHighlightFromControl(),
        attendBurst: readAttendBurstFromControl(),
        queryBurst: readQueryBurstFromControl(),
        hideArrowsDuringAttention: readHideArrowsDuringAttentionFromControl(),
        excludePromptPatternsEnabled: genAttrExcludePromptPatternsEnable?.checked ?? true,
        excludePromptPatternsText: genAttrExcludePromptPatternsTa?.value ?? '',
        excludeGeneratedPatternsEnabled: genAttrExcludeGeneratedPatternsEnable?.checked ?? true,
        excludeGeneratedPatternsText: genAttrExcludeGeneratedPatternsTa?.value ?? '',
        deletePromptPatternsEnabled: genAttrDeletePromptPatternsEnable?.checked ?? false,
        deletePromptPatternsText: genAttrDeletePromptPatternsTa?.value ?? '',
        selectedNodeId: dagHandle.getSelectedNodeId(),
    };
}

function genAttrDemoUiOptionsMatchesDefaults(current: GenAttrDemoUiOptions): boolean {
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

function syncGenAttrResetUiOptionsButtonState(): void {
    if (!genAttrResetUiOptionsBtn) return;
    genAttrResetUiOptionsBtn.disabled = genAttrDemoUiOptionsMatchesDefaults(
        readGenAttrDemoUiOptionsFromControls(),
    );
}

/**
 * 演示 UI 控件 id ↔ localStorage 键：面板委托识别、批量清除 LS。
 * 新增控件须同步改：本表、`persistGenAttrDemoUiOptionsToLocalStorage`、
 * {@link readGenAttrDemoUiOptionsFromControls}、`applyGenAttrDemoUiOptionsSnap`、
 * {@link DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS}（不含 Model、Max tokens、prompt 正文）。
 */
const GEN_ATTR_DEMO_UI_PERSIST_SPECS: ReadonlyArray<{
    readonly controlId: string;
    readonly storageKey: string;
}> = [
    { controlId: 'gen_attr_dag_layout_mode', storageKey: GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY },
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
    {
        controlId: 'gen_attr_dag_accumulative_highlight',
        storageKey: GEN_ATTR_DAG_ACCUMULATIVE_HIGHLIGHT_STORAGE_KEY,
    },
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

const GEN_ATTR_DEMO_UI_CONTROL_IDS = new Set(GEN_ATTR_DEMO_UI_PERSIST_SPECS.map((s) => s.controlId));

const GEN_ATTR_DEMO_UI_LOCAL_STORAGE_KEYS: readonly string[] = GEN_ATTR_DEMO_UI_PERSIST_SPECS.map(
    (s) => s.storageKey,
);

function isGenAttrDemoUiControl(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && GEN_ATTR_DEMO_UI_CONTROL_IDS.has(target.id);
}

function removeGenAttrDemoUiOptionsFromLocalStorage(): void {
    for (const k of GEN_ATTR_DEMO_UI_LOCAL_STORAGE_KEYS) {
        lsRemove(k);
    }
}

function persistGenAttrDemoUiOptionsToLocalStorage(snap: GenAttrDemoUiOptions): void {
    lsWriteString(GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY, snap.layoutMode);
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
    lsWriteBool(
        GEN_ATTR_DAG_ACCUMULATIVE_HIGHLIGHT_STORAGE_KEY,
        snap.accumulativeHighlight,
        '1',
    );
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

/** 演示用 UI：DOM → localStorage 的唯一写路径（用户改控件经面板委托；程序化 apply 末尾调用）。 */
function syncGenAttrDemoUiOptionsToLocalStorage(): void {
    persistGenAttrDemoUiOptionsToLocalStorage(readGenAttrDemoUiOptionsFromControls());
}

/** 从 `demoUiOptions` 还原排除控件（仅 DOM）；`replay` 读当前控件生效。 */
function applyGenAttrExcludePatternsFromDemoUiSnap(snap: Partial<GenAttrDemoUiOptions>): void {
    const {
        deletePromptPatternsEnabled,
        deletePromptPatternsText,
        excludePromptPatternsEnabled,
        excludePromptPatternsText,
        excludeGeneratedPatternsEnabled,
        excludeGeneratedPatternsText,
    } = snap;
    if (
        deletePromptPatternsEnabled === undefined &&
        deletePromptPatternsText === undefined &&
        excludePromptPatternsEnabled === undefined &&
        excludePromptPatternsText === undefined &&
        excludeGeneratedPatternsEnabled === undefined &&
        excludeGeneratedPatternsText === undefined
    ) {
        return;
    }
    if (deletePromptPatternsEnabled !== undefined && genAttrDeletePromptPatternsEnable) {
        genAttrDeletePromptPatternsEnable.checked = deletePromptPatternsEnabled;
    }
    if (deletePromptPatternsText !== undefined && genAttrDeletePromptPatternsTa) {
        genAttrDeletePromptPatternsTa.value = deletePromptPatternsText;
    }
    if (excludePromptPatternsEnabled !== undefined && genAttrExcludePromptPatternsEnable) {
        genAttrExcludePromptPatternsEnable.checked = excludePromptPatternsEnabled;
    }
    if (excludePromptPatternsText !== undefined && genAttrExcludePromptPatternsTa) {
        genAttrExcludePromptPatternsTa.value = excludePromptPatternsText;
    }
    if (excludeGeneratedPatternsEnabled !== undefined && genAttrExcludeGeneratedPatternsEnable) {
        genAttrExcludeGeneratedPatternsEnable.checked = excludeGeneratedPatternsEnabled;
    }
    if (excludeGeneratedPatternsText !== undefined && genAttrExcludeGeneratedPatternsTa) {
        genAttrExcludeGeneratedPatternsTa.value = excludeGeneratedPatternsText;
    }
    syncEnableGatedTextInputVisibility(genAttrDeletePromptPatternsEnable, genAttrDeletePromptPatternsTa);
    syncEnableGatedTextInputVisibility(genAttrExcludePromptPatternsEnable, genAttrExcludePromptPatternsTa);
    syncEnableGatedTextInputVisibility(genAttrExcludeGeneratedPatternsEnable, genAttrExcludeGeneratedPatternsTa);
}

/** demo 快照未写入的键用 {@link DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS} 补齐（仅打包 demo 加载路径）。 */
function mergeGenAttrDemoUiOptionsWithDefaults(
    snap?: Partial<GenAttrDemoUiOptions>
): GenAttrDemoUiOptions {
    return { ...DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS, ...snap };
}

/**
 * 按 `demoUiOptions` 逐项还原 DAG 面板与排除控件（后者仅 DOM）。
 * 仅应用 snap 中已存在的键；缺失键不改变当前控件状态。
 * 打包 demo 需先 {@link mergeGenAttrDemoUiOptionsWithDefaults} 再调用，以补齐未写入快照的项。
 */
function applyGenAttrDemoUiOptionsSnap(snap: Partial<GenAttrDemoUiOptions>): void {
    const mode = snap.layoutMode;
    if (mode) {
        if (dagLayoutModeSelect) {
            dagLayoutModeSelect.value = mode;
        }
        applyDagLayoutModeUi();
        dagHandle.setLayoutMode(mode);
    }

    if (snap.measureWidthPx !== undefined) {
        const w = clampDagMeasureWidth(snap.measureWidthPx);
        if (dagMeasureWidthInput) dagMeasureWidthInput.value = String(w);
        dagHandle.setMeasureWidthPx(w);
    }
    if (snap.dagCompactness !== undefined) {
        const c = clampDagCompactness(snap.dagCompactness);
        if (dagCompactnessInput) dagCompactnessInput.value = String(c);
        dagHandle.setDagCompactness(c);
    }
    if (snap.linearArcAdjacentGapPx !== undefined) {
        const n = clampLinearArcAdjacentGap(snap.linearArcAdjacentGapPx);
        if (dagLinearArcIntervalInput) dagLinearArcIntervalInput.value = String(n);
        dagHandle.setLinearArcAdjacentGapPx(n);
    }
    if (snap.edgeTopPCoverage !== undefined) {
        const c = clampDagEdgeTopPCoverage(snap.edgeTopPCoverage);
        if (dagEdgeTopPCoverageInput) dagEdgeTopPCoverageInput.value = String(c);
        dagHandle.setEdgeTopPCoverage(c);
    }
    if (snap.hideExcludedTokens !== undefined) {
        if (dagHideExcludedTokensInput) dagHideExcludedTokensInput.checked = snap.hideExcludedTokens;
        dagHandle.setHideExcludedTokens(snap.hideExcludedTokens);
    }
    if (snap.dimInactiveTokens !== undefined) {
        if (dagDimInactiveTokensInput) dagDimInactiveTokensInput.checked = snap.dimInactiveTokens;
        syncDimInactiveTokensThresholdInputUi();
        dagHandle.setDimInactiveTokens(snap.dimInactiveTokens);
    }
    if (snap.dimInactiveTokensThreshold !== undefined) {
        const t = clampDimInactiveTokensThreshold(snap.dimInactiveTokensThreshold);
        setDimInactiveTokensThresholdControlFromFraction(t);
        dagHandle.setDimInactiveTokensThreshold(t);
    }
    if (snap.dimInactiveNotDuringAnimation !== undefined) {
        if (dagDimInactiveNotInAnimationInput) {
            dagDimInactiveNotInAnimationInput.checked = snap.dimInactiveNotDuringAnimation;
        }
        syncDimInactiveTokensThresholdInputUi();
        dagHandle.setDimInactiveNotDuringAnimation(snap.dimInactiveNotDuringAnimation);
    }
    if (snap.nodeCiVisualScaleEnabled !== undefined) {
        if (dagNodeCiVisualScaleInput) dagNodeCiVisualScaleInput.checked = snap.nodeCiVisualScaleEnabled;
        setDagNodeCiVisualScaleEnabled(snap.nodeCiVisualScaleEnabled);
    }
    const decayAttributionHighSurprisal =
        snap.decayAttributionToHighSurprisalTargetEnabled ??
        (snap as { edgeWeakenHighSurprisalEnabled?: boolean }).edgeWeakenHighSurprisalEnabled;
    if (decayAttributionHighSurprisal !== undefined) {
        if (dagDecayAttributionHighSurprisalInput) {
            dagDecayAttributionHighSurprisalInput.checked = decayAttributionHighSurprisal;
        }
        setDagDecayAttributionToHighSurprisalTargetEnabled(decayAttributionHighSurprisal);
    }
    if (snap.hideInactiveEdges !== undefined) {
        if (dagHideInactiveEdgesInput) dagHideInactiveEdgesInput.checked = snap.hideInactiveEdges;
        applyDagHideInactiveEdges(snap.hideInactiveEdges);
    }
    if (snap.showDownstreamInfluence !== undefined) {
        if (dagShowDownstreamInfluenceInput) {
            dagShowDownstreamInfluenceInput.checked = snap.showDownstreamInfluence;
        }
        dagHandle.setShowDownstreamInfluence(snap.showDownstreamInfluence);
    }
    if (snap.recursiveAttributionEnabled !== undefined) {
        if (dagRecursiveAttributionInput) {
            dagRecursiveAttributionInput.checked = snap.recursiveAttributionEnabled;
        }
        applyDagRecursiveAttributionSubmodeUi();
        dagHandle.setRecursiveAttributionEnabled(snap.recursiveAttributionEnabled);
    }
    if (snap.recursiveEdgeBatchAnimationDirection !== undefined) {
        const direction: DagRecursiveEdgeAnimationDirection =
            snap.recursiveEdgeBatchAnimationDirection === 'forward' ? 'forward' : 'backward';
        if (dagRecursiveEdgeAnimationDirectionSelect) {
            dagRecursiveEdgeAnimationDirectionSelect.value = direction;
        }
        dagHandle.setRecursiveEdgeBatchAnimationDirection(direction);
    }
    if (snap.forwardSlideSharedNodes !== undefined) {
        if (dagForwardSlideSharedNodesInput) {
            dagForwardSlideSharedNodesInput.checked = snap.forwardSlideSharedNodes;
        }
        applyDagRecursiveAttributionSubmodeUi();
        dagHandle.refreshNodeLinkHighlight();
    }
    if (snap.showTokenInfoOnSelected !== undefined) {
        if (dagShowTopkOnSelectedInput) dagShowTopkOnSelectedInput.checked = snap.showTokenInfoOnSelected;
        dagHandle.setShowTokenInfoOnSelected(snap.showTokenInfoOnSelected);
    }
    if (snap.replayPacingMode !== undefined) {
        if (dagReplayModeSelect) dagReplayModeSelect.value = snap.replayPacingMode;
        applyDagReplaySpeedUi();
    }
    if (snap.replayAutoZoom !== undefined) {
        if (dagReplayAutoZoomInput) dagReplayAutoZoomInput.checked = snap.replayAutoZoom;
    }
    if (snap.disableSmartStepTime !== undefined) {
        if (dagDisableSmartStepTimeInput) {
            dagDisableSmartStepTimeInput.checked = snap.disableSmartStepTime;
        }
    }
    if (snap.lightningEffect !== undefined) {
        if (dagLightningEffectInput) {
            dagLightningEffectInput.checked = snap.lightningEffect;
        }
        syncLightningSuboptionsVisibility();
    }
    if (snap.lightningThresholdTau !== undefined) {
        const tau = clampLightningThresholdTau(snap.lightningThresholdTau);
        if (dagLightningThresholdInput) dagLightningThresholdInput.value = String(tau);
    }
    if (snap.lightningSlowMo !== undefined) {
        const slowMo = clampLightningSlowMo(snap.lightningSlowMo);
        if (dagLightningSlowMoInput) dagLightningSlowMoInput.value = String(slowMo);
    }
    if (snap.lightningSound !== undefined) {
        if (dagLightningSoundInput) dagLightningSoundInput.checked = snap.lightningSound;
    }
    if (snap.playbackTotalS !== undefined) {
        const s = clampDagPlaybackTotalS(snap.playbackTotalS);
        if (dagPlaybackTotalSInput) dagPlaybackTotalSInput.value = formatDagPlaybackTotalS(s);
    }
    if (snap.playbackStepMs !== undefined) {
        const ms = clampDagPlaybackStepMs(snap.playbackStepMs);
        if (dagPlaybackStepMsInput) dagPlaybackStepMsInput.value = String(ms);
    }
    if (snap.simulateAttentionCost !== undefined && dagSimulateAttentionInput) {
        dagSimulateAttentionInput.checked = snap.simulateAttentionCost;
    }
    const skipPrefill =
        snap.skipPrefillAttention ??
        (snap as { skipPromptAttention?: boolean }).skipPromptAttention;
    if (skipPrefill !== undefined && dagSkipPrefillInput) {
        dagSkipPrefillInput.checked = skipPrefill;
    }
    if (snap.prefillStyle !== undefined && dagPrefillStyleSelect) {
        dagPrefillStyleSelect.value = snap.prefillStyle === 'random' ? 'random' : 'plain';
    }
    if (snap.attendMs !== undefined && dagAttendMsInput) {
        dagAttendMsInput.value = String(clampAttendMs(snap.attendMs));
    }
    if (snap.ffnRatioAttend !== undefined && dagFfnRatioInput) {
        dagFfnRatioInput.value = String(clampFfnRatio(snap.ffnRatioAttend));
    }
    if (snap.accumulativeHighlight !== undefined && dagAccumulativeHighlightInput) {
        dagAccumulativeHighlightInput.checked = snap.accumulativeHighlight;
    }
    if (snap.attendBurst !== undefined && dagAttendBurstInput) {
        dagAttendBurstInput.value = String(clampAttendBurst(snap.attendBurst));
    }
    if (snap.queryBurst !== undefined && dagQueryBurstInput) {
        dagQueryBurstInput.value = String(clampAttendBurst(snap.queryBurst));
    }
    if (snap.hideArrowsDuringAttention !== undefined && dagHideArrowsDuringAttentionInput) {
        dagHideArrowsDuringAttentionInput.checked = snap.hideArrowsDuringAttention;
    }
    applyAttentionCostUi();
    applyHideArrowsDuringAttentionToDag();

    applyGenAttrExcludePatternsFromDemoUiSnap(snap);
    syncGenAttrDemoUiOptionsToLocalStorage();
    syncGenAttrResetUiOptionsButtonState();
}

/** replay 完成后按 `demoUiOptions.selectedNodeId` 恢复 DAG 焦点；无效或缺失则清除选中。 */
function restoreGenAttrDagFocusFromDemoUiOptions(snap: Partial<GenAttrDemoUiOptions> | undefined): void {
    const focusId = snap?.selectedNodeId;
    if (typeof focusId === 'string' && focusId.length > 0) {
        try {
            dagHandle.setUserFocusNodeId(focusId);
            return;
        } catch {
            /* demo 快照与当前图不一致时忽略 */
        }
    }
    dagHandle.clearNodeSelection();
}

function applyGenAttrDemoUiOptionsFromRecord(rec: GenAttrCachedRun): void {
    if (!rec.demoUiOptions) return;
    applyGenAttrDemoUiOptionsSnap(rec.demoUiOptions);
}

/** 重置「DAG 演示用 UI」：清 LS 后以 {@link DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS} 全量套用。 */
function resetGenAttrDemoUiOptionsToDefaults(): void {
    stopDagPlayback();
    removeGenAttrDemoUiOptionsFromLocalStorage();
    applyGenAttrDemoUiOptionsSnap(DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS);
    tryResetAndReplayDag({ preserveNodeSelection: false });
}

genAttrResetUiOptionsBtn?.addEventListener('click', resetGenAttrDemoUiOptionsToDefaults);

(() => {
    const panel = document.querySelector('.gen-attribute-page .input-section');
    if (!panel) return;
    const onDemoUiPersist = (e: Event) => {
        if (!isGenAttrDemoUiControl(e.target)) return;
        syncGenAttrDemoUiOptionsToLocalStorage();
        syncGenAttrResetUiOptionsButtonState();
    };
    panel.addEventListener('change', onDemoUiPersist);
    panel.addEventListener('blur', onDemoUiPersist, true);
    panel.addEventListener('input', (e) => {
        if (!isGenAttrDemoUiControl(e.target)) return;
        syncGenAttrResetUiOptionsButtonState();
    });
    syncGenAttrResetUiOptionsButtonState();
})();

window.addEventListener('pagehide', (ev) => {
    if (ev.persisted) return;
    dagHandle.detach();
});

// --- 状态 ---

/** 供导出 demo JSON；从缓存恢复时由 applyGenAttrCachedRun 写入 */
let lastRunCompletionReason: CompletionFinishReason | null = null;
let genAbort: AbortController | null = null;
let inFlight = false;
/** 当前次 run 的 `initialContext`（新 run 的 `resolveInitialContext`、从缓存/demo 灌入、onComplete 写入缓存、Export demo 共用） */
let lastRunInitialContext = '';
/** 与 `lastRunInitialContext` 同一次成功展示对应的左侧输入快照；用于判断「无新输入可跑」时置灰 Start */
let lastRunInputSnapshot: string | null = null;

function getInputSnapshotForRun(): string {
    const runOpts = {
        v: currentModelVariant(),
        max: maxTokensInput?.value ?? String(DEFAULT_MAX_NEW_TOKENS),
        tfOn: isGenAttrTeacherForcingUiOn(),
        tfText: (teacherForcingTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        saOn: isStopAfterTeacherForcingOn(),
    };
    if (isSkipChatTemplate()) {
        return JSON.stringify({
            mode: 'raw' as const,
            raw: (rawTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
            ...runOpts,
        });
    }
    return JSON.stringify({
        mode: 'chat' as const,
        useSys: isGenAttrUseSystemPrompt(),
        sys: (systemTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        user: (userTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        think: isEnableThinking(),
        toolCalling: isToolCallingEnabled(),
        multiTurn: isMultiTurnEnabled(),
        toolConfig: toolConfigFingerprint(getCurrentToolConfig()),
        ...runOpts,
    });
}

function setGenLoading(loading: boolean): void {
    inFlight = loading;
    loaderSmall.style('display', loading ? null : 'none');
    genAttrResultsEl.classed('gen-attr-in-flight', loading);
    syncSubmitButtonState();
}

registerPageBusy(() => inFlight);

/** 当前输入是否满足可以发起一次生成（不含 inFlight 判断）。 */
function isInputReadyForRun(): boolean {
    const prompt = getActivePromptValue();
    const forcing = teacherForcingContinuationForRun();
    if (prompt.length === 0 && forcing === undefined) return false;
    if (prompt.length > 0 && isGenAttrTeacherForcingUiOn() && forcing === undefined) return false;
    return isCompletionMaxNewTokensInputValid();
}

function syncSubmitButtonState(): void {
    if (inFlight) {
        submitBtn.text(STOP_BTN_LABEL);
        submitBtn.property('disabled', false);
        submitBtn.classed('inactive', false);
        return;
    }
    if (!isInputReadyForRun()) {
        submitBtn.text(GENERATE_BTN_LABEL);
        submitBtn.property('disabled', true);
        submitBtn.classed('inactive', true);
        return;
    }
    const hasDisplayedRun =
        runnerHandle !== null &&
        runnerHandle.tokenCount > 0 &&
        lastRunInitialContext.length > 0 &&
        lastRunInputSnapshot !== null;
    const inputMatchesDisplayed =
        hasDisplayedRun && getInputSnapshotForRun() === lastRunInputSnapshot;
    if (inputMatchesDisplayed) {
        submitBtn.text(tr('Retry'));
        submitBtn.property('disabled', false);
        submitBtn.classed('inactive', false);
        return;
    }
    submitBtn.text(GENERATE_BTN_LABEL);
    submitBtn.property('disabled', false);
    submitBtn.classed('inactive', false);
}

function bindInputsForSync(): void {
    const onInput = () => syncSubmitButtonState();
    (rawTextField.node() as HTMLTextAreaElement | null)?.addEventListener('input', onInput);
    (systemTextField.node() as HTMLTextAreaElement | null)?.addEventListener('input', onInput);
    (userTextField.node() as HTMLTextAreaElement | null)?.addEventListener('input', onInput);
    (teacherForcingTextField.node() as HTMLTextAreaElement | null)?.addEventListener('input', onInput);
}

if (skipChatTemplateInput) {
    skipChatTemplateInput.checked = lsReadBool(LS_SKIP_CHAT_TEMPLATE, false);
    skipChatTemplateInput.addEventListener('change', () => {
        lsWriteBool(LS_SKIP_CHAT_TEMPLATE, skipChatTemplateInput.checked);
        syncPromptPanelVisibility();
        syncGenAttrSystemPromptSuppressedUi();
        syncModelVariantUi();
        syncSubmitButtonState();
    });
}
if (genAttrEnableThinkingInput) {
    genAttrEnableThinkingInput.checked = lsReadBool(GEN_ATTR_ENABLE_THINKING_STORAGE_KEY, false);
    genAttrEnableThinkingInput.addEventListener('change', () => {
        lsWriteBool(GEN_ATTR_ENABLE_THINKING_STORAGE_KEY, genAttrEnableThinkingInput.checked);
        syncSubmitButtonState();
    });
}
syncPromptPanelVisibility();
syncModelVariantUi();
syncGenAttrSystemPromptSuppressedUi();
genAttrUseSystemPromptInput?.addEventListener('change', () => {
    syncGenAttrSystemPromptSuppressedUi();
    syncSubmitButtonState();
});
genAttrTeacherForcingEnable?.addEventListener('change', () => {
    syncTeacherForcingRow();
    syncSubmitButtonState();
});
syncTeacherForcingRow();
bindInputsForSync();
syncSubmitButtonState();
syncIdleModelMetric();

// --- History（与 Chat 共用 storage key）---
const rawTextarea = rawTextField.node() as HTMLTextAreaElement | null;
const systemPromptTextarea = systemTextField.node() as HTMLTextAreaElement | null;
const userPromptTextarea = userTextField.node() as HTMLTextAreaElement | null;
const teacherForcingTextarea = teacherForcingTextField.node() as HTMLTextAreaElement | null;

initQueryHistoryDropdown({
    input: rawTextarea,
    dropdownId: 'gen_attr_raw_input_history_dropdown',
    storageKey: GEN_ATTR_RAW_INPUT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncSubmitButtonState,
    historyButton: rawHistoryBtn,
    applyHistoryOnHover: true,
});

initQueryHistoryDropdown({
    input: systemPromptTextarea,
    dropdownId: 'gen_attr_system_prompt_history_dropdown',
    storageKey: GEN_ATTR_SYSTEM_INPUT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncSubmitButtonState,
    historyButton: systemHistoryBtn,
    applyHistoryOnHover: true,
});

initQueryHistoryDropdown({
    input: userPromptTextarea,
    dropdownId: 'gen_attr_user_prompt_history_dropdown',
    storageKey: GEN_ATTR_USER_INPUT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncSubmitButtonState,
    historyButton: userHistoryBtn,
    applyHistoryOnHover: true,
});

initQueryHistoryDropdown({
    input: teacherForcingTextarea,
    dropdownId: 'gen_attr_teacher_forcing_history_dropdown',
    storageKey: GEN_ATTR_TEACHER_FORCING_INPUT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncSubmitButtonState,
    historyButton: teacherForcingHistoryBtn,
    applyHistoryOnHover: true,
});


/** `?content=` 仅写入 IndexedDB 条目的 contentKey（save 返回值或 MRU id） */
function syncGenAttrContentUrl(contentKey: string): void {
    replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'causal_flow');
    replaceContentUrlParam(contentKey, DEFAULT_CONTENT_URL_PARAM, 'causal_flow');
    syncGenAttrCachedDemosValueDisplay();
}

function syncGenAttrDemoUrl(slug: string): void {
    replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'causal_flow');
    replaceDemoUrlParam(slug, DEFAULT_DEMO_URL_PARAM, 'causal_flow');
    syncGenAttrCachedDemosValueDisplay();
}

/** demo / cached history / `?content=` / `?demo=` 并发恢复时只采纳最后一次意图 */
let genAttrCachedApplyLatest = 0;

function nextGenAttrCachedApplyGen(): number {
    return ++genAttrCachedApplyLatest;
}

function isStaleGenAttrCachedApply(applyGen: number): boolean {
    return applyGen !== genAttrCachedApplyLatest;
}

/**
 * 将一条 GenAttr 缓存/打包记录灌入左侧输入与 DAG；与 Cached history、打包 demo、`?content=` / `?demo=` 共用。
 */
async function applyGenAttrCachedRun(
    rec: GenAttrCachedRun,
    options: {
        mru?: { shouldTouch: boolean; contentKey: string; ctx?: CachedHistorySelectContext };
        afterUrl: { kind: 'content'; contentKey: string } | { kind: 'demo'; slug: string };
    },
    applyGen: number
): Promise<void> {
    if (isStaleGenAttrCachedApply(applyGen)) {
        return;
    }
    if (rec.steps.length === 0) {
        showToast(tr('Cached run not found'), 'error');
        return;
    }
    const { draft } = rec;
    if (draft?.mode === 'chat') {
        if (genAttrUseSystemPromptInput) {
            genAttrUseSystemPromptInput.checked = draft.useSystem ?? true;
        }
        if (skipChatTemplateInput) {
            skipChatTemplateInput.checked = false;
            lsWriteBool(LS_SKIP_CHAT_TEMPLATE, false);
            syncPromptPanelVisibility();
            syncGenAttrSystemPromptSuppressedUi();
            syncModelVariantUi();
        }
        systemTextField.property('value', draft.system ?? '');
        systemPromptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        userTextField.property('value', draft.user ?? '');
        userPromptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        if (genAttrEnableThinkingInput) {
            genAttrEnableThinkingInput.checked = draft.enableThinking ?? false;
            lsWriteBool(
                GEN_ATTR_ENABLE_THINKING_STORAGE_KEY,
                genAttrEnableThinkingInput.checked,
            );
        }
        restoreToolCallingFromDraft(draft);
    } else {
        if (skipChatTemplateInput) {
            skipChatTemplateInput.checked = true;
            lsWriteBool(LS_SKIP_CHAT_TEMPLATE, true);
            syncPromptPanelVisibility();
            syncModelVariantUi();
        }
        rawTextField.property('value', rec.initialContext);
        rawTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 恢复 model / maxTokens（必须在 getInputSnapshotForRun() 之前，使快照与实际一致）
    if (draft?.mode === 'raw' && draft.model && modelVariantSelect) {
        modelVariantSelect.value = draft.model;
        lsWriteString(GEN_ATTR_MODEL_VARIANT_STORAGE_KEY, draft.model);
    }
    syncModelVariantUi();
    if (draft?.maxTokens != null && maxTokensInput) {
        maxTokensInput.value = String(draft.maxTokens);
    }

    // 恢复 teacher forcing 状态
    const tfFromRec = draft?.teacherForcing ?? '';
    if (genAttrTeacherForcingEnable) {
        genAttrTeacherForcingEnable.checked = tfFromRec.length > 0;
    }
    if (genAttrStopAfterTeacherForcing) {
        genAttrStopAfterTeacherForcing.checked = draft?.stopAfterTeacherForcing ?? false;
    }
    teacherForcingTextField.property('value', tfFromRec);
    teacherForcingTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
    syncTeacherForcingRow();

    if (rec.completionReason != null) {
        completeReasonEl.text(completionFinishReasonLabel(rec.completionReason));
        lastRunCompletionReason = rec.completionReason;
    } else {
        completeReasonEl.text('');
        lastRunCompletionReason = null;
    }

    stopDagPlayback();
    dagHandle.reset();
    if (options.afterUrl.kind === 'demo') {
        applyGenAttrDemoUiOptionsSnap(mergeGenAttrDemoUiOptionsWithDefaults(rec.demoUiOptions));
    } else {
        applyGenAttrDemoUiOptionsFromRecord(rec);
    }
    syncGenAttrResetUiOptionsButtonState();
    runnerHandle = createHydratedTokenGenHandle(rec.steps);
    lastRunInitialContext = rec.initialContext;
    lastRunInputSnapshot = getInputSnapshotForRun();
    syncSubmitButtonState();
    // 新缓存直接用 promptSpans；旧缓存无此字段时从 step 0 归因降级
    const replayPromptSpans = normalizePromptTokenSpans(
        rec.promptSpans ?? extractPromptTokenSpans(rec.steps[0]!),
    );
    currentRunPromptSpans = replayPromptSpans;
    replayRunnerStepsIntoDag(runnerHandle, replayPromptSpans);
    dagHandle.fitViewportToContent();
    restoreGenAttrDagFocusFromDemoUiOptions(rec.demoUiOptions);
    const n = runnerHandle.tokenCount;
    setGenAttrUsageMetric(initialPromptTokensFromFirstStep(rec.steps[0]!), n);
    if (validateMetricsElements(metricModel) && n > 0) {
        const last = runnerHandle.getStep(n - 1)!;
        updateModel(metricModel, last.response.model ?? null);
    }

    const m = options.mru;
    if (m?.shouldTouch) {
        if (isStaleGenAttrCachedApply(applyGen)) {
            return;
        }
        await touchCachedEntryByContentKey(m.contentKey);
        if (isStaleGenAttrCachedApply(applyGen)) {
            return;
        }
        await m.ctx?.refreshList();
    }
    if (isStaleGenAttrCachedApply(applyGen)) {
        return;
    }
    if (options.afterUrl.kind === 'content') {
        syncGenAttrContentUrl(options.afterUrl.contentKey);
    } else {
        syncGenAttrDemoUrl(options.afterUrl.slug);
    }
}

/** 从缓存恢复运行；`shouldTouch` 为 true 时 touch MRU（下拉选中恒为 false，↑ 置顶走单独路径）。 */
async function restoreGenAttrFromCachedRun(
    contentKey: string,
    shouldTouch: boolean,
    ctx?: CachedHistorySelectContext
): Promise<void> {
    const applyGen = nextGenAttrCachedApplyGen();
    const rec = await getCachedEntryByContentKey(contentKey);
    if (isStaleGenAttrCachedApply(applyGen)) {
        return;
    }
    if (!rec || rec.steps.length === 0) {
        showToast(tr('Cached run not found'), 'error');
        return;
    }
    await applyGenAttrCachedRun(
        rec,
        {
            mru: shouldTouch ? { shouldTouch: true, contentKey, ctx } : undefined,
            afterUrl: { kind: 'content', contentKey },
        },
        applyGen
    );
}

async function restoreGenAttrFromDemoSlug(slug: string): Promise<void> {
    const applyGen = nextGenAttrCachedApplyGen();
    try {
        const rec = await fetchBundledGenAttributeDemoBySlug(slug);
        if (isStaleGenAttrCachedApply(applyGen)) {
            return;
        }
        if (!rec || !isGenAttrRunPayloadValidForUi(rec)) {
            showToast(tr('Demo not found'), 'error');
            return;
        }
        await applyGenAttrCachedRun(rec, { afterUrl: { kind: 'demo', slug } }, applyGen);
    } catch (e: unknown) {
        if (isStaleGenAttrCachedApply(applyGen)) {
            return;
        }
        console.error('[causal_flow] demo load failed', e);
        showToast(extractErrorMessage(e, tr('Demo not found')), 'error');
    }
}

const genAttrCachedHistoryBtn = document.getElementById('gen_attr_cached_history_btn');
const genAttrCachedDemosBtn = document.getElementById('gen_attr_cached_demos_btn');
const genAttrCachedDemosValueBtn = document.getElementById('gen_attr_cached_demos_value_btn');
const genAttrCachedDemosValueEl = document.getElementById('gen_attr_cached_demos_value');
let genAttrBundledDemoEntries: Array<{ id: string; label: string; featuredStyle?: string }> = [];

function syncGenAttrCachedDemosValueDisplay(): void {
    const slug = readDemoUrlParam();
    const display = slug ? getBundledGenAttributeDemoLabel(slug) : '';
    if (genAttrCachedDemosValueEl) genAttrCachedDemosValueEl.textContent = display;
    if (genAttrCachedDemosValueBtn) genAttrCachedDemosValueBtn.title = display;
}

genAttrCachedDemosValueBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    genAttrCachedDemosBtn?.click();
});

function refreshGenAttrBundledDemoEntriesList(): void {
    genAttrBundledDemoEntries = [...getBundledGenAttributeDemoList()];
}

const genCachedHistory = initCachedHistoryQueryDropdown({
    dropdownId: 'gen_attr_cached_history_dropdown',
    historyButton: genAttrCachedHistoryBtn,
    clickOutsideRoot: document.getElementById('gen_attr_cached_history_dropdown'),
    listMru: listCachedHistoryRows,
    onSelectEntry: async (contentKey, shouldTouch, ctx) => {
        await restoreGenAttrFromCachedRun(contentKey, Boolean(shouldTouch), ctx);
    },
    onRemove: removeCachedEntryByContentKey,
    onPromote: touchCachedEntryByContentKey,
});

initQueryHistoryDropdown({
    input: null,
    dropdownId: 'gen_attr_cached_demos_dropdown',
    getHistoryEntries: () => genAttrBundledDemoEntries,
    refreshHistoryItems: () => refreshGenAttrBundledDemoEntriesList(),
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: () => {},
    fillInputOnSelect: false,
    onHistorySelect: (slug) => {
        void restoreGenAttrFromDemoSlug(slug);
    },
    historyButton: genAttrCachedDemosBtn,
    applyHistoryOnHover: true,
});

refreshGenAttrBundledDemoEntriesList();
syncGenAttrCachedDemosValueDisplay();

// --- 指标 ---
/** 首步 `token_attribution.length` ≈ 初始 prompt 子词数（与 Chat 展示同形，无需后端 usage） */
function initialPromptTokensFromFirstStep(step: TokenGenStep): number | undefined {
    const n = step.response.token_attribution?.length;
    return typeof n === 'number' && n > 0 ? n : undefined;
}

/** prompt=首步归因条数；completion=已累计生成 token 数 */
function setGenAttrUsageMetric(promptTokens: number | undefined, genCount: number): void {
    if (metricUsage.empty()) return;
    if (typeof promptTokens !== 'number') {
        metricUsage.text('');
        return;
    }
    updateApiUsageDisplay(metricUsage, {
        prompt_tokens: promptTokens,
        completion_tokens: genCount,
        total_tokens: promptTokens + genCount,
    });
}

function showAttributionForStepIndex(idx: number): void {
    const step = runnerHandle?.getStep(idx);
    if (!step) {
        showToast('Step not found', 'error');
        return;
    }
    if (validateMetricsElements(metricModel)) {
        updateModel(metricModel, step.response.model ?? null);
    }
}

void (async () => {
    const demoRaw = readDemoUrlParam();
    const contentRaw = readContentUrlParam();
    if (demoRaw) {
        const applyGen = nextGenAttrCachedApplyGen();
        let applied = false;
        let loadThrew = false;
        try {
            const rec = await fetchBundledGenAttributeDemoBySlug(demoRaw);
            if (!isStaleGenAttrCachedApply(applyGen) && rec && isGenAttrRunPayloadValidForUi(rec)) {
                await applyGenAttrCachedRun(
                    rec,
                    { afterUrl: { kind: 'demo', slug: demoRaw } },
                    applyGen
                );
                if (!isStaleGenAttrCachedApply(applyGen)) {
                    applied = true;
                }
            }
        } catch (e: unknown) {
            if (!isStaleGenAttrCachedApply(applyGen)) {
                loadThrew = true;
                console.error('[causal_flow] ?demo= load failed', e);
                showToast(extractErrorMessage(e, tr('Demo not found')), 'error');
                replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'causal_flow');
            }
        }
        if (applied) {
            return;
        }
        if (!loadThrew && !isStaleGenAttrCachedApply(applyGen)) {
            showToast(tr('Demo not found'), 'error');
            replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'causal_flow');
        }
    }
    await runContentUrlHydrate({
        readRaw: readContentUrlParam,
        fetchEntry: getCachedEntryByContentKey,
        isValid: (rec) => rec.steps.length > 0,
        apply: async (_rec, rawContentKey) => {
            await restoreGenAttrFromCachedRun(rawContentKey, false);
        },
        onMissing: async () => {
            showToast(tr('Cached run not found (link may be expired)'), 'error');
            replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'causal_flow');
            replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'causal_flow');
        },
        onApplyError: (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            showToast(msg, 'error');
            replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'causal_flow');
            replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'causal_flow');
        },
    });
    // 无任何 URL 参数时，静默恢复最近一次缓存 run（输入框与 DAG 一并还原）
    if (!demoRaw && !contentRaw) {
        const rows = await listCachedHistoryRows();
        if (rows.length > 0) {
            await restoreGenAttrFromCachedRun(rows[0]!.contentKey, false);
        }
    }
})();

async function resolveInitialContext(signal: AbortSignal): Promise<string> {
    if (isSkipChatTemplate()) {
        return (rawTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    }
    const user = (userTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    const useSystem = isGenAttrUseSystemPrompt();
    const systemRaw = (systemTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    const messages: {
        role: 'system' | 'user';
        content: string;
    }[] = [];
    if (useSystem) {
        messages.push({ role: 'system', content: systemRaw });
    }
    messages.push({ role: 'user', content: user });
    const assembled = await postCompletionsPrompt(
        {
            model: currentModelVariant(),
            messages,
            tools: isToolCallingEnabled()
                ? toolConfigToolsSchema(getCurrentToolConfig())
                : undefined,
            enable_thinking: isEnableThinking() ? true : undefined,
        },
        { signal }
    );
    return assembled.prompt_used;
}

async function autoMoveFirstTeacherForcingTokenToPromptIfNeeded(): Promise<void> {
    if (!isSkipChatTemplate()) return;
    if (getActivePromptValue().length > 0) return;
    const forcing = teacherForcingContinuationForRun();
    if (forcing === undefined) return;

    const spans = await fetchTokenize(apiBaseForRequests, forcing, currentModelVariant());
    if (!spans.length) {
        throw new Error('Teacher forcing tokenize returned empty spans.');
    }
    const first = spans[0]!;
    const [start, end] = first.offset;
    const chars = Array.from(forcing);
    if (start < 0 || end <= start || end > chars.length) {
        throw new Error(
            `Teacher forcing tokenize returned invalid first span [${start}, ${end}) for continuation.`
        );
    }
    const movedPrompt = chars.slice(start, end).join('');
    const remainingForcing = chars.slice(end).join('');

    setActivePromptValue(movedPrompt);
    teacherForcingTextField.property('value', remainingForcing);
    teacherForcingTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
}

function buildGenAttrCacheKeyForRun(params: {
    initialContext: string;
    model: string;
    maxTokens: number;
    teacherForcingText?: string;
    stopAfterTF: boolean;
    multiTurn: boolean;
}): GenAttrCacheKey {
    return {
        initialContext: params.initialContext,
        model: params.model,
        maxTokens: params.maxTokens,
        ...(params.teacherForcingText !== undefined
            ? {
                  teacherForcing: params.teacherForcingText,
                  stopAfterTeacherForcing: params.stopAfterTF,
              }
            : {}),
        ...toolConfigCacheKeyFields(params.multiTurn, getCurrentToolConfig()),
    };
}

function persistGenAttrRunToCache(
    reason: CompletionFinishReason,
    stepsToStore: TokenGenStep[],
    cacheKey: GenAttrCacheKey,
    runDraft: GenAttrRunDraft,
): void {
    if (stepsToStore.length < 1) return;
    const cacheStatus: 'partial' | 'complete' =
        reason === 'stop' || reason === 'length' ? 'complete' : 'partial';
    void save(cacheKey, stepsToStore, currentRunPromptSpans, cacheStatus, reason, runDraft)
        .then(({ contentKey }) => genCachedHistory.refreshList().then(() => contentKey))
        .then((contentKey) => syncGenAttrContentUrl(contentKey))
        .catch((e) => console.warn('[causal_flow] save cached run failed:', e));
}

function finishAttributionRun(
    reason: CompletionFinishReason,
    stepsToStore: TokenGenStep[],
    cacheKey: GenAttrCacheKey,
    runDraft: GenAttrRunDraft,
): void {
    genAbort = null;
    multiTurnAttributionHandle = null;
    toolCallingPendingLine?.hide();
    setGenLoading(false);
    lastRunCompletionReason = reason;
    if (stepsToStore.length >= 1) {
        runnerHandle = createHydratedTokenGenHandle(stepsToStore);
        persistGenAttrRunToCache(reason, stepsToStore, cacheKey, runDraft);
    }
    completeReasonEl.text(completionFinishReasonLabel(reason));
    scheduleDagLastTokenDwell(() => {
        dagHandle.clearNodeSelection();
    });
}

async function runGeneration(): Promise<void> {
    if (inFlight || !isInputReadyForRun()) return;
    if (!isSkipChatTemplate() && isToolCallingEnabled() && !isToolCallingConfigReady()) {
        showAlertDialog(
            tr('LLM Causal Flow'),
            tr('When Tool use is on, configure at least one tool in Config tools.'),
        );
        return;
    }

    genAbort?.abort();
    multiTurnAttributionHandle?.abort();
    genAbort = new AbortController();
    const { signal } = genAbort;

    stopDagPlayback();
    dagPlaybackNextIndex = 0;
    dagPlaybackPausedMidRun = false;

    setGenLoading(true);
    toolCallingPendingLine?.hide();
    runnerHandle = null;
    multiTurnAttributionHandle = null;
    lastRunInitialContext = '';
    lastRunInputSnapshot = null;
    lastRunCompletionReason = null;
    completeReasonEl.text('');

    let initialContext = '';

    try {
        await autoMoveFirstTeacherForcingTokenToPromptIfNeeded();
        const teacherForcingText = teacherForcingContinuationForRun();
        const stopAfterTF = isStopAfterTeacherForcingOn();
        const maxTokens = currentMaxTokens();
        const tokenizeModel = currentModelVariant();
        const runDraft = buildGenAttrRunDraftForCache();
        const multiTurn = useMultiTurnAttribution();
        const prompt = getActivePromptValue();
        initialContext = await resolveInitialContext(signal);
        lastRunInitialContext = initialContext;
        lastRunInputSnapshot = getInputSnapshotForRun();

        if (isSkipChatTemplate()) {
            saveHistory(prompt, GEN_ATTR_RAW_INPUT_HISTORY_KEY);
        } else {
            saveHistory(prompt, GEN_ATTR_USER_INPUT_HISTORY_KEY);
            if (isGenAttrUseSystemPrompt()) {
                const systemForHistory =
                    (systemTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
                if (systemForHistory.length > 0) {
                    saveHistory(systemForHistory, GEN_ATTR_SYSTEM_INPUT_HISTORY_KEY);
                }
            }
        }
        if (teacherForcingText !== undefined) {
            saveHistory(teacherForcingText, GEN_ATTR_TEACHER_FORCING_INPUT_HISTORY_KEY);
        }

        let initialPromptTokens: number | undefined;
        const allSteps: TokenGenStep[] = [];
        currentRunPromptSpans = [];
        initialPromptInputSpans = [];
        setGenAttrUsageMetric(undefined, 0);

        const cacheKey = buildGenAttrCacheKeyForRun({
            initialContext,
            model: tokenizeModel,
            maxTokens,
            teacherForcingText,
            stopAfterTF,
            multiTurn,
        });
        const flowId = createFlowId();

        const onAttributionStep = (step: TokenGenStep, stepIndex: number): void => {
            if (stepIndex === 0) {
                initialPromptTokens = initialPromptTokensFromFirstStep(step);
                if (currentRunPromptSpans.length === 0) {
                    const fallbackSpans = extractPromptTokenSpans(step);
                    currentRunPromptSpans = fallbackSpans;
                    if (initialPromptInputSpans.length === 0) {
                        initialPromptInputSpans = fallbackSpans;
                    }
                }
            }
            const excludeCtx = step.context + step.token;
            pushDagFromPreprocess(step, stepIndex, true, excludeCtx);
            dagPlaybackNextIndex = stepIndex + 1;
            setGenAttrUsageMetric(initialPromptTokens, stepIndex + 1);
            showAttributionForStepIndex(stepIndex);
        };

        dagHandle.reset();
        const tokenizeText = initialContext;
        void fetchTokenize(apiBaseForRequests, tokenizeText, tokenizeModel)
            .then((spans) => {
                initialPromptInputSpans = spans;
                // 仅在 onAttributionStep / onInputSpansAppended 尚未更新时设为初始值；
                // 避免多轮场景下 tokenize 延迟返回时覆盖 tool response spans。
                if (currentRunPromptSpans.length === 0) {
                    currentRunPromptSpans = spans;
                }
                if (spans.length > 0) {
                    syncDagInputLayerAtStep({
                        catalogSpans: spans,
                        layoutWire: tokenizeText,
                        inputRanges: [[0, tokenizeText.length]],
                        fitViewport: true,
                    });
                }
            })
            .catch(() => {
                /* 失败静默，step 0 回调兜底 */
            });

        if (multiTurn) {
            multiTurnAttributionHandle = runMultiTurnAttribution({
                apiPrefix: apiBaseForRequests,
                model: tokenizeModel,
                maxTokens,
                initialContext,
                teacherForcing: teacherForcingText,
                toolConfig: getCurrentToolConfig(),
                enableThinking: isEnableThinking(),
                flowId,
                signal,
                onStep(step) {
                    allSteps.push(step);
                    runnerHandle = createHydratedTokenGenHandle(allSteps);
                    onAttributionStep(step, allSteps.length - 1);
                },
                getPromptInputSpans: () => initialPromptInputSpans,
                onInputSpansAppended(allInputSpans, fullWire, inputRanges) {
                    currentRunPromptSpans = allInputSpans;
                    syncDagInputLayerAtStep({
                        catalogSpans: allInputSpans,
                        layoutWire: fullWire,
                        inputRanges,
                        fitViewport: true,
                    });
                },
                mockToolGapUi: toolCallingPendingLine,
                onAllComplete(reason) {
                    finishAttributionRun(reason, allSteps, cacheKey, runDraft);
                },
                onError(err) {
                    showToast(err.message, 'error');
                },
            });
            return;
        }

        runnerHandle = startTokenGenAttribution({
            initialContext,
            apiPrefix: apiBaseForRequests,
            model: tokenizeModel,
            maxTokens,
            flowId,
            teacherForcingContinuation: teacherForcingText,
            stopAfterTeacherForcing: stopAfterTF,
            onStep(step, stepIndex) {
                allSteps.push(step);
                onAttributionStep(step, stepIndex);
            },
            onComplete(reason) {
                finishAttributionRun(reason, allSteps, cacheKey, runDraft);
            },
            onError(err) {
                showToast(err.message, 'error');
            },
        });
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') {
            setGenLoading(false);
            genAbort = null;
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        showAlertDialog('Generate & Attribute', msg);
        setGenLoading(false);
        genAbort = null;
    }
}

submitBtn.on('click', () => {
    if (inFlight) {
        postCompletionsStop();
        genAbort?.abort();
        runnerHandle?.abort();
        multiTurnAttributionHandle?.abort();
        return;
    }
    void runGeneration();
});

[rawTextarea, userPromptTextarea, teacherForcingTextarea].forEach((el) => {
    el?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void runGeneration();
    });
});

function refreshDagForThemeChange(): void {
    stopDagPlayback();
    const h = runnerHandle;
    if (!h || h.tokenCount === 0) return;
    tryResetAndReplayDag({ refit: false });
}

const themeManager = initThemeManager(
    {
        onThemeChange: () => {
            refreshDagForThemeChange();
        },
    },
    '#theme_dropdown'
);

const languageManager = initLanguageManager({}, '#language_dropdown');

void new SettingsMenuManager(
    '#settings_btn',
    '#settings_menu',
    '#admin_mode_btn',
    adminManager,
    api,
    undefined,
    undefined,
    themeManager,
    languageManager,
    'common'
);

const exportDemoBtn = document.getElementById('gen_attr_export_demo_btn');
function syncGenAttrExportDemoBtn(): void {
    if (!exportDemoBtn) return;
    exportDemoBtn.style.display = adminManager.isInAdminMode() ? '' : 'none';
}
function syncGenAttrAdminUi(): void {
    syncGenAttrExportDemoBtn();
    syncMaxTokensUi();
    normalizeGenAttrMaxTokensField();
}
syncGenAttrAdminUi();
adminManager.onAdminModeChange(() => syncGenAttrAdminUi());
exportDemoBtn?.addEventListener('click', () => {
    void (async () => {
        const h = runnerHandle;
        const ic = lastRunInitialContext;
        if (!h || !ic || h.tokenCount < 1) {
            showToast(tr('No run to export'), 'error');
            return;
        }
        await autoMoveFirstTeacherForcingTokenToPromptIfNeeded();
        try {
            const payload = buildGenAttrExportedDemoPayload({
                initialContext: ic,
                steps: h.getAllSteps(),
                promptSpans: currentRunPromptSpans,
                completionReason: lastRunCompletionReason ?? undefined,
                draft: buildGenAttrRunDraftForCache(),
                demoUiOptions: readGenAttrDemoUiOptionsFromControls(),
            });
            void exportJsonFile(payload, `genattr-${Date.now()}.json`);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            showToast(msg, 'error');
        }
    })();
});

initChatPanelLayout({ storageKey: PANEL_SPLIT_STORAGE_KEY_GEN_ATTRIBUTE });
