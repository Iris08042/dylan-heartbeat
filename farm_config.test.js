const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "farm-config-"));
process.env.DATA_DIR = dataDir;

const {
  DEFAULT_FARM_LONG_TERM_GOAL,
  loadFarmConfig,
  publicFarmConfig,
  resolveFarmCandidate,
  saveFarmConfig
} = require("./farm_config");

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("farm config gives older saved data the shared long-term goal", () => {
  fs.writeFileSync(path.join(dataDir, "farm_config.json"), JSON.stringify({
    version: 2,
    humanUrl: "https://farm.catmemo.fun/",
    autonomousEnabled: false
  }));
  const migrated = loadFarmConfig();
  assert.equal(migrated.version, 3);
  assert.equal(migrated.longTermGoal, DEFAULT_FARM_LONG_TERM_GOAL);
});

test("farm config keeps secrets server-side and preserves blank secret updates", () => {
  const saved = saveFarmConfig({
    humanUrl: "https://farm.catmemo.fun/agent/example",
    agentKey: "agent-secret",
    baseUrl: "https://api.example.com/v1/chat/completions",
    apiKey: "model-secret",
    model: "cheap-model",
    longTermGoal: "一起收集四季图鉴，并分享每次新发现。",
    enabledToolNames: ["water", "water", "status"]
  });
  assert.equal(saved.baseUrl, "https://api.example.com/v1");
  assert.equal(saved.protocol, "openai-completions");
  assert.equal(saved.path, "/chat/completions");
  assert.deepEqual(saved.enabledToolNames, ["status", "water"]);

  const visible = publicFarmConfig(saved);
  assert.equal(visible.agentKeyConfigured, true);
  assert.equal(visible.apiKeyConfigured, true);
  assert.equal(visible.longTermGoal, "一起收集四季图鉴，并分享每次新发现。");
  assert.equal("agentKey" in visible, false);
  assert.equal("apiKey" in visible, false);

  saveFarmConfig({ agentKey: "", apiKey: "", model: "new-model" });
  const reloaded = loadFarmConfig();
  assert.equal(reloaded.agentKey, "agent-secret");
  assert.equal(reloaded.apiKey, "model-secret");
  assert.equal(reloaded.model, "new-model");
  assert.equal(reloaded.longTermGoal, "一起收集四季图鉴，并分享每次新发现。");
});

test("farm model candidate can use unsaved key without exposing it", () => {
  const candidate = resolveFarmCandidate({ apiKey: "temporary", model: "test-model" });
  assert.equal(candidate.apiKey, "temporary");
  assert.equal(candidate.protocol, "openai-completions");
  assert.equal(candidate.baseUrl, "https://api.example.com/v1");
  assert.equal(candidate.path, "/chat/completions");
});
