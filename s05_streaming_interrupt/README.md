# s05 · 流式输出与中断

你给 agent 一个多步任务，它闷头执行半分钟，屏幕上什么都没有——不知道是卡住了还是在干活。加上流式输出（逐字打印）后，多半还会加 Ctrl+C 中断——跑错方向的任务得能停。然后新问题出现：中断之后再发一条消息，API 直接报 400 拒收。本章解决这两件事：流式逐字输出，以及让中断过的会话能继续。

本章代码 = s03 的最小 agent 循环（调模型→执行工具→结果发回再调模型）+ 流式解析与中断修复模块 [stream.mjs](./stream.mjs)。

## 问题：中断会破坏消息序列

先补一个协议知识：模型想用工具时，会在回复（assistant 消息）里带一批 `tool_calls`，每个有唯一 id；协议要求每个 id 后面必须跟一条对应的 `tool` 消息（工具执行结果）。

看一下 Ctrl+C 那一刻的消息序列：

```
user:      "把测试跑一遍，顺便看下 README"
assistant: tool_calls: [call_test → run_shell, call_read → read_file]
tool:      (call_test 的结果 —— 第一个工具跑完了)
                     ← Ctrl+C 落在这里，call_read 永远没有结果
```

`call_read` 没有对应结果——原样发出去，服务端拒收（400，报错原文见文末）。而且流是中途切断的，`call_read` 的参数可能停在 JSON 中间（`{"path":"READ`）。怎么处理这个残缺序列，决定了中断后会话能否继续。

![Ctrl+C 后用合成 tool 结果修复悬空 tool_call](../assets/s05-tool-call-repair.svg)

## 设计：四个关键决定

### ① SSE 解析：按行缓冲，而不是按 chunk 处理

SSE（Server-Sent Events）是流式输出的传输方式：`stream: true` 时服务端保持连接打开，把回答切成小片逐个推送，每片是文本流里的一行：

```
data: {"choices":[{"delta":{"content":"我来"}}]}

data: {"choices":[{"delta":{"content":"查一下"}}]}

data: [DONE]
```

`data: ` 开头是数据行，空行是分隔符，`data: [DONE]` 表示结束。看起来逐行 parse 即可，但你收到的单位不是"行"：网络传输切分数据时不管语义，一个 chunk 可能停在 `data: {"cho` 中间，甚至停在一个 UTF-8 多字节字符中间。所以必须按行缓冲，凑齐一行才处理一行（[stream.mjs](./stream.mjs)）：

```js
buffer += decoder.decode(chunk, { stream: true }); // stream 模式：不完整的多字节字符先保留
let newline;
while ((newline = buffer.indexOf("\n")) !== -1) {  // 凑齐完整的一行才处理一行
  const line = buffer.slice(0, newline).replace(/\r$/, "");
  buffer = buffer.slice(newline + 1);
  if (!line.startsWith("data:")) continue;          // 空行、": 心跳" 注释行，都跳过
  // ...
}
```

### ② tool_calls 分片：按 index 装配

文本增量直接拼接即可。tool_calls 的增量是被切碎的 JSON 字符串：第一片带 `id` 和函数名，后续片只带参数的几个字符；并行调用时多个 call 的分片交错到达，靠 `index` 归位：

```js
for (const tc of delta.tool_calls ?? []) {
  const slot = (toolCalls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
  if (tc.id) slot.id = tc.id;
  if (tc.function?.name) slot.function.name += tc.function.name;
  if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
}
```

常见错误：每收到一片就 `JSON.parse`——必然失败，`{"comm` 不是合法 JSON。**装配阶段只拼接，parse 留到拼完之后**。

### ③ 中断信号：一个 AbortController 贯穿 HTTP 层与工具循环

中断不能只设布尔标志——正在传输的 HTTP 流不会检查标志。把 `AbortController` 的 signal 传给 `fetch`，abort 时连接立即断开；断开会让读流代码抛错，确认是主动中断（`signal.aborted`）就吞掉错误，已装配的半截消息照常返回——用户看到的内容必须留在历史里，否则模型下一轮缺上下文。

中断也可能落在两次工具执行之间，每次派发前再检查：

```js
for (const call of msg.tool_calls) {
  if (controller.signal.aborted) break; // 剩余调用不跑，悬空部分交给修复函数
  // ...
}
```

Ctrl+C 的策略：第一次中断本轮，第二次退出进程——"停下这一轮"和"退出程序"是两个意图，分开处理（readline 监听细节见文末）。

### ④ 悬空 tool_call 的修复：回填合成结果

残缺序列有三种处理方式：

| 做法 | 结果 |
|---|---|
| 把半截 assistant 消息整个丢掉 | 不会 400，但用户看到的那半截回答不在历史里，下一轮模型缺失上下文 |
| 原样保留，直接发 | 400 |
| **保留 + 回填合成 tool 结果** | 序列配平，会话继续 |

回填就是给每个没有结果的 tool_call 补一条假的 tool 消息。文案是写给模型看的界面（s02），要说清两点：

