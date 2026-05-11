/**
 * 设置菜单管理器
 */
import * as d3 from 'd3';
import { AdminManager } from './adminManager';
import { showDialog, showAlertDialog } from '../ui/dialog';
import { TextAnalysisAPI } from '../api/GLTR_API';
import { tr } from '../lang/i18n-lite';
import type { ThemeManager } from '../ui/theme';
import type { LanguageManager } from '../ui/language';
import { createSettingsDropdown } from '../ui/settingsDropdown';
import { getTokenRenderStyle, setTokenRenderStyle, type TokenRenderStyle } from './tokenRenderStyle';
import { getSemanticAnalysisEnabled, setSemanticAnalysisEnabled } from './semanticAnalysisManager';
import { getDigitsMergeEnabled, setDigitsMergeEnabled } from './digitsMergeManager';
import { getForceNarrowScreen, setForceNarrowScreen, FORCE_NARROW_CHANGE_EVENT } from './responsive';
import { getSemanticMatchThreshold } from './semanticThresholdManager';
import { getInfoDensityRenderDisabled, setInfoDensityRenderDisabled } from './infoDensityRenderManager';

export type SettingsMenuCallbacks = {
    onMinimapToggle?: (enabled: boolean) => void;
    onThemeChange?: () => void;
    onLanguageToggle?: () => void;
    onSemanticAnalysisToggle?: (enabled: boolean) => void;
};

export type SettingsMenuContext = 'common' | 'analysis';

export class SettingsMenuManager {
    private settingsBtn: d3.Selection<Element, unknown, HTMLElement, any>;
    private settingsMenu: d3.Selection<Element, unknown, HTMLElement, any>;
    private adminModeBtn: d3.Selection<Element, unknown, HTMLElement, any>;
    private modelManageBtn: d3.Selection<Element, unknown, HTMLElement, any>;
    private visitStatsBtn: d3.Selection<Element, unknown, HTMLElement, any>;
    private tokenRenderStyleDropdown: { updateCurrent: (v: TokenRenderStyle) => void } | null = null;
    private minimapToggle: d3.Selection<HTMLInputElement, unknown, HTMLElement, any>;
    private semanticAnalysisToggle: d3.Selection<HTMLInputElement, unknown, HTMLElement, any>;
    private digitsMergeToggle: d3.Selection<HTMLInputElement, unknown, HTMLElement, any>;
    private forceNarrowToggle: d3.Selection<HTMLInputElement, unknown, HTMLElement, any>;
    private semanticThresholdInput: d3.Selection<HTMLInputElement, unknown, HTMLElement, any>;
    private semanticThresholdItem: d3.Selection<HTMLElement, unknown, HTMLElement, any>;
    private semanticSubmodeRow: d3.Selection<HTMLElement, unknown, HTMLElement, any>;
    private disableInfoDensityToggle: d3.Selection<HTMLInputElement, unknown, HTMLElement, any>;
    private themeDropdownContainer: d3.Selection<Element, unknown, HTMLElement, any>;
    private adminManager: AdminManager;
    private api: TextAnalysisAPI;
    private onAdminStateChange?: () => void;
    private callbacks: SettingsMenuCallbacks;
    private themeManager?: ThemeManager;
    private languageManager?: LanguageManager;
    private readonly menuContext: SettingsMenuContext;

