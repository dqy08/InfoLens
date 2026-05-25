/**
 * 设置菜单管理器
 */
import * as d3 from 'd3';
import { AdminManager } from './adminManager';
import { showDialog, showAlertDialog } from '../../shared/ui/dialog';
import { TextAnalysisAPI } from '../../shared/api/GLTR_API';
import { tr } from '../../shared/lang/i18n-lite';
import type { ThemeManager } from '../../shared/ui/theme';
import type { LanguageManager } from '../../shared/ui/language';
import { createSettingsDropdown } from '../../shared/ui/settingsDropdown';
import { getTokenRenderStyle, setTokenRenderStyle, type TokenRenderStyle } from './tokenRenderStyle';
import { getSemanticAnalysisEnabled, setSemanticAnalysisEnabled } from './semanticAnalysisManager';
import { getDigitsMergeEnabled, setDigitsMergeEnabled } from './digitsMergeManager';
import { getForceNarrowScreen, setForceNarrowScreen, FORCE_NARROW_CHANGE_EVENT } from '../core/responsive';
import { getSemanticMatchThreshold } from './semanticThresholdManager';
import {
    getInfoDensityRenderDisabled,
    setInfoDensityRenderDisabled,
} from '../../features/analysis/infoDensityRenderManager';
import { showVisitStatsDialog } from './visitStatsDialog';
import { showModelManageDialog } from './modelManageDialog';

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
                void showModelManageDialog(this.api);
            });
        }

        if (this.visitStatsBtn.node()) {
            this.visitStatsBtn.on('click', () => {
                this.closeMenu();
                void showVisitStatsDialog(this.api);
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
}
