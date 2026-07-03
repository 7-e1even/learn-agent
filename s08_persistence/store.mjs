// 会话落盘 —— 追加式事件日志（JSONL）+ 重放恢复。
//
// 从真实产品 Reina 的 packages/core/src/rollout.ts 简化移植，机制一致：
//   · 一个会话一个 <id>.jsonl，每发生一件事 append 一行 { ts, type, ... }
//   · 只追加、绝不回写已有字节 —— 崩溃最坏丢最后一行，不会损坏整个会话
//   · 恢复 = 逐行重放（replay）重建状态；坏行（半截写入）跳过，其余照常
//   · 会话粒度的配置（用的什么模型）记在第一行 session_meta 里，随重放恢复
//
// 事件类型（本章只用三种，真实产品有二十多种）：
//   session_meta —— 会话头：id、model、createdAt（永远是第一行）
//   message      —— 一条对话消息（user / assistant / tool，原样保存）
//   tool_call    —— 一次工具调用的结构化记录 { id, name, input, status }

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function sessionPath(dir, id) {
  return path.join(dir, `${id}.jsonl`);
}

/** 新建会话：生成 id，把 session_meta 作为第一行写下去。
 *  model 在这里被"冻结"进会话 —— 以后恢复时以这一行为准，
 *  而不是取恢复那一刻的环境默认值。 */
export function createSession(dir, { model }) {
  const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const meta = { id, model, createdAt: new Date().toISOString() };
  appendEvent(dir, id, { type: "session_meta", meta });
  return meta;
}

/** 追加一个事件。appendFileSync 用 "a" 标志打开 —— 操作系统层面的
 *  O_APPEND：每次写都落在文件末尾，永远不触碰已有内容。
 *  （Reina 为了性能和写入顺序保证，会常驻一个文件句柄并用 Promise
 *  链串行化写入；示例版每次重开，崩溃安全性完全一样。） */
export function appendEvent(dir, id, event) {
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  appendFileSync(sessionPath(dir, id), line + "\n");
}

/** 恢复 = 重放：逐行读事件，重建 { meta, messages, toolCalls }。
 *  解析失败的行（多半是崩溃时写了一半的最后一行）跳过并计数 ——
 *  丢一行，不丢整个会话。文件不存在或没有 session_meta 返回 null。 */
export function replaySession(dir, id) {
  let text;
  try {
    text = readFileSync(sessionPath(dir, id), "utf8");
  } catch {
    return null;
  }
  let meta = null;
  const messages = [];
  const toolCalls = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      skipped++; // 半截行：跳过，别让一行坏数据毁掉全部历史
      continue;
    }
    switch (event.type) {
      case "session_meta":
        meta = event.meta;
        break;
      case "message":
        messages.push(event.message);
        break;
      case "tool_call": {
        // 按 id upsert：同一次调用的后续更新（如 running → completed）覆盖前一条。
        const i = toolCalls.findIndex((r) => r.id === event.record.id);
        if (i === -1) toolCalls.push(event.record);
        else toolCalls[i] = { ...toolCalls[i], ...event.record };
        break;
      }
      default:
        // 未知事件类型（来自新版本写的日志）：忽略，老代码也能加载新会话。
        break;
    }
  }
  if (!meta) return null;
  return { meta, messages, toolCalls, skipped };
}

/** 列出目录下已有的会话 id（给 --resume 提示用）。 */
export function listSessionIds(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
}
