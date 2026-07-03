#!/usr/bin/env node
// 假模型服务器 —— 零依赖，node:http 实现 OpenAI 兼容的 /chat/completions。
//
// 它回答一个所有 agent 工程师都会撞上的真实问题：怎么不烧钱地测试 agent？
// 单元测试测得了模块，测不了"接线"——工具真的执行了吗？流式半途中断修得
// 回来吗？压缩触发时摘要调用发出去了吗？这些只有让整个 agent 端到端跑一遍
// 才知道。而端到端跑一遍不该花一分钱、也不该看模型心情。
//
// 做法：把服务商换成一个"照剧本念台词"的假模型。agent 完全不知情 ——
// 它眼里这就是一个 OpenAI 兼容端点：SSE 流式、tool_calls 分片、usage 带
// 缓存字段，一应俱全。剧本决定每一轮说什么，于是每个机制都能被精确触发。
// （真实产品同款思路：Reina 内置一个 deterministic provider，
// packages/providers/src/index.ts，engine 的全部测试靠它免 key 跑通。）
//
// 单独跑：node mock-server.mjs [端口]
// 然后：  AGENT_API_KEY=mock AGENT_BASE_URL=http://127.0.0.1:<端口>/v1 node agent.mjs
// 或者直接 node selftest.mjs —— 它会在进程内起本服务器并全自动验收。

import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** usage 生成器：DeepSeek 语义的缓存字段（prompt_cache_hit/miss_tokens）。
 *  OpenAI 语义（prompt_tokens_details.cached_tokens）也一并给上 ——
 *  真实服务商只给一种，假服务商两种都给，顺便验证 agent 的兼容读取。 */
function usage(prompt, hit, completion) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: prompt - hit,
    prompt_tokens_details: { cached_tokens: hit },
  };
}

const call = (name, args) => ({ id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, args });
const shell = (command) => call("run_shell", { command });

// ─── 剧本：根据请求内容决定这一轮说什么 ─────────────────────────────────
//
// 路由的依据全部来自请求体本身（system 前缀、user 标记、assistant 计数），
// 不在服务器里存任何会话状态 —— 和真模型一样，它是无状态的。

function decide(body) {
  const messages = body.messages ?? [];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const assistants = messages.filter((m) => m.role === "assistant").length;

  // ① 压缩的摘要调用（s06）：system 是结构化摘要指令、不带 tools。
  if (system.startsWith("你的任务是把一段即将被丢弃的对话压缩")) {
    return {
      content: [
        "1. 任务目标：用户原话——\"开始全流程演习\"。",
        "2. 已完成：探测命令、超大输出、子代理调研、技能加载均已执行。",
        "3. 未完成 / 待办：收尾汇报。",
        "4. 涉及的文件与关键命令：node -e 探测命令若干；溢出文件见 .agent-spill/。",
        "5. 关键决定与踩过的坑：子代理调研被看门狗中止，遗言已抢救。",
      ].join("\n"),
      usage: usage(30_000, 28_000, 200),
    };
  }

  // ② 子代理的请求（s09）：system 以子代理身份开头。
  if (system.startsWith("你是一个子代理")) {
    // 遗言回合：被击杀后的短回合，只述职不干活。
    if (lastUser.includes("遗言回合")) {
      return {
        content:
          "1. 原任务：调研 mock 环境并汇报。2. 已完成：跑通一条探测命令，确认 shell 可用、输出可回收。3. 未完成：深入调研被中止；建议把任务拆成更小的 brief 重派。",
        usage: usage(1_400, 900, 80),
      };
    }
    // 第一轮：正常干活，调一次工具。
    if (assistants === 0) {
      return {
        content: "先跑一条探测命令。",
        toolCalls: [shell(`node -e "console.log('subagent probe ok')"`)],
        usage: usage(900, 0, 40),
      };
    }
    // 第二轮：永远不回话 —— 物理卡死，交给 s09 的心跳看门狗来抓。
    return { hang: true };
  }

  // ③ 恢复后的对话（s08 --resume）：用 user 标记路由，不依赖轮数。
  if (lastUser.includes("恢复检查")) {
    return {
      content: "会话已接上：模型、历史、工具记录都是从事件日志重放回来的，中断处回填的合成工具结果也在。",
      usage: usage(21_000, 18_000, 60),
    };
  }

  // ④ 主 agent 的演习剧本：按历史里的 assistant 条数推进（每轮 +1，天然的回合指针）。
  switch (assistants) {
    case 0: // 普通工具调用：流式 content + tool_calls 分片
      return {
        content: "收到，先探测一下环境。",
        toolCalls: [shell(`node -e "console.log('hello from s12 selftest')"`)],
        usage: usage(3_200, 0, 60),
      };
    case 1: // 制造一条超预算的大输出，逼出 s04 的溢出
      return {
        content: "再制造一条超预算的大输出。",
        toolCalls: [shell(`node -e "process.stdout.write('x'.repeat(120000))"`)],
        usage: usage(3_400, 3_100, 50),
      };
    case 2: // 派子代理（s09）——它的第二轮会卡死，看门狗登场
      return {
        content: "这个调研活交给子代理。",
        toolCalls: [call("task", { description: "调研 mock 环境并汇报" })],
        usage: usage(6_200, 3_400, 50),
      };
    case 3: // 按需加载技能正文（s10）
      return {
        content: "收尾前先加载提交规范技能。",
        toolCalls: [call("load_skill", { name: "git-commit-convention" })],
        usage: usage(7_800, 6_200, 40),
      };
    case 4: // 第一个 turn 收尾：usage 未过阈值，压缩不触发
      return {
        content: "第一阶段演习完成：命令、溢出、子代理、技能都过了一遍。",
        usage: usage(39_000, 30_000, 300),
      };
    default: // 第二个 turn：usage 越过阈值（90k > 100k×75%），压缩触发
      return {
        content: "全流程演习收尾完毕。",
        usage: usage(89_000, 80_000, 400),
      };
  }
}

