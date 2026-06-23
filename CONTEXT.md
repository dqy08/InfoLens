# Info Lens

探索 LLM 与语言的信息结构；可视化预测、归因与生成过程。

## Product focus

**Core product（核心产品）**:
LLM **Causal Flow**（`causal_flow.html`）— 逐 token 生成并构建 context–attribution DAG，支持多轮 tool calling。首页导航首位产品；性能、部署与分流决策优先保障此页体验。
_Avoid_: 把 Info Highlight（信息密度 / `analysis.html`）或 Raw Chat 当作默认核心产品表述

**Core inference path（核心推理路径）**:
**instruct 槽位**（`--instruct_model` / API `model: "instruct"`）— Causal Flow 的逐 token 归因（`POST /api/prediction-attribute`）、tokenize、多轮 wire 编排均走 instruct；续写类能力（`/v1/completions`）默认亦在此槽位。多 Space 部署时，instruct 宜低延迟、高可用（宜本地推理或专用 Worker，不宜作为次要 offload 对象）。
_Avoid_: 把 base 槽位（信息密度 `/api/analyze`）描述为产品主路径

## Language

**Tool call**:
模型在生成中发出的函数调用片段，通常包在 `<tool_call>…</tool_call>` 内，含函数名与参数 JSON。本项目中默认指展示与分析用途，不执行真实工具。
_Avoid_: function call（在与 OpenAI API 字段混用时可用，但领域讨论优先用 tool call）

**Tool catalog**:
代码库内 JSON 定义的可用 tool 全集。每条为 `function` 加 `mock_results` 候选列表；候选项含 `response`（JSON 对象，假 tool 返回值）；可选 `trigger_keyword` 在同一 function 下按 tool call 参数区分多个 mock。catalog 不由 UI 修改；`function.name` 在 catalog 内不重复。
_Avoid_: tools preset（旧称）、hardcoded tool list

**Mock candidate**:
catalog 内 `mock_results` 列表的一项：`response` 为对象；可选 `trigger_keyword` 用于按条件选用（子串匹配、区分大小写，对所有 string 参数值拼接后匹配；按数组顺序取首个命中；无命中时回退首个无 keyword 项；仍无则 mock 不执行、多轮自然结束）。UI 文本编辑的是其 JSON 表示；保存时校验后写入 tool config 快照。
_Avoid_: mock preset、default mock string

**Tool config**:
用户勾选 catalog 条目后、在文本模式下编辑整条 catalog 形状（`function` + `mock_results`），保存时 JSON 校验并落盘为快照：`entries`（`ToolCatalogEntry[]`，与 catalog 同形）。注入 chat template 的 `tools_schema` 由 `entries` 派生。读入旧快照（`tools_schema` + 扁平 `mock_results`）时静默迁移为 `entries`。未勾选任何 tool 时 tool config 为空。以完整内容存入 Run Draft / 缓存，后续 catalog 变更不影响已有记录。draft / demo 含 `toolConfig` 时按快照还原勾选与内容；无 `toolConfig` 时为空。Tool calling 开关开启而 tool config 为空时不可发起生成（点击生成时弹窗提示，引导打开 Config tools）。
_Avoid_: tools preset、tool list

**Config tools（弹窗）**:
列表 = 当前 tool config 快照中已选条目（各带 JSON 编辑区；可含 catalog 中已不存在的条目）+ catalog 中尚未选中的条目（仅 checkbox）。确认后 JSON 校验并写回快照；校验失败则弹窗不关闭、顶部一条错误提示。保存以 JSON 内 `function.name` 为准（可与 catalog 原名不同）；已选条目间 name 不得重复。取消则丢弃弹窗内未确认改动。确认后的 tool config 按页面独立持久化，刷新后仍可保留；加载带 `toolConfig` 的 draft / demo 时以 draft 为准覆盖之。允许确认后为零勾选（tool config 清空）。
_Avoid_: tool picker、tools settings

**Tool calling 开关**:
chat 模板模式下、User 输入区上方的勾选框；默认关闭。开启后显示「多轮 & mock」子开关。旧缓存与 demo 无此字段时视为关闭，不做迁移。
_Avoid_: tool call mode、agent mode

**Tool calling（单轮）**:
在 chat template 中注入 tool config 的 schema，让模型产出 tool call 文本；不执行工具、不回灌结果。生成结果中的 tool call 与普通 token 同等对待。「多轮 & mock」关闭时的形态。
_Avoid_: observational、agent

**Tool calling（多轮）**:
在 chat template 中注入 tool config 的 schema，解析模型产出的 tool call，按 mock candidate 规则解析出假返回后回灌，再驱动下一轮生成；解析成功且 mock 可解析时继续下一轮，否则自然结束（无 tool call、未配置 mock、或 keyword 无匹配且无 fallback 均不报错）。`<tool_call>` 存在但 JSON 无效时报错。每轮生成各自保留 bpe_strings；**wire 模型**：前端维护一条单调增长的字符串 `wire`，首轮为 `apply_chat_template` 完整 prompt（含 teacher forcing），后续每轮将模型输出与后端返回的 `incremental_suffix` 依次追加；UI 首轮 input 展示完整 `wire`，后续轮次 input 展示本轮的 `incremental_suffix`（即 tool response + generation scaffold），output 展示当轮续写全文。`incremental_suffix` 由后端 `POST /v1/completions/prompt-incremental` 通过 placeholder 技术从 chat template 中提取，与前序历史内容无关。「多轮 & mock」开启时的形态。
_Avoid_: closed-loop、agent loop（指真实工具执行的完整代理流程）、mock agent

**Causal Flow 多轮 tool calling**:
Causal Flow 页的多轮 tool calling 形态。与 chat 页共享 wire 模型和 mock 编排逻辑，区别在于每轮用 `/api/prediction-attribute` 逐 token 生成并归因（而非 `/v1/completions` 续写）。每轮是独立的 attribution session（`startTokenGenAttribution`），由 `runMultiTurnAttribution` 编排层协调：检测 tool call 完成（`onComplete` 时）、注入 `incremental_suffix`、启动下一轮 session。所有轮次的 `TokenGenStep` 扁平合并进同一 `steps[]`，全局坐标一致（每轮 session 的 `initialContext` = 完整 wire 前缀）。**Token 语义**：只有 input（原始 prompt + 每次 tool response 注入）和 output（所有轮次模型生成的 token）两类；DAG 用 `inputRanges: [number,number][]`（`TokenGenStep` 新字段）描述 context 中哪些区间是 input，DAG 节点着色与单轮一致（input=teal，output=orange）。Cache key 在多轮开启时追加 `toolConfigFingerprint`（含 mock_results）以避免不同 mock 的 run 互相覆盖。`maxTokens` 为全局生成 token 上限（跨轮共享，非每轮独立）。Stop 打断保留已完成 steps（含当轮已归因部分），completionReason='abort'。
_Avoid_: agent loop、closed-loop
