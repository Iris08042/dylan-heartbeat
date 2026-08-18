const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("scheduled message MCP exposes the managed tool and creates a task", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-message-routes-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousToken = process.env.HEARTBEAT_INBOX_TOKEN;
  process.env.DATA_DIR = dataDir;
  process.env.HEARTBEAT_INBOX_TOKEN = "scheduled-route-token";
  const server = require("../server");
  const headers = { authorization: "Bearer scheduled-route-token" };
  try {
    const list = await server.app.inject({
      method: "POST",
      url: "/api/polaris/scheduled-message/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    });
    assert.deepEqual(list.json().result.tools.map(tool => tool.name), ["scheduled_message"]);

    const call = await server.app.inject({
      method: "POST",
      url: "/api/polaris/scheduled-message/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "scheduled_message",
          arguments: {
            action: "create",
            runAt: "2099-08-19T09:00:00+08:00",
            prompt: "到点后根据最新情况叫她起床"
          }
        }
      }
    });
    const result = call.json().result;
    assert.equal(result.isError, false);
    assert.match(result.structuredContent.receipt, /主动消息已设置在/);

    const unauthenticated = await server.app.inject({
      method: "POST",
      url: "/api/polaris/scheduled-message/mcp",
      payload: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }
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
