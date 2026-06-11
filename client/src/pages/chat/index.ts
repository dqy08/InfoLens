import * as d3 from 'd3';
import '../../shared/core/d3-polyfill';
import '../../css/pages/chat.scss';

import { initThemeManager } from '../../shared/ui/theme';
import { initLanguageManager } from '../../shared/ui/language';
import { initI18n, tr } from '../../shared/lang/i18n-lite';
import { AdminManager } from '../../shared/cross/adminManager';
import { SettingsMenuManager } from '../../shared/cross/settingsMenuManager';
import { initCachedHistoryQueryDropdown, type CachedHistorySelectContext } from '../../shared/cross/cachedHistoryUi';
import { syncChatPromptPanelEnableGatedBody } from '../../features/chat/chatPromptPanelUi';
import { initChatPanelLayout } from '../../shared/ui/chat_panel_layout';
import { PANEL_SPLIT_STORAGE_KEY_CHAT } from '../../shared/cross/panelSplitStorage';
import { TextInputController } from '../../shared/controllers/textInputController';
import { initializeCommonApp } from '../../shared/bootstrap';
import { registerPageBusy } from '../../shared/core/activitySession';
import { showAlertDialog } from '../../shared/ui/dialog';
import URLHandler from '../../shared/core/URLHandler';
import { ToolTip } from '../../shared/vis/ToolTip';
import { GLTR_HoverEvent, GLTR_Text_Box } from '../../shared/vis/GLTR_Text_Box';
import {
    postCompletions,
    postCompletionsPrompt,
    postCompletionsStop,
    type OpenAICompletionsResponse
} from '../../shared/api/completionsClient';
import { translateApiErrorMessage } from '../../shared/core/errorUtils';
import { buildInitialChatMessages } from '../../features/chat/chatMessages';
import type { ChatDisplaySegment } from '../../features/chat/chatSegments';
import {
    MAX_TOOL_ROUNDS,
    assembleFirstTurnPrompt,
    runMultiTurnToolCalling,
} from '../../features/chat/multiTurnToolCalling';
import { aggregateUsageFromSegments } from '../../features/chat/chatCompletionUsage';
import { assertStreamMatchesFinal } from '../../features/chat/completionStreamAssert';
import { ChatTurnsView } from '../../features/chat/chatTurnsView';
import { createToolCallingOptionsRow } from '../../features/chat/toolCallingOptionsRow';
import { cloneToolConfig, toolConfigFingerprint } from '../../features/chat/toolConfig';
import type { PredictionAttributeModelVariant } from '../../shared/prediction_attribution/core/attributionResultCache';
import { createCompletionOptionsRow } from '../../shared/cross/completionOptionsRow';
import { completionFinishReasonLabel } from '../../shared/cross/generationEndReasonLabel';
import { addDigitsMergeRenderListener } from '../../shared/cross/digitsMergeManager';
import {
    CHAT_RAW_INPUT_HISTORY_KEY,
    CHAT_SYSTEM_INPUT_HISTORY_KEY,
    CHAT_TEACHER_FORCING_INPUT_HISTORY_KEY,
    CHAT_USER_INPUT_HISTORY_KEY,
    initQueryHistoryDropdown,
    saveHistory
} from '../../shared/cross/queryHistory';
import {
    buildCompletionCacheKey,
    getCachedEntryByContentKey,
    getEntry as getCompletionCacheEntry,
    listCachedHistoryRows,
    migrateLegacyChatCacheIfNeeded,
    removeCachedEntryByContentKey,
    removeForCacheKey,
    save as saveCompletionToCache,
    touchCachedEntryByContentKey,
    type ChatCompletionDraft,
    type CompletionCachedEntry,
    type CompletionResultCacheKey,
} from '../../features/chat/completionResultCache';
import {
    DEFAULT_CONTENT_URL_PARAM,
    readContentUrlParam,
    replaceContentUrlParam,
    runContentUrlHydrate,
} from '../../shared/cross/contentUrl';
import { updateChatCompletionMetrics } from '../../shared/cross/textMetricsUpdater';
import { lsReadBool, lsSet, lsWriteBool, lsWriteString } from '../../shared/storage/localStorageHelpers';
import {
    CHAT_ENABLE_THINKING_STORAGE_KEY,
    CHAT_ENABLE_TOOL_CALLING_STORAGE_KEY,
    CHAT_MAX_NEW_TOKENS_STORAGE_KEY,
    CHAT_MODEL_VARIANT_STORAGE_KEY,
    CHAT_MULTI_TURN_MOCK_STORAGE_KEY,
    LS_SKIP_CHAT_TEMPLATE,
} from '../../features/chat/chatPromptTemplateMode';
import { createToast } from '../../shared/ui/toast';
import { initDensityAttributionSidebar } from '../../shared/prediction_attribution/density_sidebar/densityAttributionSidebar';
import { syncDraftCommittedButtonPair } from '../../shared/cross/syncDraftCommittedButtonPair';
import { syncMaxNewTokensInputSiteMax } from '../../shared/cross/maxNewTokensConfig';

// 与首页一致：默认隐藏 Ask 旁的小菊花，仅在请求进行中再显示
d3.selectAll('.loadersmall').style('display', 'none');

initI18n();
void migrateLegacyChatCacheIfNeeded();

const showToast = createToast('#toast').show;

const apiPrefix = URLHandler.parameters['api'] || '';
const bodyElement = d3.select('body').node() as Element;
const { eventHandler, totalSurprisalFormat, api } = initializeCommonApp(apiPrefix, bodyElement);

