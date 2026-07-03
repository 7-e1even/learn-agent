#!/usr/bin/env node
// v0 —— 一个循环，一双手。
//
// 这就是一个 coding agent 的全部骨架：一个 while 循环 + 一个工具。
// 零依赖，单文件，Node 18+。任何 OpenAI 兼容的 API 都能跑：
//
//   AGENT_API_KEY=sk-xxx node agent.mjs                       # 默认 DeepSeek
//   AGENT_BASE_URL=https://api.moonshot.cn/v1 AGENT_MODEL=kimi-k2-0711-preview ...
//   AGENT_BASE_URL=http://localhost:11434/v1  AGENT_MODEL=qwen3 ...   # 本地 Ollama

import readline from "node:readline/promises";
import { execSync } from "node:child_process";

const BASE_URL = process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1";
const API_KEY = process.env.AGENT_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "deepseek-chat";

if (!API_KEY) {
  console.error("缺少 AGENT_API_KEY。任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）。");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. 工具：agent 的手。v0 只有一双 —— run_shell。
//    "Bash is all you need"：能跑 shell，就能读文件、写文件、查环境、跑测试。
// ---------------------------------------------------------------------------

const SYSTEM = `你是一个运行在用户终端里的编程助手。
你有一个工具 run_shell，可以在用户的机器上执行 shell 命令。
需要了解环境、读文件、改文件时，先用工具去看真实世界，不要凭空猜测。
当前目录：${process.cwd()}
操作系统：${process.platform}`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "在用户的终端里执行一条 shell 命令，返回 stdout 和 stderr。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令" },
        },
        required: ["command"],
      },
    },
  },
];

function runShell(command) {
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
    // 关键原则：工具失败不是异常，是信息。把错误交还给模型，它会自己改道。
    return `命令失败（exit ${err.status ?? "?"}）：\n${err.stdout ?? ""}${err.stderr ?? err.message}`;
  }
}

// ---------------------------------------------------------------------------
// 2. chat()：一次 API 调用。没有任何魔法，就是一个 POST。
// ---------------------------------------------------------------------------

async function chat(messages) {
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
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}：${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message;
}

// ---------------------------------------------------------------------------
// 3. runTurn()：整套笔记的灵魂。agent 和 chatbot 的全部区别就在这个 while 里 ——
//    模型说"我要用工具"，代码就执行并把结果喂回去，然后再问它一次；
//    模型说完话不再要工具，这一轮才结束，话筒交还给用户。
//    决定循环继续还是停止的是模型，不是代码。这就是"自主"的最小实现。
// ---------------------------------------------------------------------------

async function runTurn(messages) {
  while (true) {
    const msg = await chat(messages);
    messages.push(msg);

    if (msg.content) console.log(`\n${msg.content}`);
    if (!msg.tool_calls?.length) return; // 模型不再要工具 => 这一轮结束

    for (const call of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* 参数坏了也照样回填错误，让模型自己修 */
      }
      const output =
        call.function.name === "run_shell"
          ? runShell(args.command ?? "")
          : `未知工具：${call.function.name}`;
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 入口：一个最普通的 REPL。messages 数组就是 agent 的全部记忆。
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const messages = [];

console.log(`v0 agent 已上线（${MODEL}）。它有一双手：run_shell。Ctrl+C 退出。`);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  messages.push({ role: "user", content: line });
  await runTurn(messages);
}
