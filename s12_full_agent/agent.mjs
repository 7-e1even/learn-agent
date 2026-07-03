#!/usr/bin/env node
// s12 —— 收官：合体。s01 的循环 + 前十一章的机制，一行机制代码都不重写。
//
// 注意下面的 import：每一条都直接指回它自己的章节目录。这本身就是本章的
// 示例点 —— 机制是模块，循环是接线板。s03 到 s10 的文件在这里原样复用，
// 能拼上是因为每个模块都只依赖"循环喂给它的数据"（records、messages、
// usage、事件），而不依赖循环的内部结构。
//
// 运行：AGENT_API_KEY=sk-xxx node agent.mjs                # 新会话
//       AGENT_API_KEY=sk-xxx node agent.mjs --resume <id>  # 断了接上
// 免 key 端到端跑一遍（假模型服务器 + 剧本）：node selftest.mjs

import readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LoopBudget, isRecoverable, repairPrompt } from "../s03_loop_budget/loop-budget.mjs";
import { DEFAULTS, compressLog, saveSpill, enforceTurnBudget } from "../s04_output_budget/spill.mjs";
import { sseJsonEvents, createAssembler, repairDanglingToolCalls } from "../s05_streaming_interrupt/stream.mjs";
import { shouldCompact, compactMessages, SUMMARY_PROMPT } from "../s06_compaction/compaction.mjs";
import { appendEvent, createSession, listSessionIds, replaySession, sessionPath } from "../s08_persistence/store.mjs";
import { PROD_LIMITS, concludePrompt, normalizeBrief, runChildWithWatchdog } from "../s09_subagent_watchdog/subagent.mjs";
import { buildSystemPrompt, loadSkills, formatSkillsSection } from "../s10_prompt_assembly/prompt.mjs";

// ─── 配置 ────────────────────────────────────────────────────────────────

const BASE_URL = process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1";
const API_KEY = process.env.AGENT_API_KEY;

if (!API_KEY) {
  console.error("缺少 AGENT_API_KEY。任何 OpenAI 兼容的 key 都行（DeepSeek / Kimi / GLM / OpenRouter / 本地 Ollama）。");
  process.exit(1);
}

const envNum = (name, fallback) => Number(process.env[name] ?? fallback);

// 压缩阈值（s06）。窗口没有 API 可查，只能自己配。
const CONTEXT_WINDOW = envNum("AGENT_CONTEXT_WINDOW", 128_000);
const COMPACT_PERCENT = envNum("AGENT_COMPACT_PERCENT", 75);
const COMPACT_MIN_MESSAGES = envNum("AGENT_COMPACT_MIN_MESSAGES", 12);

// 子代理看门狗阈值（s09）：生产默认 + 环境变量覆盖（Reina 同款做法，
// selftest 用它把"卡死→击杀→遗言"整条链路压进两秒内演完）。
const SUB_LIMITS = {
  ...PROD_LIMITS,
  timeoutMs: envNum("AGENT_SUB_TIMEOUT_MS", PROD_LIMITS.timeoutMs),
  heartbeatMs: envNum("AGENT_SUB_HEARTBEAT_MS", PROD_LIMITS.heartbeatMs),
  staleIdleMs: envNum("AGENT_SUB_STALE_IDLE_MS", PROD_LIMITS.staleIdleMs),
  staleInToolMs: envNum("AGENT_SUB_STALE_IN_TOOL_MS", PROD_LIMITS.staleInToolMs),
  concludeTimeoutMs: envNum("AGENT_SUB_CONCLUDE_TIMEOUT_MS", PROD_LIMITS.concludeTimeoutMs),
};

// 技能目录（s10）：直接用 s10 章的示例技能，也可用 AGENT_SKILLS_DIR 指到别处。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = process.env.AGENT_SKILLS_DIR ?? path.join(HERE, "../s10_prompt_assembly/skills");

// ─── 会话：新建或恢复（s08）──────────────────────────────────────────────

const SESSIONS_DIR = path.join(process.cwd(), ".sessions");
const resumeAt = process.argv.indexOf("--resume");
const resumeId = resumeAt !== -1 ? process.argv[resumeAt + 1] : undefined;

