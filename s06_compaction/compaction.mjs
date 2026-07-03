// 上下文压缩 —— 让 agent 忘掉过程，但绝不忘掉任务。
//
// 从真实产品 Reina 的 packages/core/src/compaction.ts 简化移植，机制一致：
//   · 触发：用服务商返回的 usage 对照模型窗口，不做本地估算
//   · 切片：三段式 [被压缩的中段] + [启动任务的用户消息，逐字保留] + [最近尾部]
//   · 摘要：结构化 prompt（不是"总结一下"），失败时降级为提取式摘要
//   · 铁律：压缩绝不能因为压缩失败而毁掉会话

// ─── ① 触发决策：信服务商的账本，不信自己的估算 ───────────────────────────
//
// 本地数 token 对不上服务商的 tokenizer（中文误差尤其大，轻松差出 15%+），
// 估少了会在真正的窗口边界撞出 "context too long"。上一次 API 响应的
// usage 是服务商亲口报的数——它说多少就是多少。
// total_tokens = prompt + completion ≈ 下一轮请求要背的全部历史。
export function shouldCompact({ usage, contextWindow, triggerPercent = 75, messageCount, minMessages = 12 }) {
  if (!usage) return { compact: false, why: "还没有任何 API 响应，无从判断" };
  if (messageCount < minMessages) {
    return { compact: false, why: `消息太少（${messageCount} < ${minMessages}），压了也腾不出几个 token` };
  }
  const used = usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  const threshold = Math.floor((contextWindow * triggerPercent) / 100);
  if (used < threshold) {
    return { compact: false, why: `${used} / ${contextWindow} tokens（阈值 ${threshold}），还有余量`, used, threshold };
  }
  return { compact: true, why: `${used} tokens 已超过阈值 ${threshold}（窗口的 ${triggerPercent}%）`, used, threshold };
}

// ─── ② 切片决策：切哪里，比怎么摘要更重要 ─────────────────────────────────
//
// 返回分割点 keepFrom：messages[0, keepFrom) 被压缩，messages[keepFrom, ∞) 原样保留。
// 返回 0 = 不值得压。
//
// 两条规则，一条语法约束：
//   a) 尾部至少保留 keepRecent 条——最近的工具结果是模型正在用的工作记忆。
//   b) 分割点回拉到最后一条真实用户消息（role === "user"），让"用户到底让我
//      干嘛"逐字活过压缩。长任务里这条消息往往在几十条工具结果之前——不回拉，
//      它就会被摘要转述，而转述必然走样（Reina 真实修过的坑，见 README）。
//      回拉有上限（maxAnchorChars）：保留区太大，压缩就腾不出空间了。
//   c) 语法约束：OpenAI 格式里 role:"tool" 消息必须紧跟它的 assistant
//      tool_calls 消息，切口不能落在一对中间，否则下一次请求直接 400。
export function compactSplitIndex(messages, { keepRecent = 8, maxAnchorChars = 40_000 } = {}) {
  if (messages.length <= keepRecent) return 0;
  let keepFrom = messages.length - keepRecent;

  const lastUser = messages.findLastIndex((m) => m.role === "user");
  if (lastUser >= 0 && lastUser < keepFrom) {
    const anchoredChars = charsOf(messages.slice(lastUser));
    if (anchoredChars <= maxAnchorChars) keepFrom = lastUser;
    // 超限就不回拉——此时靠摘要 prompt 里"逐字引用用户原话"的条款兜底。
  }

  // 切口修正：不能让保留区以孤儿 tool 消息开头。向前多保留几条，
  // 直到把 tool 消息和它的 assistant tool_calls 划进同一侧。
  while (keepFrom > 0 && messages[keepFrom].role === "tool") keepFrom--;

  if (keepFrom <= 1) return 0; // 能压的太少，白白多花一次摘要调用
  return keepFrom;
}

