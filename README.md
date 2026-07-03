# learn-agent · 从零写一个能活下来的 AI Agent

**简体中文** · [English](./README_EN.md)

> 一个 `while` 循环是 agent 的全部秘密——**但只够它活 5 分钟**。
> 剩下的部分——让它在真实任务里活过 5 小时——就是这些笔记记的东西。

想搞懂 **Claude Code、Codex、opencode** 这类 coding agent 内部到底怎么实现？这个仓库是我从 0 开发自己的 agent 时的踩坑笔记。

> **和别的"手写 agent"教程不一样的地方**：这里的机制不是照着 API 文档想象的，而是从一个**真实在跑、完整开源的桌面 coding agent 产品**（[Reina](https://github.com/Reina-Agent/Reina)）简化移植而来——**每一条报错、每一个机制优化，都是线上踩过的坑**。

## 笔记内容

它们看起来很简单，真去实现才发现里面大有可学。
**但从"能跑"到"能用"，中间隔着一整层没人系统讲过的工程**——它会空转烧钱、会吃撑爆窗、会跑半小时忘了最初任务、会因为不懂缓存贵 10 倍、会被卡死的子任务拖住。每一篇解决一个这样的真实问题。

代码全部**零依赖、单文件、Node 18+ 直接跑**，任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）。

## 快速开始

```sh
git clone https://github.com/7-e1even/learn-agent && cd learn-agent
AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs
```

跑起来后，从 s01 顺着读到 s15，每篇边读 README 边跑代码即可。

## 目录

循环在第 1 篇写完，**之后尽量不改**——所有机制都围着它长。每篇的结构一致：**踩过的坑 → 设计决定 → 可跑代码走读 → 真实产品对照 → 动手挑战**。

| # | 主题 | 解决翻车点 |
|---|---|---|
| [s01](./s01_agent_loop/) | 一个循环，一双手 | agent 和 chatbot 的全部区别是一个 `while` |
| [s02](./s02_tool_system/) | 工具箱与调度 | 加工具不改循环；Edit 唯一匹配契约的深意 |
| [s03](./s03_loop_budget/) | 循环预算与自动纠偏 | 复读机/原地踏步/连环报错，先拍肩膀再熔断 |
| [s04](./s04_output_budget/) | 工具输出预算 + 无损溢出 | 一条 `cat` 就能爆窗；截断丢信息，溢出到磁盘不丢 |
| [s05](./s05_streaming_interrupt/) | 流式与中断 | Ctrl+C 之后，坏掉的消息序列怎么修 |
| [s06](./s06_compaction/) | 上下文压缩 | 压缩后不忘最初任务：启动消息逐字保留 |
| [s07](./s07_prompt_cache/) | 缓存命中工程 | 前缀稳定性；连压缩摘要那一次调用都能省 90% |
| [s08](./s08_persistence/) | 会话落盘与恢复 | 断了能接上，才叫能用 |
| [s09](./s09_subagent_watchdog/) | 子代理与心跳看门狗 | 卡死检测（闲置 vs 在工具里）、击杀前抢救遗言 |
| [s10](./s10_prompt_assembly/) | System prompt 组装 | prompt 是每轮拼出来的，不是写死的；skills 按需加载 |
| [s11](./s11_agent_team/) | 多 agent 协作 | DAG 任务图、同 brief 去重、并发上限 |
| [s12](./s12_full_agent/) | 合体 | 全部机制回到同一个循环；免 key 端到端自测 |
| [s13](./s13_permissions/) | 权限与审批 | 危险操作在副作用前裁决；allow/deny/ask 三态首匹配 |
| [s14](./s14_provider_compat/) | Provider 兼容层 | 模型乱吐 tool call（名字/参数/截断/散文）在边界掰平 |
| [s15](./s15_tool_disclosure/) | 渐进式工具披露 | 工具多了不撑爆上下文；解蔽别回灌数组、撞缓存 |

## 完整实现

这 15 课的机制在真实产品里长什么样？完整源码在 **[Reina](https://github.com/Reina-Agent/Reina)** —— 一个开源的桌面 AI agent（Electron + React + TypeScript）。每篇"真实产品对照"提到的引擎、压缩、缓存、权限、Provider 兼容层，都能在里面找到对应实现，欢迎对照阅读。

## License

本项目基于 [MIT License](./LICENSE) 开源，© 2026 7-e1even。
