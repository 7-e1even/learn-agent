#!/usr/bin/env node
// 不需要 API key 的流式与中断演示：
//   场景一：把一段 SSE 字节流故意切得支离破碎（掐在 data: 行中间、JSON 中间、
//           多字节字符中间），喂给解析器 + 装配器，看 tool_calls 分片怎么归队。
//   场景二：伪造一串被 Ctrl+C 撕成半截的 messages，跑修复函数，
//           看悬空的 tool_call 怎么被回填、断裂的参数怎么被修好。
//
//   node s05_streaming_interrupt/demo.mjs

import { sseJsonEvents, createAssembler, repairDanglingToolCalls, INTERRUPT_NOTE } from "./stream.mjs";

// ─── 场景一：SSE 分片装配 ────────────────────────────────────────────────

console.log("━━━ 场景一：SSE 分片装配（tool_calls 按 index 归队）━━━");

// 服务端"本来想发"的事件序列：先流两段文本，再交错地流两个工具调用 ——
// call 0 的 arguments 被切成 3 片，中间还插进来 call 1 的分片。
const events = [
  { choices: [{ delta: { role: "assistant" } }] },
  { choices: [{ delta: { content: "我来" } }] },
  { choices: [{ delta: { content: "查一下。" } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_ls", type: "function", function: { name: "run_shell", arguments: "" } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_read", type: "function", function: { name: "read_file", arguments: '{"path":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"a.txt"}' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' -la"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];
const wire = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

// 网络不看语义：整段字节流每 31 字节掐一刀 —— 必然有分片停在 data: 行
// 中间、JSON 字符串中间、甚至"我来"这种多字节字符的字节中间。
const bytes = new TextEncoder().encode(wire);
const chunks = [];
for (let i = 0; i < bytes.length; i += 31) chunks.push(bytes.slice(i, i + 31));
console.log(`  线路上：${events.length + 1} 个事件被切成 ${chunks.length} 个原始分片，比如：`);
const rawPreview = (u8) => JSON.stringify(new TextDecoder("utf-8", { fatal: false }).decode(u8));
console.log(`    分片[0] = ${rawPreview(chunks[0])}`);
console.log(`    分片[1] = ${rawPreview(chunks[1])}`);

async function* fakeBody() {
  for (const chunk of chunks) yield chunk;
}

const assembler = createAssembler();
let live = "";
for await (const event of sseJsonEvents(fakeBody())) {
  live += assembler.feed(event); // 真实 agent 在这里 process.stdout.write，打字机效果
}
const msg = assembler.message();
console.log(`  实时打印的文本：${JSON.stringify(live)}`);
console.log(`  装配出的 tool_calls（arguments 拼完才 parse）：`);
for (const tc of msg.tool_calls) {
  console.log(`    ${tc.id} → ${tc.function.name}(${JSON.stringify(JSON.parse(tc.function.arguments))})`);
}

// ─── 场景二：中断后的消息序列修复 ────────────────────────────────────────

console.log("\n━━━ 场景二：Ctrl+C 撕裂的消息序列，修复后能继续对话 ━━━");

// 复盘一次真实的中断现场：模型发起了两个工具调用，第一个跑完了，
// 用户在第二个开跑前按了 Ctrl+C —— 而且流是被掐断的，第二个调用的
// arguments 断在 JSON 中间。
const messages = [
  { role: "user", content: "把测试跑一遍，顺便看下 README" },
  {
    role: "assistant",
    content: "好，我先跑测试，再看 README。",
    tool_calls: [
      { id: "call_test", type: "function", function: { name: "run_shell", arguments: '{"command":"npm test"}' } },
      { id: "call_read", type: "function", function: { name: "read_file", arguments: '{"path":"READ' } }, // ← 断在半截
    ],
  },
  { role: "tool", tool_call_id: "call_test", content: "命令失败（exit 1）：\n1 test failed" },
  // ← Ctrl+C 落在这里：call_read 没有 tool 结果。这串 messages 直接发出去，
  //   OpenAI 兼容后端一律 400（每个 tool_call 必须跟一条 tool 结果消息）。
];

const shape = (msgs) =>
  msgs
    .map((m) => (m.role === "tool" ? `tool(${m.tool_call_id})` : m.tool_calls ? `assistant+${m.tool_calls.length}calls` : m.role))
    .join(" → ");
console.log(`  修复前：${shape(messages)}`);
console.log(`    悬空：call_read 没有 tool 结果；参数断裂：${JSON.stringify(messages[1].tool_calls[1].function.arguments)}`);

const filled = repairDanglingToolCalls(messages);

console.log(`  修复后：${shape(messages)}（回填 ${filled} 条）`);
console.log(`    合成结果：${JSON.stringify(messages.find((m) => m.tool_call_id === "call_read").content)}`);
console.log(`    参数修复：${JSON.stringify(messages[1].tool_calls[1].function.arguments)}`);
console.log(`  再跑一遍修复（应当无操作、幂等）：回填 ${repairDanglingToolCalls(messages)} 条`);

console.log(`
结论：
  · SSE 分片和事件边界无关 —— 按行缓冲 + TextDecoder(stream) 之后，
    掐在任何位置的分片都能装回原样；tool_calls 靠 index 归队，
    arguments 是碎 JSON 字符串，拼完才能 parse。
  · 中断很容易，中断后还能继续对话才是工程：悬空的 tool_call 回填
    合成结果（"${INTERRUPT_NOTE}"），
    断裂的参数修成 {}，消息序列重新配平 —— 下一句话不会撞上 400。
`);
