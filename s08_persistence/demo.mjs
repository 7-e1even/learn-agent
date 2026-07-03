#!/usr/bin/env node
// 不需要 API key 的落盘演示：在临时目录里真写 JSONL、真模拟崩溃、真重放。
//
//   node s08_persistence/demo.mjs
//
// 三个场景：
//   一、"每次全量重写 JSON"在崩溃时留下半个文件 —— 整个会话报废
//   二、追加式事件日志：写几个事件 → 重放 → 重建出 messages 和会话配置
//   三、最后一行写了一半（撕裂写入）—— 跳过那一行，会话照常恢复

import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, createSession, replaySession, sessionPath } from "./store.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "s08-demo-"));

// ─── 场景一：全量重写 + 崩溃 = 半个文件 ─────────────────────────────────

console.log("━━━ 场景一：全量重写 JSON，崩溃在写到一半时 ━━━");

const snapshot = {
  id: "ses_snapshot",
  model: "deepseek-chat",
  messages: [
    { role: "user", content: "帮我修一下登录页的报错" },
    { role: "assistant", content: "我先看看代码。" },
  ],
};
const full = JSON.stringify(snapshot, null, 2);
// 模拟崩溃：写盘写到 60% 时断电 —— 磁盘上只有前 60% 的字节。
const torn = full.slice(0, Math.floor(full.length * 0.6));
const snapPath = path.join(dir, "session.json");
writeFileSync(snapPath, torn);
console.log(`  磁盘上留下 ${torn.length}/${full.length} 字节的 session.json，尝试恢复：`);
try {
  JSON.parse(readFileSync(snapPath, "utf8"));
  console.log("  （不可能走到这里）");
} catch (err) {
  console.log(`  ✗ JSON.parse 失败：${err.message.split("\n")[0]}`);
  console.log("  ✗ 整个会话报废 —— 不止最后一条消息，之前的历史也一起没了。");
}

// ─── 场景二：追加式事件日志 → 重放重建 ──────────────────────────────────

console.log("\n━━━ 场景二：追加式事件日志（JSONL）→ 重放重建 ━━━");

const meta = createSession(dir, { model: "deepseek-chat" });
appendEvent(dir, meta.id, { type: "message", message: { role: "user", content: "帮我修一下登录页的报错" } });
appendEvent(dir, meta.id, {
  type: "message",
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"login.js"}' } }],
  },
});
appendEvent(dir, meta.id, {
  type: "tool_call",
  record: { id: "call_1", name: "read_file", input: { path: "login.js" }, status: "completed" },
});
appendEvent(dir, meta.id, { type: "message", message: { role: "tool", tool_call_id: "call_1", content: "   1\tconst token = nul;" } });
appendEvent(dir, meta.id, { type: "message", message: { role: "assistant", content: "找到了：nul 是笔误，应该是 null。" } });

const restored = replaySession(dir, meta.id);
console.log(`  重放 ${sessionPath(dir, meta.id)}：`);
console.log(`  模型 = ${restored.meta.model}（来自 session_meta，不是恢复时的默认值）`);
console.log(`  重建出 ${restored.messages.length} 条消息：`);
for (const m of restored.messages) {
  const body = m.content ?? `<调用 ${m.tool_calls?.map((c) => c.function.name).join("、")}>`;
  console.log(`    [${m.role}] ${body}`);
}
console.log(`  工具调用记录：${restored.toolCalls.map((r) => `${r.name}(${r.status})`).join("、")} ← 结构化 status，不用再解析报错文案`);

// ─── 场景三：最后一行撕裂 —— 丢一行，不丢会话 ───────────────────────────

console.log("\n━━━ 场景三：崩溃把最后一行写了一半 ━━━");

// 模拟崩溃：一条正常事件只落了前半截字节（没有换行、JSON 没闭合）。
const half = JSON.stringify({ ts: new Date().toISOString(), type: "message", message: { role: "user", content: "再帮我加个记住密码" } });
appendFileSync(sessionPath(dir, meta.id), half.slice(0, Math.floor(half.length / 2)));
console.log(`  往同一个 .jsonl 追加了半行（${Math.floor(half.length / 2)}/${half.length} 字节），再次重放：`);

const again = replaySession(dir, meta.id);
console.log(`  ✓ 恢复出 ${again.messages.length} 条消息，跳过 ${again.skipped} 行损坏数据`);
console.log(`  ✓ 只丢了崩溃瞬间那一条，之前的全部历史完好。`);

console.log(`
结论：
  · 全量重写 JSON：崩在写盘中间 = 新旧两份都没了，恢复无从谈起。
  · 追加式 JSONL：已写下的字节永远不被触碰，崩溃的爆炸半径被压缩到"最后一行"。
  · 恢复 = 重放：状态是从事件流里推出来的，会话配置（模型）也在流里，一起回来。
（演示文件在 ${dir}，可以 cat 看看每一行长什么样。）
`);
