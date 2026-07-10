#!/usr/bin/env node
// s07 免 key 演示 —— 前缀缓存从哪里断，纯字符串就能算出来：
//   实验 A：时间戳写进 system → 缓存在第一行就断
//   实验 B：system 稳定，时间戳放最后一条用户消息 → 上一轮请求 100% 复用
//   实验 C：违反 append-only（"好心"截短旧工具输出）→ 断点跳回历史中间
//   实验 D：浪费计数器 → 只用 provider 的 usage 数字，把每次击穿折成 token 并归因
//
// 服务商按"与上次请求逐字节相同的前缀"给缓存价（实际按 token/块粒度对齐，
// DeepSeek 是 64 token 一块；这里用字符近似，原理相同）。
//
// 运行：node s07_prompt_cache/demo.mjs

// ─── 把请求"线性化"：服务商看到的就是这样一条字节流 ─────────────────────
// system、tools、每条消息依次拼接。缓存能复用的 = 和上一条字节流相同的开头。

const TOOLS = JSON.stringify([
  { name: "run_shell", description: "执行一条 shell 命令" },
  { name: "read_file", description: "读取一个文本文件" },
]);

function serializeRequest(system, messages) {
  const parts = [`[system]\n${system}`, `[tools]\n${TOOLS}`];
  for (const m of messages) parts.push(`[${m.role}]\n${m.content}`);
  return parts.join("\n\n");
}

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function report(label, prev, cur) {
  const n = commonPrefixLength(prev, cur);
  const reused = ((n / prev.length) * 100).toFixed(1);
  console.log(`  ${label}：公共前缀 ${n} 字符（上一轮请求共 ${prev.length} 字符 → 可复用 ${reused}%）`);
  if (n < prev.length) {
    const from = Math.max(0, n - 16);
    console.log(`    断点上下文: …${JSON.stringify(prev.slice(from, n + 12))} vs …${JSON.stringify(cur.slice(from, n + 12))}`);
  } else {
    console.log("    断点在上一轮请求的末尾之后——新增的只有追加的消息，这就是理想形状。");
  }
  return n;
}

// ─── 伪造一段工具循环：1 条用户消息 + 两轮工具往返 ───────────────────────

const TOOL_OUTPUT_1 = '   1\t{\n   2\t  "scripts": {\n   3\t    "test": "vitest run",\n   4\t    "build": "tsc -p ."\n   5\t  }\n' + '   …\t（省略 60 行依赖列表）\n'.repeat(12);

const round1 = [
  { role: "assistant", content: '（调用 read_file {"path":"package.json"}）' },
  { role: "tool", content: TOOL_OUTPUT_1 },
];
const round2 = [
  { role: "assistant", content: '（调用 run_shell {"command":"npx vitest list"}）' },
  { role: "tool", content: "test/date.test.ts\ntest/http.test.ts\ntest/utils.test.ts" },
];

// 演示用假时钟：每次调用走一秒，模拟"每轮请求时间都不同"。
let tick = 0;
const clock = () => `10:23:0${++tick}`;

// ─── 实验 A：时间戳写进 system（缓存杀手）────────────────────────────────

console.log("━━━ 实验 A：时间戳写进 system ━━━");
const badSystem = () => `当前时间：${clock()}。你是一个运行在用户终端里的编程助手。先观察真实世界再行动。`;
const userA = { role: "user", content: "看看 package.json 里有哪些 scripts，然后告诉我怎么跑测试。" };

const a1 = serializeRequest(badSystem(), [userA]);
const a2 = serializeRequest(badSystem(), [userA, ...round1]);
const a3 = serializeRequest(badSystem(), [userA, ...round1, ...round2]);
report("第 1↔2 轮", a1, a2);
report("第 2↔3 轮", a2, a3);
console.log("  断点永远卡在时间戳的秒位上 → 后面的 tools、全部历史，每一轮都按全价重算。");

// ─── 实验 B：system 稳定，时间戳放最后一条用户消息 ───────────────────────

console.log("\n━━━ 实验 B：system 稳定，时间戳放进用户消息尾部 ━━━");
const goodSystem = "你是一个运行在用户终端里的编程助手。先观察真实世界再行动。";
const userB = { role: "user", content: `看看 package.json 里有哪些 scripts，然后告诉我怎么跑测试。\n\n[本地时间：${clock()}]` };

const b1 = serializeRequest(goodSystem, [userB]);
const b2 = serializeRequest(goodSystem, [userB, ...round1]);
const b3 = serializeRequest(goodSystem, [userB, ...round1, ...round2]);
report("第 1↔2 轮", b1, b2);
report("第 2↔3 轮", b2, b3);
console.log("  时间没有消失——它随那条用户消息进了历史，但从此一个字节都不再变。");

// ─── 实验 C：违反 append-only（改写历史）────────────────────────────────

