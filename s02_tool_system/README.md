# s02 · 工具箱与调度

> **格言：加一个工具，只加一个条目——循环永不再改。**

## 从上一章的烦躁说起

s01 的挑战题让你痛过了：加一个 `current_time` 要改两个地方（TOOLS 数组 + 执行分支）。工具一多，这两处必然失配——你会在 TOOLS 里声明了工具却忘了写分支，模型信心满满地调用，得到一句"未知工具"。

解法是把工具收拢成**注册表**：

```js
const REGISTRY = {
  run_shell: {
    description: "在用户的终端里执行一条 shell 命令……",
    parameters: { type: "object", properties: { command: {...} }, required: ["command"] },
    handler: ({ command }) => { ... },
  },
  read_file:  { description, parameters, handler },
  write_file: { description, parameters, handler },
  edit_file:  { description, parameters, handler },
};
```

每个工具 = 一个条目：**给模型看的说明**（description + parameters）和**给机器执行的实现**（handler），放在一起，永不失配。API 需要的 TOOLS 数组由注册表**生成**：

```js
const TOOLS = Object.entries(REGISTRY).map(([name, t]) => ({
  type: "function",
  function: { name, description: t.description, parameters: t.parameters },
}));
```

这叫**单一事实来源**（single source of truth）。调度也从 if-else 变成查表：

```js
function dispatch(call) {
  const tool = REGISTRY[call.function.name];
  if (!tool) return `未知工具：${call.function.name}`;
  let args;
  try { args = JSON.parse(call.function.arguments || "{}"); }
  catch (err) { return `工具参数不是合法 JSON：${err.message}`; }
  try { return tool.handler(args); }
  catch (err) { return `工具执行出错：${err.message}`; }
}
```

注意 dispatch 把 s01 的"错误即信息"升级成了**系统性约定**：未知工具、坏参数、handler 抛异常——三条失败路径全部变成文本回给模型，任何一条都不允许打死进程。

从此加工具 = 加一个条目。主循环唯一的变化是把 if-else 换成 `dispatch(call)`，之后**永不再改**。真实产品全是这个形状——Claude Code、Codex，包括 Reina 的 `packages/tools/` 目录，本质都是一张注册表。

![工具注册表把模型说明和机器实现放在同一个事实来源里](../assets/s02-tool-registry.svg)

## 为什么要专用文件工具？shell 不是万能吗

理论上万能，实践上让模型拼 `sed -i 's/old/new/' file` 改文件是灾难：引号转义、正则元字符、跨平台差异（Windows 没有 sed）、多行文本——每一个都是雷。**专用文件工具不是语法糖，是可靠性工程。**

### read_file：带行号 + 一个伏笔

```js
const CAP = 50_000;
const body = text.length > CAP ? text.slice(0, CAP) + `\n…(截断，共 ${text.length} 字符)` : text;
return body.split("\n").map((line, i) => `${String(i + 1).padStart(4)}\t${line}`).join("\n");
```

带行号是为了模型能精确引用位置。那个 50KB 硬截断是个**临时创可贴**——如果文件有 2MB 呢？截掉的部分模型永远看不到了，它甚至不知道自己错过了什么。s04 会正面解决这个问题（预算 + 无损溢出），现在先记住这里埋了颗雷。

### edit_file：本章最精彩的细节

```js
handler: ({ path: p, old_string, new_string }) => {
  const text = readFileSync(p, "utf8");
  const first = text.indexOf(old_string);
  if (first === -1)
    return `编辑失败：old_string 在 ${p} 中找不到。请先 read_file 确认原文。`;
  if (text.indexOf(old_string, first + 1) !== -1)
    return `编辑失败：old_string 在 ${p} 中出现多次。请带上更多上下文让它唯一。`;
  writeFileSync(p, text.replace(old_string, new_string));
  return `已编辑 ${p}`;
},
```

`edit_file` 的契约：**old_string 必须在文件中出现且仅出现一次**，否则拒绝执行。这正是 Claude Code 的 Edit 工具真实使用的契约。为什么这样设计？

因为它把"模型脑中的文件"和"磁盘上的文件"**强制对齐**：

- **匹配不到** → 说明模型的记忆过期了（文件被改过，或它根本记错了）→ 报错逼它先去 `read_file` 刷新认知，而不是闭着眼睛改错地方；
- **匹配到多处** → 说明定位有歧义 → 报错逼它带上更多上下文行，精确到唯一。

再看两条报错文案："请先 read_file 确认原文"、"请带上更多上下文让它唯一"——**报错是写给模型看的 UI**。好的报错直接告诉模型下一步动作，模型照做就能自愈；坏的报错（"Error: -1"）只会让它原地打转。

> 有人会问：为什么不用正则替换？因为正则转义是模型的重灾区。字面量匹配 + 唯一性契约，就是比正则可靠——这是各家产品拿生产事故换来的共同结论。

## 跑起来

```sh
AGENT_API_KEY=sk-xxx node s02_tool_system/agent.mjs
```

试两个实验：

1. **组合拳**：对它说"在 demo/ 下建一个 hello.js 打印当前时间，然后把打印内容改成中文，最后跑给我看"。你会看到 `write` → `edit` → `$ node` 三种黄色行依次闪过——一条指令，模型自己编排了三种工具。顺带一提，模型可能在**一条回复里同时发多个 tool_calls**，s01 写的 for 循环早就支持了。
2. **故意为难它**：挑一个文件里出现多次的短语让它替换。观察 edit_file 报"出现多次"、模型自己带上更长的上下文重试成功——唯一匹配契约的现场演示。

## 真实产品对照

- Claude Code 的 Edit 工具契约与本章 `edit_file` 相同（还多一个 `replace_all` 参数处理"我就是要全换"的场景——留给你当思考题）。
- Reina 的工具注册表在 `packages/tools/src/`，每个工具一个文件，形态和本章 REGISTRY 一致；它的 CLAUDE.md 里甚至写着一条铁律："加新工具要注册进 tool registry，不许给引擎类加方法"——注册表一旦建立，就要守住它。
- CRLF 坑：Windows 文件是 `\r\n` 换行，模型给的 old_string 是 `\n`，会匹配不上。真实产品都踩过。最简单的对策是让报错引导模型重试；更彻底的做法留作思考题。

## 动手挑战

加一个 `list_dir` 工具：列出目录内容，标注类型（文件/目录）和大小。

这次你只需要**加一个条目**。写完对比一下 s01 挑战题的体验——这就是注册表的爽点，也是"机制围着循环长，循环不变"的第一次兑现。

---

| [← 上一章：一个循环，一双手](../s01_agent_loop/README.md) | [目录](../README.md) | [下一章：别让它空转 →](../s03_loop_budget/README.md) |
|---|---|---|
