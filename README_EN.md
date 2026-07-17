# learn-agent · Notes from Building an AI Agent

[简体中文](./README.md) · **English**

Notes I took while developing [Reina](https://github.com/Reina-Agent/Reina), a desktop AI agent, covering how coding agents (tools like Claude Code, Codex, opencode) work internally. Each note covers one mechanism, simplified from Reina's production implementation into a zero-dependency, single-file, runnable Node program — so these approaches aren't guessed from API docs; they're validated in a real product.

![every mechanism builds on the same loop](./assets/s12-mechanism-map.svg)

## Running the code

Node 18+, zero dependencies:

```sh
git clone https://github.com/7-e1even/learn-agent && cd learn-agent
AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs
```

Any OpenAI-compatible API key works (DeepSeek / Kimi / GLM / OpenRouter / local Ollama); without one, most notes' `demo.mjs` and [s12](./s12_full_agent/)'s self-test mode need no key at all.

## Contents

s01–s12 build a complete, usable agent from scratch — read them in order; s13 onward are boundary problems I ran into (and wrote down) while developing Reina — pick what interests you. Each note ends with a pointer to the corresponding production code in Reina.

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
| [s18](./s18_completion_gate/) | Completion gate for autonomous runs | The agent says "done" — why should you believe it? |
| [s19](./s19_compaction_cache/) | Compaction vs. prompt cache | Compaction inevitably busts the cache — how do you minimize the damage? |
| [s20](./s20_memory_dream/) | Automatic long-term memory | Distilling what's worth remembering across projects — without burning tokens or hoarding junk |

---

Spotted a factual error or a code bug? Please open an issue. [MIT License](./LICENSE) · © 2026 7-e1even
