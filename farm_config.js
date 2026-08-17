const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");
const { chatCompletionsUrl, modelsUrl, normalizeBaseUrl } = require("./heartbeat_model_config");

const CONFIG_VERSION = 1;
const DEFAULT_HUMAN_URL = "https://farm.catmemo.fun/";

function configFile() {
  return runtimeFile("farm_config.json");
}

function defaultFarmConfig() {
  return {
    version: CONFIG_VERSION,
    humanUrl: DEFAULT_HUMAN_URL,
    agentKey: "",
    autonomousEnabled: false,
    baseUrl: "",
    apiKey: "",
    model: "",
    enabledToolNames: []
  };
}

function normalizeHumanUrl(value) {
  const input = String(value || DEFAULT_HUMAN_URL).trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("农场页面地址必须是完整的 https:// 地址");
  }
  if (parsed.protocol !== "https:") throw new Error("农场页面地址只支持 https://");
  if (parsed.username || parsed.password) throw new Error("农场页面地址不能包含账号或密码");
  return parsed.toString();
}

function normalizeToolNames(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))].sort();
}

function normalizeStoredConfig(raw) {
  const defaults = defaultFarmConfig();
  const baseUrlInput = String(raw?.baseUrl || "").trim();
  return {
    version: CONFIG_VERSION,
    humanUrl: normalizeHumanUrl(raw?.humanUrl || defaults.humanUrl),
    agentKey: String(raw?.agentKey || "").trim(),
    autonomousEnabled: raw?.autonomousEnabled === true,
    baseUrl: baseUrlInput ? normalizeBaseUrl(baseUrlInput) : "",
    apiKey: String(raw?.apiKey || "").trim(),
    model: String(raw?.model || "").trim(),
    enabledToolNames: normalizeToolNames(raw?.enabledToolNames)
  };
}

function loadFarmConfig() {
  const filePath = configFile();
  if (!fs.existsSync(filePath)) return defaultFarmConfig();
  try {
    return normalizeStoredConfig(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(`农场配置无法读取：${error.message}`);
  }
}

function publicFarmConfig(config = loadFarmConfig()) {
  return {
    version: CONFIG_VERSION,
    humanUrl: config.humanUrl,
    agentKeyConfigured: Boolean(config.agentKey),
    autonomousEnabled: config.autonomousEnabled,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyConfigured: Boolean(config.apiKey),
    enabledToolNames: [...config.enabledToolNames]
  };
}

function saveFarmConfig(raw) {
  const existing = loadFarmConfig();
  const next = normalizeStoredConfig({
    ...existing,
    ...raw,
    agentKey: Object.hasOwn(raw || {}, "agentKey") && String(raw.agentKey || "").trim()
      ? raw.agentKey
      : existing.agentKey,
    apiKey: Object.hasOwn(raw || {}, "apiKey") && String(raw.apiKey || "").trim()
      ? raw.apiKey
      : existing.apiKey
  });
  if (next.autonomousEnabled && (!next.agentKey || !next.baseUrl || !next.apiKey || !next.model)) {
    throw new Error("开启后台自主经营前，请先配置 Agent Key 和完整的农场专用模型线路");
  }
  const filePath = configFile();
  writeJsonAtomicSync(filePath, next);
  fs.chmodSync(filePath, 0o600);
  return next;
}

function resolveFarmCandidate(raw = {}) {
  const existing = loadFarmConfig();
  const baseUrlInput = String(raw.baseUrl || existing.baseUrl || "").trim();
  const apiKey = Object.hasOwn(raw, "apiKey") && String(raw.apiKey || "").trim()
    ? String(raw.apiKey).trim()
    : existing.apiKey;
  const model = String(raw.model || existing.model || "").trim();
  if (!baseUrlInput || !apiKey) throw new Error("请先填写农场专用 API 地址和 API Key");
  return {
    baseUrl: normalizeBaseUrl(baseUrlInput),
    apiKey,
    model,
    apiUrl: chatCompletionsUrl(baseUrlInput),
    modelsUrl: modelsUrl(baseUrlInput)
  };
}

module.exports = {
  DEFAULT_HUMAN_URL,
  loadFarmConfig,
  publicFarmConfig,
  resolveFarmCandidate,
  saveFarmConfig
};
