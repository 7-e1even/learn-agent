#!/usr/bin/env node
// s20 免 key 演示 —— 自动长期记忆（dream 固化），四笔账算给你看。
//   账一：什么时候写 —— 每 turn 抽取 / 启动扫描 / session 结束 / turn 末门槛检查，四种策略的账单
//   账二：idle 过滤 —— 不过滤会把「进行到一半的工作」总结成半截事实
//   账三：检索即信号 —— 大水漫灌 write-ahead vs「被需要第二次才升级」的按需写入
//   账四：修剪出口 —— 记忆只进不出 = 越攒越臃肿，固化时顺手 delete 才敢自动生长
//
// 运行：node s20_memory_dream/demo.mjs

// ─── 账一：什么时候写 —— 四种触发策略跑同一个月 ─────────────────────────
// 同一份使用记录：一个用户、3 个项目、30 天。每天在活跃项目里开若干会话、
// 每会话若干 turn。四种真实产品的触发策略各自要发多少次「后台记忆模型调用」？
//   A. 每 turn 抽取（claude-code extractMemories）：每个 turn 结束 fork 一次
//   B. 启动扫描（codex）：每天首次启动跑一次管线（每次最多消化 2 个 rollout）
//   C. session 结束（grok dream，gate: 4h + 3 sessions）
//   D. turn 末门槛检查（Reina，gate: 72h + 10 个闲置会话，检查本身零成本）
const rng = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();
const MONTH = []; // [{day, project, sessions:[turns,...]}]
for (let day = 1; day <= 30; day++) {
  for (let p = 0; p < 3; p++) {
    if (rng() < 0.45) continue; // 项目不是每天都碰
    const sessions = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => 1 + Math.floor(rng() * 6));
    MONTH.push({ day, project: `P${p + 1}`, sessions });
  }
}
const totalSessions = MONTH.reduce((a, d) => a + d.sessions.length, 0);
const totalTurns = MONTH.reduce((a, d) => a + d.sessions.reduce((x, y) => x + y, 0), 0);

const perTurn = totalTurns; // A：每 turn 一次
const startupDays = new Set(MONTH.map((d) => d.day)).size; // B：活跃日各一次
let grokFires = 0; // C：每项目 4h+3sessions —— 桌面场景近似为「每项目每活跃日一次」
const grokSeen = new Set();
for (const d of MONTH) if (d.sessions.length >= 3) { const k = `${d.project}:${d.day}`; if (!grokSeen.has(k)) { grokSeen.add(k); grokFires++; } }
// D：Reina —— 每项目独立时钟：攒够 10 个闲置会话 且 距上次 ≥72h 才跑
const acc = {}; const last = {}; let reinaFires = 0;
for (const d of MONTH) {
  acc[d.project] = (acc[d.project] ?? 0) + d.sessions.length;
  if (acc[d.project] >= 10 && d.day - (last[d.project] ?? -99) >= 3) { reinaFires++; acc[d.project] = 0; last[d.project] = d.day; }
}
console.log("━━━ 账一：什么时候写 —— 同一个月（3 项目 · " + totalSessions + " 会话 · " + totalTurns + " turns），四种策略的后台调用数 ━━━");
console.log(`  A 每 turn 抽取（claude-code）：${String(perTurn).padStart(4)} 次    —— 最细也最贵，靠 inline 互斥 + 节流才压得住`);
console.log(`  B 启动扫描（codex）        ：${String(startupDays).padStart(4)} 次    —— 摊在每天首启，永不和活跃会话抢资源`);
console.log(`  C session 结束（grok）     ：${String(grokFires).padStart(4)} 次    —— 依赖干净的「会话结束」信号（CLI 才有）`);
console.log(`  D turn 末门槛（Reina）     ：${String(reinaFires).padStart(4)} 次    —— 检查零成本（两条 SQL），开跑按项目批量结账`);
console.log("  → 频率差两个数量级。真正的设计题不是「要不要自动」，是「检查和执行必须分开计价」。\n");

