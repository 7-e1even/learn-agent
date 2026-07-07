#!/usr/bin/env node
// s19 免 key 演示 —— 压缩与缓存的冲突：s06 改写历史，s07 靠历史不变吃缓存，
// 两个机制天生打架。三笔账算清楚怎么把损失降到最低。
//   账一：什么时候压 —— 每轮修剪 vs 阈值触发，击穿次数差一个量级
//   账二：摘要调用怎么计费 —— 独立请求全价 vs 骑主 agent 刚缓存的前缀
//   账三：摘要放哪 —— 每轮重发的 reminder vs 一次性折进历史
//
// 运行：node s19_compaction_cache/demo.mjs
//
// 计费模型沿 s07/s16：命中缓存前缀的部分按 1 折计，其余全价（字符/4 ≈ token）。

const tok = (s) => Math.round(s.length / 4);
const CACHED = 0.1;
const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const ser = (msgs) => JSON.stringify(msgs);

const SYSTEM = "你是一个 coding agent……（8000 字符系统提示）".padEnd(8000, "。");
const TOOLS = '[{"name":"read_file"},…（4000 字符工具 schema）]'.padEnd(4000, " ");
const SUMMARY = "Post-compact restored context:\nConversation summary:\n任务与进展摘要……".padEnd(2000, "。");

// 每轮新增：一句叙述 + 一条 3000 字符的工具结果
const newTurn = (t) => [
  { role: "assistant", content: `第 ${t} 步：继续排查。` },
  { role: "user", content: `[tool] step${t} 输出：`.padEnd(3000, "x") },
];

// ─── 账一：什么时候压 —— 击穿次数 = 改写历史的次数 ───────────────────────
const TURNS = 20;
const THRESHOLD_TOK = 12000; // 演示阈值（生产是"窗口用到约 75%"）

function simulate(policy) {
  let msgs = []; // 实际发出去的视图（threshold 会持久改写它）
  let prev = "", total = 0, breaks = 0, compactions = 0;
  for (let t = 1; t <= TURNS; t++) {
    msgs.push(...newTurn(t));
    if (policy === "turn_end" && msgs.length > 6) {
      // 滚动摘要式：每轮结束都把最新 3 轮之外的历史重写成一段摘要。
      // 摘要内容随轮次变（它要吸收刚滚出窗口的那轮），所以历史头部每轮都在变。
      const digest = { role: "user", content: `[截至第 ${t - 3} 步的滚动摘要] 经过……`.padEnd(2000, "。") };
      msgs = [digest, ...msgs.filter((m) => !m.content.startsWith("[截至")).slice(-6)];
    }
    if (policy === "threshold" && tok(ser(msgs)) > THRESHOLD_TOK) {
      // 阈值到了才压：头部整段换成摘要消息，保留最近 6 条
      msgs = [{ role: "user", content: SUMMARY }, ...msgs.slice(-6)];
      compactions++;
    }
    const req = SYSTEM + TOOLS + ser(msgs);
    const hit = commonPrefix(prev, req);
    total += tok(req.slice(0, hit)) * CACHED + tok(req.slice(hit));
    if (t > 1 && req.length - hit > 3500) breaks++; // 未命中部分明显大于本轮新增 = 击穿
    prev = req;
  }
  return { total: Math.round(total), breaks, ctx: tok(SYSTEM + TOOLS + ser(msgs)), compactions };
}

console.log(`━━━ 账一：什么时候压 ×（${TURNS} 轮工具循环，计费输入 token） ━━━`);
const base = simulate("none");
for (const [label, policy] of [
  ["不压（计费下界参照）　　　", "none"],
  ["阈值触发（用到 75% 才压）　", "threshold"],
  ["每轮修剪（回头改写老结果）", "turn_end"],
]) {
  const r = simulate(policy);
  console.log(
    `  ${label}：${String(r.total).padStart(6)} tok · ${(r.total / base.total).toFixed(1)}× · 击穿 ${String(r.breaks).padStart(2)} 次 · 最终上下文 ${String(r.ctx).padStart(5)} tok${policy === "threshold" ? `（压了 ${r.compactions} 次）` : ""}`,
  );
}
console.log("  → 修剪确实让上下文最小，但每轮都在改历史中段 = 每轮击穿 = 每轮全价重读。");
console.log("  → 不压的前缀最完美，但上下文只增不减，迟早撞窗（为什么必须压见 s06）。\n");