```
(用户中断了执行，该工具未运行——不是工具失败，需要时可以重新调用)
```

说"不是失败"，模型不会误判为工具故障而绕路；说"可以重新调用"，用户说"继续"时它知道从哪接。顺带把断在 JSON 中间的参数改为 `{}`（部分后端会校验它）。修复函数幂等——对完好序列无操作，重复执行安全。

## 运行方式（不需要 API key）

```sh
node s05_streaming_interrupt/demo.mjs
```

输出节选（SSE 字节流每 31 字节切一次，故意切在 `data:` 行和 JSON 中间）：

```
━━━ 场景一：SSE 分片装配（tool_calls 按 index 归队）━━━
  线路上：11 个事件被切成 30 个原始分片，比如：
    分片[0] = "data: {\"choices\":[{\"delta\":{\"ro"
    分片[1] = "le\":\"assistant\"}}]}\n\ndata: {\"ch"
  实时打印的文本："我来查一下。"
  装配出的 tool_calls（arguments 拼完才 parse）：
    call_ls → run_shell({"command":"ls -la"})
    call_read → read_file({"path":"a.txt"})

━━━ 场景二：Ctrl+C 撕裂的消息序列，修复后能继续对话 ━━━
  修复前：user → assistant+2calls → tool(call_test)
    悬空：call_read 没有 tool 结果；参数断裂："{\"path\":\"READ"
  修复后：user → assistant+2calls → tool(call_read) → tool(call_test)（回填 1 条）
    合成结果："(用户中断了执行，该工具未运行——不是工具失败，需要时可以重新调用)"
    参数修复："{}"
  再跑一遍修复（应当无操作、幂等）：回填 0 条
```

有 key 的话运行 `AGENT_API_KEY=sk-xxx node s05_streaming_interrupt/agent.mjs`，给它一个多步任务，中途 Ctrl+C，再问"刚才做到哪了"——能接上即验收通过。

## 真实产品对照（延伸阅读）

先补几个正文省略的细节。悬空 tool_call 的报错原文：OpenAI 大意是 "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'"；Anthropic 的版本是 "tool_use ids were found without tool_result blocks"。"parse 留到拼完之后"之所以顺手，是因为 s02 的分层里 `dispatch` 本来就在那时才 parse——分层带来的便利。还有一个 readline 细节：终端在 readline 手里时处于 raw 模式，Ctrl+C 不产生进程信号，而是触发 `rl` 的 `'SIGINT'` 事件——所以 `rl.on("SIGINT")` 和 `process.on("SIGINT")`（非 TTY 时）都要监听。

Reina（本系列对照的生产级 agent）的对应机制在 `packages/providers/src/tool-pairing.ts`：`normalizeToolPairing` 做**双向配平**——除了本章的"悬空 call 合成占位输出"（合成文案同样说明"可能被中断丢失，需要时重跑"），还处理反方向的"孤儿结果"：一条 tool 结果找不到发起它的 call，同样会被后端拒收（"No tool call found for function call output with call_id ..."）。codex 的做法是把孤儿直接丢弃；Reina 把它降级为普通文本消息——因为 Reina 的孤儿消息里常含有真实信息，直接丢弃会损失内容。这套修复在生产里静默执行，但 `REINA_STRICT_TOOL_PAIRING=1` 时会直接抛错——配平失守说明上游某个不变量被破坏，开发环境里应当尽早暴露。

引擎侧的中断在 `packages/core/src/engine.ts`：`interrupt()` 除了 abort，还会立刻换上一个新的 AbortController 并清空待处理队列——这曾引出一个隐蔽 bug：换新之后，工具批次里尚未执行的调用读到的是新 controller 的未中断 signal，会照常执行；所以 Reina 在批次内每次派发前检查的是 `session.interrupted` 标志位，而不是 signal。另外中断不只有 Ctrl+C 一种：进程崩溃、断电也是中断——`recoverInterruptedTurn()` 在重新加载会话时检测"卡在 running 状态的工具调用"，统一标记失败并回填错误文案。这依赖会话落盘，见 s08。

## 练习挑战

1. 中断有时过重——用户只是想补一句"顺便用 --verbose 跑"，不想丢弃正在生成的回答。codex 和 Reina 都支持 steer：不打断当前流，把用户插话排队，等本轮迭代提交后作为下一条 user 消息注入。给本章 agent 加上这个能力：轮次进行中输入的文字不触发中断、进入队列（提示：难点在插入位置——工具结果和插话的先后顺序，想想为什么插在 tool 结果之后比之前安全）。
2. 思考题：合成结果的文案，"(用户中断了执行，该工具未运行)" 与 codex 风格的单词 "aborted"，各会把模型引向什么行为？构造一个"中断后用户说『继续』"的场景，推演两种文案下模型的下一步动作差异。

---

| [← 上一章：工具输出预算与溢出](../s04_output_budget/README.md) | [目录](../README.md) | [下一章：上下文压缩 →](../s06_compaction/README.md) |
|---|---|---|
