// 工具输出的观测预算与无损溢出 —— 本章的机制模块。
//
// 从真实产品 Reina 简化移植，对应两处生产实现：
//   · packages/core/src/engine.ts 的 enforceTurnObservationBudget
//     （单条上限 + 整轮总量上限，超限的从最大者开始溢出）
//   · packages/tools/src/log-compress.ts 的 compressLogOutput
//     （按"重要性"折叠构建/测试日志：错误行永远保留，噪声行折叠成标记）
//
// 核心原则：截断是有损的，溢出是无损的。
// 超预算的输出完整落盘，回给模型的是"头尾节选 + 指针"——细节永远只差一次 read_file。

import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// 演示尺度的预算（Reina 生产值：单条 100_000 字符、整轮 200_000 字符，
// 小窗口模型按窗口的 15% / 30% 缩放；节选 6_000~16_000 随窗口浮动）。
export const DEFAULTS = {
  perResult: 50_000, // 单条工具输出超过这个字符数 → 必溢出（s02 的 50KB，从截断线变成溢出线）
  turnTotal: 100_000, // 一轮所有工具输出的总量超过这个 → 从最大的开始溢出
  preview: 2_000, // 溢出后回给模型的节选大小（头部为主 + 一小段尾部）
  dir: ".agent-spill", // 落盘目录
};

/** 把一段完整输出落盘，返回相对路径。文件内容是逐字原文 ——
 *  指针文案单独拼在节选里，磁盘上的副本保持干净，模型（和人）都能直接读。 */
export function saveSpill(content, dir = DEFAULTS.dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(file, content, "utf8");
  return file;
}

/** 头尾节选：头部占大头（开头通常是"这是什么"），留一小段尾部
 *  （shell 输出的 exit code / 总结常在结尾）。中间打省略标记。 */
export function excerpt(text, cap = DEFAULTS.preview) {
  if (text.length <= cap) return text;
  const tailLen = Math.min(200, Math.floor(cap / 4));
  return `${text.slice(0, cap - tailLen)}\n… [中间省略 ${text.length - cap} 字符] …\n${text.slice(-tailLen)}`;
}

/** 单条溢出：全文落盘，返回可以直接回给模型的"节选 + 指针"。
 *  指针的三要素：全文在哪、有多大、怎么分段取 —— 缺一个模型就用不起来。 */
export function spillOne(text, opts = {}) {
  const { preview, dir } = { ...DEFAULTS, ...opts };
  const file = saveSpill(text, dir);
  const content =
    `${excerpt(text, preview)}\n` +
    `[输出超过预算：全文共 ${text.length} 字符，已完整保存到 ${file}。` +
    `需要被省略的部分时，用 read_file（配 offset/limit）分段读取，不要重跑命令。]`;
  return { content, file };
}

/** 整轮观测预算：records 是本轮所有工具调用的 [{ output, spillable }]。
 *  规则与 Reina 一致 —— 候选按体积从大到小排；只要「这条超单条上限」或
 *  「整轮总量还超标」就溢出这一条，直到两个条件都满足为止。
 *  spillable=false 的条目跳过（如 read_file：文件本来就在磁盘上，
 *  落盘一份副本毫无意义，它用 offset/limit 自我设限）。原地改写 output。 */
export function enforceTurnBudget(records, opts = {}) {
  const { perResult, turnTotal, preview, dir } = { ...DEFAULTS, ...opts };
  let total = records.reduce((sum, r) => sum + r.output.length, 0);
  const before = total;
  const candidates = records
    .filter((r) => r.spillable !== false && r.output.length > preview)
    .sort((a, b) => b.output.length - a.output.length);
  const spilled = [];
  for (const record of candidates) {
    if (record.output.length <= perResult && total <= turnTotal) break;
    const { content, file } = spillOne(record.output, { preview, dir });
    total -= record.output.length - content.length;
    record.output = content;
    spilled.push(file);
  }
  return { spilled, before, after: total };
}

// ─── 日志压缩：溢出之前的第一道减负 ─────────────────────────────────────
//
// 构建/测试日志 95% 是噪声（passing 行、进度条、下载提示），有信号的只有
// 错误、失败总结和它们旁边的堆栈。按行分三类：
//   anchor —— 错误/警告/总结行，永远保留，连同前后 2 行上下文；
//   trace  —— 堆栈帧，挨着保留行时整块保留（堆栈只有完整才有用）；
//   noise  —— 其余，成片折叠成 "… [N 行省略]"。
// 两条保险：行数太少不碰（没赚头），省不到 15% 就原样返回（别为了 3% 打乱原文）。

const ANCHOR_RE = /error|exception|failed|failure|fatal|panic|timeout|warn|deprecated/i;
const SUMMARY_RE = [
  /^\s*(FAIL|PASS)\b/, // jest / vitest 的每文件判决
  /^\s*Tests?:?\s/i, // "Tests: 1 failed, 2 passed" / vitest 的 "Tests  2 failed"
  /={3,}.*\b(passed|failed|error)\b/i, // pytest / vitest 横幅
  /^\s*npm (ERR|WARN)!/,
  // 本 agent 自己盖的失败戳（run_shell 失败时的首行前缀，见 agent.mjs）。
  // 它是最高信号的"失败总结行"，必须永远保留 —— 否则长失败日志（一堆 passing
  // 之后末尾才报错）会把这行折进省略标记，下游 FAILURE_RE 便认不出这条失败了。
  /^(命令失败|编辑失败|工具执行出错|未知工具|工具参数)/,
];
const TRACE_RE = [/^\s+at\s/, /^\s*File ".*", line \d+/, /^\s*-->\s/, /^\s*\^+/];

function classify(line) {
  if (SUMMARY_RE.some((re) => re.test(line)) || ANCHOR_RE.test(line)) return "anchor";
  if (TRACE_RE.some((re) => re.test(line))) return "trace";
  return "noise";
}

export function compressLog(text, { minLines = 40, context = 2, minSavings = 0.15 } = {}) {
  const lines = text.split(/\r?\n/);
  const unchanged = { content: text, compressed: false, inputLines: lines.length, outputLines: lines.length, savings: 0 };
  if (lines.length < minLines) return unchanged; // 短输出不碰

  const classes = lines.map(classify);
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (classes[i] !== "anchor") continue;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  }
  // 堆栈块整块保留 —— 但只在它挨着一条已保留的行时（孤儿堆栈没有归属，不值钱）。
  for (let i = 0; i < lines.length; i++) {
    if (classes[i] !== "trace") continue;
    let start = i, end = i;
    while (start > 0 && classes[start - 1] === "trace") start--;
    while (end < lines.length - 1 && classes[end + 1] === "trace") end++;
    if ((start > 0 && keep[start - 1]) || (end < lines.length - 1 && keep[end + 1])) {
      for (let j = start; j <= end; j++) keep[j] = true;
    }
    i = end;
  }

  const out = [];
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) { out.push(lines[i]); i++; continue; }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    // 成片的噪声折叠成标记；只有一两行的缝隙留着比标记还便宜。
    if (j - i >= 3) out.push(`… [${j - i} 行省略]`);
    else out.push(...lines.slice(i, j));
    i = j;
  }

  const content = out.join("\n");
  const savings = text.length > 0 ? 1 - content.length / text.length : 0;
  if (savings < minSavings) return unchanged; // 赚得太少 → 原样返回，绝不白白打乱原文
  return { content, compressed: true, inputLines: lines.length, outputLines: out.length, savings };
}