// ─── 账二：摘要调用怎么计费 —— 骑主 agent 刚缓存的前缀 ──────────────────
// 快进到阈值首次触发的时刻，拿到"刚发给主模型的请求"和"要压掉的切片"。
const msgs = [];
let mainPrev = "";
for (let t = 1; ; t++) {
  msgs.push(...newTurn(t));
  mainPrev = SYSTEM + TOOLS + ser(msgs);
  if (tok(ser(msgs)) > THRESHOLD_TOK) break;
}
const slice = msgs.slice(0, -6); // 要压掉的头部（保留最近 6 条）

const INSTRUCTION = { role: "user", content: "以上对话即将被压缩。现在就总结——不要继续任务，不要调工具……" };
const flatten = (ms) => "Conversation segment to summarize follows:\n" + ms.map((m) => `${m.role}: ${m.content}`).join("\n");

console.log("━━━ 账二：摘要调用怎么计费（被压切片 " + tok(ser(slice)) + " tok） ━━━");
for (const [label, req] of [
  ["独立请求（专用 system、扁平化文本）", "摘要专用 system prompt".padEnd(800, "。") + ser([{ role: "user", content: flatten(slice) }])],
  ["前缀复用（同 system+tools+原生切片）", SYSTEM + TOOLS + ser([...slice, INSTRUCTION])],
]) {
  const hit = commonPrefix(mainPrev, req);
  const cost = Math.round(tok(req.slice(0, hit)) * CACHED + tok(req.slice(hit)));
  const pct = ((hit / req.length) * 100).toFixed(1);
  console.log(`  ${label}：命中 ${pct.padStart(5)}% · 计费 ${String(cost).padStart(5)} tok`);
}
console.log("  → 主 agent 上一轮刚把 [system+tools+history] 写进缓存，摘要调用原样复用这个前缀，");
console.log("    切片的大头按 1 折计。两个开关条件：同一个 model+provider（缓存按模型隔离，");
console.log("    配了专用压缩小模型就自动走独立请求）；模型没跑偏（跑去调工具 → 回退独立请求，");
console.log("    最坏代价 = 多一次几乎全命中的调用，绝不接受降级的摘要）。\n");

// ─── 账三：摘要放哪 —— 每轮重发 vs 一次性折进历史 ────────────────────────
const AFTER = 8;
console.log(`━━━ 账三：摘要放哪 ×（压缩后再跑 ${AFTER} 轮） ━━━`);
const totals = {};
for (const [label, mode] of [
  ["每轮系统 reminder（追在最新消息后）", "reminder"],
  ["一次性折进历史（restored-context）　", "folded"],
]) {
  const tail = msgs.slice(-6);
  const hist = mode === "folded" ? [{ role: "user", content: SUMMARY }, ...tail] : [...tail];
  let prev = "", total = 0;
  for (let t = 1; t <= AFTER; t++) {
    hist.push(...newTurn(100 + t));
    const view = mode === "reminder" ? [...hist, { role: "user", content: SUMMARY }] : hist;
    const req = SYSTEM + TOOLS + ser(view);
    const hit = commonPrefix(prev, req);
    total += tok(req.slice(0, hit)) * CACHED + tok(req.slice(hit));
    prev = req;
  }
  totals[mode] = Math.round(total);
  console.log(`  ${label}：${String(Math.round(total)).padStart(6)} tok`);
}
console.log(
  `  多付 ${totals.reminder - totals.folded} tok ≈ 摘要（${tok(SUMMARY)} tok）按全价与 1 折的差额 × ${AFTER} 轮 —— 摘要越大、会话越长，这笔差越可观。`,
);
console.log("  → reminder 永远排在最新消息后面 = 永远在未缓存的后缀里 = 每轮全价重发一遍摘要；");
console.log("    折进历史固定位置只付一次全价，之后每轮搭前缀的 1 折便车。");
