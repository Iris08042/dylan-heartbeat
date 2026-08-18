const { parseChatCompletionResponse } = require("./upstream_response");

const DEFAULT_TIMEOUT_MS = 300_000;

function readTimeoutMs() {
  const value = Number(process.env.WAKE_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) {
    if (typeof content === "object") {
      const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
      if (content.image_url || type.includes("image")) return "[图片]";
      if (content.file || type.includes("file")) return "[文件]";
    }
    return "[非文本内容]";
  }

  return content
    .map(part => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
      if (type === "text" || type === "input_text") return part.text || part.content || "";
      if (part.image_url || type.includes("image")) return "[图片]";
      if (part.file || type.includes("file")) return "[文件]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function requestHeartbeatModel(heartbeatModel, messages, tools = [], fetchImpl = fetch) {
  const response = await fetchImpl(heartbeatModel.apiUrl, {
    method: "POST",
    signal: AbortSignal.timeout(readTimeoutMs()),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${heartbeatModel.apiKey}`
    },
    body: JSON.stringify({
      model: heartbeatModel.model,
      messages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false,
      ...(tools.length ? { tools, tool_choice: "auto" } : {})
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = parseChatCompletionResponse(responseText, response.headers.get("content-type") || "");
  } catch (error) {
    throw new Error(`模型响应无法解析（HTTP ${response.status}）：${error.message || responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("主动消息模型没有返回 message");
  return message;
}

module.exports = { normalizeContentToText, requestHeartbeatModel };
