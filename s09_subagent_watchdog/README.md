# s09 · 脏活外包与卡死抓捕：子代理与心跳看门狗

> **格言：隔离上下文去干脏活，用心跳判断死活——勤奋的不误杀，卡死的必被抓。**

## 两个痛点，一章解决

**痛点一：主上下文被中间垃圾灌满。**你让 agent "找出 Auth 模块在哪些地方被用到"，它勤勤恳恳跑了 20 轮工具——grep、读文件、再 grep——几十万 token 的中间输出全部灌进主对话。真正有用的是最后三行结论，但那 20 轮垃圾从此赖在上下文里：每一轮后续调用都要为它付钱，还稀释模型对真正任务的注意力。

解法是**上下文隔离**：开一个全新 `messages` 的子代理去干脏活，它自己的 20 轮折腾发生在自己的隔离空间里，跑完只把最终结论作为工具结果带回主对话。主上下文为这次探索付出的代价：一次工具调用，几百 token。

**痛点二：子代理是个黑盒，它 hang 住了怎么办？**s03 的行为看门狗管"转圈"——但它有一个结构性盲区：它活在循环**里面**，每轮工具执行完才被喂一次。如果工具进程 hang 死、模型流断在半路，**循环根本不转**，行为探测器永远等不到下一轮——它连"出事了"都不知道。主 agent 就这么干等到天荒地老。

管"卡死"需要另一条**基于时间的心跳看门狗**：它活在循环**外面**的定时器上，不依赖循环转动。

![子代理隔离上下文，心跳看门狗在循环外判断卡死并抢救遗言](../assets/s09-subagent-watchdog.svg)

本章代码 = s03 基底 + `subagent.mjs`（task 工具 + 心跳看门狗）。

## 先跑演示（不需要 API key）

```sh
node s09_subagent_watchdog/demo.mjs
```

四个"事件流可编剧"的假子代理，四种命运。输出节选：

```
━━━ 场景二：闲置卡死被抓 ━━━
  🔴 看门狗击杀（stale，已闲置 423ms）
  结局：disposition=stale，耗时 624ms，延期 0 次

  ↳ 击杀不是终点：给它一个遗言回合…
  遗言（disposition=completed）：1) 原任务：定位 Auth 引用；2) 已确认 src/login.js、src/api.js 两处；3) 还差测试目录没搜。

━━━ 场景四：硬顶到点但还活着，获得延长 ━━━
  🟢 硬顶到点，但最近 200ms 内有事件 → 延长 600ms（第 1 次）
  结局：disposition=completed，耗时 2415ms，延期 1 次
```

## 设计：四个关键决定

### ① 子代理 = 全新 messages 的迷你主循环，深度上限 1

`createChild()` 里最重要的一行是最不起眼的一行：

```js
const messages = []; // 上下文隔离的全部秘密：这是一个空数组
```

子代理复用同一套 chat + dispatch + LoopBudget，只有三处不同：自己的空 messages、自己的 system prompt（"你没有用户可以提问，最后一条回复就是交付物，把结论写全"）、以及**工具箱里没有 task**——这就是防套娃的深度上限：子代理想再派子代理，工具都不存在。没有这个上限，弱模型会兴高采烈地开出一棵子代理树，token 成本指数爆炸，换不来任何有意义的任务分解。

### ② 心跳：活着的标志是"最近产生过事件"

心跳看门狗的全部机制两句话讲完：子代理每产生一个事件（模型回话、工具调用完成——真实产品逐流 token 刷）就更新 `lastEventAt`；看门狗每隔 `heartbeatMs`（生产值 10 秒）醒来一次，量一下"多久没动静了"。

关键在 stale 预算是**两档**的：

```js
const idleMs = Date.now() - lastEventAt;
const limit = child.isInTool() ? limits.staleInToolMs : limits.staleIdleMs;
if (idleMs > limit) { disposition = "stale"; child.interrupt(); }
```

闲置（没在跑工具却没动静）450 秒判卡死；但工具运行中放宽到 1200 秒——跑一遍测试套件、装一次依赖，沉默十几分钟是**常态**，一刀切的闲置阈值会把干正事的子代理成批误杀。demo 场景三就是这个对照：工具里沉默 1200ms，远超闲置预算 400ms，但没被杀。

### ③ 墙钟硬顶 + 活性延期：到点先验尸，再决定杀不杀

光有 stale 检测不够——一个每 9 秒吐一个 token 的病态子代理永远不 stale，却能无限跑下去。所以还有墙钟硬顶（生产值 600 秒）。但硬顶到点直接杀，又会砍死正在勤奋收尾的好子代理。Reina 的做法是**到点先验尸**：

```js
setTimeout(() => {
  if (Date.now() - lastEventAt < limits.healthyRecentMs) { // 最近 30 秒内有事件？
    timer = scheduleTimeout(limits.healthyExtendMs);       // 还活着 → 延长 300 秒再看
    return;
  }
  disposition = "timeout";
  child.interrupt();
}, delay);
```

延长不是免死金牌：延期后躺平的，stale 预算照样抓；延期后继续勤奋的，下次到点再验一次尸。这和 s03 的"软预算 + 硬顶"是同一套哲学的时间版——**勤奋的不误杀，失控的必被抓**，只是度量从"轮数与进展"换成了"时间与事件"。

### ④ 击杀前抢救遗言：两阶段 salvage

被击杀的子代理可能已经干完了 80% 的活——直接扔掉，等于替用户把 10 分钟的探索费用点了火。所以击杀之后还有第二阶段：解除中断标志，给尸体一个短回合（有自己的小硬顶，遗言不能也无限跑），prompt 明确三问：

