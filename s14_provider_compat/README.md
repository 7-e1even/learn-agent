# s14 · Provider 兼容层：让一个循环喂饱一群乱吐 JSON 的模型

> **格言：别假设模型会守契约。它会把名字叫错、参数写歪、JSON 截断、把调用写进正文——这些全该在 provider 边界掰平，循环里只见干净结构。**

前面十三篇，循环拿到的 tool call 一直是干净的 `{ name, input }`。那是因为 demo 里只接了一个
听话的模型。真做本地优先的 agent，你要同时喂 DeepSeek / Kimi / GLM / Qwen / 本地 Ollama
一大堆——它们发 tool call 的规矩各不相同，而且**没一个像文档里那么规矩**。本章就是循环和
模型之间那层薄薄的"翻译官"。

## 十个 tool call，三个是歪的

理想里模型吐一个 `{"name":"run_shell","arguments":"{\"command\":\"ls\"}"}`。现实里我见过的花样：

| 歪法 | 现场 |
|---|---|
| **名字叫错** | `bash` / `shell` / `terminal`，指的都是你的 `run_shell` |
| **参数键写歪** | `command` 写成 `cmd` / `shellCommand` / `script` |
| **JSON 截断** | `max_tokens` 砍在半路，`{"command":"npx vi` 就没了，引号括号都没关 |
| **裹在散文里** | 不走 tool 通道，在正文里写一段 ` ```json {...} ``` `，或混在解释中间 |

第一反应是"这些破模型不支持了"。但本地优先恰恰要吃这一堆，没得挑。想通之后的定位很清楚：
**这不该是循环的负担，该在 provider 边界做一层归一化**，循环里永远只见干净的 `{ name, input }`。
四手全是死规则、零模型参与。

## 先跑演示（不需要 API key）

```sh
node s14_provider_compat/demo.mjs
```

五种"吐歪"现场，看确定性怎么掰回来（真实运行输出，节选）：

```
━━━ ② 参数键写歪：cmd / shellCommand → command ━━━
  模型吐出: name="run_shell"  args="{\"cmd\":\"npm test\",\"workdir\":\"/repo\"}"
  → 掰成: {"name":"run_shell","input":{"command":"npm test","cwd":"/repo"}}

━━━ ③ JSON 截断：max_tokens 砍在半路，引号括号都没关 ━━━
  模型吐出: name="run_shell"  args="{\"command\":\"npx vitest ru"
  → 掰成: {"name":"run_shell","input":{"command":"npx vitest ru"}}
  ⚠️  这是靠修复/抠取猜出来的（带 fallback 标记）。引擎照常执行，但会追一条提醒：
    「你的 JSON 没解析成功，我尽量补全了，下次请直接走工具调用」——让模型知道自己出了错、能自愈。

━━━ ⑤ 彻底解析不出：一堆散文，没有可用对象 ━━━
  → 掰不动。引擎收到 null，回模型一条 observation：
    「没识别出工具调用，请直接走 tool-call 通道并给出合法 JSON」
```

## 设计：四手 + 一个标记

### ① 名字别名表 + ② 参数别名表

两张查表。名字表把 `bash → run_shell` 收敛；参数表给每个规范工具声明它认的键 + 每个键的可能别名，
把值搬到规范键上。搬的时候有一条纪律：**只搬"规范键还空着"的情况，绝不覆盖模型填对的**——
模型既填了 `command` 又填了 `cmd` 时，以 `command` 为准，别把它冲掉。

```js
for (const [canonical, aliases] of Object.entries(spec)) {
  if (out[canonical] != null) continue;         // 模型已经填对了，别动
  for (const alias of aliases) {
    if (out[alias] != null) { out[canonical] = out[alias]; delete out[alias]; break; }
  }
}
```

### ③ 截断 JSON 修复：扫一遍，把没关的补上

被砍断的 JSON 与其整条丢弃，不如确定性补完整。扫一遍字符，记两个状态：一个**括号栈**、
一个"**当前是否在字符串里**"（要正确处理转义，`\"` 不算字符串结束）。扫到末尾时，如果还停在
字符串里就补个 `"`，再按栈**逆序**把没配平的 `{` `[` 补成 `}` `]`，然后 `JSON.parse`。补不出返回 null。

