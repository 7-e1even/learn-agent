# s15 · 渐进式工具披露：工具多了，别全塞进上下文

> **格言：冷启动少塞工具只是第一步；真正的账在"解蔽之后，tools 数组还稳不稳"。**

这一篇是 s07（缓存命中工程）的续集，从 system prompt 前缀转到**工具维度**。工具三五个时没人
关心，等你接上 MCP、工具奔着几十个去，工具定义本身就成了负担。本章讲怎么"按需披露"，
以及一个我真撞进去过的、反直觉的缓存坑。

![渐进式工具披露让搜索结果进消息尾部，而不是回灌 provider tools 数组](../assets/s15-tool-disclosure.svg)

## 几十个工具，每轮都在为"没用到的工具"付钱

工具定义（name + description + JSON schema）每一轮请求都要**全量序列化**进去。几十个工具就是
几千 token，每轮都付。更阴的是 s07 讲过的第二笔账：**tools 数组和 system 一起位于 prompt cache
前缀的最前部**（Anthropic 的序列化顺序是 tools 在前）——数组一变，前缀就断，后面全按全价重算。

自然的想法：冷启动别全塞。把不常用的工具标成 `deferred` 藏起来，只放一个 `search_tool` 入口，
模型需要时按关键词搜、搜到了再"解蔽"。冷启动的 tools 数组一下就瘦了。

听起来完美——直到你发现解蔽这个动作，把缓存给捅漏了。

## 先跑演示（不需要 API key）

```sh
node s15_tool_disclosure/demo.mjs
```

同一个"按需披露"，两种实现，对着 tools 数组的字节稳定性算账（真实运行输出）：

```
━━━ 坏做法：解蔽即回灌 tools 数组 ━━━
  第 1↔2 轮：tools 150→205 字节 · 公共前缀复用 99%  ❌ 前缀击穿（tools 块变了 → 本轮全价）
  第 2↔3 轮：tools 205→258 字节 · 公共前缀复用 100% ❌ 前缀击穿（tools 块变了 → 本轮全价）
  第 3↔4 轮：tools 258→319 字节 · 公共前缀复用 100% ❌ 前缀击穿（tools 块变了 → 本轮全价）
  → 4 轮里发生 3 次 tools 前缀击穿

━━━ 好做法：稳定代理，数组恒定 ━━━
  第 1↔2 轮：tools 224→224 字节 · 公共前缀复用 100% ✅ 前缀稳定
  → 4 轮里发生 0 次 tools 前缀击穿
```

（注意坏做法那个"复用 99%"是**冷酷的安慰**：新工具追加在数组尾部，前面 99% 的字节确实没变——
但 tools 块是一个**闭合的整体**，末尾那个 `]` 位置一挪、内容一多，服务商就当整块变了，
tools + system + 全部历史一起按全价重新 prefill。差一个字节，等于整块失效。）

## 设计：三个关键决定

### ① deferred 目录：冷启动只放"入口"，不放全部工具

工具分两桶：`direct`（每轮都进数组，比如 `run_shell` / `read_file` / `search_tool`）和 `deferred`
（冷启动藏起来）。deferred 工具的 `name + 一句话摘要`进一个**目录**，交给 `search_tool` 检索。
模型看到的冷启动 tools 数组因此是小而稳定的。

### ② 反直觉的坑：解蔽千万别"回灌"数组

最直觉的解蔽实现是：模型搜到 `notify_user`，就把它的完整 descriptor 加进 tools 数组，下一轮模型
就能直接调。**这恰恰是坑。** 每解蔽一次，下一轮数组就变大一次 → 撞一次 cache miss（演示的坏做法）。
工具越多、解蔽越频繁，这笔损耗越重。省了冷启动的一次性 token，赔进去的是会话中段一次次的前缀击穿。

