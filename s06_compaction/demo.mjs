#!/usr/bin/env node
// s06 免 key 演示 —— 伪造一段长对话，看压缩器怎么做决定：
//   场景一：触发判定（信 usage，不信估算）
//   场景二：切片决策 + 结构化摘要（摘要模型用替身，不调 API）
//   场景三：摘要调用失败 → 提取式降级，会话不陪葬
//
// 运行：node s06_compaction/demo.mjs

import { shouldCompact, compactSplitIndex, compactMessages } from "./compaction.mjs";

// ─── 伪造一段长会话 ──────────────────────────────────────────────────────
// 形状刻意贴近真实：先有一段"上一个任务"的往返，然后用户发出当前任务
// （启动消息），后面跟一长串 assistant(tool_calls) / tool 交替。

const LAUNCH = "帮我把 utils/date.js 里的 formatDate 改成支持时区参数 tz，默认 UTC；改完跑 npm test，把挂掉的用例也修好。";

let seq = 0;
function toolRound(name, args, output) {
  const id = `c${++seq}`;
  return [
    { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content: output },
  ];
}

const messages = [
  // ── 上一个任务：已经完结，是最该被压缩的部分 ──
  { role: "user", content: "这个仓库的测试是怎么组织的？大概讲讲。" },
  ...toolRound("run_shell", { command: "ls tests" }, "date.test.js\nhttp.test.js\nutils.test.js\n" + "fixture-….json\n".repeat(40)),
  ...toolRound("read_file", { path: "package.json" }, '  1\t{ "scripts": { "test": "node --test tests/" } }\n' + "  …\n".repeat(50)),
  { role: "assistant", content: "测试用 node --test 跑 tests/ 目录，按模块分文件，fixture 放同目录 JSON。……（此处省略三段介绍）" },
  // ── 当前任务：启动消息 + 10 轮工具往返 ──
  { role: "user", content: LAUNCH },
  ...toolRound("run_shell", { command: "rg -n formatDate src utils" }, "utils/date.js:12: export function formatDate(ts) {\ntests/date.test.js:8: formatDate(0)"),
  ...toolRound("read_file", { path: "utils/date.js" }, "  12\texport function formatDate(ts) {\n  13\t  return new Date(ts).toISOString().slice(0, 10);\n" + "  …\n".repeat(60)),
  ...toolRound("read_file", { path: "tests/date.test.js" }, "   8\tassert.equal(formatDate(0), '1970-01-01');\n" + "  …\n".repeat(40)),
  ...toolRound("edit_file", { path: "utils/date.js", old_string: "function formatDate(ts) {", new_string: "function formatDate(ts, tz = 'UTC') {" }, "已编辑 utils/date.js"),
  ...toolRound("run_shell", { command: "npm test" }, "FAIL tests/date.test.js\n  ✕ formats with timezone (invalid tz)\n" + "    at …\n".repeat(30)),
  ...toolRound("read_file", { path: "utils/date.js" }, "  12\texport function formatDate(ts, tz = 'UTC') {\n" + "  …\n".repeat(60)),
  ...toolRound("edit_file", { path: "utils/date.js", old_string: "toISOString().slice(0, 10)", new_string: "new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d)" }, "已编辑 utils/date.js"),
  ...toolRound("run_shell", { command: "npm test" }, "FAIL tests/date.test.js\n  ✕ legacy format (expected '1970-01-01', got '1970-01-01,')\n" + "    at …\n".repeat(30)),
  ...toolRound("edit_file", { path: "tests/date.test.js", old_string: "formatDate(0)", new_string: "formatDate(0, 'UTC')" }, "已编辑 tests/date.test.js"),
  ...toolRound("run_shell", { command: "npm test" }, "PASS tests/date.test.js (12 tests)\n" + "  ✓ …\n".repeat(12)),
];

const LAUNCH_IDX = messages.findIndex((m) => m.content === LAUNCH);

const preview = (m) =>
  m.role === "assistant" && m.tool_calls?.length
    ? `assistant → ${m.tool_calls[0].function.name}(${m.tool_calls[0].function.arguments.slice(0, 40)}…)`
    : `${m.role.padEnd(9)} ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 50)}…`;

