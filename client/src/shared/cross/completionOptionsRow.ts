import type { BaseType, Selection } from 'd3';
import { tr, trf } from '../lang/i18n-lite';
import type { PredictionAttributeModelVariant } from '../prediction_attribution/core/attributionResultCache';
import { showAlertDialog } from '../ui/dialog';
import { lsReadEnum, lsReadNumber, lsSet, lsWriteString } from '../storage/localStorageHelpers';
import {
    DEFAULT_MAX_NEW_TOKENS,
    finalizeMaxNewTokensInput,
    formatMaxNewTokensParseError,
    isMaxNewTokensRawValid,
    MaxNewTokensParseError,
    parseMaxNewTokens as parseMaxNewTokensShared,
    syncMaxNewTokensInputSiteMax,
} from './maxNewTokensConfig';
import { validateMetricsElements } from './textMetricsUpdater';

const MODEL_VARIANT_SELECT_ID = 'completion_model_variant';
const MAX_NEW_TOKENS_INPUT_ID = 'completion_max_new_tokens';

export type CompletionOptionsRowOptions = {
    isSkipChatTemplate: () => boolean;
    metricModel: Selection<BaseType, unknown, HTMLElement, unknown>;
    alertDialogTitle: string;
    onStateChange: () => void;
    adminMode: () => boolean;
    modelVariantStorageKey: string;
    maxNewTokensStorageKey: string;
    urlModelVariant?: PredictionAttributeModelVariant | null;
};

export type CompletionOptionsRowApi = {
    modelVariantSelect: HTMLSelectElement | null;
    maxTokensInput: HTMLInputElement | null;
    currentModelVariant: () => PredictionAttributeModelVariant;
    currentMaxTokens: () => number;
    parseMaxNewTokensFromField: () => number;
    isMaxNewTokensInputValid: () => boolean;
    readStoredModelVariant: () => PredictionAttributeModelVariant;
    readStoredMaxTokens: () => number;
    syncModelVariantUi: () => void;
    syncIdleModelMetric: () => void;
    syncMaxTokensUi: () => void;
    normalizeMaxTokensField: () => boolean;
    persistMaxTokens: () => void;
};

export function createCompletionOptionsRow(
    options: CompletionOptionsRowOptions
): CompletionOptionsRowApi {
    const modelVariantSelect = document.getElementById(
        MODEL_VARIANT_SELECT_ID
    ) as HTMLSelectElement | null;
    const maxTokensInput = document.getElementById(
        MAX_NEW_TOKENS_INPUT_ID
    ) as HTMLInputElement | null;

    const readStoredModelVariant = (): PredictionAttributeModelVariant =>
        lsReadEnum(options.modelVariantStorageKey, ['base', 'instruct'] as const, 'instruct');

    const readStoredMaxTokens = (): number =>
        lsReadNumber(options.maxNewTokensStorageKey, DEFAULT_MAX_NEW_TOKENS, {
            validate: (n) => isMaxNewTokensRawValid(String(n), options.adminMode()),
        });

    const currentModelVariant = (): PredictionAttributeModelVariant => {
        if (!options.isSkipChatTemplate()) return 'instruct';
        const v = modelVariantSelect?.value;
        return v === 'base' || v === 'instruct' ? v : 'instruct';
    };

    const syncIdleModelMetric = (): void => {
        if (!validateMetricsElements(options.metricModel)) return;
        options.metricModel.text(`${tr('model')}: ${currentModelVariant()}`);
    };

    const syncModelVariantUi = (): void => {
        if (!modelVariantSelect) return;
        const skip = options.isSkipChatTemplate();
        if (skip) {
            modelVariantSelect.disabled = false;
            modelVariantSelect.value = readStoredModelVariant();
        } else {
            modelVariantSelect.disabled = true;
            modelVariantSelect.value = 'instruct';
        }
        syncIdleModelMetric();
    };

    const parseMaxNewTokensFromField = (): number => {
        try {
            return parseMaxNewTokensShared(maxTokensInput?.value ?? '', options.adminMode());
        } catch (e) {
            if (e instanceof MaxNewTokensParseError) {
                throw new Error(formatMaxNewTokensParseError(e.code, tr, trf));
            }
            throw e;
        }
    };

    const currentMaxTokens = (): number =>
        parseMaxNewTokensShared(
            maxTokensInput?.value ?? String(DEFAULT_MAX_NEW_TOKENS),
            options.adminMode()
        );

    const isMaxNewTokensInputValid = (): boolean =>
        isMaxNewTokensRawValid(maxTokensInput?.value ?? '', options.adminMode());

    const normalizeMaxTokensField = (): boolean => {
        const ok = finalizeMaxNewTokensInput(
            maxTokensInput,
            options.adminMode(),
            (msg) => showAlertDialog(options.alertDialogTitle, msg),
            tr,
            trf
        );
        options.onStateChange();
        return ok;
    };

    const persistMaxTokens = (): void => {
        if (!maxTokensInput) return;
        try {
            const n = parseMaxNewTokensFromField();
            lsSet(options.maxNewTokensStorageKey, String(n));
        } catch {
            /* 非法值不写 storage */
        }
    };

    const syncMaxTokensUi = (): void => {
        if (maxTokensInput) {
            maxTokensInput.value = String(readStoredMaxTokens());
        }
        syncMaxNewTokensInputSiteMax(maxTokensInput, options.adminMode());
    };

    if (options.urlModelVariant && modelVariantSelect) {
        modelVariantSelect.value = options.urlModelVariant;
    } else if (modelVariantSelect) {
        modelVariantSelect.value = readStoredModelVariant();
    }

    syncMaxTokensUi();

    modelVariantSelect?.addEventListener('change', () => {
        if (!options.isSkipChatTemplate()) return;
        lsWriteString(options.modelVariantStorageKey, currentModelVariant());
        syncIdleModelMetric();
        options.onStateChange();
    });

    maxTokensInput?.addEventListener('change', () => {
        if (!normalizeMaxTokensField()) return;
        lsSet(
            options.maxNewTokensStorageKey,
            maxTokensInput?.value ?? String(DEFAULT_MAX_NEW_TOKENS)
        );
        options.onStateChange();
    });
    maxTokensInput?.addEventListener('input', () => options.onStateChange());
    maxTokensInput?.addEventListener('blur', () => {
        normalizeMaxTokensField();
    });

    return {
        modelVariantSelect,
        maxTokensInput,
        currentModelVariant,
        currentMaxTokens,
        parseMaxNewTokensFromField,
        isMaxNewTokensInputValid,
        readStoredModelVariant,
        readStoredMaxTokens,
        syncModelVariantUi,
        syncIdleModelMetric,
        syncMaxTokensUi,
        normalizeMaxTokensField,
        persistMaxTokens,
    };
}
