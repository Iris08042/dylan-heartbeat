const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("accepts authenticated HAE uploads and exposes one health MCP tool", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-routes-"));
  const previous = {
    DATA_DIR: process.env.DATA_DIR,
    HEALTH_INGEST_TOKEN: process.env.HEALTH_INGEST_TOKEN,
    HEARTBEAT_INBOX_TOKEN: process.env.HEARTBEAT_INBOX_TOKEN
  };
  process.env.DATA_DIR = dataDir;
  process.env.HEALTH_INGEST_TOKEN = "hae-only-token";
  process.env.HEARTBEAT_INBOX_TOKEN = "polaris-tool-token";
  const server = require("../server");
  try {
    const rejected = await server.app.inject({
      method: "POST",
      url: "/api/polaris/health/ingest",
      payload: { data: { metrics: [] } }
    });
    assert.equal(rejected.statusCode, 401);

    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/polaris/health/ingest",
      headers: { authorization: "Bearer hae-only-token" },
      payload: { data: { metrics: [
        { name: "resting_heart_rate", units: "bpm", data: [{ date: "2026-08-18", qty: 61 }] }
      ] } }
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json().acceptedMetrics, ["resting_heart_rate"]);

    const headers = { authorization: "Bearer polaris-tool-token" };
    const rejectedStatus = await server.app.inject({
      method: "GET",
      url: "/api/polaris/health/status"
    });
    assert.equal(rejectedStatus.statusCode, 401);

    const status = await server.app.inject({
      method: "GET",
      url: "/api/polaris/health/status",
      headers
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().metrics.resting_heart_rate.value.qty, 61);

    const list = await server.app.inject({
      method: "POST",
      url: "/api/polaris/health/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    });
    assert.deepEqual(list.json().result.tools.map(tool => tool.name), ["health_now"]);
    assert.match(list.json().result.tools[0].description, /可优先查看一次辅助判断/);
    assert.match(list.json().result.tools[0].description, /不必机械调用/);

    const call = await server.app.inject({
      method: "POST",
      url: "/api/polaris/health/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "health_now", arguments: {} } }
    });
    assert.equal(call.statusCode, 200);
    assert.match(call.json().result.content[0].text, /静息心率：61 bpm/);
  } finally {
    await server.app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