// ─── 场景一：触发判定 ────────────────────────────────────────────────────

console.log("━━━ 场景一：触发判定（usage 对照 128k 窗口，阈值 75%） ━━━");
for (const usage of [
  { prompt_tokens: 58_000, completion_tokens: 1_200, total_tokens: 59_200 },
  { prompt_tokens: 98_400, completion_tokens: 1_800, total_tokens: 100_200 },
]) {
  const d = shouldCompact({ usage, contextWindow: 128_000, triggerPercent: 75, messageCount: messages.length });
  console.log(`  usage.total_tokens=${usage.total_tokens} → ${d.compact ? "🗜️ 触发压缩" : "✅ 不压"}：${d.why}`);
}

// ─── 场景二：切片决策 + 假摘要 ───────────────────────────────────────────

console.log("\n━━━ 场景二：切片决策（保什么 / 压什么 / 启动消息逐字保留） ━━━");
const naive = messages.length - 8;
const keepFrom = compactSplitIndex(messages, { keepRecent: 8 });
console.log(`  共 ${messages.length} 条消息。只看"尾部保底 8 条"，该从第 ${naive} 条切——`);
console.log(`  但那样启动任务的用户消息（第 ${LAUNCH_IDX} 条）就会被摘要转述掉。`);
console.log(`  分割点回拉到最后一条真实用户消息：实际 keepFrom = ${keepFrom}。逐条判决：`);
messages.forEach((m, i) => {
  const mark = i < keepFrom ? "🗜️ 压缩" : i === LAUNCH_IDX ? "📌 保留 ←启动消息，逐字" : "📌 保留";
  console.log(`    [${String(i).padStart(2)}] ${mark}  ${preview(m)}`);
});

// 摘要模型替身：真实实现是一次不带 tools 的 API 调用（见 agent.mjs）。
const fakeSummarize = async () =>
  [
    "1. 任务目标：用户原话——\"这个仓库的测试是怎么组织的？大概讲讲。\"（该任务已完成并已回答）",
    "2. 已完成：确认测试用 node --test 跑 tests/ 目录，按模块分文件。",
    "3. 未完成：无（此段落只覆盖被压缩的旧任务）。",
    "4. 涉及文件与命令：package.json、tests/；ls tests。",
    "5. 关键决定与坑：无。",
  ].join("\n");

const ok = await compactMessages(messages, { summarize: fakeSummarize, keepRecent: 8 });
console.log(`\n  压缩完成：${messages.length} 条 → ${ok.messages.length} 条（压掉 ${ok.dropped} 条，降级=${ok.degraded}）`);
console.log("  压缩后的消息形状：");
console.log(`    [0] 摘要消息（role=user）: ${ok.messages[0].content.replace(/\s+/g, " ").slice(0, 56)}…`);
console.log(`    [1] ${preview(ok.messages[1])}   ← 启动消息，一字未动`);
console.log(`    [2..${ok.messages.length - 1}] 当前任务的全部工具往返，原样保留`);

console.log("\n  —— 回拉不是无限的：把上限压到 1000 字符再切一次 ——");
const bounded = compactSplitIndex(messages, { keepRecent: 8, maxAnchorChars: 1000 });
console.log(`  当前任务的历史超出上限，放弃回拉，keepFrom = ${bounded}（启动消息进了压缩区）。`);
console.log("  此时兜底的是摘要 prompt 第 1 栏：\"逐字引用用户原话，禁止转述\"。");

// ─── 场景三：摘要失败 → 降级 ────────────────────────────────────────────

console.log("\n━━━ 场景三：摘要模型挂了（超时/限流），压缩绝不能毁掉会话 ━━━");
const fallback = await compactMessages(messages, {
  summarize: async () => { throw new Error("429 rate limited"); },
  keepRecent: 8,
});
console.log(`  摘要调用抛出 429 → 自动降级为提取式摘要（degraded=${fallback.degraded}），会话照常继续。`);
console.log("  降级摘要节选：");
for (const line of fallback.summary.split("\n").slice(0, 5)) console.log(`    ${line}`);
console.log(`    …（共 ${fallback.summary.split("\n").length} 行）`);
