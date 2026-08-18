const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("farm routes keep secrets private and expose one managed MCP tool", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "farm-routes-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousToken = process.env.HEARTBEAT_INBOX_TOKEN;
  process.env.DATA_DIR = dataDir;
  process.env.HEARTBEAT_INBOX_TOKEN = "farm-route-token";
  const server = require("../server");
  const headers = { authorization: "Bearer farm-route-token" };
  try {
    const savedResponse = await server.app.inject({
      method: "PUT",
      url: "/api/polaris/farm/config",
      headers,
      payload: {
        agentKey: "private-agent",
        baseUrl: "https://provider.example/v1",
        apiKey: "private-model-key",
        model: "cheap-model",
        autonomousEnabled: true
      }
    });
    assert.equal(savedResponse.statusCode, 200);
    const visible = savedResponse.json();
    assert.equal(visible.agentKeyConfigured, true);
    assert.equal(visible.apiKeyConfigured, true);
    assert.equal(JSON.stringify(visible).includes("private-agent"), false);
    assert.equal(JSON.stringify(visible).includes("private-model-key"), false);

    const initialize = await server.app.inject({
      method: "POST",
      url: "/api/polaris/farm/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
    });
    assert.equal(initialize.statusCode, 200);
    assert.equal(initialize.json().result.serverInfo.name, "endless-summer-farm");

    const list = await server.app.inject({
      method: "POST",
      url: "/api/polaris/farm/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    });
    assert.deepEqual(list.json().result.tools.map(tool => tool.name), ["farm_agent"]);
    assert.match(list.json().result.tools[0].description, /继续完成当前合理事项/);
    assert.match(list.json().result.tools[0].inputSchema.properties.instruction.description, /开放授权/);

    const unauthenticated = await server.app.inject({
      method: "GET",
      url: "/api/polaris/farm/config"
    });
    assert.equal(unauthenticated.statusCode, 401);
  } finally {
    await server.app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousToken === undefined) delete process.env.HEARTBEAT_INBOX_TOKEN;
    else process.env.HEARTBEAT_INBOX_TOKEN = previousToken;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
