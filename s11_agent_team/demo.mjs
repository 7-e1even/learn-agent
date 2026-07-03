#!/usr/bin/env node
// s11 免 key 演示：任务 DAG 上的"拆-派-收"。
//
//   node s11_agent_team/demo.mjs
//
// 剧本：一个真实形状的大任务 ——"重构模块 + 补测试 + 更新文档"，拆成 5 个
// 带依赖的子任务，交给假 worker（随机耗时，其中"补测试"第一次必失败）。
// 四幕看点：
//   一、建图：环检测拒绝坏依赖；handoff 闸门拦住没写交接就翻篇的协调者
//   二、并行派发 ready 任务：依赖解锁、并发上限拒载、同 brief 去重
//   三、失败节点阻塞下游；完备性闸门拒绝"提前收工"
//   四、重试收口、写完交接，complete 才放行

import { TaskDag, PhaseController, Dispatcher } from "./dag.mjs";

const dag = new TaskDag();
const phases = new PhaseController(dag);
const dispatcher = new Dispatcher({ maxConcurrent: 2 });

const t0 = Date.now();
const log = (msg) => console.log(`  [+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const bar = (title) => console.log(`\n━━━ ${title} ━━━\n`);
const gate = (r) => (r.ok ? log("✅ 放行") : log(`🚧 ${r.error}`));

// ─── 假 worker：随机耗时；可脚本化指定失败 ──────────────────────────────

function fakeWorker(node, { fail = false } = {}) {
  const ms = 150 + Math.floor(Math.random() * 250);
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve(
          fail
            ? { ok: false, summary: "测试跑挂：3 个用例断言失败（fixture 里的旧接口没同步重构）" }
            : { ok: true, summary: `${node.title} 完成` },
        ),
      ms,
    ),
  );
}

/** 协调者的派发动作：先过派发闸（并发/去重），再绑定 DAG 节点，
 *  worker 收口时自动 settle 回写 —— 全程不依赖协调者"记得"更新状态。 */
async function dispatch(node, opts = {}) {
  const grant = dispatcher.acquire(`重构小队:${node.title}`);
  if (!grant.ok) {
    log(`🚫 拒绝派发「${node.title}」：${grant.message}`);
    return null;
  }
  const bind = dag.bindDispatch(node.id, grant.workerId);
  if (!bind.ok) {
    dispatcher.release(grant.workerId);
    log(`🚫 拒绝派发「${node.title}」：${bind.message}`);
    return null;
  }
  const attempt = dag.list().find((n) => n.id === node.id).attempts;
  log(`▶ 派发 ${node.id}「${node.title}」→ ${grant.workerId}（第 ${attempt} 次尝试）`);
  const result = await fakeWorker(node, opts);
  dispatcher.release(grant.workerId);
  const settled = dag.settle(node.id, { workerId: grant.workerId, ...result });
  const mark = result.ok ? "✔" : "❌";
  log(`${mark} ${node.id}「${node.title}」${result.ok ? "完成" : `失败：${result.summary}`}`);
  if (settled.unblocked?.length > 0) {
    const names = settled.unblocked.map((id) => dag.list().find((n) => n.id === id).title);
    log(`  ↳ 级联解锁：${names.join("、")} 进入 ready 集合`);
  }
  return settled;
}

const readyTitles = () => dag.ready().map((n) => `「${n.title}」`).join("") || "（空）";

// ─── 第一幕：建图（plan 阶段）───────────────────────────────────────────

bar("第一幕：拆任务，建 DAG（plan 阶段）");
phases.setPhase("plan");

const A = dag.add({ title: "梳理模块现状" });
const B = dag.add({ title: "重构核心逻辑", blockedBy: [A.id] });
const C = dag.add({ title: "补单元测试", blockedBy: [B.id] });
const D = dag.add({ title: "更新文档", blockedBy: [A.id] });
const E = dag.add({ title: "整体验收", blockedBy: [C.id, D.id] });

for (const n of dag.list()) {
  log(`${n.id}「${n.title}」 依赖：${n.blockedBy.join("、") || "无"}  状态：${n.status}`);
}

log("协调者想加边「梳理现状 依赖 整体验收」（写反了）：");
try {
  dag.addDependency(A.id, E.id);
} catch (err) {
  log(`🚫 ${err.message}`);
}

log('协调者想直接 setPhase("exec")（还没写 plan 阶段的交接）：');
gate(phases.setPhase("exec"));
phases.writeHandoff("拆成 5 个子任务；关键路径 梳理→重构→测试→验收；文档与测试并行。");
log("写完交接记录，重试：");
gate(phases.setPhase("exec"));

// ─── 第二幕：并行派发与依赖解锁（exec 阶段）─────────────────────────────

bar("第二幕：并行派发 ready 任务");

log(`ready 集合：${readyTitles()}`);
log("协调者手滑想先派「重构核心逻辑」（依赖未就绪）：");
await dispatch(B); // bindDispatch 拒绝：not_ready

await dispatch(A); // 收口后级联解锁 B、D
log(`ready 集合：${readyTitles()}`);

// B、D 同时 ready → 并行派发（2/2 打满并发上限）
const inFlight = [dispatch(B), dispatch(D)];
log(`在飞 ${dispatcher.inFlight}/${dispatcher.maxConcurrent}，协调者手痒想再开一个顺手任务：`);
const extra = dispatcher.acquire("重构小队:顺手跑一遍全量 lint");
if (!extra.ok) log(`🚫 ${extra.message}`);
log("同一个 brief 再派一次（协调者忘了刚派过「更新文档」）：");
const dup = dispatcher.acquire("重构小队:更新文档");
if (!dup.ok) log(`🚫 ${dup.message}`);
await Promise.all(inFlight);

log(`ready 集合：${readyTitles()}`);
await dispatch(C, { fail: true }); // 补测试：第一次必失败
log(`「补单元测试」失败 → 下游「整体验收」保持 blocked。ready 集合：${readyTitles()}`);

// ─── 第三幕：提前收工被完备性闸门拦下 ───────────────────────────────────

bar("第三幕：协调者急着宣布 complete");

gate(phases.setPhase("complete"));

log("被闸门点名后，协调者重派失败节点：");
await dispatch(C); // 重试成功 → 级联解锁 E
await dispatch(E);

// ─── 第四幕：全收口，闸门放行 ───────────────────────────────────────────

bar("第四幕：全收口后再过闸");

log('DAG 已全收口，但 exec 阶段还没写交接，setPhase("complete")：');
gate(phases.setPhase("complete"));
phases.writeHandoff("重构+测试+文档全部收口；补测试重试 1 次（fixture 旧接口）；验收通过。");
log("写完交接记录，重试：");
gate(phases.setPhase("complete"));

console.log("\n最终 DAG：");
for (const n of dag.list()) {
  console.log(`  ${n.id}「${n.title}」 ${n.status}（尝试 ${n.attempts} 次）— ${n.resultSummary ?? ""}`);
}
