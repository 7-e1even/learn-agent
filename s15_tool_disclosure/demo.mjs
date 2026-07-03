#!/usr/bin/env node
// s15 免 key 演示 —— 工具多了，"按需披露"怎么才不撞缓存（接 s07）。
//   坏做法：搜到就把工具"回灌"进 tools 数组 → 每解蔽一次，前缀断一次
//   好做法：搜到的工具永不进数组，调用走一个稳定的代理工具 → 数组字节恒定
//
// tools 数组紧跟 system 之后，是 prompt cache 前缀的一部分（s07 讲过）。
// 数组一变，前缀就断，后面全按全价重算。这里用字符近似把"断在哪"算给你看。
//
// 运行：node s15_tool_disclosure/demo.mjs

// ─── 工具库：3 个常驻(direct) + 一堆不常用(deferred) ─────────────────────
const DIRECT = [
  { name: "run_shell", description: "执行一条 shell 命令" },
  { name: "read_file", description: "读取一个文本文件" },
  { name: "search_tool", description: "按关键词检索未加载的工具" },
];
const DEFERRED = [
  { name: "schedule_wakeup", description: "安排一次未来的模型回合" },
  { name: "convene_panel", description: "召集多个子代理并行评审" },
  { name: "recall_memory_chunk", description: "把压缩掉的历史片段逐字召回" },
  { name: "create_subtask", description: "在任务 DAG 上新建一个子任务" },
  { name: "notify_user", description: "向用户发一条系统通知" },
];

const serialize = (tools) => JSON.stringify(tools); // 服务商看到的 tools 块字节流
const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

function reportTurns(label, arraysByTurn) {
  console.log(`━━━ ${label} ━━━`);
  let misses = 0;
  for (let t = 1; t < arraysByTurn.length; t++) {
    const prev = serialize(arraysByTurn[t - 1]);
    const cur = serialize(arraysByTurn[t]);
    const n = commonPrefix(prev, cur);
    const reuse = ((n / prev.length) * 100).toFixed(0);
    const hit = n === prev.length;
    if (!hit) misses++;
    console.log(
      `  第 ${t}↔${t + 1} 轮：tools ${prev.length}→${cur.length} 字节 · 公共前缀复用 ${reuse}% ` +
        (hit ? "✅ 前缀稳定" : "❌ 前缀击穿（tools 块变了 → 本轮全价）"),
    );
  }
  console.log(`  → 4 轮里发生 ${misses} 次 tools 前缀击穿\n`);
}

// ─── 坏做法：模型每轮搜到一个 deferred 工具，就把它加进 tools 数组 ─────────
// 冷启动确实省了（数组小），但每解蔽一次，下一轮数组就变大 → 撞一次 cache miss。
const badTurns = [DIRECT.slice()];
for (let i = 0; i < 3; i++) {
  const grown = [...badTurns[badTurns.length - 1], DEFERRED[i]]; // 解蔽 → 回灌数组
  badTurns.push(grown);
}
reportTurns("坏做法：解蔽即回灌 tools 数组", badTurns);

// ─── 好做法：加一个稳定的代理工具，deferred 工具永不进数组 ─────────────────
// 模型搜工具，schema 通过【搜索结果文本】（进 messages，不进 tools）给它；
// 真正调用走那个常驻的 run_tool({ name, input })。于是 tools 数组每轮字节恒定。
const DIRECT_WITH_PROXY = [
  ...DIRECT,
  { name: "run_tool", description: "按名字调用任何已检索到的工具：run_tool({name,input})" },
];
const goodTurns = [DIRECT_WITH_PROXY, DIRECT_WITH_PROXY, DIRECT_WITH_PROXY, DIRECT_WITH_PROXY];
reportTurns("好做法：稳定代理，数组恒定", goodTurns);

console.log("关键：冷启动省 token 只是第一步；真正的账在'解蔽之后数组还稳不稳'。");
console.log("      Anthropic 没有服务端 defer，披露逻辑只能压在客户端——被搜到的工具永不回灌数组。");
