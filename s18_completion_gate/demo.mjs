#!/usr/bin/env node
// s18 免 key 演示 —— 自主任务的完成门：agent 说"做完了"，凭什么信。
//   场景一：没有闸 —— 自我宣称直接被接受，烂尾没人发现
//   场景二：goal gate —— 合同没收口，declare 被拒；但挡不住"自我盖章"
//   场景三：独立裁判 —— 压缩 trace + 怀疑论裁判，把自我盖章打回去
//   场景四：裁判永远说不 —— 上限 + fail-open，不困死已完成的任务
//
// 运行：node s18_completion_gate/demo.mjs
//
// 生产实现里裁判是一次真实的模型调用（temperature 0、只回 JSON）。演示为了
// 免 key 可跑，用一个规则版裁判代班——它的怀疑标准就是生产版 system prompt
// 里那句话："没有具体证据（工具输出、文件改动、测试结果）的漂亮总结不算数"。

// ─── 会话状态：消息、goal 合同、autopilot 运行态 ─────────────────────────
function newSession() {
  return {
    messages: [], // {role, content, toolName?}
    activeGoals: [], // {id, condition, status: active|met|cancelled, evidence?}
    autopilot: { running: true, rounds: 0, verifyRounds: 0 },
  };
}

let goalSeq = 0;
const addGoal = (s, condition) =>
  s.activeGoals.push({ id: `goal-${++goalSeq}`, condition, status: "active" });
const markGoalMet = (s, id, evidence) => {
  const g = s.activeGoals.find((g) => g.id === id);
  g.status = "met";
  g.evidence = evidence;
};

// 模型干活 = 往消息里追加。工具结果消息带 toolName（trace 只要名字，不要参数）。
const say = (s, text) => s.messages.push({ role: "assistant", content: text });
const tool = (s, name, result) => {
  s.messages.push({ role: "assistant", content: `调用 ${name}` });
  s.messages.push({ role: "user", content: result, toolName: name });
};

// ─── 压缩 trace：给裁判看的不是 transcript，是执行轨迹的形状 ─────────────
// 生产版四段式：round/消息统计 → 工具调用序列（只有名字）→ 最近的 assistant
// 叙述（每条截 200 字符）→ goal 合同 + 盖章证据 → 最终宣称。整体上限 16000。
const clip = (v, max) => (v.length > max ? v.slice(0, max) + "…" : v);

function buildVerifyTrace(s, declare) {
  const lines = [];
  lines.push(`Continuation rounds: ${s.autopilot.rounds} | Messages: ${s.messages.length}`);
  const toolNames = s.messages.filter((m) => m.toolName).map((m) => m.toolName);
  lines.push(`Tool calls: ${toolNames.length}`, "", "Tool call sequence:");
  toolNames.forEach((n, i) => lines.push(`  [${i + 1}] ${n}`));
  const summaries = s.messages
    .filter((m) => m.role === "assistant" && !m.content.startsWith("调用 "))
    .slice(-8)
    .map((m) => `- ${clip(m.content, 200)}`);
  lines.push("", "Assistant summaries (recent):", ...summaries);
  lines.push("", "Goals:");
  for (const g of s.activeGoals) {
    lines.push(`  - [${g.id}] (${g.status}) ${g.condition}`);
    if (g.evidence) lines.push(`      evidence: ${clip(g.evidence, 200)}`);
  }
  lines.push("", `Final declaration (status=${declare.status}):`, clip(declare.summary, 1500));
  return clip(lines.join("\n"), 16000);
}

// ─── 裁判（规则版代班）：默认不信，有具体证据才放行 ──────────────────────
// 两条硬标准，对应生产版 prompt 的"be skeptical"：
//   1. 轨迹里得有验证形状的动作（跑过测试/检查命令），光改不验不算完；
//   2. 每个 met goal 的证据里得有具体锚点（exit code、通过计数、file:line），
//      "我已仔细检查过"这种自我叙述不是证据。
const CONCRETE = /exit 0|\d+\/\d+ passed|:\d+/;
function judge(trace) {
  const ranVerification = /\[\d+\] run_shell/.test(trace);
  const vague = [...trace.matchAll(/- \[(goal-\d+)\] \(met\)[^\n]*\n\s+evidence: ([^\n]*)/g)]
    .filter(([, , ev]) => !CONCRETE.test(ev))
    .map(([, id]) => id);
  if (!ranVerification)
    return { pass: false, reason: "轨迹里没有任何验证动作，只有编辑", feedback: "跑一遍回归测试，把 exit code 和通过数附进 goal 证据里", unmetGoalIds: vague };
  if (vague.length > 0)
    return { pass: false, reason: "goal 证据是自我叙述，没有具体锚点", feedback: "用测试输出（exit code / N passed / file:line）替换证据后重新盖章", unmetGoalIds: vague };
  return { pass: true, reason: "工具轨迹含验证动作，证据有具体锚点", feedback: "", unmetGoalIds: [] };
}

// ─── declare_audit_done：两道闸串联 ──────────────────────────────────────
const VERIFY_MAX_ROUNDS = 3;