/** 适配（s06 × s08 的接口冲突）：s08 的 replaySession 对未知事件的策略是
 *  "忽略"——正是这个前向兼容设计让我们能加新事件类型而不改 s08 一行代码。
 *  但它因此看不见压缩：全量 message 重放会把已压缩的历史原样端回来，长会话
 *  恢复时第一枪就可能超窗。所以压缩时我们额外落一个 compaction 快照事件，
 *  这里再扫一遍日志：遇到快照就整体换成快照，之后的 message 照常追加。 */
function replayCompacted(dir, id) {
  const base = replaySession(dir, id); // meta / toolCalls / skipped 全部照用
  if (!base) return null;
  const messages = [];
  for (const raw of readFileSync(sessionPath(dir, id), "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "message") messages.push(event.message);
    else if (event.type === "compaction") messages.splice(0, messages.length, ...event.messages);
  }
  return { ...base, messages };
}

let meta;
const messages = [];
// 适配（s05 × s08）：修复函数直接往 messages 数组里插合成消息，而落盘挂在
// pushMessage 上——两个模块互不知情。用 WeakSet 记住"哪些消息已落盘"，
// 修复之后补写日志（persistNewMessages），两边就对齐了。
const persisted = new WeakSet();

function pushMessage(message) {
  messages.push(message);
  persisted.add(message);
  appendEvent(SESSIONS_DIR, meta.id, { type: "message", message });
}

function persistNewMessages() {
  let wrote = 0;
  for (const m of messages) {
    if (persisted.has(m)) continue;
    persisted.add(m);
    appendEvent(SESSIONS_DIR, meta.id, { type: "message", message: m });
    wrote++;
  }
  return wrote;
}

if (resumeId) {
  const restored = replayCompacted(SESSIONS_DIR, resumeId);
  if (!restored) {
    console.error(`找不到会话 ${resumeId}。可用的会话：${listSessionIds(SESSIONS_DIR).join("、") || "（无）"}`);
    process.exit(1);
  }
  meta = restored.meta;
  for (const m of restored.messages) {
    messages.push(m);
    persisted.add(m);
  }
  console.log(
    `已恢复会话 ${meta.id}：${messages.length} 条消息，${restored.toolCalls.length} 次工具调用` +
      (restored.skipped ? `（跳过 ${restored.skipped} 行损坏数据）` : ""),
  );
  // s05 的修复函数在这里第二次上岗：上次会话可能死在 tool_calls 和工具结果
  // 之间（崩溃和 Ctrl+C 撕开的是同一个口子）。修复是幂等的，恢复时先跑一遍。
  const filled = repairDanglingToolCalls(messages);
  if (filled) {
    persistNewMessages();
    console.log(`\x1b[35m上次会话结束得不干净：回填了 ${filled} 条合成工具结果，历史已修复。\x1b[0m`);
  }
} else {
  meta = createSession(SESSIONS_DIR, { model: process.env.AGENT_MODEL ?? "deepseek-chat" });
  console.log(`新会话 ${meta.id}（落盘于 ${sessionPath(SESSIONS_DIR, meta.id)}）`);
  console.log(`下次续上：node agent.mjs --resume ${meta.id}`);
}

const MODEL = meta.model; // 会话粒度的配置（s08）：冻结在 session_meta 里

// ─── system prompt：每轮拼装（s10），字节稳定（s07 纪律①）─────────────────

function assembleSystemPrompt(skills) {
  return buildSystemPrompt([
    "你是一个运行在用户终端里的编程助手。",
    `## 环境\n当前目录：${process.cwd()}\n操作系统：${process.platform}`,
    [
      "## 工具使用",
      "优先用专用工具（read_file / write_file / edit_file）操作文件；run_shell 用于其余一切。",
      "搜索/探索类的独立子任务（\"找出 X 在哪里被用到\"\"调研 Y 的实现\"）交给 task 工具的子代理去跑，别让中间过程灌进当前对话。",
      `超长的工具输出会被保存到 ${DEFAULTS.dir}/ 下的文件里、只回给你节选——需要细节时用 read_file 分段读取，不要重跑命令。`,
      "先观察真实世界再行动，不要凭空猜测文件内容。",
    ].join("\n"),
    formatSkillsSection(skills),
  ]);
}

/** 易变信息（当前时间）走用户消息尾部，绝不进 system（s07 纪律 × s10）。 */
function withVolatileReminder(text) {
  return `${text}\n\n<环境提醒>当前时间：${new Date().toISOString()}</环境提醒>`;
}

const CHILD_SYSTEM = `你是一个子代理，替监督者执行一个明确的子任务。
你看不到监督者的对话历史，也没有用户可以提问 —— 独立完成任务。
你的最后一条回复会被原样带回给监督者：把结论写全（发现了什么、依据是什么、结论是什么），不要说"详见上文"。
当前目录：${process.cwd()}
操作系统：${process.platform}`;

// ─── 工具注册表 ──────────────────────────────────────────────────────────
// 形态取各章的最终版：run_shell/read_file 是 s04 的（日志压缩 + 分段读取），
// 失败一律 throw、由 dispatch 转成结构化 status（s08 拆掉 FAILURE_RE 脚手架
// 之后的形态），load_skill 来自 s10，task 来自 s09。

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
      let raw;
      let failed = false;
      try {
        raw = execSync(command, {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024, // 大输出交给压缩 + 溢出接住（s04）
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || "(命令执行成功，无输出)";
      } catch (err) {
        failed = true;
        raw = `命令失败（exit ${err.status ?? "?"}）：\n${err.stdout ?? ""}${err.stderr ?? err.message}`;
      }
      // 日志先按重要性无损压缩（s04）：失败的输出也压——测试红着的日志往往最长。
      const packed = compressLog(raw);
      let out = raw;
      if (packed.compressed) {
        const file = saveSpill(raw);
        out =
          `${packed.content}\n` +
          `[已折叠 ${packed.inputLines - packed.outputLines} 行低信号日志。完整原文保存在 ${file}，` +
          `如果需要的行被折叠了，用 read_file 找回，不要重跑命令。]`;
      }
      if (failed) throw new Error(out); // 报错文案原样保留，成败由 dispatch 结构化
      return out;
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
      const lines = readFileSync(p, "utf8").split("\n");
      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + limit);
      let body = slice.map((line, i) => `${String(start + i).padStart(4)}\t${line}`).join("\n");
      let shown = slice.length;
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
      if (first === -1) throw new Error(`编辑失败：old_string 在 ${p} 中找不到。请先 read_file 确认原文。`);
      if (text.indexOf(old_string, first + 1) !== -1)
        throw new Error(`编辑失败：old_string 在 ${p} 中出现多次。请带上更多上下文让它唯一。`);
      writeFileSync(p, text.replace(old_string, new_string));
      return `已编辑 ${p}`;
    },
  },

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
      const skills = loadSkills(SKILLS_DIR);
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        const available = skills.map((s) => s.name).join("、") || "（无）";
        throw new Error(`未找到技能"${name}"。可用技能：${available}。请使用目录中列出的确切名字。`);
      }
      return `# 技能：${skill.name}\n\n${skill.body}`;
    },
  },
};

