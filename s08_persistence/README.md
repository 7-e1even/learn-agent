# s08 · 断了能接上，才叫能用：会话落盘与恢复

> **格言：状态不是"存"出来的，是从事件流里"放"出来的——只追加，不回写。**

## 你的 agent 早晚会死在半路上

前几章的 agent 有一个共同点：`messages` 数组活在内存里。进程一退——你按错了 Ctrl+C、终端被误关、笔记本没电、Node 崩了——半小时的对话、二十次工具调用、好不容易建立起来的上下文，灰飞烟灭。重开之后它一脸无辜："有什么可以帮你？"

对聊天玩具这无所谓。对干活的 agent 这是致命的：真实任务动辄跑几十分钟，崩溃/断电/误关是**常态而不是意外**。断了能接上，才叫能用。

"那就把 messages 存成 JSON 文件呗，每次变化就重写一遍。"——这是几乎所有人的第一反应，也是一个埋着雷的反应。本章讲清楚为什么它不行，以及真实产品的做法：**追加式事件日志 + 重放恢复**。

![追加式 JSONL 事件日志通过重放恢复状态，坏掉的末尾半行可以跳过](../assets/s08-event-log-replay.svg)

本章代码 = s03 基底 + `store.mjs`（事件日志与重放）。

## 先跑演示（不需要 API key）

```sh
node s08_persistence/demo.mjs
```

三个场景，全部真写磁盘、真模拟崩溃。输出节选：

```
━━━ 场景一：全量重写 JSON，崩溃在写到一半时 ━━━
  磁盘上留下 124/207 字节的 session.json，尝试恢复：
  ✗ JSON.parse 失败：Unterminated string in JSON at position 124 (line 7 column 27)
  ✗ 整个会话报废 —— 不止最后一条消息，之前的历史也一起没了。

━━━ 场景三：崩溃把最后一行写了一半 ━━━
  往同一个 .jsonl 追加了半行（49/98 字节），再次重放：
  ✓ 恢复出 4 条消息，跳过 1 行损坏数据
  ✓ 只丢了崩溃瞬间那一条，之前的全部历史完好。
```

## 设计：三个关键决定

### ① 为什么"每次全量重写 JSON"是危险的

写文件不是原子操作。`writeFileSync(f, bigJson)` 在操作系统层面是"打开（把旧内容清空）→ 一块一块往里写字节"。崩溃如果落在中间，磁盘上就是**半个 JSON**：旧版本已经被清掉了，新版本没写完——`JSON.parse` 直接炸，整个会话（包括崩溃前好好的那 99%）一起陪葬。演示场景一就是这个现场。

而且这个方案越用越危险：会话越长，重写一次的窗口越大，中招概率越高——**你最宝贵的会话恰恰是最容易被写坏的会话**。

追加式日志（JSONL：一行一个 JSON）把这个问题从根上拆了：

```
{"ts":"…","type":"session_meta","meta":{"id":"ses_x","model":"deepseek-chat",…}}
{"ts":"…","type":"message","message":{"role":"user","content":"帮我修一下登录页"}}
{"ts":"…","type":"tool_call","record":{"id":"call_1","name":"read_file","status":"completed",…}}
```

每发生一件事（用户消息/助手消息/工具结果/压缩边界）就 **append 一行，已写下的字节永远不被触碰**。崩溃的爆炸半径被压缩到"最后一行可能写了一半"——重放时跳过那行坏数据就是了，丢一条消息，不丢整个会话。这不是精巧的容错设计，是 append-only 这个形状**天然自带**的性质。

### ② 恢复 = 重放：状态是事件流的推导结果

落盘的是事件，不是状态。恢复时逐行读事件，把 `messages` 数组**重新推导**出来：

```js
for (const line of text.split("\n")) {
  let event;
  try { event = JSON.parse(line); } catch { skipped++; continue; } // 半截行：跳过
  switch (event.type) {
    case "session_meta": meta = event.meta; break;
    case "message":      messages.push(event.message); break;
    case "tool_call":    /* 按 id upsert 进 toolCalls */ break;
    default: break; // 未知类型忽略 —— 老代码也能加载新版本写的日志
  }
}
```

这个"reducer 形状"（事件流 → fold → 状态）带来两个不显眼但重要的自由度：坏行可以跳过（容错），未知事件类型可以忽略（**向前兼容**——升级后的程序写了新事件，旧程序照样能加载它认识的部分）。

### ③ 会话粒度的配置也在流里——别用"现在的默认值"恢复"过去的会话"

一个容易想当然的细节：恢复会话时，模型配置从哪来？很多人会顺手用当前的环境变量/全局默认。**错。用什么模型是这个会话自己的属性**，创建时就该冻结进第一行 `session_meta`，恢复时以它为准：

```js
meta = createSession(SESSIONS_DIR, { model: process.env.AGENT_MODEL ?? "deepseek-chat" });
// ……第二天恢复时：
const MODEL = restored.meta.model; // 来自会话记录，不是今天的默认值
```

这是 Reina 真实踩过的坑：加载旧会话时模型选择器显示的是**新会话的默认值**，而不是会话真正在用的（重放恢复出来的）模型——一个绑定了订阅的会话看起来像在用普通 API key，请求 401，用户以为是配置错了，排查半天。配置跟着会话走，UI 和请求才不会各说各话。