正确做法是**数组恒定**：被搜到的工具**永不回灌 tools 数组**，它的 schema 通过**搜索结果文本**
（这是一条 message，在缓存前缀的**尾部**，天然安全）交给模型；真正调用走一个常驻的**代理工具**
`run_tool({ name, input })`。于是不管解蔽多少工具，发给服务商的 tools 块**每轮字节恒定**（演示的好做法，0 次击穿）。

### ③ "抄谁"要先看清 provider 能力

这坑我查根因时才明白一件事：**Anthropic 没有服务端 defer 能力。** Codex 能让模型直呼命名空间
工具名而客户端数组不增长，靠的是 OpenAI Responses API 的服务端工具管理——那是 provider 特权，
搬不到 Anthropic 上。所以在 Anthropic（以及绝大多数兼容后端）上，披露逻辑**只能压在客户端**，
也就是②那条"永不回灌 + 代理执行"的路。

> 教训记一句：**"对标某某 agent"之前，先确认那个机制在你的 provider 上到底存不存在。**
> 抄了个搬不过来的能力，比不抄更糟——你以为省了，其实每轮在漏。

## 接进真实 agent

在 s10 的 prompt 组装里，冷启动 tools 只放 direct 桶 + `search_tool` + `run_tool`；deferred 目录作为
一段"可检索工具清单"注入。模型调 `search_tool("发通知")` → 引擎回搜索结果（含 schema 摘要）→
模型调 `run_tool({name:"notify_user", input:{...}})` → 引擎按 name 派发到真实工具。全程 tools 数组
不动。权限（s13）按**目标工具**算，不是按 `run_tool` 本身算——这点是接线时最容易错的地方。

## 真实产品对照

Reina 的这套骨架在 `packages/tools/src/registry.ts`（`isDeferredByDefault` 默认白名单、
`deferredToolDescriptors` / `directToolDescriptors` 分桶、`resolveExposedTools` 每轮按已解蔽集合
重建数组）和 `search-tool.ts`（检索）。检索排序用了 TF-IDF cosine + 关键词混合，还专门加了
**CJK 分词**（中日韩按字 unigram + bigram），比 Codex 那套"中文拼音化再 BM25"精度高——但也踩清了
边界：**词法检索跨不了语言**（中文 query 搜英文工具搜不到），这是本质限制，Codex / Claude Code
至今也没上向量；对 agent 其实是伪需求，因为它看到的工具目录本就是英文的，自然用英文搜。

一个诚实的说明：Reina 目前的解蔽仍会"回灌数组"（就是本章说的坑），"数组恒定 + 代理执行"是
`docs/progressive-tool-disclosure-plan.md` 里规划的方向。Claude Code 的可观察行为思路一致：
核心工具常驻，MCP 等大批量工具标记为 deferred、只露名字；模型先调 `ToolSearch` 按需检索，
schema 通过**搜索结果**进入上下文（缓存前缀的尾部，天然安全）——冷启动数组小而稳定，这正是
①+②的组合。

## 动手挑战

1. 把演示的"好做法"接一个真实约束：`run_tool` 调用 deferred 工具时，权限得按**目标工具**裁决
   （复用 s13）。写一版 `run_tool` 的派发：`run_tool({name:"delete_all"})` 该触发 `delete_all` 的
   deny/ask，而不是 `run_tool` 自己的。想想如果漏了这步，会开出多大一个后门。
2. 阈值门控：工具总数少（比如 < 10）时，全 direct 反而更好——省掉一次 `search_tool` 往返的延迟。
   给披露加一个 `auto:N`：总数 ≤ N 就不 defer，> N 才进披露模式。N 该按什么标定？（提示：既不是拍脑袋，
   也不是越小越好——想想"多一次搜索往返的延迟"和"多几千 token 的冷启动"哪个更疼。）

---

| [← 上一章：Provider 兼容层](../s14_provider_compat/README.md) | [目录](../README.md) | 下一章：（连载中） |
|---|---|---|