// task 工具（s09）：同一批调用里一模一样的 brief 只跑一次。
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
      const hooks = {
        onKill: (reason, ms) =>
          console.log(`\n\x1b[35m  ⚰ 子代理 ${id} 被看门狗击杀（${reason}，${Math.round(ms / 1000)} 秒）→ 进入遗言回合\x1b[0m`),
        onExtend: (ms, n) => console.log(`\x1b[35m  ⏳ 子代理 ${id} 硬顶到点但还活着，延期 ${ms / 1000} 秒（第 ${n} 次）\x1b[0m`),
      };
      const { disposition, result, durationMs } = await runChildWithWatchdog(adapter, SUB_LIMITS, hooks);
      if (disposition === "completed") {
        const final = result || "子代理完成，但没有留下最终回复。";
        batchBriefs.set(key, { id, result: final });
        return final;
      }
      // 击杀不等于作废：给尸体一次短回合，抢救它已经完成的工作（s09）。
      child.resetForConclude();
      const conclude = await runChildWithWatchdog(
        { ...adapter, run: () => child.runTurn(concludePrompt(disposition, durationMs)) },
        { ...SUB_LIMITS, timeoutMs: SUB_LIMITS.concludeTimeoutMs },
      );
      const salvage =
        conclude.disposition === "completed" && conclude.result
          ? `\n\n【遗言 —— 子代理被中止前的自述，可作为下次派发的起点】\n${conclude.result}`
          : "";
      const why =
        disposition === "stale"
          ? `太久没有任何事件（疑似卡死，闲置预算 ${SUB_LIMITS.staleIdleMs / 1000} 秒）`
          : `超过墙钟硬顶 ${SUB_LIMITS.timeoutMs / 1000} 秒且已无生命迹象`;
      throw new Error(`子代理 ${id} 被看门狗中止：${why}。考虑把任务拆小或换一条路。${salvage}`);
    },
  },
};

