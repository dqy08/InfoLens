# Info Lens

探索 LLM 与语言的信息结构；可视化预测、归因与生成过程。

## Product focus

**Core product**: LLM **Causal Flow**（`causal_flow.html`）— 逐 token 生成与 context–attribution DAG，支持多轮 tool calling。首页导航首位；性能与部署优先保障此页。

**Core inference path**: **instruct 槽位**（`--instruct_model` / `model: "instruct"`）— Causal Flow 归因、tokenize、多轮 wire、续写（`/v1/completions`）均走此槽。
