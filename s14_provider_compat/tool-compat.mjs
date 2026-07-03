// s14 · Provider 兼容层 —— 把"模型乱吐的 tool call"掰回引擎能执行的形状
//
// 一个循环要驱动一堆不同的模型（DeepSeek / Kimi / GLM / Qwen / 本地 Ollama…），
// 它们发 tool call 的规矩各不相同：名字叫得不一样、参数键名不一样、JSON 还常常
// 被截断或裹在一段散文里。引擎只想拿到 { name, input } 这个干净结构。
// 这里全是确定性的"掰形状"代码，不调模型。
//
// 移植自 Reina 的 packages/providers/src/tool-compat.ts（教学化精简）。

// ─── ① 工具名归一化：bash / shell → run_shell ────────────────────────────
export const TOOL_ALIASES = {
  bash: "run_shell",
  shell: "run_shell",
  sh: "run_shell",
  terminal: "run_shell",
  execute_command: "run_shell",
  cat: "read_file",
  open_file: "read_file",
  str_replace: "edit_file",
  apply_patch: "edit_file",
};

export function normalizeToolName(name) {
  if (typeof name !== "string") return name;
  return TOOL_ALIASES[name.trim().toLowerCase()] ?? name;
}

// ─── ② 参数键归一化：cmd / shellCommand → command ────────────────────────
// 每个规范工具声明它认的键 + 每个键的别名。只搬"规范键还空着"的，不覆盖模型填对的。
const FIELD_ALIASES = {
  run_shell: {
    command: ["cmd", "shellCommand", "shell_command", "script", "commandLine"],
    cwd: ["workdir", "working_directory", "directory"],
  },
  read_file: { path: ["file", "filename", "filepath", "file_path", "target"] },
  edit_file: {
    path: ["file", "filename", "file_path"],
    old_string: ["old", "search", "find", "oldText", "old_str"],
    new_string: ["new", "replace", "replacement", "newText", "new_str"],
  },
};

export function normalizeToolInput(toolName, input) {
  if (!input || typeof input !== "object") return input;
  const spec = FIELD_ALIASES[toolName];
  if (!spec) return input;
  const out = { ...input };
  for (const [canonical, aliases] of Object.entries(spec)) {
    if (out[canonical] != null) continue; // 模型已经填对了，别动
    for (const alias of aliases) {
      if (out[alias] != null) {
        out[canonical] = out[alias];
        delete out[alias];
        break;
      }
    }
  }
  return out;
}

// ─── ③ 截断 JSON 修复：补齐悬空字符串和不配平的括号 ──────────────────────
// 输出被 max_tokens 砍断，最后一段 JSON 残缺。扫一遍记住括号栈和"是否在字符串里"，
// 到末尾把没关的引号、按栈逆序把没配平的括号补上。修不好返回 null。
export function repairTruncatedJson(text) {
  if (typeof text !== "string") return null;
  const s = text.trim();
  const start = s.indexOf("{");
  if (start === -1) return null;

  const stack = [];
  let inString = false;
  let escaped = false;
  let end = s.length;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) {
        end = i + 1;
        break;
      }
    }
  }

  let repaired = s.slice(start, end);
  if (inString && end === s.length) {
    if (escaped) repaired += "\\";
    repaired += '"';
  }
  if (end === s.length) {
    for (let i = stack.length - 1; i >= 0; i--) {
      repaired += stack[i] === "{" ? "}" : "]";
    }
  }

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

// ─── ④ 从散文里抠出工具调用对象 ──────────────────────────────────────────
export function extractEmbeddedObject(text) {
  if (typeof text !== "string") return null;

  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fence) {
    const obj = tryParseOrRepair(fence[1]);
    if (obj) return obj;
  }

  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return tryParseOrRepair(text.slice(start, i + 1));
    }
  }
  return tryParseOrRepair(text.slice(start));
}

function tryParseOrRepair(chunk) {
  try {
    return JSON.parse(chunk);
  } catch {
    return repairTruncatedJson(chunk);
  }
}

// ─── ⑤ 解析入口 + "降级过标记" ───────────────────────────────────────────
// 引擎只想要 { name, input }。解析走三级：直解 → 修复 → 从散文抠。
// 关键一手：凡是靠"修复/抠取"猜出来的结果，打一个 fallback 标记。引擎看到标记，
// 就回模型一条 observation："你的 JSON 没解析成功，我尽量补了，下次请直接走工具调用"
// ——让模型知道自己错了、能自愈，而不是把一个可能被猜歪的参数静默执行掉。
const FALLBACK = new WeakSet();

export function wasJsonParseFallback(result) {
  return result != null && FALLBACK.has(result);
}

export function parseToolCall(rawName, rawArguments) {
  const name = normalizeToolName(rawName);

  let input;
  let usedFallback = false;

  if (rawArguments && typeof rawArguments === "object") {
    input = rawArguments; // provider 已经给了对象
  } else if (typeof rawArguments === "string") {
    try {
      input = JSON.parse(rawArguments); // 正路：合法 JSON
    } catch {
      input = repairTruncatedJson(rawArguments) ?? extractEmbeddedObject(rawArguments);
      usedFallback = input != null;
    }
  }

  if (input == null) return null; // 彻底解析不出，让上层报错

  input = normalizeToolInput(name, input);
  const result = { name, input };
  if (usedFallback) FALLBACK.add(result);
  return result;
}
