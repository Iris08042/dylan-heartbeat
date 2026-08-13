const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("heartbeat prompt starts from legacy config and becomes independently editable", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-prompt-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    delete require.cache[require.resolve("../runtime_paths")];
    delete require.cache[require.resolve("../heartbeat_prompt_config")];
    const { loadHeartbeatPromptConfig, saveHeartbeatPromptConfig } = require("../heartbeat_prompt_config");
    assert.deepEqual(loadHeartbeatPromptConfig({ WAKE_PROMPT_TEMPLATE: "旧提示词\\n第二行" }), {
      prompt: "旧提示词\n第二行",
      source: "environment"
    });
    assert.deepEqual(saveHeartbeatPromptConfig({ prompt: "新的独立提示词" }), {
      prompt: "新的独立提示词",
      source: "heartbeat"
    });
    assert.deepEqual(loadHeartbeatPromptConfig({ WAKE_PROMPT_TEMPLATE: "旧提示词" }), {
      prompt: "新的独立提示词",
      source: "heartbeat"
    });
    assert.throws(() => saveHeartbeatPromptConfig({ prompt: "  " }), /不能为空/);
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
