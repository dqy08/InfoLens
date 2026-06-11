# Info Lens

探索 LLM 与语言的信息结构；可视化预测、归因与生成过程。

## Language

**Tool call**:
模型在生成中发出的函数调用片段，通常包在 `<tool_call>…</tool_call>` 内，含函数名与参数 JSON。本项目中默认指展示与分析用途，不执行真实工具。
_Avoid_: function call（在与 OpenAI API 字段混用时可用，但领域讨论优先用 tool call）

**Tool config**:
用户可配置的工具集合，包含两个字段：`tools_schema`（注入 chat template 的 JSON schema 数组）和 `mock_results`（tool name → 假返回值的映射）。二者作为整体单元一起切换，避免 schema 与 mock 不一致。存储在前端 Run Draft 中，随生成参数一起持久化。
_Avoid_: tools preset（旧称，指后端硬编码的静态配置，已废弃）、tool list

**Tool calling 开关**:
chat 模板模式下、User 输入区上方的勾选框；默认关闭。开启后显示「多轮 & mock」子开关。旧缓存与 demo 无此字段时视为关闭，不做迁移。
_Avoid_: tool call mode、agent mode

**Tool calling（单轮）**:
在 chat template 中注入 tool config 的 schema，让模型产出 tool call 文本；不执行工具、不回灌结果。生成结果中的 tool call 与普通 token 同等对待。「多轮 & mock」关闭时的形态。
_Avoid_: observational、agent

**Tool calling（多轮）**:
在 chat template 中注入 tool config 的 schema，解析模型产出的 tool call，用 tool config 的 mock_results 回灌假数据，再驱动下一轮生成；只要解析成功且 mock 表中有对应 tool name 就继续下一轮，否则自然结束（无 tool call、或未配置 mock 均不报错）。`<tool_call>` 存在但 JSON 无效时报错。每轮生成各自保留 bpe_strings；**wire 模型**：前端维护一条单调增长的字符串 `wire`，首轮为 `apply_chat_template` 完整 prompt（含 teacher forcing），后续每轮将模型输出与后端返回的 `incremental_suffix` 依次追加；UI 首轮 input 展示完整 `wire`，后续轮次 input 展示本轮的 `incremental_suffix`（即 tool response + generation scaffold），output 展示当轮续写全文。`incremental_suffix` 由后端 `POST /v1/completions/prompt-incremental` 通过 placeholder 技术从 chat template 中提取，与前序历史内容无关。「多轮 & mock」开启时的形态。
_Avoid_: closed-loop、agent loop（指真实工具执行的完整代理流程）、mock agent

**Causal Flow 多轮 tool calling**:
Causal Flow 页的多轮 tool calling 形态。与 chat 页共享 wire 模型和 mock 编排逻辑，区别在于每轮用 `/api/prediction-attribute` 逐 token 生成并归因（而非 `/v1/completions` 续写）。每轮是独立的 attribution session（`startTokenGenAttribution`），由 `runMultiTurnAttribution` 编排层协调：检测 tool call 完成（`onComplete` 时）、注入 `incremental_suffix`、启动下一轮 session。所有轮次的 `TokenGenStep` 扁平合并进同一 `steps[]`，全局坐标一致（每轮 session 的 `initialContext` = 完整 wire 前缀）。**Token 语义**：只有 input（原始 prompt + 每次 tool response 注入）和 output（所有轮次模型生成的 token）两类；DAG 用 `inputRanges: [number,number][]`（`TokenGenStep` 新字段）描述 context 中哪些区间是 input，DAG 节点着色与单轮一致（input=teal，output=orange）。Cache key 在多轮开启时追加 `toolConfigFingerprint`（含 mock_results）以避免不同 mock 的 run 互相覆盖。`maxTokens` 为全局生成 token 上限（跨轮共享，非每轮独立）。Stop 打断保留已完成 steps（含当轮已归因部分），completionReason='abort'。
_Avoid_: agent loop、closed-loop
