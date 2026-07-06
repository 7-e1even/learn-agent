# s06 · 上下文压缩

agent 的 messages 只增不减，长任务迟早顶到上下文窗口。本章实现上下文压缩：把旧消息替换为摘要，同时保证用户的原始指令不被转述丢失。

## 问题：压缩会转述丢失任务目标

s04 管住了单次工具输出，但管不住总量：messages 只增不减，每轮工具结果都在累积。任务够长，就会顶到上下文窗口，API 拒收：`This model's maximum context length is 131072 tokens...`。

所以需要压缩：把旧消息换成一段摘要。但压缩有一个比爆窗更隐蔽的问题。

你让 agent"把 utils/date.js 的 formatDate 改成支持时区，改完跑测试"。它执行了五十多条工具往返，触发了压缩。摘要模型把这段历史总结成"用户在进行日期工具函数的重构工作"。再压一次，变成"用户在优化项目代码"。最后它停下来问："请问您接下来想做什么？"

它没有出错，也没有爆窗，只是把最初的指令转述丢了。摘要是模型生成的，转述必然走样——每压一次走样一点，几轮之后目标彻底漂移。本章的要点：压缩是必须的，但有些内容必须**逐字**保留过压缩。

本章代码 = s03 基底 + compaction.mjs 压缩器（每轮结束检查触发）。

![上下文压缩用摘要替换中段历史，同时逐字保留启动任务和最近尾部](../assets/s06-compaction-shape.svg)

## 运行演示（不需要 API key）

```sh
node s06_compaction/demo.mjs
```

三个场景：触发判定、切片决策（启动消息逐字保留）、摘要失败降级。

## 设计：四个关键决定

### ① 触发时机：使用服务商报告的 usage，不自己数 token

第一反应往往是本地计算 messages 的 token 数。但你手上没有服务商的 tokenizer——本地估算（即使用 tiktoken）对 DeepSeek / Claude / GLM 都是近似值，中文文本误差可以超过 15%。估少了，会在真实窗口边界撞出 `context too long`，此时已来不及压缩。

正确做法零成本：每次 API 响应都带 `usage`，那是服务商报告的准确数字。（流式调用要在请求里加 `stream_options: {"include_usage": true}`，usage 才会出现在流的最后一片——不加则拿不到用量，压缩永远不会触发。）`total_tokens = prompt + completion`，约等于下一轮请求要携带的全部历史。拿它对照模型窗口，超过阈值（本章默认 75%）就压缩：

```js
const used = usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
const threshold = Math.floor((contextWindow * triggerPercent) / 100);
if (used >= threshold) /* 触发压缩 */;
```

留 25% 余量的原因：压缩本身还要调用一次模型、摘要还要占空间，需要在仍有操作空间时动手。Reina 的 `sessionContextTokens` 是同样的取舍：provider 报告的总量为准，本地 o200k 估算只在拿不到 provider 数字时兜底（会话第一轮、或服务商不报 total）——源码注释原话：估算比真值 "typically ~15-20% low"。

### ② 压缩的形状：三段式，启动消息逐字保留

压缩不是"全部换成摘要"。正确形状是三段：

```
[system]                        ← 不动（它本来就不在 messages 里）
[中段历史]                       → 换成模型生成的结构化摘要
[启动本轮任务的用户消息]           → 逐字保留 ★
[最近的尾部消息]                  → 原样保留（模型正在用的工作记忆）
```

尾部保留的原因：最近几条工具结果是模型的工作记忆，压掉等于打断正在进行的操作。**启动消息逐字保留**是本章的核心——Reina 修复过这个问题（commit `ce4724f` "keep the launching user message verbatim through compaction"）：长任务里压缩总在工具循环中途触发，"最近 N 条"全是工具结果，启动任务的用户指令恰好落在被压缩区，被摘要转述——模型从此在自己指令的转述版上继续工作（上游 agent 框架 hermes 也遇到过同一问题，issue #10896）。

实现是把分割点回拉到最后一条真实用户消息：

```js
let keepFrom = messages.length - keepRecent;
const lastUser = messages.findLastIndex(isRealUser);
if (lastUser >= 0 && lastUser < keepFrom) {
  if (charsOf(messages.slice(lastUser)) <= maxAnchorChars) keepFrom = lastUser;
}
// 切口不能落在 assistant(tool_calls)/tool 一对中间，否则下轮请求 400
while (keepFrom > 0 && messages[keepFrom].role === "tool") keepFrom--;
```

注意用 `isRealUser` 而不是 `m.role === "user"`——历史里的 user 消息不全是用户说的：s03 看门狗的纠偏 prompt、上一次压缩留下的摘要，也都以 `role:"user"` 存在。锚点若停在它们身上，真正的启动指令仍会被转述丢失——所以按已知前缀（`[上下文压缩]`、`自动纠偏触发：`）排除合成消息。

