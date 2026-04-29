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
import { TextInputController } from './controllers/textInputController';
import { initializeCommonApp } from './appInitializer';
import { showAlertDialog } from './ui/dialog';
import URLHandler from './utils/URLHandler';
import { createToast } from './ui/toast';
import type { PredictionAttributeModelVariant } from './attribution/attributionResultCache';
import { extractPromptTokenSpans } from './attribution/genAttributeDagPreprocess';
import { initGenAttributeDagView } from './attribution/genAttributeDagView';
import {
    createHydratedTokenGenHandle,
    startTokenGenAttribution,
    type TokenGenAttributionHandle,
    type TokenGenStep,
} from './attribution/tokenGenAttributionRunner';
import { completionFinishReasonLabel, type CompletionFinishReason } from './utils/generationEndReasonLabel';
import {
    buildCachedContentUrlParam,
    getCachedEntryByContentKey,
    listCachedHistoryRows,
    removeCachedEntryByContentKey,
    save,
    touchCachedEntryByContentKey,
} from './storage/genAttributeRunCache';
import { bindExcludeGeneratedPatternsUi, bindExcludePromptPatternsUi } from './attribution/excludePromptPatternsUi';
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
    fetchBundledGenAttributeDemoList,
    isGenAttrRunPayloadValidForUi,
} from './demos/genAttributeBundledDemos';
import { extractErrorMessage } from './utils/errorUtils';
import { exportJsonFile } from './storage/localFileIO';
import type { GenAttrCachedRun } from './storage/genAttributeRunCache';
import {
    GEN_ATTR_RAW_INPUT_HISTORY_KEY,
    GEN_ATTR_SYSTEM_INPUT_HISTORY_KEY,
    GEN_ATTR_USER_INPUT_HISTORY_KEY,
    initQueryHistoryDropdown,
    saveHistory,
} from './utils/queryHistory';
import {
    readSkipChatTemplateFromStorage,
    writeSkipChatTemplateToStorage,
} from './utils/chatPromptTemplateMode';
import { postCompletionsPrompt, postCompletionsStop } from './api/completionsClient';
import { CHAT_DEFAULT_COMPLETION_MODEL } from './chat/buildCompletionDisplayResult';
import { updateApiUsageDisplay, updateModel, validateMetricsElements } from './utils/textMetricsUpdater';

d3.selectAll('.loadersmall').style('display', 'none');

initI18n();

const showToast = createToast('#toast').show;

const GEN_ATTR_MODEL_VARIANT_STORAGE_KEY = 'info_radar_gen_attr_model_variant';
const GEN_ATTR_MAX_TOKENS_STORAGE_KEY = 'info_radar_gen_attr_max_tokens';
const GEN_ATTR_MAX_TOKENS_DEFAULT = 100;
const GEN_ATTR_DAG_MEASURE_WIDTH_STORAGE_KEY = 'info_radar_gen_attr_dag_measure_width';
const GEN_ATTR_DAG_PLAYBACK_STEP_MS_STORAGE_KEY = 'info_radar_gen_attr_dag_playback_step_ms';
const GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY = 'info_radar_gen_attr_dag_hide_inactive_edges';

const GEN_ATTR_DAG_MEASURE_WIDTH_DEFAULT = 500;
const GEN_ATTR_DAG_MEASURE_WIDTH_MIN = 200;
const GEN_ATTR_DAG_MEASURE_WIDTH_MAX = 4000;

const GEN_ATTR_DAG_PLAYBACK_STEP_MS_DEFAULT = 200;
const GEN_ATTR_DAG_PLAYBACK_STEP_MS_MIN = 0;
const GEN_ATTR_DAG_PLAYBACK_STEP_MS_MAX = 10000;

const GENERATE_BTN_LABEL = 'Start';
const STOP_BTN_LABEL = 'Stop';

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

const apiPrefix = URLHandler.parameters['api'] || '';
const bodyElement = d3.select('body').node() as Element;
const { totalSurprisalFormat, api } = initializeCommonApp(apiPrefix, bodyElement);
const apiBaseForRequests = apiPrefix === '' ? '' : String(apiPrefix);

const adminManager = AdminManager.getInstance();
api.setAdminToken(adminManager.isInAdminMode() ? adminManager.getAdminToken() : null);

const modelParam = URLHandler.parameters['model'];
const completionModel =
    typeof modelParam === 'string' && modelParam.length > 0
        ? modelParam
        : CHAT_DEFAULT_COMPLETION_MODEL;

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