    constructor(
        settingsBtnSelector: string,
        settingsMenuSelector: string,
        adminModeBtnSelector: string,
        adminManager: AdminManager,
        api: TextAnalysisAPI,
        onAdminStateChange?: () => void,
        callbacks?: SettingsMenuCallbacks,
        themeManager?: ThemeManager,
        languageManager?: LanguageManager,
        menuContext: SettingsMenuContext = 'analysis'
    ) {
        this.menuContext = menuContext;
        this.settingsBtn = d3.select(settingsBtnSelector);
        this.settingsMenu = d3.select(settingsMenuSelector);
        this.adminModeBtn = d3.select(adminModeBtnSelector);
        this.modelManageBtn = d3.select('#model_manage_btn');
        this.visitStatsBtn = d3.select('#visit_stats_btn');
        this.tokenRenderStyleDropdown =
            menuContext === 'analysis' ? this.initTokenRenderStyleDropdown() : null;
        this.minimapToggle = d3.select<HTMLInputElement, any>('#enable_minimap_toggle');
        this.semanticAnalysisToggle = d3.select<HTMLInputElement, any>('#semantic_analysis_toggle');
        this.digitsMergeToggle = d3.select<HTMLInputElement, any>('#enable_digits_merge_toggle');
        this.forceNarrowToggle = d3.select<HTMLInputElement, any>('#force_narrow_toggle');
        this.semanticThresholdInput = d3.select<HTMLInputElement, any>('#semantic_threshold_input');
        this.semanticThresholdItem = d3.select<HTMLElement, any>('#semantic_threshold_item');
        this.semanticSubmodeRow = d3.select<HTMLElement, any>('#semantic_submode_row');
        this.disableInfoDensityToggle = d3.select<HTMLInputElement, any>('#disable_info_density_toggle');
        this.themeDropdownContainer = d3.select('#theme_dropdown');
        this.adminManager = adminManager;
        this.api = api;
        this.onAdminStateChange = onAdminStateChange;
        this.callbacks = callbacks || {};
        this.themeManager = themeManager;
        this.languageManager = languageManager;

        this.initialize();
    }

    private initialize(): void {
        // 点击齿轮按钮切换菜单
        this.settingsBtn.on('click', (event: MouseEvent) => {
            event.stopPropagation();
            this.toggleMenu();
        });

        // 点击页面其他区域关闭菜单
        d3.select('body').on('click.settings-menu', () => {
            this.closeMenu();
        });

        // 阻止菜单内部点击关闭菜单
        this.settingsMenu.on('click', (event: MouseEvent) => {
            event.stopPropagation();
        });

        if (this.minimapToggle.node()) {
            this.minimapToggle.on('change', () => {
                const enabled = (this.minimapToggle.node() as HTMLInputElement)?.checked || false;
                if (this.callbacks.onMinimapToggle) {
                    this.callbacks.onMinimapToggle(enabled);
                }
            });
        }

        if (this.digitsMergeToggle.node()) {
            this.digitsMergeToggle.on('change', () => {
                const enabled = (this.digitsMergeToggle.node() as HTMLInputElement)?.checked ?? false;
                setDigitsMergeEnabled(enabled);
            });
        }

        if (this.forceNarrowToggle.node()) {
            this.forceNarrowToggle.on('change', () => {
                const enabled = (this.forceNarrowToggle.node() as HTMLInputElement)?.checked ?? false;
                setForceNarrowScreen(enabled);
            });
            // 跨标签：其他标签更改时同步 checkbox 视觉状态
            window.addEventListener(FORCE_NARROW_CHANGE_EVENT, () => {
                this.setCheckboxChecked(this.forceNarrowToggle, getForceNarrowScreen());
            });
        }

        if (this.menuContext === 'analysis' && this.semanticAnalysisToggle.node()) {
            this.semanticAnalysisToggle.on('change', () => {
                const enabled = (this.semanticAnalysisToggle.node() as HTMLInputElement)?.checked || false;
                setSemanticAnalysisEnabled(enabled);
                this.updateSemanticThresholdVisibility();
                this.updateSemanticSubmodeRowVisibility();
                setInfoDensityRenderDisabled(enabled);
                this.setDisableInfoDensity(enabled);
                window.dispatchEvent(new CustomEvent('info-density-render-change'));
                if (this.callbacks.onSemanticAnalysisToggle) {
                    this.callbacks.onSemanticAnalysisToggle(enabled);
                }
            });
        }

        if (this.menuContext === 'analysis' && this.disableInfoDensityToggle.node()) {
            this.disableInfoDensityToggle.on('change', () => {
                const disabled = (this.disableInfoDensityToggle.node() as HTMLInputElement)?.checked || false;
                setInfoDensityRenderDisabled(disabled);
                window.dispatchEvent(new CustomEvent('info-density-render-change'));
            });
        }

        // Language dropdown - 由 languageManager 初始化，这里只需要确保容器存在
        // 语言切换逻辑在 language.ts 中处理

        // Theme dropdown - 由 themeManager 初始化，这里只需要确保容器存在
        // 主题切换逻辑在 theme.ts 中处理

        // 管理员模式入口（录入 token / 退出）
        if (this.adminModeBtn.node()) {
            this.adminModeBtn.on('click', () => {
                this.closeMenu();
                this.handleAdminModeClick();
            });
        }

        if (this.modelManageBtn.node()) {
            this.modelManageBtn.on('click', () => {
                this.closeMenu();
                this.handleModelManageClick();
            });
        }

        if (this.visitStatsBtn.node()) {
            this.visitStatsBtn.on('click', () => {
                this.closeMenu();
                this.handleVisitStatsClick();
            });
        }

        if (this.menuContext === 'analysis' && this.semanticAnalysisToggle.node()) {
            this.setSemanticAnalysisEnabled(getSemanticAnalysisEnabled());
        }
        this.setDigitsMergeCheckbox(getDigitsMergeEnabled());
        this.setCheckboxChecked(this.forceNarrowToggle, getForceNarrowScreen());
        if (this.menuContext === 'analysis' && this.semanticThresholdInput.node()) {
            this.setSemanticThresholdValue(getSemanticMatchThreshold());
        }
        if (this.menuContext === 'analysis' && this.disableInfoDensityToggle.node()) {
            this.setDisableInfoDensity(getInfoDensityRenderDisabled());
        }
        this.applyAdminUiState();
    }

