const FARM_PROVIDER_PROTOCOLS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate-content"
]);

const FARM_PROVIDER_PATHS = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
  "gemini-generate-content": "/models/{model}:generateContent"
};

function normalizeFarmProtocol(value) {
  const protocol = String(value || "openai-completions").trim();
  if (!FARM_PROVIDER_PROTOCOLS.has(protocol)) throw new Error("不支持所选的农场模型接口格式");
  return protocol;
}

function defaultFarmProviderPath(protocol) {
  return FARM_PROVIDER_PATHS[normalizeFarmProtocol(protocol)];
}

function normalizeFarmBaseUrl(value, providerPath = "") {
  const input = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Base URL 必须是完整的 http:// 或 https:// 地址");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Base URL 只支持 http:// 或 https://");
  if (parsed.username || parsed.password) throw new Error("Base URL 不能包含账号或密码");
  if (parsed.search || parsed.hash) throw new Error("Base URL 不能包含查询参数或锚点");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const suffix = String(providerPath || "").trim();
  if (suffix && !suffix.includes("{") && parsed.pathname.toLowerCase().endsWith(suffix.toLowerCase())) {
    parsed.pathname = parsed.pathname.slice(0, -suffix.length).replace(/\/+$/, "") || "/";
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeFarmProviderPath(protocol, value) {
  const input = String(value || defaultFarmProviderPath(protocol)).trim();
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("?") || input.includes("#")) {
    throw new Error("API Path 必须是以 / 开头且不含查询参数的路径");
  }
  return input;
}

function farmProviderEndpoint(config) {
  const model = String(config.model || "").trim().replace(/^models\//, "");
  const path = normalizeFarmProviderPath(config.protocol, config.path)
    .replaceAll("{model}", encodeURIComponent(model));
  return `${normalizeFarmBaseUrl(config.baseUrl, path)}${path}`;
}

function farmModelsEndpoint(config) {
  return `${normalizeFarmBaseUrl(config.baseUrl)}/models`;
}

function farmProviderHeaders(config) {
  const headers = { "Content-Type": "application/json" };
  if (config.protocol === "anthropic-messages") {
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (config.protocol === "gemini-generate-content") {
    headers["x-goog-api-key"] = config.apiKey;
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function toolNameForCall(messages, callId) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const match = messages[index]?.tool_calls?.find(call => call.id === callId);
    if (match) return String(match.function?.name || "tool");
  }
  return "tool";
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(String(value || "{}")); } catch { return {}; }
}

function responseTools(tools) {
  return tools.map(tool => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }));
}

function anthropicTools(tools) {
  return tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

function geminiTools(tools) {
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }))
  }];
}

function appendRoleMessage(target, role, content) {
  const previous = target[target.length - 1];
  if (previous?.role === role && Array.isArray(previous.content) && Array.isArray(content)) {
    previous.content.push(...content);
  } else {
    target.push({ role, content });
  }
}

function buildResponsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.provider_items)) {
      input.push(...message.provider_items);
      continue;
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: String(message.content || "") });
      continue;
    }
    if (message.content) input.push({ role: message.role, content: String(message.content) });
    for (const call of message.tool_calls || []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments || "{}"
      });
    }
  }
  return input;
}

function buildAnthropicMessages(messages) {
  const converted = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      appendRoleMessage(converted, "user", [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: String(message.content || "")
      }]);
      continue;
    }
    const content = [];
    if (message.content) content.push({ type: "text", text: String(message.content) });
    for (const call of message.tool_calls || []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments)
      });
    }
    appendRoleMessage(converted, message.role === "assistant" ? "assistant" : "user", content);
  }
  return converted;
}

function buildGeminiContents(messages) {
  const converted = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      appendRoleMessage(converted, "user", [{
        functionResponse: {
          name: toolNameForCall(messages, message.tool_call_id),
          response: { result: String(message.content || "") },
          id: message.tool_call_id
        }
      }]);
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.provider_parts)) {
      appendRoleMessage(converted, "model", message.provider_parts);
      continue;
    }
    const parts = [];
    if (message.content) parts.push({ text: String(message.content) });
    for (const call of message.tool_calls || []) {
      parts.push({ functionCall: { name: call.function.name, args: parseArguments(call.function.arguments) } });
    }
    appendRoleMessage(converted, message.role === "assistant" ? "model" : "user", parts);
  }
  return converted.map(message => ({ role: message.role, parts: message.content }));
}

