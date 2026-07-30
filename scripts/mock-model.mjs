/**
 * 本地 e2e 冒烟测试用的 anthropic-messages 假模型。
 * 行为：第一轮发起 search_notes，第二轮 read_notes，第三轮输出带哨兵与受控引用的正文。
 * 同时把每次请求的 system 落盘，便于验证判决簿注入。
 * 仅用于开发验证，切勿在生产配置里指向它。
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT || 9410);
const LOG = process.env.MOCK_LOG || "/tmp/mock-model.log";

function collectToolResults(messages) {
  // 只统计最后一条用户提问之后的 tool_result（即本轮 agent loop 的进度）
  let lastUserText = -1;
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text" }];
    if (blocks.some((b) => b.type === "text" || typeof message.content === "string")) lastUserText = index;
  });
  const results = [];
  for (const message of messages.slice(lastUserText >= 0 ? lastUserText : 0)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c.text || "").join("\n")
          : String(block.content || "");
        results.push(text);
      }
    }
  }
  return results;
}

function decide(body) {
  const system = Array.isArray(body.system)
    ? body.system.map((s) => s.text || "").join("\n")
    : String(body.system || "");
  appendFileSync(LOG, `\n===== request ${new Date().toISOString()} =====\n${system}\n`);

  // 墓碑润色请求：无 tools、system 里带"墓碑"
  if (system.includes("墓碑")) {
    return { kind: "text", text: "用户否决了直接堆砌通用解释的方向，因为它偏离了验证判决簿闭环这个目标" };
  }

  const toolResults = collectToolResults(body.messages || []);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (hasTools && toolResults.length === 0) {
    return { kind: "tool", name: "search_notes", input: { query: "判决簿 测试" } };
  }
  if (hasTools && toolResults.length === 1) {
    const ids = [...new Set((toolResults[0].match(/chunk-[0-9a-f]{24}/g) || []))];
    return { kind: "tool", name: "read_notes", input: { chunkIds: ids.slice(0, 2) } };
  }
  const all = toolResults.join("\n");
  const ids = [...new Set(all.match(/chunk-[0-9a-f]{24}/g) || [])];
  const cite = ids.length ? `[[source:${ids[ids.length - 1]}]]` : "";
  return {
    kind: "text",
    text: `[[PAPERTABLE_ANSWER_START]]根据资料库中的说明，判决簿只持久化用户确认的金子与墓碑，其余探索痕迹默认蒸发${cite}。这一设计的目的是让干净上下文不再失忆${cite}。`,
  };
}

function jsonBlocks(decision) {
  if (decision.kind === "tool") {
    return [{ type: "tool_use", id: `toolu_${Date.now()}`, name: decision.name, input: decision.input }];
  }
  return [{ type: "text", text: decision.text }];
}

async function sse(response, decision) {
  response.on("error", () => undefined);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const messageId = `msg_${Date.now()}`;
  send("message_start", {
    type: "message_start",
    message: {
      id: messageId, type: "message", role: "assistant", model: "mock-1",
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  if (decision.kind === "tool") {
    const toolId = `toolu_${Date.now()}`;
    send("content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: toolId, name: decision.name, input: {} },
    });
    send("content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(decision.input) },
    });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 12 },
    });
  } else {
    send("content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    });
    // 分片输出，模拟真实流式
    const text = decision.text;
    const delay = Number(process.env.MOCK_DELAY || 0);
    for (let i = 0; i < text.length; i += 24) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      send("content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: text.slice(i, i + 24) },
      });
    }
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 80 },
    });
  }
  send("message_stop", { type: "message_stop" });
  response.end();
}

createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url?.includes("/v1/messages")) {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  let body = {};
  try { body = JSON.parse(raw); } catch { /* 忽略 */ }
  const decision = decide(body);
  if (body.stream) {
    await sse(response, decision).catch(() => undefined);
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "mock-1",
    content: jsonBlocks(decision),
    stop_reason: decision.kind === "tool" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 80 },
  }));
process.on("uncaughtException", (e) => appendFileSync(LOG, `\nUNCAUGHT: ${e?.stack || e}\n`));
process.on("unhandledRejection", (e) => appendFileSync(LOG, `\nUNHANDLED: ${e}\n`));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`mock model on 127.0.0.1:${PORT}`);
});
