#!/usr/bin/env node
// s05 —— Ctrl+C 之后：s03 的 agent + 流式输出 + 可恢复的中断。
//
// 在 s03 基底上的全部变化：
//   · chat() 改为 stream:true，手工解析 SSE（见 stream.mjs），文本增量实时打印
//   · 每轮一个 AbortController：第一次 Ctrl+C 中断本轮，第二次退出进程
//   · 中断后调用 repairDanglingToolCalls 修复消息序列 —— 悬空的 tool_call
//     回填合成结果，下一句话不会再撞上 400
//
// 运行方式与 s03 相同：AGENT_API_KEY=sk-xxx node agent.mjs

import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LoopBudget, isRecoverable, repairPrompt } from "./loop-budget.mjs";
import { sseJsonEvents, createAssembler, repairDanglingToolCalls } from "./stream.mjs";

const BASE_URL = process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1";
const API_KEY = process.env.AGENT_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "deepseek-chat";

if (!API_KEY) {
  console.error("缺少 AGENT_API_KEY。任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）。");
  process.exit(1);
}

const SYSTEM = `你是一个运行在用户终端里的编程助手。
优先用专用工具（read_file / write_file / edit_file）操作文件；run_shell 用于其余一切。
先观察真实世界再行动，不要凭空猜测文件内容。
当前目录：${process.cwd()}
操作系统：${process.platform}`;

// ─── 工具注册表（与 s03 相同）─────────────────────────────────────────────

const REGISTRY = {
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

const TOOLS = Object.entries(REGISTRY).map(([name, t]) => ({
  type: "function",
  function: { name, description: t.description, parameters: t.parameters },
}));

const FAILURE_RE = /^(命令失败|编辑失败|工具执行出错|未知工具|工具参数)/;

function dispatch(call) {
  const tool = REGISTRY[call.function.name];
  if (!tool) return `未知工具：${call.function.name}`;
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch (err) {
    return `工具参数不是合法 JSON：${err.message}`;
  }
  try {
    return tool.handler(args);
  } catch (err) {
    return `工具执行出错：${err.message}`;
  }
}

// ─── 流式 chat：SSE 手工解析，文本增量实时打印 ───────────────────────────

async function chat(messages, signal) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
      stream: true,
    }),
    signal, // 中断贯穿到 HTTP 层：abort 会掐断连接，流当场停
  });
  if (!res.ok) throw new Error(`API ${res.status}：${await res.text()}`);

  const assembler = createAssembler();
  let printed = false;
  try {
    for await (const event of sseJsonEvents(res.body)) {
      const textDelta = assembler.feed(event);
      if (textDelta) {
        process.stdout.write(textDelta); // 用户看到的"打字机"就是这一行
        printed = true;
      }
    }
  } catch (err) {
    // abort 掐断流时，body 迭代器会抛错（不同 Node 版本的错误类型不完全一致），
    // 以 signal 为准：确实是中断就吞掉，装配器里已有的半截消息照常返回。
    if (!signal.aborted) throw err;
  }
  if (printed) process.stdout.write("\n");
  return { message: assembler.message(), aborted: signal.aborted };
}

// ─── 主循环：中断可以落在任何缝隙里，落点之后统一修复 ────────────────────

let activeTurn = null; // 当前这轮的 AbortController；null = 没有轮次在跑

function finishInterrupt(messages) {
  const filled = repairDanglingToolCalls(messages);
  console.log(
    `\n\x1b[31m⏹ 本轮已中断${filled ? `，回填了 ${filled} 条合成工具结果` : ""}。会话可以继续。\x1b[0m`,
  );
}

async function runTurn(messages) {
  const budget = new LoopBudget({ baseSteps: 12 });
  let repaired = false;
  const controller = new AbortController();
  activeTurn = controller;

  try {
    while (true) {
      if (!budget.canContinue()) {
        const stop = budget.exhaustedStop();
        console.log(`\n\x1b[31m⛔ ${stop.message}（第 ${stop.turnCount} 轮）\x1b[0m`);
        return;
      }

      // 中断也可能落在建连阶段（fetch 还没返回响应头）：此时 AbortError 从
      // await fetch 本身抛出，chat 里包住 body 迭代的 try/catch 接不到它。
      let result;
      try {
        result = await chat(messages, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) throw err;
        return finishInterrupt(messages); // 一个增量都没收到，修复后直接收场
      }
      const { message: msg, aborted } = result;
      // 半截消息也要进历史：已经流出来的文字用户看到了，历史里没有的话，
      // 模型下一轮就会"失忆"，答非所问。空壳（没内容没调用）才丢弃。
      if (msg.content || msg.tool_calls?.length) messages.push(msg);
      if (aborted) return finishInterrupt(messages);
      if (!msg.tool_calls?.length) return;

      const records = [];
      for (const call of msg.tool_calls) {
        // 中断可以落在两次工具执行的缝隙里 —— 每次派发前重查，
        // 已中断就跳过剩余调用（它们的悬空 tool_call 由修复函数回填）。
        if (controller.signal.aborted) break;
        const output = dispatch(call);
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
      if (controller.signal.aborted) return finishInterrupt(messages);

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
  } finally {
    activeTurn = null;
  }
}

// ─── Ctrl+C：第一次中断本轮，第二次退出 ──────────────────────────────────

function onInterrupt() {
  if (activeTurn && !activeTurn.signal.aborted) {
    activeTurn.abort();
    console.log("\n\x1b[33m⚠ 正在中断本轮…（再按一次 Ctrl+C 退出）\x1b[0m");
  } else {
    console.log("\n再见。");
    process.exit(0);
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// 细节：终端在 readline 手里时处于 raw 模式，Ctrl+C 不会产生进程信号，
// 而是触发 rl 的 'SIGINT' 事件；stdin 不是 TTY（比如管道喂入）时才走
// process 的 'SIGINT'。两头都接到同一个处理函数上。
rl.on("SIGINT", onInterrupt);
process.on("SIGINT", onInterrupt);

const messages = [];

console.log(
  `s05 agent 已上线（${MODEL}，流式）。工具：${Object.keys(REGISTRY).join("、")}。` +
    `任务跑着的时候按 Ctrl+C 试试 —— 中断之后接着聊，不会 400。`,
);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  messages.push({ role: "user", content: line });
  await runTurn(messages);
}
