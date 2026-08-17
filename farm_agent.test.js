const assert = require("node:assert/strict");
const test = require("node:test");

const { runFarmAgent, selectTools } = require("./farm_agent");

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) }
  });
}

test("selectTools applies the saved farm permission list", () => {
  const tools = [{ name: "status" }, { name: "water" }];
  assert.deepEqual(selectTools(tools, ["water"]), [{ name: "water" }]);
  assert.deepEqual(selectTools(tools, []), tools);
});

test("farm agent delegates model tool calls to the upstream MCP", async () => {
  const requests = [];
  let modelRound = 0;
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method: init?.method, body });
    if (String(url).includes("farm.catmemo.fun")) {
      if (body?.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "Mcp-Session-Id": "session-1" } });
      if (body?.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body?.method === "tools/list") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "farm_status", description: "查看农场", inputSchema: { type: "object", properties: {} } }] }
      });
      if (body?.method === "tools/call") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "农场状态良好" }] }
      });
      if (init?.method === "DELETE") return jsonResponse({ ok: true });
    }
    modelRound += 1;
    if (modelRound === 1) return jsonResponse({ choices: [{ message: {
      content: "",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "farm_status", arguments: "{}" } }]
    } }] });
    return jsonResponse({ choices: [{ message: { content: "我看过了，农场状态良好。" } }] });
  };

  const result = await runFarmAgent({
    instruction: "看看农场",
    config: {
      agentKey: "secret-agent",
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret-model",
      model: "cheap-model",
      enabledToolNames: ["farm_status"]
    },
    fetchImpl
  });

  assert.equal(result.content, "我看过了，农场状态良好。");
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].name, "farm_status");
  assert.ok(requests.some(item => item.body?.method === "tools/call"));
  assert.ok(requests.some(item => item.url === "https://models.example.com/v1/chat/completions"));
});
