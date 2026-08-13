const crypto = require("crypto");
const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const CONFIG_VERSION = 2;

function configFile() {
  return runtimeFile("heartbeat_model_config.json");
}

function normalizeBaseUrl(value) {
  const input = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("API 地址必须是完整的 http:// 或 https:// 地址");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("API 地址只支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) throw new Error("API 地址不能包含账号或密码");
  if (parsed.search || parsed.hash) throw new Error("API 地址不能包含查询参数或锚点");

  parsed.pathname = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function chatCompletionsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

function modelsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

function profileFromLegacy(raw, source) {
  const baseUrl = normalizeBaseUrl(raw.apiUrl);
  return {
    id: "default",
    name: source === "shared" ? "腾讯云共享配置" : "原有方案",
    baseUrl,
    apiKey: String(raw.apiKey || "").trim(),
    model: String(raw.model || "").trim()
  };
}

function sharedStore(env = process.env) {
  if (!String(env.TARGET_API_URL || "").trim()) {
    return {
      version: CONFIG_VERSION,
      activeProfileId: "",
      profiles: [],
      source: "shared"
    };
  }
  const profile = profileFromLegacy({
    apiUrl: env.TARGET_API_URL,
    apiKey: env.TARGET_API_KEY,
    model: env.MODEL_NAME
  }, "shared");
  return {
    version: CONFIG_VERSION,
    activeProfileId: profile.id,
    profiles: [profile],
    source: "shared"
  };
}

function normalizeStoredProfile(raw) {
  return {
    id: String(raw.id || "").trim(),
    name: String(raw.name || "").trim(),
    baseUrl: normalizeBaseUrl(raw.baseUrl || raw.apiUrl),
    apiKey: String(raw.apiKey || "").trim(),
    model: String(raw.model || "").trim()
  };
}

function validateStore(store) {
  if (!store.profiles.length) throw new Error("至少需要保留一套主动消息线路方案");
  for (const profile of store.profiles) {
    if (!profile.id || !profile.name || !profile.model || !profile.apiKey) {
      throw new Error("主动消息线路方案缺少名称、模型或密钥");
    }
  }
  if (!store.profiles.some(profile => profile.id === store.activeProfileId)) {
    throw new Error("当前主动消息线路方案不存在");
  }
  return store;
}

function loadHeartbeatModelStore(env = process.env) {
  const filePath = configFile();
  if (!fs.existsSync(filePath)) return sharedStore(env);
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (saved.version === CONFIG_VERSION && Array.isArray(saved.profiles)) {
      return validateStore({
        version: CONFIG_VERSION,
        activeProfileId: String(saved.activeProfileId || "").trim(),
        profiles: saved.profiles.map(normalizeStoredProfile),
        source: "heartbeat"
      });
    }
    const profile = profileFromLegacy(saved, "heartbeat");
    return validateStore({
      version: CONFIG_VERSION,
      activeProfileId: profile.id,
      profiles: [profile],
      source: "heartbeat"
    });
  } catch (error) {
    throw new Error(`心跳模型配置无法读取：${error.message}`);
  }
}

function saveStore(store) {
  const saved = {
    version: CONFIG_VERSION,
    activeProfileId: store.activeProfileId,
    profiles: store.profiles
  };
  const filePath = configFile();
  writeJsonAtomicSync(filePath, saved);
  fs.chmodSync(filePath, 0o600);
  return { ...saved, source: "heartbeat" };
}

function loadHeartbeatModelConfig(env = process.env) {
  const store = loadHeartbeatModelStore(env);
  const profile = store.profiles.find(item => item.id === store.activeProfileId);
  if (!profile) return { baseUrl: "", apiUrl: "", apiKey: "", model: "", source: store.source };
  return {
    ...profile,
    apiUrl: chatCompletionsUrl(profile.baseUrl),
    source: store.source
  };
}

function publicHeartbeatModelConfig(env = process.env) {
  const store = loadHeartbeatModelStore(env);
  const active = store.profiles.find(profile => profile.id === store.activeProfileId);
  return {
    version: CONFIG_VERSION,
    activeProfileId: store.activeProfileId,
    profiles: store.profiles.map(profile => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKeyConfigured: Boolean(profile.apiKey)
    })),
    baseUrl: active?.baseUrl || "",
    apiUrl: active ? chatCompletionsUrl(active.baseUrl) : "",
    model: active?.model || "",
    apiKeyConfigured: Boolean(active?.apiKey),
    source: store.source
  };
}

