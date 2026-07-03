# s06 · 上下文压缩：忘掉过程，别忘掉任务

> **格言：压缩丢什么都行，唯独不能丢"用户让我干嘛"。**

## 跑了半小时，它礼貌地问你"请问您想做什么？"

s04 管住了单次工具输出，但管不住总量：**messages 只增不减**，每轮工具结果都往里堆。任务够长，顶到上下文窗口只是时间问题——到时候 API 直接拒收：`This model's maximum context length is 131072 tokens...`。

所以你得压缩：把旧消息换成一段摘要。但压缩有一个更隐蔽的坑，比爆窗难堪得多——

你让 agent"把 utils/date.js 的 formatDate 改成支持时区，改完跑测试"。它干了半小时，五十多条工具往返，触发了压缩。摘要模型把这段历史总结成"用户在进行日期工具函数的重构工作"。再压一次，变成"用户在优化项目代码"。然后你回来，看到它停在那里，礼貌地问：**"请问您接下来想做什么？"**

它没坏，也没爆窗。它只是把你最初的指令**转述丢了**。摘要是模型生成的，而转述必然走样——每压一次走样一点，几轮之后目标彻底漂移。本章的全部要点：压缩是必须的，但有些东西必须**逐字**活过压缩。

**本章代码 = s03 基底 + compaction.mjs 压缩器**（每轮结束检查触发）。

![上下文压缩用摘要替换中段历史，同时逐字保留启动任务和最近尾部](../assets/s06-compaction-shape.svg)

## 先跑演示（不需要 API key）

```sh
node s06_compaction/demo.mjs
```

三个场景：触发判定、切片决策（启动消息逐字保留）、摘要失败降级。

## 设计：四个关键决定

### ① 触发时机：信服务商的账本，别自己数 token

第一反应往往是"我本地算一下 messages 有多少 token"。别。你手上没有服务商的 tokenizer——本地估算（哪怕用 tiktoken）对 DeepSeek / Claude / GLM 都是近似值，中文文本误差轻松超过 15%。估少了，你会在真窗口边界撞出 `context too long`，此时已经来不及优雅压缩。

正确做法零成本：**每次 API 响应都带 `usage`**，那是服务商亲口报的数。`total_tokens = prompt + completion`，约等于下一轮请求要背的全部历史。拿它对照模型窗口，超过阈值（本章默认 75%）就压：

```js
const used = usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
const threshold = Math.floor((contextWindow * triggerPercent) / 100);
if (used >= threshold) /* 触发压缩 */;
```

留 25% 余量不是保守——压缩本身还要调一次模型、摘要还要占地方，你需要在**还有操作空间的时候**动手。Reina 的 `sessionContextTokens` 同款取舍：provider 报的总量是唯一真相，本地 o200k 估算只在还拿不到 provider 报数时兜底（会话第一轮、或服务商不报 total）——源码注释原话：估算比真值"typically ~15-20% low"。

### ② 压缩的形状：三段式，启动消息逐字保留

压缩不是"全部换成摘要"。正确形状是三段：

```
[system]                        ← 不动（它本来就不在 messages 里）
[中段历史]                       → 换成模型生成的结构化摘要
[启动本轮任务的用户消息]           → 逐字保留 ★
[最近的尾部消息]                  → 原样保留（模型正在用的工作记忆）
```

尾部保留好理解：最近几条工具结果是模型的短期记忆，压了它等于打断正在进行的操作。**启动消息逐字保留**才是本章的灵魂——它是 Reina 真实修过的坑（commit `ce4724f` "keep the launching user message verbatim through compaction"）：长任务里压缩总在工具循环中途触发，"最近 N 条"全是工具结果，那条启动任务的用户指令刚好落在被压缩区，被摘要转述掉——模型从此在**自己指令的转述版**上继续干活（上游 agent 框架 hermes 也栽在同一个坑上，issue #10896）。

实现是把分割点**回拉**到最后一条真实用户消息：

```js
let keepFrom = messages.length - keepRecent;
const lastUser = messages.findLastIndex((m) => m.role === "user");
if (lastUser >= 0 && lastUser < keepFrom) {
  if (charsOf(messages.slice(lastUser)) <= maxAnchorChars) keepFrom = lastUser;
}
// 切口不能落在 assistant(tool_calls)/tool 一对中间，否则下轮请求 400
while (keepFrom > 0 && messages[keepFrom].role === "tool") keepFrom--;
```

回拉有上限：启动消息如果在几百条之前，把它之后的全保留，压缩就腾不出空间了。超限时放弃回拉——兜底交给下一条。

### ③ 摘要 prompt：填表，不是"总结一下"

"总结一下上面的对话"得到的是抒情散文，丢的恰好是接续任务最需要的硬信息。要逼模型按栏目填表，每一栏都对应"压缩后第一轮"会用到的东西：

```
1. 任务目标：用户让你做什么。逐字引用用户原话，禁止转述。
2. 已完成：做了哪些事、各自的结论。
3. 未完成 / 待办：接下来该做什么，按优先级排。
4. 涉及的文件与关键命令：完整路径和完整命令，逐字保留。
5. 关键决定与踩过的坑：为什么选了这条路，哪些路已被证明走不通。
```

