# Frontend as agent runtime for tool calling

info_radar 没有独立的"应用后端"层，只有前端和模型后端。Tool calling（多轮）的运行时职责（解析 tool call、mock 执行、多轮编排）由前端承担，而不是放进模型后端。相应地，Tool config（tools schema + mock 映射）作为运行时状态存储在前端的 Run Draft 中，不在后端维护。单轮 tool calling 仅注入 schema、不做回灌。

模型后端只负责：接收 `messages` 数组和 `tools` schema，套用 chat template，运行 `model.generate`，返回续写文本和 bpe_strings。它不感知"这是第几轮"，也不持有任何工具配置。

## Considered Options

将 agent loop 放进模型后端，前端只发一次请求拿完整结果。拒绝原因：这将应用编排逻辑压入模型服务层，混淆了二者的职责边界；且后端处理多轮循环时流式输出需要额外的轮次分隔信令，而前端编排时每轮 SSE 天然独立。