// ─── 账二：idle 过滤 —— 半截事实 vs 尘埃落定 ────────────────────────────
// 一个会话正在把项目从 API v1 迁到 v2，迁移进行到一半。此刻固化 =
// 把「本项目用 v1（兼容层）」写成长期事实；等它闲置 6h 尘埃落定再固化 =
// 记下真正的结论。门槛计数和材料构建必须用同一条截止线，
// 否则会出现「门开了、材料却被滤空」的空转。
const now = Date.now(); const H = 3600_000;
const sessions = [
  { title: "迁移 API v1→v2（进行中）", fact: "项目暂用 v1 兼容层", updatedAt: now - 0.3 * H },
  { title: "迁移 API v1→v2（完成）", fact: "项目已全量迁到 v2，v1 兼容层已删", updatedAt: now - 9 * H },
  { title: "配置 CI", fact: "CI 用 pnpm，node 22", updatedAt: now - 30 * H },
];
const IDLE_H = 6;
const idleCutoff = now - IDLE_H * H;
console.log("━━━ 账二：idle 过滤 —— 只总结已经冷却的会话（codex min_rollout_idle_hours 的道理） ━━━");
for (const noFilter of [true, false]) {
  const mat = sessions.filter((s) => noFilter || s.updatedAt <= idleCutoff);
  const facts = mat.map((s) => s.fact);
  const bad = noFilter && facts.some((f) => f.includes("暂用 v1"));
  console.log(`  ${noFilter ? "不过滤" : `闲置≥${IDLE_H}h`}：折进笔记本 ${mat.length} 条 → ${facts.join(" / ")}`);
  if (bad) console.log("           ❌ 半截事实入库：下个会话会信「项目用 v1」，而真相 8 小时后就反转了");
}
console.log("  → 记忆是给未来会话用的，晚 6 小时写没有损失；提前写的代价是把中间态固化成「事实」。");
console.log("  → 附带红利：当前会话永远是「刚更新」的 → 天然不计入门槛（测试里想靠它凑数会翻车）。\n");

// ─── 账三：检索即信号 —— 什么值得写，让需求投票 ──────────────────────────
// write-ahead（每 turn 抽取式）：凡是「看起来持久」的都先写下来，赌将来用得上。
// 检索即信号（Reina）：search_memory 命中「历史会话」= 这个知识被需要了第二次，
// 这才是持久价值的最强证据 —— 在检索结果尾部提示模型当场升级为笔记。
const learned = [ // 一个月里各会话「学到」的 20 件事，以及未来 90 天真被再次需要的次数
  { fact: "用户偏好 pnpm", reused: 7 }, { fact: "CI 需要 node 22", reused: 4 },
  { fact: "auth 模块入口在 gateway.ts", reused: 3 }, { fact: "发版前必须跑 e2e", reused: 2 },
  { fact: "周三改过一次 tsconfig", reused: 0 }, { fact: "某次 flaky 测试重跑就好了", reused: 0 },
  ...Array.from({ length: 14 }, (_, i) => ({ fact: `一次性调试细节 #${i + 1}`, reused: 0 })),
];
const writeAhead = learned.length;
const demandDriven = learned.filter((f) => f.reused > 0);
console.log("━━━ 账三：检索即信号 —— write-ahead 大水漫灌 vs 被需要第二次才升级 ━━━");
console.log(`  write-ahead：写 ${writeAhead} 条，其中 ${writeAhead - demandDriven.length} 条从未被再次用到 —— 笔记本 ${Math.round((1 - demandDriven.length / writeAhead) * 100)}% 是死重`);
console.log(`  检索即信号：只有被再次查找的 ${demandDriven.length} 条被提示升级 → ${demandDriven.map((f) => f.fact).join(" / ")}`);
console.log("  → 写入时机交给需求：search_memory 命中历史会话时附一行提示，零调度器、零额外调用。");
console.log("  → 判据是「被迫重新发现」——你不得不再查一遍的东西，就是该记住的东西。\n");

// ─── 账四：修剪出口 —— 只进不出的记忆最终反噬 ────────────────────────────
// 每次固化写入 3 条新事实，其中 1 条与旧笔记矛盾（项目决策会变）。
// 无修剪：矛盾的旧条目一直躺着，注入 prompt 的索引里新旧并存 —— 模型各信一半。
// 有修剪：固化代理拿着 delete_note，顺手删掉被新会话推翻的旧条目。
let hoarder = 0, hoarderStale = 0, pruned = 0;
for (let cycle = 1; cycle <= 10; cycle++) {
  hoarder += 3; hoarderStale += 1;      // 只进不出：3 新 +1 矛盾旧条永驻
  pruned += 3 - 1;                       // 有出口：3 新 -1 删被推翻的
}
console.log("━━━ 账四：修剪出口 —— 10 次固化后的笔记本 ━━━");
console.log(`  只进不出：${hoarder} 条，其中 ${hoarderStale} 条已被推翻但仍在索引里 —— 每轮注入都在给模型喂过期事实`);
console.log(`  有修剪  ：${pruned} 条，全部当前有效`);
console.log("  → 能自我瘦身的记忆才敢自动生长。配套的召回侧保险：注入段末尾一句防漂移 ——");
console.log("    「笔记反映写入时的状态，引用其中的文件/命令前先核实仍存在」。记忆说 X 存在 ≠ X 现在存在。");