// ─── SSE 流式回放：把剧本"演"成 OpenAI 兼容的分片 ───────────────────────

async function streamReply(res, { content = "", toolCalls = [], usage }, delayMs) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const chunk = (delta, finish_reason = null) => ({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason }],
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send(chunk({ role: "assistant", content: "" }));
  // content 切成小片逐个吐 —— agent 端的打字机效果就来自这里。
  for (let i = 0; i < content.length; i += 6) {
    send(chunk({ content: content.slice(i, i + 6) }));
    await sleep(delayMs);
  }
  // tool_calls 按真实服务商的阴间方式分片：先给 id + 函数名，
  // arguments 是被切碎的 JSON 字符串（s05 的装配器就是为这个练的）。
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    send(chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: "" } }] }));
    const args = JSON.stringify(tc.args);
    for (let j = 0; j < args.length; j += 10) {
      send(chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 10) } }] }));
      await sleep(delayMs);
    }
  }
  send(chunk({}, toolCalls.length > 0 ? "tool_calls" : "stop"));
  // usage 收尾事件：choices 为空、只带账本（stream_options.include_usage 语义）。
  send({ id: "chatcmpl-mock", object: "chat.completion.chunk", model: "mock-model", choices: [], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ─── 服务器 ─────────────────────────────────────────────────────────────

export function createMockServer({ delayMs = 3 } = {}) {
  const hanging = new Set(); // 剧本要求"永不回话"的响应，关服时统一销毁
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404).end("mock server 只认 POST …/chat/completions");
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const reply = decide(body);
      if (reply.hang) {
        hanging.add(res); // 什么都不写：让 agent 的心跳看门狗自己发现
        req.on("close", () => hanging.delete(res));
        return;
      }
      if (body.stream === true) {
        await streamReply(res, reply, delayMs).catch(() => {}); // 客户端 abort 掐断连接不算错
      } else {
        // 非流式（摘要调用走这里）：一次性返回完整 completion。
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content: reply.content }, finish_reason: "stop" }],
            usage: reply.usage,
          }),
        );
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return {
    start: (port = 0) =>
      new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          const { port: p } = server.address();
          resolve({ port: p, url: `http://127.0.0.1:${p}/v1` });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        for (const res of hanging) res.destroy();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// 直接运行 = 单独起服务，方便手动把 agent 指过来玩。
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const port = Number(process.argv[2] ?? 8390);
  const { url } = await createMockServer().start(port);
  console.log(`假模型服务器已上线：${url}`);
  console.log(`试试：AGENT_API_KEY=mock AGENT_BASE_URL=${url} node agent.mjs`);
}
