import * as d3 from 'd3';
import './utils/d3-polyfill';
import '../css/start.scss';
import '../css/chat.scss';
import '../css/gen_attribute.scss';

import { initThemeManager } from './ui/theme';
import { initLanguageManager } from './ui/language';
import { initI18n, tr } from './lang/i18n-lite';
import { AdminManager } from './utils/adminManager';
import { SettingsMenuManager } from './utils/settingsMenuManager';
import { initChatPanelLayout } from './chat/chatPanelLayout';
import { PANEL_SPLIT_STORAGE_KEY_GEN_ATTRIBUTE } from './utils/panelSplitStorage';
import { TextInputController } from './controllers/textInputController';
import { initializeCommonApp } from './appInitializer';
import { setPageOptsGetter } from './utils/clientActivityPing';
import { showAlertDialog } from './ui/dialog';
import URLHandler from './utils/URLHandler';
import { createToast } from './ui/toast';
import type { PredictionAttributeModelVariant } from './attribution/attributionResultCache';
import {
    clampDagEdgeTopPCoverage,
    DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
    extractPromptTokenSpans,
    type PromptTokenSpan,
} from './attribution/genAttributeDagPreprocess';
import {
    initGenAttributeDagView,
    setDagNodeCiVisualScaleEnabled,
    setDagDecayAttributionToHighSurprisalTargetEnabled,
    type DagLayoutMode,
    clampDagCompactness,
    clampLinearArcAdjacentGap,
    DAG_COMPACTNESS_DEFAULT,
    LINEAR_ARC_ADJACENT_GAP_DEFAULT,
} from './attribution/genAttributeDagView';
import {
    createHydratedTokenGenHandle,
    startTokenGenAttribution,
    TOKEN_GEN_MAX_TOKENS_DEFAULT,
    type TokenGenAttributionHandle,
    type TokenGenStep,
} from './attribution/tokenGenAttributionRunner';
import { fetchTokenize } from './attribution/predictionAttributeClient';
import { completionFinishReasonLabel, type CompletionFinishReason } from './utils/generationEndReasonLabel';
import {
    buildCachedContentUrlParam,
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
} from './storage/genAttributeRunCache';
import {
    DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT,
    DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
} from './attribution/attributionExcludePromptPatternsStorage';
import { initCachedHistoryQueryDropdown, type CachedHistorySelectContext } from './utils/cachedHistoryUi';
import {
    DEFAULT_CONTENT_URL_PARAM,
    DEFAULT_DEMO_URL_PARAM,
    readContentUrlParam,
    readDemoUrlParam,
    replaceContentUrlParam,
    replaceDemoUrlParam,
    runContentUrlHydrate,
} from './utils/contentUrl';
import {
    fetchBundledGenAttributeDemoBySlug,
    getBundledGenAttributeDemoList,
    isGenAttrRunPayloadValidForUi,
} from './demos/genAttributeBundledDemos';
import { extractErrorMessage } from './utils/errorUtils';
import { exportJsonFile } from './storage/localFileIO';
import {
    GEN_ATTR_RAW_INPUT_HISTORY_KEY,
    GEN_ATTR_SYSTEM_INPUT_HISTORY_KEY,
    GEN_ATTR_TEACHER_FORCING_INPUT_HISTORY_KEY,
    GEN_ATTR_USER_INPUT_HISTORY_KEY,
    initQueryHistoryDropdown,
    saveHistory,
} from './utils/queryHistory';
import {
    readSkipChatTemplateFromStorage,
    writeSkipChatTemplateToStorage,
} from './utils/chatPromptTemplateMode';
import { postCompletionsPrompt, postCompletionsStop } from './api/completionsClient';
import { updateApiUsageDisplay, updateModel, validateMetricsElements } from './utils/textMetricsUpdater';

d3.selectAll('.loadersmall').style('display', 'none');

initI18n();

const showToast = createToast('#toast').show;

const GEN_ATTR_MODEL_VARIANT_STORAGE_KEY = 'info_radar_gen_attr_model_variant';
const GEN_ATTR_MAX_TOKENS_STORAGE_KEY = 'info_radar_gen_attr_max_tokens';
const GEN_ATTR_MAX_TOKENS_DEFAULT = TOKEN_GEN_MAX_TOKENS_DEFAULT;
const GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY = 'info_radar_gen_attr_dag_measure_width';
const GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY = 'info_radar_gen_attr_dag_layout_mode';
const GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY = 'info_radar_gen_attr_dag_playback_step_ms';
const GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY = 'info_radar_gen_attr_dag_replay_pacing_mode';
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
const GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY = 'info_radar_gen_attr_dag_hide_excluded_tokens';
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

/** 与无 demoUiOptions 本地缓存时「读出默认」对齐，供重置与可读性单一的来源 */
const DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS: GenAttrDemoUiOptions = {
    layoutMode: 'text-flow',
    measureWidthPx: GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT,
    dagCompactness: DAG_COMPACTNESS_DEFAULT,
    linearArcAdjacentGapPx: LINEAR_ARC_ADJACENT_GAP_DEFAULT,
    hideExcludedTokens: false,
    edgeTopPCoverage: DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
    nodeCiVisualScaleEnabled: true,
    decayAttributionToHighSurprisalTargetEnabled: true,
    hideInactiveEdges: false,
    showDownstreamInfluence: false,
    recursiveAttributionEnabled: false,
    showTokenInfoOnSelected: false,
    replayPacingMode: 'total',
    playbackTotalS: GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT,
    playbackStepMs: GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT,
    excludePromptPatternsEnabled: true,
    excludePromptPatternsText: DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
    excludeGeneratedPatternsEnabled: true,
    excludeGeneratedPatternsText: DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT,
};

const GENERATE_BTN_LABEL = 'Start';
const STOP_BTN_LABEL = 'Stop';

function createFlowId(): string {
    const timePart = Date.now().toString(36).slice(-6);
    const randPart = Math.random().toString(36).slice(2, 6);
    return `${timePart}-${randPart}`;
}

function readStoredModelVariant(): PredictionAttributeModelVariant {
    try {
        const v = localStorage.getItem(GEN_ATTR_MODEL_VARIANT_STORAGE_KEY);
        if (v === 'base' || v === 'instruct') return v;
    } catch {
        // ignore
    }
    return 'instruct';
}

function readStoredMaxTokens(): number {
    try {
        const v = localStorage.getItem(GEN_ATTR_MAX_TOKENS_STORAGE_KEY);
        const n = v !== null ? parseInt(v, 10) : NaN;
        if (Number.isFinite(n) && n >= 1 && n <= 500) return n;
    } catch {
        // ignore
    }
    return GEN_ATTR_MAX_TOKENS_DEFAULT;
}

