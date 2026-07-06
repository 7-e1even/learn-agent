# learn-agent · AI Agent 开发进阶笔记

**简体中文** · [English](./README_EN.md)

这是我开发桌面 agent [Reina](https://github.com/Reina-Agent/Reina) 过程中整理的一系列进阶笔记，讲解 coding agent（Claude Code、Codex、opencode 这类工具）的内部实现机制。每篇笔记讲一个机制，配一份零依赖、单文件、可以直接运行的 Node 程序。

笔记把 Reina 的核心机制抽出来，简化成单文件代码，按由浅入深的顺序整理成文。因此这里的机制不是照 API 文档推想的，而是实际产品中验证过的做法。

Agent 的核心只有一个循环：模型说要用什么工具，代码执行并把结果喂回去，直到模型不再要工具：

```js
while (true) {
  const msg = await chat(messages);       // 调一次模型
  messages.push(msg);
  if (!msg.tool_calls?.length) break;     // 模型不再要工具，这一轮结束

  for (const call of msg.tool_calls) {    // 模型要用工具：执行，把结果喂回去
    messages.push({ role: "tool", tool_call_id: call.id, content: runTool(call) });
  }
}
```

这十几行就是 s01 的全部核心（完整可运行版约 120 行）。笔记的其余部分讲的是：这个循环放进真实任务后会出什么问题，以及每个问题怎么解决。

![所有机制最终都建立在同一个循环上](./assets/s12-mechanism-map.svg)

## 适合

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

主循环在第 1 篇写完，之后基本不再改动，所有机制都围绕它扩展。s01–s12 逐步搭出一个完整可用的 agent；s13 之后补充真实 coding agent 需要处理的边界问题：权限、Provider 兼容、工具披露、多模型协作、自我复盘。每篇结构一致：问题 → 解决方案 → 运行 → 实现 → 练习 → 真实产品对照。

| # | 主题 | 要解决的问题 |
|---|---|---|
| [s01](./s01_agent_loop/) | Agent 主循环 | 最小可用的 agent 长什么样 |
| [s02](./s02_tool_system/) | 工具系统 | 工具越加越多，怎么不用每次都改循环 |
| [s03](./s03_loop_budget/) | 循环预算与纠偏 | 模型原地打转、反复报错，怎么发现并拉回来 |
| [s04](./s04_output_budget/) | 工具输出预算与溢出 | 一条 `cat` 的输出就能撑爆上下文，怎么办 |
| [s05](./s05_streaming_interrupt/) | 流式输出与中断 | 用户按下 Ctrl+C，断在一半的消息记录怎么修 |
| [s06](./s06_compaction/) | 上下文压缩 | 上下文满了要压缩，怎么不忘掉最初的任务 |
| [s07](./s07_prompt_cache/) | Prompt 缓存 | 同样的对话，为什么有人的账单贵 10 倍 |
| [s08](./s08_persistence/) | 会话持久化与恢复 | 进程崩了，跑了半小时的会话怎么接着跑 |
| [s09](./s09_subagent_watchdog/) | 子代理与看门狗 | 子任务卡死了，怎么发现它并保住已完成的部分 |
| [s10](./s10_prompt_assembly/) | System prompt 组装 | system prompt 越写越长，怎么按需拼装 |
| [s11](./s11_agent_team/) | 多 agent 协作 | 几个 agent 同时干活，怎么分工不重复不冲突 |
| [s12](./s12_full_agent/) | 完整 agent 整合 | 前面所有机制装回一个循环里是什么样 |
| [s13](./s13_permissions/) | 权限与审批 | 模型要执行 `rm -rf`，怎么在动手前拦住 |
| [s14](./s14_provider_compat/) | Provider 兼容层 | 换个模型 tool call 格式全乱，怎么兼容 |
| [s15](./s15_tool_disclosure/) | 渐进式工具披露 | 工具有几十个，怎么不把上下文塞满 |
| [s16](./s16_moa/) | MoA 多模型合议 | 让多个模型一起商量，到底值不值 |
| [s17](./s17_self_evolution/) | 自进化复盘环 | agent 能不能自己复盘对话，把学到的沉淀成记忆和技能 |

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

发现笔记中的事实错误或代码 bug，欢迎提 issue。

## License

本项目基于 [MIT License](./LICENSE) 开源，© 2026 7-e1even。