// 子代理的工具箱：没有 task（深度上限 1，防套娃），也没有 load_skill
// （子任务的指引应该写全在 brief 里，而不是让子代理自己翻目录）。
const CHILD_REGISTRY = { run_shell: BASE_REGISTRY.run_shell, read_file: BASE_REGISTRY.read_file, write_file: BASE_REGISTRY.write_file, edit_file: BASE_REGISTRY.edit_file };

const toToolDefs = (registry) =>
  Object.entries(registry).map(([name, t]) => ({
    type: "function",
    function: { name, description: t.description, parameters: t.parameters },
  }));
// s07 纪律②：tools 数组进程内字节稳定 —— 只在启动时算一次，运行中绝不增删排序。
const TOOLS = toToolDefs(REGISTRY);
const CHILD_TOOLS = toToolDefs(CHILD_REGISTRY);

/** 结构化成败（s08）：return = completed，throw = failed。
 *  报错依旧作为文本回给模型（错误即信息），但"失败"这个事实不再靠猜前缀。 */
async function dispatch(call, registry) {
  const tool = registry[call.function.name];
  if (!tool) return { status: "failed", output: `未知工具：${call.function.name}` };
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch (err) {
    return { status: "failed", output: `工具参数不是合法 JSON：${err.message}` };
  }
  try {
    return { status: "completed", output: await tool.handler(args) };
  } catch (err) {
    return { status: "failed", output: err.message };
  }
}

// ─── 缓存仪表盘（s07）────────────────────────────────────────────────────
// s07 没有机制模块可 import —— 缓存工程本来就不是组件，是贯穿全部代码的
// 纪律（system 字节稳定、tools 顺序稳定、messages 只追加）。仪表盘这
// 三十行是它唯一的代码形态，原样搬来。

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
  if (!usage) return;
  const u = readCacheUsage(usage);
  if (u.hit === undefined) {
    console.log(`\x1b[36m📊 prompt ${u.prompt} tokens（该服务商未返回缓存字段）\x1b[0m`);
    return;
  }
  sessionTotals.prompt += u.prompt;
  sessionTotals.hit += u.hit;
  const rate = u.prompt > 0 ? ((u.hit / u.prompt) * 100).toFixed(1) : "0.0";
  const saved = u.prompt > 0 ? ((u.hit * 0.9) / u.prompt) * 100 : 0;
  const total = sessionTotals.prompt > 0 ? ((sessionTotals.hit / sessionTotals.prompt) * 100).toFixed(1) : "0.0";
  console.log(
    `\x1b[36m📊 prompt ${u.prompt} | 命中 ${u.hit}（${rate}%）| 未命中 ${u.miss} | 本轮输入费≈省 ${saved.toFixed(0)}% | 会话累计命中 ${total}%\x1b[0m`,
  );
}

// ─── 模型调用：流式（s05），顺带把 usage 捞回来（s06/s07 都要用）─────────

async function chat({ system, msgs, tools, signal, onDelta }) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, ...msgs],
      tools,
      stream: true,
      // 流式响应默认不带 usage；这个 OpenAI 兼容开关让服务商在 [DONE] 前
      // 补一个 usage 事件（DeepSeek 同语义）。没有 usage，s06 的触发判定
      // 和 s07 的仪表盘都会瞎。
      stream_options: { include_usage: true },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`API ${res.status}：${await res.text()}`);

  const assembler = createAssembler();
  let usage;
  try {
    for await (const event of sseJsonEvents(res.body)) {
      if (event.usage) usage = event.usage; // 只带 usage 的收尾事件，choices 为空
      const textDelta = assembler.feed(event);
      if (textDelta) onDelta?.(textDelta);
    }
  } catch (err) {
    if (!signal?.aborted) throw err; // 中断掐断流：半截消息照常从装配器返回
  }
  return { message: assembler.message(), usage, aborted: signal?.aborted ?? false };
}

// 摘要调用（s06）：不带 tools、不走流式。失败直接 throw，
// compactMessages 内部会降级为提取式摘要 —— 会话绝不因压缩失败陪葬。
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

// ─── 压缩检查（s06 × s08）────────────────────────────────────────────────

