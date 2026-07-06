# learn-agent · Build an AI Agent from Scratch

[简体中文](./README.md) · **English**

A series of notes on how coding agents (tools like Claude Code, Codex, opencode) are implemented internally. Each note covers one mechanism and comes with a zero-dependency, single-file Node program you can run directly.

The material comes from my experience building [Reina](https://github.com/Reina-Agent/Reina), a desktop AI agent: I extracted its core mechanisms, simplified them into single-file programs, and organized them in progressive order. The mechanisms here are not guessed from API docs — they are approaches validated in a real product.

![every mechanism builds on the same loop](./assets/s12-mechanism-map.svg)

## Who this is for

- You have built an agent demo, but it runs into problems on real tasks: idle looping, context overflow, drifting off task;
- You use Claude Code daily and want to know how compaction, caching, subagents, and permission gates are implemented internally;
- You need to ship an agent at work and want a list of mechanisms validated in practice.

The basic agent loop is simple, but between "it runs" and "it's usable" sits a full layer of engineering: cost control, context management, caching, persistence, concurrency, permissions. Each note solves one of these problems.

## Running the code

All code is zero-dependency and runs on Node 18+, with any OpenAI-compatible API key (DeepSeek / Kimi / GLM / OpenRouter / local Ollama):

```sh
git clone https://github.com/7-e1even/learn-agent && cd learn-agent
AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs
```

If you don't have a key, [s12](./s12_full_agent/) has a self-test mode that runs the core mechanisms end-to-end without one.

Read from s01 in order, running each note's code alongside its README.

## Contents

The main loop is finished in the first note and barely changes afterwards; every mechanism extends around it. s01–s12 build up a complete, usable agent step by step; s13 onward covers boundary concerns a real coding agent has to handle: permissions, provider compatibility, tool disclosure, multi-model collaboration. Every note follows the same structure: problem background → design decision → code walkthrough → comparison with the real product → exercises.

| # | Topic | Problem it solves |
|---|---|---|
| [s01](./s01_agent_loop/) | The agent loop | The core difference between an agent and a chatbot: a loop where the model decides when to stop |
| [s02](./s02_tool_system/) | Tool system | Adding tools without modifying the loop; why the Edit tool requires a unique match |
| [s03](./s03_loop_budget/) | Loop budget & correction | Detecting repeated output, spinning in place, and cascading errors; warn first, then break |
| [s04](./s04_output_budget/) | Tool-output budget & spill | A single command's output can overflow the context; truncation loses information, spilling to disk doesn't |
| [s05](./s05_streaming_interrupt/) | Streaming & interruption | Repairing an incomplete message sequence after Ctrl+C |
| [s06](./s06_compaction/) | Context compaction | Keeping the original task after compaction: preserve startup messages verbatim |
| [s07](./s07_prompt_cache/) | Prompt caching | Keeping the prefix stable to hit the cache, including on the compaction-summary call |
| [s08](./s08_persistence/) | Session persistence & resume | Resuming a session after an interruption |
| [s09](./s09_subagent_watchdog/) | Subagents & watchdog | Stall detection that distinguishes idle from in-tool execution; save the subagent's conclusion before terminating it |
| [s10](./s10_prompt_assembly/) | System-prompt assembly | The prompt is assembled every turn, not hardcoded; skills load on demand |
| [s11](./s11_agent_team/) | Multi-agent coordination | DAG task graph, deduplicating identical tasks, concurrency cap |
| [s12](./s12_full_agent/) | Full agent assembly | Core mechanisms integrated into one loop; key-free end-to-end self-test |
| [s13](./s13_permissions/) | Permissions & approval | Approving dangerous operations before side effects; allow/deny/ask, first match wins |
| [s14](./s14_provider_compat/) | Provider compatibility | Handling malformed tool calls from models (names, arguments, truncation, prose) |
| [s15](./s15_tool_disclosure/) | Progressive tool disclosure | Keeping context small with many tools; revealing tools without busting the cache |
| [s16](./s16_moa/) | MoA multi-model deliberation | Cost analysis of adding multi-model deliberation to a tool loop; deciding against it is a valid conclusion |

## Comparing with Reina

To see the full production implementation of these mechanisms, compare against the Reina repository:

| Note | Corresponding code in Reina |
|---|---|
| s01 · main loop | [`core/engine.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/engine.ts) |
| s03 / s04 · budget & spill | [`core/loop-budget.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/loop-budget.ts) |
| s06 / s07 · compaction & cache | [`compaction.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/compaction.ts) · [`engine-prompt.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/engine-prompt.ts) |
| s09 / s11 · subagents & multi-agent | [`subagent/activity.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/subagent/activity.ts) · [`subagent/manager.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/subagent/manager.ts) |
| s13 / s14 · permissions & provider compat | [`permissions.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/permissions.ts) · [`providers/tool-compat.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/providers/src/tool-compat.ts) |

## Feedback

If you spot a factual error or a code bug, please open an issue.

## License

Released under the [MIT License](./LICENSE) — © 2026 7-e1even.
