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
  const firstModelRequest = requests.find(item => item.url === "https://models.example.com/v1/chat/completions");
  assert.match(firstModelRequest.body.messages[0].content, /每次被调用都默认拥有完成一轮自主经营的授权/);
  assert.match(firstModelRequest.body.messages[0].content, /长期共同经营目标/);
  assert.match(firstModelRequest.body.messages[0].content, /持续收集普通、稀有、限定、幻想、原创/);
  assert.match(firstModelRequest.body.messages[0].content, /主动和顾清瑶分享/);
  assert.match(firstModelRequest.body.messages[0].content, /不机械地总选最便宜或默认选项/);
  assert.match(firstModelRequest.body.messages[0].content, /只有用户明确说“只查看”/);
});

test("farm agent corrects a model that answers before using a farm tool", async () => {
  let modelRound = 0;
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (String(url).includes("farm.catmemo.fun")) {
      if (body?.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "Mcp-Session-Id": "session-1" } });
      if (body?.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body?.method === "tools/list") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "farm", description: "操作农场；查看状态时传 action=status", inputSchema: { type: "object", properties: { action: { type: "string" } } } }] }
      });
      if (body?.method === "tools/call") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "农场状态良好" }] }
      });
      if (init?.method === "DELETE") return jsonResponse({ ok: true });
    }
    modelRound += 1;
    if (modelRound === 1) return jsonResponse({ choices: [{ message: { content: "农场状态应该不错。" } }] });
    if (modelRound === 2) return jsonResponse({ choices: [{ message: {
      content: "",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "farm", arguments: '{"action":"status"}' } }]
    } }] });
    return jsonResponse({ choices: [{ message: { content: "我实际查看过了，农场状态良好。" } }] });
  };

  const result = await runFarmAgent({
    instruction: "只查看农场状态",
    config: {
      agentKey: "secret-agent",
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret-model",
      model: "cheap-model",
      enabledToolNames: ["farm"]
    },
    fetchImpl
  });

  assert.equal(result.content, "我实际查看过了，农场状态良好。");
  assert.deepEqual(result.actions.map(action => action.name), ["farm"]);
  assert.equal(modelRound, 4);
});

test("farm agent uses the configured goal and reviews an early stop before finishing", async () => {
  let modelRound = 0;
  const modelRequests = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (String(url).includes("farm.catmemo.fun")) {
      if (body?.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "Mcp-Session-Id": "session-1" } });
      if (body?.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body?.method === "tools/list") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "farm", description: "操作农场", inputSchema: { type: "object", properties: { action: { type: "string" } } } }] }
      });
      if (body?.method === "tools/call") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: `已完成 ${body.params.arguments.action}` }] }
      });
      if (init?.method === "DELETE") return jsonResponse({ ok: true });
    }
    modelRound += 1;
    modelRequests.push(body);
    if (modelRound === 1) return jsonResponse({ choices: [{ message: {
      content: "",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "farm", arguments: '{"action":"status"}' } }]
    } }] });
    if (modelRound === 2) return jsonResponse({ choices: [{ message: { content: "看完了。" } }] });
    if (modelRound === 3) return jsonResponse({ choices: [{ message: {
      content: "",
      tool_calls: [{ id: "call-2", type: "function", function: { name: "farm", arguments: '{"action":"explore"}' } }]
    } }] });
    return jsonResponse({ choices: [{ message: { content: "继续探索后发现了新内容，想邀请清瑶一起命名。" } }] });
  };

  const result = await runFarmAgent({
    instruction: "上农场看看",
    config: {
      agentKey: "secret-agent",
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret-model",
      model: "cheap-model",
      enabledToolNames: ["farm"],
      longTermGoal: "优先寻找四季隐藏作物，并邀请清瑶一起命名。"
    },
    fetchImpl
  });

  assert.deepEqual(result.actions.map(action => action.arguments.action), ["status", "explore"]);
  assert.match(modelRequests[0].messages[0].content, /优先寻找四季隐藏作物/);
  assert.match(modelRequests[2].messages.at(-1).content, /你准备结束本轮/);
  assert.match(result.content, /邀请清瑶/);
});

test("farm agent safely summarizes completed work at the operation limit", async () => {
  let modelRound = 0;
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (String(url).includes("farm.catmemo.fun")) {
      if (body?.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "Mcp-Session-Id": "session-1" } });
      if (body?.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body?.method === "tools/list") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "farm", description: "操作农场", inputSchema: { type: "object", properties: { action: { type: "string" } } } }] }
      });
      if (body?.method === "tools/call") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "操作成功" }] }
      });
      if (init?.method === "DELETE") return jsonResponse({ ok: true });
    }
    modelRound += 1;
    if (!body.tools) return jsonResponse({ choices: [{ message: { content: "已到安全上限，完成六次操作后停止。" } }] });
    return jsonResponse({ choices: [{ message: {
      content: "",
      tool_calls: [{ id: `call-${modelRound}`, type: "function", function: { name: "farm", arguments: `{"action":"step-${modelRound}"}` } }]
    } }] });
  };

  const result = await runFarmAgent({
    instruction: "经营一下农场",
    config: {
      agentKey: "secret-agent",
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret-model",
      model: "cheap-model",
      enabledToolNames: ["farm"]
    },
    fetchImpl
  });

  assert.equal(result.content, "已到安全上限，完成六次操作后停止。");
  assert.equal(result.actions.length, 6);
  assert.equal(modelRound, 7);
});

test("farm agent leaves repeated actions to the model within the safety limit", async () => {
  let modelRound = 0;
  let farmCalls = 0;
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (String(url).includes("farm.catmemo.fun")) {
      if (body?.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "Mcp-Session-Id": "session-1" } });
      if (body?.method === "notifications/initialized") return new Response("", { status: 202 });
      if (body?.method === "tools/list") return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "farm", description: "操作农场", inputSchema: { type: "object", properties: { action: { type: "string" } } } }] }
      });
      if (body?.method === "tools/call") {
        farmCalls += 1;
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "操作成功" }] } });
      }
      if (init?.method === "DELETE") return jsonResponse({ ok: true });
    }
    modelRound += 1;
    if (modelRound <= 2) return jsonResponse({ choices: [{ message: {
      content: "",
      tool_calls: [{ id: `call-${modelRound}`, type: "function", function: { name: "farm", arguments: '{"action":"status"}' } }]
    } }] });
    if (modelRound === 3) return jsonResponse({ choices: [{ message: {
      content: "",
      tool_calls: [{ id: "call-3", type: "function", function: { name: "farm", arguments: '{"action":"water"}' } }]
    } }] });
    return jsonResponse({ choices: [{ message: { content: "已经查看状态并完成浇水。" } }] });
  };

  const result = await runFarmAgent({
    instruction: "请给符合条件的作物浇水",
    config: {
      agentKey: "secret-agent",
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret-model",
      model: "cheap-model",
      enabledToolNames: ["farm"]
    },
    fetchImpl
  });

  assert.equal(result.content, "已经查看状态并完成浇水。");
  assert.deepEqual(result.actions.map(action => action.arguments.action), ["status", "status", "water"]);
  assert.equal(farmCalls, 3);
});