    private initTokenRenderStyleDropdown(): { updateCurrent: (v: TokenRenderStyle) => void } {
        const container = d3.select('#token_render_style_dropdown');
        if (!container.node()) {
            throw new Error('initTokenRenderStyleDropdown: #token_render_style_dropdown missing on analysis page');
        }
        const options: Array<{ value: TokenRenderStyle; label: string }> = [
            { value: 'classic', label: 'Classic' },
            { value: 'density', label: 'Density' },
        ];
        const dropdown = createSettingsDropdown<TokenRenderStyle>({
            container,
            classPrefix: 'token-render-style',
            options: options.map((o) => ({ value: o.value, html: `<span>${o.label}</span>` })),
            dataAttr: 'data-style',
            bodyClickNamespace: 'token-render-style-dropdown',
            onSelect: (v) => {
                setTokenRenderStyle(v);
                dropdown.updateCurrent(v);
                window.dispatchEvent(new CustomEvent('token-render-style-change'));
            },
        });
        dropdown.updateCurrent(getTokenRenderStyle());
        return dropdown;
    }

    private closeMenu(): void {
        this.settingsMenu.style('display', 'none');
    }

    private toggleMenu(): void {
        const cur = this.settingsMenu.style('display');
        this.settingsMenu.style('display', cur === 'none' || cur === '' ? 'block' : 'none');
    }

