#!/usr/bin/env node
// s09 —— 子代理与心跳看门狗：s03 的 agent + task 工具（subagent.mjs）。
//
// 新增的全部内容：
//   · task 工具：spawn 一个全新 messages 的子代理干脏活，只把结论带回主上下文
//   · 深度上限 1：子代理的工具箱里没有 task，防止套娃
//   · 子代理跑在心跳看门狗 + 墙钟硬顶之下（卡死必被抓，勤奋不误杀）
//   · 被击杀的子代理有一次"遗言"回合，抢救已完成的工作
//   · 同一批工具调用里一模一样的 brief 只跑一次（同 brief 去重）
//
// 运行方式与 s03 相同：AGENT_API_KEY=sk-xxx node agent.mjs

import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LoopBudget, isRecoverable, repairPrompt } from "./loop-budget.mjs";
import { PROD_LIMITS, concludePrompt, normalizeBrief, runChildWithWatchdog } from "./subagent.mjs";

const BASE_URL = process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1";
const API_KEY = process.env.AGENT_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "deepseek-chat";

if (!API_KEY) {
  console.error("缺少 AGENT_API_KEY。任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）。");
  process.exit(1);
}

const SYSTEM = `你是一个运行在用户终端里的编程助手。
优先用专用工具（read_file / write_file / edit_file）操作文件；run_shell 用于其余一切。
搜索/探索类的独立子任务（"找出 X 在哪里被用到""调研 Y 的实现"）交给 task 工具的子代理去跑，别让中间过程灌进当前对话。
先观察真实世界再行动，不要凭空猜测文件内容。
当前目录：${process.cwd()}
操作系统：${process.platform}`;

// 子代理没有用户可以对话：它的最终回复就是交付物，必须自带结论。
const CHILD_SYSTEM = `你是一个子代理，替监督者执行一个明确的子任务。
你看不到监督者的对话历史，也没有用户可以提问 —— 独立完成任务。
你的最后一条回复会被原样带回给监督者：把结论写全（发现了什么、依据是什么、结论是什么），不要说"详见上文"。
当前目录：${process.cwd()}
操作系统：${process.platform}`;

// ─── 基础工具（与 s03 相同）──────────────────────────────────────────────