const rawInputPanel = document.getElementById('gen_attr_raw_input_panel');
const chatInputPanel = document.getElementById('gen_attr_chat_input_panel');
const skipChatTemplateInput = document.getElementById(
    'gen_attr_skip_chat_template'
) as HTMLInputElement | null;
const genAttrUseSystemPromptInput = document.getElementById(
    'gen_attr_use_system_prompt'
) as HTMLInputElement | null;
const genAttrSystemPromptPanel = document.getElementById('gen_attr_system_prompt_panel');

const submitBtn = d3.select('#gen_attr_submit_btn');
const loaderSmall = d3.select('.loadersmall');
const analyzeProgressEl = d3.select('#gen_attr_analyze_progress');
const metricUsage = d3.select('#gen_attr_metric_usage');
const metricModel = d3.select('#gen_attr_metric_model');
const genAttrResultsEl = d3.select('#results.gen-attr-results-surface');

const modelVariantSelect = document.getElementById('gen_attr_model_variant') as HTMLSelectElement | null;
const maxTokensInput = document.getElementById('gen_attr_max_tokens') as HTMLInputElement | null;
const dagMeasureWidthInput = document.getElementById(
    'gen_attr_dag_measure_width'
) as HTMLInputElement | null;
const dagPlaybackStepMsInput = document.getElementById(
    'gen_attr_dag_playback_step_ms'
) as HTMLInputElement | null;
const dagHideInactiveEdgesInput = document.getElementById(
    'gen_attr_dag_hide_inactive_edges'
) as HTMLInputElement | null;
const completeReasonEl = d3.select('#gen_attr_complete_reason');

if (modelVariantSelect) modelVariantSelect.value = readStoredModelVariant();
if (maxTokensInput) maxTokensInput.value = String(readStoredMaxTokens());
const initialDagMeasureWidth = readStoredDagMeasureWidth();
if (dagMeasureWidthInput) dagMeasureWidthInput.value = String(initialDagMeasureWidth);
const initialDagPlaybackStepMs = readStoredDagPlaybackStepMs();
if (dagPlaybackStepMsInput) dagPlaybackStepMsInput.value = String(initialDagPlaybackStepMs);