    /**
     * 根据管理员模式更新菜单项文案
     */
    public applyAdminUiState(): void {
        const isAdmin = this.adminManager.isInAdminMode();

        this.adminModeBtn.text(isAdmin ? 'Exit' : 'Enter');
        this.adminModeBtn.classed('active', isAdmin);

        // 显示/隐藏所有带 data-admin-only 的菜单项
        this.settingsMenu.selectAll<HTMLElement, unknown>('.settings-menu-item[data-admin-only]')
            .style('display', isAdmin ? null : 'none');
        this.tokenRenderStyleDropdown?.updateCurrent(getTokenRenderStyle());
        if (this.menuContext === 'analysis' && this.semanticAnalysisToggle.node()) {
            this.setSemanticAnalysisEnabled(getSemanticAnalysisEnabled());
        }
        this.setDigitsMergeCheckbox(getDigitsMergeEnabled());
        this.setCheckboxChecked(this.forceNarrowToggle, getForceNarrowScreen());
        if (this.menuContext === 'analysis' && this.semanticThresholdInput.node()) {
            this.setSemanticThresholdValue(getSemanticMatchThreshold());
            this.updateSemanticThresholdVisibility();
        }
        if (this.menuContext === 'analysis' && this.disableInfoDensityToggle.node()) {
            this.setDisableInfoDensity(getInfoDensityRenderDisabled());
        }

        // 通知外部更新 UI
        if (this.onAdminStateChange) {
            this.onAdminStateChange();
        }
    }

    /**
     * 设置 minimap 的初始状态
     */
    public setMinimapEnabled(enabled: boolean): void {
        const checkbox = this.minimapToggle.node() as HTMLInputElement | null;
        if (checkbox) {
            checkbox.checked = enabled;
        }
    }

    /**
     * 设置 semantic analysis 的初始状态
     */
    public setSemanticAnalysisEnabled(enabled: boolean): void {
        const checkbox = this.semanticAnalysisToggle.node() as HTMLInputElement | null;
        if (checkbox) {
            checkbox.checked = enabled;
        }
    }

    public setDigitsMergeCheckbox(checked: boolean): void {
        this.setCheckboxChecked(this.digitsMergeToggle, checked);
    }

    private setCheckboxChecked(
        sel: d3.Selection<HTMLInputElement, unknown, HTMLElement, any>,
        checked: boolean
    ): void {
        const el = sel.node() as HTMLInputElement | null;
        if (el) el.checked = checked;
    }

    private updateSemanticThresholdVisibility(): void {
        if (!this.semanticThresholdItem.node()) return;
        const isAdmin = this.adminManager.isInAdminMode();
        const semanticOn = getSemanticAnalysisEnabled();
        this.semanticThresholdItem.style('display', isAdmin && semanticOn ? null : 'none');
    }

    private updateSemanticSubmodeRowVisibility(): void {
        if (!this.semanticSubmodeRow.node()) return;
        const isAdmin = this.adminManager.isInAdminMode();
        this.semanticSubmodeRow.style('display', isAdmin ? null : 'none');
    }

    private setSemanticThresholdValue(value: number): void {
        const input = this.semanticThresholdInput.node() as HTMLInputElement | null;
        if (input) {
            input.value = String(value);
        }
    }

    /**
     * 设置 disable info density 的初始状态
     */
    public setDisableInfoDensity(disabled: boolean): void {
        const checkbox = this.disableInfoDensityToggle.node() as HTMLInputElement | null;
        if (checkbox) {
            checkbox.checked = disabled;
        }
    }

    private handleAdminModeClick(): void {
        if (this.adminManager.isInAdminMode()) {
            this.adminManager.clearAdminTokenAndNotify();
            // 刷新页面以让 demoManager 等基于配置的模块重新初始化
            window.location.reload();
            return;
        }

        showDialog({
            title: 'Admin Mode',
            content: (dialog) => {
                const container = dialog.append('div').attr('class', 'dialog-form-container');
                container.append('label')
                    .attr('class', 'dialog-label')
                    .text('Please enter admin token:');

                const input = container.append('input')
                    .attr('type', 'password')
                    .attr('class', 'dialog-input')
                    .attr('placeholder', 'INFORADAR_ADMIN_TOKEN');

                return {
                    getValue: () => (input.node() as HTMLInputElement | null)?.value?.trim() || '',
                    validate: () => ((input.node() as HTMLInputElement | null)?.value?.trim() || '').length > 0,
                    focus: () => {
                        const n = input.node() as HTMLInputElement | null;
                        if (n) n.focus();
                    }
                };
            },
            onConfirm: async (token: string) => {
                const { success, message } = await this.adminManager.setAdminTokenAndNotify(token);
                if (!success) {
                    showAlertDialog(tr('Error'), message || 'Admin token verification failed.');
                    return;
                }

                // 注入到 API，随后刷新页面以启用文件夹操作等（初始化期配置）
                this.api.setAdminToken(this.adminManager.getAdminToken());
                window.location.reload();
            },
            onCancel: () => {},
            confirmText: 'Enter',
            cancelText: tr('Cancel'),
            width: 'clamp(300px, 90vw, 420px)'
        });
    }

