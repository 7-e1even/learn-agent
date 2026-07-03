#!/usr/bin/env node
// s07 —— 缓存命中工程：s03 的 agent（工具注册表 + 看门狗）+ 缓存命中率仪表盘。
//
// 新增的全部内容：
//   · chat() 读回 usage，兼容两种缓存字段（DeepSeek / OpenAI）
//   · 每轮打印 prompt tokens、缓存命中/未命中、按"命中≈1折"估算省了多少钱
//   · 三条纪律落在代码里：system 字节稳定、tools 顺序稳定、messages 只追加
//
// 运行方式与 s03 相同：AGENT_API_KEY=sk-xxx node agent.mjs

import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LoopBudget, isRecoverable, repairPrompt } from "./loop-budget.mjs";

const BASE_URL = process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1";
const API_KEY = process.env.AGENT_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "deepseek-chat";

if (!API_KEY) {
  console.error("缺少 AGENT_API_KEY。任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）。");
  process.exit(1);
}

// 纪律①：system prompt 必须逐轮字节稳定。cwd 和 platform 在进程生命周期内
// 不变，可以进来；时间戳、随机数、"今天是几号"是缓存杀手——
//
//   ❌ const SYSTEM = `当前时间：${new Date().toISOString()}\n你是…`;
//
// 这样写，每轮请求的第 6 个字符就开始不同，前缀缓存从那里断掉，
// 后面的一切（tools、全部历史）永远按全价计费。每轮会变的信息
// 放进"最后一条用户消息"随尾部走（见 demo.mjs 的对照实验）。
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

// 纪律②：tools 数组也在前缀里。Object.entries 的顺序 = 注册表的书写顺序，
// 进程内每轮相同——别在运行时对它排序、增删或拼接动态描述。
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

// ─── 缓存仪表盘：让省钱可见 ──────────────────────────────────────────────

// 兼容读两种 usage 字段：
//   DeepSeek：usage.prompt_cache_hit_tokens / usage.prompt_cache_miss_tokens
//   OpenAI：  usage.prompt_tokens_details.cached_tokens（未命中 = prompt - cached）
// 都没有就返回 undefined——有的服务商/本地模型根本不报缓存。
function readCacheUsage(usage = {}) {
  const prompt = usage.prompt_tokens ?? 0;
  let hit;
  if (typeof usage.prompt_cache_hit_tokens === "number") hit = usage.prompt_cache_hit_tokens;
  else if (typeof usage.prompt_tokens_details?.cached_tokens === "number") hit = usage.prompt_tokens_details.cached_tokens;
  if (hit === undefined) return { prompt };
  const miss = typeof usage.prompt_cache_miss_tokens === "number" ? usage.prompt_cache_miss_tokens : prompt - hit;
  return { prompt, hit, miss };
}

const sessionTotals = { prompt: 0, hit: 0 };

function printUsage(usage) {
  const u = readCacheUsage(usage);
  if (u.hit === undefined) {
    console.log(`\x1b[36m📊 prompt ${u.prompt} tokens（该服务商未返回缓存字段）\x1b[0m`);
    return;
  }
  sessionTotals.prompt += u.prompt;
  sessionTotals.hit += u.hit;
  const rate = u.prompt > 0 ? ((u.hit / u.prompt) * 100).toFixed(1) : "0.0";
  // 命中部分按约 1 折计费 → 每命中 1 token 省 0.9 个全价 token。
  const saved = u.prompt > 0 ? ((u.hit * 0.9) / u.prompt) * 100 : 0;
  const total = sessionTotals.prompt > 0 ? ((sessionTotals.hit / sessionTotals.prompt) * 100).toFixed(1) : "0.0";
  console.log(
    `\x1b[36m📊 prompt ${u.prompt} | 命中 ${u.hit}（${rate}%）| 未命中 ${u.miss} | 本轮输入费≈省 ${saved.toFixed(0)}% | 会话累计命中 ${total}%\x1b[0m`,
  );
}

// ─── 模型调用（与 s03 唯一的区别：读回 usage）────────────────────────────

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
  return { message: data.choices[0].message, usage: data.usage };
}

// ─── 主循环：s03 原样 + 每轮打印命中率 ───────────────────────────────────
// 纪律③就藏在这里：messages 只 push、从不改写。s03 的循环天生 append-only，
// 本章一行都不用改——难的不是做到，是别在后续迭代里破坏它
// （比如"帮模型省上下文"回头去截短旧的工具输出：省了 token，赔了缓存）。

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
    printUsage(usage);
    messages.push(msg);

    if (msg.content) console.log(`\n${msg.content}`);
    if (!msg.tool_calls?.length) return;

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

console.log(`s07 agent 已上线（${MODEL}）。每轮打印缓存命中率——盯着第二轮开始的 📊 行看。Ctrl+C 退出。`);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  messages.push({ role: "user", content: line });
  await runTurn(messages);
}
