# s07 · 缓存命中工程：同样的活，别花 10 倍的钱

> **格言：前缀缓存不是优化项，是 agent 的定价模型——一个时间戳就能让你多付 10 倍。**

## 你的 agent 每一轮都在"重新读一遍全部历史"

先看清一个事实：agent 循环每一轮都要把**越来越长的 messages 全量发一遍**。第 1 轮发 2k token，第 30 轮就是 100k——而且下一轮还是 100k 多一点，再下一轮又是。一个 50 轮的任务，累计发送的输入 token 是**历史长度的几十倍**。输入 token 是 agent 账单的绝对大头。

服务商知道这件事，所以给了一条活路：**前缀缓存**。原理说穿了很简单——模型收到请求后要把整个 prompt 从头算一遍（这一步叫 prefill，占了输入侧几乎全部算力）；如果这次请求的开头和上次**逐字节相同**，中间计算结果（KV cache）可以直接复用，几乎不花算力。所以服务商对命中缓存的部分只收**约一折**：DeepSeek 的缓存命中输入价约为未命中的 1/10，Anthropic 的 cache read 同样是基础输入价的 0.1 倍。

看清代价结构：你的第 30 轮请求里，前 99% 是和上一轮一模一样的历史。命中缓存，这一轮输入费打一折；不命中，全价。算笔账——一个 30 轮的任务，平均每轮 prompt 60k token，累计输入 1.8M token：

- 全部未命中：1.8M × 全价；
- 稳定 95% 命中：1.8M × (5% × 全价 + 95% × 一折) ≈ 0.145 × 全价，**省 85%**。

**懂缓存和不懂缓存的两个实现，功能一模一样，账单差将近 10 倍**——而"不命中"往往只是因为某个人在 system prompt 里写了一行 `当前时间：...`。

![前缀缓存依赖逐字节稳定，早期断点会让后续历史全部按全价计算](../assets/s07-cache-prefix.svg)

**本章代码 = s03 基底 + 每轮打印 token 用量与缓存命中率**（免 key 演示：字节级找出缓存断点）。

## 先跑演示（不需要 API key）

```sh
node s07_prompt_cache/demo.mjs
```

## 设计：三条纪律，一套仪表

### ① 三条纪律：前缀的每个字节都是钱

命中条件是"前缀逐字节相同"，而请求的开头依次是 system、tools、历史消息。三条纪律分别看住这三段：

1. **system prompt 逐轮字节稳定**。时间戳、随机数、"剩余预算 7 轮"这类每轮会变的东西是缓存杀手——变化发生在请求最开头，断点之后（tools + 全部历史）全部按全价重算。每轮会变的信息挪到**最后一条用户消息**里去：尾部本来就是新字节，不破坏任何前缀。
2. **tools 数组顺序稳定**。工具定义紧跟 system 之后序列化进请求。别在运行时排序、按条件增删、往 description 里拼动态内容。
3. **messages 只追加，不改写**（append-only）。历史里任何一个字节被改动，断点就跳回那里，之后的全部历史退回全价。最常见的好心办坏事："帮模型省上下文"回头截短旧的工具输出——省了几十 token 的上下文，赔掉整段后续历史的缓存（demo 实验 C 演的就是它）。

免 key 演示把断点直接算给你看（真实运行输出）：

```
━━━ 实验 A：时间戳写进 system ━━━
  第 2↔3 轮：公共前缀 21 字符（上一轮请求共 594 字符 → 可复用 3.5%）
    断点上下文: …"em]\n当前时间：10:23:02。你是一个运行在用户终" vs …"em]\n当前时间：10:23:03。你是一个运行在用户终"

━━━ 实验 B：system 稳定，时间戳放进用户消息尾部 ━━━
  第 2↔3 轮：公共前缀 597 字符（上一轮请求共 597 字符 → 可复用 100.0%）
    断点在上一轮请求的末尾之后——新增的只有追加的消息，这就是理想形状。

━━━ 实验 C：第 3 轮"好心"截短旧的工具输出 ━━━
  第 2↔3 轮：公共前缀 353 字符（上一轮请求共 597 字符 → 可复用 59.1%）
```

这三条纪律最难的不是做到，是**别在后续迭代里悄悄破坏**。Reina 为此专门写了回归测试 `packages/core/src/engine-prompt.cache-stability.test.ts`：把所有每轮会变的状态（todos、计划、笔记、autopilot 进度、记忆块）全部塞满，断言 system prompt **一个字节都不动**——

```ts
const empty = buildSystemPrompt(baseSession());
const loaded = buildSystemPrompt(withVolatileState(baseSession()));
expect(loaded).toBe(empty);
```

这些易变状态走另一条通道 `buildVolatileContextReminder`，作为尾部消息随每轮追加（正是纪律①的"挪到最后"）。测试注释写得直白：这个文件存在的意义，就是"某天有人把一个每轮会变的值接进 buildSystemPrompt"时**大声地失败**——静默的缓存击穿没有任何报错，只有月底的账单。

### ② 测量：省钱必须可见

不打印命中率，纪律就是玄学——你永远不知道自己有没有做对。服务商在 `usage` 里报了账，但字段名不统一，两种都要会读：

```js
// DeepSeek：usage.prompt_cache_hit_tokens / usage.prompt_cache_miss_tokens
// OpenAI：  usage.prompt_tokens_details.cached_tokens（未命中 = prompt - cached）
let hit;
if (typeof usage.prompt_cache_hit_tokens === "number") hit = usage.prompt_cache_hit_tokens;
else if (typeof usage.prompt_tokens_details?.cached_tokens === "number") hit = usage.prompt_tokens_details.cached_tokens;
```

