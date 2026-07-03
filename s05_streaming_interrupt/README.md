# s05 · Ctrl+C 之后：流式与中断

> **格言：中断很容易，中断后还能继续对话才是工程。**

本章代码 = s03 基底 + 流式解析与中断修复模块 [stream.mjs](./stream.mjs)。

## 两层痛，第二层深得多

第一层痛人人都见过：非流式的 agent，模型思考 40 秒，用户盯着一个不动的光标，唯一的悬念是"它死了吗"。解法众所周知——流式，一个字一个字地打出来。

于是你加了流式，顺手加了 Ctrl+C 中断（跑错方向的任务总得能停）。然后第二层痛来了：**中断之后再说一句话，API 直接甩你一个 400。**

复盘一下 Ctrl+C 那一刻的消息现场：

```
user:      "把测试跑一遍，顺便看下 README"
assistant: tool_calls: [call_test → run_shell, call_read → read_file]
tool:      (call_test 的结果 —— 第一个工具跑完了)
                     ← Ctrl+C 落在这里，call_read 永远没有结果
```

OpenAI 协议有一条硬性要求：**assistant 消息里的每个 `tool_call`，后面都必须跟一条对应 `tool_call_id` 的 `tool` 消息**。上面这串消息里 `call_read` 是悬空的——原样发出去，OpenAI 兼容后端一律拒收（OpenAI 的报错原文大意是 "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'"；Anthropic 的版本是 "tool_use ids were found without tool_result blocks"）。

更阴的是：流是被掐断的，`call_read` 的 arguments 可能断在 JSON 中间（`{"path":"READ`）。中断把序列撕成了半截——**这半截怎么处理，决定了你的 agent 是"能停"还是"停完还能用"**。

![Ctrl+C 后用合成 tool 结果修复悬空 tool_call](../assets/s05-tool-call-repair.svg)

## 设计：四个关键决定

### ① SSE：为什么要按行缓冲，而不是按 chunk 处理

先给没见过的人解释 SSE（Server-Sent Events）：`stream: true` 时，服务端不再攒出完整回答一次性返回，而是保持一条 HTTP 响应一直开着，把回答切成小片逐个推给你。每片是文本流里的一行：

```
data: {"choices":[{"delta":{"content":"我来"}}]}

data: {"choices":[{"delta":{"content":"查一下"}}]}

data: [DONE]
```

`data: ` 开头是数据行，空行是事件分隔符，`data: [DONE]` 是全剧终。看起来一行一个 JSON，逐行 parse 就完了？——错在"行"不是你收到的单位。**TCP 和中间代理切分数据从不看语义**：你 `for await` 拿到的一个 chunk，可能停在 `data: {"cho` 的中间，甚至停在"我"这个字的三个 UTF-8 字节中间。所以解析器必须（[stream.mjs](./stream.mjs)）：

```js
buffer += decoder.decode(chunk, { stream: true }); // stream 模式：半个多字节字符先扣下
let newline;
while ((newline = buffer.indexOf("\n")) !== -1) {  // 凑出完整的一行才处理一行
  const line = buffer.slice(0, newline).replace(/\r$/, "");
  buffer = buffer.slice(newline + 1);
  if (!line.startsWith("data:")) continue;          // 空行、": 心跳" 注释行，都跳过
  // ...
}
```

### ② tool_calls 的 delta 比 content 阴：碎 JSON 分片按 index 归队

content 的 delta 是字符串，`+=` 就完了。tool_calls 的 delta 是**被切碎的 JSON 字符串**：第一片带 `id` 和函数名，后续片只带 `arguments` 的几个字符；并行调用时多个 call 的分片还会交错到达，靠 `index` 归队：

```js
for (const tc of delta.tool_calls ?? []) {
  const slot = (toolCalls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
  if (tc.id) slot.id = tc.id;
  if (tc.function?.name) slot.function.name += tc.function.name;
  if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
}
```

新手最常见的坑：每收到一片就想 `JSON.parse(arguments)` ——必炸，因为 `{"comm` 不是 JSON。**装配阶段只做拼接，parse 留给拼完之后**（我们的 `dispatch` 本来就是那时才 parse 的，s02 的分层白捡了这个好处）。

### ③ 中断要"贯穿"：一个 AbortController 从 HTTP 层到工具缝隙

中断不是设个布尔标志位就完事——正在飞的 HTTP 流不会看你的标志位。`AbortController` 的 signal 传给 `fetch`，abort 时连接当场掐断；掐断会让 body 迭代器抛错，**以 `signal.aborted` 为准吞掉它**，装配器里已有的半截消息照常返回（已经流出来的内容用户看到了，历史里也得有，否则模型下一轮"失忆"）。

中断还可能落在两次工具执行的缝隙里，所以每次派发前重查：

