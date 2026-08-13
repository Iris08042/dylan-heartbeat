const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("heartbeat model config starts from shared env and then becomes independent", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-model-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    const {
      loadHeartbeatModelConfig,
      publicHeartbeatModelConfig,
      saveHeartbeatModelConfig
    } = require("../heartbeat_model_config");
    const env = {
      TARGET_API_URL: "https://shared.example/v1/chat/completions",
      TARGET_API_KEY: "shared-secret",
      MODEL_NAME: "shared-model"
    };

    assert.deepEqual(publicHeartbeatModelConfig(env), {
      apiUrl: "https://shared.example/v1/chat/completions",
      model: "shared-model",
      apiKeyConfigured: true,
      source: "shared"
    });

    saveHeartbeatModelConfig({
      apiUrl: "https://heartbeat.example/v1/chat/completions",
      apiKey: "heartbeat-secret",
      model: "heartbeat-model"
    }, env);
    assert.deepEqual(loadHeartbeatModelConfig(env), {
      apiUrl: "https://heartbeat.example/v1/chat/completions",
      apiKey: "heartbeat-secret",
      model: "heartbeat-model",
      source: "heartbeat"
    });

    saveHeartbeatModelConfig({
      apiUrl: "https://new.example/v1/chat/completions",
      apiKey: "",
      model: "new-model"
    }, env);
    assert.equal(loadHeartbeatModelConfig(env).apiKey, "heartbeat-secret");
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("heartbeat model config never exposes the API key", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-model-public-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    const { publicHeartbeatModelConfig, saveHeartbeatModelConfig } = require("../heartbeat_model_config");
    saveHeartbeatModelConfig({
      apiUrl: "https://heartbeat.example/v1/chat/completions",
      apiKey: "do-not-return",
      model: "heartbeat-model"
    });
    const publicConfig = publicHeartbeatModelConfig();
    assert.equal(publicConfig.apiKeyConfigured, true);
    assert.equal(Object.hasOwn(publicConfig, "apiKey"), false);
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
