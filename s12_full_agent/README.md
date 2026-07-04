# s12 · 合体

> **格言：机制是模块，循环是接线板——前十一章的零件，合回同一个 `while`。**

本章代码 = s01 的循环 + s03–s10 各章模块的**直接 import**（一行机制代码都不重写；唯一例外是 s07——那章没有可 import 的模块，约 30 行缓存仪表盘是原样搬进来的）+ 一台照剧本念台词的假模型服务器。这是核心循环的合体章，也是一次验收：前面十一章吹过的牛——"循环写完之后一行不改，所有机制围着它长"——现在要当场兑现。

## 循环真的没变过

打开 [agent.mjs](./agent.mjs) 的 import 区，每一条都指回它自己的章节目录：

```js
import { LoopBudget, isRecoverable, repairPrompt } from "../s03_loop_budget/loop-budget.mjs";
import { DEFAULTS, compressLog, saveSpill, enforceTurnBudget } from "../s04_output_budget/spill.mjs";
import { sseJsonEvents, createAssembler, repairDanglingToolCalls } from "../s05_streaming_interrupt/stream.mjs";
import { shouldCompact, compactMessages, SUMMARY_PROMPT } from "../s06_compaction/compaction.mjs";
import { appendEvent, createSession, listSessionIds, replaySession, sessionPath } from "../s08_persistence/store.mjs";
import { PROD_LIMITS, concludePrompt, normalizeBrief, runChildWithWatchdog } from "../s09_subagent_watchdog/subagent.mjs";
import { buildSystemPrompt, loadSkills, formatSkillsSection } from "../s10_prompt_assembly/prompt.mjs";
```

而"循环没变过"不是修辞。s01 的 `runTurn` 骨架是这样的（略去打印和参数解析；`dispatch` 这个名字要到 s02 才出现，s01 还是内联的 `if`）：

```js
while (true) {
  const msg = await chat(messages);          // 问模型
  messages.push(msg);
  if (!msg.tool_calls?.length) return;       // 不要工具 = 这轮结束
  for (const call of msg.tool_calls) {
    messages.push({ role: "tool", tool_call_id: call.id, content: dispatch(call) });
  }                                          // 执行工具，结果喂回去，再问一次
}
```

s12 的 `runTurn` 剥掉机制挂点后，骨架逐句相同：问模型 → 进历史 → 不要工具就收口 → 执行工具 → 结果喂回去 → 再问一次。前十一章加起来，改变的只是每一步的**前后**发生了什么：问模型之前多了预算闸口，问模型这一步变成了流式装配，工具结果进历史之前过一遍观测预算，收口之前查一次压缩……每个机制都是挂上去的，没有一个是写进循环结构里的。这就是 s02 那句"循环永不再改"跑到第十二章的样子。

## 先跑验收（不需要 API key）

```sh
node s12_full_agent/selftest.mjs
```

selftest 会在进程内起一台假模型服务器（下文详说），把合体 agent 当黑盒 spawn 出来端到端跑两幕，然后在输出里逐项找证据。真实运行输出（节选）：

```
你> —— 循环第 2 步（预算 12，硬顶 48）
再制造一条超预算的大输出。
📊 prompt 3400 | 命中 3100（91.2%）| 未命中 300 | 本轮输入费≈省 82% | 会话累计命中 47.0%
  $ node -e "process.stdout.write('x'.repeat(120000))"
  ⤵ 1 条超预算输出已溢出：.agent-spill\1783041516581-0ee13df1.txt
—— 循环第 3 步（预算 12，硬顶 48）
这个调研活交给子代理。
  task sub_63aa14：调研 mock 环境并汇报
  $ node -e "console.log('subagent probe ok')"
  ⚰ 子代理 sub_63aa14 被看门狗击杀（stale，1 秒）→ 进入遗言回合
...
🗜️ 触发压缩：89400 tokens 已超过阈值 75000（窗口的 75%）
🗜️ 压缩完成：压掉 3 条，现存 10 条。
```

第二幕先往会话日志里伪造一条"崩溃现场"（assistant 带 tool_calls 但没有工具结果、arguments 断在 JSON 中间），再 `--resume`：

```
已恢复会话 ses_mr48vqzl_5apj：11 条消息，4 次工具调用
上次会话结束得不干净：回填了 1 条合成工具结果，历史已修复。
你> 会话已接上：模型、历史、工具记录都是从事件日志重放回来的……
```

验收汇总（17 项全过才退出 0）：

```
✓ s04 输出预算：120k 大输出溢出落盘　→ ⤵ 1 条超预算输出已溢出：.agent-spill
✓ s09 心跳看门狗：卡死子代理被击杀　→ 子代理 sub_gabwtg 被看门狗击杀（stale
✓ s06 压缩触发：usage 越过阈值　→ 🗜️ 触发压缩：89400 tokens 已超过阈值 75000
✓ s05×s08 崩溃修复：悬空 tool_call 被回填　→ 回填了 1 条合成工具结果
全部 17 项通过 —— 前十一章核心机制在同一个循环里各就各位。
```