function clampDagMeasureWidth(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_MEASURE_WIDTH_MIN,
        Math.min(GEN_ATTR_DAG_MEASURE_WIDTH_MAX, Math.round(n))
    );
}

function readStoredDagMeasureWidth(): number {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY);
        const n = v !== null ? parseInt(v, 10) : NaN;
        if (Number.isFinite(n)) return clampDagMeasureWidth(n);
    } catch {
        // ignore
    }
    return GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT;
}

function readStoredDagCompactness(): number {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY);
        const n = v !== null ? parseFloat(v) : NaN;
        if (Number.isFinite(n)) return clampDagCompactness(n);
    } catch {
        // ignore
    }
    return DAG_COMPACTNESS_DEFAULT;
}

function readStoredDagEdgeTopPCoverage(): number {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY);
        const n = v !== null ? parseFloat(v) : NaN;
        if (Number.isFinite(n)) return clampDagEdgeTopPCoverage(n);
    } catch {
        // ignore
    }
    return DAG_EDGE_TOP_P_COVERAGE_DEFAULT;
}

function readStoredDagLinearArcAdjacentGap(): number {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY);
        const n = v !== null ? parseInt(v, 10) : NaN;
        if (Number.isFinite(n)) return clampLinearArcAdjacentGap(n);
    } catch {
        // ignore
    }
    return LINEAR_ARC_ADJACENT_GAP_DEFAULT;
}

function clampDagPlaybackStepMs(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_PLAYBACK_STEP_MS_MIN,
        Math.min(GEN_ATTR_DAG_PLAYBACK_STEP_MS_MAX, Math.round(n))
    );
}

function readStoredDagPlaybackStepMs(): number {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY);
        const n = v !== null ? parseInt(v, 10) : NaN;
        if (Number.isFinite(n)) return clampDagPlaybackStepMs(n);
    } catch {
        // ignore
    }
    return GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT;
}

function clampDagPlaybackTotalS(n: number): number {
    return Math.max(
        GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MIN,
        Math.min(GEN_ATTR_DAG_PLAYBACK_TOTAL_S_MAX, Math.round(n))
    );
}

function readStoredDagPlaybackTotalS(): number {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY);
        const n = v !== null ? parseInt(v, 10) : NaN;
        if (Number.isFinite(n)) return clampDagPlaybackTotalS(n);
    } catch {
        // ignore
    }
    return GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT;
}

function readStoredDagReplayPacingMode(): DagReplayPacingMode {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY);
        if (v === 'total' || v === 'step') return v;
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.replayPacingMode;
}

function readStoredDagLayoutMode(): DagLayoutMode {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY);
        if (
            v === 'text-flow' ||
            v === 'linear-arc' ||
            v === 'linear-arc-step-down' ||
            v === 'spiral'
        ) {
            return v;
        }
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.layoutMode;
}

const apiPrefix = URLHandler.parameters['api'] || '';
const bodyElement = d3.select('body').node() as Element;
const { totalSurprisalFormat, api } = initializeCommonApp(apiPrefix, bodyElement);
const apiBaseForRequests = apiPrefix === '' ? '' : String(apiPrefix);

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

const submitBtn = d3.select('#gen_attr_submit_btn');
const loaderSmall = d3.select('.loadersmall');
const analyzeProgressEl = d3.select('#gen_attr_analyze_progress');
const metricUsage = d3.select('#gen_attr_metric_usage');
const metricModel = d3.select('#gen_attr_metric_model');
const genAttrResultsEl = d3.select('#results.gen-attr-results-surface');

const modelVariantSelect = document.getElementById('gen_attr_model_variant') as HTMLSelectElement | null;
const maxTokensInput = document.getElementById('gen_attr_max_tokens') as HTMLInputElement | null;
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

/** 与 `#gen_attr_dag_replay_mode` 同步；非法或缺失时视为 `total`。 */
function currentDagReplayPacingMode(): DagReplayPacingMode {
    return dagReplayModeSelect?.value === 'step' ? 'step' : 'total';
}

/** 切换下拉时更新 `hidden`；样式见 `.gen-attr-dag-replay-value-wrap:not([hidden])`。 */
function applyDagReplaySpeedUi(): void {
    const mode = currentDagReplayPacingMode();
    if (dagReplayTotalWrap) dagReplayTotalWrap.hidden = mode !== 'total';
    if (dagReplayStepWrap) dagReplayStepWrap.hidden = mode !== 'step';
}

