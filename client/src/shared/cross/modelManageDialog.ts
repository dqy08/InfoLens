/**
 * Model Management 弹窗
 */
import * as d3 from 'd3';
import { showDialog, showAlertDialog } from '../../shared/ui/dialog';
import { tr } from '../../shared/lang/i18n-lite';
import type { TextAnalysisAPI } from '../../shared/api/GLTR_API';

export async function showModelManageDialog(api: TextAnalysisAPI): Promise<void> {
    try {
        const [availableModelsResp, currentModelResp] = await Promise.all([
            api.getAvailableModels(),
            api.getCurrentModel(),
        ]);

        if (!availableModelsResp.success || !currentModelResp.success) {
            showAlertDialog(tr('Error'), 'Failed to load model management information');
            return;
        }

        const models = availableModelsResp.models;
        let currentModel = currentModelResp.model;
        let deviceType = currentModelResp.device_type;
        let currentUseInt8 = currentModelResp.use_int8;
        let currentUseBfloat16 = currentModelResp.use_bfloat16;
        let isLoading = currentModelResp.loading;

        let pollId: number | null = null;
        let setConfirmBtnState: (enabled: boolean, queuing?: boolean) => void = () => {};
        showDialog({
            title: 'Model Management',
            loadingConfirmText: 'Applying...',
            content: (dialog, setConfirmButtonState) => {
                setConfirmBtnState = setConfirmButtonState ?? (() => {});
                const container = dialog.append('div').attr('class', 'dialog-form-container');

                const deviceInfo = container
                    .append('div')
                    .attr('class', 'device-info')
                    .style('margin-bottom', '12px')
                    .style('padding', '8px')
                    .style('background-color', 'var(--panel-bg)')
                    .style('border-radius', '4px')
                    .style('font-size', '12px');

                const titleRow = deviceInfo
                    .append('div')
                    .style('display', 'flex')
                    .style('justify-content', 'space-between')
                    .style('align-items', 'center')
                    .style('margin-bottom', '6px');

                const modelTitle = titleRow.append('div').style('font-weight', 'bold').style('color', 'var(--primary-color, #2196F3)');

                const refreshBtn = titleRow.append('button').attr('class', 'refresh-btn').attr('title', 'Refresh').text('↻');

                const hideDisplay = () => {
                    deviceInfo.style('opacity', '0');
                };

                const updateDisplay = () => {
                    modelTitle.text(`Current Model: ${currentModel}${isLoading ? ' (Loading...)' : ''}`);
                    deviceInfo.select('.device-type').text(`Device Type: ${deviceType.toUpperCase()}`);
                    const currentQuantization = currentUseInt8
                        ? 'INT8'
                        : currentUseBfloat16
                          ? 'bfloat16'
                          : deviceType === 'cpu'
                            ? 'float32'
                            : 'float16';
                    deviceInfo.select('.quantization').text(`Current Quantization: ${currentQuantization}`);
                    deviceInfo.style('opacity', '1');
                };

                deviceInfo.append('div').attr('class', 'device-type');
                deviceInfo.append('div').attr('class', 'quantization');
                updateDisplay();

                const fetchAndUpdate = async () => {
                    hideDisplay();
                    try {
                        const resp = await api.getCurrentModel();
                        if (resp.success) {
                            currentModel = resp.model;
                            deviceType = resp.device_type;
                            currentUseInt8 = resp.use_int8;
                            currentUseBfloat16 = resp.use_bfloat16;
                            isLoading = resp.loading;
                            updateDisplay();
                        }
                    } catch {
                        // 未收到或失败不恢复，保持隐藏
                    }
                };

                refreshBtn.on('click', async () => {
                    refreshBtn.property('disabled', true).text('…');
                    await fetchAndUpdate();
                    refreshBtn.property('disabled', false).text('↻');
                });

                const overlay = deviceInfo.node()?.closest('.dialog-overlay');
                const pollMs = 2000;
                pollId = window.setInterval(async () => {
                    if (!overlay?.isConnected) {
                        if (pollId != null) window.clearInterval(pollId);
                        pollId = null;
                        return;
                    }
                    await fetchAndUpdate();
                }, pollMs);

                container.append('label').attr('class', 'dialog-label').style('margin-top', '12px').text('Select model:');

                const modelList = container
                    .append('div')
                    .attr('class', 'model-list')
                    .style('max-height', '200px')
                    .style('overflow-y', 'auto')
                    .style('margin-top', '8px');

                let selectedModel = currentModel;

                models.forEach((model) => {
                    const modelItem = modelList
                        .append('div')
                        .attr('class', 'model-item')
                        .style('padding', '8px 12px')
                        .style('margin', '4px 0')
                        .style('border', '1px solid var(--border-color, #ddd)')
                        .style('border-radius', '4px')
                        .style('cursor', 'pointer')
                        .style('transition', 'background-color 0.2s')
                        .classed('current-model', model === currentModel);

                    if (model === currentModel) {
                        modelItem.style('background-color', 'var(--bg-hover, #f0f0f0)').style('font-weight', 'bold');
                    }

                    modelItem.append('span').text(model);

                    modelItem.on('click', function () {
                        selectedModel = model;
                        modelList.selectAll('.model-item').style('background-color', null).style('font-weight', null);
                        d3.select(this).style('background-color', 'var(--bg-hover, #f0f0f0)').style('font-weight', 'bold');
                    });

                    modelItem
                        .on('mouseenter', function () {
                            if (model !== selectedModel) {
                                d3.select(this).style('background-color', 'var(--bg-hover-light, #f8f8f8)');
                            }
                        })
                        .on('mouseleave', function () {
                            if (model !== selectedModel) {
                                d3.select(this).style('background-color', null);
                            }
                        });
                });

                container.append('label').attr('class', 'dialog-label').style('margin-top', '16px').text('Quantization Options:');

                const quantizationOptions = container
                    .append('div')
                    .attr('class', 'quantization-options')
                    .style('margin-top', '8px')
                    .style('padding', '8px')
                    .style('border', '1px solid var(--border-color, #ddd)')
                    .style('border-radius', '4px');

                const int8Option = quantizationOptions.append('div').style('margin-bottom', '8px');

                const int8Checkbox = int8Option
                    .append('input')
                    .attr('type', 'checkbox')
                    .attr('id', 'use_int8_checkbox')
                    .property('checked', currentUseInt8)
                    .property('disabled', deviceType === 'mps');

                const int8LabelText =
                    deviceType === 'mps' ? 'Use INT8 Quantization (not supported on MPS)' : 'Use INT8 Quantization';
                int8Option
                    .append('label')
                    .attr('for', 'use_int8_checkbox')
                    .style('margin-left', '6px')
                    .style('cursor', deviceType === 'mps' ? 'not-allowed' : 'pointer')
                    .style('color', deviceType === 'mps' ? 'var(--text-disabled, #999)' : null)
                    .text(int8LabelText);

                const bfloat16Option = quantizationOptions.append('div');

                const bfloat16Checkbox = bfloat16Option
                    .append('input')
                    .attr('type', 'checkbox')
                    .attr('id', 'use_bfloat16_checkbox')
                    .property('checked', currentUseBfloat16)
                    .property('disabled', deviceType !== 'cpu');

                const bfloat16LabelText = deviceType !== 'cpu' ? 'Use bfloat16 (CPU only)' : 'Use bfloat16';
                bfloat16Option
                    .append('label')
                    .attr('for', 'use_bfloat16_checkbox')
                    .style('margin-left', '6px')
                    .style('cursor', deviceType !== 'cpu' ? 'not-allowed' : 'pointer')
                    .style('color', deviceType !== 'cpu' ? 'var(--text-disabled, #999)' : null)
                    .text(bfloat16LabelText);

                int8Checkbox.on('change', function () {
                    if ((this as HTMLInputElement).checked) {
                        bfloat16Checkbox.property('checked', false);
                    }
                });

                bfloat16Checkbox.on('change', function () {
                    if ((this as HTMLInputElement).checked) {
                        int8Checkbox.property('checked', false);
                    }
                });

                return {
                    getValue: () => ({
                        model: selectedModel,
                        use_int8: (int8Checkbox.node() as HTMLInputElement)?.checked || false,
                        use_bfloat16: (bfloat16Checkbox.node() as HTMLInputElement)?.checked || false,
                    }),
                    validate: () => {
                        if (isLoading) return false;

                        const useInt8 = (int8Checkbox.node() as HTMLInputElement)?.checked || false;
                        const useBfloat16 = (bfloat16Checkbox.node() as HTMLInputElement)?.checked || false;
                        return (
                            selectedModel !== currentModel || useInt8 !== currentUseInt8 || useBfloat16 !== currentUseBfloat16
                        );
                    },
                    focus: () => {},
                };
            },
            onConfirm: async (params: { model: string; use_int8: boolean; use_bfloat16: boolean }) => {
                setConfirmBtnState(false, true);
                try {
                    const result = await api.switchModel(params.model, params.use_int8, params.use_bfloat16);
                    setConfirmBtnState(true, false);
                    if (result.success) {
                        showAlertDialog(
                            tr('Success'),
                            result.message || 'Model settings applied. The selected model will be used for the next analysis.'
                        );
                    } else {
                        showAlertDialog(tr('Error'), result.message || 'Failed to apply model settings');
                    }
                } catch (error: any) {
                    setConfirmBtnState(true, false);
                    showAlertDialog(tr('Error'), 'Failed to apply model settings: ' + error.message);
                }
                return false;
            },
            onCancel: () => {
                if (pollId != null) {
                    window.clearInterval(pollId);
                    pollId = null;
                }
            },
            confirmText: 'Apply',
            cancelText: tr('Exit'),
            width: 'clamp(400px, 90vw, 500px)',
        });
    } catch (error) {
        console.error('Failed to load models:', error);
        showAlertDialog(tr('Error'), 'Failed to load model management information');
    }
}
