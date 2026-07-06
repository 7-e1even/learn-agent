# s12 · 完整 agent 整合

本章把 s01 的循环与 s03–s10 各章的模块直接 import 组合成一个完整 agent，并用一台假模型服务器做端到端验收，验证「循环写完之后不再修改，机制都挂在循环外围」这一前面各章的约定。

本章代码 = s01 的循环 + s03–s10 各章模块的直接 import（不重写任何机制代码；唯一例外是 s07——那章没有可 import 的模块，约 30 行缓存仪表盘是原样搬进来的）+ 一台按剧本回复的假模型服务器。

## 主循环没有改变

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

「循环没变过」可以直接对照验证。s01 的 `runTurn` 骨架是这样的（略去打印和参数解析；`dispatch` 这个名字到 s02 才出现，s01 还是内联的 `if`）：

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

s12 的 `runTurn` 去掉机制挂点后，骨架逐句相同：问模型 → 进历史 → 不要工具就收口 → 执行工具 → 结果喂回去 → 再问一次。前十一章改变的只是每一步**前后**发生了什么：问模型之前多了预算闸口，问模型这一步变成了流式装配，工具结果进历史之前过一遍观测预算，收口之前查一次压缩。每个机制都是挂上去的，没有一个写进循环结构里。这就是 s02 那句「循环永不再改」到第十二章的形态。

## 运行验收（不需要 API key）

```sh
node s12_full_agent/selftest.mjs
```

selftest 会在进程内启动一台假模型服务器（下文详述），把整合后的 agent 当黑盒 spawn 出来端到端跑两幕，然后在输出里逐项找证据。真实运行输出（节选）：

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

第二幕先往会话日志里伪造一条「崩溃现场」（assistant 带 tool_calls 但没有工具结果、arguments 断在 JSON 中间），再 `--resume`：

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

## 机制地图：各机制挂在循环的哪里

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

## 整合时的适配点

各章模块能直接拼，是因为它们都只依赖「循环喂过来的数据形状」（records、messages、usage、事件），不依赖循环内部结构。但有两处接口冲突，整合时写了少量适配代码，每一处都是真实产品会遇到的问题：

### ① s06 × s08：压缩改写历史，重放却是无损的

s08 的原则是「只追加、逐行重放」；s06 的压缩却要把 messages 数组整体替换。直接组合的后果：长会话恢复时，重放把已压缩掉的全部历史原样还原，第一次请求就可能超出窗口。

适配（agent.mjs 的 `replayCompacted`）：压缩时额外落一个 `compaction` 快照事件；恢复时先照常重放，遇到快照就整体切换成快照。s08 本身不需要修改——它对未知事件的策略本来就是「忽略」（当初为了老代码能读新日志），这个前向兼容设计恰好允许新事件类型自由扩展。日志里旧消息一行不动（无损审计），内存里的工作集以最后一个快照为准：**压缩是视图，日志是事实**。

### ② s05 × s08：修复函数不知道有落盘这回事

`repairDanglingToolCalls` 直接往 messages 数组里插合成消息；而落盘挂在 `pushMessage` 上。两个模块互不知情，整合后修复插入的消息就成了「内存里有、磁盘上没有」的不一致。适配用一个 `WeakSet` 记录哪些消息已落盘，修复后补写差集。

顺带获得一个额外能力：崩溃恢复和 Ctrl+C 中断造成的是同一种历史缺口（tool_calls 落了盘、工具结果没落）。所以恢复会话时先跑一遍同一个修复函数——s05 的机制在 s12 里有了第二个用途，代码没有改动。

### ③ 假模型服务器：不产生费用地测试 agent

单元测试测得了模块，测不了接线：工具真的执行了吗？流式中断修得回来吗？压缩触发时摘要调用真的发出去了吗？这些只有让整个 agent 端到端跑才能确认——而端到端测试不应产生 API 费用，也不应依赖真实模型的输出波动（多说一句话，断言就失败）。

[mock-server.mjs](./mock-server.mjs) 用 `node:http` 实现 OpenAI 兼容的流式 `/chat/completions`：SSE 分片、tool_calls 的分片 JSON arguments、带缓存字段的 usage 都有。agent 完全不感知——把 `AGENT_BASE_URL` 指过去，它以为自己在跟 DeepSeek 通信。剧本按请求内容路由（system 前缀区分主 agent/子代理/摘要调用，assistant 计数当回合指针），服务器自身无状态，和真模型一样。于是每个机制都能被**精确触发**：要演示卡死，就让子代理第二轮不再回话；要演示压缩，就把 usage 报到阈值之上。