function currentDagLayoutMode(): DagLayoutMode {
    const v = dagLayoutModeSelect?.value;
    if (v === 'linear-arc' || v === 'linear-arc-step-down' || v === 'spiral') return v;
    return 'text-flow';
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

function syncGenAttrExcludePatternTextareasDisabled(): void {
    if (genAttrExcludePromptPatternsTa) {
        genAttrExcludePromptPatternsTa.disabled = !genAttrExcludePromptPatternsEnable?.checked;
    }
    if (genAttrExcludeGeneratedPatternsTa) {
        genAttrExcludeGeneratedPatternsTa.disabled = !genAttrExcludeGeneratedPatternsEnable?.checked;
    }
}

function hydrateGenAttrExcludePatternsFromGenAttrStorage(): void {
    try {
        const savedPrompt = localStorage.getItem(GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY);
        if (genAttrExcludePromptPatternsTa) {
            genAttrExcludePromptPatternsTa.value =
                savedPrompt !== null ? savedPrompt : DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT;
        }
        const promptEnRaw = localStorage.getItem(GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY);
        if (genAttrExcludePromptPatternsEnable) {
            genAttrExcludePromptPatternsEnable.checked = promptEnRaw === null ? true : promptEnRaw === '1';
        }

        const savedGen = localStorage.getItem(GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY);
        if (genAttrExcludeGeneratedPatternsTa) {
            genAttrExcludeGeneratedPatternsTa.value =
                savedGen !== null ? savedGen : DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT;
        }
        const genEnRaw = localStorage.getItem(GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY);
        if (genAttrExcludeGeneratedPatternsEnable) {
            genAttrExcludeGeneratedPatternsEnable.checked = genEnRaw === null ? true : genEnRaw === '1';
        }
    } catch {
        /* ignore */
    }
    syncGenAttrExcludePatternTextareasDisabled();
}

hydrateGenAttrExcludePatternsFromGenAttrStorage();

/** 与 DAG 同源：DAG 预处理按当前控件即时读取，不读 Attribution 的 localStorage。 */
function genAttrEffectiveExcludePromptPatternsText(): string {
    if (!genAttrExcludePromptPatternsEnable?.checked) return '';
    return genAttrExcludePromptPatternsTa?.value ?? '';
}

function genAttrEffectiveExcludeGeneratedPatternsText(): string {
    if (!genAttrExcludeGeneratedPatternsEnable?.checked) return '';
    return genAttrExcludeGeneratedPatternsTa?.value ?? '';
}

if (modelVariantSelect) modelVariantSelect.value = readStoredModelVariant();
if (maxTokensInput) maxTokensInput.value = String(readStoredMaxTokens());
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
if (dagPlaybackTotalSInput) dagPlaybackTotalSInput.value = String(initialDagPlaybackTotalS);
applyDagReplaySpeedUi();

const genAttrResultsNode = genAttrResultsEl.node() as HTMLElement | null;
function readStoredDagNodeCiVisualScale(): boolean {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY);
        if (v !== null) return v === '1';
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.nodeCiVisualScaleEnabled;
}
const initialDagNodeCiVisualScale = readStoredDagNodeCiVisualScale();
if (dagNodeCiVisualScaleInput) dagNodeCiVisualScaleInput.checked = initialDagNodeCiVisualScale;
setDagNodeCiVisualScaleEnabled(initialDagNodeCiVisualScale);
dagNodeCiVisualScaleInput?.addEventListener('change', () => {
    const enabled = dagNodeCiVisualScaleInput.checked;
    try {
        localStorage.setItem(GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
        /* ignore */
    }
    setDagNodeCiVisualScaleEnabled(enabled);
    tryResetAndReplayDag();
});

function readStoredDagDecayAttributionToHighSurprisalTarget(): boolean {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY);
        if (v !== null) return v === '1';
        const legacy = localStorage.getItem(GEN_ATTR_DAG_EDGE_WEAKEN_HIGH_SURPRISAL_STORAGE_KEY_LEGACY);
        if (legacy !== null) return legacy === '1';
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.decayAttributionToHighSurprisalTargetEnabled;
}
const initialDagDecayAttributionHighSurprisal = readStoredDagDecayAttributionToHighSurprisalTarget();
if (dagDecayAttributionHighSurprisalInput) {
    dagDecayAttributionHighSurprisalInput.checked = initialDagDecayAttributionHighSurprisal;
}
setDagDecayAttributionToHighSurprisalTargetEnabled(initialDagDecayAttributionHighSurprisal);
dagDecayAttributionHighSurprisalInput?.addEventListener('change', () => {
    const enabled = dagDecayAttributionHighSurprisalInput.checked;
    try {
        localStorage.setItem(GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
        /* ignore */
    }
    setDagDecayAttributionToHighSurprisalTargetEnabled(enabled);
    tryResetAndReplayDag();
});

function applyDagHideInactiveEdges(hide: boolean): void {
    if (!genAttrResultsNode) return;
    genAttrResultsNode.classList.toggle('gen-attr-dag-hide-inactive-edges', hide);
}
function readStoredDagHideInactiveEdges(): boolean {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY);
        if (v !== null) return v === '1';
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.hideInactiveEdges;
}
const initialDagHideInactiveEdges = readStoredDagHideInactiveEdges();
if (dagHideInactiveEdgesInput) dagHideInactiveEdgesInput.checked = initialDagHideInactiveEdges;
applyDagHideInactiveEdges(initialDagHideInactiveEdges);
dagHideInactiveEdgesInput?.addEventListener('change', () => {
    const hide = dagHideInactiveEdgesInput.checked;
    try {
        localStorage.setItem(GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY, hide ? '1' : '0');
    } catch {
        /* ignore */
    }
    applyDagHideInactiveEdges(hide);
});

function readStoredDagShowDownstreamInfluence(): boolean {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY);
        if (v !== null) return v === '1';
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.showDownstreamInfluence;
}
const initialDagShowDownstreamInfluence = readStoredDagShowDownstreamInfluence();
if (dagShowDownstreamInfluenceInput) {
    dagShowDownstreamInfluenceInput.checked = initialDagShowDownstreamInfluence;
}
dagShowDownstreamInfluenceInput?.addEventListener('change', () => {
    const show = dagShowDownstreamInfluenceInput.checked;
    try {
        localStorage.setItem(GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY, show ? '1' : '0');
    } catch {
        /* ignore */
    }
    dagHandle.setShowDownstreamInfluence(show);
});

/** 传播归因（UI: Propagated attribution mode；`recursiveAttributionEnabled`）开启时隐藏 downstream influence 选项（该模式仅展示上游链）。 */
function applyDagDownstreamInfluenceUi(): void {
    const recursive = dagRecursiveAttributionInput?.checked ?? false;
    if (dagShowDownstreamInfluenceGroup) {
        dagShowDownstreamInfluenceGroup.hidden = recursive;
    }
}

function readStoredDagRecursiveAttribution(): boolean {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY);
        if (v !== null) return v === '1';
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.recursiveAttributionEnabled;
}
const initialDagRecursiveAttribution = readStoredDagRecursiveAttribution();
if (dagRecursiveAttributionInput) dagRecursiveAttributionInput.checked = initialDagRecursiveAttribution;
applyDagDownstreamInfluenceUi();
dagRecursiveAttributionInput?.addEventListener('change', () => {
    const enabled = dagRecursiveAttributionInput.checked;
    try {
        localStorage.setItem(GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY, enabled ? '1' : '0');
    } catch {
        /* ignore */
    }
    applyDagDownstreamInfluenceUi();
    dagHandle.setRecursiveAttributionEnabled(enabled);
});

function readStoredDagHideExcludedTokens(): boolean {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY);
        if (v !== null) return v === '1';
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.hideExcludedTokens;
}
const initialDagHideExcludedTokens = readStoredDagHideExcludedTokens();
if (dagHideExcludedTokensInput) dagHideExcludedTokensInput.checked = initialDagHideExcludedTokens;
function readStoredDagShowTopkOnSelected(): boolean {
    try {
        const v = localStorage.getItem(GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY);
        if (v !== null) return v === '1';
    } catch {
        // ignore
    }
    return DEFAULT_GEN_ATTR_DEMO_UI_OPTIONS.showTokenInfoOnSelected;
}
const initialDagShowTopkOnSelected = readStoredDagShowTopkOnSelected();
if (dagShowTopkOnSelectedInput) dagShowTopkOnSelectedInput.checked = initialDagShowTopkOnSelected;
dagHideExcludedTokensInput?.addEventListener('change', () => {
    const hide = dagHideExcludedTokensInput.checked;
    try {
        localStorage.setItem(GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY, hide ? '1' : '0');
    } catch {
        /* ignore */
    }
    dagHandle.setHideExcludedTokens(hide);
});

