import * as d3 from 'd3';
import '../../shared/core/d3-polyfill';
import '../../css/pages/attribution.scss';

import { initThemeManager } from '../../shared/ui/theme';
import { initLanguageManager } from '../../shared/ui/language';
import { initI18n, tr, trf } from '../../shared/lang/i18n-lite';
import { AdminManager } from '../../shared/cross/adminManager';
import { SettingsMenuManager } from '../../shared/cross/settingsMenuManager';
import { initChatPanelLayout } from '../../shared/ui/chat_panel_layout';
import { PANEL_SPLIT_STORAGE_KEY_ATTRIBUTION } from '../../shared/cross/panelSplitStorage';
import { TextInputController } from '../../shared/controllers/textInputController';
import { initializeCommonApp } from '../../shared/bootstrap';
import { showAlertDialog } from '../../shared/ui/dialog';
import URLHandler from '../../shared/core/URLHandler';
import { initCachedHistoryQueryDropdown, type CachedHistorySelectContext } from '../../shared/cross/cachedHistoryUi';
import {
    DEFAULT_CONTENT_URL_PARAM,
    readContentUrlParam,
    replaceContentUrlParam,
    runContentUrlHydrate,
} from '../../shared/cross/contentUrl';
import { initQueryHistoryDropdown, saveHistory } from '../../shared/cross/queryHistory';
import { createToast } from '../../shared/ui/toast';
import { translateApiErrorMessage } from '../../shared/core/errorUtils';
import { createAttributionInspector } from '../../shared/prediction_attribution/inspector/attributionInspector';
import type { AttributionDisplayOptions } from '../../shared/prediction_attribution/core/attributionDisplayModel';
import {
    buildCachedContentUrlParam,
    getCachedEntryByContentKey,
    listCachedHistoryRows,
    removeCachedEntryByContentKey,
    takeSuccessfulAttributionFromCache,
    touchCachedEntryByContentKey,
    type AttributionApiResponse,
    type AttributionCachedEntry,
    type PredictionAttributeModelVariant,
} from '../../shared/prediction_attribution/core/attributionResultCache';
import { loadPredictionAttributeWithCache } from '../../shared/prediction_attribution/core/predictionAttributeClient';
import { readStoredEffectiveExcludePromptPatternsText } from '../../shared/prediction_attribution/core/attributionExcludePromptPatternsStorage';
import { bindExcludePromptPatternsUi } from '../../shared/prediction_attribution/core/excludePromptPatternsUi';
import { syncDraftCommittedButtonPair } from '../../shared/cross/syncDraftCommittedButtonPair';
import { lsReadEnum, lsWriteString } from '../../shared/storage/localStorageHelpers';

d3.selectAll('.loadersmall').style('display', 'none');

initI18n();

const showToast = createToast('#toast').show;

const CONTEXT_HISTORY_KEY = 'info_radar_attribution_context_history';
const TARGET_HISTORY_KEY = 'info_radar_attribution_target_history';
const ATTRIBUTION_MODEL_VARIANT_STORAGE_KEY = 'info_radar_attribution_model_variant';

function readStoredAttributionPageModelVariant(): PredictionAttributeModelVariant {
    return lsReadEnum(ATTRIBUTION_MODEL_VARIANT_STORAGE_KEY, ['base', 'instruct'] as const, 'instruct');
}

const apiPrefix = URLHandler.parameters['api'] || '';
const bodyElement = d3.select('body').node() as Element;
const { eventHandler, totalSurprisalFormat, api } = initializeCommonApp(apiPrefix, bodyElement);
/** 与 {@link TextAnalysisAPI} 一致：`?api=` 非空时用其作为基址，否则 `''`，URL 为 `/api/...`（相对当前站点根路径） */
const apiBaseForRequests = apiPrefix === '' ? '' : String(apiPrefix);

