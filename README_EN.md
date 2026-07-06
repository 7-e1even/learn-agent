# learn-agent · Advanced Notes on Building an AI Agent

[简体中文](./README.md) · **English**

A series of advanced notes I compiled while developing [Reina](https://github.com/Reina-Agent/Reina), a desktop AI agent, covering how coding agents (tools like Claude Code, Codex, opencode) are implemented internally. Each note covers one mechanism and comes with a zero-dependency, single-file Node program you can run directly.

The notes extract Reina's core mechanisms, simplify them into single-file programs, and organize them in progressive order. The mechanisms here are not guessed from API docs — they are approaches validated in a real product.

At its core, an agent is one loop: the model asks for a tool, your code runs it and feeds the result back, until the model stops asking:

```js
while (true) {
  const msg = await chat(messages);       // call the model once
  messages.push(msg);
  if (!msg.tool_calls?.length) break;     // no more tool requests — turn is over

  for (const call of msg.tool_calls) {    // run each tool, feed the result back
    messages.push({ role: "tool", tool_call_id: call.id, content: runTool(call) });
  }
}
```

These fifteen-odd lines are the entire core of s01 (the full runnable version is about 120 lines). The rest of the notes cover what goes wrong once this loop meets real tasks, and how to fix each problem.

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

The main loop is finished in the first note and barely changes afterwards; every mechanism extends around it. s01–s12 build up a complete, usable agent step by step; s13 onward covers boundary concerns a real coding agent has to handle: permissions, provider compatibility, tool disclosure, multi-model collaboration, self-review. Every note follows the same structure: problem background → design decision → code walkthrough → comparison with the real product → exercises.

| # | Topic | The question it answers |
|---|---|---|
| [s01](./s01_agent_loop/) | The agent loop | What does the smallest usable agent look like? |
| [s02](./s02_tool_system/) | Tool system | How do you keep adding tools without touching the loop? |
| [s03](./s03_loop_budget/) | Loop budget & correction | The model spins in place or keeps erroring — how do you catch it and pull it back? |
| [s04](./s04_output_budget/) | Tool-output budget & spill | One `cat` can overflow the context — what then? |
| [s05](./s05_streaming_interrupt/) | Streaming & interruption | The user hits Ctrl+C mid-response — how do you repair the half-broken message history? |
| [s06](./s06_compaction/) | Context compaction | The context is full and must be compacted — how do you not forget the original task? |
| [s07](./s07_prompt_cache/) | Prompt caching | Same conversation — why is someone else's bill 10× cheaper? |
| [s08](./s08_persistence/) | Session persistence & resume | The process crashed half an hour in — how does the session pick up where it left off? |
| [s09](./s09_subagent_watchdog/) | Subagents & watchdog | A subtask hangs — how do you notice, and keep the work it already finished? |
| [s10](./s10_prompt_assembly/) | System-prompt assembly | The system prompt keeps growing — how do you assemble it on demand? |
| [s11](./s11_agent_team/) | Multi-agent coordination | Several agents working at once — how do they split work without duplicating or colliding? |
| [s12](./s12_full_agent/) | Full agent assembly | What do all the previous mechanisms look like back in one loop? |
| [s13](./s13_permissions/) | Permissions & approval | The model wants to run `rm -rf` — how do you stop it before it acts? |
| [s14](./s14_provider_compat/) | Provider compatibility | Switch models and the tool calls come out mangled — how do you stay compatible? |
| [s15](./s15_tool_disclosure/) | Progressive tool disclosure | Dozens of tools — how do you keep them from filling the context? |
| [s16](./s16_moa/) | MoA multi-model deliberation | Letting several models deliberate together — is it worth it? |
| [s17](./s17_self_evolution/) | Self-evolution review loop | Can the agent review its own conversations and distill what it learned into memory and skills? |
| [s17](./s17_self_evolution/) | Self-evolution review loop | Forking a restricted self every N turns to distill the conversation into memory/skills; the cadence, cache, and isolation bills |

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
