#!/usr/bin/env node
// s10 —— prompt 是拼出来的：s03 的 agent + system prompt 分段拼装 + 技能按需加载。
//
// 相对 s03 基底的全部变化：
//   · SYSTEM 字符串常量没了 —— 每轮由 buildSystemPrompt(sections) 确定性拼装
//   · 新增 skills/ 目录 + load_skill 工具：目录进 prompt，正文按需取
//   · 每轮开工前重扫技能目录：运行中新装的技能，下一轮自动可见
//   · 易变信息（当前时间）附在最新一条用户消息尾部，绝不进 system
//
// 运行方式与 s03 相同：AGENT_API_KEY=sk-xxx node agent.mjs

import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LoopBudget, isRecoverable, repairPrompt } from "./loop-budget.mjs";
import { buildSystemPrompt, loadSkills, formatSkillsSection } from "./prompt.mjs";

const BASE_URL = process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1";
const API_KEY = process.env.AGENT_API_KEY;
const MODEL = process.env.AGENT_MODEL ?? "deepseek-chat";

if (!API_KEY) {
  console.error("缺少 AGENT_API_KEY。任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）。");
  process.exit(1);
}

// 技能目录跟着脚本走（也可用 AGENT_SKILLS_DIR 指到别处，比如 ~/.config/agent/skills）
const SKILLS_DIR =
  process.env.AGENT_SKILLS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");

// ─── system prompt：每轮拼装，但拼装本身是确定性的 ──────────────────────
//
// 段的顺序 = 稳定性排序：越不可能变的越靠前。身份永远不变；环境在会话内
// 不变；技能目录只在用户增删技能时变。任何一段不变，它贡献的字节就不变 ——
// 目录没动时，两轮的 system prompt 逐字节一致，前缀缓存照样命中。

function assembleSystemPrompt(skills) {
  return buildSystemPrompt([
    // ① 身份 —— 最稳定的段放最前
    "你是一个运行在用户终端里的编程助手。",
    // ② 环境 —— cwd / 平台在会话内不变。注意：这里没有时间戳。
    `## 环境\n当前目录：${process.cwd()}\n操作系统：${process.platform}`,
    // ③ 工具指引
    [
      "## 工具使用",
      "优先用专用工具（read_file / write_file / edit_file）操作文件；run_shell 用于其余一切。",
      "先观察真实世界再行动，不要凭空猜测文件内容。",
    ].join("\n"),
    // ④ 技能目录 —— 只有 name + description，正文靠 load_skill 按需取
    formatSkillsSection(skills),
  ]);
}

/** 易变信息走用户消息，不走 system。已写进历史的旧提醒字节不再变化，
 *  所以前缀缓存不受影响；塞进 system 则每轮整个前缀全部 miss。 */
function withVolatileReminder(text) {
  return `${text}\n\n<环境提醒>当前时间：${new Date().toISOString()}</环境提醒>`;
}

// ─── 工具注册表（s03 基底 + load_skill）─────────────────────────────────

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

  // 本章新增：技能正文的按需加载。目录里那一行描述是"广告"，这里才是"全文"。
  load_skill: {
    description:
      "读取一个技能的完整指引正文。system prompt 里的技能目录只有一句话描述；当任务和某个技能的描述匹配时，先调用本工具拿到全文再动手。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "技能名（目录里列出的 name）" } },
      required: ["name"],
    },
    handler: ({ name }) => {
      console.log(`\x1b[33m  load_skill ${name}\x1b[0m`);
      // 每次都重扫磁盘而不是用缓存 —— 技能可能刚被用户编辑过，
      // 正文取最新的；扫描很便宜（几个小文件），不值得为它做失效逻辑。
      const skills = loadSkills(SKILLS_DIR);
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        const available = skills.map((s) => s.name).join("、") || "（无）";
        return `未找到技能"${name}"。可用技能：${available}。请使用目录中列出的确切名字。`;
      }
      return `# 技能：${skill.name}\n\n${skill.body}`;
    },
  },
};

const TOOLS = Object.entries(REGISTRY).map(([name, t]) => ({
  type: "function",
  function: { name, description: t.description, parameters: t.parameters },
}));

const FAILURE_RE = /^(命令失败|编辑失败|工具执行出错|未知工具|工具参数|未找到技能)/;

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

// ─── 主循环：system 不再是常量，而是本轮的拼装结果 ──────────────────────

async function chat(system, messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, ...messages],
      tools: TOOLS,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}：${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message;
}

async function runTurn(messages) {
  // 每轮开工前重扫技能目录（Reina 的 refreshContext 同款时机）。
  // agent 运行中装的新技能，这里自动进目录 —— 引擎零改动。
  // 拼装在一轮内只做一次：同一轮的多次模型调用里 system 字节完全一致。
  const system = assembleSystemPrompt(loadSkills(SKILLS_DIR));

  const budget = new LoopBudget({ baseSteps: 12 });
  let repaired = false;

  while (true) {
    if (!budget.canContinue()) {
      const stop = budget.exhaustedStop();
      console.log(`\n\x1b[31m⛔ ${stop.message}（第 ${stop.turnCount} 轮）\x1b[0m`);
      return;
    }

    const msg = await chat(system, messages);
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

const bootSkills = loadSkills(SKILLS_DIR);
console.log(
  `s10 agent 已上线（${MODEL}）。工具：${Object.keys(REGISTRY).join("、")}。` +
    `技能目录：${SKILLS_DIR}（${bootSkills.length} 个：${bootSkills.map((s) => s.name).join("、") || "无"}）。Ctrl+C 退出。`,
);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  messages.push({ role: "user", content: withVolatileReminder(line) });
  await runTurn(messages);
}
