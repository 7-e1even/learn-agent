# s03 · 别让它空转：循环预算与自动纠偏

> **格言：勤奋的 agent 给续期，失控的 agent 摁暂停——先纠偏，再熔断。**

## 你的 agent 早晚会遇到这一晚

s01 的循环有一个没人第一时间注意到的性质：**它是 `while (true)`，退出条件掌握在模型手里**。模型不喊停，循环就不停。

于是总有一天你会看到这样的账单现场：你让 agent "修一下这个测试"，它跑了一次失败，改了一行，又跑，又失败，又把刚才那行改回去，又跑……你去泡了杯茶，回来发现它已经这样干了 40 分钟，烧掉了几百万 token，测试还是红的。

模型不是故意的。它每一轮都"真诚地"认为下一次会成功。但站在外面看，它有三种典型的失控姿势：

| 失控模式 | 长什么样 | 本质 |
|---|---|---|
| **复读机** | 一模一样的命令跑了 8 遍 | 卡在同一个想法里出不来 |
| **连环报错** | 每一轮的工具全在报错，还在换着花样试 | 撞墙了但不肯承认 |
| **原地踏步** | 动作不重复、也不报错，但全是读读读，世界没有任何变化 | 看起来很忙，其实在逛 |

裸的 `while (true)` 对这三种情况毫无防御。本章给循环装上**看门狗**。

## 先跑演示（不需要 API key）

```sh
node s03_loop_budget/demo.mjs
```

四个剧本 agent 分别演示三种失控被摁停、以及勤奋 agent 拿到续期。输出长这样：

```
━━━ 场景一：复读机（同一动作反复执行） ━━━
  第 1 轮：run_shell({"command":"grep -r TODO ."})  [预算 1/6]
  ...
  第 4 轮：run_shell({"command":"grep -r TODO ."})  [预算 4/6]
  🟡 可纠偏暂停：同一个工具动作被反复执行，暂停。（reason=repeated_action）

━━━ 场景四：勤奋 agent（有进展就续期，直到硬顶） ━━━
  第 3 轮：edit_file(...)  [预算 3/6]
  第 4 轮：edit_file(...)  [预算 4/12]   ← 续期发生在这里
  ...
  第 25 轮：⛔ 达到硬性上限，强制停止。（reason=hard_max_steps）
```

## 设计：四个关键决定

看门狗的完整实现在 [loop-budget.mjs](./loop-budget.mjs)，不到 150 行。它是从真实产品 Reina 的 `loop-budget.ts` 简化移植的，机制一致。四个设计决定值得展开：

![循环预算用软预算续期、纠偏 prompt 和硬顶控制失控循环](../assets/s03-loop-budget.svg)

### ① 预算是软的：有进展就续期

一刀切的"最多 20 轮"是坏设计——重构任务正干到一半被拦腰砍断，用户体验极差。正确形状是**软预算 + 硬顶**：

```js
// 有进展、且预算只剩 2 轮 → 再给一份 baseSteps（封顶 hardMax = 4 倍）
if (hasProgress && this.turns >= this.budget - 2 && this.budget < this.hardMaxSteps) {
  this.budget = Math.min(this.hardMaxSteps, this.budget + this.baseSteps);
}
```

勤奋的 agent 不受惩罚，失控的 agent 也不可能无限烧钱——硬顶是最后的兜底。

### ② 什么算"进展"？写操作算，重复读不算

```js
function isProgress(record, actionCount) {
  if (record.status !== "completed") return false;
  if (["write_file", "edit_file"].includes(record.name)) return true; // 写 = 永远算
  return Boolean(record.output?.trim()) && actionCount === 1;         // 读 = 只有第一次算
}
```

这个启发式很粗，但方向精确：**改变了世界的动作才是进展**。写文件改变了世界；第一次读到新信息也勉强算（认知变了）；第二次跑同一条命令、读同一个文件——世界没变，你也早知道结果了，不算。

### ③ 动作指纹：识别"同一个动作"要做稳定序列化