const adminManager = AdminManager.getInstance();
api.setAdminToken(adminManager.isInAdminMode() ? adminManager.getAdminToken() : null);

// --- DOM 引用 ---
const contextField = d3.select('#context_text');
const contextCountValue = d3.select('#context_count_value');
const clearContextBtn = d3.select('#clear_context_btn');
const pasteContextBtn = d3.select('#paste_context_btn');
const contextHistoryBtn = document.getElementById('context_history_btn');

const targetField = d3.select('#target_text');
const targetCountValue = d3.select('#target_count_value');
const clearTargetBtn = d3.select('#clear_target_btn');
const pasteTargetBtn = d3.select('#paste_target_btn');
const targetHistoryBtn = document.getElementById('target_history_btn');

const analyzeBtn = d3.select('#analyze_btn');
const modelVariantSelect = document.getElementById('attribution_model_variant') as HTMLSelectElement | null;
const forceRetryBtn = d3.select('#force_retry_btn');
const loaderSmall = d3.select('.loadersmall');
const resultInfoEl = d3.select('#attribution_result_info');
const useMappingCheckbox = document.getElementById('attribution_use_mapping') as HTMLInputElement | null;
const maxScoreRange = document.getElementById('attribution_max_score_range') as HTMLInputElement | null;
const maxScoreValueEl = document.getElementById('attribution_max_score_value');
if (modelVariantSelect) {
    modelVariantSelect.value = readStoredAttributionPageModelVariant();
}

function currentAttributionModelVariant(): PredictionAttributeModelVariant {
    const v = modelVariantSelect?.value;
    return v === 'base' || v === 'instruct' ? v : 'instruct';
}

modelVariantSelect?.addEventListener('change', () => {
    lsWriteString(ATTRIBUTION_MODEL_VARIANT_STORAGE_KEY, currentAttributionModelVariant());
});

// --- TextInputController ---
new TextInputController({
    textField: contextField,
    textCountValue: contextCountValue,
    clearBtn: clearContextBtn,
    submitBtn: analyzeBtn,
    saveBtn: d3.select(null),
    pasteBtn: pasteContextBtn,
    totalSurprisalFormat,
    showAlertDialog,
});

new TextInputController({
    textField: targetField,
    textCountValue: targetCountValue,
    clearBtn: clearTargetBtn,
    submitBtn: analyzeBtn,
    saveBtn: d3.select(null),
    pasteBtn: pasteTargetBtn,
    totalSurprisalFormat,
    showAlertDialog,
});

const attributionInspector = createAttributionInspector({
    resultsRoot: d3.select('#results'),
    eventHandler,
    debugParentId: 'attribution_debug_container',
});

function readAttributionDisplayOptions(): AttributionDisplayOptions {
    return {
        colorRangeMax: readAttributionColorRangeMax(),
        excludePromptPatternsText: readStoredEffectiveExcludePromptPatternsText(),
    };
}

// --- 分析按钮状态管理（草稿 vs 已提交：右侧展示对应 lastCommittedInputs）---
let analyzeInFlight = false;
/** 当前右侧已展示的归因所对应的输入；null 表示尚未成功应用过任何结果 */
let lastCommittedInputs: { context: string; target: string } | null = null;