const adminManager = AdminManager.getInstance();
api.setAdminToken(adminManager.isInAdminMode() ? adminManager.getAdminToken() : null);

const textField = d3.select('#test_text');
const textCountValue = d3.select('#text_count_value');
const chatSystemTextField = d3.select('#chat_system_text');
const chatSystemTextCountValue = d3.select('#chat_system_text_count_value');
const chatUserTextField = d3.select('#chat_user_text');
const chatUserTextCountValue = d3.select('#chat_user_text_count_value');
const metricUsage = d3.select('#metric_usage');
const metricModel = d3.select('#metric_model');
const chatCompleteReasonEl = d3.select('#chat_complete_reason');
const clearBtn = d3.select('#clear_text_btn');
const chatSystemClearBtn = d3.select('#chat_system_clear_text_btn');
const chatUserClearBtn = d3.select('#chat_user_clear_text_btn');
const submitBtn = d3.select('#submit_text_btn');
const forceRetryBtn = d3.select('#force_retry_btn');
const pasteBtn = d3.select('#paste_text_btn');
const chatSystemPasteBtn = d3.select('#chat_system_paste_text_btn');
const chatUserPasteBtn = d3.select('#chat_user_paste_text_btn');
const rawInputHistoryBtn = document.getElementById('chat_raw_input_history_btn');
const chatSystemHistoryBtn = document.getElementById('chat_system_prompt_history_btn');
const chatUserHistoryBtn = document.getElementById('chat_user_prompt_history_btn');
const loaderSmall = d3.select('.loadersmall');

const rawInputPanel = document.getElementById('raw_input_panel');
const chatInputPanel = document.getElementById('chat_input_panel');

const skipChatTemplateInput = document.getElementById(
    'chat_skip_chat_template'
) as HTMLInputElement | null;
const chatUseSystemPromptInput = document.getElementById(
    'chat_use_system_prompt'
) as HTMLInputElement | null;
const chatSystemPromptPanel = document.getElementById('chat_system_prompt_panel');
const enableThinkingInput = document.getElementById(
    'chat_enable_thinking'
) as HTMLInputElement | null;
const teacherForcingTextField = d3.select('#chat_teacher_forcing_text');
const teacherForcingTextCountValue = d3.select('#chat_teacher_forcing_text_count_value');
const clearTeacherForcingBtn = d3.select('#chat_clear_teacher_forcing_btn');
const pasteTeacherForcingBtn = d3.select('#chat_paste_teacher_forcing_btn');
const teacherForcingHistoryBtn = document.getElementById('chat_teacher_forcing_history_btn');
const chatTeacherForcingEnable = document.getElementById(
    'chat_teacher_forcing_enable'
) as HTMLInputElement | null;
const chatTeacherForcingBlock = document.getElementById('chat_teacher_forcing_block');

function isSkipChatTemplate(): boolean {
    return skipChatTemplateInput?.checked ?? false;
}

function isChatUseSystemPrompt(): boolean {
    return chatUseSystemPromptInput?.checked ?? true;
}

function isEnableThinking(): boolean {
    return enableThinkingInput?.checked ?? false;
}

function isChatTeacherForcingUiOn(): boolean {
    return chatTeacherForcingEnable?.checked ?? false;
}

