// dag.mjs —— 多 agent 协作的骨架：任务 DAG + ready 集合 + 两道闸门 + 派发闸。
//
// 从真实产品 Reina 简化移植（packages/core/src/subtasks.ts 与
// controllers/subtask.ts、subagent/manager.ts），机制一致：
//   · TaskDag：子任务 + blockedBy 依赖边；ready 集合 = 依赖全部收口的待办
//   · 派活即绑定：bindDispatch 把节点标成 in_progress，物理上退出 ready 集合，
//     重复派同一个活变得不可能；worker 收口用 settle 自动回写节点状态
//   · PhaseController：两道闸门 —— handoff gate（离开一个工作阶段必须先写
//     交接记录）+ completeness gate（DAG 上还有非终态节点就不许宣布 complete）
//   · Dispatcher：并发上限 + 同 brief 去重（s09 子代理机制的团队版复用）

let seq = 0;
const nextId = (prefix) => `${prefix}_${(++seq).toString(36).padStart(3, "0")}`;

/** 终态：不再阻塞任何下游判断的状态。
 *  示例版从严：只有 completed 的依赖才放行下游（失败节点阻塞下游，
 *  逼协调者显式重试或取消）。Reina 的生产语义更宽（见 README 对照）。 */
const SETTLED = new Set(["completed", "cancelled"]);

export class TaskDag {
  #order = [];
  #byId = new Map();

  /** 建一个子任务节点。依赖必须已存在（先建上游再建下游，天然无环——
   *  环只可能在事后 addDependency 时出现，那里才需要 DFS 检查）。 */
  add({ title, blockedBy = [] }) {
    for (const dep of blockedBy) {
      if (!this.#byId.has(dep)) throw new Error(`未知依赖 "${dep}"——先创建上游节点`);
    }
    const node = {
      id: nextId("sub"),
      title,
      status: blockedBy.every((d) => this.#byId.get(d).status === "completed") ? "pending" : "blocked",
      blockedBy: [...blockedBy],
      blocks: [],       // 反向边，settle 时用来级联解锁
      attempts: 0,      // 派发次数（重试会 +1）
      workerIds: [],    // 绑定过的 worker，最后一个是"现任"
      resultSummary: undefined,
    };
    this.#byId.set(node.id, node);
    this.#order.push(node.id);
    for (const dep of blockedBy) this.#byId.get(dep).blocks.push(node.id);
    return { ...node };
  }

  /** 事后补一条依赖边。加边前从 target 沿 blocks 边做一次 DFS ——
   *  如果能走到 dep，说明 dep 在 target 下游，加这条边就成环了。 */
  addDependency(id, depId) {
    const node = this.#must(id);
    const dep = this.#must(depId);
    if (id === depId) throw new Error(`不能给 ${id} 加自己作依赖`);
    const stack = [id];
    const seen = new Set();
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === depId) throw new Error(`加边 ${depId}→${id} 会成环：${depId} 已在 ${id} 的下游`);
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.#byId.get(cur).blocks);
    }
    node.blockedBy.push(depId);
    dep.blocks.push(id);
    if (node.status === "pending" && !SETTLED.has(dep.status)) node.status = "blocked";
  }