async function maybeCompact(usage) {
  const decision = shouldCompact({
    usage,
    contextWindow: CONTEXT_WINDOW,
    triggerPercent: COMPACT_PERCENT,
    messageCount: messages.length,
    minMessages: COMPACT_MIN_MESSAGES,
  });
  if (!decision.compact) return;

  console.log(`\n\x1b[36m🗜️ 触发压缩：${decision.why}\x1b[0m`);
  const result = await compactMessages(messages, { summarize: summarizeViaModel });
  if (!result.compacted) {
    console.log("\x1b[36m   可压的前缀太小，本次跳过。\x1b[0m");
    return;
  }
  messages.splice(0, messages.length, ...result.messages);
  for (const m of messages) persisted.add(m); // 摘要消息经快照落盘，不再走 pushMessage
  // 压缩后的工作集整体落一个快照事件。日志里旧消息一行不动（无损审计），
  // 恢复时 replayCompacted 以最后一个快照为准 —— 压缩是"视图"，日志是"事实"。
  appendEvent(SESSIONS_DIR, meta.id, { type: "compaction", messages: [...messages] });
  console.log(
    `\x1b[36m🗜️ 压缩完成：压掉 ${result.dropped} 条${result.degraded ? "（摘要降级为提取式）" : ""}，现存 ${messages.length} 条。\x1b[0m`,
  );
}

// ─── 子代理引擎（s09）：全新 messages 的迷你循环，心跳按流 token 刷 ───────

function createChild() {
  const listeners = new Set();
  const emit = () => {
    for (const cb of listeners) cb();
  };
  const childMessages = []; // 上下文隔离的全部秘密：这是一个空数组
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
      interrupted = true;
      controller?.abort();
    },
    resetForConclude() {
      interrupted = false;
    },
    async runTurn(prompt) {
      childMessages.push({ role: "user", content: prompt });
      const budget = new LoopBudget({ baseSteps: 12 }); // 行为看门狗照旧管"转圈"
      let last = "";
      while (!interrupted && budget.canContinue()) {
        controller = new AbortController();
        let msg;
        try {
          // s09 里子代理按回合刷心跳；接上 s05 的流式后可以做到和真实产品
          // 一样 —— 每个流 token 都是一次心跳（onDelta: emit），静默不打印。
          ({ message: msg } = await chat({
            system: CHILD_SYSTEM,
            msgs: childMessages,
            tools: CHILD_TOOLS,
            signal: controller.signal,
            onDelta: emit,
          }));
        } catch (err) {
          if (interrupted) break; // 被看门狗击杀：请求被 abort，安静收口
          throw err;
        }
        emit();
        if (interrupted) break;
        childMessages.push(msg);
        if (msg.content) last = msg.content;
        if (!msg.tool_calls?.length) break;

        const records = [];
        for (const call of msg.tool_calls) {
          if (interrupted) break;
          toolRunning = true; // 看门狗据此切换到宽松的在途预算
          const { status, output } = await dispatch(call, CHILD_REGISTRY);
          toolRunning = false;
          emit(); // 每次工具调用完成也是一次心跳
          childMessages.push({ role: "tool", tool_call_id: call.id, content: output });
          let input = {};
          try {
            input = JSON.parse(call.function.arguments || "{}");
          } catch { /* 坏参数已作为失败回填 */ }
          records.push({ name: call.function.name, input, status, output });
        }
        if (budget.recordTurn(records)) break; // 子代理熔断不纠偏，直接收口交回
      }
      return last;
    },
  };
}

// ─── 主循环：s01 的 while，挂满了前十一章的机制 ───────────────────────────

let activeTurn = null; // 当前这轮的 AbortController（s05）；null = 没有轮次在跑

function finishInterrupt() {
  const filled = repairDanglingToolCalls(messages); // s05：修复撕裂的消息序列
  persistNewMessages(); // s08：修复插入的合成消息也要进日志
  console.log(
    `\n\x1b[31m⏹ 本轮已中断${filled ? `，回填了 ${filled} 条合成工具结果` : ""}。会话可以继续。\x1b[0m`,
  );
}

