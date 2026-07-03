// 子代理与心跳看门狗 —— 上下文隔离的脏活外包 + 基于时间的卡死检测。
//
// 从真实产品 Reina 的 packages/core/src/subagent/manager.ts 简化移植，机制一致：
//   · 心跳看门狗：子代理每产生一个事件就刷新 lastEventAt，
//     看门狗每 heartbeatMs 醒来一次比对 —— 管的是"卡死"，不是"转圈"
//   · 两档 stale 预算：闲置判死快，工具运行中放宽（跑测试真的很慢）
//   · 墙钟硬顶 + 活性延期：硬顶到点但最近还有事件 = 还活着，延长再看
//   · 击杀不是终点：外面还有一次"遗言"回合（见 agent.mjs 的 salvage）
//   · 同 brief 去重：一样的任务已有活着的子代理在跑，就别再花一份钱
//
// 生产阈值（Reina 真实常量，全部可用环境变量覆盖）：
export const PROD_LIMITS = {
  timeoutMs: 600_000,      // DEFAULT_SUBAGENT_TIMEOUT_MS：单个子代理墙钟硬顶 10 分钟
  heartbeatMs: 10_000,     // HEARTBEAT_INTERVAL_MS：看门狗每 10 秒醒来一次
  staleIdleMs: 450_000,    // STALE_IDLE_MS：闲置 450 秒无事件 → 判卡死
  staleInToolMs: 1_200_000,// STALE_IN_TOOL_MS：工具运行中放宽到 20 分钟
  healthyRecentMs: 30_000, // HEALTHY_RECENT_MS：硬顶到点时，30 秒内有事件 = 还活着
  healthyExtendMs: 300_000,// HEALTHY_EXTEND_MS：活着的子代理获得 5 分钟延期
  concludeTimeoutMs: 90_000, // 遗言回合自己的硬顶（遗言不能也无限跑）
};

/**
 * 给一个子代理回合套上心跳看门狗 + 墙钟硬顶。
 *
 * child 只需要四个能力（agent.mjs 的真子代理和 demo.mjs 的剧本假子代理都实现它）：
 *   run()          开始干活，返回 Promise<最终回复>；被 interrupt 后应尽快返回
 *   interrupt()    请求中断（协作式：中止在途的模型请求、在轮次边界停下）
 *   subscribe(cb)  订阅事件流（每个流 token / 每次工具调用都算一个事件），返回退订函数
 *   isInTool()     此刻是否有工具在运行中（决定用哪档 stale 预算）
 *
 * 返回 { disposition, result, durationMs, extensions }：
 *   completed = 自己跑完 | stale = 被心跳看门狗击杀 | timeout = 被墙钟硬顶击杀
 */
export async function runChildWithWatchdog(child, limits, hooks = {}) {
  const started = Date.now();
  let disposition = "completed";
  let extensions = 0;

  // 心跳的全部真相就这一行：活着的标志是"最近产生过事件"。
  let lastEventAt = Date.now();
  const unsubscribe = child.subscribe(() => {
    lastEventAt = Date.now();
  });

  // 心跳看门狗：定期醒来量一次"多久没动静了"。
  // 注意它和 s03 行为看门狗的分工 —— 行为看门狗活在循环里，循环不转它就瞎了；
  // 心跳看门狗活在循环外面的定时器上，专抓"循环根本不转"的物理卡死。
  const heartbeat = setInterval(() => {
    const idleMs = Date.now() - lastEventAt;
    // 两档预算：工具运行中（跑测试/装依赖）沉默很正常，一刀切会误杀。
    const limit = child.isInTool() ? limits.staleInToolMs : limits.staleIdleMs;
    if (idleMs > limit) {
      disposition = "stale";
      hooks.onKill?.("stale", idleMs);
      child.interrupt();
    }
  }, limits.heartbeatMs);

  // 墙钟硬顶：自我重排的定时器。到点先验尸 —— 最近还有事件说明在勤奋干活，
  // 给一段延期再看；真死了才击杀。勤奋的不误杀，卡死的必被抓（上面的
  // 心跳看门狗兜底），这和 s03"软预算 + 硬顶"是同一套哲学的时间版。
  let timer;
  const scheduleTimeout = (delay) =>
    setTimeout(() => {
      if (Date.now() - lastEventAt < limits.healthyRecentMs) {
        extensions++;
        hooks.onExtend?.(limits.healthyExtendMs, extensions);
        timer = scheduleTimeout(limits.healthyExtendMs);
        return;
      }
      disposition = "timeout";
      hooks.onKill?.("timeout", Date.now() - started);
      child.interrupt();
    }, delay);
  timer = scheduleTimeout(limits.timeoutMs);

  try {
    const result = await child.run();
    return { disposition, result, durationMs: Date.now() - started, extensions };
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timer);
    unsubscribe();
  }
}

/** 遗言回合的 prompt：被击杀的子代理还有一次短回合"总结你做到哪了"。
 *  三问结构照抄 Reina 的 conclude prompt：原任务是什么 / 完成了哪些具体
 *  步骤 / 还差什么、下一步该怎么走。明确禁止继续干活。 */
export function concludePrompt(reason, durationMs) {
  return [
    `【遗言回合 —— 你上一轮被监督者中止了（原因：${reason}，已运行 ${Math.round(durationMs / 1000)} 秒）。】`,
    "不要再调用任何工具、不要继续原任务。用一段简短的结构化自述回答：",
    "1. 原任务是什么？",
    "2. 你完成了哪些具体步骤（碰过的文件、确认过的事实、验证过的假设）？",
    "3. 还差什么没做完？下一步合理的做法是什么？",
    "只描述和建议，不要开始新的探索。",
  ].join("\n");
}

/** brief 归一化：去首尾空白、压空格、转小写、截断。
 *  "查一下  Auth 模块" 和 "查一下 auth 模块" 是同一个任务 ——
 *  弱模型爱重发一模一样的任务描述，语义级去重能省下一份完整的子代理开销。 */
export function normalizeBrief(description) {
  return description.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 240);
}
