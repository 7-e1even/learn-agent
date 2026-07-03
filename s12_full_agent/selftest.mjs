#!/usr/bin/env node
// selftest —— 免 key 的端到端验收：进程内起假模型服务器（mock-server.mjs），
// 把合体 agent 当成黑盒 spawn 出来，用管道喂它用户消息，然后在 stdout 里
// 找每个机制被触发的证据。
//
// 两幕：
//   第一幕（新会话）：流式打字机 → 工具真执行 → 大输出溢出 → 子代理卡死
//     被心跳看门狗击杀 + 遗言抢救 → 技能按需加载 → usage 越过阈值触发压缩。
//   第二幕（--resume）：先往会话日志里伪造一条"崩溃现场"（assistant 带
//     tool_calls 但没有工具结果、arguments 还断在 JSON 中间），再恢复会话 ——
//     验证重放 + 悬空调用修复 + 压缩快照都工作。
//
// 运行：node selftest.mjs   （退出码 0 = 全部通过）

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent } from "../s08_persistence/store.mjs";
import { createMockServer } from "./mock-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, "agent.mjs");
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** spawn 合体 agent，按 "你> " 提示符的出现节奏喂输入；inputs 走完就关 stdin。 */
function runAgent({ args = [], env = {}, inputs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT, ...args], {
      cwd: HERE,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let step = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`agent 超时未结束。已捕获输出：\n${out}`));
    }, 45_000);

    const feed = () => {
      // 第 N 个提示符出现 = 第 N-1 轮已收尾，可以喂第 N 句话（或收工）。
      const prompts = out.split("你> ").length - 1;
      while (step < prompts && step <= inputs.length) {
        if (step === inputs.length) {
          child.stdin.end(); // 没话说了：关 stdin，agent 干净退出
        } else {
          child.stdin.write(inputs[step] + "\n");
        }
        step++;
      }
    };
    child.stdout.on("data", (d) => {
      out += d;
      feed();
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out: stripAnsi(out), code });
    });
    child.on("error", reject);
  });
}

const checks = [];
function expect(name, transcript, re) {
  const m = transcript.match(re);
  checks.push({ name, pass: Boolean(m), evidence: m?.[0] });
}

// ─── 起假模型服务器 ──────────────────────────────────────────────────────

const server = createMockServer();
const { url } = await server.start();
console.log(`假模型服务器：${url}`);

const ENV = {
  AGENT_API_KEY: "mock-key",
  AGENT_BASE_URL: url,
  AGENT_MODEL: "mock-model",
  // 压缩阈值调到剧本能够到的位置：窗口 100k，75% 触发，最少 8 条消息。
  AGENT_CONTEXT_WINDOW: "100000",
  AGENT_COMPACT_PERCENT: "75",
  AGENT_COMPACT_MIN_MESSAGES: "8",
  // 子代理看门狗压进两秒内演完（生产值是 450 秒/10 分钟这个量级）。
  AGENT_SUB_HEARTBEAT_MS: "250",
  AGENT_SUB_STALE_IDLE_MS: "1200",
  AGENT_SUB_STALE_IN_TOOL_MS: "4000",
  AGENT_SUB_TIMEOUT_MS: "15000",
  AGENT_SUB_CONCLUDE_TIMEOUT_MS: "5000",
};

// ─── 第一幕：新会话，全机制过一遍 ────────────────────────────────────────

console.log("\n━━━ 第一幕：新会话，端到端演习 ━━━");
const a = await runAgent({ env: ENV, inputs: ["开始全流程演习", "收尾并汇报"] });

expect("进程干净退出（第一幕）", `exit=${a.code}`, /exit=0/);
expect("s08 会话落盘：分配了会话 id", a.out, /新会话 (ses_[a-z0-9_]+)/);
expect("s05 流式：剧本台词逐片流出并完整打印", a.out, /全流程演习收尾完毕。/);
expect("s02 工具真执行：run_shell 黄色行", a.out, /\$ node -e "console\.log\('hello from s12 selftest'\)"/);
expect("s03 循环预算：每步打印预算状态", a.out, /—— 循环第 \d+ 步（预算 12，硬顶 48）/);
expect("s07 缓存仪表盘：每轮命中率", a.out, /📊 prompt \d+ \| 命中 \d+（\d+\.\d%）/);
expect("s04 输出预算：120k 大输出溢出落盘", a.out, /⤵ 1 条超预算输出已溢出：.*\.agent-spill/);
expect("s09 子代理：task 派发", a.out, /task sub_[a-z0-9]+：调研 mock 环境并汇报/);
expect("s09 心跳看门狗：卡死子代理被击杀", a.out, /子代理 sub_[a-z0-9]+ 被看门狗击杀（stale/);
expect("s09 遗言回合：击杀后进入抢救", a.out, /进入遗言回合/);
expect("s10 技能按需加载：load_skill 黄色行", a.out, /load_skill git-commit-convention/);
expect("s06 压缩触发：usage 越过阈值", a.out, /🗜️ 触发压缩：\d+ tokens 已超过阈值 75000/);
expect("s06 压缩完成：历史被折叠", a.out, /🗜️ 压缩完成：压掉 \d+ 条/);

const sessionId = a.out.match(/新会话 (ses_[a-z0-9_]+)/)?.[1];

// ─── 第二幕：伪造崩溃现场，--resume 恢复 ─────────────────────────────────

let b = { out: "（第一幕没拿到会话 id，第二幕跳过）", code: -1 };
if (sessionId) {
  console.log(`\n━━━ 第二幕：伪造崩溃现场，--resume ${sessionId} ━━━`);
  // 往日志末尾补一条"死在半路"的 assistant：tool_calls 悬空、arguments 断裂 ——
  // 这正是进程在 tool_calls 落盘之后、工具结果落盘之前崩溃会留下的现场。
  appendEvent(path.join(HERE, ".sessions"), sessionId, {
    type: "message",
    message: {
      role: "assistant",
      content: "（模拟崩溃：这条消息的工具调用没有结果）",
      tool_calls: [
        { id: "call_crash_1", type: "function", function: { name: "run_shell", arguments: '{"command":"echo boom"' } },
      ],
    },
  });
  b = await runAgent({ env: ENV, args: ["--resume", sessionId], inputs: ["恢复检查：报告当前状态"] });
}

expect("进程干净退出（第二幕）", `exit=${b.code}`, /exit=0/);
expect("s08 恢复：事件重放重建会话", b.out, /已恢复会话 ses_/);
expect("s05×s08 崩溃修复：悬空 tool_call 被回填", b.out, /回填了 1 条合成工具结果/);
expect("恢复后对话继续（压缩快照生效、请求没有 400）", b.out, /会话已接上/);

// ─── 汇总 ────────────────────────────────────────────────────────────────

await server.close();

console.log("\n━━━ 验收结果 ━━━");
let failed = 0;
for (const c of checks) {
  const mark = c.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${mark} ${c.name}${c.pass ? `　→ ${c.evidence.slice(0, 76)}` : ""}`);
  if (!c.pass) failed++;
}
if (failed > 0) {
  console.log(`\n\x1b[31m${failed} 项未通过。完整输出：\x1b[0m\n${a.out}\n${b.out}`);
  process.exit(1);
}
console.log(`\n\x1b[32m全部 ${checks.length} 项通过 —— 前十一章的机制在同一个循环里各就各位。\x1b[0m`);
