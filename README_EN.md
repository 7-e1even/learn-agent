# learn-agent · Build an AI Agent That Actually Survives

[简体中文](./README.md) · **English**

> A single `while` loop is the whole secret of an agent — **but it only keeps it alive for 5 minutes**.
> Everything else — what makes it survive 5 *hours* of real work — is what these notes are about.

Want to understand how coding agents like **Claude Code, Codex, opencode** actually work under the hood? This repo is my field notes from the potholes I hit building my own agent from scratch.

> **What makes this different from other "build your own agent" tutorials**: the mechanisms here aren't imagined from API docs. They're ported (and simplified) from a **real, shipping, fully open-source desktop coding agent** ([Reina](https://github.com/Reina-Agent/Reina)) — **every error handler, every optimization, is a bug that was actually hit in production**.

## What this is

They look simple. Try to actually implement one and you'll find there's a lot to learn.
**But the gap between "it runs" and "it's usable" is an entire layer of engineering nobody explains systematically** — it burns money spinning in circles, blows past the context window, forgets its original task after half an hour, pays 10× more because it doesn't understand caching, and gets dragged down by a stuck subtask. Each lesson solves one of these real problems.

All code is **zero-dependency, single-file, runs on Node 18+**, and works with any OpenAI-compatible key (DeepSeek / Kimi / GLM / OpenRouter / local Ollama).

## Quick start

```sh
git clone https://github.com/7-e1even/learn-agent && cd learn-agent
AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs
```

Once it's running, read s01 through s15 in order — read each README while running its code.

## Contents

The loop is written in lesson 1 and **barely changes after that** — every mechanism grows around it. Each lesson has the same shape: **the bug that bit us → the design decision → a walk through runnable code → how the real product does it → hands-on challenge**.

| # | Topic | The failure it fixes |
|---|---|---|
| [s01](./s01_agent_loop/) | One loop, one pair of hands | The entire difference between an agent and a chatbot is a `while` |
| [s02](./s02_tool_system/) | Toolbox & dispatch | Adding tools without touching the loop; why Edit's single-match contract matters |
| [s03](./s03_loop_budget/) | Loop budget & self-correction | Parroting / spinning in place / cascading errors — tap the shoulder before the breaker trips |
| [s04](./s04_output_budget/) | Tool-output budget + lossless spill | One `cat` can blow the window; truncation loses info, spilling to disk doesn't |
| [s05](./s05_streaming_interrupt/) | Streaming & interruption | After Ctrl+C, how to repair a broken message sequence |
| [s06](./s06_compaction/) | Context compaction | Don't forget the original task after compaction: keep the startup messages verbatim |
| [s07](./s07_prompt_cache/) | Cache-hit engineering | Prefix stability; save 90% even on the compaction-summary call itself |
| [s08](./s08_persistence/) | Session persistence & resume | It's only usable if it can pick up after a crash |
| [s09](./s09_subagent_watchdog/) | Subagents & heartbeat watchdog | Stall detection (idle vs. stuck in a tool), salvage last words before the kill |
| [s10](./s10_prompt_assembly/) | System-prompt assembly | The prompt is assembled every turn, not hardcoded; skills load on demand |
| [s11](./s11_agent_team/) | Multi-agent coordination | DAG task graph, same-brief dedup, concurrency cap |
| [s12](./s12_full_agent/) | Assembly | Every mechanism returns to the same loop; key-free end-to-end self-test |
| [s13](./s13_permissions/) | Permissions & approval | Adjudicate dangerous ops before the side effect; allow/deny/ask, first match wins |
| [s14](./s14_provider_compat/) | Provider compatibility layer | Models spew malformed tool calls (name/args/truncation/prose) — flatten it at the boundary |
| [s15](./s15_tool_disclosure/) | Progressive tool disclosure | Too many tools blow up context; unshielding shouldn't re-inject the array or bust the cache |

## The full implementation

Want to see what these 15 lessons' mechanisms look like in a real product? The complete source lives at **[Reina](https://github.com/Reina-Agent/Reina)** — an open-source desktop AI agent (Electron + React + TypeScript). Every engine, compaction, caching, permission, and provider-compat mechanism referenced in the "how the real product does it" sections has its full implementation there.

## License

Released under the [MIT License](./LICENSE) — © 2026 7-e1even.
