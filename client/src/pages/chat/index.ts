import * as d3 from 'd3';
import '../../shared/core/d3-polyfill';
import '../../css/pages/chat.scss';

import { initThemeManager } from '../../shared/ui/theme';
import { initLanguageManager } from '../../shared/ui/language';
import { initI18n, tr, trf } from '../../shared/lang/i18n-lite';
import { AdminManager } from '../../shared/cross/adminManager';
import { SettingsMenuManager } from '../../shared/cross/settingsMenuManager';
import { initCachedHistoryQueryDropdown, type CachedHistorySelectContext } from '../../shared/cross/cachedHistoryUi';
import { initChatPanelLayout } from '../../shared/ui/chat_panel_layout';
import { PANEL_SPLIT_STORAGE_KEY_CHAT } from '../../shared/cross/panelSplitStorage';
import { TextInputController } from '../../shared/controllers/textInputController';
import { initializeCommonApp } from '../../shared/bootstrap';
import { showAlertDialog } from '../../shared/ui/dialog';
import URLHandler from '../../shared/core/URLHandler';
import { ToolTip } from '../../shared/vis/ToolTip';
import { GLTR_HoverEvent, GLTR_Mode, GLTR_Text_Box } from '../../shared/vis/GLTR_Text_Box';
import {
    postCompletions,
    postCompletionsPrompt,
    postCompletionsStop,
    type OpenAICompletionsResponse
} from '../../shared/api/completionsClient';
import { translateApiErrorMessage } from '../../shared/core/errorUtils';
import {
    buildCompletionDisplayResult,
    CHAT_DEFAULT_COMPLETION_MODEL
} from '../../features/chat/buildCompletionDisplayResult';
import { completionFinishReasonLabel } from '../../shared/cross/generationEndReasonLabel';
import { addDigitsMergeRenderListener } from '../../shared/cross/digitsMergeManager';
import {
    CHAT_RAW_INPUT_HISTORY_KEY,
    CHAT_SYSTEM_INPUT_HISTORY_KEY,
    CHAT_USER_INPUT_HISTORY_KEY,
    initQueryHistoryDropdown,
    saveHistory
} from '../../shared/cross/queryHistory';
import {
    buildCachedContentUrlParam,
    getCachedEntryByContentKey,
    listCachedHistoryRows,
    removeCachedEntryByContentKey,
    touchCachedEntryByContentKey,
    type CompletionCachedEntry,
    type CompletionResultCacheKey,
} from '../../features/chat/completionResultCache';
import {
    DEFAULT_CONTENT_URL_PARAM,
    readContentUrlParam,
    replaceContentUrlParam,
    runContentUrlHydrate,
} from '../../shared/cross/contentUrl';
import { CHAT_SURPRISAL_COLOR_MAP_MAX } from '../../shared/cross/SurprisalColorConfig';
import { updateChatCompletionMetrics } from '../../shared/cross/textMetricsUpdater';
import { lsReadBool, lsReadNumber, lsSet, lsWriteBool } from '../../shared/storage/localStorageHelpers';
import {
    CHAT_ENABLE_THINKING_STORAGE_KEY,
    CHAT_MAX_NEW_TOKENS_STORAGE_KEY,
    LS_SKIP_CHAT_TEMPLATE,
} from '../../features/chat/chatPromptTemplateMode';
import { createToast } from '../../shared/ui/toast';
import { initDensityAttributionSidebar } from '../../shared/prediction_attribution/density_sidebar/densityAttributionSidebar';
import { syncDraftCommittedButtonPair } from '../../shared/cross/syncDraftCommittedButtonPair';
import {
    DEFAULT_MAX_NEW_TOKENS,
    finalizeMaxNewTokensInput,
    formatMaxNewTokensParseError,
    MaxNewTokensParseError,
    parseMaxNewTokens as parseMaxNewTokensShared,
    isMaxNewTokensRawValid,
    syncMaxNewTokensInputSiteMax,
} from '../../shared/cross/maxNewTokensConfig';

// 与首页一致：默认隐藏 Ask 旁的小菊花，仅在请求进行中再显示
d3.selectAll('.loadersmall').style('display', 'none');

initI18n();

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
const maxNewTokensInput = document.getElementById(
    'chat_max_new_tokens'
) as HTMLInputElement | null;
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

function isSkipChatTemplate(): boolean {
    return skipChatTemplateInput?.checked ?? false;
}

function isChatUseSystemPrompt(): boolean {
    return chatUseSystemPromptInput?.checked ?? true;
}