dagShowTopkOnSelectedInput?.addEventListener('change', () => {
    const show = dagShowTopkOnSelectedInput.checked;
    try {
        localStorage.setItem(GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY, show ? '1' : '0');
    } catch {
        /* ignore */
    }
    dagHandle.setShowTokenInfoOnSelected(show);
});

setPageOptsGetter(() => {
    const mode = currentDagLayoutMode();
    return {
        layout_linear_arc: mode === 'linear-arc',
        layout_step_down: mode === 'linear-arc-step-down',
        layout_spiral: mode === 'spiral',
        propagated: dagRecursiveAttributionInput?.checked ?? false,
        downstream: dagShowDownstreamInfluenceInput?.checked ?? false,
        token_tooltip: dagShowTopkOnSelectedInput?.checked ?? false,
    };
});

modelVariantSelect?.addEventListener('change', () => {
    try {
        localStorage.setItem(GEN_ATTR_MODEL_VARIANT_STORAGE_KEY, currentModelVariant());
    } catch {
        /* ignore */
    }
    syncIdleModelMetric();
    syncSubmitButtonState();
});

maxTokensInput?.addEventListener('change', () => {
    try {
        localStorage.setItem(
            GEN_ATTR_MAX_TOKENS_STORAGE_KEY,
            maxTokensInput?.value ?? String(GEN_ATTR_MAX_TOKENS_DEFAULT)
        );
    } catch {
        /* ignore */
    }
    syncSubmitButtonState();
});

// DAG 回放节奏（与上节「DAG 测量宽度」无关；宽度 listener 在后文）
dagPlaybackStepMsInput?.addEventListener('change', () => {
    const raw = parseInt(dagPlaybackStepMsInput.value, 10);
    const ms = Number.isFinite(raw)
        ? clampDagPlaybackStepMs(raw)
        : GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT;
    dagPlaybackStepMsInput.value = String(ms);
    try {
        localStorage.setItem(GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY, String(ms));
    } catch {
        /* ignore */
    }
});

dagReplayModeSelect?.addEventListener('change', () => {
    const mode = currentDagReplayPacingMode();
    try {
        localStorage.setItem(GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY, mode);
    } catch {
        /* ignore */
    }
    applyDagReplaySpeedUi();
});

dagPlaybackTotalSInput?.addEventListener('change', () => {
    const raw = parseInt(dagPlaybackTotalSInput.value, 10);
    const s = Number.isFinite(raw)
        ? clampDagPlaybackTotalS(raw)
        : GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT;
    dagPlaybackTotalSInput.value = String(s);
    try {
        localStorage.setItem(GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY, String(s));
    } catch {
        /* ignore */
    }
});

function isSkipChatTemplate(): boolean {
    return skipChatTemplateInput?.checked ?? false;
}

function isGenAttrUseSystemPrompt(): boolean {
    return genAttrUseSystemPromptInput?.checked ?? true;
}