function declareAuditDone(s, declare, { goalGate = true, verify = null } = {}) {
  // 闸一 goal gate：还有 active 的合同 → 拒绝，错误消息就是给模型的操作指引。
  if (goalGate) {
    const open = s.activeGoals.filter((g) => g.status === "active");
    if (open.length > 0)
      return {
        error:
          `Cannot declare_audit_done — ${open.length} goal(s) still active:\n` +
          open.map((g) => `  - ${g.id}: ${g.condition}`).join("\n") +
          `\n满足了就 mark_goal_met({goalId, evidence})，做不了就 cancel_goal({goalId, reason})，然后重试。`,
      };
  }
  // 闸二 独立裁判：goal gate 之后、关环之前。上限一到就放行（fail-open）。
  if (verify) {
    if (s.autopilot.verifyRounds >= VERIFY_MAX_ROUNDS)
      return closeLoop(s, declare, `accepted after ${VERIFY_MAX_ROUNDS} verify round(s)`);
    const verdict = verify(buildVerifyTrace(s, declare));
    if (!verdict.pass) {
      s.autopilot.verifyRounds += 1;
      // 重开裁判点名的 goal —— 下次 declare 会先撞回闸一。
      for (const id of verdict.unmetGoalIds) {
        const g = s.activeGoals.find((g) => g.id === id);
        if (g) g.status = "active";
      }
      return {
        error:
          `Independent verification did NOT confirm completion ` +
          `(round ${s.autopilot.verifyRounds}/${VERIFY_MAX_ROUNDS}).\n` +
          `理由：${verdict.reason}\n下一步：${verdict.feedback}`,
      };
    }
    return closeLoop(s, declare, verdict.reason);
  }
  return closeLoop(s, declare, "goal 已全部收口，宣称即接受");
}

function closeLoop(s, declare, reason) {
  s.autopilot.running = false;
  return { output: `<autopilot done status=${declare.status}> （${reason}）` };
}

// ─── 一段共用的"偷懒剧本"：改了 1 处就宣称全修完 ─────────────────────────
function lazyRun(s) {
  addGoal(s, "parser.ts 的 3 处越界读取全部修复，npm test 回归全绿");
  s.autopilot.rounds = 2;
  // 工具结果按真实体积造（读一个文件就是几千字符），trace 的压缩比才有意义
  tool(s, "read_file", "parser.ts：第 88、132、201 行各有一处越界读取\n".padEnd(9000, "…"));
  tool(s, "edit_file", "已修复 parser.ts:88\n--- a/parser.ts\n+++ b/parser.ts\n".padEnd(1600, "…"));
  say(s, "主要问题已经修复，代码看起来没问题了。");
}
const DECLARE = { status: "complete", summary: "三处越界读取均已修复，任务完成。" };
const show = (label, r) =>
  console.log(`  ${label}：${(r.output ?? r.error).split("\n").join("\n  │ ")}`);

// ─── 场景一：没有闸 ──────────────────────────────────────────────────────
console.log("━━━ 场景一：没有闸 —— 自我宣称直接被接受 ━━━");
{
  const s = newSession();
  lazyRun(s);
  show("declare_audit_done", declareAuditDone(s, DECLARE, { goalGate: false }));
  console.log(`  实际状态：3 处只修了 1 处，测试一次没跑 —— 循环已关，没人发现。\n`);
}

// ─── 场景二：goal gate 挡住"忘了合同"，挡不住"自我盖章" ──────────────────
console.log("━━━ 场景二：goal gate —— 合同没收口，declare 被拒 ━━━");
{
  const s = newSession();
  lazyRun(s);
  show("第 1 次 declare", declareAuditDone(s, DECLARE));
  markGoalMet(s, "goal-2", "我已仔细检查过，应该都修好了");
  show("自我盖章后再 declare", declareAuditDone(s, DECLARE));
  console.log(`  → goal gate 只查合同状态，不查证据质量 —— 需要第二道闸。\n`);
}

// ─── 场景三：独立裁判 ────────────────────────────────────────────────────
console.log("━━━ 场景三：独立裁判 —— 自我盖章过不了第二道闸 ━━━");
{
  const s = newSession();
  lazyRun(s);
  markGoalMet(s, "goal-3", "我已仔细检查过，应该都修好了");
  show("declare（裁判第 1 轮）", declareAuditDone(s, DECLARE, { verify: judge }));

  // 反馈进入下一个 continuation round：这回真干活、真验证。
  s.autopilot.rounds += 1;
  tool(s, "edit_file", "已修复 parser.ts:132\n".padEnd(1600, "…"));
  tool(s, "edit_file", "已修复 parser.ts:201\n".padEnd(1600, "…"));
  tool(s, "run_shell", "npm test → 41/41 passed，exit 0\n".padEnd(4000, "…"));
  markGoalMet(s, "goal-3", "npm test exit 0，41/41 passed；修复位于 parser.ts:88/132/201");
  say(s, "三处越界全部修复，回归测试全绿。");
  show("declare（裁判第 2 轮）", declareAuditDone(s, DECLARE, { verify: judge }));

  const trace = buildVerifyTrace(s, DECLARE);
  const transcript = s.messages.map((m) => m.content).join("\n");
  console.log(`  裁判读的 trace：${trace.length} 字符（transcript ${transcript.length} 字符 → 只看形状，不逐字重放）\n`);
}

// ─── 场景四：裁判永远说不 —— 上限 + fail-open ────────────────────────────
console.log("━━━ 场景四：裁判卡死 —— verifyRounds 上限 + fail-open ━━━");
{
  const s = newSession();
  lazyRun(s);
  markGoalMet(s, "goal-4", "npm test exit 0，41/41 passed");
  const alwaysNo = () => ({ pass: false, reason: "（故障裁判：无条件拒绝）", feedback: "再来一遍", unmetGoalIds: [] });
  for (let i = 1; i <= 4; i++) {
    const r = declareAuditDone(s, DECLARE, { verify: alwaysNo });
    console.log(`  第 ${i} 次 declare：${r.output ?? r.error.split("\n")[0]}`);
  }
  console.log(`  → 独立校验是闸不是牢：上限一到宁可放行，也不困死一个已完成的任务。`);
}