  /** ready 集合：待办、且每条依赖都已 completed 的节点。
   *  协调者的每一步派发决策都从这里取——而不是自己心算依赖。 */
  ready() {
    return this.list().filter(
      (n) => n.status === "pending" && n.blockedBy.every((d) => this.#byId.get(d).status === "completed"),
    );
  }

  /** 派活即绑定：把 worker 绑到节点上，节点立刻 in_progress。
   *  绑定的一瞬间它就退出了 ready 集合——"重复派同一个活"在数据结构层面
   *  变得不可能，不依赖协调者记性好。失败节点允许再次绑定 = 重试。 */
  bindDispatch(id, workerId) {
    const node = this.#must(id);
    if (node.status === "in_progress") {
      return { ok: false, reason: "in_flight", message: `${id} 已在派发中（worker ${node.workerIds.at(-1)}），不重复派活` };
    }
    if (node.status === "completed" || node.status === "cancelled") {
      return { ok: false, reason: "settled", message: `${id} 已收口（${node.status}），无活可派` };
    }
    const waiting = node.blockedBy.filter((d) => this.#byId.get(d).status !== "completed");
    if (waiting.length > 0) {
      return { ok: false, reason: "not_ready", message: `${id} 依赖未就绪：还差 ${waiting.join("、")}` };
    }
    node.status = "in_progress";
    node.attempts++;
    node.workerIds.push(workerId);
    return { ok: true };
  }

  /** worker 收口时自动回写节点状态——协调者忘了标记也不会卡死 DAG。
   *  现任校验：只有节点"最新一次"绑定的 worker 有资格回写。重试之后，
   *  上一次尝试的迟到结果不能覆盖新尝试（Reina 的 active-binding 规则）。 */
  settle(id, { workerId, ok, summary }) {
    const node = this.#must(id);
    if (node.workerIds.at(-1) !== workerId) {
      return { ok: false, message: `忽略过期回写：${workerId} 不是 ${id} 的现任 worker` };
    }
    node.status = ok ? "completed" : "failed";
    node.resultSummary = summary;
    const unblocked = [];
    if (ok) {
      // 级联解锁：本节点收口后，重查每个下游——依赖全齐的从 blocked 翻成 pending
      for (const childId of node.blocks) {
        const child = this.#byId.get(childId);
        if (child.status !== "blocked") continue;
        if (child.blockedBy.every((d) => this.#byId.get(d).status === "completed")) {
          child.status = "pending";
          unblocked.push(childId);
        }
      }
    }
    return { ok: true, unblocked };
  }

  cancel(id, reason) {
    const node = this.#must(id);
    node.status = "cancelled";
    node.resultSummary = reason;
  }

  /** 非终态节点：完备性闸门的证据来源。 */
  unsettled() {
    return this.list().filter((n) => !SETTLED.has(n.status));
  }

  list() {
    return this.#order.map((id) => ({ ...this.#byId.get(id) }));
  }

  #must(id) {
    const node = this.#byId.get(id);
    if (!node) throw new Error(`未知子任务 "${id}"——用 list() 查有效 id`);
    return node;
  }
}

// ─── 两道闸门 ────────────────────────────────────────────────────────────

/** 需要交接记录才能离开的"工作阶段"。complete / failed 是终点不是阶段。 */
const WORKING_PHASES = new Set(["plan", "exec", "verify"]);

export class PhaseController {
  #phase = null;
  #handoffs = [];        // { phase, text }
  #baselineCount = 0;    // 进入当前阶段时已有的交接数——旧交接不算数

  constructor(dag) {
    this.dag = dag;
  }

  get phase() {
    return this.#phase;
  }

  /** 交接记录：这一阶段决定了什么、否决了什么、遗留什么。
   *  写给下一阶段的 worker 和未来的自己看。 */
  writeHandoff(text) {
    this.#handoffs.push({ phase: this.#phase, text });
  }

  setPhase(next) {
    if (next === this.#phase) return { ok: true };

    // 闸门一（先查）：完备性 —— DAG 上还有非终态节点就不许宣布 complete。
    // 证据是引擎手里的 DAG 状态，不是协调者的一句"我做完了"。
    if (next === "complete") {
      const unsettled = this.dag.unsettled();
      if (unsettled.length > 0) {
        const preview = unsettled.map((n) => `${n.id} [${n.status}] ${n.title}`).join("；");
        return {
          ok: false,
          error:
            `拒绝进入 complete：还有 ${unsettled.length} 个子任务未收口 —— ${preview}。` +
            `每个节点必须 completed 或明确 cancelled。要放弃整个任务请用 setPhase("failed")——那条路不设闸。`,
        };
      }
    }

    // 闸门二：handoff —— 离开一个工作阶段，必须有"本阶段新写的"交接记录。
    // 进入当前阶段前的旧交接不算（防止一份交接吃两次），→ failed 不设闸（逃生口）。
    if (WORKING_PHASES.has(this.#phase) && next !== "failed") {
      if (this.#handoffs.length <= this.#baselineCount) {
        return {
          ok: false,
          error:
            `拒绝 ${this.#phase} → ${next}：还没为"${this.#phase}"阶段写交接记录。` +
            `先 writeHandoff("决定了什么 / 否决了什么 / 遗留什么")，再重试 setPhase。`,
        };
      }
    }

    this.#phase = next;
    this.#baselineCount = this.#handoffs.length; // 重新划基线：下次转移需要新的交接
    return { ok: true };
  }
}

// ─── 派发闸：并发上限 + 同 brief 去重（s09 机制的团队版）────────────────

export class Dispatcher {
  #running = new Map(); // workerId -> briefKey
  #briefs = new Map();  // briefKey -> workerId

  constructor({ maxConcurrent = 2 } = {}) {
    this.maxConcurrent = maxConcurrent;
  }

  /** 申请一个派发名额。两个否决理由要区分开——duplicate 该合并到在飞任务，
   *  capacity 该等待，处置完全不同，混成一个错误模型就没法自愈。 */
  acquire(briefKey) {
    const existing = this.#briefs.get(briefKey);
    if (existing) {
      return { ok: false, reason: "duplicate", message: `相同 brief 已在飞（${existing}），合并等待它的结果，不再重复派` };
    }
    if (this.#running.size >= this.maxConcurrent) {
      return {
        ok: false,
        reason: "capacity",
        message: `并发已满（${this.#running.size}/${this.maxConcurrent}），等一个在飞任务收口再派新活`,
      };
    }
    const workerId = nextId("w");
    this.#running.set(workerId, briefKey);
    this.#briefs.set(briefKey, workerId);
    return { ok: true, workerId };
  }

  release(workerId) {
    const briefKey = this.#running.get(workerId);
    this.#running.delete(workerId);
    if (briefKey !== undefined) this.#briefs.delete(briefKey);
  }

  get inFlight() {
    return this.#running.size;
  }
}