function syncGenAttrSystemPromptSuppressedUi(): void {
    const on = isGenAttrUseSystemPrompt();
    genAttrSystemPromptPanel?.classList.toggle('chat-system-prompt-suppressed', !on);
    const ta = systemTextField.node() as HTMLTextAreaElement | null;
    if (ta) {
        ta.disabled = !on;
    }
    const dis = !on;
    clearSystemBtn.property('disabled', dis);
    pasteSystemBtn.property('disabled', dis);
    if (systemHistoryBtn instanceof HTMLButtonElement) {
        systemHistoryBtn.disabled = dis;
    }
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

/** 与 DAG 节点 offset 同源的累积串，供跨 token 闭合后的排除区间（`excludeNodeAggregatedEntries`）。 */
function excludeIntervalContextFromSteps(steps: TokenGenStep[]): string | undefined {
    if (steps.length === 0) return undefined;
    const last = steps[steps.length - 1]!;
    return last.context + last.token;
}

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

/** 下一步要 `pushDagFromPreprocess` 的步下标；与当前 DAG 前缀一致（暂停不重置） */
let dagPlaybackNextIndex = 0;

/**
 * 当前 run 的 prompt token spans：tokenize 先行写入，或 step 0 归因兜底，或历史加载时赋值。
 * 步进回放从头开始时作为 prompt 帧数据源，独立于 token_attribution 完整性。
 */
let currentRunPromptSpans: PromptTokenSpan[] = [];

/**
 * 将 handle 中已存步序按序重放进 DAG（调用方负责先 {@link dagHandle.reset} 等）。
 * @param promptSpans prompt 层节点数据；在批内最先注入，与归因裁剪无关。
 *   未传入时从 step 0 归因降级（旧缓存 / 非生成路径兼容）。
 */
function replayRunnerStepsIntoDag(h: TokenGenAttributionHandle, promptSpans?: PromptTokenSpan[]): void {
    if (h.tokenCount === 0) {
        dagPlaybackNextIndex = 0;
        return;
    }
    const steps = h.getAllSteps();
    const spans = promptSpans ?? extractPromptTokenSpans(steps[0]!);
    const excludeCtx = excludeIntervalContextFromSteps(steps);
    // 整段回放期间中间帧不可见：批处理内只维护图数据，结束时统一刷一次 svg。
    dagHandle.beginBatch();
    try {
        dagHandle.setPromptTokenSpans(spans, steps[0]!.context);
        steps.forEach((step, i) => {
            pushDagFromPreprocess(step, i, true, excludeCtx);
        });
    } finally {
        dagHandle.endBatch();
    }
    dagPlaybackNextIndex = h.tokenCount;
}

/** 实际生成结束与 DAG 回放结束时：末 token 选中再保留多久后执行收尾（清选中等） */
const DAG_LAST_TOKEN_DWELL_MS = 500;

let dagPlaybackTimer: ReturnType<typeof setTimeout> | null = null;
let dagLastTokenDwellTimer: ReturnType<typeof setTimeout> | null = null;

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
function scheduleDagLastTokenDwell(action: () => void, dwellMs: number = DAG_LAST_TOKEN_DWELL_MS): void {
    cancelDagLastTokenDwell();
    dagLastTokenDwellTimer = setTimeout(() => {
        dagLastTokenDwellTimer = null;
        action();
    }, dwellMs);
}

/**
 * 点击播放时：读界面值并写回规范化结果，得到本轮「相邻两帧 DAG 更新」之间的延时（ms）。
 * - `step`：固定间隔。
 * - `total`：`totalS` 按**整段帧数（含 prompt 帧）**均分，共 `fullStepCount` 段等权间隔。
 *   `fullStepCount` 即生成 token 步数；prompt 帧 → step0 占一段，step0 → step1 占一段，依此类推。
 */
function resolveDagPlaybackStepDelayMsOnPlay(fullStepCount: number): number {
    if (currentDagReplayPacingMode() === 'step') {
        const raw = parseInt(dagPlaybackStepMsInput?.value ?? '', 10);
        const ms = Number.isFinite(raw)
            ? clampDagPlaybackStepMs(raw)
            : readStoredDagPlaybackStepMs();
        if (dagPlaybackStepMsInput) dagPlaybackStepMsInput.value = String(ms);
        return ms;
    }

    const rawS = parseInt(dagPlaybackTotalSInput?.value ?? '', 10);
    const totalS = Number.isFinite(rawS)
        ? clampDagPlaybackTotalS(rawS)
        : readStoredDagPlaybackTotalS();
    if (dagPlaybackTotalSInput) dagPlaybackTotalSInput.value = String(totalS);

    // prompt 帧作为等权第一段，共 fullStepCount 段（比原来的 fullStepCount-1 多一段）
    const transitionCount = Math.max(0, fullStepCount);
    if (transitionCount <= 0) return 0;
    return Math.round((totalS * 1000) / transitionCount);
}

function stopDagPlayback(): void {
    if (dagPlaybackTimer !== null) {
        clearTimeout(dagPlaybackTimer);
        dagPlaybackTimer = null;
    }
    cancelDagLastTokenDwell();
    dagHandle.setDagPlaybackPlaying(false);
}

function handleDagPlaybackToggle(wantPlay: boolean): void {
    const h = runnerHandle;
    if (!wantPlay) {
        stopDagPlayback();
        return;
    }
    if (!h || h.tokenCount === 0) return;
    if (dagPlaybackTimer !== null) {
        clearTimeout(dagPlaybackTimer);
        dagPlaybackTimer = null;
    }
    cancelDagLastTokenDwell();
    const steps = h.getAllSteps();
    if (dagPlaybackNextIndex >= steps.length) {
        // `reset()` 默认会清 `layoutDirty`，每步 `update` 就会 fit；重放前需保留用户 pan/zoom 时保留 dirty。
        dagHandle.reset(true);
        dagPlaybackNextIndex = 0;
    }
    const stepDelayMs = resolveDagPlaybackStepDelayMsOnPlay(steps.length);
    dagHandle.setDagPlaybackPlaying(true);

    /** 相邻两步「理想触发」之间的名义间隔；与 {@link resolveDagPlaybackStepDelayMsOnPlay} 一致。 */
    let nextDue = performance.now();

    const isStalePlaybackHandle = (): boolean => {
        if (runnerHandle === h) return false;
        dagPlaybackTimer = null;
        dagHandle.setDagPlaybackPlaying(false);
        return true;
    };

    const finishDagPlayback = (): void => {
        cancelDagLastTokenDwell();
        dagPlaybackTimer = null;
        dagHandle.clearNodeSelection();
        dagHandle.setDagPlaybackPlaying(false);
    };

    /**
     * 步间节拍：理想时刻 `nextDue` 每次前进 `stepDelayMs`，实际等待 `max(0, nextDue - now)`。
     * 若已迟到（`delay === 0`），则 `nextDue = now + stepDelayMs` 重锚，避免长时间暂停 / 后台节流后连发多步。
     */
    const scheduleNextPlaybackTick = (): void => {
        const now = performance.now();
        nextDue += stepDelayMs;
        let delay = Math.max(0, nextDue - now);
        if (delay === 0) {
            nextDue = now + stepDelayMs;
        }
        dagPlaybackTimer = setTimeout(() => {
            dagPlaybackTimer = null;
            if (isStalePlaybackHandle()) return;
            tick();
        }, delay);
    };

    const tick = (): void => {
        if (isStalePlaybackHandle()) return;
        const all = h.getAllSteps();
        if (dagPlaybackNextIndex >= all.length) {
            finishDagPlayback();
            return;
        }
        const excludeCtx = excludeIntervalContextFromSteps(all);
        pushDagFromPreprocess(all[dagPlaybackNextIndex], dagPlaybackNextIndex, false, excludeCtx);
        dagPlaybackNextIndex++;
        const done = dagPlaybackNextIndex >= all.length;
        if (done) {
            scheduleDagLastTokenDwell(() => {
                if (runnerHandle !== h) {
                    dagHandle.setDagPlaybackPlaying(false);
                    return;
                }
                dagHandle.clearNodeSelection();
                dagHandle.setDagPlaybackPlaying(false);
            });
            return;
        }
        scheduleNextPlaybackTick();
    };
    // 从头开始（index 为 0）时先展示 prompt 帧，再等一个步进间隔后触发 step 0；
    // 中途恢复（index > 0）则直接续播，不重复 prompt 帧。
    if (dagPlaybackNextIndex === 0 && currentRunPromptSpans.length > 0) {
        dagHandle.setPromptTokenSpans(currentRunPromptSpans, steps[0]!.context);
        dagHandle.fitViewportToContent();
        scheduleNextPlaybackTick();
    } else {
        tick();
    }
}

const dagHandle = initGenAttributeDagView(d3.select('#results'), {
    onDagPlaybackToggle: handleDagPlaybackToggle,
    onDagRefresh: () => {
        stopDagPlayback();
        const h = runnerHandle;
        if (!h) return;
        replayRunnerStepsIntoDag(h, currentRunPromptSpans.length > 0 ? currentRunPromptSpans : undefined);
    },
    layoutMode: initialDagLayoutMode,
    measureWidthPx: initialDagMeasureWidth,
    dagCompactness: initialDagCompactness,
    linearArcAdjacentGapPx: initialDagLinearArcGap,
    hideExcludedTokens: initialDagHideExcludedTokens,
    showTokenInfoOnSelected: initialDagShowTopkOnSelected,
    showDownstreamInfluence: initialDagShowDownstreamInfluence,
    recursiveAttributionEnabled: initialDagRecursiveAttribution,
    edgeTopPCoverage: initialDagEdgeTopPCoverage,
    onFullscreenError: (message) => showToast(message, 'error'),
    getEffectiveExcludePromptPatternsText: genAttrEffectiveExcludePromptPatternsText,
    getEffectiveExcludeGeneratedPatternsText: genAttrEffectiveExcludeGeneratedPatternsText,
});

dagLayoutModeSelect?.addEventListener('change', () => {
    const mode = currentDagLayoutMode();
    try {
        localStorage.setItem(GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY, mode);
    } catch {
        /* ignore */
    }
    applyDagLayoutModeUi();
    dagHandle.setLayoutMode(mode);
});

/**
 * DAG 是否处于「不方便」状态：流式生成中或 DAG 播放中（含末 token dwell）。
 * 这些状态下改测量宽度只更新设置、不触发重绘，避免打断正在进行的流程/定时器状态机；
 * 否则（稳态显示已完成结果）则自动 reset + replay + fit 到新宽度。
 */
function isDagBusy(): boolean {
    return inFlight || dagPlaybackTimer !== null || dagLastTokenDwellTimer !== null;
}

/**
 * 非忙状态下 reset + replay + fit，供各设置项切换后复用。忙时为 no-op。
 * 默认保留 DAG 选中节点；整页重置 UI 等场景传 `preserveNodeSelection: false`。
 */
function tryResetAndReplayDag(opts?: { preserveNodeSelection?: boolean }): void {
    if (isDagBusy()) return;
    const preserveSelection = opts?.preserveNodeSelection !== false;
    const preservedSelectedId = preserveSelection ? dagHandle.getSelectedNodeId() : null;
    const h = runnerHandle;
    dagHandle.reset();
    if (h && h.tokenCount > 0) {
        replayRunnerStepsIntoDag(h, currentRunPromptSpans.length > 0 ? currentRunPromptSpans : undefined);
    }
    dagHandle.fitViewportToContent();
    if (preservedSelectedId != null) {
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
    try {
        localStorage.setItem(GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY, String(w));
    } catch {
        /* ignore */
    }
    dagHandle.setMeasureWidthPx(w);
    tryResetAndReplayDag();
});

dagCompactnessInput?.addEventListener('change', () => {
    const raw = parseFloat(dagCompactnessInput.value);
    const c = Number.isFinite(raw) ? clampDagCompactness(raw) : DAG_COMPACTNESS_DEFAULT;
    dagCompactnessInput.value = String(c);
    try {
        localStorage.setItem(GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY, String(c));
    } catch {
        /* ignore */
    }
    dagHandle.setDagCompactness(c);
    tryResetAndReplayDag();
});

dagEdgeTopPCoverageInput?.addEventListener('change', () => {
    const raw = parseFloat(dagEdgeTopPCoverageInput.value);
    const c = Number.isFinite(raw)
        ? clampDagEdgeTopPCoverage(raw)
        : DAG_EDGE_TOP_P_COVERAGE_DEFAULT;
    dagEdgeTopPCoverageInput.value = String(c);
    try {
        localStorage.setItem(GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY, String(c));
    } catch {
        /* ignore */
    }
    dagHandle.setEdgeTopPCoverage(c);
    tryResetAndReplayDag();
});

dagLinearArcIntervalInput?.addEventListener('change', () => {
    const raw = parseInt(dagLinearArcIntervalInput.value, 10);
    const n = Number.isFinite(raw)
        ? clampLinearArcAdjacentGap(raw)
        : LINEAR_ARC_ADJACENT_GAP_DEFAULT;
    dagLinearArcIntervalInput.value = String(n);
    try {
        localStorage.setItem(GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY, String(n));
    } catch {
        /* ignore */
    }
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
    const rawTotal = parseInt(dagPlaybackTotalSInput?.value ?? '', 10);
    const playbackTotalS = Number.isFinite(rawTotal)
        ? clampDagPlaybackTotalS(rawTotal)
        : GEN_ATTR_DAG_PLAYBACK_TOTAL_S_DEFAULT;
    const rawStep = parseInt(dagPlaybackStepMsInput?.value ?? '', 10);
    const playbackStepMs = Number.isFinite(rawStep)
        ? clampDagPlaybackStepMs(rawStep)
        : GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT;
    return {
        layoutMode: currentDagLayoutMode(),
        measureWidthPx,
        dagCompactness,
        linearArcAdjacentGapPx,
        hideExcludedTokens: dagHideExcludedTokensInput?.checked ?? false,
        edgeTopPCoverage,
        nodeCiVisualScaleEnabled: dagNodeCiVisualScaleInput?.checked ?? true,
        decayAttributionToHighSurprisalTargetEnabled:
            dagDecayAttributionHighSurprisalInput?.checked ?? true,
        hideInactiveEdges: dagHideInactiveEdgesInput?.checked ?? false,
        showDownstreamInfluence: dagShowDownstreamInfluenceInput?.checked ?? false,
        recursiveAttributionEnabled: dagRecursiveAttributionInput?.checked ?? false,
        showTokenInfoOnSelected: dagShowTopkOnSelectedInput?.checked ?? false,
        replayPacingMode: currentDagReplayPacingMode(),
        playbackTotalS,
        playbackStepMs,
        excludePromptPatternsEnabled: genAttrExcludePromptPatternsEnable?.checked ?? true,
        excludePromptPatternsText: genAttrExcludePromptPatternsTa?.value ?? '',
        excludeGeneratedPatternsEnabled: genAttrExcludeGeneratedPatternsEnable?.checked ?? true,
        excludeGeneratedPatternsText: genAttrExcludeGeneratedPatternsTa?.value ?? '',
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
 * 从 `demoUiOptions` 还原排除控件（仅 DOM）；与施加 DAG demo 不回写 GEN_ATTR_LS 的策略一致，`replay` 读当前控件生效。
 */
function applyGenAttrExcludePatternsFromDemoUiSnap(snap: Partial<GenAttrDemoUiOptions>): void {
    const {
        excludePromptPatternsEnabled,
        excludePromptPatternsText,
        excludeGeneratedPatternsEnabled,
        excludeGeneratedPatternsText,
    } = snap;
    if (
        excludePromptPatternsEnabled === undefined &&
        excludePromptPatternsText === undefined &&
        excludeGeneratedPatternsEnabled === undefined &&
        excludeGeneratedPatternsText === undefined
    ) {
        return;
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
    syncGenAttrExcludePatternTextareasDisabled();
}

/** 按 `demoUiOptions` 逐项还原 DAG 面板与排除控件（后者仅 DOM）；未覆盖字段不改变。 */
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
        applyDagDownstreamInfluenceUi();
        dagHandle.setRecursiveAttributionEnabled(snap.recursiveAttributionEnabled);
    }
    if (snap.showTokenInfoOnSelected !== undefined) {
        if (dagShowTopkOnSelectedInput) dagShowTopkOnSelectedInput.checked = snap.showTokenInfoOnSelected;
        dagHandle.setShowTokenInfoOnSelected(snap.showTokenInfoOnSelected);
    }
    if (snap.replayPacingMode !== undefined) {
        if (dagReplayModeSelect) dagReplayModeSelect.value = snap.replayPacingMode;
        applyDagReplaySpeedUi();
    }
    if (snap.playbackTotalS !== undefined) {
        const s = clampDagPlaybackTotalS(snap.playbackTotalS);
        if (dagPlaybackTotalSInput) dagPlaybackTotalSInput.value = String(s);
    }
    if (snap.playbackStepMs !== undefined) {
        const ms = clampDagPlaybackStepMs(snap.playbackStepMs);
        if (dagPlaybackStepMsInput) dagPlaybackStepMsInput.value = String(ms);
    }

    applyGenAttrExcludePatternsFromDemoUiSnap(snap);
    syncGenAttrResetUiOptionsButtonState();
}

/** replay 完成后按 `demoUiOptions.selectedNodeId` 恢复 DAG 焦点；无效或缺失则清除选中。 */
function restoreGenAttrDagFocusFromDemoUiOptions(snap: Partial<GenAttrDemoUiOptions> | undefined): void {
    const focusId = snap?.selectedNodeId;
    if (typeof focusId === 'string' && focusId.length > 0) {
        try {
            dagHandle.setSelectedNodeId(focusId);
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

/** Gen Attribute demo-UI scope：与 {@link readGenAttrDemoUiOptionsFromControls} / IndexedDB demo 快照一致（不含 Model、Max tokens、prompt 正文）。 */
const GEN_ATTR_DEMO_UI_LOCAL_STORAGE_KEYS: readonly string[] = [
    GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY,
    GEN_ATTR_DAG_LAYOUT_MODE_STORAGE_KEY,
    GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY,
    GEN_ATTR_DAG_REPLAY_PACING_MODE_STORAGE_KEY,
    GEN_ATTR_DAG_PLAYBACK_TOTAL_S_STORAGE_KEY,
    GEN_ATTR_DAG_NODE_CI_VISUAL_SCALE_STORAGE_KEY,
    GEN_ATTR_DAG_DECAY_ATTRIBUTION_HIGH_SURPRISAL_STORAGE_KEY,
    GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY,
    GEN_ATTR_DAG_SHOW_DOWNSTREAM_INFLUENCE_STORAGE_KEY,
    GEN_ATTR_DAG_RECURSIVE_ATTRIBUTION_STORAGE_KEY,
    GEN_ATTR_DAG_HIDE_EXCLUDED_TOKENS_STORAGE_KEY,
    GEN_ATTR_DAG_SHOW_TOPK_ON_SELECTED_STORAGE_KEY,
    GEN_ATTR_DAG_LINEAR_ARC_GAP_STORAGE_KEY,
    GEN_ATTR_DAG_COMPACTNESS_STORAGE_KEY,
    GEN_ATTR_DAG_EDGE_TOP_P_COVERAGE_STORAGE_KEY,
    GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY,
    GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
    GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY,
    GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY,
];

function removeGenAttrDemoUiOptionsFromLocalStorage(): void {
    try {
        for (const k of GEN_ATTR_DEMO_UI_LOCAL_STORAGE_KEYS) {
            localStorage.removeItem(k);
        }
    } catch {
        /* ignore */
    }
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
    const sync = () => syncGenAttrResetUiOptionsButtonState();
    panel.addEventListener('change', sync);
    panel.addEventListener('input', sync);
    sync();
})();

window.addEventListener('pagehide', (ev) => {
    if (ev.persisted) return;
    dagHandle.detach();
});

function onExcludePatternsEffectiveChange(): void {
    const h = runnerHandle;
    if (!h || h.tokenCount === 0) return;
    tryResetAndReplayDag();
}

function bindExcludePatternControls(
    enableEl: HTMLInputElement | null,
    textEl: HTMLTextAreaElement | null,
    textKey: string,
    enabledKey: string,
): void {
    enableEl?.addEventListener('change', () => {
        try {
            if (textEl) localStorage.setItem(textKey, textEl.value);
            localStorage.setItem(enabledKey, enableEl.checked ? '1' : '0');
        } catch { /* ignore */ }
        syncGenAttrExcludePatternTextareasDisabled();
        onExcludePatternsEffectiveChange();
    });
    textEl?.addEventListener('blur', () => {
        try {
            localStorage.setItem(textKey, textEl.value);
        } catch { /* ignore */ }
        onExcludePatternsEffectiveChange();
    });
}

bindExcludePatternControls(
    genAttrExcludePromptPatternsEnable,
    genAttrExcludePromptPatternsTa,
    GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY,
    GEN_ATTR_EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
);
bindExcludePatternControls(
    genAttrExcludeGeneratedPatternsEnable,
    genAttrExcludeGeneratedPatternsTa,
    GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY,
    GEN_ATTR_EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY,
);

function currentModelVariant(): PredictionAttributeModelVariant {
    const v = modelVariantSelect?.value;
    return v === 'base' || v === 'instruct' ? v : 'instruct';
}

function currentMaxTokens(): number {
    const n = parseInt(
        maxTokensInput?.value ?? String(GEN_ATTR_MAX_TOKENS_DEFAULT),
        10
    );
    return Number.isFinite(n) && n >= 1
        ? Math.min(n, 500)
        : GEN_ATTR_MAX_TOKENS_DEFAULT;
}

function syncIdleModelMetric(): void {
    if (!validateMetricsElements(metricModel)) return;
    const slot = currentModelVariant();
    metricModel.text(`${tr('model')}: ${slot}`);
}

// --- 状态 ---
let runnerHandle: TokenGenAttributionHandle | null = null;

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
        max: currentMaxTokens(),
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
        ...runOpts,
    });
}

function setGenLoading(loading: boolean): void {
    inFlight = loading;
    loaderSmall.style('display', loading ? null : 'none');
    genAttrResultsEl.classed('gen-attr-in-flight', loading);
    if (!loading) {
        analyzeProgressEl.text('').style('display', 'none');
    }
    syncSubmitButtonState();
}

/** 当前输入是否满足可以发起一次生成（不含 inFlight 判断）。 */
function isInputReadyForRun(): boolean {
    const prompt = getActivePromptValue();
    const forcing = teacherForcingContinuationForRun();
    if (prompt.length === 0 && forcing === undefined) return false;
    if (prompt.length > 0 && isGenAttrTeacherForcingUiOn() && forcing === undefined) return false;
    return true;
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
    skipChatTemplateInput.checked = readSkipChatTemplateFromStorage();
    skipChatTemplateInput.addEventListener('change', () => {
        writeSkipChatTemplateToStorage(skipChatTemplateInput.checked);
        syncPromptPanelVisibility();
        syncGenAttrSystemPromptSuppressedUi();
        syncSubmitButtonState();
    });
}
syncPromptPanelVisibility();
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


function syncGenAttrContentUrl(key: GenAttrCacheKey): void {
    replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'gen_attribute');
    replaceContentUrlParam(
        buildCachedContentUrlParam(key),
        DEFAULT_CONTENT_URL_PARAM,
        'gen_attribute'
    );
}

function syncGenAttrDemoUrl(slug: string): void {
    replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'gen_attribute');
    replaceDemoUrlParam(slug, DEFAULT_DEMO_URL_PARAM, 'gen_attribute');
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
            writeSkipChatTemplateToStorage(false);
            syncPromptPanelVisibility();
            syncGenAttrSystemPromptSuppressedUi();
        }
        systemTextField.property('value', draft.system ?? '');
        systemPromptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        userTextField.property('value', draft.user ?? '');
        userPromptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        if (skipChatTemplateInput) {
            skipChatTemplateInput.checked = true;
            writeSkipChatTemplateToStorage(true);
            syncPromptPanelVisibility();
        }
        rawTextField.property('value', rec.initialContext);
        rawTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // 恢复 model / maxTokens（必须在 getInputSnapshotForRun() 之前，使快照与实际一致）
    if (draft?.model && modelVariantSelect) {
        modelVariantSelect.value = draft.model;
    }
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
    applyGenAttrDemoUiOptionsFromRecord(rec);
    syncGenAttrResetUiOptionsButtonState();
    runnerHandle = createHydratedTokenGenHandle(rec.steps);
    lastRunInitialContext = rec.initialContext;
    lastRunInputSnapshot = getInputSnapshotForRun();
    syncSubmitButtonState();
    // 新缓存直接用 promptSpans；旧缓存无此字段时从 step 0 归因降级
    const replayPromptSpans = rec.promptSpans ?? extractPromptTokenSpans(rec.steps[0]!);
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
        replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'gen_attribute');
        replaceContentUrlParam(options.afterUrl.contentKey, DEFAULT_CONTENT_URL_PARAM, 'gen_attribute');
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
        console.error('[gen_attribute] demo load failed', e);
        showToast(extractErrorMessage(e, tr('Demo not found')), 'error');
    }
}