function isEnableThinking(): boolean {
    return enableThinkingInput?.checked ?? false;
}

function syncChatSystemPromptSuppressedUi(): void {
    const on = isChatUseSystemPrompt();
    chatSystemPromptPanel?.classList.toggle('chat-system-prompt-suppressed', !on);
    const ta = chatSystemTextField.node() as HTMLTextAreaElement | null;
    if (ta) {
        ta.disabled = !on;
    }
    const dis = !on;
    chatSystemClearBtn.property('disabled', dis);
    chatSystemPasteBtn.property('disabled', dis);
    if (chatSystemHistoryBtn instanceof HTMLButtonElement) {
        chatSystemHistoryBtn.disabled = dis;
    }
}

function syncPromptPanelVisibility(): void {
    const skip = isSkipChatTemplate();
    if (rawInputPanel) rawInputPanel.hidden = !skip;
    if (chatInputPanel) chatInputPanel.hidden = skip;
}

const chatRightStack = d3.select('.chat-right-stack');
const chatPromptUsedEl = d3.select('#chat_prompt_used');
const chatStreamingPreviewEl = d3.select('#chat_streaming_preview');

async function copyChatFullText(): Promise<void> {
    const pu = document.getElementById('chat_prompt_used');
    const prompt =
        pu && !pu.hasAttribute('hidden') ? (pu.textContent ?? '') : '';
    const layer = document.querySelector('#results .text-layer');
    const generated = layer?.textContent ?? '';
    const text = prompt + generated;
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

const toolTip = new ToolTip(d3.select('#major_tooltip'), eventHandler, {
    surprisalRowLabel: tr('log perplexity:')
});

const lmf = new GLTR_Text_Box(d3.select('#results'), eventHandler);
lmf.updateOptions(
    {
        gltrMode: GLTR_Mode.fract_p,
        enableRenderAnimation: false,
        enableMinimap: false,
        overlayTokenRenderStyle: 'classic',
        overlayIgnoreGlobalInfoDensityDisable: true,
        surprisalColorMax: CHAT_SURPRISAL_COLOR_MAP_MAX
    },
    true
);

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

const modelParam = URLHandler.parameters['model'];
const completionModel =
    typeof modelParam === 'string' && modelParam.length > 0
        ? modelParam
        : CHAT_DEFAULT_COMPLETION_MODEL;

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
} | null = null;

/** 右侧已展示结果对应的左侧输入快照（与 Context Attribution 页 lastCommittedInputs 同类） */
type ChatCommittedFingerprint =
    | { skipTemplate: true; raw: string; maxTokens: string }
    | {
          skipTemplate: false;
          user: string;
          system: string;
          useSystem: boolean;
          maxTokens: string;
      };

let lastCommittedFingerprint: ChatCommittedFingerprint | null = null;

