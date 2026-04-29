/**
 * 非对称翻译表
 * 
 * 说明：
 * 1. 英文是 source of truth，不需要翻译表
 * 2. key 必须是代码中的英文原文
 * 3. 仅翻译用户可见的 UI 文案
 * 4. 仅翻译普通用户界面，管理员/开发者界面、日志等仅使用英文
 * 5. 不翻译分析内容、模型输出、抓取文本
 */

export type TranslationTable = Record<string, string>;
export type Translations = Partial<Record<'en' | 'zh', TranslationTable>>;

export const translations: Translations = {
    zh: {
        // ========== 首页介绍文本 ==========
        // 注意：首页介绍的大段内容已迁移到外部 HTML 文件：
        // - client/src/content/home.en.html
        // - client/src/content/home.zh.html
        // 由 contentLoader.ts 动态加载
        'Info Lens': 'Info Lens 信息透镜',
        'A toolbox for exploring the informational nature of LLMs and language': '用于探索 LLM 与语言的信息本质的工具箱',
        'Info Highlight': 'Info Highlight 信息高亮',
        "- highlight the 'informative' parts": '- 高亮“信息量大”的地方',
        'LLM Raw Chat': 'LLM Raw Chat 原始对话',
        '- chat with explicit raw prompts': '- 用精确的 prompt 进行对话',
        'Context Attribution': 'Context Attribution 上下文归因',
        '- attribute a predicted token to its context': '- 将预测 token 归因到上下文',
        'LLM Causal Flow': 'LLM Causal Flow 因果流',
        '- explore the context-attribution DAG': '- 探索上下文归因的 DAG 关系图',
        // 合成标题串（<title>）：英文 key 与 injectPageMeta documentTitleEn 拼接一致
        'Info Lens - A toolbox for exploring the informational nature of LLMs and language': 'Info Lens 信息透镜 - 用于探索 LLM 与语言的信息本质的工具箱',
        "Info Highlight - highlight the 'informative' parts": 'Info Highlight 信息高亮 - 高亮“信息量大”的地方',
        'LLM Raw Chat - chat with explicit raw prompts': 'LLM Raw Chat 原始对话 - 用精确的 prompt 进行对话',
        'Context Attribution - attribute a predicted token to its context': 'Context Attribution 上下文归因 - 将预测 token 归因到上下文',
        'LLM Causal Flow - explore the context-attribution DAG': 'LLM Causal Flow 因果流 - 探索上下文归因的 DAG 关系图',
        // LLM Causal Flow（gen_attribute）页：placeholder / title 文案
        'When enabled, each line below is a regex with the global flag, matched only within the initial static prompt prefix (excluding generated continuation). If a token offset lies fully inside a match, its score is treated as 0.':
            '启用后仅在初始静态 prompt 前缀内按下列正则匹配（不含已生成 continuation）；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'One regex per line (prompt prefix only)': '每行一条正则（仅 prompt 前缀）',
        'One regex per line (global flag), matched only within the initial prompt prefix; if a token offset lies fully inside a match, its score is treated as 0.':
            '每行一条正则，`g`，仅在初始 prompt 前缀内匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'When enabled, each line below is a regex with the global flag, matched only within the model-generated continuation (excluding the initial static prompt). If a token offset lies fully inside a match, its score is treated as 0.':
            '启用后仅在模型已生成的 continuation（不含初始静态 prompt）内按下列正则匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'One regex per line (generated continuation only)': '每行一条正则（仅已生成 continuation）',
        'One regex per line (global flag), matched only within the generated suffix; if a token offset lies fully inside a match, its score is treated as 0.':
            '每行一条正则，`g`，仅在已生成后缀内匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'When checked, gray DAG edges not adjacent to the hovered or selected node are hidden.':
            '勾选后，DAG 中未与当前悬浮/选中节点相邻的灰色边将被隐藏。',
        'Width (px) of the invisible measurement layer used for DAG layout. Only this width affects wrapping and node positions. When idle, changes replay and fit automatically; during generation or DAG playback, the setting updates for the next run or refresh.':
            'DAG 节点几何所基于的不可见测量层宽度（px）。只有测量层宽度会影响节点折行/位置。修改后：稳态下自动按新宽度重放并 fit；若正在生成或 DAG 播放中，仅更新设置，下次刷新/生成时生效。',
        'Delay in milliseconds between steps during DAG playback. Stored locally; the value is read when you press play—changing it mid-playback does not affect the current run.':
            'DAG 步进重放时相邻两步之间的间隔（ms）。写入本地存储；每次点击播放时读取当前输入，播放中途改数值不影响本轮。',
        'Perform gradient attribution on the target token below.': '对以下target token做梯度归因。',
        // Context Attribution 页（attribution.html）
        'Context': 'Context 上下文',
        'Target prediction': 'Target prediction 目标预测',
        'Analyze attribution': '归因分析',
        '{count} tokens': '{count} 个 token',
        'Exclude prompt patterns': '排除prompt部分的正则',
        'Exclude generated patterns': '排除生成部分的正则',
        'One regex per line (context only)': '每行一条正则（仅 context）',
        'When enabled, each line below is a regex with the global flag, matched only within the context field below. If a token offset lies fully inside a match, its score is treated as 0.':
            '启用后仅在下方 context 输入框全文内按下列正则匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'One regex per line (global flag), matched only within the context text; if a token offset lies fully inside a match, its score is treated as 0.':
            '每行一条正则，`g`，仅在 context 全文上匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'For threshold x∈(0,1]: map normalized scores in [0,x] linearly to display intensities [0,1]; scores above x saturate at maximum intensity. At x=1, equivalent to disabling mapping.':
            '阈值 x∈(0,1]：将已归一的分数在 [0,x] 上线性映射到显示强度 [0,1]；高于 x 的分数饱和为最高强度。x=1 时与关闭映射等价。',
        'LLM × Linguistics × Information Theory': '大模型 × 语言学 × 信息论',
        
        // ========== 通用按钮和操作 ==========
        'Add': '添加',
        'Analyze': '分析',
        'Analyze & Upload': '分析并上传',
        'Analyze&Upload': '分析并上传',
        'Analyze URL': '分析 URL',
        'Analyze URL content': '分析 URL 内容',
        'Cancel': '取消',
        'Clear': '清空',
        'Compare results': '对比结果',
        'Compare analysis results': '对比分析结果',
        'Info Highlight / Compare': 'Info Highlight 信息高亮 / 对比',
        'Compare': '对比',
        'Confirm': '确定',
        'Delete': '删除',
        'Remove': '移除',
        'Move to top': '移到顶部',
        'Edit': '编辑',
        'Enter': '进入',
        'Exit': '退出',
        'Finish editing': '完成编辑',
        'Move': '移动',
        'OK': '确定',
        'Overwrite': '覆盖',
        'Paste': '粘贴',
        'Cached completion not found': '未找到该条续写缓存，可能已被删除',
        'Cached completion not found (link may be expired)': '未找到该条续写缓存（分享链接可能已过期）',
        'Cached result not found': '未找到该条归因缓存，可能已被删除',
        'Cached result not found (link may be expired)': '未找到该条归因缓存（分享链接可能已过期）',
        'Cached run not found': '未找到该条生成缓存，可能已被删除',
        'Cached run not found (link may be expired)': '未找到该条生成缓存（分享链接可能已过期）',
        'Cached history': '历史缓存',
        'Cached demos': '示例缓存',
        'Demo not found': '未找到该示例缓存',
        'No run to export': '当前无可导出的运行结果',
        'History': '输入历史',
        'Raw prompt': 'Raw prompt 原始提示词',
        'Raw prompt mode': 'Raw prompt mode 原始提示词模式',
        'Ask': '提问',
        'Force retry': '强制重试',
        'Fetch again without using cached result': '不使用缓存，重新向服务器请求',
        'Save': '保存',
        'Search': '搜索',
        'Stop': '停止',
        'Stopped': '已停止',
        'EOS reached': '已到达序列结束（EOS）',
        '{count} tokens reached': '已达 {count} 个 token',
        'Maximum length reached': '已达生成长度上限',
        'Fullscreen unavailable': '当前环境无法使用该全屏功能',
        'Upload': '上传',

        // ========== 对话框和表单 ==========
        'Demo name:': 'Demo名称：',
        'Enter folder name': '请输入文件夹名称',
        'Please enter demo name:': '请输入demo名称：',
        'Folder name:': '文件夹名称：',
        'New name:': '新名称：',
        'Save directory:': '保存目录：',
        'Target folder:': '目标文件夹：',
        'Text content:': '文本内容：',
        'URL address:': 'URL 地址：',

        // ========== 状态和提示信息 ==========
        'Downloaded to local': '已下载到本地',
        'File already exists': '文件已存在',
        'File "{name}.json" already exists, overwrite?': '文件 "{name}.json" 已存在，是否覆盖？',
        'Info': '提示',
        'Loading...': '加载中...',
        'No file selected': '未选择文件',
        'Queuing...': '排队中...',
        'Refreshing...': '正在刷新...',
        'Success': '成功',
        'Upload successful': '上传成功',
        'User cancelled save': '用户取消保存',
        'Demo path is missing': '缺少demo路径',
        'Saved to local cache': '已保存到本地缓存',
        'Storage quota exceeded, please clear cache and try again': '存储空间不足，请清理缓存后重试',
        'Key is missing': '缺少key',
        'File not found in local cache, please open again': '本地缓存中未找到该文件，请重新打开',
        'Failed to read from cache': '从缓存读取失败',
        'Request failed, please try again later.': '请求失败，请稍后重试。',
        'File name cannot be empty': '文件名不能为空',
        'File name too long (max 255 characters)': '文件名过长（最多255个字符）',
        'File name contains invalid characters (cannot contain < > : " | ? * or control characters)': '文件名包含非法字符（不能包含 < > : " | ? * 或控制字符）',
        'File name cannot be a system reserved name': '文件名不能使用系统保留名称',
        'File name cannot start or end with a dot': '文件名不能以点开头或结尾',
        'File name cannot contain path separators': '文件名不能包含路径分隔符',
        'Chinese': '中文',

        // ========== 浏览器兼容性提示 ==========
        'Browser does not support IndexedDB, the following features will not be available:': 
            '浏览器不支持 IndexedDB，以下功能将不可用：',
        'Local file cache (unable to cache local files to browser after opening)': 
            '• 本地文件缓存（打开本地文件后无法缓存到浏览器）',
        'Other features (text analysis, server save, local file download, etc.) are still available.':
            '• 其他功能（文本分析、服务器保存、本地文件下载等）仍然可用。',
        'Or configure HTTPS access': '或配置HTTPS访问',
        'Or: Configure HTTPS access': '或者：配置HTTPS访问',
        'Reason: Browser does not support or has disabled encryption API.': 
            '原因：浏览器不支持或禁用了加密API。',
        'Reason: Currently accessing via non-HTTPS non-localhost address, browser security policy has disabled encryption API.': 
            '原因：当前通过非HTTPS的非localhost地址访问，浏览器安全策略禁用了加密API。',
        'Reason: Opening page via file:// protocol, browser security policy has disabled encryption API.': 
            '原因：通过 file:// 协议打开页面，浏览器安全策略禁用了加密API。',
        'Restore local files after refresh (need to reselect files after refreshing the page)': 
            '• 刷新后恢复本地文件（刷新页面后需要重新选择文件）',
        'Solution:': '解决方案：',
        'Solution: Please access the application via http://localhost:port': 
            '解决方案：请通过 http://localhost:端口 访问应用',
        'Recommended: Access via http://localhost:port (recommended)': 
            '推荐：通过 http://localhost:端口 访问（推荐）',
        'Use http://localhost:port to access (recommended)': 
            '使用 http://localhost:端口 访问（推荐）',

        // ========== 设置和配置 ==========
        'Auto': '自动',
        'Dark': '暗色',
        'Light': '亮色',
        'Language:': '语言：',
        'Minimap:': '滚动条缩略图：',
        'Settings': '设置',
        'Theme': '主题',
        'Theme:': '主题：',
        'Force narrow screen:': '强制窄屏：',
        'Toggle dark mode': '切换夜间模式',

        // ========== 文件操作 ==========
        'Load text from URL and analyze': '从URL加载文本并分析',
        'Open demo file from local': '从本地打开demo文件',
        'Save to local file': '保存到本地文件',
        'Select local': '选择本地',

        // ========== 文件夹操作 ==========
        'Are you sure you want to delete {type} "{name}"?': '确定要删除{type}“{name}”吗？',
        'Confirm deletion': '确认删除',
        'File': '文件',
        'Folder': '文件夹',
        'More actions': '更多操作',
        'Move to...': '移动到...',
        'New folder': '新建文件夹',
        'Rename': '重命名',
        '/(Root)': '/（根目录）',
        '/ (Root)': '/（根目录）',
        'This action cannot be undone.': '此操作不可撤销。',

        // ========== Demo 对比页面 ==========
        'InfoLens Home': '返回首页',
        'Import Result': '导入结果',
        'Diff Mode': '差分模式',
        'Move left': '左移',
        'Move right': '右移',
        'Move to leftmost': '移到最左',
        'Move to rightmost': '移到最右',
        'No comparison data': '无对比数据',
        'No demos to compare': '当前没有对比的demo',
        'Please select at least one demo': '请至少选择一个demo',
        'Please wait for all demos to load': '请等待所有 demo 加载完成',
        'Refresh demo list': '刷新demo列表',
        'Select Demo': '选择Demo',
        'Select demo to add:': '选择要添加的demo：',
        'Show Text Rendering': '显示文本渲染',
        'This demo is already in the comparison list': '该demo已在对比列表中',
        'Demo "{name}" analyzed and uploaded successfully!': 'Demo "{name}" 分析并上传成功！',

        // ========== 多选操作 ==========
        'Exit multi-select mode': '退出多选模式',
        'Multi-select mode': '多选模式',
        'No selection': '未选择',
        'Partial success': '部分成功',
        'Please select items to delete first': '请先选择要删除的项',
        'Please select items to move first': '请先选择要移动的项',
        'Select all': '全选',
        'Selected {count}': '已选 {count}',
        'Successfully deleted {count} items': '已成功删除 {count} 项',
        'Successfully deleted {success} items, failed {fail} items': '成功删除 {success} 项，失败 {fail} 项',
        'Successfully moved {count} items': '已成功移动 {count} 项',
        'Successfully moved {success} items, failed {fail} items': '成功移动 {success} 项，失败 {fail} 项',
        'Are you sure you want to delete the following {count} items?': '确定要删除以下 {count} 项吗？',

        // ========== 图表和可视化 ==========
        'Δ bits/Byte': 'Δ 比特/字节',
        'Δinformation per byte histogram': 'Δ字节信息量直方图',
        'bits/Byte': '比特/字节',
        'bits/token': '比特/token',
        'information (bits)': '信息量（比特）',
        'information per byte histogram': '字节信息量直方图',
        'information per token histogram': 'token信息量直方图',
        'information per token progress': 'token信息量进度图',
        'semantic match per chunk progress': 'chunk匹配度进度图',
        'chunk match degree': 'chunk匹配度',
        'token index': 'token索引',
        'character offset': '字符偏移',
        'semantic score histogram': '语义分数直方图',
        'signal prob': 'signal概率',
        'signal ratio': '信号比',
        'pw score': 'pw 分数',

        // ========== Tooltip 内容 ==========
        'information density:': '信息密度：',
        'pw score:': 'pw 分数：',
        'signal prob:': 'signal概率：',
        'signal probability:': '信号概率：',
        'raw score normed:': '归一化原始分数：',
        'Match: {0}%': '匹配度: {0}%',
        'raw score:': '原始分数：',
        'prob:': '概率：',
        'BPE overlap merge: overlapping spans were combined.': 'BPE 重叠合并：已合并重叠区间。',
        'Digit merge: adjacent digit sub-tokens were combined.': '数字合并：已合并相邻数字子 token。',
        'information:': '信息量：',
        'log perplexity:': '对数困惑度：',
        'Top-k data not available.': '未提供 Top-k 数据。',
        'UTF-8 size:': 'UTF-8大小：',

        // ========== 统计信息 ==========
        'bytes': '字节',
        'chars': '字符',
        'model': '模型',
        'index model': '索引模型',
        'tokens': 'token',
        'total information': '总信息量',

        // ========== 标签和提示 ==========
        'or enter text:': '或输入文本：',
        'Quick start - select a demo:': '快速开始 - 选择示例：',

        // ========== 错误和警告消息 ==========
        '0 chars': '0 字符',
        'total information = 0 bits': '总信息量 = 0 比特',
        'All files import failed:': '所有文件导入失败：',
        'Analysis failed': '分析失败',
        'Batch delete failed, please check console for details.': '批量删除失败，请检查控制台获取详细信息。',
        'Batch move failed, please check console for details.': '批量移动失败，请检查控制台获取详细信息。',
        'Cannot add demo, source text inconsistent with existing demos:': '无法添加以下 demo，原文与已有 demo 不一致：',
        'Cannot enable model diff mode: current demos have inconsistent source text': '无法启用模型差分模式：当前 demo 的原文不一致',
        'Cannot find corresponding demo file path, unable to load.': '找不到对应的 demo 文件路径，无法加载。',
        'Delete failed': '删除失败',
        'Delete failed, please check console for details.': '删除失败，请检查控制台获取详细信息。',
        'Demo precheck failed:': '预检查 demo 失败:',
        'Error': '错误',
        'Error loading demos, please check console for details.': '加载 demos 时出错，请检查控制台获取详细信息。',
        'Failed items:': '失败项：',
        'All files failed to read:': '所有文件读取失败：',
        'Failed to add local file': '添加本地文件失败',
        'Failed to create folder': '创建文件夹失败',
        'Failed to read file': '文件读取失败',
        'Partial files failed:': '部分文件失败：',
        'Read failed': '读取失败',
        'Failed to create folder, please check console for details.': '创建文件夹失败，请检查控制台获取详细信息。',
        'Failed to get folder list, please check console for details.': '获取文件夹列表失败，请检查控制台获取详细信息。',
        'Failed to load folder list': '加载文件夹列表失败',
        'Failed to load folder list: {message}': '加载文件夹列表失败: {message}',
        'Failed to open file': '打开文件失败',
        'Failed to open IndexedDB': '无法打开 IndexedDB',
        'Failed to read clipboard, please paste manually': '无法读取剪贴板，请手动粘贴',
        'Failed to refresh demo list, please check console for details.': '刷新demo列表失败，请检查控制台获取详细信息。',
        'Failed to restore': '恢复失败',
        'Failed to save to cache': '保存到缓存失败',
        'File content is not a valid JSON object': '文件内容不是有效的JSON对象',
        'File download failed': '文件下载失败',
        'File is not a valid JSON format': '文件不是有效的JSON格式',
        'Invalid hash format: "{hash}", expected 4 hexadecimal characters': '无效的哈希值格式: "{hash}"，应为4位十六进制字符',
        'File opened, but cannot be saved to local cache due to browser security policy restrictions.': 
            '文件已打开，但由于浏览器安全策略限制，无法保存到本地缓存。',
        'Hash value missing': '哈希值缺失',
        'Import failed': '导入失败',
        'Invalid URL format': 'URL格式无效',
        'Load failed': '加载失败',
        'Load failed: {message}': '加载失败: {message}',
        'Local resource identifier missing hash: "{identifier}", format should be local://filename.json~hash': '本地资源标识符缺少哈希值: "{identifier}"，格式应为 local://filename.json~hash',
        'Missing required "request" field': '缺少必需的"request"字段',
        'Missing required "result" field': '缺少必需的"result"字段',
        'Unable to extract local resource info: "{identifier}"': '无法提取本地资源信息: "{identifier}"',
        'Move failed': '移动失败',
        'Move failed, please check console for details.': '移动失败，请检查控制台获取详细信息。',
        'No data to save, please analyze text first': '没有可保存的数据，请先分析文本',
        'Only refresh recovery of opened files is affected, other features work normally.': 
            '仅已打开文件的刷新恢复受影响，其他功能均可正常使用。',
        'Precheck failed': '预检查失败',
        'Processing failed': '处理失败',
        'Rename failed': '重命名失败',
        'Rename failed, please check console for details.': '重命名失败，请检查控制台获取详细信息。',
        'Returned JSON missing valid bpe_strings array': '返回 JSON 缺少合法的 bpe_strings 数组',
        'Returned JSON missing valid bpe_strings array, processing cancelled.': '返回 JSON 缺少合法的 bpe_strings 数组，已取消本次处理。',
        'Save failed': '保存失败',
        'Save failed: {message}': '保存失败: {message}',
        'Some demos failed to load': '部分 Demo 加载失败',
        'Some files import failed': '部分文件导入失败',
        'Unable to extract text from URL': '无法从 URL 提取文本',
        'Unable to load project configuration, please check backend logs.': '无法加载项目配置，请检查后端日志。',
        'Unable to use encryption API (crypto.subtle), local cache save feature is unavailable.': 
            '无法使用加密API（crypto.subtle），保存到本地缓存功能不可用。',
        'URL text extraction failed': 'URL 文本提取失败',
        'Semantic analysis failed': '语义分析失败',
        'Tokenizer results inconsistent: semantic and info-density token boundaries differ.': 'Tokenizer 结果不一致：语义分析与信息密度的 token 边界存在差异，属预期外情况。',
        'No data to analyze, please analyze text first': '没有可分析的数据，请先分析文本',
        'User cancelled file selection': '用户取消了文件选择',
        // --- API：仅固定全文可精确匹配的校验/静态错误；含数字的动态错误不译，见 translateApiErrorMessage 说明 ---
        'Missing required field: context': '缺少 context 字段',
        'context must be a string': 'context 须为字符串',
        'target_prediction must be a string': 'target_prediction 须为字符串',
        'target_prediction must not be empty': 'target_prediction 不能为空字符串',
        'Missing required field: model': '缺少 model 字段',
        'model must be a string': 'model 须为字符串',
        'model must be "base" or "instruct"': 'model 仅能为 base 或 instruct',
        'Gradient did not propagate; this model may not support attribution (e.g. int8 quantization).':
            '梯度未回传，可能模型不支持归因（如 int8 量化）',
        'Unable to resolve context for this token': '无法解析该 token 的上下文',
        'Completion response missing choices[0].text': '续写响应缺少 choices[0].text',
        'Response missing info_radar.bpe_strings': '响应缺少 info_radar.bpe_strings',
        'completions/prompt response missing prompt_used': 'completions/prompt 响应缺少 prompt_used',
        '... and {count} more items failed': '...还有 {count} 项失败',
        'Source fragments ({count}):': '来源子片段（共 {count} 段）：',
        '(+{n} more)': '（另有 {n} 段未列出）',
    }
};
