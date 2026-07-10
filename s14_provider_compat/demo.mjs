#!/usr/bin/env node
// s14 免 key 演示 —— 五种"模型把 tool call 吐歪"的现场，确定性掰回规范形状；
// 外加一种修复层管不了的：finish_reason=length 的轮次，修好的 JSON 也不能执行。
//   名字叫错 / 参数键写歪 / JSON 截断 / 裹在散文里 / 彻底解析不出（打 fallback 标记）/ length 门
//
// 运行：node s14_provider_compat/demo.mjs

import { parseToolCall, wasJsonParseFallback } from "./tool-compat.mjs";

// 每条：模型吐出来的 (name, arguments) —— arguments 多半是字符串（provider 原样透传）
const CASES = [
  {
    title: "① 名字叫错：bash → run_shell",
    name: "bash",
    args: '{"command":"ls -la"}',
  },
  {
    title: "② 参数键写歪：cmd / shellCommand → command",
    name: "run_shell",
    args: '{"cmd":"npm test","workdir":"/repo"}',
  },
  {
    title: "③ JSON 截断：流式分片丢了尾巴，引号括号都没关",
    name: "run_shell",
    args: '{"command":"npx vitest ru',
  },
  {
    title: "④ 不走 tool 通道：把调用裹在 ```json 代码块里",
    name: "read_file",
    args: '我打算读一下配置：\n```json\n{"path":"src/config.ts"}\n```\n这样能看到默认值。',
  },
  {
    title: "⑤ 彻底解析不出：一堆散文，没有可用对象",
    name: "read_file",
    args: "让我想想应该读哪个文件比较好呢……",
  },
];

for (const c of CASES) {
  console.log(`━━━ ${c.title} ━━━`);
  console.log(`  模型吐出: name=${JSON.stringify(c.name)}  args=${JSON.stringify(c.args)}`);
  const parsed = parseToolCall(c.name, c.args);

  if (parsed == null) {
    console.log("  → 掰不动。引擎收到 null，回模型一条 observation：");
    console.log('    「没识别出工具调用，请直接走 tool-call 通道并给出合法 JSON」');
  } else {
    console.log(`  → 掰成: ${JSON.stringify(parsed)}`);
    if (wasJsonParseFallback(parsed)) {
      console.log("  ⚠️  这是靠修复/抠取猜出来的（带 fallback 标记）。引擎照常执行，但会追一条提醒：");
      console.log('    「你的 JSON 没解析成功，我尽量补全了，下次请直接走工具调用」——让模型知道自己出了错、能自愈。');
    }
  }
  console.log("");
}

// ─── ⑥ 修复的边界：finish_reason=length 时，修好的 JSON 也不能执行 ──────────
// ③修的是"传输层弄丢了尾巴"。一模一样的字节还有另一种病因：模型的生成被
// max_tokens 掐断。修复层只看得见字节，分不出两者——能分清的是 provider，
// 它在 finish_reason 里明说了这轮是 "length" 停止。

console.log("━━━ ⑥ 修复的边界：finish_reason=length，修好的 JSON 也不能执行 ━━━");

const turn = {
  finishReason: "length", // provider 明说：这轮输出撞了 max_tokens
  toolCall: {
    name: "write_file",
    args: '{"path":"src/config.ts","content":"export const config = {\\n  retries: 3,',
  },
};

console.log(`  模型吐出: name="write_file"  args=${JSON.stringify(turn.toolCall.args)}`);
const repaired = parseToolCall(turn.toolCall.name, turn.toolCall.args);
console.log(`  → 修复层照样掰成: ${JSON.stringify(repaired)}`);
console.log("  结构完全合法。如果照③的路子执行：write_file 成功落盘——");
console.log("  src/config.ts 从此只有半个文件，而且没有任何报错。");
console.log("  （对比③：半条 shell 命令会大声报错，模型能自愈；半个文件是静默的。）");
console.log("");
console.log(`  但 provider 说了 finish_reason="${turn.finishReason}"，引擎在派发前按病因拦截：`);
if (turn.finishReason === "length") {
  console.log("  ✋ 本轮所有 tool call 一律拒绝，回 observation：");
  console.log("    「输出撞了 token 上限，参数即使解析成功也可能不完整，请重发完整调用」");
}
console.log("");

console.log("要点：这层全在 provider 边界，循环里只见干净的 { name, input }。");
console.log("      最关键的不是'能修'，是修完打标记——静默执行一个猜歪的参数，比报错更危险。");
console.log("      而标记之上还有一道病因门：length 掐断的轮次，参数修得再干净也不能执行（⑥）。");
