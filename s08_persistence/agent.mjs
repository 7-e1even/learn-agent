#!/usr/bin/env node
// s08 —— 会话落盘与恢复：s03 的 agent + 追加式事件日志（store.mjs）。
//
// 新增的全部内容：
//   · 每条消息进 messages 数组的同时 append 一行事件到 .sessions/<id>.jsonl
//   · 工具调用带结构化 status 落盘（回收 s03 靠报错文案前缀判失败的临时方案）
//   · 启动带 --resume <id> → 重放事件重建 messages，续上次的会话接着聊
//   · 会话用的模型记录在 session_meta 里，恢复时以它为准，不取当前默认
//
// 运行：AGENT_API_KEY=sk-xxx node agent.mjs             # 新会话，打印会话 id
//       AGENT_API_KEY=sk-xxx node agent.mjs --resume <id>  # 断了接上

import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LoopBudget, isRecoverable, repairPrompt } from "./loop-budget.mjs";
import { appendEvent, createSession, listSessionIds, replaySession, sessionPath } from "./store.mjs";

const BASE_URL = process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1";
const API_KEY = process.env.AGENT_API_KEY;

if (!API_KEY) {
  console.error("缺少 AGENT_API_KEY。任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）。");
  process.exit(1);
}

// ─── 会话：新建或恢复 ─────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(process.cwd(), ".sessions");
const resumeAt = process.argv.indexOf("--resume");
const resumeId = resumeAt !== -1 ? process.argv[resumeAt + 1] : undefined;

let meta;
const messages = [];

if (resumeId) {
  const restored = replaySession(SESSIONS_DIR, resumeId);
  if (!restored) {
    console.error(`找不到会话 ${resumeId}。可用的会话：${listSessionIds(SESSIONS_DIR).join("、") || "（无）"}`);
    process.exit(1);
  }
  meta = restored.meta;
  messages.push(...restored.messages);
  console.log(
    `已恢复会话 ${meta.id}：${restored.messages.length} 条消息，${restored.toolCalls.length} 次工具调用` +
      (restored.skipped ? `（跳过 ${restored.skipped} 行损坏数据）` : ""),
  );
} else {
  // 模型在"创建时"读一次环境变量，然后冻结进 session_meta ——
  // 恢复这个会话的永远是它，而不是恢复那一刻的默认值。
  meta = createSession(SESSIONS_DIR, { model: process.env.AGENT_MODEL ?? "deepseek-chat" });
  console.log(`新会话 ${meta.id}（落盘于 ${sessionPath(SESSIONS_DIR, meta.id)}）`);
  console.log(`下次续上：node agent.mjs --resume ${meta.id}`);
}

const MODEL = meta.model; // 会话粒度的配置，来自会话记录

/** 消息只从这里进数组：内存 + 磁盘一步完成，两边永远一致。 */
function pushMessage(message) {
  messages.push(message);
  appendEvent(SESSIONS_DIR, meta.id, { type: "message", message });
}

const SYSTEM = `你是一个运行在用户终端里的编程助手。
优先用专用工具（read_file / write_file / edit_file）操作文件；run_shell 用于其余一切。
先观察真实世界再行动，不要凭空猜测文件内容。
当前目录：${process.cwd()}
操作系统：${process.platform}`;

// ─── 工具注册表（s02/s03 的四件套，失败改为 throw —— 见 dispatch）────────

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
        // 失败 = 抛异常。报错文案原样保留（错误即信息，模型看得到），
        // 但"这次调用失败了"这个事实由 dispatch 转成结构化 status。
        throw new Error(`命令失败（exit ${err.status ?? "?"}）：\n${err.stdout ?? ""}${err.stderr ?? err.message}`);
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
      const text = readFileSync(p, "utf8"); // 读不到 → 自然抛出，dispatch 记 failed
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
      if (first === -1) throw new Error(`编辑失败：old_string 在 ${p} 中找不到。请先 read_file 确认原文。`);
      if (text.indexOf(old_string, first + 1) !== -1)
        throw new Error(`编辑失败：old_string 在 ${p} 中出现多次。请带上更多上下文让它唯一。`);
      writeFileSync(p, text.replace(old_string, new_string));
      return `已编辑 ${p}`;
    },
  },
};

const TOOLS = Object.entries(REGISTRY).map(([name, t]) => ({
  type: "function",
  function: { name, description: t.description, parameters: t.parameters },
}));

// s03 靠 FAILURE_RE 前缀猜成败，本章拆掉这个脚手架：
// 成败在执行的那一刻就确定（return = completed，throw = failed），
// dispatch 把它变成结构化字段，落盘之后审计和重放都不用再解析报错文案。
function dispatch(call) {
  const tool = REGISTRY[call.function.name];
  if (!tool) return { status: "failed", output: `未知工具：${call.function.name}` };
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch (err) {
    return { status: "failed", output: `工具参数不是合法 JSON：${err.message}` };
  }
  try {
    return { status: "completed", output: tool.handler(args) };
  } catch (err) {
    return { status: "failed", output: err.message }; // 错误依旧作为文本回给模型
  }
}

// ─── 主循环：s03 原样 + 每一步落盘 ───────────────────────────────────────

async function chat(msgs) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...msgs],
      tools: TOOLS,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}：${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message;
}

async function runTurn() {
  const budget = new LoopBudget({ baseSteps: 12 });
  let repaired = false;

  while (true) {
    if (!budget.canContinue()) {
      const stop = budget.exhaustedStop();
      console.log(`\n\x1b[31m⛔ ${stop.message}（第 ${stop.turnCount} 轮）\x1b[0m`);
      return;
    }

    const msg = await chat(messages);
    pushMessage(msg); // 助手消息（含 tool_calls）落盘

    if (msg.content) console.log(`\n${msg.content}`);
    if (!msg.tool_calls?.length) return;

    const records = [];
    for (const call of msg.tool_calls) {
      const { status, output } = dispatch(call);
      pushMessage({ role: "tool", tool_call_id: call.id, content: output }); // 工具结果落盘
      let input = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch { /* 坏参数已作为失败回填 */ }
      const record = { name: call.function.name, input, status, output };
      records.push(record);
      // 结构化审计记录：真实产品的 ToolCallRecord 还带 permission / preview /
      // outputPath 等字段，这里只落最小集。output 已在 tool 消息里，不重复存。
      appendEvent(SESSIONS_DIR, meta.id, {
        type: "tool_call",
        record: { id: call.id, name: record.name, input, status },
      });
    }

    const stop = budget.recordTurn(records);
    if (!stop) continue;

    if (isRecoverable(stop) && !repaired) {
      repaired = true;
      console.log(`\n\x1b[35m🟡 看门狗触发（${stop.reason}），注入纠偏 prompt…\x1b[0m`);
      pushMessage({ role: "user", content: repairPrompt(stop) }); // 纠偏也是历史的一部分
      continue;
    }
    console.log(`\n\x1b[31m⛔ ${stop.message}（reason=${stop.reason}，第 ${stop.turnCount} 轮）\x1b[0m`);
    return;
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(`s08 agent 已上线（${MODEL}，来自会话记录）。工具：${Object.keys(REGISTRY).join("、")}。Ctrl+C 随便按 —— 会话在盘上。`);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  pushMessage({ role: "user", content: line });
  await runTurn();
}
