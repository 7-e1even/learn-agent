#!/usr/bin/env node
// 不需要 API key 的看门狗演示：用三个"剧本 agent"喂 LoopBudget，
// 亲眼看三种失控模式分别在第几轮被摁停、勤奋 agent 如何拿到续期。
//
//   node s03_loop_budget/demo.mjs

import { LoopBudget, isRecoverable } from "./loop-budget.mjs";

function play(title, script) {
  console.log(`\n━━━ ${title} ━━━`);
  const budget = new LoopBudget({ baseSteps: 6 });
  for (let turn = 1; ; turn++) {
    if (!budget.canContinue()) {
      const stop = budget.exhaustedStop();
      console.log(`  第 ${turn} 轮：⛔ ${stop.message}（reason=${stop.reason}）`);
      return;
    }
    const records = script(turn);
    const desc = records.map((r) => `${r.name}(${JSON.stringify(r.input)})${r.status === "failed" ? "✗" : ""}`).join(" + ");
    const stop = budget.recordTurn(records);
    console.log(`  第 ${turn} 轮：${desc}  [预算 ${budget.turns}/${budget.budget}]`);
    if (stop) {
      const tag = isRecoverable(stop) ? "🟡 可纠偏暂停" : "⛔ 强制停止";
      console.log(`  ${tag}：${stop.message}（reason=${stop.reason}）`);
      return;
    }
  }
}

// 场景一：复读机。模型卡住了，反复 grep 同一个词 —— 每轮动作一模一样。
play("场景一：复读机（同一动作反复执行）", () => [
  { name: "run_shell", input: { command: "grep -r TODO ." }, status: "completed", output: "src/a.js: // TODO" },
]);

// 场景二：连环报错。命令一直失败，模型没换路，只是不停重试变体。
play("场景二：连环报错（每轮全是失败）", (turn) => [
  { name: "run_shell", input: { command: `npm test -- --retry=${turn}` }, status: "failed", output: "Error: Cannot find module" },
]);

// 场景三：原地踏步。每轮动作都不一样、也不报错，但一直搜不到东西 ——
// 空手而归不算进展，连续空手就该停下来想想（或者问用户）。
play("场景三：原地踏步（干了很多，全部空手而归）", (turn) => [
  { name: "run_shell", input: { command: `grep -r "pattern_${turn}" src/` }, status: "completed", output: "" },
]);

// 场景四：勤奋的好 agent。每轮都有真实写操作 —— 观察预算从 6 自动续到 24（硬顶）。
play("场景四：勤奋 agent（有进展就续期，直到硬顶）", (turn) => [
  { name: "edit_file", input: { path: "src/app.js", old_string: `v${turn}`, new_string: `v${turn + 1}` }, status: "completed", output: "已编辑" },
]);

console.log(`
结论：
  · 复读机、连环报错、原地踏步 —— 都在预算耗尽前就被行为探测器摁停（🟡 可纠偏，
    真实 agent 会先收到一条"纠偏 prompt"，换个思路重来一次）。
  · 勤奋 agent 不受一刀切上限的惩罚 —— 有进展就续期，直到硬顶（⛔ 兜底）。
`);
