#!/usr/bin/env node
// s04 —— 一条 cat 就能爆窗：s03 的 agent + 工具输出预算与无损溢出。
//
// 在 s03 基底上的全部变化：
//   · read_file 拆掉 50KB 截断创可贴，改成 offset/limit 分段读取（文件自己就是指针）
//   · run_shell 的日志先按重要性无损压缩（错误行保留，噪声行折叠，全文落盘）
//   · 每轮工具输出先收集、过一遍观测预算（单条 + 整轮总量），超限的溢出到
//     .agent-spill/ 并回给模型"节选 + 指针"，再回填进 messages
//
// 运行方式与 s03 相同：AGENT_API_KEY=sk-xxx node agent.mjs

import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LoopBudget, isRecoverable, repairPrompt } from "./loop-budget.mjs";
import { DEFAULTS, compressLog, saveSpill, enforceTurnBudget } from "./spill.mjs";

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
超长的工具输出会被保存到 ${DEFAULTS.dir}/ 下的文件里、只回给你节选——需要细节时用 read_file 分段读取，不要重跑命令。
当前目录：${process.cwd()}
操作系统：${process.platform}`;

// ─── 工具注册表（read_file / run_shell 为本章改造，其余与 s03 相同）──────

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
      let raw;
      try {
        raw = execSync(command, {
          encoding: "utf8",
          timeout: 30_000,
          // s03 的 1MB maxBuffer 会让大输出直接抛错 —— 现在我们有能力"接住"
          // 大输出了（压缩 + 溢出），就把接收上限放开到 16MB。
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || "(命令执行成功，无输出)";
      } catch (err) {
        raw = `命令失败（exit ${err.status ?? "?"}）：\n${err.stdout ?? ""}${err.stderr ?? err.message}`;
      }
      // 日志先按重要性无损压缩：折叠真的发生时，把全文落盘 + 加指针，
      // 被折叠的行随时可以 read_file 找回来 —— 整条链路保持无损。
      const packed = compressLog(raw);
      if (!packed.compressed) return raw;
      const file = saveSpill(raw);
      return (
        `${packed.content}\n` +
        `[已折叠 ${packed.inputLines - packed.outputLines} 行低信号日志。完整原文保存在 ${file}，` +
        `如果需要的行被折叠了，用 read_file 找回，不要重跑命令。]`
      );
    },
  },

  read_file: {
    description:
      "读取一个文本文件，返回带行号的内容。大文件用 offset（起始行号，从 1 开始）和 limit（行数）分段读取。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对或绝对）" },
        offset: { type: "integer", description: "起始行号（1-based），默认 1" },
        limit: { type: "integer", description: "本次最多读多少行，默认 800" },
      },
      required: ["path"],
    },
    handler: ({ path: p, offset = 1, limit = 800 }) => {
      console.log(`\x1b[33m  read ${p}${offset > 1 || limit !== 800 ? ` [${offset}, +${limit}]` : ""}\x1b[0m`);
      // s02 的 50KB 截断在这里正式退役：截掉的部分模型永远看不到；
      // 现在改成分段读取 —— 文件本来就在磁盘上，指针就是它自己。
      const lines = readFileSync(p, "utf8").split("\n");
      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + limit);
      let body = slice.map((line, i) => `${String(start + i).padStart(4)}\t${line}`).join("\n");
      let shown = slice.length;
      // 兜底：行数不多但单行巨大（压缩过的 JSON/bundle）也不能爆窗。
      if (body.length > DEFAULTS.perResult) {
        let cut = 0, chars = 0;
        for (const line of slice) {
          if (chars + line.length + 6 > DEFAULTS.perResult) break;
          chars += line.length + 6;
          cut++;
        }
        shown = Math.max(1, cut);
        body = slice.slice(0, shown).map((line, i) => `${String(start + i).padStart(4)}\t${line}`).join("\n").slice(0, DEFAULTS.perResult);
      }
      const end = start + shown - 1;
      if (start > 1 || end < lines.length) {
        body += `\n…(文件共 ${lines.length} 行，本次返回第 ${start}–${end} 行；继续读用 offset=${end + 1})`;
      }
      return body;
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

// ─── 主循环：工具输出先收集 → 过预算 → 再回填 ────────────────────────────

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

    // s03 是"执行一个、回填一个"；本章改成先把整轮输出收集起来 ——
    // 因为整轮总量预算必须看到全局才能决定谁溢出（largest-first）。
    const records = [];
    for (const call of msg.tool_calls) {
      const output = dispatch(call);
      let input = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch { /* 坏参数已作为失败回填 */ }
      records.push({
        call,
        name: call.function.name,
        input,
        // 成败判定看输出前缀的失败戳。run_shell 的输出可能已被 compressLog 压过，
        // 但失败戳被登记成 anchor（见 spill.mjs 的 SUMMARY_RE）永不折叠，前缀始终在。
        status: FAILURE_RE.test(output) ? "failed" : "completed",
        output,
        // read_file 自带指针（文件本身 + offset/limit），落盘副本毫无意义；
        // 其余工具的输出只存在于内存里，超限就必须溢出落盘。
        spillable: call.function.name !== "read_file",
      });
    }

    const { spilled } = enforceTurnBudget(records);
    if (spilled.length > 0) {
      console.log(`\x1b[35m  ⤵ ${spilled.length} 条超预算输出已溢出：${spilled.join("、")}\x1b[0m`);
    }
    for (const r of records) {
      messages.push({ role: "tool", tool_call_id: r.call.id, content: r.output });
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

console.log(
  `s04 agent 已上线（${MODEL}）。工具：${Object.keys(REGISTRY).join("、")}。` +
    `观测预算：单条 ${DEFAULTS.perResult}、整轮 ${DEFAULTS.turnTotal} 字符，超限溢出到 ${DEFAULTS.dir}/。Ctrl+C 退出。`,
);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  messages.push({ role: "user", content: line });
  await runTurn(messages);
}