有真 key 也可以直接聊：`AGENT_API_KEY=sk-xxx node s12_full_agent/agent.mjs`（`--resume <id>` 续会话）。

## 机制地图：核心机制各挂在循环的哪里

![前十一章核心机制挂在同一个 while 循环周围](../assets/s12-mechanism-map.svg)

```
 用户消息                ┌─ 进循环前 ──────────────────────────────────┐
    │                   │ s10 system prompt 分段拼装 + 技能目录重扫      │
    │                   │ s08 会话重放（--resume）→ s05 崩溃修复回填     │
    ▼                   └─────────────────────────────────────────────┘
 ┌──────────────────── while (true) ────────────────────────┐
 │ s03 预算闸口 canContinue()：软预算 + 硬顶                    │
 │    │                                                      │
 │ chat() ───── s05 SSE 手工解析 + delta 装配（Ctrl+C 随时掐）  │
 │    │         s07 缓存纪律：system/tools 字节稳定、只追加      │
 │    │         s07 仪表盘：📊 每轮打印命中率                    │
 │    ▼                                                      │
 │ 工具执行 ─── s02 注册表分发（错误即信息，绝不崩溃）             │
 │    │         s09 task 子代理（旁路：心跳看门狗 + 遗言抢救）    │
 │    ▼                                                      │
 │ 工具执行后 ─ s04 观测预算：日志压缩 → 单条/整轮溢出落盘        │
 │              s08 落盘：消息 + 结构化工具记录 append-only      │
 │    ▼                                                      │
 │ 轮末 ─────── s06 压缩触发（信服务商 usage，不信本地估算）      │
 │              s03 看门狗 recordTurn：复读/停滞/连错 → 纠偏/熔断│
 └───────────────────────────────────────────────────────────┘
 旁路（不进这个循环）：s11 任务 DAG —— 把多个这样的循环编成一队，
 ready 集合决定派谁、闸门决定何时收工（本章没接，见挑战 1）。
```

## 设计：拼不上的地方，才是最有营养的地方

各章模块能直接拼，是因为它们都只依赖"循环喂过来的数据形状"（records、messages、usage、事件），不依赖循环内部结构。但有两处接口真的打架了——合体时写了少量适配代码，每一处都是真实产品会遇到的问题：

### ① s06 × s08：压缩改写历史，重放却是无损的

s08 的哲学是"只追加、逐行重放"；s06 的压缩却要把 messages 数组拦腰换掉。直接合的后果：长会话恢复时，重放把**已压缩掉的全部历史**原样端回来，第一枪就可能超窗。

适配（agent.mjs 的 `replayCompacted`）：压缩时额外落一个 `compaction` 快照事件；恢复时先照常重放，遇到快照就整体切换成快照。妙处在于 s08 一行都不用改——它对未知事件的策略本来就是"忽略"（当初为了老代码能读新日志），这个前向兼容设计恰好让新事件类型可以自由生长。日志里旧消息一行不动（无损审计），内存里的工作集以最后一个快照为准：**压缩是"视图"，日志是"事实"**。

### ② s05 × s08：修复函数不知道有落盘这回事

`repairDanglingToolCalls` 直接往 messages 数组里插合成消息；而落盘挂在 `pushMessage` 上。两个模块互不知情，合体后修复插入的消息就成了"内存里有、磁盘上没有"的幽灵。适配用一个 `WeakSet` 记住哪些消息已落盘，修复后补写差集。

顺带收获一个免费的能力：**崩溃恢复和 Ctrl+C 中断撕开的是同一个口子**（tool_calls 落了盘、工具结果没落）。所以恢复会话时先跑一遍同一个修复函数——s05 的机制在 s12 里有了第二个岗位，一行没改。

### ③ 假模型服务器：怎么不烧钱地测试 agent

单元测试测得了模块，测不了接线：工具真的执行了吗？流式中断修得回来吗？压缩触发时摘要调用真的发出去了吗？这些只有让整个 agent 端到端跑，才见分晓——而端到端不该花一分钱、不该看模型心情（今天多说一句话，断言全崩）。

[mock-server.mjs](./mock-server.mjs) 用 `node:http` 实现 OpenAI 兼容的流式 `/chat/completions`：SSE 分片、tool_calls 的碎 JSON arguments、带缓存字段的 usage，一应俱全。agent 完全不知情——把 `AGENT_BASE_URL` 指过去，它以为自己在跟 DeepSeek 说话。剧本按请求内容路由（system 前缀区分主 agent/子代理/摘要调用，assistant 计数当回合指针），服务器自身无状态，和真模型一样。于是每个机制都能被**精确触发**：想演卡死，就让子代理第二轮永不回话；想演压缩，就把 usage 报到阈值之上。

```sh
node s12_full_agent/mock-server.mjs 8390   # 单独起服务
AGENT_API_KEY=mock AGENT_BASE_URL=http://127.0.0.1:8390/v1 node s12_full_agent/agent.mjs
```