function saveHeartbeatModelProfile(raw, env = process.env) {
  const store = loadHeartbeatModelStore(env);
  const requestedId = String(raw?.id || "").trim();
  const existing = requestedId ? store.profiles.find(profile => profile.id === requestedId) : null;
  if (requestedId && !existing) throw new Error("要修改的线路方案不存在");

  const profile = {
    id: existing?.id || `profile-${crypto.randomUUID()}`,
    name: String(raw?.name || "").trim(),
    baseUrl: normalizeBaseUrl(raw?.baseUrl || raw?.apiUrl),
    apiKey: Object.hasOwn(raw || {}, "apiKey") ? String(raw.apiKey || "").trim() : existing?.apiKey || "",
    model: String(raw?.model || "").trim()
  };
  if (!profile.name) throw new Error("方案名称不能为空");
  if (!profile.model) throw new Error("模型名称不能为空");
  if (!profile.apiKey) throw new Error(existing ? "新 API Key 不能为空" : "新方案必须填写 API Key");

  const profiles = existing
    ? store.profiles.map(item => item.id === profile.id ? profile : item)
    : [...store.profiles, profile];
  return saveStore(validateStore({
    version: CONFIG_VERSION,
    activeProfileId: raw?.activate === false ? store.activeProfileId : profile.id,
    profiles,
    source: "heartbeat"
  }));
}

function saveHeartbeatModelConfig(raw, env = process.env) {
  const store = loadHeartbeatModelStore(env);
  const active = store.profiles.find(profile => profile.id === store.activeProfileId);
  return saveHeartbeatModelProfile({
    ...(active ? { id: active.id } : {}),
    name: active?.name || "默认方案",
    baseUrl: raw?.baseUrl || raw?.apiUrl,
    model: raw?.model,
    ...(Object.hasOwn(raw || {}, "apiKey") ? { apiKey: raw.apiKey } : {})
  }, env);
}

function activateHeartbeatModelProfile(profileId, env = process.env) {
  const store = loadHeartbeatModelStore(env);
  const id = String(profileId || "").trim();
  if (!store.profiles.some(profile => profile.id === id)) throw new Error("要切换的线路方案不存在");
  return saveStore({ ...store, activeProfileId: id });
}

function deleteHeartbeatModelProfile(profileId, env = process.env) {
  const store = loadHeartbeatModelStore(env);
  const id = String(profileId || "").trim();
  if (!store.profiles.some(profile => profile.id === id)) throw new Error("要删除的线路方案不存在");
  if (store.profiles.length === 1) throw new Error("至少需要保留一套主动消息线路方案");
  const profiles = store.profiles.filter(profile => profile.id !== id);
  return saveStore({
    ...store,
    profiles,
    activeProfileId: store.activeProfileId === id ? profiles[0].id : store.activeProfileId
  });
}

function resolveHeartbeatModelCandidate(raw, env = process.env) {
  const store = loadHeartbeatModelStore(env);
  const id = String(raw?.id || store.activeProfileId).trim();
  const existing = store.profiles.find(profile => profile.id === id);
  const baseUrlInput = raw?.baseUrl || raw?.apiUrl || existing?.baseUrl;
  const model = String(raw?.model || existing?.model || "").trim();
  const apiKey = Object.hasOwn(raw || {}, "apiKey")
    ? String(raw.apiKey || "").trim()
    : existing?.apiKey || "";
  if (!baseUrlInput || !apiKey) throw new Error("请先填写 API 地址和 API Key");
  return {
    baseUrl: normalizeBaseUrl(baseUrlInput),
    apiKey,
    model
  };
}

module.exports = {
  activateHeartbeatModelProfile,
  chatCompletionsUrl,
  deleteHeartbeatModelProfile,
  loadHeartbeatModelConfig,
  loadHeartbeatModelStore,
  modelsUrl,
  normalizeBaseUrl,
  publicHeartbeatModelConfig,
  resolveHeartbeatModelCandidate,
  saveHeartbeatModelConfig,
  saveHeartbeatModelProfile
};
