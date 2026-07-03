// 流式与中断 —— 本章的机制模块，零依赖。
//
// 三件事：
//   1. sseJsonEvents：手工解析 OpenAI 兼容的 SSE 流（data: 行、[DONE]、按行缓冲）
//   2. createAssembler：把 delta 分片装配回一条完整的 assistant 消息
//      （content 逐段拼接；tool_calls 按 index 聚合，arguments 是碎 JSON 字符串分片）
//   3. repairDanglingToolCalls：中断后修复消息序列 —— 给悬空的 tool_call
//      回填合成结果，会话才能继续（协议要求每个 tool_call 必须有对应的 tool 消息）
//
// 对应真实产品 Reina 的 packages/providers/src/tool-pairing.ts
// （codex 同款的双向配平：悬空 call 合成占位输出，孤儿结果降级为文本）。

/** 逐事件解析 SSE 字节流。body 是任何异步可迭代的字节块序列
 *  （fetch 的 response.body 就是），每拿到一条 `data: {...}` 就 yield 出解析
 *  好的 JSON 对象，遇到 `data: [DONE]` 结束。
 *
 *  关键点是**按行缓冲**：TCP/代理切分数据从不看语义，一个 chunk 可能停在
 *  半行、甚至半个多字节字符的中间 —— 所以字节先过 TextDecoder(stream 模式)，
 *  文本攒进缓冲区，凑出完整的一行才处理一行。 */
export async function* sseJsonEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      // 空行是事件分隔符；": xxx" 开头的是注释行（有些网关拿它当心跳）——都跳过。
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      yield JSON.parse(payload);
    }
  }
}

/** delta 装配器：喂进一个个流式事件，最后拿回一条完整的 assistant 消息。
 *
 *  content 好办 —— 字符串逐段拼。tool_calls 阴得多：
 *    · 一次 delta 可能只带 id，可能只带函数名，也可能只带 arguments 的几个字符；
 *    · arguments 是被切碎的 JSON 字符串分片 —— 拼完之前 parse 必炸，
 *      所以只做 += ，把 parse 留给拼完之后的人；
 *    · 并行工具调用时多个 call 交错到达，靠 delta 里的 index 归队。 */
export function createAssembler() {
  let content = "";
  const toolCalls = []; // index -> 聚合中的 tool_call
  let finishReason = null;

  return {
    /** 喂一个 SSE 事件，返回本次新到的文本增量（调用方拿去实时打印）。 */
    feed(event) {
      const choice = event.choices?.[0];
      if (!choice) return ""; // 有些兼容端在最后补一个只带 usage 的空 choices 事件
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      const textDelta = delta.content ?? "";
      content += textDelta;
      for (const tc of delta.tool_calls ?? []) {
        const slot = (toolCalls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
      return textDelta;
    },

    /** 流结束（或被中断）后取出装配结果。中断时拿到的就是"半截消息"——
     *  已经流出来的部分都在，这正是修复函数的输入。 */
    message() {
      const msg = { role: "assistant", content };
      const calls = toolCalls.filter(Boolean);
      if (calls.length > 0) msg.tool_calls = calls;
      return msg;
    },

    finishReason: () => finishReason,
  };
}

export const INTERRUPT_NOTE = "(用户中断了执行，该工具未运行——不是工具失败，需要时可以重新调用)";

/** 中断后修复消息序列。OpenAI 协议的硬性要求：assistant 消息里的每个
 *  tool_call，后面都必须跟一条对应 tool_call_id 的 tool 消息 —— 否则下一次
 *  API 调用直接 400。中断恰好会把序列撕成半截：tool_calls 已经进了历史，
 *  工具却没跑（或只跑了一半的批次）。
 *
 *  修复动作有两个：
 *    1. 给每个悬空的 tool_call 回填一条合成 tool 结果（文案写明"用户中断、
 *       未运行"，防止模型误以为工具失败而盲目重试）；
 *    2. arguments 可能断在 JSON 中间（流被掐断时最后一个分片没到齐），
 *       断裂的参数修成 "{}" —— 挑剔的后端会校验历史里的这段字符串。
 *
 *  返回回填的条数。对完整的序列是无操作，随便多跑几遍都安全（幂等）。 */
export function repairDanglingToolCalls(messages, note = INTERRUPT_NOTE) {
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  let repaired = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;
    for (const tc of msg.tool_calls) {
      try {
        JSON.parse(tc.function.arguments || "{}");
      } catch {
        tc.function.arguments = "{}";
      }
    }
    const missing = msg.tool_calls.filter((tc) => !answered.has(tc.id));
    if (missing.length === 0) continue;
    // 回填插在 assistant 消息紧后面，和真实 tool 结果保持同一块 —— 有些后端
    // 要求 tool 消息紧跟发起它的 assistant 消息，中间不能夹别的角色。
    messages.splice(i + 1, 0, ...missing.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: note })));
    repaired += missing.length;
  }
  return repaired;
}
