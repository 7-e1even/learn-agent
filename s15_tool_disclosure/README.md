# s15 · 渐进式工具披露

工具只有三五个时一切正常；接上 MCP、工具涨到几十个之后，每轮请求都要把全部工具定义（名字 + 描述 + JSON schema）原样发一遍，几千 token 轮轮都付。更隐蔽的是：工具数组一变，prompt 缓存整段失效，账单不降反升。本章的解法：冷启动只挂少数常用工具和一个搜索入口，其余工具等模型需要时再搜出来用——并避开一个反直觉的缓存坑。

![渐进式工具披露让搜索结果进消息尾部，而不是回灌 provider tools 数组](../assets/s15-tool-disclosure.svg)

## 问题：每轮都在为没用到的工具付费

第一笔账好懂：没用到的工具定义，每轮白付。第二笔来自 s07（缓存命中工程）：tools 数组和 system 一起位于缓存前缀的最前部（Anthropic 的序列化顺序是 tools 在前），数组一变，前缀从头失效，后面全部按全价重算。

自然的想法：不常用的工具先藏起来（标成 `deferred`），只放一个 `search_tool` 入口；模型需要时按关键词搜，搜到后再放开给模型用——这个"放开"的动作，下文称**解蔽**。冷启动的 tools 数组因此明显变小。但解蔽这个动作如果实现不当，会反过来砸掉缓存。

## 运行演示（不需要 API key）

```sh
node s15_tool_disclosure/demo.mjs
```

同一个"按需披露"，两种实现，对比 tools 数组的字节稳定性（真实运行输出）：

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

注意坏做法那行"复用 99%"不代表只损失 1%：新工具追加在尾部，前面 99% 的字节确实没变，但 tools 块是一个闭合的整体，末尾一变，服务商就视为整块变更，tools + system + 全部历史一起按全价重算。差一个字节，等于整块失效。

## 设计：两个关键决定

### ① deferred 目录：冷启动只放入口，不放全部工具

工具分两类：`direct`（每轮都进数组，比如 `run_shell` / `read_file` / `search_tool`）和 `deferred`（冷启动隐藏）。deferred 工具只把"名字 + 一句话摘要"放进一个**目录**，供 `search_tool` 检索。模型看到的冷启动 tools 数组因此小而稳定。

### ② 解蔽不能把工具加回数组

最直觉的解蔽实现：模型搜到 `notify_user`，就把它的完整定义追加进 tools 数组，下一轮直接调用。问题正在这：每解蔽一次，数组变一次，缓存失效一次（演示的坏做法）。省下的是冷启动的一次性 token，赔进去的是会话中段一次次前缀失效。

正确做法是**数组恒定**：搜到的工具永不加回数组。它的 schema 通过搜索结果文本交给模型——搜索结果是一条消息，位于缓存前缀的尾部，往尾部追加天然安全；实际调用走一个常驻的代理工具 `run_tool({ name, input })`。于是不管解蔽多少工具，发给服务商的 tools 块每轮字节恒定（演示的好做法，0 次失效）。

一个重要前提：Anthropic 没有服务端的按需披露能力，这套逻辑只能放在客户端做——为什么不能照抄 Codex 的做法，见文末对照。

## 接进真实 agent

在 s10 的 prompt 组装里，冷启动 tools 只放 direct 类 + `search_tool` + `run_tool`；deferred 目录作为一段"可检索工具清单"注入。模型调 `search_tool("发通知")` → 引擎回搜索结果（含 schema 摘要）→ 模型调 `run_tool({name:"notify_user", input:{...}})` → 引擎按 name 派发到真实工具。全程 tools 数组不变。权限（s13）按**目标工具**裁决，不是按 `run_tool` 本身裁决——这是接线时最容易出错的地方。

## 与真实产品对照（延伸阅读）

为什么不能照抄 Codex？Codex 能让模型直接调用命名空间工具名、而客户端数组不增长，靠的是 OpenAI Responses API 的服务端工具管理——那是 provider 专有能力，无法迁移到 Anthropic 以及绝大多数兼容后端。由此一条通用经验：参考某个 agent 的机制之前，先确认该机制在你的 provider 上是否存在。照搬一个不可迁移的能力，比不搬更糟——表面上省了，实际每轮都在损耗。

Reina 的这套骨架在 `packages/tools/src/registry.ts`（`isDeferredByDefault` 默认白名单、`deferredToolDescriptors` / `directToolDescriptors` 分桶、`resolveExposedTools` 每轮按已解蔽集合重建数组）和 `search-tool.ts`（检索）。检索排序用了 TF-IDF cosine + 关键词混合，并加了 CJK 分词（中日韩按字 unigram + bigram），比 Codex 那套"中文拼音化再 BM25"精度高。但边界也很明确：**词法检索跨不了语言**（中文 query 搜不到英文工具），这是本质限制，Codex / Claude Code 至今也没上向量检索；对 agent 而言影响不大，因为它看到的工具目录本就是英文的，自然用英文搜索。

需要说明的是：Reina 目前的解蔽仍会回灌数组（即本章所说的问题），"数组恒定 + 代理执行"是 `docs/progressive-tool-disclosure-plan.md` 里规划的方向。Claude Code 的可观察行为思路一致：核心工具常驻，MCP 等大批量工具标记为 deferred、只露名字；模型先调 `ToolSearch` 按需检索，schema 通过搜索结果进入上下文（缓存前缀的尾部，天然安全）——冷启动数组小而稳定，即①+②的组合。

## 动手挑战

1. 给演示的"好做法"接一个真实约束：`run_tool` 调用 deferred 工具时，权限要按目标工具裁决
   （复用 s13）。写一版 `run_tool` 的派发：`run_tool({name:"delete_all"})` 应触发 `delete_all` 的
   deny/ask，而不是 `run_tool` 自己的。思考如果漏了这步，会留下多大的漏洞。
2. 阈值门控：工具总数少（比如 < 10）时，全 direct 反而更好——省掉一次 `search_tool` 往返的延迟。
   给披露加一个 `auto:N`：总数 ≤ N 就不 defer，> N 才进披露模式。N 该按什么标定？（提示：
   权衡"多一次搜索往返的延迟"和"多几千 token 的冷启动"哪个代价更高。）

---

| [← 上一章：Provider 兼容层](../s14_provider_compat/README.md) | [目录](../README.md) | [下一章：MoA 多模型合议 →](../s16_moa/README.md) |
|---|---|---|