```
1. 原任务是什么？
2. 你完成了哪些具体步骤（碰过的文件、确认过的事实、验证过的假设）？
3. 还差什么没做完？下一步合理的做法是什么？
```

遗言被拼进 task 的失败结果里带回主 agent——下次派发不必从零开始。注意遗言 prompt 里"不要再调用工具、只描述和建议"的禁令：没有它，被叫醒的子代理会条件反射地继续原任务，然后被第二次击杀。

### ⑤ 同 brief 去重：一样的任务别花两份钱

弱模型有个费钱的习惯：同一条回复里连发两个一模一样的 task。第二个必然是冗余的——第一个的结果还没回到模型手里，它不可能"有理由"重发。所以派发前先查（brief 归一化：压空格、转小写再比对，`"查一下  Auth"` 和 `"查一下 auth"` 是同一个任务）：查到同批已跑过，直接返回指向原任务的指针 + 复用结论，一个子代理都不 spawn。

## 接进你的 agent

[agent.mjs](./agent.mjs) 里 task 的 handler 就是上面四件事的串联，注意看门狗是**套**在子代理外面的，子代理自己毫不知情：

```js
const { disposition, result, durationMs } = await runChildWithWatchdog(adapter, PROD_LIMITS);
if (disposition === "completed") return result;
child.resetForConclude(); // 击杀后：解除中断，进遗言回合
const conclude = await runChildWithWatchdog(
  { ...adapter, run: () => child.runTurn(concludePrompt(disposition, durationMs)) },
  { ...PROD_LIMITS, timeoutMs: PROD_LIMITS.concludeTimeoutMs },
);
```

两个实现细节值得留意：`chat()` 多了 `signal` 参数，`child.interrupt()` 会 abort 在途的 fetch——**模型流断在半路也杀得掉**，这正是心跳看门狗要抓的那类卡死；子代理的 LoopBudget 熔断时不给纠偏机会，直接收口把话筒交回主线——在隔离上下文里继续烧钱，不如让监督者换个 brief 重派。

验收：`AGENT_API_KEY=sk-xxx node agent.mjs`，让它"用子代理调查一下这个目录里都有什么类型的文件"——你会看到黄色的 `task sub_xxx：…` 行，子代理自己的工具调用刷屏，最后只有一段结论回到主对话。

## 真实产品对照

本章机制对应 Reina 的 `packages/core/src/subagent/manager.ts`。生产常量（均可环境变量覆盖）：`MAX_SUBAGENT_DEPTH=1`、硬顶 `DEFAULT_SUBAGENT_TIMEOUT_MS=600_000`、心跳 `HEARTBEAT_INTERVAL_MS=10_000`、`STALE_IDLE_MS=450_000`、`STALE_IN_TOOL_MS=1_200_000`、活性窗口 `HEALTHY_RECENT_MS=30_000`、延期 `HEALTHY_EXTEND_MS=300_000`、遗言硬顶默认 90 秒。几个示例版没装下的生产细节：

- **防套娃是双保险**：`assertDepth()` 显式检查深度之外，`BLOCKED_FOR_SUBAGENT` 集合直接把 `task`、`question`（子代理没有用户可问）、`compact_conversation` 等工具从子代理工具箱里拿掉——"defense in depth"。
- **等人不算卡死**：子代理的工具在等用户审批（`pending_approval`）时，心跳和硬顶**双双暂停计时**——用户离开电脑几小时是合法状态，等待的时间还会补回硬顶额度。
- **击杀前先警告**：闲置越过预算一半时先向 UI 发 `async-task-warning`，用户能在击杀前介入。
- **首轮宽限**：还没有任何工具调用/轮次时按在途（宽）预算算——慢的首个模型响应不该被误杀。
- **去重管两个窗口**：`findLiveDuplicateDispatch` 管跨轮（同 (agent, brief) 的任务还在 running/resuming 就返回 merged 指针），`inFlightDispatches` 管同批并发。归一化和本章同款：压空格、转小写、截 240 字符。此外还有**同 brief 失败重试上限**（默认 3 次）：反复失败的 brief 会被直接拒绝——"re-firing the same prompt won't help"。
- 遗言产物的标注原文：`[Salvaged self-report — original task was killed; this is the subagent's summary of what it did before the cut-off]`——明确告诉监督者这不是正常交付。

Claude Code 的 Agent tool（子代理）同样是"结论带回、过程隔离"：你只能看到它的最终报告，中间几十轮搜索从不进主对话——下次派一个搜索任务时留意一下 token 计数就能确认。

## 动手挑战

1. 把 task 改造成异步版：`start_task` 立刻返回 `task_id`，另加 `check_task` 工具查询进度/取结果（提示：`runChildWithWatchdog` 的调用改成 fire-and-forget，结果存进一个 Map）。做完你会发现同 brief 去重突然从"同批"扩展到了"跨轮"——这正是 s11 多 agent 协作的地基。
2. 思考题：本章的 `interrupt()` 是协作式的——abort 在途 fetch、在轮次边界停下。但如果卡死的是 `execSync` 里的子进程（30 秒超时之前），中断要等它自然超时才生效。真正的强杀需要什么？（提示：想想为什么 Reina 的子代理是独立的 engine 实例、Claude Code 的工具跑在可以 `kill()` 的子进程里。代价是什么？）

---

| [← 上一章：会话落盘与恢复](../s08_persistence/README.md) | [目录](../README.md) | [下一章：System prompt 组装与技能加载 →](../s10_prompt_assembly/README.md) |
|---|---|---|