/** 勾选 Teacher forcing 且续写非空时返回原文；未勾选或空串时返回 `undefined`。 */
function teacherForcingContinuationForRun(): string | undefined {
    if (!isChatTeacherForcingUiOn()) return undefined;
    const t = (teacherForcingTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    return t.length > 0 ? t : undefined;
}

function syncTeacherForcingRow(): void {
    if (chatTeacherForcingBlock) {
        chatTeacherForcingBlock.hidden = !isChatTeacherForcingUiOn();
    }
}

function syncChatSystemPromptSuppressedUi(): void {
    syncChatPromptPanelEnableGatedBody(chatSystemPromptPanel, isChatUseSystemPrompt());
}

function syncPromptPanelVisibility(): void {
    const skip = isSkipChatTemplate();
    if (rawInputPanel) rawInputPanel.hidden = !skip;
    if (chatInputPanel) chatInputPanel.hidden = skip;
}

const DEFAULT_CHAT_MODEL_VARIANT: PredictionAttributeModelVariant = 'instruct';

function resolveStoredModelVariant(v?: PredictionAttributeModelVariant): PredictionAttributeModelVariant {
    return v === 'base' || v === 'instruct' ? v : DEFAULT_CHAT_MODEL_VARIANT;
}

const chatRightStack = d3.select('.chat-right-stack');
const chatStreamingPreviewEl = d3.select('#chat_streaming_preview');
const chatSegmentsContainer = document.getElementById('chat_segments_container');

async function copyChatFullText(): Promise<void> {
    const text = chatTurnsView.getFullTextForCopy();
    if (!text) {
        showToast('Nothing to copy', 'error');
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        showToast('Copied to clipboard', 'success');
    } catch {
        showToast('Failed to copy to clipboard', 'error');
    }
}

new TextInputController({
    textField,
    textCountValue,
    clearBtn,
    submitBtn,
    saveBtn: forceRetryBtn,
    pasteBtn,
    totalSurprisalFormat,
    showAlertDialog
});

new TextInputController({
    textField: chatSystemTextField,
    textCountValue: chatSystemTextCountValue,
    clearBtn: chatSystemClearBtn,
    submitBtn,
    saveBtn: forceRetryBtn,
    pasteBtn: chatSystemPasteBtn,
    totalSurprisalFormat,
    showAlertDialog
});

new TextInputController({
    textField: chatUserTextField,
    textCountValue: chatUserTextCountValue,
    clearBtn: chatUserClearBtn,
    submitBtn,
    saveBtn: forceRetryBtn,
    pasteBtn: chatUserPasteBtn,
    totalSurprisalFormat,
    showAlertDialog
});

new TextInputController({
    textField: teacherForcingTextField,
    textCountValue: teacherForcingTextCountValue,
    clearBtn: clearTeacherForcingBtn,
    submitBtn,
    saveBtn: forceRetryBtn,
    pasteBtn: pasteTeacherForcingBtn,
    totalSurprisalFormat,
    showAlertDialog
});

const toolTip = new ToolTip(d3.select('#major_tooltip'), eventHandler, {
    surprisalRowLabel: tr('log perplexity:')
});

if (!chatSegmentsContainer) {
    throw new Error('chat_segments_container missing');
}
const chatTurnsView = new ChatTurnsView(chatSegmentsContainer, eventHandler);

eventHandler.bind(GLTR_Text_Box.events.tokenHovered, (ev: GLTR_HoverEvent) => {
    if (ev.hovered) {
        toolTip.updateData(ev.d, ev.event);
    } else {
        toolTip.visibility = false;
    }
});

d3.select('body').on('touchstart', () => {
    toolTip.hideAndReset();
});

const urlModelParam = URLHandler.parameters['model'];
const urlModelVariant: PredictionAttributeModelVariant | null =
    urlModelParam === 'base' || urlModelParam === 'instruct' ? urlModelParam : null;

let askAbort: AbortController | null = null;
let askInFlight = false;
let currentPromptUsed = '';

/** 流式预览 DOM 刷新最短间隔（毫秒），短于此间隔则跳过本次刷新（末条 stream_end 仍强制刷新） */
const STREAMING_PREVIEW_MIN_INTERVAL_MS = 10;

/** 上次 flushStreamingPreview 的时间戳；新请求置 0 使首包必刷 */
let streamingPreviewLastFlush = 0;

/** 最近一次成功续写结果，供 digit merge 等设置变更时重算渲染 */
let lastCompletionForRerender: {
    res: OpenAICompletionsResponse;
    promptUsed: string;
    modelVariant?: PredictionAttributeModelVariant;
    contentUrlKey: string;
    segments: ChatDisplaySegment[];
} | null = null;

type ChatTfFingerprintFields = {
    tfOn: boolean;
    tfText: string;
};

/** 右侧已展示结果对应的左侧输入快照（与 Context Attribution 页 lastCommittedInputs 同类） */
type ChatCommittedFingerprint =
    | ({ skipTemplate: true; raw: string; maxTokens: string; model: PredictionAttributeModelVariant } &
          ChatTfFingerprintFields)
    | ({
          skipTemplate: false;
          user: string;
          system: string;
          useSystem: boolean;
          enableThinking: boolean;
          toolCallingEnabled: boolean;
          multiTurnMockEnabled: boolean;
          toolConfig: string;
          maxTokens: string;
          model: PredictionAttributeModelVariant;
      } & ChatTfFingerprintFields);

let lastCommittedFingerprint: ChatCommittedFingerprint | null = null;

const completionOptions = createCompletionOptionsRow({
    isSkipChatTemplate,
    metricModel,
    alertDialogTitle: tr('LLM Raw Chat'),
    onStateChange: () => syncAskButtonState(),
    adminMode: () => adminManager.isInAdminMode(),
    modelVariantStorageKey: CHAT_MODEL_VARIANT_STORAGE_KEY,
    maxNewTokensStorageKey: CHAT_MAX_NEW_TOKENS_STORAGE_KEY,
    urlModelVariant,
});

const {
    maxTokensInput,
    modelVariantSelect,
    currentModelVariant,
    currentMaxTokens,
    parseMaxNewTokensFromField,
    isMaxNewTokensInputValid,
    syncModelVariantUi,
    syncIdleModelMetric,
    syncMaxTokensUi,
    normalizeMaxTokensField,
} = completionOptions;

const toolCallingOptions = createToolCallingOptionsRow({
    enableToolCallingStorageKey: CHAT_ENABLE_TOOL_CALLING_STORAGE_KEY,
    multiTurnStorageKey: CHAT_MULTI_TURN_MOCK_STORAGE_KEY,
    onStateChange: () => syncAskButtonState(),
});

const {
    isToolCallingEnabled,
    isMultiTurnEnabled: isMultiTurnMockEnabled,
    getCurrentToolConfig,
    restoreFromDraft: restoreToolCallingFromDraft,
} = toolCallingOptions;

function buildChatRunDraftForCache(): ChatCompletionDraft {
    const maxTokens = currentMaxTokens();
    const teacherForcingText = teacherForcingContinuationForRun();
    const tfDraftFields =
        teacherForcingText !== undefined ? { teacherForcing: teacherForcingText } : {};
    if (isSkipChatTemplate()) {
        return {
            mode: 'raw',
            model: currentModelVariant(),
            maxTokens,
            raw: (textField.node() as HTMLTextAreaElement | null)?.value ?? '',
            ...tfDraftFields,
        };
    }
    return {
        mode: 'chat',
        model: 'instruct',
        maxTokens,
        system: (chatSystemTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        user: (chatUserTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        useSystem: isChatUseSystemPrompt(),
        enableThinking: isEnableThinking(),
        toolCallingEnabled: isToolCallingEnabled(),
        multiTurnMockEnabled: isMultiTurnMockEnabled(),
        toolConfig: cloneToolConfig(getCurrentToolConfig()),
        ...tfDraftFields,
    };
}

/** 从缓存 draft 还原左侧面板（仅含 draft 的新条目；与 causal_flow applyGenAttrCachedRun 对齐） */
function applyChatDraftFromCache(draft: ChatCompletionDraft, entry: CompletionCachedEntry): void {
    if (draft.mode === 'chat') {
        if (skipChatTemplateInput) {
            skipChatTemplateInput.checked = false;
            lsWriteBool(LS_SKIP_CHAT_TEMPLATE, false);
        }
        syncPromptPanelVisibility();
        syncChatSystemPromptSuppressedUi();
        if (chatUseSystemPromptInput) {
            chatUseSystemPromptInput.checked = draft.useSystem ?? true;
        }
        chatSystemTextField.property('value', draft.system ?? '');
        chatSystemPromptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        chatUserTextField.property('value', draft.user ?? '');
        chatUserPromptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        if (enableThinkingInput) {
            enableThinkingInput.checked = draft.enableThinking ?? false;
            lsWriteBool(CHAT_ENABLE_THINKING_STORAGE_KEY, enableThinkingInput.checked);
        }
        restoreToolCallingFromDraft(draft);
    } else if (draft.mode === 'raw') {
        if (skipChatTemplateInput) {
            skipChatTemplateInput.checked = true;
            lsWriteBool(LS_SKIP_CHAT_TEMPLATE, true);
        }
        syncPromptPanelVisibility();
        textField.property('value', draft.raw ?? entry.promptUsed);
        promptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
        const model = resolveStoredModelVariant(draft.model);
        if (modelVariantSelect) {
            modelVariantSelect.value = model;
            lsWriteString(CHAT_MODEL_VARIANT_STORAGE_KEY, model);
        }
    }

    syncModelVariantUi();
    if (draft.maxTokens != null) {
        if (maxTokensInput) {
            maxTokensInput.value = String(draft.maxTokens);
        }
        lsSet(CHAT_MAX_NEW_TOKENS_STORAGE_KEY, String(draft.maxTokens));
        syncMaxNewTokensInputSiteMax(maxTokensInput, adminManager.isInAdminMode());
    } else {
        syncMaxTokensUi();
    }
    normalizeMaxTokensField();

    const tfFromRec = draft?.teacherForcing ?? '';
    if (chatTeacherForcingEnable) {
        chatTeacherForcingEnable.checked = tfFromRec.length > 0;
    }
    teacherForcingTextField.property('value', tfFromRec);
    teacherForcingTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
    syncTeacherForcingRow();
}

function chatTfFingerprintFields(): ChatTfFingerprintFields {
    return {
        tfOn: isChatTeacherForcingUiOn(),
        tfText: (teacherForcingTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
    };
}

function getCurrentFingerprint(): ChatCommittedFingerprint {
    const maxTokens = maxTokensInput?.value ?? '';
    const model = currentModelVariant();
    const tf = chatTfFingerprintFields();
    if (isSkipChatTemplate()) {
        return {
            skipTemplate: true,
            raw: (textField.node() as HTMLTextAreaElement | null)?.value ?? '',
            maxTokens,
            model,
            ...tf,
        };
    }
    return {
        skipTemplate: false,
        user: (chatUserTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        system: (chatSystemTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        useSystem: isChatUseSystemPrompt(),
        enableThinking: isEnableThinking(),
        toolCallingEnabled: isToolCallingEnabled(),
        multiTurnMockEnabled: isMultiTurnMockEnabled(),
        toolConfig: toolConfigFingerprint(getCurrentToolConfig()),
        maxTokens,
        model,
        ...tf,
    };
}

function fingerprintsEqual(a: ChatCommittedFingerprint, b: ChatCommittedFingerprint): boolean {
    if (a.tfOn !== b.tfOn || a.tfText !== b.tfText) {
        return false;
    }
    if (a.skipTemplate && b.skipTemplate) {
        return a.raw === b.raw && a.maxTokens === b.maxTokens && a.model === b.model;
    }
    if (!a.skipTemplate && !b.skipTemplate) {
        const ta = a as Extract<ChatCommittedFingerprint, { skipTemplate: false }>;
        const tb = b as Extract<ChatCommittedFingerprint, { skipTemplate: false }>;
        return (
            ta.user === tb.user &&
            ta.system === tb.system &&
            ta.useSystem === tb.useSystem &&
            ta.enableThinking === tb.enableThinking &&
            ta.toolCallingEnabled === tb.toolCallingEnabled &&
            ta.multiTurnMockEnabled === tb.multiTurnMockEnabled &&
            ta.toolConfig === tb.toolConfig &&
            ta.maxTokens === tb.maxTokens &&
            ta.model === tb.model
        );
    }
    return false;
}

/** 当前输入是否满足可以发起 Ask（不含 inFlight）。 */
function isAskInputsReady(): boolean {
    if (!isMaxNewTokensInputValid()) return false;
    const prompt = getActivePromptValue();
    const forcing = teacherForcingContinuationForRun();
    if (prompt.length === 0 && forcing === undefined) return false;
    if (prompt.length > 0 && isChatTeacherForcingUiOn() && forcing === undefined) return false;
    return true;
}

function syncAskButtonState(): void {
    const fp = getCurrentFingerprint();
    const idleInputsReady = isAskInputsReady();
    const hasUncommittedDraft =
        lastCommittedFingerprint === null ||
        !fingerprintsEqual(lastCommittedFingerprint, fp);
    syncDraftCommittedButtonPair({
        primaryBtn: submitBtn,
        forceRetryBtn,
        inFlight: askInFlight,
        primaryInFlightMode: 'stop',
        primaryInFlightLabel: tr('Stop'),
        primaryIdleLabel: tr('Ask'),
        idleInputsReady,
        hasUncommittedDraft,
    });
}

function buildSingleTurnSegments(
    modelPrompt: string,
    res: OpenAICompletionsResponse,
    model: PredictionAttributeModelVariant
): ChatDisplaySegment[] {
    const finalText = res.choices?.[0]?.text;
    if (typeof finalText !== 'string') {
        throw new Error('续写响应缺少 choices[0].text');
    }
    return [
        { kind: 'input', text: modelPrompt },
        {
            kind: 'output',
            text: finalText,
            promptUsed: modelPrompt,
            response: res,
            modelName: res.model ?? model,
        },
    ];
}

function segmentsFromEntryOrFallback(
    res: OpenAICompletionsResponse,
    promptUsed: string,
    modelVariant?: PredictionAttributeModelVariant,
    segments?: ChatDisplaySegment[]
): ChatDisplaySegment[] {
    if (segments && segments.length > 0) {
        return segments;
    }
    return buildSingleTurnSegments(promptUsed, res, modelVariant ?? 'instruct');
}

function syncUsageMetricsFromSegments(
    segments: ChatDisplaySegment[],
    modelFallback: string | null
): void {
    const usage = aggregateUsageFromSegments(segments);
    if (usage === null) return;
    const lastModel =
        [...segments]
            .reverse()
            .find((s): s is Extract<ChatDisplaySegment, { kind: 'output' }> => s.kind === 'output')
            ?.modelName ?? modelFallback;
    updateChatCompletionMetrics(metricUsage, metricModel, lastModel, usage);
}

function saveChatPromptHistories(
    prompt: string,
    skipTemplate: boolean,
    teacherForcingText: string | undefined
): void {
    if (skipTemplate) {
        saveHistory(prompt, CHAT_RAW_INPUT_HISTORY_KEY);
    } else {
        saveHistory(prompt, CHAT_USER_INPUT_HISTORY_KEY);
        if (isChatUseSystemPrompt()) {
            const systemForHistory =
                (chatSystemTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
            if (systemForHistory.length > 0) {
                saveHistory(systemForHistory, CHAT_SYSTEM_INPUT_HISTORY_KEY);
            }
        }
    }
    if (teacherForcingText !== undefined) {
        saveHistory(teacherForcingText, CHAT_TEACHER_FORCING_INPUT_HISTORY_KEY);
    }
}

/** 仅重绘右侧可视化；不修改 `?content=`（主题 / digit merge 等） */
function renderCompletionResultToUi(
    res: OpenAICompletionsResponse,
    promptUsed: string,
    segments?: ChatDisplaySegment[],
    modelVariant?: PredictionAttributeModelVariant
): void {
    currentPromptUsed = promptUsed;
    clearStreamingPreview();
    const segs = segmentsFromEntryOrFallback(res, promptUsed, modelVariant, segments);
    chatTurnsView.render(segs);
    const usage = aggregateUsageFromSegments(segs);
    updateChatCompletionMetrics(metricUsage, metricModel, res.model ?? null, usage);
    chatCompleteReasonEl.text(completionFinishReasonLabel(res.choices?.[0]?.finish_reason));
}

/**
 * Ask 成功或从 Cached history 恢复：更新可视化，并将 URL 设为 IndexedDB 条目的 contentKey。
 * contentUrlKey 必须来自 save 返回值、下拉列表 id 或 `?content=` hydrate，不得在 UI 层由 prompt+model 重算。
 */
function applyCompletionResponseToUi(
    res: OpenAICompletionsResponse,
    promptUsed: string,
    contentUrlKey: string,
    modelVariant?: PredictionAttributeModelVariant,
    segments?: ChatDisplaySegment[]
): void {
    const segs = segmentsFromEntryOrFallback(res, promptUsed, modelVariant, segments);
    renderCompletionResultToUi(res, promptUsed, segs, modelVariant);
    lastCompletionForRerender = {
        res,
        promptUsed,
        modelVariant,
        contentUrlKey,
        segments: segs,
    };
    replaceContentUrlParam(contentUrlKey, DEFAULT_CONTENT_URL_PARAM, 'chat');
    lastCommittedFingerprint = getCurrentFingerprint();
    syncAskButtonState();
}

function rerenderLastCompletionResult(): void {
    if (!lastCompletionForRerender) return;
    const { res, promptUsed, modelVariant, segments } = lastCompletionForRerender;
    renderCompletionResultToUi(res, promptUsed, segments, modelVariant);
}

addDigitsMergeRenderListener(rerenderLastCompletionResult);

const themeManager = initThemeManager(
    {
        onThemeChange: () => {
            if (lastCompletionForRerender) {
                rerenderLastCompletionResult();
            } else {
                chatTurnsView.rerender();
            }
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

adminManager.onAdminModeChange(() => {
    api.setAdminToken(adminManager.isInAdminMode() ? adminManager.getAdminToken() : null);
    syncMaxTokensUi();
    normalizeMaxTokensField();
});

const clearStreamingPreview = (): void => {
    streamingPreviewLastFlush = 0;
    chatStreamingPreviewEl.text('').attr('hidden', 'true');
};

const flushStreamingPreview = (text: string, streamEnd: boolean): void => {
    if (
        !streamEnd &&
        Date.now() - streamingPreviewLastFlush < STREAMING_PREVIEW_MIN_INTERVAL_MS
    ) {
        return;
    }
    chatStreamingPreviewEl.text(text).attr('hidden', null);
    streamingPreviewLastFlush = Date.now();
};

const getActivePromptValue = (): string => {
    if (isSkipChatTemplate()) {
        return (textField.node() as HTMLTextAreaElement | null)?.value ?? '';
    }
    return (chatUserTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
};

const setAskLoading = (loading: boolean): void => {
    askInFlight = loading;
    loaderSmall.style('display', loading ? null : 'none');
    chatRightStack.classed('chat-ask-in-flight', loading);
    if (loading) {
        lastCompletionForRerender = null;
        clearStreamingPreview();
        chatCompleteReasonEl.text('');
        chatTurnsView.clear();
    }
    syncAskButtonState();
};

registerPageBusy(() => askInFlight);

async function executeMultiTurnAsk(options: {
    prompt: string;
    model: PredictionAttributeModelVariant;
    maxTokens: number;
    teacherForcingText: string | undefined;
    forceRefresh: boolean;
    signal: AbortSignal;
}): Promise<void> {
    const { prompt, model, maxTokens, teacherForcingText, forceRefresh, signal } = options;
    const useSystem = isChatUseSystemPrompt();
    const systemRaw = (chatSystemTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
    const messages = buildInitialChatMessages({
        user: prompt,
        system: systemRaw,
        useSystem,
    });
    const toolConfig = getCurrentToolConfig();
    const modelPrompt = await assembleFirstTurnPrompt({
        model,
        messages,
        toolConfig,
        enableThinking: isEnableThinking(),
        teacherForcing: teacherForcingText,
        signal,
    });
    const cacheKey = buildCompletionCacheKey(modelPrompt, model, true);
    const cacheDraft = buildChatRunDraftForCache();

    if (forceRefresh) {
        await removeForCacheKey(cacheKey);
    } else {
        const cached = await getCompletionCacheEntry(cacheKey);
        if (cached?.segments?.length) {
            const lastOutput = [...cached.segments]
                .reverse()
                .find(
                    (s): s is Extract<ChatDisplaySegment, { kind: 'output' }> => s.kind === 'output'
                );
            if (lastOutput) {
                const cachedText = lastOutput.response.choices?.[0]?.text;
                if (typeof cachedText === 'string') {
                    flushStreamingPreview(cachedText, true);
                }
                saveChatPromptHistories(prompt, false, teacherForcingText);
                applyCompletionResponseToUi(
                    lastOutput.response,
                    modelPrompt,
                    cached.contentKey,
                    model,
                    cached.segments
                );
                return;
            }
        }
    }

    let streamRound = 0;
    let roundStreamed = '';
    const run = await runMultiTurnToolCalling({
        model,
        messages,
        toolConfig,
        enableThinking: isEnableThinking(),
        maxTokens,
        teacherForcing: teacherForcingText,
        signal,
        onSegmentsUpdate: (segs) => {
            clearStreamingPreview();
            chatTurnsView.render(segs);
            syncUsageMetricsFromSegments(segs, model);
        },
        onDelta: (chunk, streamEnd, roundIndex) => {
            if (roundIndex !== streamRound) {
                streamRound = roundIndex;
                roundStreamed = '';
                clearStreamingPreview();
            }
            roundStreamed += chunk;
            flushStreamingPreview(roundStreamed, streamEnd);
        },
        onPartialAbort: ({ segments: partialSegs, inFlightText, inFlightPromptUsed }) => {
            if (partialSegs.length === 0 && inFlightText.length === 0) {
                return;
            }
            const segmentsToSave: ChatDisplaySegment[] = [...partialSegs];
            let response: OpenAICompletionsResponse;
            if (inFlightText.length > 0) {
                response = {
                    id: `partial-${Date.now()}`,
                    object: 'text_completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ text: inFlightText, index: 0, finish_reason: 'abort' }],
                };
                segmentsToSave.push({
                    kind: 'output',
                    text: inFlightText,
                    promptUsed: inFlightPromptUsed,
                    response,
                    modelName: model,
                });
            } else {
                const lastOut = [...segmentsToSave]
                    .reverse()
                    .find(
                        (s): s is Extract<ChatDisplaySegment, { kind: 'output' }> =>
                            s.kind === 'output'
                    );
                if (!lastOut) return;
                response = lastOut.response;
            }
            void saveCompletionToCache(cacheKey, response, 'partial', cacheDraft, {
                segments: segmentsToSave,
            });
        },
    });

    const lastOutput = [...run.segments]
        .reverse()
        .find((s): s is Extract<ChatDisplaySegment, { kind: 'output' }> => s.kind === 'output');
    if (!lastOutput) {
        throw new Error('Multi-turn run missing output segment');
    }
    const res = lastOutput.response;

    if (run.truncatedAtMaxRounds) {
        showToast(
            tr('Tool calling reached max rounds ({max})').replace('{max}', String(MAX_TOOL_ROUNDS)),
            'success'
        );
    }

    saveChatPromptHistories(prompt, false, teacherForcingText);

    const { contentKey } = await saveCompletionToCache(cacheKey, res, 'complete', cacheDraft, {
        segments: run.segments,
    });
    applyCompletionResponseToUi(res, modelPrompt, contentKey, model, run.segments);
}

const runAsk = async (options?: { forceRefresh?: boolean }): Promise<void> => {
    const prompt = getActivePromptValue();
    if (askInFlight || !isAskInputsReady()) return;
    const forceRefresh = options?.forceRefresh === true;
    const teacherForcingText = teacherForcingContinuationForRun();

    let maxTokensOpt: number;
    try {
        maxTokensOpt = parseMaxNewTokensFromField();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        showAlertDialog(tr('LLM Raw Chat'), translateApiErrorMessage(msg));
        return;
    }

    askAbort?.abort();
    askAbort = new AbortController();
    setAskLoading(true);

    try {
        let streamedText = '';
        const skipTemplate = skipChatTemplateInput?.checked ?? false;
        const model = currentModelVariant();

        const useMultiTurn =
            !skipTemplate && isToolCallingEnabled() && isMultiTurnMockEnabled();

        if (useMultiTurn) {
            await executeMultiTurnAsk({
                prompt,
                model,
                maxTokens: maxTokensOpt,
                teacherForcingText,
                forceRefresh,
                signal: askAbort.signal,
            });
            return;
        }

        let modelPrompt: string;
        if (skipTemplate) {
            modelPrompt = prompt;
        } else {
            const useSystem = isChatUseSystemPrompt();
            const systemRaw =
                (chatSystemTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
            const messages = buildInitialChatMessages({
                user: prompt,
                system: systemRaw,
                useSystem,
            });
            const tools = isToolCallingEnabled() ? getCurrentToolConfig().tools_schema : undefined;
            const assembled = await postCompletionsPrompt(
                {
                    model,
                    messages,
                    tools,
                    enable_thinking: isEnableThinking() ? true : undefined,
                },
                { signal: askAbort.signal }
            );
            modelPrompt = assembled.prompt_used;
        }

        if (teacherForcingText !== undefined) {
            modelPrompt += teacherForcingText;
        }

        chatTurnsView.render([{ kind: 'input', text: modelPrompt }]);

        saveChatPromptHistories(prompt, skipTemplate, teacherForcingText);

        const cacheKey = buildCompletionCacheKey(modelPrompt, model, false);
        const cacheDraft = buildChatRunDraftForCache();

        const { response: res, contentKey, cachedSegments } = await postCompletions(
            {
                model,
                prompt: modelPrompt,
                max_tokens: maxTokensOpt
            },
            {
                signal: askAbort.signal,
                cacheKey,
                cacheDraft,
                forceRefresh,
                onDelta: (chunk, streamEnd) => {
                    streamedText += chunk;
                    flushStreamingPreview(streamedText, streamEnd);
                }
            }
        );
        if (!contentKey) {
            throw new Error('Chat completion cache: missing contentKey after successful request');
        }
        const finalText = res.choices?.[0]?.text;
        if (typeof finalText !== 'string') {
            throw new Error('Completion response missing choices[0].text');
        }
        assertStreamMatchesFinal(streamedText, finalText);
        const segments = cachedSegments?.length
            ? cachedSegments
            : buildSingleTurnSegments(modelPrompt, res, model);
        applyCompletionResponseToUi(res, modelPrompt, contentKey, model, segments);
    } catch (err: unknown) {
        if (
            err &&
            typeof err === 'object' &&
            'name' in err &&
            (err as { name: string }).name === 'AbortError'
        ) {
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        showAlertDialog(tr('LLM Raw Chat'), translateApiErrorMessage(msg));
    } finally {
        streamingPreviewLastFlush = 0;
        setAskLoading(false);
    }
};

if (skipChatTemplateInput) {
    skipChatTemplateInput.checked = lsReadBool(LS_SKIP_CHAT_TEMPLATE, false);
    skipChatTemplateInput.addEventListener('change', () => {
        lsWriteBool(LS_SKIP_CHAT_TEMPLATE, skipChatTemplateInput.checked);
        syncPromptPanelVisibility();
        syncChatSystemPromptSuppressedUi();
        syncModelVariantUi();
        syncAskButtonState();
    });
}
if (enableThinkingInput) {
    enableThinkingInput.checked = lsReadBool(CHAT_ENABLE_THINKING_STORAGE_KEY, false);
    enableThinkingInput.addEventListener('change', () => {
        lsWriteBool(CHAT_ENABLE_THINKING_STORAGE_KEY, enableThinkingInput.checked);
        syncAskButtonState();
    });
}
syncPromptPanelVisibility();
syncModelVariantUi();
syncIdleModelMetric();
syncChatSystemPromptSuppressedUi();
chatUseSystemPromptInput?.addEventListener('change', () => {
    syncChatSystemPromptSuppressedUi();
    syncAskButtonState();
});
syncAskButtonState();

chatTeacherForcingEnable?.addEventListener('change', () => {
    syncTeacherForcingRow();
    syncAskButtonState();
});
syncTeacherForcingRow();

const teacherForcingTextarea = teacherForcingTextField.node() as HTMLTextAreaElement | null;
const promptTextarea = textField.node() as HTMLTextAreaElement | null;
const chatSystemPromptTextarea = chatSystemTextField.node() as HTMLTextAreaElement | null;
const chatUserPromptTextarea = chatUserTextField.node() as HTMLTextAreaElement | null;
if (teacherForcingTextarea) {
    teacherForcingTextarea.addEventListener('input', () => {
        syncAskButtonState();
    });
}
if (promptTextarea) {
    promptTextarea.addEventListener('input', () => {
        syncAskButtonState();
    });
}
if (chatUserPromptTextarea) {
    chatUserPromptTextarea.addEventListener('input', () => {
        syncAskButtonState();
    });
}
if (chatSystemPromptTextarea) {
    chatSystemPromptTextarea.addEventListener('input', () => {
        syncAskButtonState();
    });
}
async function restoreChatFromCachedPrompt(
    contentKey: string,
    options: {
        shouldTouch: boolean;
        ctx?: CachedHistorySelectContext;
        /** 无 draft 的旧缓存：仅把 promptUsed 填入 raw 框，不切换模式 */
        syncLegacyPromptToField?: boolean;
        cached?: CompletionCachedEntry;
    }
): Promise<void> {
    const entry = options.cached ?? (await getCachedEntryByContentKey(contentKey));
    if (!entry) {
        showToast(tr('Cached completion not found'), 'error');
        return;
    }
    const promptUsed = entry.promptUsed;
    const res = entry.response;
    try {
        if (entry.draft?.mode === 'chat' || entry.draft?.mode === 'raw') {
            applyChatDraftFromCache(entry.draft, entry);
        } else if (options.syncLegacyPromptToField) {
            textField.property('value', promptUsed);
            promptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
            const model = resolveStoredModelVariant(entry.modelVariant);
            if (modelVariantSelect) {
                modelVariantSelect.value = model;
                lsWriteString(CHAT_MODEL_VARIANT_STORAGE_KEY, model);
            }
            syncModelVariantUi();
        }
        applyCompletionResponseToUi(
            res,
            promptUsed,
            contentKey,
            resolveStoredModelVariant(entry.modelVariant),
            entry.segments
        );
        if (!entry.draft && options.syncLegacyPromptToField && !isSkipChatTemplate()) {
            lastCommittedFingerprint = null;
        }
        syncAskButtonState();
        if (options.shouldTouch && options.ctx) {
            await touchCachedEntryByContentKey(contentKey);
            await options.ctx.refreshList();
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast(translateApiErrorMessage(msg), 'error');
    }
}

submitBtn.on('click', () => {
    if (askInFlight) {
        postCompletionsStop();
        // 不断开 SSE：后端 Stop 后仍会发送末条 result（含 info_radar），以便渲染 bpe_strings。
        return;
    }
    void runAsk();
});

forceRetryBtn.on('click', () => {
    void runAsk({ forceRefresh: true });
});

initQueryHistoryDropdown({
    input: promptTextarea,
    dropdownId: 'chat_raw_input_history_dropdown',
    storageKey: CHAT_RAW_INPUT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncAskButtonState,
    historyButton: rawInputHistoryBtn,
    applyHistoryOnHover: true
});

void initCachedHistoryQueryDropdown({
    dropdownId: 'chat_cached_history_dropdown',
    historyButton: document.getElementById('chat_cached_history_btn'),
    clickOutsideRoot: document.getElementById('chat_cached_history_dropdown'),
    listMru: listCachedHistoryRows,
    onSelectEntry: async (contentKey, shouldTouch, ctx) => {
        await restoreChatFromCachedPrompt(contentKey, {
            shouldTouch: Boolean(shouldTouch),
            ctx,
            syncLegacyPromptToField: true,
        });
    },
    onRemove: removeCachedEntryByContentKey,
    onPromote: (contentKey) => touchCachedEntryByContentKey(contentKey),
});

void runContentUrlHydrate({
    readRaw: readContentUrlParam,
    fetchEntry: getCachedEntryByContentKey,
    apply: async (entry, rawContentKey) => {
        await restoreChatFromCachedPrompt(rawContentKey, {
            shouldTouch: false,
            cached: entry,
        });
    },
    onMissing: async () => {
        showToast(tr('Cached completion not found (link may be expired)'), 'error');
        replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'chat');
    },
    onApplyError: (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        showToast(translateApiErrorMessage(msg), 'error');
        replaceContentUrlParam(null, DEFAULT_CONTENT_URL_PARAM, 'chat');
    },
});

initQueryHistoryDropdown({
    input: chatSystemPromptTextarea,
    dropdownId: 'chat_system_prompt_history_dropdown',
    storageKey: CHAT_SYSTEM_INPUT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncAskButtonState,
    historyButton: chatSystemHistoryBtn,
    applyHistoryOnHover: true
});

initQueryHistoryDropdown({
    input: chatUserPromptTextarea,
    dropdownId: 'chat_user_prompt_history_dropdown',
    storageKey: CHAT_USER_INPUT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncAskButtonState,
    historyButton: chatUserHistoryBtn,
    applyHistoryOnHover: true
});

initQueryHistoryDropdown({
    input: teacherForcingTextarea,
    dropdownId: 'chat_teacher_forcing_history_dropdown',
    storageKey: CHAT_TEACHER_FORCING_INPUT_HISTORY_KEY,
    openDropdownOnFocusInput: false,
    filterHistoryByInput: false,
    onSelect: syncAskButtonState,
    historyButton: teacherForcingHistoryBtn,
    applyHistoryOnHover: true
});

initChatPanelLayout({ storageKey: PANEL_SPLIT_STORAGE_KEY_CHAT });

const chatCopyFulltextBtn = document.getElementById('chat_copy_fulltext_btn');
if (chatCopyFulltextBtn) {
    chatCopyFulltextBtn.addEventListener('click', () => {
        void copyChatFullText();
    });
}

initDensityAttributionSidebar({
    eventHandler,
    getCurrentAnalyzeResult: () => chatTurnsView.getActiveAnalyzeResult(),
    apiPrefix,
    showToast,
    getContextPrefix: () => chatTurnsView.getPromptPrefixForSidebar() || currentPromptUsed,
    predictionModelVariant: 'instruct',
    getPredictionModelVariant: () => currentModelVariant(),
    sourcePage: 'chat',
});