## 十二句格言

前十二章 README 的第一句话，连起来就是核心循环的骨架：

1. **s01**：Agent 和 chatbot 的全部区别，是一个 `while` 循环。
2. **s02**：加一个工具，只加一个条目——循环永不再改。
3. **s03**：勤奋的 agent 给续期，失控的 agent 摁暂停——先纠偏，再熔断。
4. **s04**：截断是有损的，溢出是无损的——细节永远只差一次 read_file。
5. **s05**：中断很容易，中断后还能继续对话才是工程。
6. **s06**：压缩丢什么都行，唯独不能丢"用户让我干嘛"。
7. **s07**：前缀缓存不是优化项，是 agent 的定价模型——一个时间戳就能让你多付 10 倍。
8. **s08**：状态不是"存"出来的，是从事件流里"放"出来的——只追加，不回写。
9. **s09**：隔离上下文去干脏活，用心跳判断死活——勤奋的不误杀，卡死的必被抓。
10. **s10**：目录进 prompt，正文按需取——system prompt 是每轮拼装的产物，不是写死的常量。
11. **s11**：ready 集合决定派谁，闸门决定何时收工——协调者的记性不可靠，数据结构才可靠。
12. **s12**：机制是模块，循环是接线板——前十一章的零件，合回同一个 `while`。

s13-s15 不再继续往这个合体 demo 里塞东西，而是转向真实 coding agent 的边界层：副作用前的权限裁决、模型输出进循环前的 Provider 兼容、以及工具定义进上下文前的渐进式披露。它们更像生产补完篇：不推翻 s12 的核心循环，只把循环外面的入口和出口守住。

## 真实产品对照

假模型服务器是真实产品同款思路：Reina 内置一个 `deterministic` provider（`packages/providers/src/index.ts`，照固定规则回话），引擎的全部测试靠它免 key、免网络跑通——测试骗过引擎的方式和本章骗过 agent 的方式一模一样：**在 provider 边界上换零件，循环毫不知情**。这也反过来验证了架构：模型调用被收拢在一个可替换的边界后面，才有可能这么测。

合体后的形状也和 Reina 一致：核心循环收在一个文件里（`packages/core/src/engine.ts` 的 `runTurn`，五千多行的引擎类），机制各自成文件挂上来——`loop-budget.ts`、`compaction.ts`、`rollout.ts`、`subagent/manager.ts`、`engine-prompt.ts` + `skills.ts`、providers 侧的 `tool-pairing.ts`、tools 侧的 `log-compress.ts`。循环保持连贯可读，周边机制模块化，这是真实产品在几十次迭代后收敛出的同一个答案。

## 从这里去哪

**读真实源码**（Reina 在你手边的话，按本章顺序对照）：s03→`packages/core/src/loop-budget.ts`，s04→`engine.ts` 的 `enforceTurnObservationBudget` + `packages/tools/src/log-compress.ts`，s05→`packages/providers/src/tool-pairing.ts`，s06→`compaction.ts`，s08→`rollout.ts`，s09→`subagent/manager.ts`，s10→`engine-prompt.ts` + `skills.ts`。接着读 s13-s15 对应的权限、Provider 兼容、工具披露边界。每个文件都比示例版多一层"被真实用户踩出来"的边界处理，diff 着读最有收获。

**观察 Claude Code**：现在你能看懂它的行为了——`Esc` 中断后会话还能继续（s05 的修复）、`/compact` 与自动压缩（s06）、`--resume`/`--continue`（s08 的重放）、Task 子代理只带结论回来（s09）、"Paused after several tool turns without new progress"（s03 的看门狗）。工具只是表象，机制是通的。

**把它改成你自己的 agent**，三个方向：换感官（把 run_shell 换成浏览器/数据库/家里的 IoT——注册表加条目，循环不动）；换大脑（本地 Ollama、或按任务难度在便宜/贵模型间路由——只动 chat() 一个边界）；换形态（从 REPL 变成常驻服务，定时醒来干活——s08 的会话就是它的记忆体）。

## 动手挑战

1. 把 s11 的 DAG 接进来：给主 agent 加一个 `plan_team` 工具，让模型把大任务拆成带 `blockedBy` 的子任务图，用 s11 的 ready 集合驱动 s09 的子代理并行开工、闸门收口。接完你就拥有了一个微型 multi-agent 系统——而主循环，依然一行不改。
2. 给 mock-server 的剧本加"第三幕"：一轮流到一半就断流（发几个 delta 后直接 `res.destroy()`），验证合体 agent 在服务端断连时的表现。它会崩、会重试、还是会把半截消息稳稳收进历史？先预测，再运行——预测错的那一格，就是你还没吃透的那一章。

---

| [← 上一章：拆-派-收：多 agent 协作](../s11_agent_team/README.md) | [目录](../README.md) | [下一章：权限与审批 →](../s13_permissions/README.md) |
|---|---|---|