function getCurrentFingerprint(): ChatCommittedFingerprint {
    const maxTokens = maxNewTokensInput?.value ?? '';
    if (isSkipChatTemplate()) {
        return {
            skipTemplate: true,
            raw: (textField.node() as HTMLTextAreaElement | null)?.value ?? '',
            maxTokens,
        };
    }
    return {
        skipTemplate: false,
        user: (chatUserTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        system: (chatSystemTextField.node() as HTMLTextAreaElement | null)?.value ?? '',
        useSystem: isChatUseSystemPrompt(),
        maxTokens,
    };
}

function fingerprintsEqual(a: ChatCommittedFingerprint, b: ChatCommittedFingerprint): boolean {
    if (a.skipTemplate && b.skipTemplate) {
        return a.raw === b.raw && a.maxTokens === b.maxTokens;
    }
    if (!a.skipTemplate && !b.skipTemplate) {
        const ta = a as Extract<ChatCommittedFingerprint, { skipTemplate: false }>;
        const tb = b as Extract<ChatCommittedFingerprint, { skipTemplate: false }>;
        return (
            ta.user === tb.user &&
            ta.system === tb.system &&
            ta.useSystem === tb.useSystem &&
            ta.maxTokens === tb.maxTokens
        );
    }
    return false;
}

function syncAskButtonState(): void {
    const fp = getCurrentFingerprint();
    const idleInputsReady =
        ('raw' in fp ? fp.raw.length > 0 : fp.user.length > 0) && isMaxNewTokensInputValid();
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

/** 与 Ask 成功末尾一致：用 completions 响应更新右侧可视化（不发起请求、不改左侧输入） */
function applyCompletionResponseToUi(res: OpenAICompletionsResponse, promptUsed: string): void {
    currentPromptUsed = promptUsed;
    lastCompletionForRerender = { res, promptUsed };
    streamingPreviewLastFlush = 0;
    chatStreamingPreviewEl.text('').attr('hidden', 'true');
    chatPromptUsedEl.text(promptUsed).attr('hidden', null);
    const finalText = res.choices?.[0]?.text;
    if (typeof finalText !== 'string') {
        throw new Error('续写响应缺少 choices[0].text');
    }
    const display = buildCompletionDisplayResult(
        finalText,
        res.model,
        res.info_radar?.bpe_strings ?? null
    );
    lmf.update(display);
    updateChatCompletionMetrics(metricUsage, metricModel, res.model ?? null, res.usage ?? null);
    chatCompleteReasonEl.text(completionFinishReasonLabel(res.choices?.[0]?.finish_reason));
    replaceContentUrlParam(buildCachedContentUrlParam(promptUsed), DEFAULT_CONTENT_URL_PARAM, 'chat');
    lastCommittedFingerprint = getCurrentFingerprint();
    syncAskButtonState();
}

addDigitsMergeRenderListener(() => {
    if (!lastCompletionForRerender) return;
    const { res, promptUsed } = lastCompletionForRerender;
    applyCompletionResponseToUi(res, promptUsed);
});

const themeManager = initThemeManager(
    {
        onThemeChange: () => {
            if (lastCompletionForRerender) {
                const { res, promptUsed } = lastCompletionForRerender;
                applyCompletionResponseToUi(res, promptUsed);
            } else {
                lmf.reRenderCurrent();
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
    syncChatMaxNewTokensUi();
    normalizeChatMaxNewTokensField();
});

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

function parseMaxNewTokens(raw: string): number {
    try {
        return parseMaxNewTokensShared(raw, adminManager.isInAdminMode());
    } catch (e) {
        if (e instanceof MaxNewTokensParseError) {
            throw new Error(
                formatMaxNewTokensParseError(e.code, tr, trf)
            );
        }
        throw e;
    }
}

function normalizeChatMaxNewTokensField(): boolean {
    const ok = finalizeMaxNewTokensInput(
        maxNewTokensInput,
        adminManager.isInAdminMode(),
        (msg) => showAlertDialog(tr('LLM Raw Chat'), msg),
        tr,
        trf
    );
    syncAskButtonState();
    return ok;
}

function isMaxNewTokensInputValid(): boolean {
    return isMaxNewTokensRawValid(
        maxNewTokensInput?.value ?? '',
        adminManager.isInAdminMode()
    );
}

function readChatStoredMaxTokens(): number {
    return lsReadNumber(CHAT_MAX_NEW_TOKENS_STORAGE_KEY, DEFAULT_MAX_NEW_TOKENS, {
        validate: (n) =>
            isMaxNewTokensRawValid(String(n), adminManager.isInAdminMode()),
    });
}

function persistChatMaxNewTokens(): void {
    if (!maxNewTokensInput) return;
    try {
        const n = parseMaxNewTokens(maxNewTokensInput.value);
        lsSet(CHAT_MAX_NEW_TOKENS_STORAGE_KEY, String(n));
    } catch {
        /* 非法值不写 storage */
    }
}

function syncChatMaxNewTokensUi(): void {
    if (maxNewTokensInput) {
        maxNewTokensInput.value = String(readChatStoredMaxTokens());
    }
    syncMaxNewTokensInputSiteMax(maxNewTokensInput, adminManager.isInAdminMode());
}

syncChatMaxNewTokensUi();

const setAskLoading = (loading: boolean): void => {
    askInFlight = loading;
    loaderSmall.style('display', loading ? null : 'none');
    chatRightStack.classed('chat-ask-in-flight', loading);
    if (loading) {
        lastCompletionForRerender = null;
        streamingPreviewLastFlush = 0;
        chatPromptUsedEl.text('').attr('hidden', 'true');
        chatStreamingPreviewEl.text('').attr('hidden', 'true');
        chatCompleteReasonEl.text('');
        // 新请求开始即清空主可视化，避免仍显示上一轮结果
        lmf.update(buildCompletionDisplayResult('', completionModel, null));
    }
    syncAskButtonState();
};

const runAsk = async (options?: { forceRefresh?: boolean }): Promise<void> => {
    const prompt = getActivePromptValue();
    if (askInFlight || prompt.length === 0) return;
    const forceRefresh = options?.forceRefresh === true;

    let maxTokensOpt: number;
    try {
        maxTokensOpt = parseMaxNewTokens(maxNewTokensInput?.value ?? '');
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

        let modelPrompt: string;
        if (skipTemplate) {
            modelPrompt = prompt;
            chatPromptUsedEl.text(prompt).attr('hidden', null);
        } else {
            const useSystem = isChatUseSystemPrompt();
            const systemRaw =
                (chatSystemTextField.node() as HTMLTextAreaElement | null)?.value ?? '';
            const promptReq: { model: string; prompt: string; system?: string; enable_thinking?: boolean } = {
                model: completionModel,
                prompt
            };
            if (useSystem) {
                promptReq.system = systemRaw;
            }
            if (isEnableThinking()) {
                promptReq.enable_thinking = true;
            }
            const assembled = await postCompletionsPrompt(promptReq, {
                signal: askAbort.signal
            });
            modelPrompt = assembled.prompt_used;
            chatPromptUsedEl.text(modelPrompt).attr('hidden', null);
        }

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

        const cacheKey: CompletionResultCacheKey = { prompt: modelPrompt };

        const res = await postCompletions(
            {
                model: completionModel,
                prompt: modelPrompt,
                max_tokens: maxTokensOpt
            },
            {
                signal: askAbort.signal,
                cacheKey,
                forceRefresh,
                onDelta: (chunk, streamEnd) => {
                    streamedText += chunk;
                    flushStreamingPreview(streamedText, streamEnd);
                }
            }
        );
        const finalText = res.choices?.[0]?.text;
        if (typeof finalText !== 'string') {
            throw new Error('Completion response missing choices[0].text');
        }
        // Stop 后服务端仍可能省略尾部若干 delta（见 completions stream_delta 在 cancel 后直接 return），
        // 最终以 result 为准；仅拒绝明显不一致。
        if (finalText !== streamedText && !finalText.startsWith(streamedText)) {
            throw new Error(
                'Streaming deltas do not match final text (retry or report): ' +
                    `delta_len=${streamedText.length}, final_len=${finalText.length}`
            );
        }
        applyCompletionResponseToUi(res, modelPrompt);
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
syncChatSystemPromptSuppressedUi();
chatUseSystemPromptInput?.addEventListener('change', () => {
    syncChatSystemPromptSuppressedUi();
    syncAskButtonState();
});
syncAskButtonState();

const promptTextarea = textField.node() as HTMLTextAreaElement | null;
const chatSystemPromptTextarea = chatSystemTextField.node() as HTMLTextAreaElement | null;
const chatUserPromptTextarea = chatUserTextField.node() as HTMLTextAreaElement | null;
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
maxNewTokensInput?.addEventListener('input', () => syncAskButtonState());
maxNewTokensInput?.addEventListener('change', () => {
    if (normalizeChatMaxNewTokensField()) {
        persistChatMaxNewTokens();
    }
});
maxNewTokensInput?.addEventListener('blur', () => {
    if (normalizeChatMaxNewTokensField()) {
        persistChatMaxNewTokens();
    }
});

async function restoreChatFromCachedPrompt(
    contentKey: string,
    options: {
        shouldTouch: boolean;
        ctx?: CachedHistorySelectContext;
        syncPromptToTextField: boolean;
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
        if (options.syncPromptToTextField) {
            textField.property('value', promptUsed);
            promptTextarea?.dispatchEvent(new Event('input', { bubbles: true }));
            syncAskButtonState();
        }
        applyCompletionResponseToUi(res, promptUsed);
        if (!options.syncPromptToTextField || !isSkipChatTemplate()) {
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
            syncPromptToTextField: true,
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
            syncPromptToTextField: false,
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

initChatPanelLayout({ storageKey: PANEL_SPLIT_STORAGE_KEY_CHAT });

const chatCopyFulltextBtn = document.getElementById('chat_copy_fulltext_btn');
if (chatCopyFulltextBtn) {
    chatCopyFulltextBtn.addEventListener('click', () => {
        void copyChatFullText();
    });
}

initDensityAttributionSidebar({
    eventHandler,
    getCurrentAnalyzeResult: () => lmf.getCurrentAnalyzeResult(),
    apiPrefix,
    showToast,
    getContextPrefix: () => currentPromptUsed,
    predictionModelVariant: 'instruct',
    sourcePage: 'chat',
});