const genAttrResultsNode = genAttrResultsEl.node() as HTMLElement | null;
function applyDagHideInactiveEdges(hide: boolean): void {
    if (!genAttrResultsNode) return;
    genAttrResultsNode.classList.toggle('gen-attr-dag-hide-inactive-edges', hide);
}
function readStoredDagHideInactiveEdges(): boolean {
    try {
        return localStorage.getItem(GEN_ATTR_DAG_HIDE_INACTIVE_EDGES_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
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
        dagHandle.setPromptTokenSpans(extractPromptTokenSpans(step), step.context);
        if (!dagHandle.isBatching() && fitOnFirstStep) {
            dagHandle.fitViewportToContent();
        }
    }
    dagHandle.update(step, excludeIntervalContext);
}

/** 下一步要 `pushDagFromPreprocess` 的步下标；与当前 DAG 前缀一致（暂停不重置） */
let dagPlaybackNextIndex = 0;

/** 将 handle 中已存步序按序重放进 DAG（调用方负责先 {@link dagHandle.reset} 等） */
function replayRunnerStepsIntoDag(h: TokenGenAttributionHandle): void {
    if (h.tokenCount === 0) {
        dagPlaybackNextIndex = 0;
        return;
    }
    // 整段回放期间中间帧不可见：批处理内 `update` 只维护图数据，结束时统一刷一次 svg。
    // 避免 N 次 `syncGraphToSvg`（含 N 次对所有边的 join / paint / refresh）造成 O(N²) 累计开销。
    const steps = h.getAllSteps();
    const excludeCtx = excludeIntervalContextFromSteps(steps);
    dagHandle.beginBatch();
    try {
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

/** 仅在点击播放时调用：读当前输入、写回规范化值，返回本轮重放使用的步进间隔。 */
function sampleDagPlaybackStepMsOnPlay(): number {
    const raw = parseInt(dagPlaybackStepMsInput?.value ?? '', 10);
    const ms = Number.isFinite(raw)
        ? clampDagPlaybackStepMs(raw)
        : readStoredDagPlaybackStepMs();
    if (dagPlaybackStepMsInput) dagPlaybackStepMsInput.value = String(ms);
    return ms;
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
    const playbackStepMs = sampleDagPlaybackStepMsOnPlay();
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
        dagHandle.clearNodeSelection();
        dagHandle.setDagPlaybackPlaying(false);
    };

    const afterPlaybackDelay = (fn: () => void): void => {
        dagPlaybackTimer = setTimeout(() => {
            dagPlaybackTimer = null;
            if (isStalePlaybackHandle()) return;
            fn();
        }, playbackStepMs);
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
        afterPlaybackDelay(tick);
    };
    tick();
}

const dagHandle = initGenAttributeDagView(d3.select('#results'), {
    onDagPlaybackToggle: handleDagPlaybackToggle,
    onDagRefresh: () => {
        stopDagPlayback();
        const h = runnerHandle;
        if (!h) return;
        replayRunnerStepsIntoDag(h);
    },
    measureWidthPx: initialDagMeasureWidth,
    onFullscreenError: (message) => showToast(message, 'error'),
});

/**
 * DAG 是否处于「不方便」状态：流式生成中或 DAG 播放中（含末 token dwell）。
 * 这些状态下改测量宽度只更新设置、不触发重绘，避免打断正在进行的流程/定时器状态机；
 * 否则（稳态显示已完成结果）则自动 reset + replay + fit 到新宽度。
 */
function isDagBusy(): boolean {
    return inFlight || dagPlaybackTimer !== null || dagLastTokenDwellTimer !== null;
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
    if (isDagBusy()) return;
    const h = runnerHandle;
    dagHandle.reset();
    if (h && h.tokenCount > 0) {
        replayRunnerStepsIntoDag(h);
    }
    dagHandle.fitViewportToContent();
    dagHandle.clearNodeSelection();
});
window.addEventListener('pagehide', (ev) => {
    if (ev.persisted) return;
    dagHandle.detach();
});

function onExcludePatternsEffectiveChange(): void {
    const h = runnerHandle;
    if (!h || h.tokenCount === 0) return;
    dagHandle.reset();
    replayRunnerStepsIntoDag(h);
    dagHandle.clearNodeSelection();
}

bindExcludePromptPatternsUi({
    textInput: document.getElementById('gen_attr_exclude_prompt_patterns') as HTMLTextAreaElement | null,
    enableCheckbox: document.getElementById('gen_attr_exclude_prompt_patterns_enable') as HTMLInputElement | null,
    onEffectiveChange: onExcludePatternsEffectiveChange,
});
bindExcludeGeneratedPatternsUi({
    textInput: document.getElementById('gen_attr_exclude_generated_patterns') as HTMLTextAreaElement | null,
    enableCheckbox: document.getElementById('gen_attr_exclude_generated_patterns_enable') as HTMLInputElement | null,
    onEffectiveChange: onExcludePatternsEffectiveChange,
});

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
    const runOpts = { v: currentModelVariant(), max: currentMaxTokens() };
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

function syncSubmitButtonState(): void {
    if (inFlight) {
        submitBtn.text(STOP_BTN_LABEL);
        submitBtn.property('disabled', false);
        submitBtn.classed('inactive', false);
        return;
    }
    submitBtn.text(GENERATE_BTN_LABEL);
    const raw = getActivePromptValue();
    const hasDisplayedRun =
        runnerHandle !== null &&
        runnerHandle.tokenCount > 0 &&
        lastRunInitialContext.length > 0 &&
        lastRunInputSnapshot !== null;
    const inputMatchesDisplayed =
        hasDisplayedRun && getInputSnapshotForRun() === lastRunInputSnapshot;
    const enable = raw.length > 0 && !inputMatchesDisplayed;
    submitBtn.property('disabled', !enable);
    submitBtn.classed('inactive', !enable);
}

function bindInputsForSync(): void {
    const onInput = () => syncSubmitButtonState();
    (rawTextField.node() as HTMLTextAreaElement | null)?.addEventListener('input', onInput);
    (systemTextField.node() as HTMLTextAreaElement | null)?.addEventListener('input', onInput);
    (userTextField.node() as HTMLTextAreaElement | null)?.addEventListener('input', onInput);
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
bindInputsForSync();
syncSubmitButtonState();
syncIdleModelMetric();

// --- History（与 Chat 共用 storage key）---
const rawTextarea = rawTextField.node() as HTMLTextAreaElement | null;
const systemPromptTextarea = systemTextField.node() as HTMLTextAreaElement | null;
const userPromptTextarea = userTextField.node() as HTMLTextAreaElement | null;

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

function syncGenAttrContentUrl(initialContext: string): void {
    replaceDemoUrlParam(null, DEFAULT_DEMO_URL_PARAM, 'gen_attribute');
    replaceContentUrlParam(
        buildCachedContentUrlParam(initialContext),
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
        afterUrl: { kind: 'content' } | { kind: 'demo'; slug: string };
    },
    applyGen: number
): Promise<void> {
    if (rec.steps.length === 0) {
        showToast(tr('Cached run not found'), 'error');
        return;
    }
    if (isStaleGenAttrCachedApply(applyGen)) {
        return;
    }
    if (skipChatTemplateInput) {
        skipChatTemplateInput.checked = true;
        writeSkipChatTemplateToStorage(true);
        syncPromptPanelVisibility();
    }
    rawTextField.property('value', rec.initialContext);
    rawTextarea?.dispatchEvent(new Event('input', { bubbles: true }));

    if (rec.completionReason != null) {
        completeReasonEl.text(completionFinishReasonLabel(rec.completionReason));
        lastRunCompletionReason = rec.completionReason;
    } else {
        completeReasonEl.text('');
        lastRunCompletionReason = null;
    }

    stopDagPlayback();
    dagHandle.reset();
    runnerHandle = createHydratedTokenGenHandle(rec.steps);
    lastRunInitialContext = rec.initialContext;
    lastRunInputSnapshot = getInputSnapshotForRun();
    syncSubmitButtonState();
    replayRunnerStepsIntoDag(runnerHandle);
    dagHandle.fitViewportToContent();
    dagHandle.clearNodeSelection();
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
        syncGenAttrContentUrl(rec.initialContext);
    } else {
        syncGenAttrDemoUrl(options.afterUrl.slug);
    }
}

/** Cached history 与 `?content=` 共用；`shouldTouch` 为 true 时 touch MRU 并刷新下拉镜像。 */
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
            afterUrl: { kind: 'content' },
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

async function refreshGenAttrBundledDemoEntriesList(): Promise<void> {
    genAttrBundledDemoEntries = [...(await fetchBundledGenAttributeDemoList())];
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

void refreshGenAttrBundledDemoEntriesList().catch((e) => {
    console.warn('[gen_attribute] bundled demo manifest prefetch failed', e);
});

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
    if (demoRaw) {
        const applyGen = nextGenAttrCachedApplyGen();
        let applied = false;
        let loadThrew = false;
        try {
            const rec = await fetchBundledGenAttributeDemoBySlug(demoRaw);
            if (!isStaleGenAttrCachedApply(applyGen) && rec && isGenAttrRunPayloadValidForUi(rec)) {
                await applyGenAttrCachedRun(rec, { afterUrl: { kind: 'demo', slug: demoRaw } }, applyGen);
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
})();

async function resolveInitialContext(signal: AbortSignal): Promise<string> {
    if (isSkipChatTemplate()) {
        return (rawTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    }
    const user = (userTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    const useSystem = isGenAttrUseSystemPrompt();
    const systemRaw = (systemTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    const promptReq: { model: string; prompt: string; system?: string } = {
        model: completionModel,
        prompt: user,
    };
    if (useSystem) {
        promptReq.system = systemRaw;
    }
    const assembled = await postCompletionsPrompt(promptReq, { signal });
    return assembled.prompt_used;
}

async function runGeneration(): Promise<void> {
    const prompt = getActivePromptValue();
    if (inFlight || prompt.length === 0) return;

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

        const maxTokens = currentMaxTokens();
        let initialPromptTokens: number | undefined;
        setGenAttrUsageMetric(undefined, 0);
        showProgress(0, maxTokens);

        dagHandle.reset();
        runnerHandle = startTokenGenAttribution({
            initialContext,
            apiPrefix: apiBaseForRequests,
            model: currentModelVariant(),
            maxTokens,
            onStep(step, stepIndex) {
                if (stepIndex === 0) initialPromptTokens = initialPromptTokensFromFirstStep(step);
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
                    void save({ initialContext: ic }, stepsToStore, cacheStatus, reason)
                        .then(() => genCachedHistory.refreshList())
                        .then(() => syncGenAttrContentUrl(ic))
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

[rawTextarea, userPromptTextarea].forEach((el) => {
    el?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void runGeneration();
    });
});

function refreshDagForThemeChange(): void {
    stopDagPlayback();
    const h = runnerHandle;
    if (!h || h.tokenCount === 0) {
        return;
    }
    dagHandle.reset();
    replayRunnerStepsIntoDag(h);
    dagHandle.fitViewportToContent();
    dagHandle.clearNodeSelection();
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
    const h = runnerHandle;
    const ic = lastRunInitialContext;
    if (!h || !ic || h.tokenCount < 1) {
        showToast(tr('No run to export'), 'error');
        return;
    }
    const payload: GenAttrCachedRun = {
        initialContext: ic,
        steps: h.getAllSteps(),
        ...(lastRunCompletionReason != null ? { completionReason: lastRunCompletionReason } : {}),
    };
    void exportJsonFile(payload, `genattr-${Date.now()}.json`);
});

initChatPanelLayout();