const BASE_REGISTRY = {
  run_shell: {
    description: "在用户的终端里执行一条 shell 命令，返回 stdout 和 stderr。",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令" } },
      required: ["command"],
    },
    handler: ({ command }) => {
      console.log(`\x1b[33m  $ ${command}\x1b[0m`);
      try {
        const out = execSync(command, {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return out.trim() || "(命令执行成功，无输出)";
      } catch (err) {
        return `命令失败（exit ${err.status ?? "?"}）：\n${err.stdout ?? ""}${err.stderr ?? err.message}`;
      }
    },
  },

  read_file: {
    description: "读取一个文本文件，返回带行号的内容。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径（相对或绝对）" } },
      required: ["path"],
    },
    handler: ({ path: p }) => {
      console.log(`\x1b[33m  read ${p}\x1b[0m`);
      const text = readFileSync(p, "utf8");
      const CAP = 50_000;
      const body = text.length > CAP ? text.slice(0, CAP) + `\n…(截断，共 ${text.length} 字符)` : text;
      return body
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4)}\t${line}`)
        .join("\n");
    },
  },

  write_file: {
    description: "写入一个文件（整体覆盖）。父目录不存在时自动创建。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "完整的文件内容" },
      },
      required: ["path", "content"],
    },
    handler: ({ path: p, content }) => {
      console.log(`\x1b[33m  write ${p} (${content.length} 字符)\x1b[0m`);
      mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
      writeFileSync(p, content);
      return `已写入 ${p}`;
    },
  },

  edit_file: {
    description:
      "对文件做一次精确替换。old_string 必须在文件中出现且仅出现一次（带上足够的上下文来保证唯一），否则会失败。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        old_string: { type: "string", description: "要被替换的原文（必须唯一匹配）" },
        new_string: { type: "string", description: "替换成的新文本" },
      },
      required: ["path", "old_string", "new_string"],
    },
    handler: ({ path: p, old_string, new_string }) => {
      console.log(`\x1b[33m  edit ${p}\x1b[0m`);
      const text = readFileSync(p, "utf8");
      const first = text.indexOf(old_string);
      if (first === -1) return `编辑失败：old_string 在 ${p} 中找不到。请先 read_file 确认原文。`;
      if (text.indexOf(old_string, first + 1) !== -1)
        return `编辑失败：old_string 在 ${p} 中出现多次。请带上更多上下文让它唯一。`;
      writeFileSync(p, text.replace(old_string, new_string));
      return `已编辑 ${p}`;
    },
  },
};

// ─── task 工具：把脏活外包给子代理 ───────────────────────────────────────

// 同一批 tool_calls 内的去重表：brief 归一化后 → { id, result }。
// 模型在一条回复里连发两个一模一样的 task 时，第二个直接复用第一个的结论
// （第一个的结果还没回到模型手里，它不可能"有理由"重发 —— 必然是冗余）。
let batchBriefs = new Map();

const REGISTRY = {
  ...BASE_REGISTRY,

  task: {
    description:
      "派生一个子代理去完成独立的搜索/探索类子任务，等它跑完后只把最终结论带回来。" +
      "子代理有全新的上下文（看不到当前对话），brief 必须自包含：要做什么、在哪做、交付什么。",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "子任务的完整描述（子代理唯一能看到的信息）" },
      },
      required: ["description"],
    },
    handler: async ({ description }) => {
      const key = normalizeBrief(description);
      const seen = batchBriefs.get(key);
      if (seen) {
        return `<merged task_id="${seen.id}">同一批调用里已有一模一样的任务跑完了，不再重复派发，直接复用结论：</merged>\n${seen.result}`;
      }
      const id = `sub_${Math.random().toString(36).slice(2, 8)}`;
      console.log(`\x1b[33m  task ${id}：${description.slice(0, 60)}${description.length > 60 ? "…" : ""}\x1b[0m`);
      const child = createChild();
      const adapter = {
        run: () => child.runTurn(description),
        interrupt: child.interrupt,
        subscribe: child.subscribe,
        isInTool: child.isInTool,
      };
      const { disposition, result, durationMs } = await runChildWithWatchdog(adapter, PROD_LIMITS);
      if (disposition === "completed") {
        const final = result || "子代理完成，但没有留下最终回复。";
        batchBriefs.set(key, { id, result: final });
        return final;
      }
      // 击杀不等于作废：给尸体一次短回合，抢救它已经完成的工作。
      child.resetForConclude();
      const conclude = await runChildWithWatchdog(
        { ...adapter, run: () => child.runTurn(concludePrompt(disposition, durationMs)) },
        { ...PROD_LIMITS, timeoutMs: PROD_LIMITS.concludeTimeoutMs },
      );
      const salvage =
        conclude.disposition === "completed" && conclude.result
          ? `\n\n【遗言 —— 子代理被中止前的自述，可作为下次派发的起点】\n${conclude.result}`
          : "";
      const why =
        disposition === "stale"
          ? `太久没有任何事件（疑似卡死，闲置预算 ${PROD_LIMITS.staleIdleMs / 1000} 秒）`
          : `超过墙钟硬顶 ${PROD_LIMITS.timeoutMs / 1000} 秒且已无生命迹象`;
      return `子代理 ${id} 被看门狗中止：${why}。考虑把任务拆小或换一条路。${salvage}`;
    },
  },
};

// 子代理的工具箱 = 基础四件套，没有 task —— 这就是"深度上限 1"的实现：
// 子代理想套娃也套不了（Reina 里对应 MAX_SUBAGENT_DEPTH=1 + BLOCKED_FOR_SUBAGENT）。
const CHILD_REGISTRY = BASE_REGISTRY;

const toToolDefs = (registry) =>
  Object.entries(registry).map(([name, t]) => ({
    type: "function",
    function: { name, description: t.description, parameters: t.parameters },
  }));
const TOOLS = toToolDefs(REGISTRY);
const CHILD_TOOLS = toToolDefs(CHILD_REGISTRY);

const FAILURE_RE = /^(命令失败|编辑失败|工具执行出错|未知工具|工具参数|子代理)/;

// dispatch 变成 async（task 的 handler 要 await 子代理跑完），其余与 s03 一致。
async function dispatch(call, registry) {
  const tool = registry[call.function.name];
  if (!tool) return `未知工具：${call.function.name}`;
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch (err) {
    return `工具参数不是合法 JSON：${err.message}`;
  }
  try {
    return await tool.handler(args);
  } catch (err) {
    return `工具执行出错：${err.message}`;
  }
}

// ─── 模型调用（多了 signal：让看门狗能掐断在途的请求）────────────────────

async function chat(msgs, { tools, system, signal } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system ?? SYSTEM }, ...msgs],
      tools: tools ?? TOOLS,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`API ${res.status}：${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message;
}

// ─── 子代理引擎：全新 messages 的迷你主循环 ─────────────────────────────

function createChild() {
  const listeners = new Set();
  const emit = () => {
    for (const cb of listeners) cb();
  };
  const messages = []; // 上下文隔离的全部秘密：这是一个空数组
  let interrupted = false;
  let controller = null;
  let toolRunning = false;

  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isInTool: () => toolRunning,
    interrupt() {
      // 协作式中断：掐断在途的模型请求（fetch abort —— 模型流断了也能停），
      // 循环在下一个边界看到标志位就收口。工具本身有 30 秒超时兜底。
      interrupted = true;
      controller?.abort();
    },
    resetForConclude() {
      interrupted = false; // 遗言回合前解除中断标志（Reina 同款：interrupted = false）
    },
    async runTurn(prompt) {
      messages.push({ role: "user", content: prompt });
      const budget = new LoopBudget({ baseSteps: 12 }); // 行为看门狗照旧管"转圈"
      let last = "";
      while (!interrupted && budget.canContinue()) {
        controller = new AbortController();
        let msg;
        try {
          msg = await chat(messages, { tools: CHILD_TOOLS, system: CHILD_SYSTEM, signal: controller.signal });
        } catch (err) {
          if (interrupted) break; // 被看门狗击杀：请求被 abort，安静收口
          throw err;
        }
        emit(); // 模型回了话 = 一次心跳（真实产品逐流 token 刷，这里按回合刷）
        messages.push(msg);
        if (msg.content) last = msg.content;
        if (!msg.tool_calls?.length) break;

        const records = [];
        for (const call of msg.tool_calls) {
          if (interrupted) break;
          toolRunning = true; // 看门狗据此切换到宽松的在途预算
          const output = await dispatch(call, CHILD_REGISTRY);
          toolRunning = false;
          emit(); // 每次工具调用完成也是一次心跳
          messages.push({ role: "tool", tool_call_id: call.id, content: output });
          let input = {};
          try {
            input = JSON.parse(call.function.arguments || "{}");
          } catch { /* 坏参数已作为失败回填 */ }
          records.push({ name: call.function.name, input, status: FAILURE_RE.test(output) ? "failed" : "completed", output });
        }
        // 子代理熔断不给纠偏机会：它的产出就是最终回复，转圈了直接收口，
        // 让主 agent（或遗言回合）决定下一步 —— 而不是在隔离上下文里继续烧。
        if (budget.recordTurn(records)) break;
      }
      return last;
    },
  };
}

// ─── 主循环（与 s03 相同，只多了 batchBriefs 的重置）────────────────────

async function runTurn(messages) {
  const budget = new LoopBudget({ baseSteps: 12 });
  let repaired = false;

  while (true) {
    if (!budget.canContinue()) {
      const stop = budget.exhaustedStop();
      console.log(`\n\x1b[31m⛔ ${stop.message}（第 ${stop.turnCount} 轮）\x1b[0m`);
      return;
    }

    const msg = await chat(messages);
    messages.push(msg);

    if (msg.content) console.log(`\n${msg.content}`);
    if (!msg.tool_calls?.length) return;

    batchBriefs = new Map(); // 去重的作用域是"同一条助手回复里的一批调用"
    const records = [];
    for (const call of msg.tool_calls) {
      const output = await dispatch(call, REGISTRY);
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
      let input = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch { /* 坏参数已作为失败回填 */ }
      records.push({
        name: call.function.name,
        input,
        status: FAILURE_RE.test(output) ? "failed" : "completed",
        output,
      });
    }

    const stop = budget.recordTurn(records);
    if (!stop) continue;

    if (isRecoverable(stop) && !repaired) {
      repaired = true;
      console.log(`\n\x1b[35m🟡 看门狗触发（${stop.reason}），注入纠偏 prompt…\x1b[0m`);
      messages.push({ role: "user", content: repairPrompt(stop) });
      continue;
    }
    console.log(`\n\x1b[31m⛔ ${stop.message}（reason=${stop.reason}，第 ${stop.turnCount} 轮）\x1b[0m`);
    return;
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const messages = [];

console.log(`s09 agent 已上线（${MODEL}）。工具：${Object.keys(REGISTRY).join("、")}。子代理硬顶 ${PROD_LIMITS.timeoutMs / 60000} 分钟。Ctrl+C 退出。`);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  messages.push({ role: "user", content: line });
  await runTurn(messages);
}
