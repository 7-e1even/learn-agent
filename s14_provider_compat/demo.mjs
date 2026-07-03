#!/usr/bin/env node
// s14 免 key 演示 —— 五种"模型把 tool call 吐歪"的现场，确定性掰回规范形状。
//   名字叫错 / 参数键写歪 / JSON 截断 / 裹在散文里 / 彻底解析不出（打 fallback 标记）
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
    title: "③ JSON 截断：max_tokens 砍在半路，引号括号都没关",
    name: "run_shell",
    args: '{"command":"npx vitest ru',
  },
  {
    title: "④ 不走 tool 通道：把调用裹在 ```json 代码块里",
    name: "run_shell",
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

console.log("要点：这层全在 provider 边界，循环里只见干净的 { name, input }。");
console.log("      最关键的不是'能修'，是修完打标记——静默执行一个猜歪的参数，比报错更危险。");
