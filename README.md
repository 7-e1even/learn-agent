# learn-agent · 从零实现一个 AI Agent

**简体中文** · [English](./README_EN.md)

这是一系列讲解 coding agent（Claude Code、Codex、opencode 这类工具）内部实现机制的笔记。每篇笔记讲一个机制，配一份零依赖、单文件、可以直接运行的 Node 程序。

笔记的内容来自我开发桌面 agent [Reina](https://github.com/Reina-Agent/Reina) 的过程：把其中的核心机制抽出来，简化成单文件代码，按由浅入深的顺序整理成文。因此这里的机制不是照 API 文档推想的，而是实际产品中验证过的做法。

![所有机制最终都建立在同一个循环上](./assets/s12-mechanism-map.svg)

## 适合谁读

- 写过 agent demo，但在真实任务上遇到问题：循环空转、上下文超限、任务跑偏；
- 日常使用 Claude Code，想知道压缩、缓存、子代理、权限审批这些机制内部怎么实现；
- 需要在工作中落地 agent，想要一份经过实际验证的机制清单。

Agent 的基本循环很简单，但从"能跑"到"能用"之间有一整层工程问题：成本控制、上下文管理、缓存、持久化、并发、权限。这套笔记每篇解决其中一个。

## 运行方式

代码零依赖，Node 18 以上直接运行，支持任何 OpenAI 兼容的 API key（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）：

```sh
git clone https://github.com/7-e1even/learn-agent && cd learn-agent
AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs
```

没有 key 的话，[s12](./s12_full_agent/) 提供不需要 key 的自测模式，可以端到端跑通核心机制。

建议从 s01 开始按顺序阅读，边读 README 边运行对应代码。

## 目录

主循环在第 1 篇写完，之后基本不再改动，所有机制都围绕它扩展。s01–s12 逐步搭出一个完整可用的 agent；s13 之后补充真实 coding agent 需要处理的边界问题：权限、Provider 兼容、工具披露、多模型协作。每篇结构一致：问题背景 → 设计决定 → 代码走读 → 真实产品对照 → 练习。

| # | 主题 | 解决的问题 |
|---|---|---|
| [s01](./s01_agent_loop/) | Agent 主循环 | agent 与 chatbot 的核心区别：一个由模型决定何时停止的循环 |
| [s02](./s02_tool_system/) | 工具系统 | 新增工具不修改循环；Edit 工具唯一匹配约定的原因 |
| [s03](./s03_loop_budget/) | 循环预算与纠偏 | 检测重复输出、原地打转、连续报错，先提醒再熔断 |
| [s04](./s04_output_budget/) | 工具输出预算与溢出 | 单条命令输出可能撑爆上下文；截断丢信息，溢出到磁盘不丢 |
| [s05](./s05_streaming_interrupt/) | 流式输出与中断 | Ctrl+C 之后如何修复不完整的消息序列 |
| [s06](./s06_compaction/) | 上下文压缩 | 压缩后保留初始任务：启动消息逐字保留 |
| [s07](./s07_prompt_cache/) | Prompt 缓存 | 保持前缀稳定以命中缓存，压缩摘要调用同样适用 |
| [s08](./s08_persistence/) | 会话持久化与恢复 | 会话中断后可以恢复继续 |
| [s09](./s09_subagent_watchdog/) | 子代理与看门狗 | 区分闲置与工具内执行的卡死检测，终止前保留子代理结论 |
| [s10](./s10_prompt_assembly/) | System prompt 组装 | prompt 每轮动态拼装而非写死；skills 按需加载 |
| [s11](./s11_agent_team/) | 多 agent 协作 | DAG 任务图、相同任务去重、并发上限 |
| [s12](./s12_full_agent/) | 完整 agent 整合 | 核心机制整合进同一个循环；免 key 端到端自测 |
| [s13](./s13_permissions/) | 权限与审批 | 危险操作在产生副作用前审批；allow/deny/ask 三态首条匹配 |
| [s14](./s14_provider_compat/) | Provider 兼容层 | 处理模型输出的畸形 tool call（名字、参数、截断、散文） |
| [s15](./s15_tool_disclosure/) | 渐进式工具披露 | 工具数量多时不撑爆上下文；解蔽时避免破坏缓存 |
| [s16](./s16_moa/) | MoA 多模型合议 | 多模型合议接入工具循环的成本分析；评估后放弃也是有效结论 |

## 与 Reina 的对照

想看这些机制在生产代码中的完整实现，可以对照 Reina 主仓库：

| 笔记 | Reina 中的对应实现 |
|---|---|
| s01 · 主循环 | [`core/engine.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/engine.ts) |
| s03 / s04 · 预算与溢出 | [`core/loop-budget.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/loop-budget.ts) |
| s06 / s07 · 压缩与缓存 | [`compaction.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/compaction.ts) · [`engine-prompt.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/engine-prompt.ts) |
| s09 / s11 · 子代理与多 agent | [`subagent/activity.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/subagent/activity.ts) · [`subagent/manager.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/subagent/manager.ts) |
| s13 / s14 · 权限与 Provider 兼容 | [`permissions.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/permissions.ts) · [`providers/tool-compat.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/providers/src/tool-compat.ts) |

## 反馈

发现笔记中的事实错误或代码 bug，欢迎开 issue。

## License

本项目基于 [MIT License](./LICENSE) 开源，© 2026 7-e1even。
