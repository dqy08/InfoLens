import * as d3 from 'd3';
import "./utils/d3-polyfill";

import '../css/start.scss'
import {SimpleEventHandler} from "./utils/SimpleEventHandler";
import {TextAnalysisAPI} from "./api/GLTR_API";
import type {AnalyzeResponse, FrontendAnalyzeResult, FrontendToken} from "./api/GLTR_API";
import {GLTR_HoverEvent, GLTR_Mode, GLTR_Text_Box} from "./vis/GLTR_Text_Box";
import {ToolTip} from "./vis/ToolTip";
import URLHandler from "./utils/URLHandler";
import {Histogram, HistogramBinClickEvent} from './vis/Histogram';
import {ScatterPlot, type ScatterChunkClickEvent} from './vis/ScatterPlot';
import {initThemeManager} from './ui/theme';
import {initLanguageManager} from './ui/language';
import {createToast} from './ui/toast';
import {initDemoManager, type DemoManager} from './ui/demoManager';
import {showAlertDialog, showDialog, createCombinedContent, createNamePathTextContent, createUrlInputContent} from './ui/dialog';
// 国际化
import {tr, initI18n, toggleLanguage, getCurrentLanguage} from './lang/i18n-lite';
import {loadHomeContent} from './lang/contentLoader';
// Demo存储层
import { ServerStorage } from './storage/demoStorage';
import { DemoStorageController } from './controllers/demoStorageController';
import { LocalFileIO } from './storage/localFileIO';
import { LocalDemoCache } from './storage/localDemoCache';
import { DemoResourceLoader } from './storage/demoResourceLoader';
// 控制器模块
import {TextInputController, calculateTextStatsForController, type ExtendedInputEvent} from './controllers/textInputController';
import {HighlightController, initHighlightClearListeners} from './controllers/highlightController';
import {LayoutController} from './controllers/layoutController';
import {handleServerDemoSave} from './controllers/serverDemoController';
// 公共初始化模块
import {initializeCommonApp} from './appInitializer';
// 工具函数
import {ensureJsonExtension} from './utils/localFileUtils';
import {extractErrorMessage} from './utils/errorUtils';
import {CryptoSubtleUnavailableError} from './utils/hashUtils';
import type { TextStats } from './utils/textStatistics';
import {composeDemoFullPath, getDefaultDemoName, normalizeFolderPath, buildFolderOptions} from './utils/demoPathUtils';
// 新的业务逻辑模块
import { AppStateManager } from './utils/appStateManager';
import { DemoBusinessLogic } from './utils/demoBusinessLogic';
import { VisualizationUpdater } from './utils/visualizationUpdater';
import { addDigitsMergeRenderListener } from './utils/digitsMergeManager';
import { AnalyzeFlowManager } from './utils/analyzeFlow';
import { isMobileDevice } from './utils/responsive';
import { isValidUrl, extractUrl, isPureUrl } from './utils/urlUtils';
import { AdminManager } from './utils/adminManager';
import { SettingsMenuManager } from './utils/settingsMenuManager';
import { saveHistory, initQueryHistoryDropdown } from './utils/queryHistory';
import { removeByQuery as removeSemanticCacheByQuery } from './utils/semanticResultCache';
import { playAnalysisCompleteSound } from './utils/soundNotification';
import { getSemanticMatchThreshold, setSemanticMatchThreshold } from './utils/semanticThresholdManager';
import { SEMANTIC_MATCH_THRESHOLD } from './constants';
import { SemanticSearchController } from './controllers/semanticSearchController';
import { initDensityAttributionSidebar } from './attribution/densityAttributionSidebar';

const current = {
    sidebar: {
        width: 400,
        visible: false
    },
    demo: true,
    model_name: 'default'  // 使用默认模型，由后端自动选择
};

// 类型定义和工具函数已移至 utils 和 controllers 模块


const mapIDtoEnum = {
    mode_frac_p: GLTR_Mode.fract_p
};


