#!/usr/bin/env node
// 不需要 API key 的溢出演示：伪造三种"大输出"现场，亲眼看
// 单条溢出、整轮预算（largest-first）、日志压缩分别怎么工作。
//
//   node s04_output_budget/demo.mjs
//
// 会在当前目录下生成 .agent-spill/（真实 agent 的落盘目录，看完可删）。

import { DEFAULTS, spillOne, enforceTurnBudget, compressLog } from "./spill.mjs";

console.log(`预算：单条 ${DEFAULTS.perResult} 字符 / 整轮 ${DEFAULTS.turnTotal} 字符 / 节选 ${DEFAULTS.preview} 字符`);

// ─── 场景一：一条 cat 灌出 2MB ───────────────────────────────────────────

console.log("\n━━━ 场景一：单条 2MB 输出（模拟 cat 大文件）━━━");
let big = "";
for (let i = 1; big.length < 2 * 1024 * 1024; i++) {
  big += `row ${i}: id=${i * 7} name=user_${i} email=user_${i}@example.com status=active\n`;
}
const one = spillOne(big);
console.log(`  原始输出：${big.length} 字符`);
console.log(`  回给模型：${one.content.length} 字符（压到 ${((one.content.length / big.length) * 100).toFixed(2)}%）`);
console.log(`  落盘全文：${one.file}`);
console.log("  节选的收尾部分（模型看到的）：");
for (const line of one.content.split("\n").slice(-4)) console.log(`    ${line}`);

// ─── 场景二：整轮预算，从最大的开始溢出 ─────────────────────────────────

console.log("\n━━━ 场景二：一轮 4 条输出合谋超总量（largest-first 溢出）━━━");
const fake = (tag, chars) => `${tag} `.repeat(Math.ceil(chars / (tag.length + 1))).slice(0, chars);
const records = [
  { name: "run_shell(git log)", output: fake("commit", 60_000), spillable: true },
  { name: "run_shell(grep -r)", output: fake("match", 30_000), spillable: true },
  { name: "run_shell(ls -laR)", output: fake("file", 30_000), spillable: true },
  { name: "read_file(src/app.js)", output: fake("line", 30_000), spillable: false }, // 文件自己就是指针
];
const beforeSizes = records.map((r) => r.output.length);
const round = enforceTurnBudget(records);
console.log(`  整轮总量：${round.before} → ${round.after} 字符（预算 ${DEFAULTS.turnTotal}）`);
records.forEach((r, i) => {
  const changed = r.output.length !== beforeSizes[i];
  console.log(
    `  ${changed ? "⤵ 溢出" : "· 保留"}  ${r.name}：${beforeSizes[i]} → ${r.output.length} 字符` +
      (r.spillable === false ? "（read_file 不落盘副本，自带 offset/limit）" : ""),
  );
});

// ─── 场景三：测试日志先压缩再计预算 ─────────────────────────────────────

console.log("\n━━━ 场景三：vitest 风格日志的重要性压缩 ━━━");
const log = [];
log.push(" RUN  v1.6.0 /work/demo", "");
for (let f = 1; f <= 24; f++) {
  for (let c = 1; c <= 8; c++) log.push(` ✓ src/mod${f}.test.ts > case ${c} (${c + 1}ms)`);
}
log.push(
  " FAIL  src/billing.test.ts > charges the right amount",
  " AssertionError: expected 1099 to be 999",
  "     at src/billing.test.ts:42:15",
  "     at processTicksAndRejections (node:internal/process/task_queues:95:5)",
);
for (let f = 25; f <= 48; f++) {
  for (let c = 1; c <= 8; c++) log.push(` ✓ src/mod${f}.test.ts > case ${c} (${c + 1}ms)`);
}
log.push("", " Test Files  1 failed | 48 passed", " Tests  1 failed | 384 passed", " Duration  4.21s");
const raw = log.join("\n");
const packed = compressLog(raw);
console.log(`  ${packed.inputLines} 行 → ${packed.outputLines} 行，省 ${(packed.savings * 100).toFixed(1)}%（错误行一行没丢）`);
console.log("  压缩后的中段（FAIL 块完整幸存）：");
const kept = packed.content.split("\n");
const failAt = kept.findIndex((l) => l.includes("FAIL"));
for (const line of kept.slice(Math.max(0, failAt - 1), failAt + 5)) console.log(`    ${line}`);

console.log(`
结论：
  · 截断是有损的，溢出是无损的 —— 场景一里 2MB 只回给模型 ${one.content.length} 字符，
    但一个字都没丢：全文躺在 ${one.file}，read_file 一次就能取回任何一段。
  · 预算要两层：单条上限接不住"十条中等输出合谋爆窗"，所以整轮总量超标时
    从最大的开始溢出，够了就收手（场景二只溢出了 1 条）。
  · 日志先压缩再计预算：噪声行折叠、错误行和堆栈完整保留（场景三），
    折叠发生时全文同样落盘 —— 压缩链路整体依然无损。
`);