```sh
node s12_full_agent/mock-server.mjs 8390   # 单独起服务
AGENT_API_KEY=mock AGENT_BASE_URL=http://127.0.0.1:8390/v1 node s12_full_agent/agent.mjs
```

## 各章要点回顾

1. s01：agent 和 chatbot 的区别是一个 `while` 循环。
2. s02：加一个工具只加一个注册表条目，循环不改。
3. s03：正常推进的 agent 给续期，失控的先纠偏、再熔断。
4. s04：截断是有损的，溢出落盘是无损的——细节只差一次 read_file。
5. s05：中断之后还能修复历史、继续对话，才算完成。
6. s06：压缩可以丢细节，不能丢「用户让我干嘛」。
7. s07：前缀缓存决定 agent 的成本结构——一个时间戳就能让费用增加数倍。
8. s08：状态从事件流重放得出——只追加，不回写。
9. s09：隔离上下文执行探索，用心跳判断死活。
10. s10：目录进 prompt，正文按需取——system prompt 是每轮拼装的产物。
11. s11：ready 集合决定派谁，闸门决定何时收工——协调状态放进数据结构。
12. s12：机制是模块，循环是接线板。

s13-s15 不再继续往这个整合 demo 里加东西，而是转向真实 coding agent 的边界层：副作用前的权限裁决、模型输出进循环前的 Provider 兼容、以及工具定义进上下文前的渐进式披露。它们不推翻 s12 的核心循环，只把循环外面的入口和出口守住。

## 真实产品对照

假模型服务器是真实产品的同款思路：Reina 内置一个 `deterministic` provider（`packages/providers/src/index.ts`，按固定规则回复），引擎的全部测试靠它免 key、免网络跑通——测试替换引擎依赖的方式和本章替换 agent 依赖的方式相同：在 provider 边界上换实现，循环不感知。这也反过来验证了架构：模型调用被收拢在一个可替换的边界后面，才可能这样测试。

整合后的形状也和 Reina 一致：核心循环收在一个文件里（`packages/core/src/engine.ts` 的 `runTurn`，五千多行的引擎类），机制各自成文件挂上来——`loop-budget.ts`、`compaction.ts`、`rollout.ts`、`subagent/manager.ts`、`engine-prompt.ts` + `skills.ts`、providers 侧的 `tool-pairing.ts`、tools 侧的 `log-compress.ts`。循环保持连贯可读，周边机制模块化，这是真实产品在多次迭代后收敛出的同一个结构。

## 后续方向

读真实源码（有 Reina 源码的话，按本章顺序对照）：s03→`packages/core/src/loop-budget.ts`，s04→`engine.ts` 的 `enforceTurnObservationBudget` + `packages/tools/src/log-compress.ts`，s05→`packages/providers/src/tool-pairing.ts`，s06→`compaction.ts`，s08→`rollout.ts`，s09→`subagent/manager.ts`，s10→`engine-prompt.ts` + `skills.ts`。接着读 s13-s15 对应的权限、Provider 兼容、工具披露边界。每个文件都比示例版多一层来自真实使用的边界处理，对照着读收获最大。

观察 Claude Code：现在可以对照理解它的行为——`Esc` 中断后会话还能继续（s05 的修复）、`/compact` 与自动压缩（s06）、`--resume`/`--continue`（s08 的重放）、Task 子代理只带结论回来（s09）、"Paused after several tool turns without new progress"（s03 的看门狗）。工具是表象，机制是相通的。

把它改成你自己的 agent，三个方向：换感官（把 run_shell 换成浏览器/数据库/IoT 设备——注册表加条目，循环不动）；换大脑（本地 Ollama、或按任务难度在便宜/贵模型间路由——只动 chat() 一个边界）；换形态（从 REPL 变成常驻服务，定时唤醒干活——s08 的会话就是它的记忆体）。

## 动手挑战

1. 把 s11 的 DAG 接进来：给主 agent 加一个 `plan_team` 工具，让模型把大任务拆成带 `blockedBy` 的子任务图，用 s11 的 ready 集合驱动 s09 的子代理并行开工、闸门收口。接完就得到一个小型 multi-agent 系统——而主循环仍然不需要修改。
2. 给 mock-server 的剧本加「第三幕」：一轮流到一半断流（发几个 delta 后直接 `res.destroy()`），验证整合后的 agent 在服务端断连时的表现。它会崩溃、会重试、还是会把半截消息收进历史？先预测，再运行——预测错的那一项对应的章节值得重读。

---

| [← 上一章：多 agent 协作](../s11_agent_team/README.md) | [目录](../README.md) | [下一章：权限与审批 →](../s13_permissions/README.md) |
|---|---|---|
