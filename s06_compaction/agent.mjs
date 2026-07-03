#!/usr/bin/env node
// s06 —— 上下文压缩：s03 的 agent（工具注册表 + 看门狗）+ 压缩器。
//
// 新增的全部内容：
//   · chat() 顺带返回服务商的 usage —— 触发判定的唯一依据
//   · 每轮工具执行结束后 maybeCompact()：超阈值就地压缩 messages
//   · 摘要调用失败自动降级为提取式摘要（compaction.mjs 内部兜底）
//
// 运行方式与 s03 相同：AGENT_API_KEY=sk-xxx node agent.mjs

import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LoopBudget, isRecoverable, repairPrompt } from "./loop-budget.mjs";
import { shouldCompact, compactMessages, SUMMARY_PROMPT } from "./compaction.mjs";

const BASE_URL = process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1";
const API_KEY = process.env.AGENT_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "deepseek-chat";
// 模型窗口没有任何 API 能查询，只能自己配（Reina 也是配在 models.json 里）。
// DeepSeek 128k；换模型记得改，配大了会在真窗口边界撞 "context too long"。
const CONTEXT_WINDOW = Number(process.env.AGENT_CONTEXT_WINDOW ?? 128_000);
const COMPACT_PERCENT = Number(process.env.AGENT_COMPACT_PERCENT ?? 75);

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

// ─── 模型调用：现在连 usage 一起带回来 ───────────────────────────────────

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
  // usage 是服务商的账本：prompt_tokens / completion_tokens / total_tokens。
  // 压缩触发只信它——本地估算对不上服务商的 tokenizer。
  return { message: data.choices[0].message, usage: data.usage };
}

// 摘要也是一次模型调用——但不带 tools（摘要不许干活），system 换成结构化
// 摘要指令。任何失败直接 throw，由 compactMessages 降级为提取式摘要。
async function summarizeViaModel(middleText) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: `以下是即将被压缩掉的对话段（从旧到新）：\n\n${middleText}\n\n现在按五个小节输出摘要。` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`摘要调用失败：API ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// ─── 每轮结束检查：超阈值就地压缩 ────────────────────────────────────────

async function maybeCompact(messages, usage) {
  const decision = shouldCompact({
    usage,
    contextWindow: CONTEXT_WINDOW,
    triggerPercent: COMPACT_PERCENT,
    messageCount: messages.length,
  });
  if (!decision.compact) return;

  console.log(`\n\x1b[36m🗜️ 触发压缩：${decision.why}\x1b[0m`);
  const result = await compactMessages(messages, { summarize: summarizeViaModel });
  if (!result.compacted) {
    console.log("\x1b[36m   可压的前缀太小，本次跳过。\x1b[0m");
    return;
  }
  // 就地替换：外层循环和本函数共享同一个数组引用，不能换新数组。
  messages.splice(0, messages.length, ...result.messages);
  console.log(
    `\x1b[36m🗜️ 压缩完成：压掉 ${result.dropped} 条${result.degraded ? "（摘要降级为提取式）" : ""}，现存 ${messages.length} 条。\x1b[0m`,
  );
}

// ─── 主循环：s03 原样 + 每轮结束的压缩检查 ───────────────────────────────

async function runTurn(messages) {
  const budget = new LoopBudget({ baseSteps: 12 });
  let repaired = false;

  while (true) {
    if (!budget.canContinue()) {
      const stop = budget.exhaustedStop();
      console.log(`\n\x1b[31m⛔ ${stop.message}（第 ${stop.turnCount} 轮）\x1b[0m`);
      return;
    }

    const { message: msg, usage } = await chat(messages);
    messages.push(msg);

    if (msg.content) console.log(`\n${msg.content}`);
    if (!msg.tool_calls?.length) {
      await maybeCompact(messages, usage); // 纯文本收尾的轮次也要检查
      return;
    }

    const records = [];
    for (const call of msg.tool_calls) {
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

    // 每轮结束检查触发：此刻工具结果刚落地，是上下文长胖最快的时刻。
    // usage 来自本轮响应，等下一轮再看它就是旧账了。
    await maybeCompact(messages, usage);

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

console.log(
  `s06 agent 已上线（${MODEL}，窗口 ${CONTEXT_WINDOW}，${COMPACT_PERCENT}% 触发压缩）。工具：${Object.keys(REGISTRY).join("、")}。Ctrl+C 退出。`,
);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  messages.push({ role: "user", content: line });
  await runTurn(messages);
}
