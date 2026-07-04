# learn-agent · Build an AI Agent That Actually Survives

[简体中文](./README.md) · **English**

![notes](https://img.shields.io/badge/notes-ongoing-blue)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933?logo=node.js&logoColor=white)
![MIT](https://img.shields.io/badge/license-MIT-lightgrey)
[![Full implementation · Reina](https://img.shields.io/badge/full_implementation-Reina-8A2BE2?logo=github)](https://github.com/Reina-Agent/Reina)

**Jump to**　·　[Who it's for](#who)　·　[Run in 30s](#start)　·　[All notes](#toc)　·　[Full impl · Reina](#reina)　·　[Star it](#star)

> A single `while` loop is the whole secret of an agent — **but it only keeps it alive for 5 minutes**.
> Everything else — what makes it survive 5 *hours* of real work — is what these notes are about.

Want to understand how coding agents like **Claude Code, Codex, opencode** actually work under the hood? This repo is my field notes from the potholes I hit building my own agent from scratch: **a growing series of progressive notes, each with a zero-dependency, single-file, runnable program**, each one fixing a real failure.

![every mechanism grows back onto the same loop](./assets/s12-mechanism-map.svg)

> [!IMPORTANT]
> **What makes this different from other "build your own agent" tutorials**: the mechanisms here aren't imagined from API docs. They're ported (and simplified) from a **real, shipping, fully open-source desktop coding agent** — **[Reina](https://github.com/Reina-Agent/Reina)** — and **every error handler, every optimization, is a bug that was actually hit in production**.
> Done with the notes and want the production-grade source? Go straight to 👉 **[Reina-Agent/Reina](https://github.com/Reina-Agent/Reina)**

<a id="who"></a>

## Is this for you

Three quick checks — if any one hits, it's worth your time:

- You've built an agent demo from a tutorial, but it falls apart on real tasks: **burns money spinning in circles, blows the context window, forgets its original task after half an hour**;
- You use Claude Code every day and want to know how the "magic" — compaction, caching, subagents, permission gates — **actually works inside**;
- You need to ship an agent at work and want a **production-tested checklist of mechanisms**, not another hello world.

Agents look simple. Try to actually implement one and you'll find there's a lot to learn. **The gap between "it runs" and "it's usable" is an entire layer of engineering nobody explains systematically** — each note solves one of these real problems.

<a id="start"></a>

## Running in 30 seconds

All code is **zero-dependency, single-file, runs on Node 18+**, and works with any OpenAI-compatible key (DeepSeek / Kimi / GLM / OpenRouter / local Ollama):

```sh
git clone https://github.com/7-e1even/learn-agent && cd learn-agent
AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs
```

No key handy? The self-test mode in [s12](./s12_full_agent/) runs the core loop end-to-end **without any key**.

Once it's running, read from s01 onward in order — read each README while running its code.

<a id="toc"></a>

## Contents

The loop is written in note 1 and **barely changes after that** — every mechanism grows around it. s01-s12 build and assemble the core loop; s13-s15 add the production hardening layers a real coding agent needs at the boundary. Each note has the same shape: **the bug that bit us → the design decision → a walk through runnable code → how the real product does it → hands-on challenge**.

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
| [s12](./s12_full_agent/) | Core assembly | Core mechanisms return to the same loop; key-free end-to-end self-test |
| [s13](./s13_permissions/) | Permissions & approval | Adjudicate dangerous ops before the side effect; allow/deny/ask, first match wins |
| [s14](./s14_provider_compat/) | Provider compatibility layer | Models spew malformed tool calls (name/args/truncation/prose) — flatten it at the boundary |
| [s15](./s15_tool_disclosure/) | Progressive tool disclosure | Too many tools blow up context; unshielding shouldn't re-inject the array or bust the cache |

<a id="reina"></a>

## Full implementation: Reina — these mechanisms in a real product

These notes weren't written in a vacuum — they all come from the potholes I hit building **[Reina](https://github.com/Reina-Agent/Reina)**, a **fully open-source, actually-usable** desktop AI agent (Electron + React + TypeScript). This repo is my study notes from pulling Reina's core mechanisms out and simplifying them into single files; to see what they really look like in production code, go compare against the main repo:

| What you learn here | Jump into Reina's real code |
|---|---|
| s01 · The main loop | The agent engine → [`core/engine.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/engine.ts) |
| s03 / s04 · Budget & spill | Cost & context guardrails → [`core/loop-budget.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/loop-budget.ts) |
| s06 / s07 · Compaction & cache | Compaction [`compaction.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/compaction.ts) · cache stability [`engine-prompt.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/engine-prompt.ts) |
| s09 / s11 · Subagents & multi-agent | Watchdog [`subagent/activity.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/subagent/activity.ts) · scheduling [`subagent/manager.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/subagent/manager.ts) |
| s13 / s14 · Permissions & provider compat | Approval [`permissions.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/core/src/permissions.ts) · provider compat [`providers/tool-compat.ts`](https://github.com/Reina-Agent/Reina/blob/main/packages/providers/src/tool-compat.ts) |

> 👉 **If these notes helped, don't forget to ⭐ the full version at [Reina-Agent/Reina](https://github.com/Reina-Agent/Reina)** — the notes reason through *why* it's built this way; the main repo gives you production-grade code you can actually ship.

<a id="star"></a>

## If this helped you

No course to sell, no newsletter funnel — just notes and code. If this repo saved you from stepping in even one pothole, a ⭐ is the only way more people will find it. Spot a factual error or a code bug? Open an issue and let's argue it out.

## License

Released under the [MIT License](./LICENSE) — © 2026 7-e1even.
