const { loadFarmConfig } = require("./farm_config");
const { FarmMcpClient } = require("./farm_mcp");
const { requestFarmProvider } = require("./farm_provider");

const MAX_TOOL_ROUNDS = 6;

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => typeof part === "string" ? part : String(part?.text || part?.content || "")).join("");
}

function toolResultText(result) {
  if (typeof result === "string") return result;
  const fromContent = contentText(result?.content);
  return fromContent || JSON.stringify(result ?? null);
}

function asModelTool(tool) {
  return {
    type: "function",
    function: {
      name: String(tool.name || ""),
      description: String(tool.description || "农场操作"),
      parameters: tool.inputSchema && typeof tool.inputSchema === "object"
        ? tool.inputSchema
        : { type: "object", properties: {} }
    }
  };
}

function selectTools(tools, enabledToolNames) {
  if (!enabledToolNames?.length) return tools;
  const enabled = new Set(enabledToolNames);
  return tools.filter(tool => enabled.has(tool.name));
}

async function runFarmAgent({ instruction, context = "", config = loadFarmConfig(), fetchImpl = fetch } = {}) {
  const task = String(instruction || "").trim();
  if (!task) throw new Error("农场任务不能为空");
  if (!config.agentKey) throw new Error("尚未配置农场 Agent Key");
  if (!config.baseUrl || !config.apiKey || !config.model) throw new Error("尚未配置完整的农场专用模型线路");

  const client = new FarmMcpClient(config.agentKey, { fetchImpl });
  const actions = [];
  try {
    await client.initialize();
    const available = selectTools(await client.listTools(), config.enabledToolNames);
    if (!available.length) throw new Error("当前没有允许农场代理使用的工具");
    const tools = available.map(asModelTool);
    const allowed = new Set(available.map(tool => tool.name));
    const messages = [
      {
        role: "system",
        content: "你是《无尽夏》里的农场经营代理。只处理用户给出的农场任务；必须先调用可用工具查看真实状态，再谨慎行动；不猜测数值，不使用未提供的工具，也不能在没有调用工具时声称任务已完成。完成后用简短中文说明做了什么和结果。"
      },
      {
        role: "user",
        content: [task, context ? `补充背景：${String(context).slice(0, 2000)}` : ""].filter(Boolean).join("\n\n")
      }
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const { message } = await requestFarmProvider(config, messages, tools, fetchImpl);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        ...(message.provider_items ? { provider_items: message.provider_items } : {}),
        ...(message.provider_parts ? { provider_parts: message.provider_parts } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      });
      if (!toolCalls.length) {
        if (!actions.length) {
          messages.push({
            role: "user",
            content: "你还没有调用农场工具。请先调用可用工具查看真实状态，再根据原任务继续；不要只用文字回答。"
          });
          continue;
        }
        return { content: contentText(message.content).trim() || "农场任务已经处理完成。", actions };
      }

      for (const call of toolCalls) {
        const name = String(call?.function?.name || "");
        if (!allowed.has(name)) throw new Error(`农场模型请求了未授权工具：${name || "未知"}`);
        let args;
        try { args = JSON.parse(call?.function?.arguments || "{}"); } catch { throw new Error(`工具 ${name} 的参数不是有效 JSON`); }
        const result = await client.callTool(name, args);
        const resultText = toolResultText(result);
        actions.push({ name, arguments: args, result: resultText.slice(0, 1000) });
        messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
      }
    }
    throw new Error(`农场代理连续操作超过 ${MAX_TOOL_ROUNDS} 轮，已停止以避免误操作`);
  } finally {
    await client.close();
  }
}

module.exports = { MAX_TOOL_ROUNDS, runFarmAgent, selectTools };
