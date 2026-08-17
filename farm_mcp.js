const FARM_MCP_ROOT = "https://farm.catmemo.fun/mcp";

function parseSsePayload(text) {
  const values = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/i);
    if (!match || !match[1].trim()) continue;
    try { values.push(JSON.parse(match[1])); } catch {}
  }
  return values.at(-1) || null;
}

function parseMcpPayload(text, contentType) {
  if (/text\/event-stream/i.test(contentType || "") || /^\s*(?:event:.*\r?\n)?data:/i.test(text || "")) {
    return parseSsePayload(text);
  }
  return text ? JSON.parse(text) : null;
}

function errorMessage(payload, status) {
  return payload?.error?.message || payload?.message || `农场 MCP 返回 HTTP ${status}`;
}

class FarmMcpClient {
  constructor(agentKey, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    const key = String(agentKey || "").trim();
    if (!key) throw new Error("尚未配置农场 Agent Key");
    this.url = `${FARM_MCP_ROOT}/${encodeURIComponent(key)}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sessionId = "";
    this.nextId = 1;
  }

  async request(method, params, { notification = false } = {}) {
    const body = {
      jsonrpc: "2.0",
      ...(notification ? {} : { id: this.nextId++ }),
      method,
      ...(params === undefined ? {} : { params })
    };
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {})
      },
      body: JSON.stringify(body)
    });
    const receivedSession = response.headers.get("mcp-session-id");
    if (receivedSession) this.sessionId = receivedSession;
    const text = await response.text();
    const payload = parseMcpPayload(text, response.headers.get("content-type") || "");
    if (!response.ok || payload?.error) throw new Error(errorMessage(payload, response.status));
    return notification ? null : payload?.result;
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "endless-summer-farm", version: "1.0.0" }
    });
    await this.request("notifications/initialized", undefined, { notification: true });
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        signal: AbortSignal.timeout(5_000),
        headers: { "Mcp-Session-Id": this.sessionId }
      });
    } catch {}
  }
}

async function inspectFarmTools(agentKey, options) {
  const client = new FarmMcpClient(agentKey, options);
  try {
    await client.initialize();
    return await client.listTools();
  } finally {
    await client.close();
  }
}

module.exports = { FarmMcpClient, inspectFarmTools, parseMcpPayload };