console.log("\n━━━ 实验 C：第 3 轮\"好心\"截短旧的工具输出 ━━━");
const trimmedRound1 = [
  round1[0],
  { role: "tool", content: TOOL_OUTPUT_1.slice(0, 80) + "…(为省上下文截短)" },
];
const c3 = serializeRequest(goodSystem, [userB, ...trimmedRound1, ...round2]);
const brk = report("第 2↔3 轮", b2, c3);
console.log(`  断点从请求末尾跳回第 ${brk} 字符（那条工具输出的中间）——`);
console.log(`  之后的 ${c3.length - brk} 字符全部退回全价。省了几十个字符的上下文，赔掉的是整段后续历史的缓存。`);
console.log("  真想省：要么当初就别让大输出进历史（s04 输出预算），要么整段压缩换摘要（s06）。");

// ─── 实验 D：浪费计数器——上一轮的 prompt，这一轮本该全是缓存读 ────────────
// A/B/C 拿着两轮请求的原文对比，能精确指出断点在哪个字节——但那是实验室条件：
// 生产里你不会留着每轮几十万字符的请求原文。生产里手上只有 provider 每轮
// 报回的三个数：prompt 总量、缓存读了多少、缓存写了多少。
// 好在"该命中多少"是可以推的：上一轮整个 prompt 刚被算过一遍，这一轮它的
// 每个 token 都该是缓存读。差出来的部分就是被重计费的浪费：
//   miss = min(上一轮 prompt, 这一轮 prompt) - 这一轮缓存读
// 再看闲置了多久：超过 TTL（Anthropic 默认 5 分钟）是缓存被淘汰（正常损耗）；
// 没超 TTL 就是前缀被改写了（实验 C 的病，去查 append-only）。

console.log("\n━━━ 实验 D：浪费计数器——只靠 usage 数字，量化每次击穿并归因 ━━━");

const TTL_MS = 5 * 60 * 1000; // 缓存保留时间
const NOISE = 1024; // 断点/块粒度造成的小额差异，不算浪费

function trackCacheUsage(prev, usage, now) {
  const reported = usage.cacheRead + usage.cacheWrite > 0;
  const next = { promptTokens: usage.prompt, at: now, reportedCache: (prev?.reportedCache ?? false) || reported };
  // 第一轮没有参照；从不报缓存字段的服务商，0 也说明不了什么
  if (!prev || (!reported && !prev.reportedCache)) return { next };
  const missed = Math.min(prev.promptTokens, usage.prompt) - usage.cacheRead;
  if (missed <= NOISE) return { next };
  const idleMs = now - prev.at;
  return { next, miss: { missed, idleMs, ttlExpired: idleMs > TTL_MS } };
}

// 一段会话的 usage 流水（provider 每轮报回的原始数字）：
const rounds = [
  { label: "第 1 轮（会话开始）　　　　", gap: 0, prompt: 8200, cacheRead: 0, cacheWrite: 8200 },
  { label: "第 2 轮（15 秒后）　　　　　", gap: 15e3, prompt: 11400, cacheRead: 8200, cacheWrite: 3200 },
  { label: "第 3 轮（20 秒后）　　　　　", gap: 20e3, prompt: 14100, cacheRead: 11400, cacheWrite: 2700 },
  { label: "第 4 轮（用户开会，38 分钟后）", gap: 38 * 60e3, prompt: 16300, cacheRead: 0, cacheWrite: 16300 },
  { label: "第 5 轮（10 秒后）　　　　　", gap: 10e3, prompt: 18000, cacheRead: 16300, cacheWrite: 1700 },
  { label: "第 6 轮（12 秒后，有人截短了老工具输出）", gap: 12e3, prompt: 17600, cacheRead: 5100, cacheWrite: 12500 },
];

let state, now = 0, waste = 0, misses = 0;
for (const r of rounds) {
  now += r.gap;
  const { next, miss } = trackCacheUsage(state, r, now);
  state = next;
  if (!miss) { console.log(`  ${r.label}：✓ 正常`); continue; }
  waste += miss.missed; misses++;
  const idle = miss.idleMs >= 60e3 ? `${Math.round(miss.idleMs / 60e3)} 分钟` : `${Math.round(miss.idleMs / 1e3)} 秒`;
  const verdict = miss.ttlExpired
    ? "闲置超过 TTL → 缓存被服务商淘汰（正常损耗，人回来了它就回来）"
    : "TTL 没过 → 前缀被改写了！去查 append-only（实验 C 的病）";
  console.log(`  ${r.label}：✗ 浪费 ${miss.missed} tok · 闲置 ${idle} · ${verdict}`);
}
console.log(`  会话累计：浪费 ${waste} tok / ${misses} 次 —— 放到 UI 上就是一行 "Cache waste"。`);
console.log("  注意第 4 轮和第 6 轮的数字长得几乎一样（cacheRead 掉下去了），");
console.log("  没有 idle 归因就分不清'正常损耗'和'代码有病'——量化的意义就在这一步。");
