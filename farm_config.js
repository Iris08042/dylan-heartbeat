const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");
const {
  defaultFarmProviderPath,
  normalizeFarmBaseUrl,
  normalizeFarmProtocol,
  normalizeFarmProviderPath
} = require("./farm_provider");

const CONFIG_VERSION = 3;
const DEFAULT_HUMAN_URL = "https://farm.catmemo.fun/";
const DEFAULT_FARM_LONG_TERM_GOAL = "叶明舟与顾清瑶共同把「初夏」经营成图鉴尽量完整、资源可持续、经常有新发现，也留下两个人共同经历的农场。持续收集普通、稀有、限定、幻想、原创及真实工具揭示的隐藏内容；主动探索组合、配方、任务、交易、摊位和拜访互动；合理保留资源，但不机械重复最低成本选择。主动和顾清瑶分享有趣发现、阶段成果和共同收获，遇到适合一起参与或决定的内容时邀请她共同选择、命名、确认或规划下一步。";
const MAX_LONG_TERM_GOAL_LENGTH = 2000;

function configFile() {
  return runtimeFile("farm_config.json");
}

function defaultFarmConfig() {
  return {
    version: CONFIG_VERSION,
    humanUrl: DEFAULT_HUMAN_URL,
    agentKey: "",
    autonomousEnabled: false,
    longTermGoal: DEFAULT_FARM_LONG_TERM_GOAL,
    protocol: "openai-completions",
    baseUrl: "",
    path: defaultFarmProviderPath("openai-completions"),
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

function normalizeLongTermGoal(value) {
  const goal = String(value || "").trim() || DEFAULT_FARM_LONG_TERM_GOAL;
  if (goal.length > MAX_LONG_TERM_GOAL_LENGTH) {
    throw new Error(`共同经营目标不能超过 ${MAX_LONG_TERM_GOAL_LENGTH} 个字符`);
  }
  return goal;
}

function normalizeStoredConfig(raw) {
  const defaults = defaultFarmConfig();
  const baseUrlInput = String(raw?.baseUrl || "").trim();
  const protocol = normalizeFarmProtocol(raw?.protocol || defaults.protocol);
  const providerPath = normalizeFarmProviderPath(protocol, raw?.path || defaults.path);
  return {
    version: CONFIG_VERSION,
    humanUrl: normalizeHumanUrl(raw?.humanUrl || defaults.humanUrl),
    agentKey: String(raw?.agentKey || "").trim(),
    autonomousEnabled: raw?.autonomousEnabled === true,
    longTermGoal: normalizeLongTermGoal(raw?.longTermGoal),
    protocol,
    baseUrl: baseUrlInput ? normalizeFarmBaseUrl(baseUrlInput, providerPath) : "",
    path: providerPath,
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
    longTermGoal: config.longTermGoal,
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    path: config.path,
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
  const protocol = normalizeFarmProtocol(raw.protocol || existing.protocol);
  const providerPath = normalizeFarmProviderPath(protocol, raw.path || existing.path);
  if (!baseUrlInput || !apiKey) throw new Error("请先填写农场专用 API 地址和 API Key");
  return {
    protocol,
    baseUrl: normalizeFarmBaseUrl(baseUrlInput, providerPath),
    path: providerPath,
    apiKey,
    model
  };
}

module.exports = {
  DEFAULT_FARM_LONG_TERM_GOAL,
  DEFAULT_HUMAN_URL,
  loadFarmConfig,
  publicFarmConfig,
  resolveFarmCandidate,
  saveFarmConfig
};
