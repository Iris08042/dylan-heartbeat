const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("heartbeat model routes manage profiles, list models, and test the chat endpoint", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-model-routes-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousToken = process.env.HEARTBEAT_INBOX_TOKEN;
  const previousFetch = global.fetch;
  process.env.DATA_DIR = dataDir;
  process.env.HEARTBEAT_INBOX_TOKEN = "test-token";
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      model: "model-a",
      choices: [{ message: { content: "OK" } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const server = require("../server");
  const auth = { authorization: "Bearer test-token" };
  try {
    const savedResponse = await server.app.inject({
      method: "PUT",
      url: "/api/polaris/heartbeat/model/profile",
      headers: auth,
      payload: {
        name: "测试站",
        baseUrl: "https://provider.example/v1/chat/completions",
        apiKey: "secret-key",
        model: "model-a"
      }
    });
    assert.equal(savedResponse.statusCode, 200);
    const saved = savedResponse.json();
    assert.equal(saved.profiles[0].baseUrl, "https://provider.example/v1");
    assert.equal(JSON.stringify(saved).includes("secret-key"), false);

    const profile = { id: saved.activeProfileId, baseUrl: saved.baseUrl, model: saved.model };
    const modelsResponse = await server.app.inject({
      method: "POST",
      url: "/api/polaris/heartbeat/model/models",
      headers: auth,
      payload: profile
    });
    assert.deepEqual(modelsResponse.json(), { models: ["model-a", "model-b"] });
    assert.equal(calls[0].url, "https://provider.example/v1/models");
    assert.equal(calls[0].options.headers.Authorization, "Bearer secret-key");

    const testResponse = await server.app.inject({
      method: "POST",
      url: "/api/polaris/heartbeat/model/test",
      headers: auth,
      payload: profile
    });
    assert.deepEqual(testResponse.json(), { ok: true, model: "model-a", reply: "OK" });
    assert.equal(calls[1].url, "https://provider.example/v1/chat/completions");
    assert.equal(JSON.parse(calls[1].options.body).model, "model-a");
  } finally {
    await server.app.close();
    global.fetch = previousFetch;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousToken === undefined) delete process.env.HEARTBEAT_INBOX_TOKEN;
    else process.env.HEARTBEAT_INBOX_TOKEN = previousToken;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