### ④ 工具调用带结构化 status 落盘

s03 有个我们当时明说是临时方案的东西：靠报错文案前缀（`FAILURE_RE`）猜一次工具调用成没成功。文案是给模型看的 UI，随时会改——拿它当机器判据，改一句文案就悄悄弄坏看门狗。本章把这个脚手架拆了：**成败在执行那一刻就确定，作为结构化字段落盘**。

约定很简单：handler `return` = completed，`throw` = failed；报错文案原样回给模型（错误即信息，一个字不少），但"失败了"这个事实走字段：

```js
try {
  return { status: "completed", output: tool.handler(args) };
} catch (err) {
  return { status: "failed", output: err.message };
}
```

落盘的 `tool_call` 事件带着这个 status。从此审计、重放、看门狗都读字段，没有人再解析文案。

## 接进你的 agent

[agent.mjs](./agent.mjs) 是 s03 的 agent + 落盘。关键改动只有两处。第一，消息只从一个口进数组——内存和磁盘一步完成，永远一致：

```js
function pushMessage(message) {
  messages.push(message);
  appendEvent(SESSIONS_DIR, meta.id, { type: "message", message });
}
```

第二，启动时分岔：带 `--resume <id>` 就重放续命，否则开新会话并打印 id：

```sh
AGENT_API_KEY=sk-xxx node agent.mjs
# 新会话 ses_mr47xdu8_sgf8（落盘于 …/.sessions/ses_mr47xdu8_sgf8.jsonl）
# 下次续上：node agent.mjs --resume ses_mr47xdu8_sgf8

AGENT_API_KEY=sk-xxx node agent.mjs --resume ses_mr47xdu8_sgf8
# 已恢复会话 ses_mr47xdu8_sgf8：14 条消息，5 次工具调用
```

验收方法很直接：跟它聊两轮、让它读个文件，然后**狠心 Ctrl+C**，再 `--resume` 回来问"我们刚才聊到哪了"——它应该答得上来。注意纠偏 prompt 也走 `pushMessage`：它是历史的一部分，恢复出来的会话必须和崩溃前那个是同一个会话，一条不多一条不少。

## 真实产品对照

本章机制对应 Reina 的 `packages/core/src/rollout.ts`（照着 openai/codex 的 rollout recorder 建模）：每个会话一个 `.reina/sessions/<id>.jsonl`，每次状态变化 append 一行 `{ ts, type, ... }`。示例版三种事件类型，生产版二十多种（`message` / `tool_call` / `tool_update` / `compacted` / `usage` / `todos`……）。几个值得抄的生产细节：

- **不变量写在注释里**："Writes are `O_APPEND` only. No code path ever rewrites an existing byte"——跨进程的并发写者也无法互相覆盖历史。进程内则常驻一个文件句柄、用 Promise 链串行化所有 append（示例版每次重开文件，崩溃安全性一样，性能差一截）。
- **重放跳坏行**：`loadRolloutAsSession` 对每行单独 `JSON.parse`，失败（"likely a torn final write from a crash"）就跳过并告警 `skipped N malformed line(s)`——和本章 demo 场景三同款。
- **工具调用是结构化记录**：`packages/protocol/src/index.ts` 的 `ToolCallRecord` 带 `status: "pending_approval" | "running" | "completed" | "rejected" | "failed"`——比示例版的两态多出审批流和运行中；还有 `outputPath` 指向 `.reina/tool_outputs/` 下的完整输出存档。
- **模型配置随会话重放**，且 `config` 事件对 model 是**整体替换不浅合并**——浅合并会让上一个模型的 `baseUrl` 泄漏到切换后的模型上，Reina 注释里就记着一次真实事故：kimi 切 codex 后残留的 baseUrl 把请求路由到了错误的主机。
- 仅有的"全量重写"出现在**迁移**旧格式时（`migrateJsonSnapshotToJsonl`），而且写法是先写临时文件再 `rename` 进位——rename 在同一文件系统上是原子的，崩溃也不会留下半个 jsonl。

顺带的行为观察：Claude Code 的会话也是 JSONL（`~/.claude/projects/<项目>/**.jsonl`），`--resume` 的底层就是同一套"重放事件流"。

## 动手挑战

1. 给 `store.mjs` 加一个 `compacted` 事件和对应的重放逻辑：记录"从第 N 条消息之前已被压缩为摘要 S"，重放时用摘要替换被压缩的区间。s06 的压缩机制落盘之后，才算真正闭环。
2. 思考题：demo 场景三里半截行恰好在**文件末尾**，跳过它显然安全。但如果坏行出现在文件**中间**（比如磁盘坏块），跳过一条 `message` 可能让后面的 `tool` 消息变成"孤儿"（tool_call_id 对不上助手消息）——API 会拒绝这样的序列。恢复时该怎么检测并修剪这种断链？（提示：s05 处理 Ctrl+C 留下的坏消息序列用的是同一套办法。）

---

| [← 上一章：缓存命中工程](../s07_prompt_cache/README.md) | [目录](../README.md) | [下一章：子代理与心跳看门狗 →](../s09_subagent_watchdog/README.md) |
|---|---|---|
