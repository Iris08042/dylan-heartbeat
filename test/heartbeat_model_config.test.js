const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

function inTemporaryDataDir(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-model-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    run();
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("API base URL accepts either /v1 or the old complete chat endpoint", () => {
  const { chatCompletionsUrl, modelsUrl, normalizeBaseUrl } = require("../heartbeat_model_config");
  assert.equal(normalizeBaseUrl("https://api.example/v1"), "https://api.example/v1");
  assert.equal(normalizeBaseUrl("https://api.example/v1/chat/completions"), "https://api.example/v1");
  assert.equal(chatCompletionsUrl("https://api.example/v1"), "https://api.example/v1/chat/completions");
  assert.equal(modelsUrl("https://api.example/v1"), "https://api.example/v1/models");
});

test("shared env becomes the first switchable heartbeat profile", () => inTemporaryDataDir(() => {
  const {
    loadHeartbeatModelConfig,
    publicHeartbeatModelConfig,
    saveHeartbeatModelProfile
  } = require("../heartbeat_model_config");
  const env = {
    TARGET_API_URL: "https://shared.example/v1/chat/completions",
    TARGET_API_KEY: "shared-secret",
    MODEL_NAME: "shared-model"
  };

  const initial = publicHeartbeatModelConfig(env);
  assert.equal(initial.activeProfileId, "default");
  assert.equal(initial.profiles[0].baseUrl, "https://shared.example/v1");
  assert.equal(initial.profiles[0].apiKeyConfigured, true);

  saveHeartbeatModelProfile({
    name: "备用站",
    baseUrl: "https://backup.example/v1",
    apiKey: "backup-secret",
    model: "backup-model"
  }, env);
  const active = loadHeartbeatModelConfig(env);
  assert.equal(active.name, "备用站");
  assert.equal(active.apiUrl, "https://backup.example/v1/chat/completions");
  assert.equal(active.apiKey, "backup-secret");
}));

test("profiles switch as a complete URL, key, and model set", () => inTemporaryDataDir(() => {
  const {
    activateHeartbeatModelProfile,
    deleteHeartbeatModelProfile,
    loadHeartbeatModelConfig,
    publicHeartbeatModelConfig,
    saveHeartbeatModelProfile
  } = require("../heartbeat_model_config");

  saveHeartbeatModelProfile({ name: "站点 A", baseUrl: "https://a.example/v1", apiKey: "key-a", model: "model-a" });
  saveHeartbeatModelProfile({ name: "站点 B", baseUrl: "https://b.example/v1", apiKey: "key-b", model: "model-b" });
  const config = publicHeartbeatModelConfig();
  const a = config.profiles.find(profile => profile.name === "站点 A");
  const b = config.profiles.find(profile => profile.name === "站点 B");
  assert.equal(config.activeProfileId, b.id);

  activateHeartbeatModelProfile(a.id);
  assert.deepEqual(
    (({ baseUrl, apiKey, model }) => ({ baseUrl, apiKey, model }))(loadHeartbeatModelConfig()),
    { baseUrl: "https://a.example/v1", apiKey: "key-a", model: "model-a" }
  );
  deleteHeartbeatModelProfile(a.id);
  assert.equal(publicHeartbeatModelConfig().activeProfileId, b.id);
}));

test("editing a profile keeps its stored key unless replacement is explicit", () => inTemporaryDataDir(() => {
  const { loadHeartbeatModelConfig, publicHeartbeatModelConfig, saveHeartbeatModelProfile } = require("../heartbeat_model_config");
  saveHeartbeatModelProfile({ name: "站点", baseUrl: "https://old.example/v1", apiKey: "secret", model: "old" });
  const id = publicHeartbeatModelConfig().activeProfileId;
  saveHeartbeatModelProfile({ id, name: "新站点", baseUrl: "https://new.example/v1", model: "new" });
  assert.equal(loadHeartbeatModelConfig().apiKey, "secret");
  assert.throws(() => saveHeartbeatModelProfile({ id, name: "新站点", baseUrl: "https://new.example/v1", apiKey: "", model: "new" }), /不能为空/);
}));

test("public heartbeat profiles never expose API keys", () => inTemporaryDataDir(() => {
  const { publicHeartbeatModelConfig, saveHeartbeatModelProfile } = require("../heartbeat_model_config");
  saveHeartbeatModelProfile({ name: "私密站", baseUrl: "https://private.example/v1", apiKey: "do-not-return", model: "private-model" });
  const publicConfig = publicHeartbeatModelConfig();
  assert.equal(publicConfig.profiles[0].apiKeyConfigured, true);
  assert.equal(Object.hasOwn(publicConfig.profiles[0], "apiKey"), false);
  assert.equal(JSON.stringify(publicConfig).includes("do-not-return"), false);
}));