复读机探测靠给每个动作记指纹：

```js
const key = `${record.name}:${stableStringify(record.input)}`;
```

注意是 `stableStringify`（key 排序后再序列化），不是裸 `JSON.stringify`——模型两次生成的参数对象字段顺序可能不同（`{a,b}` vs `{b,a}`），语义上是同一个动作，裸 stringify 会把它们当成两个，复读机探测直接失效。**这种一行的细节，就是玩具和产品的差距。**

### ④ 熔断不是死刑：先给一次纠偏机会

看门狗触发后最粗暴的做法是直接停。但三种行为异常（复读/停滞/连环报错）往往只是模型钻了牛角尖——它缺的不是能力，是**外部视角**。所以真实产品的做法是先注入一条"纠偏 prompt"：

```
自动纠偏触发：同一个工具动作被反复执行，暂停。
循环状态：原因=repeated_action，已用 9 轮，预算 12，硬顶 48。
不要再重复同样的工具调用或失败的命令。先总结目前发生了什么、找出卡点，
换一条不同的路。如果任务被阻塞或有歧义，向用户提一个具体的问题，而不是继续空转。
```

这条 prompt 的三段结构都有讲究：**说清发生了什么**（模型自己意识不到在复读）、**给出禁止项**（别再重复）、**给出出路**（换路，或者问用户）。注入之后模型经常真的能跳出来——就像人被同事拍一下肩膀："你这个命令已经跑四遍了。"

纠偏只给一次。再次熔断，或预算真正耗尽（`max_steps` / `hard_max_steps`），就停止本轮、把话筒交还用户——此时该由人来决定，而不是继续烧钱。

## 接进你的 agent

[agent.mjs](./agent.mjs) 是 s02 的 agent + 看门狗，主循环的全部变化：

```js
async function runTurn(messages) {
  const budget = new LoopBudget({ baseSteps: 12 });
  let repaired = false;
  while (true) {
    if (!budget.canContinue()) { /* 预算耗尽 → 停止 */ }

    const msg = await chat(messages);
    // ...执行工具，同时收集 records: [{ name, input, status }]

    const stop = budget.recordTurn(records);
    if (!stop) continue;
    if (isRecoverable(stop) && !repaired) {
      repaired = true;
      messages.push({ role: "user", content: repairPrompt(stop) }); // 拍肩膀
      continue;
    }
    return; // 纠偏用过了还熔断 → 交还用户
  }
}
```

循环的骨架没变——看门狗是**挂**在循环上的，不是写进循环里的。

## 真实产品对照

本章机制原样对应 Reina 的 `packages/core/src/loop-budget.ts`（生产阈值：停滞 8 轮、重复动作 10 次、连续报错 5 轮，均可用环境变量覆盖；预算耗尽时最新的工具结果会被完整保留进下一轮，避免"停下来"变成"忘了刚才干了啥"）。Claude Code 里你偶尔看到的 "Paused after several tool turns without new progress" 同款提示，背后就是这类机制。

另外注意一个分工：本章的看门狗管的是**行为失控**（转圈）。还有一类失控是**物理卡死**——工具进程 hang 住、模型流断了，循环根本转不动，行为探测器永远等不到下一轮。那要靠另一条看门狗（心跳 + 超时 + 击杀前抢救遗言），在 s09 子代理章登场。

## 动手挑战

1. 给 `isProgress` 加一条规则：`run_shell` 跑 `git commit` 这类明确改变世界的命令，即使是第二次也算进展。想想怎么判定"改变世界的命令"（提示：白名单前缀就够了，别过度设计）。
2. 思考题：纠偏 prompt 是以 `role: "user"` 注入的——模型会把它当成用户说的话。有什么副作用？如果换成 system 消息或 tool 消息，各有什么问题？（这个问题没有标准答案，真实产品各有取舍。）

---

| [← 上一章：工具箱与调度](../s02_tool_system/README.md) | [目录](../README.md) | [下一章：工具输出预算与无损溢出 →](../s04_output_budget/README.md) |
|---|---|---|