    private async handleVisitStatsClick(): Promise<void> {
        // backend/visit_stats.py：_STATS_PAGE_ORDER / _STATS_API_ORDER / _STATS_OS_ORDER
        const PAGE_ORDER = [
            'index.html',
            'analysis.html',
            'compare.html',
            'chat.html',
            'attribution.html',
            'gen_attribute.html',
        ] as const;
        const API_ORDER = [
            'analyze',
            'analyze_semantic',
            'chat',
            'causal_flow',
            'prediction_attribute',
            'prediction_attribute__attribution.html',
            'prediction_attribute__chat.html',
            'prediction_attribute__analysis.html',
        ] as const;
        const OS_ORDER = ['ios', 'android', 'windows', 'macos', 'linux', 'unknown'] as const;

        type VisitStatsRow = NonNullable<Awaited<ReturnType<TextAnalysisAPI['getVisitStats']>>>;
        const orderedKeysGt0 = (primary: readonly string[], rec: Record<string, number>): string[] => {
            const primarySet = new Set(primary);
            const pos = Object.keys(rec).filter((k) => (rec[k] ?? 0) > 0);
            const posSet = new Set(pos);
            const head = primary.filter((k) => posSet.has(k));
            const tail = pos.filter((k) => !primarySet.has(k)).sort();
            return [...head, ...tail];
        };
        const visitStatsHtml = (data: VisitStatsRow): string => {
            const GREEN = '#22c55e';
            const g = (s: string) => `<span style="color:${GREEN}">${s}</span>`;
            const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const sb = data.startup_base ?? {};

            const deltaSuffix = (d: number) => d !== 0 ? ` ${g(`(${d > 0 ? '+' : ''}${d})`)}` : '';
            const t = data.totals;
            const pg = data.page_sec ?? {};
            const ap = data.api ?? {};
            const os = data.os ?? {};
            // startup_base 为空说明历史总量未持久化，无从得知累计值；此时显示 unknown
            const fmtTotal = (v: number) => Object.keys(sb).length > 0 ? String(v) : 'unknown';
            const linesJoined = (keys: string[], cur: Record<string, number>, base: Record<string, number>): string[] => {
                if (!keys.length) return ['(none)'];
                return keys.map((k) => {
                    const v = cur[k] ?? 0;
                    return `${esc(k)}: ${fmtTotal(v)}${deltaSuffix(v - (base[k] ?? 0))}`;
                });
            };

            return [
                `Process start: ${esc(data.process_start_at ? new Date(data.process_start_at).toLocaleString() : 'unknown')}`,
                `Last persisted: ${esc(data.saved_at ? new Date(data.saved_at).toLocaleString() : 'unknown')}`,
                '',
                `[All-time (${g('+ delta since process start')})]`,
                `Page loads: ${fmtTotal(t.page_loads)}${deltaSuffix(t.page_loads - (sb.page_loads ?? 0))}`,
                `Active visits: ${fmtTotal(t.active_visits)}${deltaSuffix(t.active_visits - (sb.active_visits ?? 0))}`,
                '',
                '[OS]',
                ...linesJoined(orderedKeysGt0(OS_ORDER, os), os, sb.os ?? {}),
                '',
                '[Page active time / s]',
                ...linesJoined(orderedKeysGt0(PAGE_ORDER, pg), pg, sb.page_sec ?? {}),
                '',
                '[API]',
                ...linesJoined(orderedKeysGt0(API_ORDER, ap), ap, sb.api ?? {}),
            ].join('\n');
        };

        const fetchAndRender = async (container: d3.Selection<HTMLDivElement, unknown, HTMLElement, any>) => {
            let block = container.select<HTMLDivElement>('div.visit-stats-body');
            if (block.empty()) {
                block = container
                    .append('div')
                    .attr('class', 'visit-stats-body')
                    .style('margin', '0')
                    .style('white-space', 'pre-wrap')
                    .style('font', 'inherit')
                    .style('font-size', '13px');
            } else {
                // 与 Model Management 一致：用透明度保留占位，避免清空 DOM 导致弹窗高度塌陷抖动
                block.style('opacity', '0');
            }
            try {
                const data = await this.api.getVisitStats();
                if (!data?.success) throw new Error('bad');
                block.html(visitStatsHtml(data));
            } catch {
                block.text('Failed to load stats.');
            }
            block.style('opacity', '1');
        };

        showDialog({
            title: 'Visit Stats',
            content: (dialog) => {
                const wrap = dialog.append('div').attr('class', 'dialog-form-container');
                const body = wrap.append('div');
                wrap.append('button')
                    .attr('type', 'button')
                    .attr('class', 'refresh-btn')
                    .attr('title', 'Refresh')
                    .text('↻')
                    .on('click', async function () {
                        const btn = d3.select(this);
                        btn.property('disabled', true).text('…');
                        await fetchAndRender(body);
                        btn.property('disabled', false).text('↻');
                    });
                fetchAndRender(body);
                return { focus: () => {} };
            },
            cancelText: tr('Exit'),
            confirmText: null,
            width: 'clamp(340px, 90vw, 460px)',
        });
    }

