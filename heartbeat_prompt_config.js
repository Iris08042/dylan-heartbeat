const fs = require("fs");
const path = require("path");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const DEFAULT_HEARTBEAT_PROMPT = `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。

## 唤醒信息
- 当前时间：\${currentTime}
- 距离用户最后一条消息：\${diffMinutes} 分钟
\${weatherContext}
`.trim();

function configFile() {
  return runtimeFile("heartbeat_prompt_config.json");
}

function legacyPrompt(env = process.env) {
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    return { prompt: fs.readFileSync(promptFile, "utf8").trim(), source: "file" };
  }
  if (env.WAKE_PROMPT_TEMPLATE) {
    return {
      prompt: String(env.WAKE_PROMPT_TEMPLATE).replace(/\\n/g, "\n").trim(),
      source: "environment"
    };
  }
  return { prompt: DEFAULT_HEARTBEAT_PROMPT, source: "default" };
}

function loadHeartbeatPromptConfig(env = process.env) {
  const filePath = configFile();
  if (!fs.existsSync(filePath)) return legacyPrompt(env);
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const prompt = String(saved.prompt || "").trim();
    if (!prompt) throw new Error("提示词为空");
    return { prompt, source: "heartbeat" };
  } catch (error) {
    throw new Error(`心跳提示词配置无法读取：${error.message}`);
  }
}

function saveHeartbeatPromptConfig(raw) {
  const prompt = String(raw?.prompt || "").trim();
  if (!prompt) throw new Error("心跳提示词不能为空");
  writeJsonAtomicSync(configFile(), { prompt });
  return { prompt, source: "heartbeat" };
}

module.exports = {
  DEFAULT_HEARTBEAT_PROMPT,
  loadHeartbeatPromptConfig,
  saveHeartbeatPromptConfig
};