const genAttrCachedHistoryBtn = document.getElementById('gen_attr_cached_history_btn');
let genAttrBundledDemoEntries: Array<{ id: string; label: string }> = [];

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
    historyButton: document.getElementById('gen_attr_cached_demos_btn'),
    clickOutsideRoot: document.getElementById('gen_attr_cached_demos_dropdown'),
    applyHistoryOnHover: true,
});

refreshGenAttrBundledDemoEntriesList();

// --- 进度与指标 ---
function showProgress(current: number, total: number): void {
    analyzeProgressEl.text(`${current} / ${total}`).style('display', null);
}

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
                console.error('[gen_attribute] ?demo= load failed', e);
                showToast(extractErrorMessage(e, tr('Demo not found')), 'error');
                replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'gen_attribute');
            }
        }
        if (applied) {
            return;
        }
        if (!loadThrew && !isStaleGenAttrCachedApply(applyGen)) {
            showToast(tr('Demo not found'), 'error');
            replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'gen_attribute');
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
            replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'gen_attribute');
            replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'gen_attribute');
        },
        onApplyError: (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            showToast(msg, 'error');
            replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'gen_attribute');
            replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'gen_attribute');
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
    const promptReq: { model: string; prompt: string; system?: string } = {
        model: currentModelVariant(),
        prompt: user,
    };
    if (useSystem) {
        promptReq.system = systemRaw;
    }
    const assembled = await postCompletionsPrompt(promptReq, { signal });
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