回拉有上限：启动消息如果在几百条之前，把它之后的全部保留，压缩就腾不出空间。超限时放弃回拉——由下一条兜底。

### ③ 摘要 prompt：按栏目填写，不是笼统总结

"总结一下上面的对话"得到的是泛泛的叙述，丢失的恰好是接续任务最需要的信息。应当让模型按栏目填写，每一栏对应"压缩后第一轮"会用到的内容：

```
1. 任务目标：用户让你做什么。逐字引用用户原话，禁止转述。
2. 已完成：做了哪些事、各自的结论。
3. 未完成 / 待办：接下来该做什么，按优先级排。
4. 涉及的文件与关键命令：完整路径和完整命令，逐字保留。
5. 关键决定与踩过的坑：为什么选了这条路，哪些路已被证明走不通。
```

第 1 栏再次要求"逐字引用"——这是对决定②的双保险：即使启动消息因超长没能逐字保留，原话也还在摘要里。第 5 栏容易被忽略但很重要：不记录"哪些路走不通"，压缩后的模型会把失败的路径重走一遍。

### ④ 摘要失败时的降级

摘要要调用一次模型，而模型调用可能出各种错误：限流、超时、断网。此刻会话已经接近窗口上限，"下轮再试"往往来不及——**压缩不能因为摘要失败而毁掉会话**。所以需要一条不会失败的降级路径：提取式摘要，纯字符串处理，把每条消息截取首尾拼成骨架：

```js
try {
  summary = await summarize(toSummarySource(middle));
} catch {
  degraded = true;
  summary = extractiveSummary(middle); // 不智能，但零依赖、不会失败
}
```

有损的记忆也比崩溃的会话好。Reina 的 `buildCompactSummary` 是同样的结构：模型摘要用 try/catch 包住，任何异常落到 `extractiveSummary`，源码注释原话——"so compaction never blocks the main turn"。

## 运行方式

```sh
AGENT_API_KEY=sk-xxx node s06_compaction/agent.mjs
# 可选：AGENT_CONTEXT_WINDOW=128000 AGENT_COMPACT_PERCENT=75
```

窗口大小在标准 chat/completions 协议里没有字段可查（个别服务商的模型列表接口会给 `context_length`，但不可依赖），所以只能自己配置（Reina 也是配在 models.json 里）。想观察压缩过程，把 `AGENT_COMPACT_PERCENT` 调到 5，然后让它连续读几个大文件。免 key 演示的切片决策输出节选（真实运行）：

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

本章是 Reina `packages/core/src/compaction.ts` 的最小化移植，生产版多出的部分同样值得了解：

- **触发阈值不是固定的 75%**：有效窗口 = 窗口 − 20k（给输出留的），默认再留 13k 安全垫（400k+ 窗口留 30k、800k+ 留 50k）；用户可用 `REINA_COMPACTION_TRIGGER_PERCENT` 换成百分比语义。另有净收益门槛：可压前缀不足 2000 token 就拒绝压——否则 /compact 每次剥一条小消息、再注入一条差不多大的摘要，永远压不完。
- **回拉上限是有效窗口的 25%**（`COMPACT_TAIL_USER_ANCHOR_WINDOW_FRACTION`），超限时靠摘要里的逐字引用段兜底——和本章 `maxAnchorChars` 同构。
- **摘要 prompt 是 9 个栏目**（Primary Request and Intent / Errors and Fixes / All user messages / Current Work / Next Step…），要求先写 `<analysis>` 草稿再输出 `<summary>`，且用 prompt 前后双重围栏禁止工具调用——因为部分 OpenAI 兼容端点会无视 `tools: []` 照样发起工具调用。
- **被压掉的历史没有消失**：全文落盘到 `.reina/conversation_history/<sessionId>.md`，摘要消息里附路径指针，模型需要旧细节时可以自己去读——这是 s04"无损溢出"思想在压缩上的复用。

Claude Code 的行为也可以观察到：上下文快满时状态栏出现 "Context left until auto-compact: 8%"，压缩后它对之前任务的记忆变成摘要形式——但最初的任务指令还在，是同一套机制。

## 练习挑战

1. 本章每次压缩都从头生成摘要。改成滚动摘要：把上一次的摘要作为输入传给摘要模型，并在 prompt 里加一条"上一份摘要中仍然相关的部分逐字复制，不要改写"。想想为什么"逐字复制"比"合并改写"更重要（提示：和启动消息逐字保留是同一个道理——转述会累积走样）。
2. 压缩后的摘要消息每轮都会重发一遍。它的内容是稳定的吗？如果你在摘要里加上"压缩于 {当前时间}"，会发生什么？（这与成本有关，下一章展开。）

---

| [← 上一章：流式输出与中断](../s05_streaming_interrupt/README.md) | [目录](../README.md) | [下一章：Prompt 缓存 →](../s07_prompt_cache/README.md) |
|---|---|---|
