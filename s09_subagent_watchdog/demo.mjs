#!/usr/bin/env node
// 不需要 API key 的心跳看门狗演示：用"事件流可编剧"的假子代理，
// 亲眼看四种命运 —— 正常完成 / 闲置卡死被抓 / 工具中宽限不误杀 / 硬顶到点但还活着获得延长。
//
//   node s09_subagent_watchdog/demo.mjs
//
// 阈值按比例缩小到毫秒级方便观察（生产值见 subagent.mjs 的 PROD_LIMITS）。

import { concludePrompt, runChildWithWatchdog } from "./subagent.mjs";

const DEMO_LIMITS = {
  timeoutMs: 2_000,      // 墙钟硬顶（生产 600s）
  heartbeatMs: 50,       // 看门狗醒来间隔（生产 10s）
  staleIdleMs: 400,      // 闲置 stale 预算（生产 450s）
  staleInToolMs: 1_600,  // 工具在途 stale 预算（生产 1200s）
  healthyRecentMs: 200,  // 活性窗口（生产 30s）
  healthyExtendMs: 600,  // 活性延期（生产 300s）
  concludeTimeoutMs: 500,
};

/** 剧本假子代理：按时间表发事件、进出工具、（也许）交卷。
 *  beats: [{ at, kind: "event" | "toolStart" | "toolEnd" }]
 *  finishAt 为 null = 永远不交卷（卡死），只有 interrupt 能让它停。 */
function scriptedChild({ beats = [], finishAt = null, result = "" }) {
  const listeners = new Set();
  let inTool = false;
  let timers = [];
  let stop = null;
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isInTool: () => inTool,
    interrupt() {
      for (const t of timers) clearTimeout(t);
      stop?.(null); // 被击杀：什么也交不出来
    },
    run() {
      return new Promise((resolve) => {
        stop = resolve;
        for (const b of beats) {
          timers.push(
            setTimeout(() => {
              if (b.kind === "toolStart") inTool = true;
              if (b.kind === "toolEnd") inTool = false;
              for (const cb of listeners) cb();
            }, b.at),
          );
        }
        if (finishAt != null) {
          timers.push(
            setTimeout(() => {
              for (const t of timers) clearTimeout(t);
              resolve(result);
            }, finishAt),
          );
        }
      });
    },
  };
}

const everyN = (interval, until, kind = "event") =>
  Array.from({ length: Math.floor(until / interval) }, (_, i) => ({ at: (i + 1) * interval, kind }));

async function play(title, child, note) {
  console.log(`\n━━━ ${title} ━━━`);
  const hooks = {
    onKill: (reason, ms) =>
      console.log(`  🔴 看门狗击杀（${reason}，${reason === "stale" ? "已闲置" : "已运行"} ${Math.round(ms)}ms）`),
    onExtend: (ms, n) => console.log(`  🟢 硬顶到点，但最近 ${DEMO_LIMITS.healthyRecentMs}ms 内有事件 → 延长 ${ms}ms（第 ${n} 次）`),
  };
  const outcome = await runChildWithWatchdog(child, DEMO_LIMITS, hooks);
  console.log(`  结局：disposition=${outcome.disposition}，耗时 ${Math.round(outcome.durationMs)}ms，延期 ${outcome.extensions} 次`);
  if (outcome.result) console.log(`  交付：${outcome.result}`);
  if (note) console.log(`  ${note}`);
  return outcome;
}

// 场景一：正常完成。每 100ms 一个事件（流 token/工具调用），600ms 交卷。
await play(
  "场景一：正常完成",
  scriptedChild({ beats: everyN(100, 500), finishAt: 600, result: "结论：Auth 模块在 3 处被引用，列表如下…" }),
);

// 场景二：闲置卡死。发了两个事件之后彻底沉默（模型流断了/进程 hang 死），
// 永不交卷 —— s03 的行为看门狗对此束手无策（循环根本不转），心跳看门狗抓它。
const stale = await play(
  "场景二：闲置卡死被抓",
  scriptedChild({ beats: [{ at: 100, kind: "event" }, { at: 200, kind: "event" }], finishAt: null }),
  `（最后一个事件在 t=200ms，闲置预算 ${DEMO_LIMITS.staleIdleMs}ms → t≈600ms 判死）`,
);

// 击杀之后的第二阶段：遗言回合。同一个子代理换一个短 prompt 再跑一小圈，
// 抢救它已完成的工作 —— 演示里用另一个剧本代表"complete 的遗言回合"。
console.log(`\n  ↳ 击杀不是终点：给它一个遗言回合（prompt 开头：${concludePrompt("stale", stale.durationMs).split("\n")[0].slice(0, 38)}…）`);
const conclude = await runChildWithWatchdog(
  scriptedChild({
    beats: [{ at: 60, kind: "event" }],
    finishAt: 140,
    result: "1) 原任务：定位 Auth 引用；2) 已确认 src/login.js、src/api.js 两处；3) 还差测试目录没搜。",
  }),
  { ...DEMO_LIMITS, timeoutMs: DEMO_LIMITS.concludeTimeoutMs },
);
console.log(`  遗言（disposition=${conclude.disposition}）：${conclude.result}`);
console.log("  → 已完成的两处发现被抢救回主 agent，而不是全部作废。");

// 场景三：工具中宽限。进入工具后沉默 1200ms —— 早超过闲置预算 400ms，
// 但工具在途预算是 1600ms（跑测试真的很慢），一刀切会误杀，两档预算不会。
await play(
  "场景三：工具运行中，宽限不误杀",
  scriptedChild({
    beats: [{ at: 100, kind: "event" }, { at: 150, kind: "toolStart" }, { at: 1350, kind: "toolEnd" }, { at: 1360, kind: "event" }],
    finishAt: 1500,
    result: "测试跑完：47 通过 0 失败。",
  }),
  `（工具里沉默了 1200ms > 闲置预算 ${DEMO_LIMITS.staleIdleMs}ms，但 < 在途预算 ${DEMO_LIMITS.staleInToolMs}ms）`,
);

// 场景四：硬顶到点但还活着。每 100ms 都有事件的勤奋子代理，撞上 2000ms 硬顶 ——
// 活性检查发现它最近 200ms 内有动静 → 延长 600ms 再看，2400ms 顺利交卷。
await play(
  "场景四：硬顶到点但还活着，获得延长",
  scriptedChild({ beats: everyN(100, 2300), finishAt: 2400, result: "梳理完 12 个文件的调用关系，报告如下…" }),
  "（勤奋的不误杀；要是它延期后开始躺平，闲置预算照样抓它 —— 延长不是免死金牌）",
);

console.log(`
结论：
  · 心跳看门狗管"卡死"，s03 的行为看门狗管"转圈"—— 一个看时间，一个看行为，缺一不可。
  · 两档 stale 预算：闲置从严、工具在途从宽 —— 跑测试很慢是常态，一刀切必然误杀。
  · 墙钟硬顶 + 活性延期：到点先验尸，最近有事件就续命 —— 勤奋的不误杀，卡死的必被抓。
  · 击杀后还有遗言回合：抢救已完成的工作，别让 10 分钟的探索全部作废。
`);