// ─── ③ 摘要 prompt：结构化，不是"总结一下" ────────────────────────────────
//
// "总结一下"得到的是一段抒情散文，丢的恰好是接续任务最需要的硬信息。
// 逼模型按栏目填表，每一栏都对应"压缩后第一轮"会用到的东西。
// 第 1 栏的"逐字引用"是对切片规则 b) 的双保险：即使启动消息因超长
// 没能逐字保留，原话也还在摘要里。
export const SUMMARY_PROMPT = `你的任务是把一段即将被丢弃的对话压缩成结构化摘要。这份摘要是后续对话仅存的记忆，宁可啰嗦不可遗漏。只输出纯文本，不要调用任何工具。

必须包含以下小节：

1. 任务目标：用户让你做什么。逐字引用用户原话，禁止转述。
2. 已完成：做了哪些事、各自的结论。
3. 未完成 / 待办：接下来该做什么，按优先级排。
4. 涉及的文件与关键命令：完整路径和完整命令，逐字保留。
5. 关键决定与踩过的坑：为什么选了这条路，哪些路已被证明走不通。`;

// 被压缩的中段可能含 tool 消息和 assistant tool_calls——摘要请求不带 tools
// 参数，部分服务商会拒收这些结构。统一拍平成带标签的纯文本（Reina 的
// toSummarySourceMessages 同款处理），顺带把超长工具输出截到摘要够用的长度。
export function toSummarySource(middle) {
  const lines = [];
  for (const m of middle) {
    if (m.role === "tool") {
      lines.push(`[工具结果] ${clip(m.content, 1500)}`);
    } else if (m.role === "assistant") {
      if (m.content) lines.push(`[assistant] ${clip(m.content, 1500)}`);
      for (const call of m.tool_calls ?? []) {
        lines.push(`[assistant 调用工具] ${call.function.name}(${clip(call.function.arguments, 300)})`);
      }
    } else {
      lines.push(`[${m.role}] ${clip(m.content, 2000)}`);
    }
  }
  return lines.join("\n");
}

// ─── ④ 降级路径：摘要死了，会话不能陪葬 ───────────────────────────────────
//
// 摘要要调一次模型——而模型调用什么错都可能出（限流、超时、断网）。
// 此刻会话已经贴着窗口上限，"下一轮再试"往往等不起。提取式摘要不聪明，
// 但零依赖、永不失败：有损的记忆也比崩掉的会话强。
export function extractiveSummary(middle) {
  const lines = ["（自动降级：摘要模型调用失败，以下为逐条提取的对话骨架）"];
  for (const m of middle) {
    if (m.role === "tool") lines.push(`- 工具结果: ${clip(oneLine(m.content), 160)}`);
    else if (m.role === "assistant" && m.tool_calls?.length) {
      lines.push(`- assistant 调用: ${m.tool_calls.map((c) => c.function.name).join("、")}`);
    } else if (m.content) lines.push(`- ${m.role}: ${clip(oneLine(m.content), 240)}`);
  }
  return lines.join("\n");
}

// ─── 组装：执行一次压缩 ──────────────────────────────────────────────────
//
// summarize(middleText) 是调用方注入的异步函数（真 agent 里调 API，
// demo 里用替身）。返回新的 messages 数组，形状：
//   [摘要消息] + [保留尾部（以启动任务的用户消息开头，逐字未动）]
export async function compactMessages(messages, { summarize, keepRecent = 8, maxAnchorChars = 40_000 } = {}) {
  const keepFrom = compactSplitIndex(messages, { keepRecent, maxAnchorChars });
  if (keepFrom <= 0) return { compacted: false, messages };

  const middle = messages.slice(0, keepFrom);
  const tail = messages.slice(keepFrom);

  let summary;
  let degraded = false;
  try {
    summary = (await summarize(toSummarySource(middle)))?.trim();
    if (!summary) throw new Error("摘要为空");
  } catch {
    degraded = true;
    summary = extractiveSummary(middle);
  }

  const summaryMessage = {
    role: "user",
    content: `[上下文压缩] 更早的 ${middle.length} 条对话已被压缩，以下摘要是它们仅存的记忆：\n\n${summary}\n\n从中断处直接继续任务。不要复述摘要，不要重新自我介绍。`,
  };
  return { compacted: true, messages: [summaryMessage, ...tail], dropped: middle.length, degraded, summary };
}

// ─── 小工具 ──────────────────────────────────────────────────────────────

function charsOf(messages) {
  return messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
}

function clip(text, max) {
  if (typeof text !== "string") return "";
  return text.length <= max ? text : `${text.slice(0, max)}…(截断)`;
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