function syncAnalyzeButtonState(): void {
    const context = (contextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    const target = (targetField.node() as HTMLTextAreaElement | null)?.value ?? '';
    const idleInputsReady = context.length > 0 && target.length > 0;
    const hasUncommittedDraft =
        lastCommittedInputs === null ||
        context !== lastCommittedInputs.context ||
        target !== lastCommittedInputs.target;
    syncDraftCommittedButtonPair({
        primaryBtn: analyzeBtn,
        forceRetryBtn,
        inFlight: analyzeInFlight,
        primaryInFlightMode: 'freeze',
        primaryIdleLabel: tr('Analyze attribution'),
        idleInputsReady,
        hasUncommittedDraft,
    });
}

function setAnalyzeLoading(loading: boolean): void {
    analyzeInFlight = loading;
    loaderSmall.style('display', loading ? null : 'none');
    syncAnalyzeButtonState();
}

// input 事件同步按钮状态
[contextField, targetField].forEach((field) => {
    (field.node() as HTMLTextAreaElement | null)?.addEventListener('input', syncAnalyzeButtonState);
});
syncAnalyzeButtonState();

function syncMaxScoreRangeUiEnabled(): void {
    const on = !!useMappingCheckbox?.checked;
    if (maxScoreRange) maxScoreRange.disabled = !on;
}

function updateMaxScoreValueLabel(): void {
    if (!maxScoreRange || !maxScoreValueEl) return;
    const v = Number(maxScoreRange.value);
    maxScoreValueEl.textContent = Number.isFinite(v) ? v.toFixed(2) : '—';
}

syncMaxScoreRangeUiEnabled();
updateMaxScoreValueLabel();

useMappingCheckbox?.addEventListener('change', () => {
    syncMaxScoreRangeUiEnabled();
    reapplyAttributionColorsIfPossible();
});

maxScoreRange?.addEventListener('input', () => {
    updateMaxScoreValueLabel();
    reapplyAttributionColorsIfPossible();
});

/** 勾选「使用映射」且 x∈(0,1]：将已归一化到 [0,1] 的分数中，[0,x] 线性映射到 [0,1] 用于染色，>x 视为 1。未勾选则不设置 colorScores。x=1 时与未勾选等价（恒等染色）。 */
function readAttributionColorRangeMax(): number | null {
    if (!useMappingCheckbox?.checked) return null;
    if (!maxScoreRange) return null;
    const n = Number(maxScoreRange.value);
    if (!Number.isFinite(n) || n <= 0 || n > 1) return null;
    return n;
}

// --- 应用归因结果到 UI ---
function applyAttributionResponse(context: string, response: AttributionApiResponse): void {
    attributionInspector.apply(context, response, readAttributionDisplayOptions());
    updateResultInfo(response);
    lastCommittedInputs = {
        context: (contextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        target: (targetField.node() as HTMLTextAreaElement | null)?.value ?? '',
    };
    syncAnalyzeButtonState();
    replaceContentUrlParam(
        buildCachedContentUrlParam(lastCommittedInputs.context, lastCommittedInputs.target),
        DEFAULT_CONTENT_URL_PARAM,
        'attribution'
    );
}

function reapplyAttributionColorsIfPossible(): void {
    attributionInspector.reapply(readAttributionDisplayOptions());
}

bindExcludePromptPatternsUi({
    textInput: document.getElementById('attribution_exclude_prompt_patterns') as HTMLTextAreaElement | null,
    enableCheckbox: document.getElementById('attribution_exclude_prompt_patterns_enable') as HTMLInputElement | null,
    onEffectiveChange: reapplyAttributionColorsIfPossible,
});

function updateResultInfo(response: AttributionApiResponse): void {
    const n = response.token_attribution?.length ?? 0;
    const model = response.model ?? '–';
    resultInfoEl.classed('is-hidden', false).text(`${trf('{count} tokens', { count: n })}\n${tr('model')}: ${model}`);
}

// --- 主分析逻辑 ---
async function runAnalyze(options?: { forceRefresh?: boolean }): Promise<void> {
    const context = (contextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    const target = (targetField.node() as HTMLTextAreaElement | null)?.value ?? '';
    if (analyzeInFlight || !context || !target) return;

    const forceRefresh = options?.forceRefresh === true;

    if (!forceRefresh) {
        const hit = await takeSuccessfulAttributionFromCache(context, target);
        if (hit) {
            applyAttributionResponse(context, hit);
            saveHistory(context, CONTEXT_HISTORY_KEY);
            saveHistory(target, TARGET_HISTORY_KEY);
            return;
        }
    }

    setAnalyzeLoading(true);
    try {
        const json = await loadPredictionAttributeWithCache({
            apiBaseForRequests,
            context,
            targetPrediction: target,
            model: currentAttributionModelVariant(),
            sourcePage: 'attribution',
            forceRefresh,
        });
        applyAttributionResponse(context, json);
        saveHistory(context, CONTEXT_HISTORY_KEY);
        saveHistory(target, TARGET_HISTORY_KEY);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showAlertDialog(tr('Context Attribution'), translateApiErrorMessage(msg));
    } finally {
        setAnalyzeLoading(false);
    }
}

analyzeBtn.on('click', () => void runAnalyze());
forceRetryBtn.on('click', () => void runAnalyze({ forceRefresh: true }));

// Enter 键（Ctrl/Cmd + Enter）提交
(contextField.node() as HTMLTextAreaElement | null)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void runAnalyze();
});

// --- 历史下拉 ---
const contextTextarea = contextField.node() as HTMLTextAreaElement | null;
const targetTextarea = targetField.node() as HTMLTextAreaElement | null;

initQueryHistoryDropdown({
    input: contextTextarea,
    dropdownId: 'context_history_dropdown',
    storageKey: CONTEXT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncAnalyzeButtonState,
    historyButton: contextHistoryBtn,
    applyHistoryOnHover: true,
});

initQueryHistoryDropdown({
    input: targetTextarea,
    dropdownId: 'target_history_dropdown',
    storageKey: TARGET_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncAnalyzeButtonState,
    historyButton: targetHistoryBtn,
    applyHistoryOnHover: true,
});

async function restoreAttributionFromCachedEntry(
    entry: AttributionCachedEntry,
    options: { shouldTouch: boolean; ctx?: CachedHistorySelectContext; contentKey: string }
): Promise<void> {
    try {
        contextField.property('value', entry.context);
        targetField.property('value', entry.targetPrediction);
        contextTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        targetTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        syncAnalyzeButtonState();
        applyAttributionResponse(entry.context, entry.response);
        if (options.shouldTouch && options.ctx) {
            await touchCachedEntryByContentKey(options.contentKey);
            await options.ctx.refreshList();
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast(translateApiErrorMessage(msg), 'error');
    }
}

// --- Cached history ---
const cachedHistoryBtn = document.getElementById('attribution_cached_history_btn');
void initCachedHistoryQueryDropdown({
    dropdownId: 'attribution_cached_history_dropdown',
    historyButton: cachedHistoryBtn,
    clickOutsideRoot: document.getElementById('attribution_cached_history_dropdown'),
    listMru: listCachedHistoryRows,
    onSelectEntry: async (contentKey, shouldTouch, ctx) => {
        const entry = await getCachedEntryByContentKey(contentKey);
        if (!entry) {
            showToast(tr('Cached result not found'), 'error');
            return;
        }
        await restoreAttributionFromCachedEntry(entry, {
            shouldTouch: Boolean(shouldTouch),
            ctx,
            contentKey,
        });
    },
    onRemove: removeCachedEntryByContentKey,
    onPromote: touchCachedEntryByContentKey,
});

void runContentUrlHydrate({
    readRaw: readContentUrlParam,
    fetchEntry: getCachedEntryByContentKey,
    apply: async (entry, rawContentKey) => {
        await restoreAttributionFromCachedEntry(entry, { shouldTouch: false, contentKey: rawContentKey });
    },
    onMissing: async () => {
        showToast(tr('Cached result not found (link may be expired)'), 'error');
        replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'attribution');
    },
    onApplyError: (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        showToast(translateApiErrorMessage(msg), 'error');
        replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'attribution');
    },
});

initChatPanelLayout({ storageKey: PANEL_SPLIT_STORAGE_KEY_ATTRIBUTION });

const themeManager = initThemeManager(
    {
        onThemeChange: () => {
            reapplyAttributionColorsIfPossible();
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