async function runTurn() {
  // s10：每轮开工前重扫技能目录、重拼 system —— 拼装确定性，缓存照样命中。
  const system = assembleSystemPrompt(loadSkills(SKILLS_DIR));
  const budget = new LoopBudget({ baseSteps: 12 }); // s03：软预算 + 硬顶
  let repaired = false;
  const controller = new AbortController(); // s05：中断贯穿到 HTTP 层
  activeTurn = controller;

  try {
    while (true) {
      if (!budget.canContinue()) {
        const stop = budget.exhaustedStop();
        console.log(`\n\x1b[31m⛔ ${stop.message}（第 ${stop.turnCount} 轮）\x1b[0m`);
        return;
      }
      console.log(`\x1b[2m—— 循环第 ${budget.turns + 1} 步（预算 ${budget.budget}，硬顶 ${budget.hardMaxSteps}）\x1b[0m`);

      let result;
      try {
        result = await chat({
          system,
          msgs: messages,
          tools: TOOLS,
          signal: controller.signal,
          onDelta: (d) => process.stdout.write(d), // 用户看到的"打字机"
        });
      } catch (err) {
        if (!controller.signal.aborted) throw err;
        return finishInterrupt(); // 中断落在建连阶段：一个增量都没收到
      }
      const { message: msg, usage, aborted } = result;
      if (msg.content) process.stdout.write("\n");
      printUsage(usage); // s07：每轮打印缓存命中率
      // 半截消息也要进历史（s05）：已经流出来的文字用户看到了，空壳才丢弃。
      if (msg.content || msg.tool_calls?.length) pushMessage(msg); // s08：落盘
      if (aborted) return finishInterrupt();
      if (!msg.tool_calls?.length) {
        await maybeCompact(usage); // s06：纯文本收尾的轮次也要检查
        return;
      }

      batchBriefs = new Map(); // s09：brief 去重的作用域是同一批调用
      const records = [];
      for (const call of msg.tool_calls) {
        if (controller.signal.aborted) break; // 中断落在工具缝隙里（s05）
        const { status, output } = await dispatch(call, REGISTRY);
        let input = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch { /* 坏参数已作为失败回填 */ }
        records.push({
          call,
          name: call.function.name,
          input,
          status, // 结构化成败（s08）：在溢出改写 output 之前就已确定
          output,
          spillable: call.function.name !== "read_file", // 文件自己就是指针（s04）
        });
      }

      // s04：先看全局再决定谁溢出（largest-first），然后才回填 messages。
      const { spilled } = enforceTurnBudget(records);
      if (spilled.length > 0) {
        console.log(`\x1b[35m  ⤵ ${spilled.length} 条超预算输出已溢出：${spilled.join("、")}\x1b[0m`);
      }
      for (const r of records) {
        pushMessage({ role: "tool", tool_call_id: r.call.id, content: r.output }); // s08
        appendEvent(SESSIONS_DIR, meta.id, {
          type: "tool_call",
          record: { id: r.call.id, name: r.name, input: r.input, status: r.status },
        });
      }
      if (controller.signal.aborted) return finishInterrupt();

      await maybeCompact(usage); // s06：工具结果刚落地是上下文长胖最快的时刻

      const stop = budget.recordTurn(records); // s03：喂看门狗
      if (!stop) continue;

      if (isRecoverable(stop) && !repaired) {
        repaired = true;
        console.log(`\n\x1b[35m🟡 看门狗触发（${stop.reason}），注入纠偏 prompt…\x1b[0m`);
        pushMessage({ role: "user", content: repairPrompt(stop) }); // 纠偏也是历史
        continue;
      }
      console.log(`\n\x1b[31m⛔ ${stop.message}（reason=${stop.reason}，第 ${stop.turnCount} 轮）\x1b[0m`);
      return;
    }
  } finally {
    activeTurn = null;
  }
}

// ─── Ctrl+C：第一次中断本轮，第二次退出（s05）────────────────────────────

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
rl.on("SIGINT", onInterrupt);
process.on("SIGINT", onInterrupt);
rl.on("close", () => process.exit(0)); // stdin 走到头（管道喂入 / Ctrl+D）：干净收场

const bootSkills = loadSkills(SKILLS_DIR);
console.log(
  `s12 合体 agent 已上线（${MODEL}，流式）。工具：${Object.keys(REGISTRY).join("、")}。` +
    `技能 ${bootSkills.length} 个。窗口 ${CONTEXT_WINDOW}，${COMPACT_PERCENT}% 触发压缩。子代理硬顶 ${SUB_LIMITS.timeoutMs / 1000} 秒。`,
);

while (true) {
  const line = (await rl.question("\n你> ")).trim();
  if (!line) continue;
  pushMessage({ role: "user", content: withVolatileReminder(line) }); // s10 × s08
  await runTurn();
}