注意第 1 栏又要求了一遍"逐字引用"——这是对决定②的双保险：即使启动消息因超长没能逐字保留，原话也还在摘要里。第 5 栏经常被忽略但极其值钱：不记"哪些路走不通"，压缩后的模型会把失败的路再走一遍。

### ④ 摘要挂了，会话不能陪葬

摘要要调一次模型，而模型调用什么错都可能出：限流、超时、断网。此刻会话已经贴着窗口上限，"下轮再试"往往等不起——**压缩绝不能因为压缩失败而毁掉会话**。所以必须有一条永不失败的降级路径：提取式摘要，纯字符串处理，把每条消息掐头去尾拼成骨架：

```js
try {
  summary = await summarize(toSummarySource(middle));
} catch {
  degraded = true;
  summary = extractiveSummary(middle); // 不聪明，但零依赖、永不失败
}
```

有损的记忆也比崩掉的会话强。Reina 的 `buildCompactSummary` 就是这个结构：模型摘要 try/catch 包住，任何异常落到 `extractiveSummary`，源码注释原话——"so compaction never blocks the main turn"。

## 跑起来

```sh
AGENT_API_KEY=sk-xxx node s06_compaction/agent.mjs
# 可选：AGENT_CONTEXT_WINDOW=128000 AGENT_COMPACT_PERCENT=75
```

窗口没有任何 API 能查，只能自己配（Reina 也是配在 models.json 里）。想亲眼看到压缩，把 `AGENT_COMPACT_PERCENT` 调到 5，然后让它连续读几个大文件。免 key 演示的切片决策输出节选（真实运行）：

```
━━━ 场景二：切片决策（保什么 / 压什么 / 启动消息逐字保留） ━━━
  共 27 条消息。只看"尾部保底 8 条"，该从第 19 条切——
  但那样启动任务的用户消息（第 6 条）就会被摘要转述掉。
  分割点回拉到最后一条真实用户消息：实际 keepFrom = 6。逐条判决：
    [ 0] 🗜️ 压缩  user      这个仓库的测试是怎么组织的？大概讲讲。…
    ...
    [ 6] 📌 保留 ←启动消息，逐字  user      帮我把 utils/date.js 里的 formatDate 改成支持时区参数 tz，默认 UTC…
    [ 7] 📌 保留  assistant → run_shell({"command":"rg -n formatDate src utils"}…)
    ...
  压缩完成：27 条 → 22 条（压掉 6 条，降级=false）

━━━ 场景三：摘要模型挂了（超时/限流），压缩绝不能毁掉会话 ━━━
  摘要调用抛出 429 → 自动降级为提取式摘要（degraded=true），会话照常继续。
```

## 真实产品对照

本章是 Reina `packages/core/src/compaction.ts` 的最小化移植，生产版多出的部分同样值得知道：

- **触发阈值不是拍的 75%**：有效窗口 = 窗口 − 20k（给输出留的），默认再留 13k 安全垫（400k+ 窗口留 30k、800k+ 留 50k）；用户可用 `REINA_COMPACTION_TRIGGER_PERCENT` 换成百分比语义。另有"净收益门槛"：可压前缀不足 2000 token 就拒绝压——否则 /compact 每次剥一条小消息、再注入一条差不多大的摘要，永远压不完。
- **回拉上限是有效窗口的 25%**（`COMPACT_TAIL_USER_ANCHOR_WINDOW_FRACTION`），超限时靠摘要里的逐字引用段兜底——和本章 `maxAnchorChars` 同构。
- **摘要 prompt 是 9 个栏目**（Primary Request and Intent / Errors and Fixes / All user messages / Current Work / Next Step…），要求先写 `<analysis>` 草稿再输出 `<summary>`，且用 prompt 前后双重围栏禁止工具调用——因为部分 OpenAI 兼容端点会无视 `tools: []` 照样发起工具调用。
- **被压掉的历史没有消失**：全文落盘到 `.reina/conversation_history/<sessionId>.md`，摘要消息里附路径指针，模型需要旧细节时可以自己去读——这正是 s04"无损溢出"的思想在压缩上的复用。

Claude Code 的行为你也能观察到：上下文快满时状态栏出现 "Context left until auto-compact: 8%"，压缩后它对之前任务的记忆变成摘要腔——但最初的任务指令还在，就是同一套机制。

## 动手挑战

1. 本章每次压缩都从头生成摘要。改成**滚动摘要**：把上一次的摘要作为输入传给摘要模型，并在 prompt 里加一条"上一份摘要中仍然相关的部分逐字复制，不要改写"。想想为什么"逐字复制"比"合并改写"更重要（提示：和启动消息逐字保留是同一个道理——转述会累积走样）。
2. 压缩后的摘要消息每轮都会重发一遍。它的内容是稳定的吗？如果你在摘要里加上"压缩于 {当前时间}"，会发生什么？（答案关系到钱，下一章见分晓。）

---

| [← 上一章：流式与中断](../s05_streaming_interrupt/README.md) | [目录](../README.md) | [下一章：缓存命中工程 →](../s07_prompt_cache/README.md) |
|---|---|---|