```js
for (const call of msg.tool_calls) {
  if (controller.signal.aborted) break; // 剩余调用不跑，悬空部分交给修复函数
  // ...
}
```

Ctrl+C 的策略是**第一次中断本轮、第二次退出进程**——"我只是想停下这轮"和"我想走了"是两个意图，别用一个动作应付两件事。另有一个 readline 细节：终端在 readline 手里时处于 raw 模式，Ctrl+C 不产生进程信号，而是触发 `rl` 的 `'SIGINT'` 事件——所以 `rl.on("SIGINT")` 和 `process.on("SIGINT")`（非 TTY 时）两头都要接。

### ④ 修复而不是丢弃：给悬空的 tool_call 回填合成结果

撕成半截的序列有三种处理法：

| 做法 | 结果 |
|---|---|
| 把半截 assistant 消息整个丢掉 | 不会 400，但模型失忆——用户明明看到了那半截回答，历史里却没有，下一轮答非所问 |
| 原样保留，直接发 | 400 |
| **保留 + 回填合成 tool 结果** | 序列配平，会话无缝继续 ✅ |

回填就是给每个悬空的 tool_call 插一条合成的 tool 消息。文案是精心写的（还记得 s02 的"报错是写给模型看的 UI"吗）：

```
(用户中断了执行，该工具未运行——不是工具失败，需要时可以重新调用)
```

明确说"不是失败"，模型就不会误判成工具坏了而绕路；明确说"可以重新调用"，用户说"继续"时它知道从哪接。顺带修第二处撕裂：断在 JSON 中间的 arguments 修成 `{}`（挑剔的后端会校验历史里的这段字符串）。修复函数是幂等的——对配平的序列是无操作，随便多跑几遍都安全。

## 跑起来（不需要 API key）

```sh
node s05_streaming_interrupt/demo.mjs
```

真实输出节选——先看分片装配（整段 SSE 字节流每 31 字节掐一刀，故意掐在 `data:` 行和 JSON 的中间）：

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
    参数修复："{}"
  再跑一遍修复（应当无操作、幂等）：回填 0 条
```

有 key 的话跑 `AGENT_API_KEY=sk-xxx node s05_streaming_interrupt/agent.mjs`，给它一个多步任务，中途按 Ctrl+C，然后问一句"刚才做到哪了"——它能接上，这就是验收标准。

## 真实产品对照

Reina 的对应机制在 `packages/providers/src/tool-pairing.ts`：`normalizeToolPairing` 做**双向**配平——不止本章讲的"悬空 call 合成占位输出"（合成文案同样强调"可能被中断丢失，需要时重跑"），还有反方向的"孤儿结果"：一条 tool 结果找不到发起它的 call，同样会被后端拒收（"No tool call found for function call output with call_id ..."）。codex 的做法是把孤儿直接丢掉；Reina 把它**降级为普通文本消息**——因为 Reina 的孤儿里常有真实信息，丢了可惜。这套修复在生产里静默自愈，但 `REINA_STRICT_TOOL_PAIRING=1` 时会直接抛错——配平失守说明上游某个不变量破了，开发环境里要炸得响亮。

引擎侧的中断在 `packages/core/src/engine.ts`：`interrupt()` 除了 abort，还**立刻换上一个新的 AbortController** 并清空待处理队列——这带来一个隐蔽 bug 的教训：换新之后，工具批次里"后面还没跑的调用"读到的是新 controller 的未中断 signal，会照常跑完；所以 Reina 在批次内每次派发前重查的是 `session.interrupted` 标志位，而不是 signal。另外中断不只有 Ctrl+C 一种：进程崩溃、断电也是中断——`recoverInterruptedTurn()` 在重新加载会话时检测"卡在 running 状态的工具调用"，统一标记失败并回填错误文案。那要靠会话落盘才做得到，s08 见。

## 动手挑战

1. 中断有时太重了——用户只是想补一句"顺便用 --verbose 跑"，不想废掉正在流的回答。codex 和 Reina 都支持 **steer**：不打断当前流，把用户插话排队，等本轮迭代提交后作为下一条 user 消息注入。给本章 agent 加上：轮次进行中输入的文字不触发中断、进入队列（提示：难点在"排到哪个缝隙里"——工具结果和插话的先后顺序，想想为什么插在 tool 结果之后比之前安全）。
2. 思考题：合成结果的文案，"(用户中断了执行，该工具未运行)" 与 codex 风格的一个单词 "aborted"，各会把模型引向什么行为？构造一个"中断后用户说『继续』"的场景，推演两种文案下模型的下一步动作差异。

---

| [← 上一章：工具输出预算与无损溢出](../s04_output_budget/README.md) | [目录](../README.md) | [下一章：上下文压缩 →](../s06_compaction/README.md) |
|---|---|---|