    private async handleModelManageClick(): Promise<void> {
        try {
            // 获取可用模型和当前模型
            const [availableModelsResp, currentModelResp] = await Promise.all([
                this.api.getAvailableModels(),
                this.api.getCurrentModel()
            ]);

            if (!availableModelsResp.success || !currentModelResp.success) {
                showAlertDialog(tr('Error'), 'Failed to load model management information');
                return;
            }

            let models = availableModelsResp.models;
            let currentModel = currentModelResp.model;
            let deviceType = currentModelResp.device_type;
            let currentUseInt8 = currentModelResp.use_int8;
            let currentUseBfloat16 = currentModelResp.use_bfloat16;
            let isLoading = currentModelResp.loading;

            let pollId: number | null = null;
            let setConfirmBtnState: (enabled: boolean, queuing?: boolean) => void = () => {};
            // 显示模型管理弹窗
            showDialog({
                title: 'Model Management',
                loadingConfirmText: 'Applying...',
                content: (dialog, setConfirmButtonState) => {
                    setConfirmBtnState = setConfirmButtonState ?? (() => {});
                    const container = dialog.append('div').attr('class', 'dialog-form-container');
                    
                    // 显示当前模型和设备信息
                    const deviceInfo = container.append('div')
                        .attr('class', 'device-info')
                        .style('margin-bottom', '12px')
                        .style('padding', '8px')
                        .style('background-color', 'var(--panel-bg)')
                        .style('border-radius', '4px')
                        .style('font-size', '12px');
                    
                    // 标题行：包含当前模型和刷新按钮
                    const titleRow = deviceInfo.append('div')
                        .style('display', 'flex')
                        .style('justify-content', 'space-between')
                        .style('align-items', 'center')
                        .style('margin-bottom', '6px');
                    
                    const modelTitle = titleRow.append('div')
                        .style('font-weight', 'bold')
                        .style('color', 'var(--primary-color, #2196F3)');
                    
                    const refreshBtn = titleRow.append('button')
                        .attr('class', 'refresh-btn')
                        .attr('title', 'Refresh')
                        .text('↻');
                    
                    // 请求发出时隐藏文字（用透明度保留占位，避免布局重排导致整窗闪）
                    const hideDisplay = () => {
                        deviceInfo.style('opacity', '0');
                    };
                    
                    // 请求返回后重绘并显示
                    const updateDisplay = () => {
                        modelTitle.text(`Current Model: ${currentModel}${isLoading ? ' (Loading...)' : ''}`);
                        deviceInfo.select('.device-type').text(`Device Type: ${deviceType.toUpperCase()}`);
                        const currentQuantization = currentUseInt8 ? 'INT8' : 
                                                  currentUseBfloat16 ? 'bfloat16' : 
                                                  deviceType === 'cpu' ? 'float32' : 'float16';
                        deviceInfo.select('.quantization').text(`Current Quantization: ${currentQuantization}`);
                        deviceInfo.style('opacity', '1');
                    };
                    
                    deviceInfo.append('div').attr('class', 'device-type');
                    deviceInfo.append('div').attr('class', 'quantization');
                    updateDisplay();
                    
                    // 拉取当前模型并更新显示（轮询与刷新共用）；只有收到成功响应才恢复文字
                    const fetchAndUpdate = async () => {
                        hideDisplay();
                        try {
                            const resp = await this.api.getCurrentModel();
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
                    
                    // 刷新按钮点击事件
                    refreshBtn.on('click', async () => {
                        refreshBtn.property('disabled', true).text('…');
                        await fetchAndUpdate();
                        refreshBtn.property('disabled', false).text('↻');
                    });
                    
                    // 2s 一次后台轮询，弹窗关闭后清除
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
                    
                    container.append('label')
                        .attr('class', 'dialog-label')
                        .style('margin-top', '12px')
                        .text('Select model:');

                    // 创建模型列表
                    const modelList = container.append('div')
                        .attr('class', 'model-list')
                        .style('max-height', '200px')
                        .style('overflow-y', 'auto')
                        .style('margin-top', '8px');

                    let selectedModel = currentModel;

                    models.forEach(model => {
                        const modelItem = modelList.append('div')
                            .attr('class', 'model-item')
                            .style('padding', '8px 12px')
                            .style('margin', '4px 0')
                            .style('border', '1px solid var(--border-color, #ddd)')
                            .style('border-radius', '4px')
                            .style('cursor', 'pointer')
                            .style('transition', 'background-color 0.2s')
                            .classed('current-model', model === currentModel);

                        // 如果是当前模型，显示标记
                        if (model === currentModel) {
                            modelItem.style('background-color', 'var(--bg-hover, #f0f0f0)')
                                .style('font-weight', 'bold');
                        }

                        modelItem.append('span').text(model);

                        // 点击选择模型
                        modelItem.on('click', function() {
                            selectedModel = model;
                            // 更新选中样式
                            modelList.selectAll('.model-item')
                                .style('background-color', null)
                                .style('font-weight', null);
                            d3.select(this)
                                .style('background-color', 'var(--bg-hover, #f0f0f0)')
                                .style('font-weight', 'bold');
                        });

                        // 鼠标悬停效果
                        modelItem.on('mouseenter', function() {
                            if (model !== selectedModel) {
                                d3.select(this).style('background-color', 'var(--bg-hover-light, #f8f8f8)');
                            }
                        }).on('mouseleave', function() {
                            if (model !== selectedModel) {
                                d3.select(this).style('background-color', null);
                            }
                        });
                    });

                    // 量化选项
                    container.append('label')
                        .attr('class', 'dialog-label')
                        .style('margin-top', '16px')
                        .text('Quantization Options:');
                    
                    const quantizationOptions = container.append('div')
                        .attr('class', 'quantization-options')
                        .style('margin-top', '8px')
                        .style('padding', '8px')
                        .style('border', '1px solid var(--border-color, #ddd)')
                        .style('border-radius', '4px');
                    
                    // INT8 选项
                    const int8Option = quantizationOptions.append('div')
                        .style('margin-bottom', '8px');
                    
                    const int8Checkbox = int8Option.append('input')
                        .attr('type', 'checkbox')
                        .attr('id', 'use_int8_checkbox')
                        .property('checked', currentUseInt8)
                        .property('disabled', deviceType === 'mps');
                    
                    const int8LabelText = deviceType === 'mps'
                        ? 'Use INT8 Quantization (not supported on MPS)'
                        : 'Use INT8 Quantization';
                    int8Option.append('label')
                        .attr('for', 'use_int8_checkbox')
                        .style('margin-left', '6px')
                        .style('cursor', deviceType === 'mps' ? 'not-allowed' : 'pointer')
                        .style('color', deviceType === 'mps' ? 'var(--text-disabled, #999)' : null)
                        .text(int8LabelText);
                    
                    // bfloat16 选项
                    const bfloat16Option = quantizationOptions.append('div');
                    
                    const bfloat16Checkbox = bfloat16Option.append('input')
                        .attr('type', 'checkbox')
                        .attr('id', 'use_bfloat16_checkbox')
                        .property('checked', currentUseBfloat16)
                        .property('disabled', deviceType !== 'cpu');
                    
                    const bfloat16LabelText = deviceType !== 'cpu'
                        ? 'Use bfloat16 (CPU only)'
                        : 'Use bfloat16';
                    bfloat16Option.append('label')
                        .attr('for', 'use_bfloat16_checkbox')
                        .style('margin-left', '6px')
                        .style('cursor', deviceType !== 'cpu' ? 'not-allowed' : 'pointer')
                        .style('color', deviceType !== 'cpu' ? 'var(--text-disabled, #999)' : null)
                        .text(bfloat16LabelText);
                    
                    // 互斥逻辑
                    int8Checkbox.on('change', function() {
                        if ((this as HTMLInputElement).checked) {
                            bfloat16Checkbox.property('checked', false);
                        }
                    });
                    
                    bfloat16Checkbox.on('change', function() {
                        if ((this as HTMLInputElement).checked) {
                            int8Checkbox.property('checked', false);
                        }
                    });

                    return {
                        getValue: () => ({
                            model: selectedModel,
                            use_int8: (int8Checkbox.node() as HTMLInputElement)?.checked || false,
                            use_bfloat16: (bfloat16Checkbox.node() as HTMLInputElement)?.checked || false
                        }),
                        validate: () => {
                            // 如果正在加载，禁用确认按钮
                            if (isLoading) return false;
                            
                            const useInt8 = (int8Checkbox.node() as HTMLInputElement)?.checked || false;
                            const useBfloat16 = (bfloat16Checkbox.node() as HTMLInputElement)?.checked || false;
                            return selectedModel !== currentModel || 
                                   useInt8 !== currentUseInt8 || 
                                   useBfloat16 !== currentUseBfloat16;
                        },
                        focus: () => {}
                    };
                },
                onConfirm: async (params: { model: string, use_int8: boolean, use_bfloat16: boolean }) => {
                    setConfirmBtnState(false, true);
                    try {
                        const result = await this.api.switchModel(
                            params.model,
                            params.use_int8,
                            params.use_bfloat16
                        );
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
                    return false; // 保持弹窗打开
                },
                onCancel: () => {
                    if (pollId != null) {
                        window.clearInterval(pollId);
                        pollId = null;
                    }
                },
                confirmText: 'Apply',
                cancelText: tr('Exit'),
                width: 'clamp(400px, 90vw, 500px)'
            });

        } catch (error) {
            console.error('Failed to load models:', error);
            showAlertDialog(tr('Error'), 'Failed to load model management information');
        }
    }
}