function buildFarmProviderBody(config, messages, tools = []) {
  if (config.protocol === "openai-responses") {
    return {
      model: config.model,
      input: buildResponsesInput(messages),
      ...(tools.length ? { tools: responseTools(tools), tool_choice: "auto" } : {})
    };
  }
  if (config.protocol === "anthropic-messages") {
    return {
      model: config.model,
      max_tokens: 800,
      system: messages.filter(message => message.role === "system").map(message => message.content).join("\n\n"),
      messages: buildAnthropicMessages(messages),
      ...(tools.length ? { tools: anthropicTools(tools), tool_choice: { type: "auto" } } : {})
    };
  }
  if (config.protocol === "gemini-generate-content") {
    const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n\n");
    return {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: buildGeminiContents(messages),
      ...(tools.length ? { tools: geminiTools(tools), toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {})
    };
  }
  return {
    model: config.model,
    messages,
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
    temperature: 0.2,
    stream: false
  };
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => typeof part === "string" ? part : String(part?.text || part?.content || "")).join("");
}

function parseFarmProviderMessage(config, result) {
  if (config.protocol === "openai-responses") {
    const output = Array.isArray(result?.output) ? result.output : [];
    const toolCalls = output.filter(item => item?.type === "function_call").map((item, index) => ({
      id: String(item.call_id || item.id || `call-${index}`),
      type: "function",
      function: { name: String(item.name || ""), arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) }
    }));
    const text = String(result?.output_text || output.flatMap(item => item?.content || [])
      .filter(item => item?.type === "output_text").map(item => item.text || "").join(""));
    return { content: text, provider_items: output, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  }
  if (config.protocol === "anthropic-messages") {
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const toolCalls = blocks.filter(block => block?.type === "tool_use").map((block, index) => ({
      id: String(block.id || `call-${index}`),
      type: "function",
      function: { name: String(block.name || ""), arguments: JSON.stringify(block.input || {}) }
    }));
    const text = blocks.filter(block => block?.type === "text").map(block => block.text || "").join("");
    return { content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  }
  if (config.protocol === "gemini-generate-content") {
    const parts = result?.candidates?.[0]?.content?.parts;
    const blocks = Array.isArray(parts) ? parts : [];
    const toolCalls = blocks.filter(block => block?.functionCall).map((block, index) => ({
      id: String(block.functionCall.id || `gemini-call-${index}`),
      type: "function",
      function: { name: String(block.functionCall.name || ""), arguments: JSON.stringify(block.functionCall.args || {}) }
    }));
    const text = blocks.map(block => block?.text || "").join("");
    return { content: text, provider_parts: blocks, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  }
  const message = result?.choices?.[0]?.message;
  return message ? { ...message, content: contentText(message.content) } : null;
}

function farmProviderError(result, status) {
  const message = result?.error?.message || result?.error || result?.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 500)
    : `上游接口返回 ${status}`;
}

async function requestFarmProvider(config, messages, tools = [], fetchImpl = fetch) {
  const response = await fetchImpl(farmProviderEndpoint(config), {
    method: "POST",
    signal: AbortSignal.timeout(45_000),
    headers: farmProviderHeaders(config),
    body: JSON.stringify(buildFarmProviderBody(config, messages, tools))
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { throw new Error(`农场模型响应不是有效 JSON（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(farmProviderError(result, response.status));
  const message = parseFarmProviderMessage(config, result);
  if (!message) throw new Error("农场模型没有返回可识别的消息");
  return { message, model: String(result?.model || result?.modelVersion || config.model) };
}

async function discoverFarmModels(config, fetchImpl = fetch) {
  const response = await fetchImpl(farmModelsEndpoint(config), {
    method: "GET",
    signal: AbortSignal.timeout(20_000),
    headers: farmProviderHeaders(config)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(farmProviderError(result, response.status));
  const source = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : [];
  return [...new Set(source.map(item => String(item?.id || item?.name || item || "").trim().replace(/^models\//, "")).filter(Boolean))].sort();
}

module.exports = {
  buildFarmProviderBody,
  defaultFarmProviderPath,
  discoverFarmModels,
  farmModelsEndpoint,
  farmProviderEndpoint,
  normalizeFarmBaseUrl,
  normalizeFarmProtocol,
  normalizeFarmProviderPath,
  parseFarmProviderMessage,
  requestFarmProvider
};