window.onload = () => {
    // 初始化公共应用组件
    const api_prefix = URLHandler.parameters['api'] || '';
    const bodyElement = <Element>d3.select('body').node();
    const { eventHandler, api, tokenSurprisalColorScale, byteSurprisalColorScale, totalSurprisalFormat } = initializeCommonApp(api_prefix, bodyElement);

    // 管理员模式：从本地恢复 token，并注入到 API（写请求自动带 X-Admin-Token）
    const adminManager = AdminManager.getInstance();
    api.setAdminToken(adminManager.isInAdminMode() ? adminManager.getAdminToken() : null);

    // 页面初始化时确保 loading 状态被重置（防止刷新后仍显示转圈）
    d3.selectAll(".loadersmall").style('display', 'none');

    if (URLHandler.parameters['nodemo']){
        current.demo = false;
    }

    const toastController = createToast('#toast');
    const showToast = toastController.show;

    const side_bar = d3.select(".side_bar");
    side_bar.style('width', `${current.sidebar.width}px`);

    const toolTip = new ToolTip(d3.select('#major_tooltip'), eventHandler);

    const submitBtn = d3.select('#submit_text_btn');
    const saveBtn = d3.select('#save_demo_btn');
    const saveLocalBtn = d3.select('#save_local_demo_btn');
    const semanticSearchBtn = d3.select('#semantic_search_btn');
    const clearBtn = d3.select('#clear_text_btn');
    const pasteBtn = d3.select('#paste_text_btn');
    const loadUrlBtn = d3.select('#load_url_btn');
    const analyzeSaveBtn = d3.select('#analyze_save_btn');
    const textField = d3.select('#test_text');
    const textCountValue = d3.select('#text_count_value');
    const textMetrics = d3.select('#text_metrics');
    const metricBytes = d3.select('#metric_bytes');
    const metricChars = d3.select('#metric_chars');
    const metricTokens = d3.select('#metric_tokens');
    const metricTotalSurprisal = d3.select('#metric_total_surprisal');
    const metricModel = d3.select('#metric_model');

    // 从 HTML 读取作为 i18n key 的默认文案（须在 initI18n 之前）
    const defaultNoFileLabel = (() => {
        const el = document.getElementById('open_local_demo_filename');
        return el ? el.textContent?.trim().replace(/\s+/g, ' ') : 'No file selected';
    })();

    // 页面初始化时根据当前语言翻译所有带 data-i18n 属性的元素
    initI18n();
    // 首页相关：中文时用 HTML 内的英文作 key 翻译后覆盖标题与描述
    const isZh = getCurrentLanguage() === 'zh';
    document.documentElement.lang = isZh ? 'zh-CN' : 'en';
    if (isZh) {
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
            const content = metaDesc.getAttribute('content');
            if (content) metaDesc.setAttribute('content', tr(content));
        }
    }
    // 加载首页介绍内容（home.en.html / home.zh.html）
    loadHomeContent('home-intro-content');

    // minimap启用状态（优先使用localStorage，否则根据设备类型判断：移动端默认为false，桌面端默认为true）
    const storedMinimap = localStorage.getItem('minimap_enabled');
    let enableMinimap: boolean = storedMinimap !== null
        ? storedMinimap === '1'
        : !isMobileDevice();

    if (!textMetrics.empty()) {
        textMetrics.style('display', null).classed('is-hidden', true);
    }

    // 创建文本输入控制器
    const textInputController = new TextInputController({
        textField,
        textCountValue,
        textMetrics,
        metricBytes,
        metricChars,
        metricTokens,
        metricTotalSurprisal,
        metricModel,
        clearBtn,
        submitBtn,
        saveBtn,
        pasteBtn,
        totalSurprisalFormat,
        showAlertDialog
    });

    const stats_frac = new Histogram(d3.select('#stats_frac'), eventHandler, { 
        width: 400,   // 宽度
        height: 200   // 增加高度从默认150px到200px
    });
    const stats_raw_score_normed = new Histogram(d3.select('#stats_raw_score_normed'), eventHandler, {
        width: 400,
        height: 200
    });
    const stats_surprisal_progress = new ScatterPlot(d3.select('#stats_surprisal_progress'), eventHandler, {
        width: 400,
        height: 200
    });
    const stats_match_score_progress = new ScatterPlot(d3.select('#stats_match_score_progress'), eventHandler, {
        width: 400,
        height: 200
    });

    // 创建应用状态管理器
    const appStateManager = new AppStateManager({
        submitBtn: submitBtn as d3.Selection<HTMLElement, unknown, HTMLElement, unknown>,
        saveBtn: saveBtn as d3.Selection<HTMLElement, unknown, HTMLElement, unknown>,
        saveLocalBtn: saveLocalBtn as d3.Selection<HTMLElement, unknown, HTMLElement, unknown>,
        textField: textField as d3.Selection<HTMLElement, unknown, HTMLElement, unknown>,
        textMetrics: textMetrics as d3.Selection<HTMLElement, unknown, HTMLElement, unknown>,
        semanticSearchBtn: semanticSearchBtn as d3.Selection<HTMLElement, unknown, HTMLElement, unknown>,
        getSemanticSearchQuery: () => (document.getElementById('semantic_search_input') as HTMLInputElement | null)?.value ?? '',
        tr
    });

    // 创建GLTR文本可视化实例
    const lmf = new GLTR_Text_Box(d3.select("#results"), eventHandler);

    // 直接设置为 fract_p 模式，minimap状态将在settingsMenuManager初始化后设置
    lmf.updateOptions({
        gltrMode: GLTR_Mode.fract_p,
        enableMinimap: false  // 临时值，将在settingsMenuManager初始化后更新
    }, true);

    // 创建高亮控制器
    const highlightController = new HighlightController({
        stats_frac,
        stats_raw_score_normed,
        stats_match_score_progress,
        lmf,
        currentData: null
    });
    const clearHighlights = () => highlightController.clearHighlights();
    
    // 初始化高亮清除事件监听（点击空白处和 ESC 键）
    initHighlightClearListeners(clearHighlights);

    // 创建可视化更新器
    const visualizationUpdater = new VisualizationUpdater({
        lmf,
        highlightController,
        textInputController,
        stats_frac,
        stats_raw_score_normed,
        stats_surprisal_progress,
        stats_match_score_progress,
        appStateManager,
        surprisalColorScale: tokenSurprisalColorScale as d3.ScaleSequential<string>
    });

    addDigitsMergeRenderListener(() => {
        visualizationUpdater.applyDigitsMergeSetting();
    });

    // 初始化主题管理器（在设置菜单中）
    const themeManager = initThemeManager({
        onThemeChange: () => {
            visualizationUpdater.rerenderOnThemeChange();
        }
    }, '#theme_dropdown');

    // 初始化语言管理器（在设置菜单中）
    const languageManager = initLanguageManager({
        onLanguageChange: () => {
            // 语言切换后会自动刷新页面，这里不需要额外处理
        }
    }, '#language_dropdown');

    // 语义分析：query 用 URL，submode/chunked/color_source/阈值 用 localStorage 且一致处理
    const SEMANTIC_KEYS = {
        submode: 'info_radar_semantic_submode',
        chunked: 'info_radar_semantic_chunked',
        colorSource: 'info_radar_semantic_color_source',
        threshold: 'info_radar_semantic_match_threshold'
    } as const;
    const initSemanticOptions = () => {
        const validSubmodes = ['count', 'fill_blank', 'hybrid'];
        const validColorSources = ['raw_score_normed', 'signal_probability', 'pw_score'];
        const query = URLHandler.parameters['semantic_query'] ?? '';
        const submode = localStorage.getItem(SEMANTIC_KEYS.submode) ?? 'hybrid';
        const chunked = localStorage.getItem(SEMANTIC_KEYS.chunked) !== '0';
        const colorSource = localStorage.getItem(SEMANTIC_KEYS.colorSource) ?? 'pw_score';
        const queryEl = document.getElementById('semantic_search_input') as HTMLInputElement | null;
        if (queryEl) queryEl.value = typeof query === 'string' ? query : '';
        const submodeEl = document.getElementById('semantic_submode_select') as HTMLSelectElement | null;
        if (submodeEl && validSubmodes.includes(submode)) submodeEl.value = submode;
        const chunkedEl = document.getElementById('semantic_chunked_mode') as HTMLInputElement | null;
        if (chunkedEl) chunkedEl.checked = chunked;
        const colorEl = document.getElementById('semantic_color_source_select') as HTMLSelectElement | null;
        if (colorEl && validColorSources.includes(colorSource)) colorEl.value = colorSource;
        const thresholdEl = document.getElementById('semantic_threshold_input') as HTMLInputElement | null;
        if (thresholdEl) thresholdEl.value = String(getSemanticMatchThreshold());
    };
    const syncSemanticOptionsToStorage = () => {
        const submodeEl = document.getElementById('semantic_submode_select') as HTMLSelectElement | null;
        const chunkedEl = document.getElementById('semantic_chunked_mode') as HTMLInputElement | null;
        const colorEl = document.getElementById('semantic_color_source_select') as HTMLSelectElement | null;
        const thresholdEl = document.getElementById('semantic_threshold_input') as HTMLInputElement | null;
        localStorage.setItem(SEMANTIC_KEYS.submode, submodeEl?.value ?? 'hybrid');
        if (chunkedEl) localStorage.setItem(SEMANTIC_KEYS.chunked, chunkedEl.checked ? '1' : '0');
        if (colorEl) localStorage.setItem(SEMANTIC_KEYS.colorSource, colorEl.value);
        if (thresholdEl) {
            const v = parseFloat(thresholdEl.value);
            if (Number.isFinite(v)) {
                setSemanticMatchThreshold(v);
                thresholdEl.value = String(getSemanticMatchThreshold());
            }
        }
    };
    const syncSemanticQueryToUrl = () => {
        const queryEl = document.getElementById('semantic_search_input') as HTMLInputElement | null;
        const query = queryEl?.value ?? '';
        const params = URLHandler.parameters;
        if (query) params['semantic_query'] = query;
        else delete params['semantic_query'];
        URLHandler.updateUrl(params, false);
    };

    // 设置菜单管理器（需要在所有依赖创建后初始化）
    const settingsMenuManager = new SettingsMenuManager(
        '#settings_btn',
        '#settings_menu',
        '#admin_mode_btn',
        adminManager,
        api,
        () => {
            // 根据管理员模式更新写按钮（进/退 admin 会整页 reload，无需在此处理 Compare 链）
            const isAdmin = adminManager.isInAdminMode();
            analyzeSaveBtn.style('display', isAdmin ? null : 'none');
            saveBtn.style('display', isAdmin ? null : 'none');
        },
        {
            onMinimapToggle: (enabled: boolean) => {
                enableMinimap = enabled;
                lmf.updateOptions({
                    enableMinimap: enableMinimap
                }, false);
                localStorage.setItem('minimap_enabled', enableMinimap ? '1' : '0');
            },
            onSemanticAnalysisToggle: (_enabled: boolean) => {
                // 打开/关闭时都清除 query，并将 submode/chunked/color/阈值 重置为默认值并写回 localStorage
                const queryEl = document.getElementById('semantic_search_input') as HTMLInputElement | null;
                if (queryEl) queryEl.value = '';
                const submodeEl = document.getElementById('semantic_submode_select') as HTMLSelectElement | null;
                if (submodeEl) submodeEl.value = 'hybrid';
                const chunkedEl = document.getElementById('semantic_chunked_mode') as HTMLInputElement | null;
                if (chunkedEl) chunkedEl.checked = true;
                const colorEl = document.getElementById('semantic_color_source_select') as HTMLSelectElement | null;
                if (colorEl) colorEl.value = 'pw_score';
                setSemanticMatchThreshold(SEMANTIC_MATCH_THRESHOLD);
                const thresholdEl = document.getElementById('semantic_threshold_input') as HTMLInputElement | null;
                if (thresholdEl) thresholdEl.value = String(SEMANTIC_MATCH_THRESHOLD);
                const params = URLHandler.parameters;
                delete params['semantic_query'];
                URLHandler.updateUrl(params, false);
                syncSemanticOptionsToStorage();
                appStateManager.setLastSearchedQuery(null);
                visualizationUpdater.clearSemanticState();
                visualizationUpdater.syncSemanticUiFromConfig();
            },
        },
        themeManager,
        languageManager
    );

    // Compare 入口仅 admin 可见（与 onAdminStateChange 重复无意义：设置里切换 admin 后会 location.reload）
    const compareLinkEl = document.querySelector<HTMLElement>('.compare-link');
    if (compareLinkEl) {
        compareLinkEl.style.display = adminManager.isInAdminMode() ? null : 'none';
    }

    // 设置 minimap 的初始状态并同步到可视化
    settingsMenuManager.setMinimapEnabled(enableMinimap);
    lmf.updateOptions({
        enableMinimap: enableMinimap
    }, false);

    // Semantic analysis UI 完全由配置决定，初始化时同步
    visualizationUpdater.syncSemanticUiFromConfig();

    initSemanticOptions();

    // *****************************
    // *****  demo stuff *****
    // *****************************

    const startSystem = () => {
        d3.select('#model_name').text(current.model_name);
        // opacity 已在 CSS 和 window.onload 中设置，此处无需重复
    }

    let hasStarted = false;
    const ensureSystemStarted = () => {
        if (!hasStarted) {
            startSystem();
            hasStarted = true;
        }
    };

    // 初始化资源加载器和本地 I/O 工具
    const demoResourceLoader = new DemoResourceLoader(api);
    const localFileIO = new LocalFileIO();
    const localDemoCache = demoResourceLoader.getLocalDemoCache();
    
    // 复用服务器存储实例（用于服务器保存）
    const serverStorage = demoResourceLoader.getServerStorage();

    // 更新文件名显示（必须在使用前定义）
    const openLocalFilename = d3.select('#open_local_demo_filename');
    const updateFileNameDisplay = (filename: string | null) => {
        openLocalFilename.text(filename || tr(defaultNoFileLabel));
    };

    // 创建 Demo 业务逻辑管理器
    const demoBusinessLogic = new DemoBusinessLogic({
        textInputController,
        demoManager: null,  // 将在 initDemoManager 后更新
        localDemoCache,
        updateFromRequest: (data, disableAnimation, options) => 
            visualizationUpdater.updateFromRequest(data, disableAnimation, options),
        updateAppState: (updates) => appStateManager.updateState(updates),
        ensureSystemStarted,
        updateFileNameDisplay
    });

    // 创建分析流程管理器
    const analyzeFlowManager = new AnalyzeFlowManager({
        api,
        textInputController,
        demoManager: null,  // 将在 initDemoManager 后更新
        appStateManager,
        visualizationUpdater,
        demoBusinessLogic,
        serverStorage,
        lmf,
        modelName: current.model_name,
        enableDemo: current.demo,
        showToast,
        updateFileNameDisplay
    });

    let demoManager: DemoManager | null = null;
    let hasProcessedUrlDemo = false;  // 标记是否已经处理过URL中的demo参数
    const LAST_SAVE_PATH_KEY = 'lastSaveDemoPath';
    let cryptoSubtleHintShown = false;  // 标记是否已提示过 crypto.subtle 不可用（每个页面会话只提示一次）

    // 检查 IndexedDB 可用性并显示警告
    if (!LocalDemoCache.isAvailable()) {
        console.warn('IndexedDB 不可用，本地缓存功能将受限');
        // 提示用户哪些功能不可用，但其他功能仍然可用
        showAlertDialog(tr('Info'), 
            tr('Browser does not support IndexedDB, the following features will not be available:') + '\n\n' +
            tr('Local file cache (unable to cache local files to browser after opening)') + '\n' +
            tr('Restore local files after refresh (need to reselect files after refreshing the page)') + '\n\n' +
            tr('Other features (text analysis, server save, local file download, etc.) are still available.')
        );
    }

    /**
     * 统一处理加载失败的情况
     * 清除 URL 参数、文件名显示，并显示错误提示
     *
     * @param urlDemoPath URL 中的 demo 路径（用于判断是否为本地资源）
     * @param message 错误消息
     * @param silent 为 true 时不显示错误弹窗（如首页自动加载 404 时静默处理）
     */
    const handleLoadFailure = (urlDemoPath: string | undefined, message: string, silent?: boolean): void => {
        demoBusinessLogic.clearDemoUrlParam();
        if (urlDemoPath && DemoResourceLoader.isLocalResource(urlDemoPath)) {
            updateFileNameDisplay(null);
        }
        if (!silent) {
            showAlertDialog(tr('Error'), tr(message));
        }
    };

    /**
     * 统一的本地 Demo 保存处理函数
     * 封装本地保存的完整流程：下载文件 + 同步状态
     */
    const handleLocalDemoSave = async (
        data: AnalyzeResponse,
        currentFilename?: string,
        textValue?: string
    ): Promise<void> => {
        // 生成文件名：使用统一的文件名生成函数（会自动处理现有文件名）
        const defaultName = getDefaultDemoName(data, textValue || '', currentFilename);
        const filename = ensureJsonExtension(defaultName);

        appStateManager.setGlobalLoading(true);
        appStateManager.updateState({ isSaving: true });

        try {
            // 仅触发物理下载（Download Copy）
            // 语义变更：不再同步更新缓存和 URL，避免因浏览器下载行为不可控导致的状态不一致
            // 应用状态只与"服务端保存"或"打开的文件"挂钩
            const exportSuccess = await localFileIO.export(data, filename);

            if (!exportSuccess) {
                showAlertDialog(tr('Error'), tr('File download failed'));
                return;
            }

            // 保存成功后，标记为已保存到本地
            appStateManager.updateState({ isSavedToLocal: true });

            // 不显示 toast，浏览器下载本身已有反馈
        } catch (error) {
            const message = error instanceof Error ? error.message : tr('Save failed');
            showAlertDialog(tr('Error'), message);
        } finally {
            appStateManager.setGlobalLoading(false);
            appStateManager.updateState({ isSaving: false });
        }
    };

    // Open from local 按钮点击事件处理
    const openLocalBtn = d3.select('#open_local_demo_btn');
    const openLocalInput = d3.select('#open_local_demo_input');
    
    // 按钮点击时触发文件导入
    openLocalBtn.on('click', async () => {
        appStateManager.setGlobalLoading(true);
        try {
            // 使用 LocalFileIO 导入文件
            const result = await localFileIO.import();
            
            if (result.success && result.data && result.filename) {
                try {
                    // 方案3：统一使用资源加载器
                    // 1. 先保存到缓存（获取hash）
                    const saveResult = await localDemoCache.save(result.data, { name: result.filename });
                    if (!saveResult.success || !saveResult.hash) {
                        throw new Error(tr('Failed to save to cache') + ': ' + (saveResult.message || tr('Hash value missing')));
                    }
                    
                    // 2. 创建资源标识符
                    const identifier = DemoResourceLoader.createLocalIdentifier(result.filename, saveResult.hash);
                    
                    // 3. 更新URL（使用资源标识符）
                    URLHandler.updateURLParam('demo', identifier, false);
                    
                    // 4. 使用统一的资源加载器加载（与URL恢复流程完全一致）
                    const loadResult = await demoResourceLoader.load(identifier);
                    if (loadResult.success && loadResult.data) {
                        // 从资源标识符中提取文件名和哈希
                        const localInfo = DemoResourceLoader.extractLocalInfo(identifier);
                        demoBusinessLogic.renderDemo(loadResult.data, 'local', localInfo.filename, { 
                            disableAnimation: true, 
                            isNewDemo: true 
                        });
                        // 本地文件打开不需要toast提示
                    } else {
                        throw new Error(loadResult.message || 'Load failed');
                    }
                } catch (cacheError) {
                    // 如果是因为 crypto.subtle 不可用导致保存到缓存失败，跳过缓存，直接渲染文件
                    if (cacheError instanceof CryptoSubtleUnavailableError) {
                        // 直接渲染文件，不保存到缓存，不更新URL
                        demoBusinessLogic.renderDemo(result.data, 'local', result.filename, { 
                            disableAnimation: true, 
                            isNewDemo: true 
                        });
                        // 检查是否已经提示过（每个页面会话只提示一次）
                        if (!cryptoSubtleHintShown) {
                            // 标记为已提示
                            cryptoSubtleHintShown = true;
                            // 提示用户缓存功能不可用，但文件已正常打开
                            const hintMessage = tr('File opened, but cannot be saved to local cache due to browser security policy restrictions.') + '\n\n' +
                                '✅ ' + tr('Only refresh recovery of opened files is affected, other features work normally.') + '\n\n' +
                                cacheError.message;
                            showAlertDialog(tr('Info'), hintMessage);
                        }
                    } else {
                        // 其他错误继续抛出
                        throw cacheError;
                    }
                }
            } else if (result.message && !result.cancelled) {
                // 只有在非取消的情况下才显示错误
                showAlertDialog(tr('Error'), tr(result.message));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to open file';
            showAlertDialog(tr('Error'), tr(message));
        } finally {
            appStateManager.setGlobalLoading(false);
        }
    });

    if (current.demo) {
        demoManager = initDemoManager({
            api,
            enableDemo: true,
            containerSelector: '.demos',
            loaderSelector: '#demos_loading',
            refreshSelector: '#refresh_demo_btn',
            // 非管理员：禁用文件夹/文件的改删移等操作（后端也会做硬校验）
            disableFolderOperations: !adminManager.isInAdminMode(),
            onDemoLoaded: (data, disableAnimation, isNewDemo = false, path?: string) => {
                // 使用统一渲染函数，传递路径以便提取文件名
                demoBusinessLogic.renderDemo(data, 'server', path, { disableAnimation, isNewDemo });
            },
            onTextPrefill: (text) => {
                textInputController.setTextValue(text);
            },
            onDemoLoading: (loading) => {
                // loading 状态已经通过 setGlobalLoading 更新，会自动触发按钮状态更新
                // 注意：TextMetrics 的显示/隐藏由 AppStateManager 统一管理，不需要手动调用 hideTextMetrics
                // Clear按钮状态由TextInputController内部自动管理，不需要手动更新
                appStateManager.setGlobalLoading(loading);
            },
            onRefreshEnd: async () => {
                ensureSystemStarted();
                
                // 只在首次加载时检查URL参数中的demo参数；无参数时默认加载 quick-start-1.json
                if (!hasProcessedUrlDemo) {
                    hasProcessedUrlDemo = true;
                    const paramDemo = URLHandler.parameters['demo'];
                    const urlDemoPath = (paramDemo && typeof paramDemo === 'string') ? paramDemo : '/quick-start-1.json';
                    if (urlDemoPath) {
                        appStateManager.setGlobalLoading(true);
                        try {
                            // 判断资源类型
                            if (DemoResourceLoader.isLocalResource(urlDemoPath)) {
                                // 本地资源：加载并渲染（不需要导航）
                                const result = await demoResourceLoader.load(urlDemoPath);
                                if (result.success && result.data) {
                                    try {
                                        const localInfo = DemoResourceLoader.extractLocalInfo(urlDemoPath);
                                        demoBusinessLogic.renderDemo(result.data, 'local', localInfo.filename, { 
                                            disableAnimation: true, 
                                            isNewDemo: true 
                                        });
                                        if (!paramDemo) {
                                            URLHandler.updateURLParam('demo', '/quick-start-1.json', false);
                                        }
                                    } catch (error) {
                                        const errorMessage = extractErrorMessage(error, tr('Invalid URL format'));
                                        console.error('解析本地资源标识符失败:', error);
                                        handleLoadFailure(urlDemoPath, errorMessage);
                                    }
                                } else {
                                    handleLoadFailure(urlDemoPath, result.message || tr('Load failed'));
                                }
                            } else {
                                // 服务器资源：统一使用 DemoResourceLoader 加载，然后导航并高亮（首页自动加载仅此分支）
                                const result = await demoResourceLoader.load(urlDemoPath);
                                if (result.success && result.data) {
                                    demoBusinessLogic.renderDemo(result.data, 'server', urlDemoPath, { 
                                        disableAnimation: true, 
                                        isNewDemo: true 
                                    });
                                    if (!paramDemo) {
                                        URLHandler.updateURLParam('demo', '/quick-start-1.json', false);
                                    }
                                    // 导航到demo所在文件夹并高亮
                                    if (demoManager) {
                                        await demoManager.navigateToDemoAndHighlight(urlDemoPath);
                                    }
                                } else {
                                    const msg = result.message || tr('Load failed');
                                    handleLoadFailure(urlDemoPath, msg, msg.startsWith('404'));
                                }
                            }
                        } catch (error) {
                            const errorMessage = extractErrorMessage(error, tr('Failed to restore'));
                            console.error('从URL恢复demo失败:', error);
                            handleLoadFailure(urlDemoPath, errorMessage);
                        } finally {
                            appStateManager.setGlobalLoading(false);
                        }
                    }
                }
            },
        });
        
        // 更新 demoBusinessLogic 和 analyzeFlowManager 中的 demoManager 引用
        demoBusinessLogic.setDemoManager(demoManager);
        analyzeFlowManager.setDemoManager(demoManager);
    } else {
        // 非 demo 模式：移除 demo 相关 UI，启动系统
        d3.selectAll('.demo').remove();
        ensureSystemStarted();
    }



    // 监听文本框变化事件，处理业务逻辑相关的状态更新
    // 注意：Clear按钮状态和字数统计由TextInputController内部自动管理
    // 使用原生 addEventListener 监听 input 事件，避免覆盖 TextInputController 的监听器
    const textFieldNode = textField.node() as HTMLTextAreaElement | null;
    if (textFieldNode) {
        textFieldNode.addEventListener('input', (event: Event) => {
            // 检查是否是匹配分析结果的文本填入
            const isMatchingAnalysis = (event as ExtendedInputEvent).isMatchingAnalysis === true;
            
            if (!isMatchingAnalysis) {
                // 单方面的文本修改（用户输入、预填充等），清除数据标记并重置状态（视为新的分析阶段）
                visualizationUpdater.clearDataOnTextChange();
                appStateManager.updateState({ 
                    hasValidData: false,
                    dataSource: null,
                    isSavedToLocal: false,
                    isSavedToServer: false
                });
            }
            // 如果是匹配分析结果的文本填入，不清除hasValidData（因为updateFromRequest已经重新设置了）
            // 也不隐藏统计信息（因为updateFromRequest已经显示了统计信息）
            
            // 注意：文本修改时不清除文件名显示和URL参数（与远程demo行为一致）
            // 只有点击analyze按钮时才会清除这些状态
        });
    }
    // 初始化时更新业务逻辑相关的按钮状态
    appStateManager.updateButtonStates();

    /**
     * 打开 Analyze&Upload 弹窗，收集名称/目录/文本
     */
    const openAnalyzeSaveDialog = async (prefillText: string) => {
        let folders: string[] = ['/'];
        try {
            const result = await api.list_all_folders();
            folders = Array.isArray(result?.folders) ? result.folders : ['/'];
        } catch (error) {
            const message = error instanceof Error ? error.message : tr('Failed to load folder list');
            showAlertDialog(tr('Error'), `${tr('Failed to load folder list')}：${message}`);
            return;
        }

        const lastPath = localStorage.getItem(LAST_SAVE_PATH_KEY);
        const { options: folderOptions, defaultPath } = buildFolderOptions(folders, lastPath);
        const defaultName = getDefaultDemoName(null, prefillText);

        const { setConfirmButtonState } = showDialog({
            title: tr('Analyze & Upload'),
            content: createNamePathTextContent(
                tr('Demo name:'),
                defaultName,
                tr('Save directory:'),
                folderOptions,
                defaultPath,
                tr('Text content:'),
                prefillText
            ),
            onConfirm: (value: { input: string; select: string; text: string }): boolean => {
                const name = (value?.input || '').trim();
                const path = normalizeFolderPath(value?.select || '/');
                const text = value?.text ?? '';
                
                // 检查是否正在 analyze
                if (appStateManager.getIsAnalyzing()) {
                    // 进入排队状态
                    setConfirmButtonState(false, true); // queuing = true
                    
                    // 轮询等待 analyze 结束
                    const checkInterval = setInterval(() => {
                        if (!appStateManager.getIsAnalyzing()) {
                            // analyze 已结束，清除轮询
                            clearInterval(checkInterval);
                            
                            // 恢复按钮状态（但保持禁用，因为即将关闭弹窗）
                            setConfirmButtonState(false, false);
                            
                            // 延迟一小段时间后执行任务（确保状态完全稳定）
                            setTimeout(() => {
                                // 关闭弹窗（需要获取 overlay 引用）
                                const overlay = d3.select('.dialog-overlay');
                                if (!overlay.empty()) {
                                    overlay.remove();
                                }
                                
                                // 执行 Analyze&Upload 任务
                                void analyzeFlowManager.runAnalyzeAndUpload({ name, path, text });
                            }, 100);
                        }
                    }, 200); // 每 200ms 检查一次
                    
                    return false; // 返回 false 表示不关闭弹窗，等待排队
                }
                
                // 如果不在 analyze 状态，直接执行
                setConfirmButtonState(false);
                void analyzeFlowManager.runAnalyzeAndUpload({ name, path, text });
                return true; // 返回 true 表示可以关闭弹窗
            },
            onCancel: () => {},
            confirmText: tr('Confirm'),
            cancelText: tr('Cancel'),
            // 使用CSS响应式单位，自动响应窗口大小变化
            // 宽度：最小300px，最大不超过90vw或600px
            width: 'clamp(300px, 90vw, 600px)'
        });
    };

    submitBtn.on('click', () => {
        const t = textInputController.getTextValue();
        if (t.length === 0) {
            return;
        }
        
        // 使用 analyzeFlowManager 执行分析
        void analyzeFlowManager.runAnalyze(t, true);
    });

    /**
     * 打开 Analyze URL 弹窗，从剪贴板获取 URL 并加载文本，加载完成后自动分析
     */
    const openLoadUrlDialog = async () => {
        // 尝试从剪贴板获取内容
        let clipboardText = '';
        try {
            clipboardText = await navigator.clipboard.readText();
        } catch (error) {
            // 读取失败时使用空字符串，不弹错误
            clipboardText = '';
        }
        
        // 如果剪贴板内容不为空，尝试提取 URL
        let defaultUrl = '';
        if (clipboardText) {
            if (isPureUrl(clipboardText)) {
                defaultUrl = clipboardText.trim();
            } else {
                const extractedUrl = extractUrl(clipboardText);
                if (extractedUrl) {
                    defaultUrl = extractedUrl;
                }
            }
        }
        
        // 显示弹窗
        const { setConfirmButtonState } = showDialog({
            title: tr('Analyze URL content'),
            content: createUrlInputContent(tr('URL address:'), defaultUrl, 'https://example.com'),
            onConfirm: async (url: string) => {
                if (!url) {
                    return true; // 空 URL，直接关闭弹窗
                }
                
                setConfirmButtonState(false, true); // 弹窗内加载中：禁用确定钮、显示转圈
                appStateManager.setGlobalLoading(true);
                
                try {
                    const result = await api.fetchUrlText(url);
                    
                    if (result.success && result.text) {
                        textInputController.setTextValue(result.text);
                        
                        // 加载完成后自动触发 Analyze 按钮点击
                        (submitBtn.node() as HTMLButtonElement)?.click();
                    } else {
                        showAlertDialog(tr('Load failed'), tr(result.message || 'Unable to extract text from URL'));
                    }
                } catch (error) {
                    const errorMessage = extractErrorMessage(error, tr('URL text extraction failed'));
                    showAlertDialog(tr('Load failed'), errorMessage);
                    console.error('URL 文本提取失败:', error);
                } finally {
                    appStateManager.setGlobalLoading(false);
                }
                
                return true; // 完成后关闭弹窗
            },
            onCancel: () => {},
            confirmText: tr('Analyze'),
            cancelText: tr('Cancel'),
            loadingConfirmText: tr('Loading...'),
            width: 'clamp(300px, 90vw, 500px)'
        });
    };

    // Analyze URL 按钮点击事件
    loadUrlBtn.on('click', async () => {
        await openLoadUrlDialog();
    });

    // Semantic analysis Search 按钮：将 query 和原文发送给 analyze-attention API
    const semanticSearchInput = document.getElementById('semantic_search_input') as HTMLInputElement | null;
    const getSubmode = () =>
        (document.getElementById('semantic_submode_select') as HTMLSelectElement | null)?.value || undefined;
    const showSemanticError = (message?: string) => {
        d3.select('#semantic_match_degree').style('display', 'none');
        showToast(message || tr('Semantic analysis failed'), 'error');
        lmf.hideLoading();
        visualizationUpdater.rerenderHistograms();
    };
    const finishSemanticSearch = (query: string, matchDegree: number | null, fromCache: boolean) => {
        appStateManager.setLastSearchedQuery(query);
        syncSemanticQueryToUrl();
        syncSemanticOptionsToStorage();
        if (!fromCache) playAnalysisCompleteSound();
        const mdEl = d3.select('#semantic_match_degree');
        if (matchDegree !== null) {
            mdEl.text(tr('Match: {0}%').replace('{0}', (matchDegree * 100).toFixed(1)))
                .style('display', 'inline-block')
                .style('color', matchDegree < getSemanticMatchThreshold() ? 'var(--error-color, #e74c3c)' : null);
        } else {
            mdEl.style('display', 'none');
        }
    };
    const semanticSearchController = new SemanticSearchController({
        getQuery: () => semanticSearchInput?.value ?? '',
        getText: () => (textField.property('value') ?? visualizationUpdater.getCurrentData()?.request?.text ?? '').toString(),
        getSubmode,
        isChunkedMode: () => (document.getElementById('semantic_chunked_mode') as HTMLInputElement | null)?.checked ?? true,
        api,
        appStateManager,
        visualizationUpdater,
        lmf,
        showToast,
        showSemanticError,
        onSearchStart: (query) => saveHistory(query),
        finishSemanticSearch,
        tr,
        extractErrorMessage,
    });
    const runSemanticSearchOrChunked = () => semanticSearchController.run();
    const onSemanticBtnClick = () => {
        if (appStateManager.getState().isSemanticSearching) {
            semanticSearchController.abort();
        } else {
            runSemanticSearchOrChunked();
        }
    };

    semanticSearchBtn.on('click', onSemanticBtnClick);
    semanticSearchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) onSemanticBtnClick();
    });
    initQueryHistoryDropdown({
        input: semanticSearchInput,
        dropdownId: 'semantic_search_history_dropdown',
        onSelect: () => appStateManager.updateButtonStates(),
        onHistorySelect: runSemanticSearchOrChunked,
        onRemove: removeSemanticCacheByQuery
    });
    semanticSearchInput?.addEventListener('blur', syncSemanticQueryToUrl);
    document.getElementById('semantic_submode_select')?.addEventListener('change', syncSemanticOptionsToStorage);
    document.getElementById('semantic_chunked_mode')?.addEventListener('change', syncSemanticOptionsToStorage);
    document.getElementById('semantic_threshold_input')?.addEventListener('change', syncSemanticOptionsToStorage);
    document.getElementById('semantic_color_source_select')?.addEventListener('change', () => {
        visualizationUpdater.updateSemanticColorSource();
        syncSemanticOptionsToStorage();
    });

    // Save按钮点击事件（使用 serverDemoController）
    saveBtn.on('click', async () => {
        try {
            const state = appStateManager.getState();
            await handleServerDemoSave({
                api,
                currentData: visualizationUpdater.getCurrentData(),
                rawApiResponse: visualizationUpdater.getRawApiResponse(),
                textFieldValue: textInputController.getTextValue(),
                enableDemo: current.demo,
                demoManager: demoManager || null,
                serverStorage,
                currentFileName: state.currentFileName,
                onSaveStart: () => {
                    appStateManager.updateState({ isSaving: true });
                },
                onSaveSuccess: (name?: string) => {
                    appStateManager.updateState({ 
                        isSaving: false,
                        isSavedToServer: true 
                    });
                },
                onSaveError: () => {
                    appStateManager.updateState({ isSaving: false });
                },
                setGlobalLoading: (loading: boolean) => appStateManager.setGlobalLoading(loading),
                showToast
            });
        } catch (error) {
            // 错误已在 handleServerDemoSave 中处理
        }
    });

    // Save to local 按钮点击事件（使用统一的保存处理函数）
    saveLocalBtn.on('click', async () => {
        const rawApiResponse = visualizationUpdater.getRawApiResponse();
        if (!rawApiResponse) {
            showAlertDialog(tr('Error'), tr('No data to save, please analyze text first'));
            return;
        }

        // 使用 AppState 中的文件名（单一真相来源）
        const state = appStateManager.getState();

        await handleLocalDemoSave(
            rawApiResponse,
            state.currentFileName || undefined,
            textInputController.getTextValue()
        );
    });

    // Analyze&Upload 按钮：读取剪贴板（失败/空白则用空文本），弹窗后执行串行 Analyze + Upload
    analyzeSaveBtn.on('click', async () => {
        let clipboardText = '';
        try {
            clipboardText = await navigator.clipboard.readText();
        } catch (error) {
            // 读取失败时按空文本处理，不弹错误
            clipboardText = '';
        }
        if (!clipboardText) {
            clipboardText = '';
        }
        await openAnalyzeSaveDialog(clipboardText);
    });

    // Clear 和 Paste 按钮的事件处理已由 TextInputController 内部处理

    eventHandler.bind(GLTR_Text_Box.events.tokenHovered, (ev: GLTR_HoverEvent) => {
        if (ev.hovered) {
            toolTip.updateData(ev.d, ev.event);
        } else {
            toolTip.visibility = false;
        }
    });

    initDensityAttributionSidebar({
        eventHandler,
        getCurrentAnalyzeResult: () => lmf.getCurrentAnalyzeResult(),
        apiPrefix: api_prefix,
        showToast,
        predictionModelVariant: 'base',
    });

    // 高亮清除事件监听已由 initHighlightClearListeners 处理

    // 监听直方图bin点击事件（使用 HighlightController 处理）
    eventHandler.bind(Histogram.events.binClicked, (ev: HistogramBinClickEvent) => {
        highlightController.handleHistogramBinClick(ev);
    });

    eventHandler.bind(ScatterPlot.events.chunkClicked, (ev: ScatterChunkClickEvent) => {
        highlightController.handleMatchScoreChunkClick(ev);
    });

    d3.select('body').on('touchstart', () => {
        toolTip.hideAndReset();
    })

    const mainWindow = {
        width: () => window.innerWidth - (current.sidebar.visible ? current.sidebar.width : 0),
        height: () => window.innerHeight - 195
    };


    // 创建布局控制器
    const layoutController = new LayoutController({
        sidebarState: current.sidebar,
        sideBar: side_bar,
        sidebarBtn: d3.select('#sidebar_btn')
    });
};




