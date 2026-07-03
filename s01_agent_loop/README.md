# s01 · 一个循环，一双手

> **格言：Agent 和 chatbot 的全部区别，是一个 `while` 循环。**

## 先说人话：agent 到底是什么

你用过 ChatGPT：你说一句，它答一句，结束。这叫 **chatbot**。

你可能也见过 Claude Code：你说"帮我修这个 bug"，它自己去读文件、跑测试、改代码、再跑测试，十几分钟后回来说"修好了"。这叫 **agent**。

它们的区别听起来很玄——"自主性"、"智能体"、"任务规划"——但你今天会亲眼看到，剥掉所有包装之后，区别只有一个：

```
chatbot:  用户说 → 模型答 → 结束
agent:    用户说 → 模型答"我要先看看" → 代码替它执行 → 把结果喂回去
          → 模型再看 → ……如此循环 → 直到模型自己说"我说完了"
```

**决定循环继续还是停止的，是模型，不是代码。** 代码唯一的工作：模型要用工具，就执行，然后把结果原封不动递回去。这就是"自主"的最小实现——Claude Code、Codex，所有 coding agent 的主循环在拓扑上都是这一个。

![agent 循环和 chatbot 的区别](../assets/s01-agent-loop.svg)

本章我们用**约 120 行、零依赖**的 Node 写出它。写完你可以直接跟它说话，它有一双手（能跑 shell 命令），会自己决定什么时候用。

## 跑起来

```sh
# 任何 OpenAI 兼容的 key 都行：DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama
AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs

# 换模型：
AGENT_BASE_URL=https://api.moonshot.cn/v1 AGENT_MODEL=kimi-k2-0711-preview AGENT_API_KEY=sk-xxx node s01_agent_loop/agent.mjs
```

跑起来之后，对它说：**"看看当前目录，猜猜这是个什么项目"**。你会看到一行黄色的 `$ dir`（或 `$ ls`）闪过——那是模型自己决定伸手了。

## 代码走读

整个文件只有四块。

### ① 工具：agent 的手

```js
const TOOLS = [{
  type: "function",
  function: {
    name: "run_shell",
    description: "在用户的终端里执行一条 shell 命令，返回 stdout 和 stderr。",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令" } },
      required: ["command"],
    },
  },
}];
```

这段 JSON 是写给**模型**看的说明书。模型读了 `description`，才知道自己有一双叫 `run_shell` 的手，以及怎么伸（参数格式）。v01 只给一双手，因为 shell 几乎万能：能跑命令就能读文件、写文件、查环境、跑测试——"Bash is all you need"。

System prompt 里有个容易被忽略的细节：

```js
const SYSTEM = `...
当前目录：${process.cwd()}
操作系统：${process.platform}`;
```

**把 cwd 和平台放进 system prompt，是所有真实 agent 都做的事。** 模型不知道自己站在哪台机器的哪个目录里，就会瞎猜路径、在 Windows 上跑 `ls`。这两行是 agent 的"本体感"。

### ② runShell：失败不是事故，是信息

```js
function runShell(command) {
  try {
    return execSync(command, { encoding: "utf8", timeout: 30_000, ... });
  } catch (err) {
    // 关键原则：不抛异常，把错误文本 return 回去
    return `命令失败（exit ${err.status}）：\n${err.stdout ?? ""}${err.stderr ?? err.message}`;
  }
}
```

新手最容易写错的地方：命令失败就抛异常、进程崩溃。但对 agent 来说，**工具失败不是事故，是信息**。模型看到"命令失败：'ls' 不是内部或外部命令"，下一轮会自己改用 `dir`——你把报错喂回去，它自己改道。这个原则贯穿整套笔记：错误永远流向模型，而不是打死进程。

### ③ chat()：所谓"底层"就是一个 POST

```js
async function chat(messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
    }),
  });
  const data = await res.json();
  return data.choices[0].message;
}
```

没有 SDK，没有框架，没有魔法。agent 框架的"底层"就是一个裸 `fetch`。

### ④ runTurn()：全篇的灵魂

```js
async function runTurn(messages) {
  while (true) {
    const msg = await chat(messages);
    messages.push(msg);

    if (msg.content) console.log(`\n${msg.content}`);
    if (!msg.tool_calls?.length) return;   // 模型不再要工具 => 这一轮结束

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      const output = call.function.name === "run_shell"
        ? runShell(args.command ?? "")
        : `未知工具：${call.function.name}`;
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
}
```

逐行读一遍这个 `while`，你就读懂了所有 coding agent：

1. 问模型一次；
2. 模型的回复里带 `tool_calls`？——执行每一个，把结果以 `role: "tool"` 的消息回填进 `messages`，**回到第 1 步**；
3. 不带？——模型认为话说完了，把话筒交还用户。

注意两个真实世界的细节：`content` 和 `tool_calls` **可能同时存在**（模型边说"我来看看目录"边伸手），所以 content 要打印；`function.arguments` 是 JSON **字符串**不是对象，要 parse，而且 parse 失败也要回填错误而不是崩溃（劣质网络下模型真的会吐出半截 JSON）。

### 最后是记忆

```js
const messages = [];
while (true) {
  const line = await rl.question("\n你> ");
  messages.push({ role: "user", content: line });
  await runTurn(messages);
}
```

`messages` 数组就是 agent 的**全部记忆**。它只增不减，每问一次模型都要把它完整发过去。现在它还小，无所谓——但记住这句话：**这个数组会一直长大**。这一套笔记 s04（输出预算）、s06（压缩）、s07（cache 命中）的所有麻烦和所有精彩，全都从"这个数组会一直长大"里来。

## 真实产品对照

- 这 120 行和 Claude Code 的主循环**在拓扑上是同一个东西**。真实产品多出来的几万行，都花在这个循环的"周边"：工具更多更可靠（s02）、不空转（s03）、上下文不爆（s04/s06）、便宜（s07）、断了能接上（s08）、能分身（s09）。循环本身，从 s01 到最后一章，一行都不会再改。
- 桌面 agent [Reina](https://github.com/Reina-Agent/Reina) 的引擎（`runTurn`）也是这个循环。它的 system prompt 同样以 cwd + 平台开头——所有 agent 的"本体感"都长一样。

## 动手挑战

给 agent 加第二个工具 `current_time`（返回当前时间字符串）。提示：TOOLS 数组加一项 + 执行分支加一个 `if`。

做完你会发现：**加一个工具要改两个地方，好烦**。这个烦躁是故意的——它就是下一章工具注册表存在的理由。

---

| ← 上一章 | [目录](../README.md) | [下一章：工具箱与调度 →](../s02_tool_system/README.md) |
|---|---|---|