async function runGeneration(): Promise<void> {
    if (inFlight || !isInputReadyForRun()) return;

    genAbort?.abort();
    genAbort = new AbortController();
    const { signal } = genAbort;

    stopDagPlayback();
    dagPlaybackNextIndex = 0;

    setGenLoading(true);
    runnerHandle = null;
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
        const prompt = getActivePromptValue();
        analyzeProgressEl.text('Assembling prompt…').style('display', null);
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
        currentRunPromptSpans = [];
        setGenAttrUsageMetric(undefined, 0);
        showProgress(0, maxTokens);

        dagHandle.reset();
        void fetchTokenize(apiBaseForRequests, initialContext, tokenizeModel).then((spans) => {
            currentRunPromptSpans = spans;
            if (spans.length > 0) {
                dagHandle.setPromptTokenSpans(spans, initialContext);
                dagHandle.fitViewportToContent();
            }
        }).catch(() => { /* 失败静默，step 0 回调兜底 */ });
        runnerHandle = startTokenGenAttribution({
            initialContext,
            apiPrefix: apiBaseForRequests,
            model: tokenizeModel,
            maxTokens,
            flowId: createFlowId(),
            teacherForcingContinuation: teacherForcingText,
            stopAfterTeacherForcing: stopAfterTF,
            onStep(step, stepIndex) {
                if (stepIndex === 0) {
                    initialPromptTokens = initialPromptTokensFromFirstStep(step);
                    // tokenize 失败时兜底：从 step 0 归因派生 spans
                    if (currentRunPromptSpans.length === 0) {
                        currentRunPromptSpans = extractPromptTokenSpans(step);
                    }
                }
                const h = runnerHandle;
                if (!h) return;
                const excludeCtx = excludeIntervalContextFromSteps(h.getAllSteps());
                pushDagFromPreprocess(step, stepIndex, true, excludeCtx);
                dagPlaybackNextIndex = stepIndex + 1;
                showProgress(stepIndex + 1, maxTokens);
                setGenAttrUsageMetric(initialPromptTokens, stepIndex + 1);
                showAttributionForStepIndex(stepIndex);
            },
            onComplete(reason) {
                genAbort = null;
                setGenLoading(false);
                const h = runnerHandle;
                const ic = lastRunInitialContext;
                lastRunCompletionReason = reason;
                if (h && ic && h.tokenCount >= 1) {
                    const stepsToStore = h.getAllSteps();
                    const cacheStatus: 'partial' | 'complete' =
                        reason === 'stop' || reason === 'length' ? 'complete' : 'partial';
                    const cacheKey: GenAttrCacheKey = {
                        initialContext: ic,
                        model: tokenizeModel,
                        maxTokens,
                        ...(teacherForcingText !== undefined ? {
                            teacherForcing: teacherForcingText,
                            stopAfterTeacherForcing: stopAfterTF,
                        } : {}),
                    };
                    void save(cacheKey, stepsToStore, currentRunPromptSpans, cacheStatus, reason, runDraft)
                        .then(() => genCachedHistory.refreshList())
                        .then(() => syncGenAttrContentUrl(cacheKey))
                        .catch((e) => console.warn('[gen_attribute] save cached run failed:', e));
                }
                completeReasonEl.text(completionFinishReasonLabel(reason));
                scheduleDagLastTokenDwell(() => {
                    dagHandle.clearNodeSelection();
                });
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
    tryResetAndReplayDag();
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
syncGenAttrExportDemoBtn();
adminManager.onAdminModeChange(() => syncGenAttrExportDemoBtn());
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
