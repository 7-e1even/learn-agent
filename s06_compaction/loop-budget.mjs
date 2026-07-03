// 循环预算 —— agent 的防空转看门狗。
//
// 从真实产品 Reina 的 packages/core/src/loop-budget.ts 简化移植，机制一致：
//   · 软预算 + 硬顶（4 倍）：有进展就自动续期，真正失控才熔断
//   · 三个行为探测器：复读机 / 原地踏步 / 连环报错
//   · 熔断不是死刑：可恢复的停止先给模型一次"自我纠偏"的机会
//
// 演示阈值调小了方便观察（生产值见 README）。

export class LoopBudget {
  constructor({
    baseSteps = 12,
    hardMaxSteps,
    stagnationLimit = 5,
    repeatedActionLimit = 4,
    consecutiveErrorLimit = 3,
  } = {}) {
    this.baseSteps = baseSteps;
    this.hardMaxSteps = hardMaxSteps ?? baseSteps * 4;
    this.stagnationLimit = stagnationLimit;
    this.repeatedActionLimit = repeatedActionLimit;
    this.consecutiveErrorLimit = consecutiveErrorLimit;
    this.seenActions = new Map(); // "工具名:参数指纹" -> 出现次数
    this.noProgressTurns = 0;
    this.consecutiveErrorTurns = 0;
    this.budget = this.baseSteps;
    this.turns = 0;
  }

  canContinue() {
    return this.turns < this.budget;
  }

  /** 每执行完一轮工具调用喂一次。返回 undefined = 继续，返回 stop 对象 = 熔断。
   *  records: [{ name, input, status: "completed"|"failed", output }] */
  recordTurn(records) {
    this.turns++;
    const counts = records.map((r) => this.#recordAction(r));
    const hasProgress = records.some((r, i) => isProgress(r, counts[i]));
    const hasRepeated = counts.some((c) => c >= this.repeatedActionLimit);
    const onlyErrors = records.length > 0 && records.every((r) => r.status === "failed");

    // 两个计数器：有进展就清零，说明 agent 还活着；持续无进展/持续报错才累积。
    this.noProgressTurns = hasProgress ? 0 : this.noProgressTurns + 1;
    this.consecutiveErrorTurns = onlyErrors ? this.consecutiveErrorTurns + 1 : 0;

    if (hasRepeated && !hasProgress) return this.#stop("repeated_action");
    if (this.consecutiveErrorTurns >= this.consecutiveErrorLimit) return this.#stop("consecutive_errors");
    if (this.noProgressTurns >= this.stagnationLimit) return this.#stop("no_progress");

    // 自动续期：有进展、且预算只剩 2 轮，就再给一份 baseSteps（封顶 hardMax）。
    // 勤奋的 agent 不该被一刀切的上限打断，失控的 agent 也不该无限烧钱。
    if (hasProgress && this.turns >= this.budget - 2 && this.budget < this.hardMaxSteps) {
      this.budget = Math.min(this.hardMaxSteps, this.budget + this.baseSteps);
    }
    return undefined;
  }

  exhaustedStop() {
    return this.#stop(this.budget >= this.hardMaxSteps ? "hard_max_steps" : "max_steps");
  }

  #recordAction(record) {
    // 参数做稳定序列化（key 排序），结构相同的调用无论字段顺序都算同一个动作。
    const key = `${record.name}:${stableStringify(record.input)}`;
    const count = (this.seenActions.get(key) ?? 0) + 1;
    this.seenActions.set(key, count);
    return count;
  }

  #stop(reason) {
    return {
      reason,
      message: MESSAGES[reason],
      turnCount: this.turns,
      maxSteps: this.budget,
      hardMaxSteps: this.hardMaxSteps,
    };
  }
}

/** 什么算"进展"？——写操作永远算；读操作只有第一次算。
 *  第二次跑同一条命令、读同一个文件，世界没有变化，不算进展。 */
function isProgress(record, actionCount) {
  if (record.status !== "completed") return false;
  if (["write_file", "edit_file"].includes(record.name)) return true;
  return Boolean(record.output?.trim()) && actionCount === 1;
}

export const MESSAGES = {
  no_progress: "连续多轮没有新进展，暂停。",
  repeated_action: "同一个工具动作被反复执行，暂停。",
  consecutive_errors: "连续多轮全部报错，暂停。",
  max_steps: "达到本轮工具预算，暂停。",
  hard_max_steps: "达到硬性上限，强制停止。",
};

/** 行为异常（复读/停滞/连环报错）可以给模型一次自我纠偏的机会；
 *  预算耗尽（max_steps 系）说明该歇了，直接交还用户。 */
export function isRecoverable(stop) {
  return ["no_progress", "repeated_action", "consecutive_errors"].includes(stop.reason);
}

/** 纠偏 prompt：告诉模型它被暂停的原因和当前状态，并明确指令 ——
 *  别重复原动作；先总结、找到卡点、换一条路；实在不行就问用户。 */
export function repairPrompt(stop) {
  return [
    `自动纠偏触发：${stop.message}`,
    `循环状态：原因=${stop.reason}，已用 ${stop.turnCount} 轮，预算 ${stop.maxSteps}，硬顶 ${stop.hardMaxSteps}。`,
    "不要再重复同样的工具调用或失败的命令。先总结目前发生了什么、找出卡点，换一条不同的路。如果任务被阻塞或有歧义，向用户提一个具体的问题，而不是继续空转。",
  ].join("\n");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}
