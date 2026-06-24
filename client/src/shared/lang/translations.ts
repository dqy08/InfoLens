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
        'Back to Info Lens': '返回 Info Lens 信息透镜',
        'A toolbox for exploring the informational nature of LLMs and language': '用于探索 LLM 与语言的信息本质的工具箱',
        'Info Highlight': 'Info Highlight 信息高亮',
        "- highlight the 'informative' parts": '- 高亮“信息量大”的地方',
        'LLM Raw Chat': 'LLM Raw Chat 原始对话',
        '- chat with explicit raw prompts': '- 用精确的 prompt 进行对话',
        'Context Attribution': 'Context Attribution 上下文归因',
        '- attribute a predicted token to its context': '- 将预测 token 归因到上下文',
        'LLM Causal Flow': 'LLM Causal Flow 因果流',
        '- explore the context-attribution DAG': '- 探索上下文归因的 DAG 关系图',
        '700K+ plays on RedNote': '小红书 70万+次播放',
        'Go to demo on RedNote: xhslink.com': '在小红书打开demo：xhslink.com',
        // 合成标题串（<title>）：英文 key 与 injectPageMeta documentTitleEn 拼接一致
        'Info Lens - A toolbox for exploring the informational nature of LLMs and language': 'Info Lens 信息透镜 - 用于探索 LLM 与语言的信息本质的工具箱',
        "Info Highlight - highlight the 'informative' parts": 'Info Highlight 信息高亮 - 高亮“信息量大”的地方',
        'LLM Raw Chat - chat with explicit raw prompts': 'LLM Raw Chat 原始对话 - 用精确的 prompt 进行对话',
        'Context Attribution - attribute a predicted token to its context': 'Context Attribution 上下文归因 - 将预测 token 归因到上下文',
        'LLM Causal Flow - explore the context-attribution DAG': 'LLM Causal Flow 因果流 - 探索上下文归因的 DAG 关系图',
        'Max new tokens must not exceed {limit}': 'Max new tokens 不得超过 {limit}',
        'Max new tokens must be a positive integer': 'Max new tokens 须为正整数',
        // LLM Causal Flow（gen_attribute）页：placeholder / title 文案
        'When enabled, each line below is a regex with the global flag, matched only within input areas (excluding generated continuation). Matched prompt tokens are physically removed from the DAG — they neither appear nor occupy layout space (stricter than Exclude + Hide).':
            '启用后仅在 input 区（不含已生成 continuation）内按下列正则匹配；命中的 prompt token 从 DAG 物理移除，不占布局（比 Exclude + Hide 更严格）。',
        'One regex per line (global flag), matched only within input areas (excluding generated continuation); matched tokens are deleted from the DAG and do not occupy layout space.':
            '每行一条正则，`g`，仅在 input 区（不含已生成 continuation）内匹配；命中的 token 从 DAG 删除且不占布局空间。',
        'When enabled, each line below is a regex with the global flag, matched only within input areas (excluding generated continuation). If a token offset lies fully inside a match, its score is treated as 0.':
            '启用后仅在 input 区（不含已生成 continuation）内按下列正则匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'One regex per line (input areas only)': '每行一条正则（仅 input 区）',
        'One regex per line (global flag), matched only within input areas (excluding generated continuation); if a token offset lies fully inside a match, its score is treated as 0.':
            '每行一条正则，`g`，仅在 input 区（不含已生成 continuation）内匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'When enabled, each line below is a regex with the global flag, matched only within the model-generated continuation (excluding the initial static prompt). If a token offset lies fully inside a match, its score is treated as 0.':
            '启用后仅在模型已生成的 continuation（不含初始静态 prompt）内按下列正则匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'One regex per line (generated continuation only)': '每行一条正则（仅已生成 continuation）',
        'One regex per line (global flag), matched only within the generated suffix; if a token offset lies fully inside a match, its score is treated as 0.':
            '每行一条正则，`g`，仅在已生成后缀内匹配；token 的 offset 完全落在某次匹配区间内则 score 视为 0。',
        'Coverage is the cumulative mass share within each generation step\'s Top-N candidate pool (after sorting candidates into the pool and normalizing mass inside that pool). Higher values keep more incoming edges. The denominator is this pool only, not every token-attribution entry returned for the step.':
            'Coverage 指每一步在 Top-N 候选池内的累计质量份额（先入池、池内归一后按强度排序再累加）。数值越大保留的 DAG 入边越多；分母仅为该候选池，不是该步 API 返回的全部归因 token。',
        'When checked, gray DAG edges not adjacent to the hovered or selected node are hidden.':
            '勾选后，DAG 中未与当前悬浮/选中节点相邻的灰色边将被隐藏。',
        'Show token tooltip':
            '显示 token 提示',
        'When checked, selecting or hovering a token node shows token information in the results area.':
            '勾选后，选中或悬浮 token 节点时，在右侧结果区展示该 token 的信息（信息量、预测分布、归因份额等）。',
        'Width (px) of the invisible measurement layer used for DAG layout. Only this width affects wrapping and node positions. When idle, changes replay and fit automatically; during generation or DAG step replay (▶), the setting updates for the next run or refresh.':
            'DAG 节点几何所基于的不可见测量层宽度（px）。只有测量层宽度会影响节点折行/位置。修改后：稳态下自动按新宽度重放并 fit；若正在生成或 DAG 步进重放（▶）中，仅更新设置，下次刷新/生成时生效。',
        'Token distance': 'Token distance 间距',
        'Horizontal gap (px) between the outer left/right edges of adjacent token nodes in linear-arc / linear-arc-step-down layout only. When idle, the DAG refits; during generation or DAG step replay (▶), the value is stored and applied on the next sync.':
            '仅 linear-arc / linear-arc-step-down 布局下生效：相邻 token 节点矩形外侧边之间的水平间隙（px）。修改后：稳态下立即重绘并 fit；若正在生成或 DAG 步进重放（▶）中，仅写入存储，下一轮同步时再反映。',
        'Horizontal gap (px) between the outer left/right edges of adjacent token nodes in linear-arc layout only. When idle, the DAG refits; during generation or DAG step replay (▶), the value is stored and applied on the next sync.':
            '仅 linear-arc / linear-arc-step-down 布局下生效：相邻 token 节点矩形外侧边之间的水平间隙（px）。修改后：稳态下立即重绘并 fit；若正在生成或 DAG 步进重放（▶）中，仅写入存储，下一轮同步时再反映。',
        'Compactness': 'DAG 紧凑度',
        'Scales DAG node boxes and labels relative to the measurement layer; 1 matches full readout scale. When idle, changes replay and fit automatically; during generation or DAG step replay (▶), the setting updates for the next run or refresh.':
            '相对测量层缩放 DAG 节点框与标签；1 与正文阅读比例一致。修改后：稳态下自动重放并 fit；若正在生成或 DAG 步进重放（▶）中，仅更新设置，下次运行或刷新时生效。',
        'Delay in milliseconds between steps during DAG step replay (▶). Stored locally; the value is read when you press play—changing it mid-playback does not affect the current run.':
            'DAG 步进重放（▶）时相邻两步之间的间隔（ms）。写入本地存储；每次点击播放时读取当前输入，播放中途改数值不影响本轮。',
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
        'A ❤️ would mean a lot!': '喜欢就点个❤️吧！',
        'LLM × Linguistics × Information Theory': '大模型 × 语言学 × 信息论',
        
        // ========== 通用按钮和操作 ==========
        'Add': '添加',
        'Analyze': '分析',
        'Analyze & Upload': '分析并上传',
        'Analyze&Upload': '分析并上传',
        'Analyze URL': '分析 URL',
        'Analyze URL content': '分析 URL 内容',
        'Please enter a URL.': '请输入 URL。',
        'Invalid input': '输入无效',
        'Invalid URL': 'URL 无效',
        'This does not look like a valid URL. Check for typos.': '这不像有效的网址，请检查是否输错。',
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
        'Reset UI options': '重置界面选项',
        'Restore DAG options, play speed, exclusions, etc. to defaults and clear saved preferences for those controls.':
            '将 DAG 参数、播放速度、排除正则等恢复为默认值，并清除这些控件的本地保存项。',
        'Play speed': '播放速度',
        'Disable smart step time': '禁用智能步长时间',
        'When checked, propagation chain animation (↯) uses a uniform interval per frame instead of scaling by attribution weight. DAG step replay (▶) is unchanged. Saved locally; applied when you press play.':
            '勾选后，传播链动画（↯）各帧使用均匀间隔，不再按归因权重缩放；步进重放（▶）不受影响。本地保存；点击播放时生效。',
        'Auto zoom': '自动缩放',
        'Slide prompt in animation': '动画中 slide 扫过 prompt',
        'When checked, step replay (▶) fits the viewport after each step (stops if you pan or zoom). Saved locally.':
            '勾选后，步进重放（▶）每步自动适配视口（手动平移/缩放后停止）。本地保存。',
        'Causal Flow Mode': '因果流模式',
        'Unchecked: direct attribution — immediate predecessors only (default). Checked: Causal Flow Mode (↯) — trace from the focused token back to information sources. Sources: prompt; surprising or teacher-forced generated tokens (MI decay stops the chain). Conduits: high-confidence middle tokens—attribution passes through. Blue edges: propagated share; node ring: attribution stay (strong where explanation lands). Use with Decay attribution to high-surprisal targets. On the DAG, ↯ plays the focus propagation chain; ▶ replays generation steps when no token is focused.':
            '未勾选：原始直接归因（仅一跳前驱，默认）。勾选：因果流模式（↯）— 从焦点 token 向上追溯到信息来源。来源：prompt；高惊讶或 teacher-forced 的生成 token（MI 衰减可截断链）。传导：高置信中间 token，归因穿过。蓝边：传播份额；节点环：归因停留（解释落点处更强）。建议与「向高惊讶目标衰减归因」配合使用。DAG 上：↯ 播放焦点传播链；无焦点时 ▶ 步进重放生成过程。',
        'Direction for focus-chain batch animation when you press propagation play (↯) on the DAG with a focused token in Causal Flow Mode.':
            '因果流模式下，对已聚焦 token 在 DAG 上按传播播放（↯）时，焦点传播链分批动画的方向。',
        'When checked, direct attribution focus also shows outgoing edges from the selected or hovered token as downstream influence. Causal Flow Mode keeps showing upstream attribution chains only.':
            '勾选后，直接归因焦点下还会显示从选中/悬浮 token 出发的下游影响出边。因果流模式仍只显示向上游的归因链。',
        'Total duration or per-step simulated cost. DAG step replay (▶) divides evenly or uses a fixed per-token cost; propagation chain animation (↯) scales each frame by attribution weight.':
            '总时长或单步模拟开销。DAG 步进重放（▶）按步均分或固定单步开销；传播链动画（↯）按各层归因权重缩放每帧模拟开销。',
        'Total seconds. DAG step replay (▶) divides evenly across steps; propagation chain (↯) splits by layer weight. Saved locally; applied when you press play or select a focus node.':
            '总秒数。步进重放（▶）在步间均分；传播链（↯）按层权重分配。本地保存；点击对应播放钮或选中焦点节点时生效。',
        'Total seconds. With no focused token, DAG step replay (▶) divides evenly; in Causal Flow Mode with a focused token, propagation play (↯) runs focus-chain animation split by layer weight. Saved locally; applied when you press play.':
            '总秒数。无焦点时步进重放（▶）在步间均分；因果流模式下对已聚焦 token 按传播播放（↯）时，按层权重运行焦点传播链动画。本地保存；点击播放时生效。',
        'Milliseconds per step. DAG step replay (▶) uses this fixed interval; propagation chain (↯) multiplies by layer weight. Saved locally; applied when you press play or select a focus node.':
            '每步毫秒数。步进重放（▶）使用固定间隔；传播链（↯）乘以层权重。本地保存；点击对应播放钮或选中焦点节点时生效。',
        'Milliseconds per step. DAG step replay (▶) uses this as the 1× output-gen clock; with a focused token in Causal Flow Mode, propagation play (↯) scales each batch by layer weight. Saved locally; applied when you press play.':
            '每步毫秒数。步进重放（▶）作为 output gen 的 1× 时钟；因果流模式下对已聚焦 token 按传播播放（↯）时，各批按层权重缩放模拟开销。本地保存；点击播放时生效。',
        'Cached history': '历史缓存',
        'Cached demo': '示例缓存',
        'Demo not found': '未找到该示例缓存',
        'No run to export': '当前无可导出的运行结果',
        'History': '输入历史',
        'Raw prompt': '原始提示词',
        'Raw prompt mode': '原始提示词模式',
        'Enable thinking': '启用思考模式',
        'Tool use': '工具使用',
        'Multi-turn': '多轮',
        'Config tools': '配置工具',
        'Add tool': '新增工具',
        'custom': '自定义',
        'custom, will not save': '自定义，未勾选不会保存',
        'When Tool use is on, configure at least one tool in Config tools.':
            '已开启 Tool use，请先在 Config tools 中至少勾选一个工具。',
        'Invalid tool_call JSON in model output': '模型输出中 tool_call JSON 无效。',
        'Tool calling reached max rounds ({max})': 'Tool calling 已达最大轮数（{max}），已停止。',
        'Teacher forcing': 'Teacher forcing 强制续写',
        'Stop after teacher forcing': '续写结束后停止（不继续 top-1 生成）',
        'When enabled, type the exact continuation after the assembled prompt. Each step attributes the next token toward that text (same tokenizer as Model), then stops when the continuation is consumed or EOS.':
            '启用后，在下方填写接在「完整 prompt」之后的期望续写文本。每一步用该串剩余部分的第一个 token 作为归因目标（与所选 Model 槽位分词器一致）；续写消费完或遇到 EOS 时结束。',
        'Expected generated text after the full prompt. Each API step uses the first token of what remains here as the attribution target.':
            '期望模型在完整 prompt 之后生成的文字；每一步对当前剩余串的第一个 token 做归因目标。',
        'When unchecked, generation continues with top-1 after teacher forcing tokens are exhausted, up to Max tokens.':
            '未勾选时，teacher forcing 续写用完后将继续以 top-1 贪心生成，直到 Max tokens 或 EOS。',
        'When enabled, this text is appended to the assembled prompt (raw or chat template) before completion. GLTR colors apply only to newly generated tokens, not the appended suffix.':
            '启用后，该文本会拼接到已组装的 prompt（原始或 chat 模板）之后、再调用 completion。GLTR 着色仅作用于新生成的 token，不包含拼接的续写后缀。',
        'Text appended to the full prompt before calling /v1/completions. The suffix is part of the input, not model-generated output.':
            '调用 /v1/completions 前拼接到完整 prompt 末尾的文本；属于输入的一部分，而非模型生成结果。',
        'Ask': '提问',
        'Force retry': '强制重试',
        'Retry': '重试',
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
        'semantic match progress': '匹配度进度图',
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
        'Attribution share:': '归因份额：',
        'Attribution share (Total):': '归因份额（总计）：',
        'Attribution share (Self):': '归因份额（自身）：',

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
        'Semantic Query(Beta)': '语义查询(Beta)',
        'Enter query question or topic': '请输入查询问题或主题',
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
