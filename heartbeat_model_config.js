const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

function configFile() {
  return runtimeFile("heartbeat_model_config.json");
}

function sharedConfig(env = process.env) {
  return {
    apiUrl: String(env.TARGET_API_URL || "").trim(),
    apiKey: String(env.TARGET_API_KEY || "").trim(),
    model: String(env.MODEL_NAME || "").trim(),
    source: "shared"
  };
}

function loadHeartbeatModelConfig(env = process.env) {
  const filePath = configFile();
  if (!fs.existsSync(filePath)) return sharedConfig(env);
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      apiUrl: String(saved.apiUrl || "").trim(),
      apiKey: String(saved.apiKey || "").trim(),
      model: String(saved.model || "").trim(),
      source: "heartbeat"
    };
  } catch (error) {
    throw new Error(`心跳模型配置无法读取：${error.message}`);
  }
}

function normalizeApiUrl(value) {
  const apiUrl = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("API 地址必须是完整的 http:// 或 https:// 地址");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("API 地址只支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) throw new Error("API 地址不能包含账号或密码");
  return apiUrl;
}

function saveHeartbeatModelConfig(raw, env = process.env) {
  const current = loadHeartbeatModelConfig(env);
  const apiUrl = normalizeApiUrl(raw?.apiUrl);
  const model = String(raw?.model || "").trim();
  const apiKey = String(raw?.apiKey || "").trim() || current.apiKey;
  if (!model) throw new Error("模型名称不能为空");
  if (!apiKey) throw new Error("首次保存时必须填写 API Key");

  const saved = { apiUrl, apiKey, model };
  const filePath = configFile();
  writeJsonAtomicSync(filePath, saved);
  fs.chmodSync(filePath, 0o600);
  return { ...saved, source: "heartbeat" };
}

function publicHeartbeatModelConfig(env = process.env) {
  const config = loadHeartbeatModelConfig(env);
  return {
    apiUrl: config.apiUrl,
    model: config.model,
    apiKeyConfigured: Boolean(config.apiKey),
    source: config.source
  };
}

module.exports = {
  loadHeartbeatModelConfig,
  publicHeartbeatModelConfig,
  saveHeartbeatModelConfig
};