演示③里 `{"command":"npx vitest ru` 就这么被补成 `{"command":"npx vitest ru"}`——命令内容可能少了尾巴，
但结构合法、能执行，剩下的交给下面那个标记。

### ④ 从散文里抠对象：先代码围栏，再第一个配平的 `{}`

弱模型爱在正文里写调用。先试 ` ```json ... ``` ` 代码围栏（最规整），再退而求其次找第一个
**配平**的顶层 `{ ... }`（同样用括号栈+字符串态扫，别被字符串里的 `}` 骗了）。演示④就是从
一整段中文解释里，把中间那个 `{"path":"src/config.ts"}` 精确抠了出来。

### ⑤ 最关键的一手：给"猜出来的"打标记

这手我一开始漏了，后来觉得是整层里最重要的。③④都是**猜**——修复和抠取都可能猜歪。所以凡是
不走正路（直接 `JSON.parse` 成功）、而是靠修复/抠取得到的结果，**打一个 fallback 标记**
（一个 `WeakSet` 就够）。引擎看到标记，照常执行，但**追加一条 observation** 告诉模型：
"你的 JSON 没解析成功，我尽量补了，下次请直接走工具调用。"

没有这个标记，一个被你猜歪的参数就**静默执行**掉了——比直接报错更可怕，因为没人知道它错了。
有了标记，模型知道自己出了错、下一轮能自愈。这又回到 s02 那条贯穿全系列的原则：
**报错（和"我不太确定"）是写给模型看的 UI。**

## 接进真实 agent

在 s01 的循环里，模型返回后、派发工具前，插一步 `parseToolCall(rawName, rawArgs)`：拿到 `null`
就回"没识别出工具调用"让它重发；拿到结果就正常派发，但如果 `wasJsonParseFallback` 为真，
就在这次工具 observation 后**多挂一条提醒**。循环主体一个字不用改——所有脏活都关在这层适配器里。

## 真实产品对照

本章对应 Reina 的 `packages/providers/src/tool-compat.ts`：`normalizeToolName` + `toolAliases`
管名字，`normalizeToolInput` / `pickFields` 管参数别名，`parseToolJson` 里的 `repairTruncatedJson`
（补悬空字符串 + 逆序配平括号）和 `extractEmbeddedObject`（代码围栏 + 配平扫描）管残缺 JSON，
那个"猜出来的"标记是个 `WeakSet`（`wasJsonParseFallback`）——和本章一一对应。相邻的
`tool-pairing.ts` 还处理另一类脏活：把流式吐出来的 tool_call 分片按 id 重新配对拼回完整调用。

为什么值得单开一层？因为 Reina 的 provider 抽象要同时驱动 OpenAI 和 Anthropic 两套 API、
底下又挂着十来个各家兼容后端。核心循环要保持 provider 中立，就必须把"这个后端 JSON 吐得脏"
这类差异**全部拦在边界上**，不让它渗进引擎。Claude Code 也做类似的事——它对模型返回的
tool input 做校验和修复，schema 对不上时给模型结构化的报错让它重试，而不是直接崩。

## 动手挑战

1. 给 `repairTruncatedJson` 喂几个更刁钻的截断：`{"a":[1,2,` （数组没关）、`{"a":"b\` （末尾一个孤立反斜杠）、
   `{"a":{"b":` （嵌套一半）。哪些补对了？哪些补出了非法 JSON 返回 null？想想"补出一个看似合法但语义错的
   对象"和"老实返回 null"哪个危害大——这决定了修复器应该多激进。
2. 现在 fallback 标记只是"提醒一下"。改成**分级**：截断修复（③，多半只丢了尾巴）风险低，照常执行只提醒；
   从散文抠取（④，可能抠错对象）风险高，改成走一次 `ask`（s13 的审批）让用户确认再执行。同一个标记，
   两种处置——你会怎么给标记加上"我有多不确定"这个维度？

---

| [← 上一章：权限与审批](../s13_permissions/README.md) | [目录](../README.md) | [下一章：渐进式工具披露 →](../s15_tool_disclosure/README.md) |
|---|---|---|