本章 agent 每轮打印一行仪表（格式示意；第一轮命中 0% 是正常的——缓存要先有上一次请求才有"上次"）：

```
📊 prompt 48213 | 命中 47616（98.8%）| 未命中 597 | 本轮输入费≈省 89% | 会话累计命中 91.2%
```

健康的 agent 从第二轮起命中率应该在 90% 以上，而且随任务变长**越来越高**——历史越长，"和上轮相同的开头"占比越大。仪表异常时对着这张表查：

| 现场 | 诊断 |
|---|---|
| 每一轮都是 0% | 前缀在最开头就断了——system 或 tools 里混进了每轮变化的字节（时间戳是头号嫌犯） |
| 一直 95%+，某轮突然跌到 50% | 历史中段被改写了——检查是否有代码在"回头修剪"旧消息（违反 append-only） |
| 压缩后的第一轮跌到 0% | 预期行为：s06 把历史整段重写，缓存必然报废一次，用一次全价换之后每轮更短的前缀 |
| 命中率正常但账单没降 | 确认服务商真的支持前缀缓存并读对了字段——读不到字段时本章 agent 会明说，而不是打印一个假的 0 |

顺带一提：看门狗的纠偏 prompt（s03）是**追加**的用户消息，对缓存无害——所有"往尾部塞东西"的机制天然安全，危险的永远是"回头改前面"。

### ③ 进阶案例一：连"省钱的操作"本身都要省

s06 的压缩要把整段被压历史发给摘要模型——听起来注定全价：换了 system prompt（摘要指令）、不带 tools，前缀从第一个字节就对不上。一次压缩 = 10 万 token 全价，压缩越勤，罚款越多。

Reina 的解法（`packages/core/src/compaction.ts`，搜 `SummaryCacheReuse`）：摘要调用**不换 system**。直接复用主 agent 刚缓存过的 `[system + tools + history]` 前缀——被压缩的大段历史按原样作为消息发出（provider 序列化和上一轮逐字节相同），摘要指令作为**追加的一条用户消息**放在末尾。于是 10 万 token 的历史按缓存读计费，全价的只有末尾几百 token 的指令。代价是一点风险：主 agent 的 system prompt 鼓励用工具，模型可能不总结反而干活——所以指令里带上"禁止调用工具"的围栏，一旦模型仍然"叛逃"去调工具，立刻放弃、退回换 system 的老实路径重试。最坏情况多花一次几乎全命中的调用，绝不会拿到降质的摘要。

### ④ 进阶案例二：fork 子代理生下来就带着缓存

多 agent 场景的痛点是**冷启动**：每个子代理独立的 system + 历史，第一轮全价。Reina 的 fork 模式（`packages/core/src/subagent/fork.ts` 的 `buildForkContext`，由 `subagent/manager.ts` 调用）让子代理直接继承父会话的消息尾部（按 token 预算选，默认 8k、上限 24 条，且刻意**停在消息边界**上）——子代理的第一轮请求就是"父会话的前缀 + 一条任务指令"，第一轮就命中父缓存。源码注释的说法：一次 fan-out 的成本是 "supervisor's prefix + small delta per worker"，而不是 N 次冷启动。子代理的完整机制是 s09 的主角，这里先记住：**缓存友好是它的出生设计，不是事后补丁**。

## 跑起来

```sh
AGENT_API_KEY=sk-xxx node s07_prompt_cache/agent.mjs
```

给它一个多轮任务（比如"看看这个目录的结构，然后读一下最大的那个文件"），盯着每轮的 📊 行：第一轮命中 0%，之后应该迅速爬到 90%+。然后做个破坏性实验：把 `SYSTEM` 第一行改成 `` `当前时间：${new Date().toISOString()}` ``，重跑同样的任务——命中率归零，亲眼看一次 10 倍的差距。

## 真实产品对照

上文已核实的三处 Reina 源码：`engine-prompt.cache-stability.test.ts`（前缀稳定性回归测试）、`compaction.ts` 的 `SummaryCacheReuse` / `tryCacheFriendlySummary`（摘要调用吃主 agent 缓存）、`subagent/fork.ts` 的 `buildForkContext`（fork 继承父前缀）。Claude Code 同样遵守这套纪律：system prompt 会话内稳定，动态上下文（文件变更提醒、todo 状态）全部以 `<system-reminder>` 消息**追加**在对话尾部，而不是改写 system——你在 transcript 里看到的那些 reminder，位置就是纪律①的教科书示范。

一个容易误解的点：缓存匹配实际按 token 块粒度对齐（DeepSeek 64 token 一块，Anthropic/OpenAI 也有各自的最小长度和断点规则），demo 用字符近似只是为了让"断在哪里"肉眼可见，原理一致。

## 动手挑战

1. 给本章 agent 加一个 `/cost` 命令：按你所用服务商的真实价目（命中价、未命中价、输出价）把会话累计花费折算成钱，并对比"如果全部未命中"的假想账单。省钱可见，才有人守纪律。
2. 思考题：s06 的压缩把历史整段重写，缓存必然失效一次。那压缩的**阈值**（75%）和缓存其实存在一个隐藏的权衡：压得越早，缓存报废越频繁；压得越晚，每轮背的未命中风险越大。如果服务商的缓存只保留 5 分钟（DeepSeek 的缓存有淘汰机制），这个权衡又会怎么变？（s09 讲子代理时会再回到"前缀即资产"这个视角。）

---

| [← 上一章：上下文压缩](../s06_compaction/README.md) | [目录](../README.md) | [下一章：会话落盘与恢复 →](../s08_persistence/README.md) |
|---|---|---|
