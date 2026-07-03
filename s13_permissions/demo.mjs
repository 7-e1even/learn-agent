#!/usr/bin/env node
// s13 免 key 演示 —— 一条有序规则链，把"准不准"从自由心证变成确定性求值。
//   ① 首匹配：规则从上到下，第一个命中的说了算
//   ② 三态 verdict：allow 放行 / deny 硬拒 / ask 问用户
//   ③ workspace 覆盖 global：项目规则排在全局前，天然覆盖
//
// 运行：node s13_permissions/demo.mjs

import { evaluatePermission, mergeRules } from "./permissions.mjs";

// ─── 全局规则（~/.reina 那层，对所有项目生效）─────────────────────────────
// 顺序就是优先级：越靠上越先命中。危险的硬拒放最上面，安全的放行放中间，
// 其余的靠 default=ask 兜底。
const GLOBAL = [
  { verdict: "deny", tool: "read_file", pathGlob: "**/.env*" }, // 密钥文件：读都不许
  { verdict: "deny", tool: "run_shell", commandPrefix: "git push" }, // 别偷偷推
  { verdict: "deny", tool: "run_shell", commandPrefix: "rm -rf" }, // 别删库
  { verdict: "allow", tool: "run_shell", commandPrefix: "git status" }, // 只读，免打扰
  { verdict: "allow", tool: "run_shell", commandPrefix: "git diff" },
  { verdict: "allow", tool: "run_shell", commandPrefix: "ls" },
  { verdict: "allow", tool: "read_file", pathGlob: "src/**" }, // 读源码：放行
  // 其余 run_shell / write_file / edit_file …… 全部落到 default = ask
];

// ─── 场景 A：只用全局规则 ─────────────────────────────────────────────────
const ATTEMPTS = [
  { tool: "run_shell", input: { command: "git status" }, note: "只读，应放行" },
  { tool: "run_shell", input: { command: "git push origin main" }, note: "危险，应硬拒" },
  { tool: "run_shell", input: { command: "rm -rf node_modules" }, note: "前缀撞 rm -rf，硬拒" },
  { tool: "read_file", input: { path: ".env.local" }, note: "密钥文件，硬拒" },
  { tool: "read_file", input: { path: "src/engine.ts" }, note: "源码，放行" },
  { tool: "run_shell", input: { command: "npm test" }, note: "不认识，问用户" },
  { tool: "write_file", input: { path: "src/new.ts" }, note: "写操作，问用户" },
];

const ICON = { allow: "✅ 放行", deny: "🚫 硬拒", ask: "❓ 问用户" };

function run(rules, attempts) {
  for (const a of attempts) {
    const { verdict, rule } = evaluatePermission(rules, a);
    const shown = a.input.command ?? a.input.path;
    const why = rule
      ? `命中规则 [${rule.verdict}${rule.commandPrefix ? ` "${rule.commandPrefix}…"` : ""}${rule.pathGlob ? ` ${rule.pathGlob}` : ""}]`
      : "无规则命中 → default";
    console.log(`  ${ICON[verdict].padEnd(7)} ${a.tool}(${shown})`);
    console.log(`          ${why}  ·  ${a.note}`);
  }
}

console.log("━━━ 场景 A：只有全局规则（首匹配 + 三态）━━━");
run(GLOBAL, ATTEMPTS);

// ─── 场景 B：workspace 覆盖 global ────────────────────────────────────────
// 这个项目是个 demo 沙箱，作者信得过它——预授权 npm test 和写 src/。
// workspace 规则排在 global 前面，于是同样两条请求的 verdict 反转了。
console.log("\n━━━ 场景 B：叠加 workspace 规则（项目里预授权，覆盖全局）━━━");
const WORKSPACE = [
  { verdict: "allow", tool: "run_shell", commandPrefix: "npm test" }, // 本项目免问
  { verdict: "allow", tool: "write_file", pathGlob: "src/**" }, // 本项目随便写 src
];
const merged = mergeRules(GLOBAL, WORKSPACE);
run(merged, [
  { tool: "run_shell", input: { command: "npm test" }, note: "被 workspace 提升为放行" },
  { tool: "write_file", input: { path: "src/new.ts" }, note: "被 workspace 提升为放行" },
  { tool: "run_shell", input: { command: "git push origin main" }, note: "global 的 deny 仍在，workspace 提不动" },
]);

console.log("\n关键：workspace 规则排在前 → 首匹配天然让项目规则覆盖全局；");
console.log("      但危险操作（git push）的 deny 在 global 里照样命中——放权是加白，不是拆闸。");
