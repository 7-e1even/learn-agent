# learn-agent · 从零写一个能活下来的 AI Agent

**简体中文** · [English](./README_EN.md)

[![GitHub stars](https://img.shields.io/github/stars/7-e1even/learn-agent?style=social)](https://github.com/7-e1even/learn-agent/stargazers)
![15 篇](https://img.shields.io/badge/%E7%AC%94%E8%AE%B0-15%20%E7%AF%87-blue)
![零依赖](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-brightgreen)
![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?logo=node.js&logoColor=white)
![MIT](https://img.shields.io/badge/license-MIT-lightgrey)
[![完整实现 · Reina](https://img.shields.io/badge/%E5%AE%8C%E6%95%B4%E5%AE%9E%E7%8E%B0-Reina-8A2BE2?logo=github)](https://github.com/Reina-Agent/Reina)

> 一个 `while` 循环是 agent 的全部秘密——**但只够它活 5 分钟**。
> 剩下的部分——让它在真实任务里活过 5 小时——就是这 15 篇笔记记的东西。

想搞懂 **Claude Code、Codex、opencode** 这类 coding agent 内部到底怎么实现？这个仓库是我从 0 开发自己的 agent 时的踩坑笔记：**15 篇渐进式笔记 + 15 份零依赖、单文件、直接能跑的代码**，每篇解决一个真实翻车现场。

![15 套机制，最后都长回同一个循环上](./assets/s12-mechanism-map.svg)

> [!IMPORTANT]
> **和别的"手写 agent"教程不一样的地方**：这里的机制不是照着 API 文档想象的，而是从一个**真实在跑、完整开源的桌面 coding agent 产品**——**[Reina](https://github.com/Reina-Agent/Reina)**——简化移植而来，**每一条报错、每一个机制优化，都是线上踩过的坑**。
> 学完这 15 篇想看生产级完整源码，直接去 👉 **[Reina-Agent/Reina](https://github.com/Reina-Agent/Reina)**

## 这份笔记适合你吗

对着下面三条自查，中一条就值得读：

- 你照教程写过 agent demo，但一上真实任务就失控：**空转烧钱、上下文爆窗、跑半小时忘了最初任务**；
- 你每天在用 Claude Code，想知道压缩、缓存、子代理、权限审批这些"魔法"**内部到底怎么做的**；
- 你要在工作里落地 agent，想要一份**被生产环境验证过的机制清单**，而不是再看一遍 hello world。

Agent 看起来很简单，真去实现才发现里面大有可学。**从"能跑"到"能用"，中间隔着一整层没人系统讲过的工程**——它会空转烧钱、会吃撑爆窗、会跑半小时忘了最初任务、会因为不懂缓存贵 10 倍、会被卡死的子任务拖住。每一篇解决一个这样的真实问题。

## 30 秒跑起来

代码全部**零依赖、单文件、Node 18+ 直接跑**，任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）：

```sh
git clone https://github.com/7-e1even/learn-agent && cd learn-agent
AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs
```

手上一时没有 key？[s12](./s12_full_agent/) 的自测模式**不需要任何 key** 也能端到端跑通全部机制。

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

## 如果它帮到了你

这个仓库不卖课、不引流，只有笔记和代码。如果它帮你少踩了一个坑，顺手点个 ⭐——这是让更多人看到它的唯一方式。发现笔记里有事实错误或代码 bug，直接开 issue，当面对线。

## License

本项目基于 [MIT License](./LICENSE) 开源，© 2026 7-e1even。
