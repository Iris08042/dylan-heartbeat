require("dotenv").config({ quiet: true });

const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");
const { Readable } = require("node:stream");
const {
  PROJECT_DIR,
  ensureDataDir,
  runtimeDirectory,
  runtimeFile,
  writeJsonAtomicSync
} = require("./runtime_paths");
const { isSpecialEventContent } = require("./special_events");
const { decideRequestAccess } = require("./network_access");
const {
  acknowledgeInboxEvents,
  enqueueInboxEvent,
  listPendingInboxEvents
} = require("./heartbeat_inbox");
const {
  activeProfile,
  loadPolicy,
  loadPolicyState,
  savePolicy
} = require("./heartbeat_policy");
const {
  activateHeartbeatModelProfile,
  chatCompletionsUrl,
  deleteHeartbeatModelProfile,
  modelsUrl,
  publicHeartbeatModelConfig,
  resolveHeartbeatModelCandidate,
  saveHeartbeatModelConfig,
  saveHeartbeatModelProfile
} = require("./heartbeat_model_config");
const {
  loadHeartbeatPromptConfig,
  saveHeartbeatPromptConfig
} = require("./heartbeat_prompt_config");
const {
  formatDateTimeInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");
const { createCloudBackupStore } = require("./cloud_backup");
const { ProviderRelayError, forwardProviderRequest } = require("./provider_relay");
const {
  loadFarmConfig,
  publicFarmConfig,
  resolveFarmCandidate,
  saveFarmConfig
} = require("./farm_config");
const { inspectFarmTools } = require("./farm_mcp");
const { runFarmAgent } = require("./farm_agent");
const { discoverFarmModels, requestFarmProvider } = require("./farm_provider");
const { executeScheduledMessageTool } = require("./scheduled_messages");
const { processDueScheduledMessages } = require("./scheduled_message_runtime");
const {
  createOmbreDashboardClient,
  mapOmbreDashboardError,
  normalizeOmbreBucket
} = require("./ombre_dashboard");

const DEFAULT_BODY_LIMIT_MB = 50;
const DEFAULT_BACKUP_BODY_LIMIT_MB = 512;

function readBodyLimitBytes() {
  const configured = Number(process.env.REQUEST_BODY_LIMIT_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BODY_LIMIT_MB;
  return Math.floor(mb * 1024 * 1024);
}

const app = Fastify({
  logger: true,
  bodyLimit: readBodyLimitBytes()
});

app.register(require("@fastify/formbody"));
app.addContentTypeParser("application/zip", { parseAs: "buffer" }, (req, body, done) => done(null, body));
app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (req, body, done) => done(null, body));

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIME_ZONE = resolveTimeZone();
const IS_RAILWAY_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);
// 批注 2026-08-10：默认路径仍是项目目录，保护本机/VPS 旧部署；Railway 挂载 Volume 后
// DATA_DIR（或平台提供的 RAILWAY_VOLUME_MOUNT_PATH）统一承载时间线、时间戳、预设和日记。
const DATA_DIR = ensureDataDir();
const cloudBackupStore = createCloudBackupStore({ dataDir: DATA_DIR });
const ombreDashboard = createOmbreDashboardClient();
const TIMELINE_FILE = runtimeFile("enhanced_messages.json");
const TIMESTAMP_DB_FILE = runtimeFile("message_timestamps.json");
// 批注 2026-07-17：管理页保存 .env 后要让 PM2 刷新进程环境；保留原进程名，
// 只补 --update-env，避免用户改完推送配置却继续运行旧值。
const GATEWAY_RESTART_COMMAND = "pm2 restart gateway --update-env";

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function configuredModelName() {
  // 批注 2026-07-15：/v1/models 要暴露部署者实际配置的模型名；
  // 不能继续硬编码示例模型，否则 Kelivo 模型选择会和真实上游不一致。
  return String(process.env.MODEL_NAME || "gateway-model").trim() || "gateway-model";
}

// ========================
// 多模态消息处理
// ========================
function shouldForwardMultimodalContent() {
  // 批注 2026-07-15：默认把 Kelivo 的图片 content 数组原样交给视觉模型；
  // 如果上游不是多模态模型，部署者仍可显式设 MULTIMODAL_MODE=text 退回旧的 [图片] 占位模式。
  const mode = (process.env.MULTIMODAL_MODE || "passthrough").trim().toLowerCase();
  return !["text", "plain", "placeholder", "false", "off", "0"].includes(mode);
}

function isDataImageUrl(value) {
  return typeof value === "string" && /^data:image\//i.test(value);
}

function isImageContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.image_url) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("image");
}

function isFileContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.file) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("file");
}

function getTextFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (type === "text" || type === "input_text") return part.text || part.content || "";
  if (typeof part.text === "string") return part.text;
  return "";
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        const text = getTextFromContentPart(part).trim();
        if (text) return text;
        if (isImageContentPart(part)) return "[图片]";
        if (isFileContentPart(part)) return "[文件]";
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (isImageContentPart(content)) return "[图片]";
  if (isFileContentPart(content)) return "[文件]";
  return "[非文本内容]";
}

function normalizeMessageForTimeline(msg) {
  return { ...msg, content: normalizeContentToText(msg.content) };
}

function prepareMessageForLLM(msg) {
  if (msg.role === "assistant" && msg.tool_calls) return msg;
  if (msg.role === "tool") return msg;
  if (msg.role === "system") return { ...msg, content: normalizeContentToText(msg.content) };
  if (typeof msg.content === "string") return msg;

  if (Array.isArray(msg.content) && shouldForwardMultimodalContent()) return msg;

  const textContent = normalizeContentToText(msg.content);
  if (!textContent) return null;
  return { ...msg, content: textContent };
}

function sanitizeForLog(value) {
  if (typeof value === "string") {
    if (isDataImageUrl(value)) {
      const commaIndex = value.indexOf(",");
      const prefix = commaIndex >= 0 ? value.slice(0, commaIndex + 1) : value.slice(0, 40);
      return `${prefix}[base64 image omitted]`;
    }
    if (value.length > 1000) return `${value.slice(0, 1000)}... [truncated ${value.length - 1000} chars]`;
    return value;
  }

  if (Array.isArray(value)) return value.map(sanitizeForLog);

  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeForLog(child);
    }
    return sanitized;
  }

  return value;
}

function summarizeMessageForLog(msg) {
  const parts = Array.isArray(msg?.content) ? msg.content : [msg?.content];
  const textChars = parts.reduce((sum, part) => sum + getTextFromContentPart(part).length, 0);
  return {
    role: msg?.role || "",
    content_type: Array.isArray(msg?.content) ? "multimodal" : typeof msg?.content,
    text_chars: textChars || normalizeContentToText(msg?.content).length,
    image_parts: parts.filter(isImageContentPart).length,
    file_parts: parts.filter(isFileContentPart).length,
    tool_calls: Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0
  };
}

function summarizeMessagesForLog(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let imageParts = 0;
  let fileParts = 0;
  let textChars = 0;
  for (const msg of list) {
    const item = summarizeMessageForLog(msg);
    roles[item.role] = (roles[item.role] || 0) + 1;
    imageParts += item.image_parts;
    fileParts += item.file_parts;
    textChars += item.text_chars;
  }
  return { total: list.length, roles, text_chars: textChars, image_parts: imageParts, file_parts: fileParts };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ========================
// 读取 timeline
// ========================
function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try { return fs.readJsonSync(TIMELINE_FILE); } catch { return []; }
}

// ========================
// 保存 timeline（保留 SP）
// ========================
function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(message => {
    if (message.role === "system") return false;
    if (message.heartbeatInboxPending === true) return false;
    if (message.role !== "assistant") return true;
    return !isSpecialEventContent(normalizeContentToText(message.content));
  });
  const trimmed = nonSP.slice(-50);
  const final = sp ? [sp, ...trimmed] : trimmed;
  writeJsonAtomicSync(TIMELINE_FILE, final);
}

function saveHeartbeatContext(raw) {
  const systemPrompt = String(raw?.systemPrompt || "").trim();
  const messages = (Array.isArray(raw?.messages) ? raw.messages : [])
    .filter(message => message?.role === "user" || message?.role === "assistant")
    .map(message => ({
      id: String(message.id || "").trim(),
      role: message.role,
      content: normalizeContentToText(message.content).trim(),
      timestamp: Number(message.timestamp)
    }))
    .filter(message => message.id && message.content && Number.isFinite(message.timestamp))
    .slice(-50);
  if (!messages.some(message => message.role === "user")) {
    throw new Error("at least one user message is required");
  }
  saveTimeline([{ role: "system", content: systemPrompt }, ...messages]);
  return { messageCount: messages.length, latestMessageAt: messages.at(-1)?.timestamp || null };
}

// ========================
// 提取时间戳（支持多种格式）
// ========================
function parseTimestampLabel(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  // 批注 2026-07-30：Kelivo 写进消息前缀的是用户配置时区的墙上时间；
  // 公网/Railway 不能按服务器 UTC 解析，否则时间线和自动唤醒都会被推迟。
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function stripLeadingTimestamp(content) {
  // 批注 2026-07-15：兼容 Kelivo 有时把日期和时间贴在一起的前缀；
  // 旧格式 "YYYY-MM-DD HH:mm" 继续保留，新格式 "YYYY-MM-DDHH:mm" 不再导致时间记忆/排序失效。
  return String(content || "")
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .trim();
}

function extractTimestamp(content) {
  return parseTimestampLabel(content);
}

// ========================
// 时间戳记忆库
// ========================
function loadTimestampDB() {
  if (!fs.existsSync(TIMESTAMP_DB_FILE)) return {};
  try { return fs.readJsonSync(TIMESTAMP_DB_FILE); } catch { return {}; }
}

function saveTimestampDB(db) {
  writeJsonAtomicSync(TIMESTAMP_DB_FILE, db);
}

function makeFingerprint(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = raw.trim().slice(0, 150);
  return `${msg.role}::${content}`;
}

function makeFingerprintStripped(msg) {
  const raw = normalizeContentToText(msg.content);
  const content = stripLeadingTimestamp(raw).slice(0, 150);
  return `${msg.role}::${content}`;
}

function extractTimestampWithMemory(msg, tsDB) {
  const fromContent = extractTimestamp(normalizeContentToText(msg.content));
  if (fromContent) return fromContent;
  const fp = makeFingerprint(msg);
  if (tsDB[fp]) return new Date(tsDB[fp]);
  const fpStripped = makeFingerprintStripped(msg);
  if (tsDB[fpStripped]) return new Date(tsDB[fpStripped]);
  return null;
}

// ========================
// 消息判断
// ========================
function isSpecialEvent(msg) {
  if (msg.role !== "assistant") return false;
  if (msg.heartbeatInboxPending === true) return true;
  return isSpecialEventContent(normalizeContentToText(msg.content));
}

function heartbeatInboxEventId(message) {
  const metadataId = String(message?.heartbeatInboxId || "").trim();
  if (metadataId) return metadataId;
  const messageId = String(message?.id || "").trim();
  return messageId.startsWith("heartbeat-inbox:")
    ? messageId.slice("heartbeat-inbox:".length)
    : "";
}

function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return false;
  return msg.role === "user" || msg.role === "assistant";
}

function isSystemRule(msg) {
  if (msg.role === "system") return true;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return true;
  return false;
}

// ========================
// 构建 Timeline
// ========================
function buildTimeline(kelivoMessages, tsDB) {
  const oldTimeline = loadTimeline();
  const newSystemMessages = kelivoMessages
    .filter(msg => msg.role === "system")
    .map(normalizeMessageForTimeline);
  const latestSP = newSystemMessages.length > 0 ? newSystemMessages[newSystemMessages.length - 1] : null;
  const oldSP = oldTimeline.find(msg => msg.role === "system");

  const newRealMessages = kelivoMessages
    .filter(isRealMessageForTimeline)
    .map(normalizeMessageForTimeline);

  const result = [];
  if (latestSP) result.push({ ...latestSP, position: 0 });
  else if (oldSP) result.push({ ...oldSP, position: 0 });

  let realPos = 1;
  const finalMessages = [];
  for (const msg of newRealMessages) {
    finalMessages.push({ ...msg, position: realPos });
    realPos++;
  }

  result.push(...finalMessages);
  return result;
}

function appendAcknowledgedInboxMessages(events, acknowledgedAt) {
  if (!Array.isArray(events) || events.length === 0) return;
  const timeline = loadTimeline();
  const tsDB = loadTimestampDB();
  const existingIds = new Set(timeline.map(heartbeatInboxEventId).filter(Boolean));
  let changed = false;

  for (const event of events) {
    if (!event?.id || !event?.content || existingIds.has(event.id)) continue;
    const createdAt = Number(event.createdAt);
    const message = {
      id: `heartbeat-inbox:${event.id}`,
      role: "assistant",
      content: event.content,
      timestamp: createdAt,
      heartbeatInboxId: event.id,
      heartbeatInboxKind: event.kind === "thought" ? "thought" : "contact",
      heartbeatInboxCreatedAt: createdAt,
      heartbeatInboxAcknowledgedAt: Number(acknowledgedAt)
    };
    const insertAt = timeline.findIndex(candidate => {
      if (candidate.role === "system") return false;
      const inboxTime = Number(candidate.heartbeatInboxCreatedAt);
      const parsedTime = Number.isFinite(inboxTime)
        ? inboxTime
        : extractTimestampWithMemory(candidate, tsDB)?.getTime();
      return Number.isFinite(parsedTime) && parsedTime > createdAt;
    });
    if (insertAt === -1) timeline.push(message);
    else timeline.splice(insertAt, 0, message);
    existingIds.add(event.id);
    changed = true;
  }

  if (changed) saveTimeline(timeline);
}

function readBearerToken(req) {
  return String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

function requireHeartbeatInboxToken(req, reply) {
  const configured = String(process.env.HEARTBEAT_INBOX_TOKEN || "").trim();
  if (!configured) {
    reply.code(503).send({ error: "HEARTBEAT_INBOX_TOKEN is not configured" });
    return false;
  }
  if (readBearerToken(req) !== configured) {
    reply.code(401).send({ error: "Heartbeat inbox token is invalid or missing" });
    return false;
  }
  return true;
}

function readBackupBodyLimitBytes() {
  const configured = Number(process.env.POLARIS_BACKUP_BODY_LIMIT_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BACKUP_BODY_LIMIT_MB;
  return Math.floor(mb * 1024 * 1024);
}

function requireCloudBackupToken(req, reply) {
  const configured = String(process.env.POLARIS_BACKUP_TOKEN || "").trim();
  if (!configured) {
    reply.code(503).send({ error: "POLARIS_BACKUP_TOKEN is not configured" });
    return false;
  }
  if (readBearerToken(req) !== configured) {
    reply.code(401).send({ error: "Cloud backup token is invalid or missing" });
    return false;
  }
  return true;
}

function requireOmbreDashboardToken(req, reply) {
  const configured = String(process.env.POLARIS_BACKUP_TOKEN || "").trim();
  if (!configured) {
    reply.code(503).send({ error: "POLARIS_BACKUP_TOKEN is not configured" });
    return false;
  }
  if (readBearerToken(req) !== configured) {
    reply.code(401).send({ error: "Ombre Dashboard access token is invalid or missing" });
    return false;
  }
  return true;
}

let wakeUpLastHeartbeat = null;

// ========================
// 预设方案
// ========================
const PRESETS_FILE = runtimeFile("presets.json");
// .env 是启动配置而不是运行数据；继续固定在代码目录，Railway 则始终以 Variables 为权威来源。
const ENV_FILE = path.join(PROJECT_DIR, ".env");
const PREFERRED_ENV_ORDER = [
  "TARGET_API_URL",
  "TARGET_API_KEY",
  "GATEWAY_API_KEY",
  "HEARTBEAT_INBOX_TOKEN",
  "POLARIS_BACKUP_TOKEN",
  "POLARIS_BACKUP_BODY_LIMIT_MB",
  "OMBRE_DASHBOARD_URL",
  "OMBRE_DASHBOARD_PASSWORD",
  "OMBRE_DASHBOARD_TIMEOUT_MS",
  "MODEL_NAME",
  "BARK_KEY",
  "BARK_TITLE",
  "CUSTOM_ICON_URL",
  "ALLOW_PUBLIC_API",
  "PUSH_PROVIDER",
  "NTFY_SERVER_URL",
  "NTFY_TOPIC",
  "NTFY_TOKEN",
  "NTFY_PRIORITY",
  "NTFY_TAGS",
  "DIARY_ENABLED",
  "DIARY_DIR",
  "DATA_DIR",
  "PUSH_TIMEOUT_MS",
  "WAKE_UPSTREAM_TIMEOUT_MS",
  "REQUEST_BODY_LIMIT_MB",
  "MULTIMODAL_MODE",
  "WEATHER_ENABLED",
  "WEATHER_LOCATION_NAME",
  "WEATHER_LAT",
  "WEATHER_LON",
  "WEATHER_UNITS",
  "PORT",
  "GATEWAY_BASE_URL",
  "TIME_ZONE",
  "ADMIN_USER",
  "ADMIN_PASSWORD"
];

function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try { return fs.readJsonSync(PRESETS_FILE); } catch { return []; }
}

function savePresets(presets) {
  writeJsonAtomicSync(PRESETS_FILE, presets);
}

function wantsJsonResponse(req) {
  const contentType = req.headers["content-type"] || "";
  const accept = req.headers.accept || "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

function loadEnvFileObject() {
  const result = {};
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      result[key] = value;
    }
  } catch {}
  return result;
}

function serializeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n");
}

function writeEnvUpdates(updates) {
  const merged = { ...loadEnvFileObject(), ...updates };
  const orderedKeys = [
    ...PREFERRED_ENV_ORDER.filter(key => Object.prototype.hasOwnProperty.call(merged, key)),
    ...Object.keys(merged)
      .filter(key => !PREFERRED_ENV_ORDER.includes(key))
      .sort()
  ];
  const lines = orderedKeys.map(key => `${key}=${serializeEnvValue(merged[key])}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

// ========================
// 安全：管理页走 Basic Auth，/v1 按公开开关鉴权，内部写接口只允许同进程容器 localhost
// ========================
app.addHook("onRequest", (req, reply, done) => {
  const requestPath = req.url.split("?")[0];
  const ip = String(req.ip || req.connection.remoteAddress || "");
  const headerKey = String(req.headers["x-gateway-api-key"] || req.headers["x-api-key"] || "").trim();
  const access = decideRequestAccess({
    path: requestPath,
    ip,
    isRailway: IS_RAILWAY_RUNTIME,
    allowPublicApi: readBooleanEnv("ALLOW_PUBLIC_API", false),
    configuredKey: readEnvValue("GATEWAY_API_KEY"),
    authorization: req.headers.authorization,
    headerKey
  });
  if (access.allow) return done();
  if (access.authRejected) {
    // 批注 2026-07-30：Kelivo 可能在模型探测或旧预设里继续带错 key；
    // 只记路径和 header 类型，帮助排查缓存/重复请求，绝不把任意密钥写入日志。
    console.warn(JSON.stringify({
      event: "gateway_auth_rejected",
      path: requestPath,
      auth_source: access.authSource || "missing"
    }));
  }
  reply.code(access.status || 403).send(access.status === 401 ? { error: access.error } : access.error);
});

app.get("/healthz", async () => ({ status: "ok" }));

// ========================
// Provider relay
// ========================
app.post("/api/provider-relay", async (req, reply) => {
  try {
    const upstream = await forwardProviderRequest(req.body);
    reply
      .code(upstream.status)
      .header("Cache-Control", "no-store, no-transform")
      .header("X-Accel-Buffering", "no");
    const contentType = upstream.headers.get("content-type");
    if (contentType) reply.header("Content-Type", contentType);
    if (!upstream.body) return reply.send(await upstream.text());
    return reply.send(Readable.fromWeb(upstream.body));
  } catch (error) {
    if (error instanceof ProviderRelayError) {
      return reply.code(error.status).send({ error: { message: error.message, type: error.type } });
    }
    console.error(JSON.stringify({
      event: "provider_relay_error",
      message: error instanceof Error ? error.message : String(error)
    }));
    return reply.code(502).send({ error: { message: "provider relay 请求失败。", type: "relay_error" } });
  }
});

// ========================
// Models
// ========================
app.get("/v1/models", async (req, reply) => {
  reply.send({
    object: "list",
    data: [{ id: configuredModelName(), object: "model", created: 0, owned_by: "gateway" }]
  });
});

// ========================
// Chat Completions
// ========================
app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    // 批注 2026-07-15：公开部署时日志不能默认写入完整上下文；
    // 这里只保留请求摘要，避免 system prompt、记忆和聊天正文进入 pm2 日志。
    console.log(JSON.stringify({
      event: "kelivo_request",
      model: body?.model || "",
      stream: body?.stream === true,
      messages: summarizeMessagesForLog(body?.messages || [])
    }));

    const kelivoMessages = body.messages || [];
    const tsDB = loadTimestampDB();
    let tsDBDirty = false;
    for (const msg of kelivoMessages) {
      if (msg.role === "system") continue;
      if (msg.role === "tool") continue;
      const ts = extractTimestamp(normalizeContentToText(msg.content));
      if (!ts) continue;
      const fp = makeFingerprint(msg);
      const fpStripped = makeFingerprintStripped(msg);
      if (!tsDB[fp]) { tsDB[fp] = ts.toISOString(); tsDBDirty = true; }
      if (!tsDB[fpStripped]) { tsDB[fpStripped] = ts.toISOString(); tsDBDirty = true; }
    }
    if (tsDBDirty) saveTimestampDB(tsDB);

    const finalTimeline = buildTimeline(kelivoMessages, tsDB);
    saveTimeline(finalTimeline);

    // Kelivo 发图时 content 常是数组。默认原样透传给视觉模型；
    // 如上游不支持图片，可设置 MULTIMODAL_MODE=text 退回文本占位。
    const llmMessages = kelivoMessages
      .map(prepareMessageForLLM)
      .filter(Boolean);

    console.log(JSON.stringify({
      event: "llm_forward_summary",
      messages: summarizeMessagesForLog(llmMessages)
    }));

    // ---- 自动修复不完整的 tool 调用（双向清理） ----
    // 第一遍：标记需要移除的索引
    const removeSet = new Set();

    // 检查 assistant tool_calls 是否完整
    for (let i = 0; i < llmMessages.length; i++) {
      const msg = llmMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      const expectedIds = msg.tool_calls.map(tc => tc.id);
      const followingTools = [];
      for (let j = i + 1; j < llmMessages.length; j++) {
        const nxt = llmMessages[j];
        if (nxt.role === "tool") {
          followingTools.push(nxt);
        } else {
          break;
        }
      }
      const foundIds = followingTools.map(t => t.tool_call_id);
      const complete = expectedIds.every(id => foundIds.includes(id));
      if (!complete) {
        // 标记这条 assistant 为移除，同时标记它后面的所有 tool 消息也移除
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") {
            removeSet.add(j);
          } else {
            break;
          }
        }
        console.log(`⚠️ 自动修复：移除不完整的 tool_calls (索引 ${i})`);
      }
    }

    // 检查孤立 tool 消息（前面没有对应的 tool_calls）
    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      // 向前查找最近的 assistant
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          // 检查这个 tool_call_id 是否在 assistant 的 tool_calls 中
          const ids = prev.tool_calls.map(tc => tc.id);
          if (ids.includes(llmMessages[i].tool_call_id)) {
            hasMatchingToolCalls = true;
          }
          break;
        } else if (prev.role === "tool") {
          continue; // 继续向前找
        } else {
          break; // 遇到 user 或其他消息，停止
        }
      }
      if (!hasMatchingToolCalls) {
        removeSet.add(i);
        console.log(`⚠️ 自动修复：移除孤立的 tool 消息 (索引 ${i})`);
      }
    }

    // 按索引从大到小删除，避免索引错乱
    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      llmMessages.splice(idx, 1);
    }

    if (!TARGET_API_URL || !process.env.TARGET_API_KEY) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 未配置" });
    }

    const requestedStream = body?.stream === true;

    // 请求模型
    const response = await fetch(TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify({ ...body, messages: llmMessages })
    });

    const upstreamContentType = response.headers.get("content-type") || "";
    const shouldStreamResponse = requestedStream || upstreamContentType.includes("text/event-stream");

    // 批注 2026-07-11：Kelivo 关闭 stream 时需要收到普通 JSON；只在请求或上游确认为 SSE 时才按流式直通。
    if (!shouldStreamResponse) {
      const responseText = await response.text();
      return reply
        .code(response.status)
        .header("Content-Type", upstreamContentType || "application/json")
        .send(responseText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "上游 API 没有返回可读取的响应体" });
    }

    reply.raw.writeHead(response.status, {
      "Content-Type": upstreamContentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(value);
    }
    reply.raw.end();
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 内部接口：记录唤醒事件
// ========================
app.post("/internal/wake-event", async (req, reply) => {
  try {
    const { inboxContent, inboxKind } = req.body || {};
    if (!String(inboxContent || "").trim()) {
      return reply.code(400).send({ error: "inboxContent is required" });
    }
    const kind = inboxKind === "thought" ? "thought" : "contact";
    const inboxEvent = enqueueInboxEvent(inboxContent, Date.now(), kind);
    reply.send({ success: true, inboxEventId: inboxEvent.id });
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

app.get("/api/polaris/heartbeat/inbox", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  reply.send({ events: listPendingInboxEvents() });
});

app.post("/api/polaris/heartbeat/ack", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return reply.code(400).send({ error: "ids must be an array" });
  const requestedIds = new Set(ids.map(id => String(id || "").trim()).filter(Boolean));
  const pending = listPendingInboxEvents().filter(event => requestedIds.has(event.id));
  const acknowledgedAt = Date.now();
  appendAcknowledgedInboxMessages(pending, acknowledgedAt);
  const acknowledged = acknowledgeInboxEvents(ids, acknowledgedAt);
  reply.send({ acknowledged: acknowledged.map(event => event.id) });
});

app.put("/api/polaris/heartbeat/context", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    const saved = saveHeartbeatContext(req.body || {});
    console.log(JSON.stringify({ event: "heartbeat_context_synced", ...saved }));
    reply.send({ success: true, ...saved });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

function heartbeatPolicySnapshot() {
  const now = new Date();
  const policy = loadPolicy();
  const selected = activeProfile(policy, now, TIME_ZONE);
  return {
    policy,
    active: {
      profileId: selected.profile?.id || null,
      profileName: selected.profile?.name || "",
      allowContact: selected.allowContact !== false,
      source: selected.source,
      scheduleId: selected.schedule?.id || null,
      scheduleName: selected.schedule?.name || ""
    },
    state: loadPolicyState(),
    serverTime: now.toISOString(),
    timeZone: TIME_ZONE
  };
}

app.get("/api/polaris/heartbeat/policy", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  reply.send(heartbeatPolicySnapshot());
});

app.put("/api/polaris/heartbeat/policy", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    const incoming = req.body?.policy || req.body || {};
    const current = loadPolicy();
    savePolicy({
      ...incoming,
      enabled: typeof incoming.enabled === "boolean" ? incoming.enabled : current.enabled
    });
    reply.send(heartbeatPolicySnapshot());
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.get("/api/polaris/heartbeat/status", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  reply.send(heartbeatPolicySnapshot());
});

app.get("/api/polaris/backup/status", async (req, reply) => {
  if (!requireCloudBackupToken(req, reply)) return;
  const backups = cloudBackupStore.listBackups();
  reply.send({ backups });
});

app.post("/api/polaris/backup/backups", { bodyLimit: readBackupBodyLimitBytes() }, async (req, reply) => {
  if (!requireCloudBackupToken(req, reply)) return;
  try {
    const backup = cloudBackupStore.saveBackup(
      req.body,
      String(req.headers["x-polaris-backup-created-at"] || "")
    );
    reply.send({ backup });
  } catch (error) {
    reply.code(400).send({ error: error.message });
  }
});

app.get("/api/polaris/backup/backups/:id", async (req, reply) => {
  if (!requireCloudBackupToken(req, reply)) return;
  const backup = cloudBackupStore.readBackup(req.params.id);
  if (!backup) return reply.code(404).send({ error: "Cloud backup was not found" });
  reply
    .header("content-type", "application/zip")
    .header("content-disposition", `attachment; filename=polaris-cloud-backup-${req.params.id}.zip`)
    .header("x-polaris-backup-sha256", backup.metadata.sha256)
    .send(backup.buffer);
});

function sendOmbreDashboardError(reply, error) {
  const mapped = mapOmbreDashboardError(error);
  console.warn(JSON.stringify({ event: "ombre_dashboard_error", code: error?.code || "unknown" }));
  reply.code(mapped.status).send({ error: mapped.error, message: mapped.message });
}

app.get("/api/polaris/ombre/status", async (req, reply) => {
  if (!requireOmbreDashboardToken(req, reply)) return;
  if (!ombreDashboard.configured()) {
    return reply.code(503).send({ available: false, error: "ombre_not_configured" });
  }
  try {
    const data = await ombreDashboard.request("/api/status");
    const buckets = data.buckets || {};
    reply.send({
      available: true,
      version: data.version || null,
      total: Number(buckets.total ?? data.total ?? 0),
      permanent: Number(buckets.permanent ?? 0),
      dynamic: Number(buckets.dynamic ?? 0),
      archived: Number(buckets.archive ?? buckets.archived ?? 0)
    });
  } catch (error) {
    sendOmbreDashboardError(reply, error);
  }
});

app.get("/api/polaris/ombre/buckets", async (req, reply) => {
  if (!requireOmbreDashboardToken(req, reply)) return;
  try {
    const state = String(req.query?.state || "").toLowerCase();
    const upstreamParams = new URLSearchParams({ sort: "created_desc" });
    if (state === "archived") upstreamParams.set("include_archive", "true");
    const data = await ombreDashboard.request(`/api/buckets?${upstreamParams.toString()}`);
    let items = (Array.isArray(data) ? data : data.buckets || data.items || []).map(normalizeOmbreBucket);
    const type = String(req.query?.type || "").toLowerCase();
    if (type) items = items.filter(item => item.type.toLowerCase() === type);
    if (state === "pinned") items = items.filter(item => item.pinned);
    if (state === "archived") items = items.filter(item => item.archived);
    reply.send({ items, total: items.length });
  } catch (error) {
    sendOmbreDashboardError(reply, error);
  }
});

app.get("/api/polaris/ombre/search", async (req, reply) => {
  if (!requireOmbreDashboardToken(req, reply)) return;
  const query = String(req.query?.q || "").trim().slice(0, 160);
  if (!query) return reply.send({ items: [], total: 0, query: "" });
  try {
    const data = await ombreDashboard.request(`/api/search?q=${encodeURIComponent(query)}`);
    const raw = Array.isArray(data) ? data : data.results || data.items || data.buckets || [];
    const items = raw.map(normalizeOmbreBucket);
    reply.send({ items, total: items.length, query });
  } catch (error) {
    sendOmbreDashboardError(reply, error);
  }
});

app.get("/api/polaris/ombre/buckets/:id", async (req, reply) => {
  if (!requireOmbreDashboardToken(req, reply)) return;
  try {
    const data = await ombreDashboard.request(`/api/bucket/${encodeURIComponent(req.params.id)}`);
    reply.send(normalizeOmbreBucket(data.bucket || data));
  } catch (error) {
    sendOmbreDashboardError(reply, error);
  }
});

app.post("/api/polaris/ombre/buckets/:id/:action", async (req, reply) => {
  if (!requireOmbreDashboardToken(req, reply)) return;
  const action = String(req.params.action || "");
  if (!["pin", "resolve", "archive", "forget", "anchor"].includes(action)) {
    return reply.code(404).send({ error: "Unsupported Ombre action" });
  }
  try {
    const data = await ombreDashboard.request(
      `/api/bucket/${encodeURIComponent(req.params.id)}/${action}`,
      { method: "POST", body: req.body || {} }
    );
    reply.send(data);
  } catch (error) {
    sendOmbreDashboardError(reply, error);
  }
});

app.get("/api/polaris/ombre/breath-debug", async (req, reply) => {
  if (!requireOmbreDashboardToken(req, reply)) return;
  const params = new URLSearchParams();
  params.set("q", String(req.query?.q || "").trim().slice(0, 160));
  if (req.query?.valence !== undefined && req.query.valence !== "") params.set("valence", String(req.query.valence));
  if (req.query?.arousal !== undefined && req.query.arousal !== "") params.set("arousal", String(req.query.arousal));
  try {
    reply.send(await ombreDashboard.request(`/api/breath-debug?${params.toString()}`));
  } catch (error) {
    sendOmbreDashboardError(reply, error);
  }
});

app.get("/api/polaris/heartbeat/model", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    reply.send(publicHeartbeatModelConfig());
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.put("/api/polaris/heartbeat/model", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    saveHeartbeatModelConfig(req.body || {});
    reply.send(publicHeartbeatModelConfig());
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.put("/api/polaris/heartbeat/model/profile", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    saveHeartbeatModelProfile(req.body || {});
    reply.send(publicHeartbeatModelConfig());
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.put("/api/polaris/heartbeat/model/active", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    activateHeartbeatModelProfile(req.body?.id);
    reply.send(publicHeartbeatModelConfig());
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.delete("/api/polaris/heartbeat/model/profile/:id", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    deleteHeartbeatModelProfile(req.params.id);
    reply.send(publicHeartbeatModelConfig());
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

function upstreamError(body, status) {
  const message = body?.error?.message || body?.error || body?.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 500)
    : `上游接口返回 ${status}`;
}

async function requestHeartbeatProvider(url, candidate, body) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${candidate.apiKey}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(upstreamError(result, response.status));
  return result;
}

app.post("/api/polaris/heartbeat/model/models", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    const candidate = resolveHeartbeatModelCandidate(req.body || {});
    const result = await requestHeartbeatProvider(modelsUrl(candidate.baseUrl), candidate);
    const models = Array.isArray(result?.data)
      ? result.data.map(item => String(item?.id || "").trim()).filter(Boolean).sort()
      : [];
    reply.send({ models });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.post("/api/polaris/heartbeat/model/test", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    const candidate = resolveHeartbeatModelCandidate(req.body || {});
    if (!candidate.model) throw new Error("请先选择模型");
    const result = await requestHeartbeatProvider(chatCompletionsUrl(candidate.baseUrl), candidate, {
      model: candidate.model,
      messages: [{ role: "user", content: "Reply with OK." }],
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    });
    const content = result?.choices?.[0]?.message?.content;
    reply.send({ ok: true, model: String(result?.model || candidate.model), reply: typeof content === "string" ? content.slice(0, 100) : "" });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

function farmAgentKeyCandidate(raw = {}) {
  const supplied = String(raw.agentKey || "").trim();
  const agentKey = supplied || loadFarmConfig().agentKey;
  if (!agentKey) throw new Error("请先填写农场 Agent Key");
  return agentKey;
}

function publicFarmTools(tools) {
  return tools.map(tool => ({
    name: String(tool?.name || ""),
    description: String(tool?.description || ""),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema
      : { type: "object", properties: {} }
  })).filter(tool => tool.name);
}

app.get("/api/polaris/farm/config", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    reply.send(publicFarmConfig());
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.put("/api/polaris/farm/config", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    reply.send(publicFarmConfig(saveFarmConfig(req.body || {})));
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.post("/api/polaris/farm/models", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    const candidate = resolveFarmCandidate(req.body || {});
    const models = await discoverFarmModels(candidate);
    reply.send({ models });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.post("/api/polaris/farm/test-model", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    const candidate = resolveFarmCandidate(req.body || {});
    if (!candidate.model) throw new Error("请先选择农场专用模型");
    const result = await requestFarmProvider(candidate, [{ role: "user", content: "Reply with OK." }]);
    reply.send({
      ok: true,
      model: result.model,
      reply: String(result.message.content || "").slice(0, 100)
    });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.post("/api/polaris/farm/test-connection", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    const tools = await inspectFarmTools(farmAgentKeyCandidate(req.body || {}));
    reply.send({ ok: true, tools: publicFarmTools(tools) });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

const MANAGED_FARM_TOOL = {
  name: "farm_agent",
  description: "让《无尽夏》的专用农场代理查看或经营我们的农场。具体农场工具与专用模型费用均由农场独立配置承担。",
  inputSchema: {
    type: "object",
    properties: {
      instruction: { type: "string", description: "要完成的具体农场任务" },
      context: { type: "string", description: "可选的简短背景或偏好" }
    },
    required: ["instruction"],
    additionalProperties: false
  }
};

app.post("/api/polaris/farm/mcp", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  const body = req.body || {};
  const id = body.id;
  const sendResult = result => reply.send({ jsonrpc: "2.0", id, result });
  const sendError = (code, message) => reply.send({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    if (body.method === "notifications/initialized") return reply.code(202).send();
    if (body.method === "initialize") {
      return sendResult({
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "endless-summer-farm", version: "1.0.0" }
      });
    }
    if (body.method === "ping") return sendResult({});
    if (body.method === "tools/list") return sendResult({ tools: [MANAGED_FARM_TOOL] });
    if (body.method === "tools/call") {
      if (body.params?.name !== MANAGED_FARM_TOOL.name) return sendError(-32602, "未知农场工具");
      const result = await runFarmAgent({
        instruction: body.params?.arguments?.instruction,
        context: body.params?.arguments?.context
      });
      return sendResult({
        content: [{ type: "text", text: result.content }],
        structuredContent: result,
        isError: false
      });
    }
    return sendError(-32601, "不支持的 MCP 方法");
  } catch (err) {
    req.log.error({
      err,
      event: "farm_agent_failed",
      errorCode: err?.code || err?.cause?.code,
      causeMessage: err?.cause?.message,
      rpcMethod: body.method,
      toolName: body.params?.name
    }, "farm agent execution failed");
    return sendResult({
      content: [{ type: "text", text: `农场代理执行失败：${err.message}` }],
      isError: true
    });
  }
});

app.delete("/api/polaris/farm/mcp", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  reply.code(200).send({ ok: true });
});

const MANAGED_SCHEDULED_MESSAGE_TOOL = {
  name: "scheduled_message",
  description: "管理一次性定时主动消息。你可以在用户明确要求时调用，也可以根据聊天自行决定设置；创建时要写给未来的自己一段提示词。到点后云端会使用主动消息模型线路结合最新聊天重新生成，并必定尝试 Bark。",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "list", "update", "cancel"], description: "创建、查询、修改或取消任务" },
      taskId: { type: "string", description: "修改或取消时使用的任务 ID" },
      runAt: { type: "string", description: "包含时区的绝对 ISO 日期时间，例如 2026-08-19T09:00:00+08:00" },
      prompt: { type: "string", description: "写给到点后的自己看的提示词，不是现在就写好的最终消息" }
    },
    required: ["action"],
    additionalProperties: false
  }
};

app.post("/api/polaris/scheduled-message/mcp", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  const body = req.body || {};
  const id = body.id;
  const sendResult = result => reply.send({ jsonrpc: "2.0", id, result });
  const sendError = (code, message) => reply.send({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    if (body.method === "notifications/initialized") return reply.code(202).send();
    if (body.method === "initialize") {
      return sendResult({
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "polaris-scheduled-message", version: "1.0.0" }
      });
    }
    if (body.method === "ping") return sendResult({});
    if (body.method === "tools/list") return sendResult({ tools: [MANAGED_SCHEDULED_MESSAGE_TOOL] });
    if (body.method === "tools/call") {
      if (body.params?.name !== MANAGED_SCHEDULED_MESSAGE_TOOL.name) {
        return sendError(-32602, "未知定时消息工具");
      }
      const result = executeScheduledMessageTool(body.params?.arguments);
      return sendResult({
        content: [{ type: "text", text: result.receipt || JSON.stringify(result) }],
        structuredContent: result,
        isError: false
      });
    }
    return sendError(-32601, "不支持的 MCP 方法");
  } catch (err) {
    req.log.error({ err, event: "scheduled_message_tool_failed" }, "scheduled message tool failed");
    return sendResult({
      content: [{ type: "text", text: `定时消息工具执行失败：${err.message}` }],
      isError: true
    });
  }
});

app.delete("/api/polaris/scheduled-message/mcp", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  reply.code(200).send({ ok: true });
});

app.get("/api/polaris/heartbeat/prompt", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    reply.send(loadHeartbeatPromptConfig());
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.put("/api/polaris/heartbeat/prompt", async (req, reply) => {
  if (!requireHeartbeatInboxToken(req, reply)) return;
  try {
    reply.send(saveHeartbeatPromptConfig(req.body || {}));
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

// ========================
// 读取 .env 值
// ========================
function readEnvValue(key) {
  // 批注 2026-07-30：Railway Variables 是云端部署的权威配置源；
  // 容器内 .env 只作兜底，避免管理页保存出的临时文件覆盖平台变量。
  if (IS_RAILWAY_RUNTIME && process.env[key]) return process.env[key];
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key + "=")) return trimmed.substring(key.length + 1).trim();
    }
  } catch {}
  return process.env[key] || "";
}

function readEnvValueOrDefault(key, fallback) {
  const value = readEnvValue(key);
  return value === "" ? fallback : value;
}

function normalizeBooleanString(value, key, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return "true";
  if (["false", "0", "no", "off"].includes(raw)) return "false";
  return readEnvValueOrDefault(key, fallback);
}

function normalizeWeatherUnits(value) {
  return String(value || "").trim().toLowerCase() === "fahrenheit" ? "fahrenheit" : "metric";
}

function diaryDirectoryPath() {
  const configured = readEnvValueOrDefault("DIARY_DIR", "diary");
  return runtimeDirectory(configured, "diary");
}

function readDiaryEntries(limit = 20) {
  const dir = diaryDirectoryPath();
  try {
    if (!fs.existsSync(dir)) return [];
    // 批注 2026-07-15：管理页只读展示 wake-up 生成的本地日记；
    // 只读取 DIARY_DIR 下的 .md 文件，避免把任意路径内容暴露到 admin 页面。
    return fs.readdirSync(dir)
      .filter(name => /^[^/\\]+\.md$/i.test(name))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit)
      .map(name => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8").slice(0, 24000);
        return { name, updated_at: stat.mtime.toISOString(), content };
      });
  } catch (err) {
    return [{ name: "读取日记失败", updated_at: new Date().toISOString(), content: err.message || String(err) }];
  }
}

// ========================
// HTTP Basic Auth
// ========================
function basicAuth(req, reply, done) {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
    return;
  }
  const decoded = Buffer.from(encoded, "base64").toString();
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);
  if (user === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
    done();
  } else {
    reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
  }
}

// ========================
// 管理页面 GET /admin
// ========================
app.get("/admin", { preHandler: basicAuth }, async (req, reply) => {
  const serverUptime = Math.floor(process.uptime());
  const wakeUpStatus = wakeUpLastHeartbeat
    ? `在线（上次心跳: ${formatDateTimeInTimeZone(new Date(wakeUpLastHeartbeat), TIME_ZONE)}）`
    : "离线或未启动";

  const currentUrl = readEnvValue("TARGET_API_URL");
  const currentModel = readEnvValue("MODEL_NAME");
  const currentIcon = readEnvValue("CUSTOM_ICON_URL");
  const gatewayKeyStatus = readEnvValue("GATEWAY_API_KEY") ? "已配置" : "未配置";
  const weatherConfig = {
    enabled: readEnvValueOrDefault("WEATHER_ENABLED", "false"),
    locationName: readEnvValue("WEATHER_LOCATION_NAME"),
    lat: readEnvValue("WEATHER_LAT"),
    lon: readEnvValue("WEATHER_LON"),
    units: readEnvValueOrDefault("WEATHER_UNITS", "metric")
  };
  const diaryEntries = readDiaryEntries(20);
  const diaryHtml = diaryEntries.length
    ? diaryEntries.map(entry => `
      <details class="diary-entry">
        <summary>
          <span>${escapeHtml(entry.name)}</span>
          <em>${escapeHtml(formatDateTimeInTimeZone(new Date(entry.updated_at), TIME_ZONE))}</em>
        </summary>
        <pre>${escapeHtml(entry.content)}</pre>
      </details>
    `).join("")
    : `<div class="diary-empty">还没有日记。模型在 wake-up 回复里输出 [DIARY]...[/DIARY] 后会保存到这里。</div>`;

  const authToken = Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`).toString("base64");
  const runtimeConfigNotice = IS_RAILWAY_RUNTIME
    ? `<div class="hint">Railway 检测到：此页面保存的是当前容器的 .env。Railway Variables 会优先提供运行时配置，且未挂载 Volume 的文件会在重新部署后丢失；主动联系节奏请在无尽夏中修改。</div>`
    : "";

  const presets = loadPresets();
  const presetsJson = safeJsonForInlineScript(presets);
  const authHeaderJson = safeJsonForInlineScript(`Basic ${authToken}`);

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HEARTBEAT · Runtime</title>
  <!-- 引入思源宋体 -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: "Noto Serif SC", Georgia, "Times New Roman", serif;
      background: linear-gradient(135deg, #f8f0f3 0%, #f5e6eb 100%);
      background-image: 
        radial-gradient(circle at 20% 80%, rgba(230, 190, 200, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(210, 170, 180, 0.1) 0%, transparent 50%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 30px 20px;
    }

    .container {
      max-width: 480px;
      width: 100%;
      background: rgba(255, 255, 255, 0.75);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 40px 32px;
      box-shadow: 
        0 2px 10px rgba(180, 120, 130, 0.05),
        0 15px 40px rgba(180, 120, 130, 0.15),
        0 0 0 1px rgba(255, 255, 255, 0.8) inset;
      transition: all 0.4s ease;
    }

    .container:hover {
      box-shadow: 
        0 2px 10px rgba(180, 120, 130, 0.08),
        0 20px 50px rgba(180, 120, 130, 0.2),
        0 0 0 1px rgba(255, 255, 255, 0.9) inset;
    }

    h2 {
      text-align: center;
      font-size: 32px;
      font-weight: 700;
      color: #8a4a58;
      margin-bottom: 4px;
      letter-spacing: 6px;
      font-family: "Times New Roman", "Georgia", "Noto Serif SC", serif;
      font-style: normal;
      text-transform: uppercase;
    }

    .subtitle {
      text-align: center;
      font-size: 12px;
      color: #a87a85;
      margin-bottom: 32px;
      letter-spacing: 4px;
      text-transform: uppercase;
      font-style: italic;
      opacity: 0.85;
    }

    .status {
      background: rgba(255, 250, 252, 0.6);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 14px;
      padding: 16px 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.4);
    }

    .status p {
      margin: 6px 0;
      font-size: 13px;
      color: #6d5057;
      font-weight: 400;
      line-height: 1.5;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .status strong {
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    label {
      display: block;
      margin-top: 16px;
      font-weight: 500;
      font-size: 11px;
      color: #8b6b72;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    input {
      width: 100%;
      padding: 10px 14px;
      margin-top: 6px;
      border: 1px solid rgba(200, 160, 170, 0.3);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      font-family: "Noto Serif SC", serif;
      font-size: 13px;
      color: #5a4046;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    input:focus {
      outline: none;
      border-color: #c89aa6;
      box-shadow: 0 0 0 3px rgba(200, 154, 166, 0.1);
      background: rgba(255, 255, 255, 0.95);
      transform: translateY(-1px);
    }

    input::placeholder {
      color: #b8a0a6;
      font-style: italic;
      font-size: 12px;
    }

    select {
      width: 100%;
      padding: 10px 14px;
      margin-top: 6px;
      border: 1px solid rgba(200, 160, 170, 0.3);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      font-family: "Noto Serif SC", serif;
      font-size: 13px;
      color: #5a4046;
    }

    button {
      width: 100%;
      margin-top: 16px;
      padding: 12px;
      border: none;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      letter-spacing: 1.5px;
      font-family: "Noto Serif SC", serif;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      text-transform: uppercase;
    }

    button.save {
      background: linear-gradient(135deg, #d8a0ad 0%, #c8909d 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(180, 120, 130, 0.2);
    }

    button.save:hover {
      background: linear-gradient(135deg, #c8909d 0%, #b8808d 100%);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(180, 120, 130, 0.3);
    }

    button.save:active {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(180, 120, 130, 0.2);
    }

    button.restart {
      background: linear-gradient(135deg, #e8909d 0%, #d8808d 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(200, 100, 120, 0.25);
      margin-top: 28px;
    }

    button.restart:hover {
      background: linear-gradient(135deg, #d8808d 0%, #c8707d 100%);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(200, 100, 120, 0.35);
    }

    button.restart:active {
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(200, 100, 120, 0.25);
    }

    .note {
      margin-top: 16px;
      font-size: 10px;
      color: #a88a92;
      text-align: center;
      font-style: italic;
      letter-spacing: 1px;
      opacity: 0.7;
    }

    /* 预设区域 */
    .presets-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .presets-box h3 {
      margin: 0 0 14px 0;
      font-size: 12px;
      color: #8a4a58;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .preset-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
    }

    .preset-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .preset-btn {
      flex: 1;
      padding: 10px 14px;
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      border: 1px solid rgba(220, 180, 190, 0.3);
      border-radius: 10px;
      text-align: left;
      font-size: 13px;
      color: #6d5057;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-family: "Noto Serif SC", serif;
    }

    .preset-btn:hover {
      background: rgba(255, 245, 248, 0.9);
      border-color: #c89aa6;
      box-shadow: 0 4px 12px rgba(180, 120, 130, 0.15);
      transform: translateY(-1px);
    }

    .preset-btn span {
      color: #9a7a82;
      font-size: 11px;
      margin-left: 8px;
      font-style: italic;
    }

    .preset-del {
      padding: 8px 12px;
      background: rgba(255, 240, 243, 0.6);
      border: 1px solid rgba(240, 200, 210, 0.4);
      border-radius: 8px;
      font-size: 11px;
      color: #a85a68;
      cursor: pointer;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .preset-del:hover {
      background: rgba(255, 230, 235, 0.8);
      border-color: #e8a0b0;
      color: #9a4a58;
    }

    .add-preset {
      border-top: 1px solid rgba(220, 180, 190, 0.3);
      padding-top: 16px;
    }

    .add-preset strong {
      font-size: 11px;
      color: #8a4a58;
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .add-preset input {
      margin-top: 6px;
      background: rgba(255, 255, 255, 0.8);
    }

    .add-preset button {
      background: linear-gradient(135deg, #c89aa6 0%, #b88a96 100%);
      color: white;
      box-shadow: 0 4px 10px rgba(160, 100, 110, 0.2);
      font-size: 12px;
      padding: 10px;
    }

    .add-preset button:hover {
      background: linear-gradient(135deg, #b88a96 0%, #a87a86 100%);
    }

    .config-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .diary-box {
      background: rgba(255, 250, 252, 0.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      border: 1px solid rgba(230, 200, 208, 0.3);
    }

    .diary-box h3 {
      margin: 0 0 12px 0;
      font-size: 12px;
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .diary-entry {
      border: 1px solid rgba(220, 180, 190, 0.3);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.58);
      margin-top: 10px;
      overflow: hidden;
    }

    .diary-entry summary {
      cursor: pointer;
      padding: 12px 14px;
      color: #6d5057;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }

    .diary-entry summary span {
      font-weight: 600;
    }

    .diary-entry summary em {
      color: #a88a92;
      font-style: normal;
      font-size: 10px;
      white-space: nowrap;
    }

    .diary-entry pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      padding: 0 14px 14px;
      color: #5a4046;
      font-family: "Noto Serif SC", Georgia, "Times New Roman", serif;
      font-size: 12px;
      line-height: 1.8;
      max-height: 360px;
      overflow: auto;
    }

    .diary-empty {
      color: #9a7a82;
      font-size: 12px;
      line-height: 1.7;
      background: rgba(255, 255, 255, 0.55);
      border-radius: 12px;
      padding: 12px 14px;
    }

    .section-title {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid rgba(220, 180, 190, 0.3);
      font-size: 12px;
      color: #8a4a58;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .hint {
      margin-top: 8px;
      font-size: 11px;
      color: #9a7a82;
      line-height: 1.6;
    }

    /* 加载动画 */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .container {
      animation: fadeIn 0.6s ease-out;
    }

    .status, .presets-box, .config-box {
      animation: fadeIn 0.8s ease-out;
    }

    .restart {
      animation: fadeIn 1s ease-out;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>HEARTBEAT</h2>
    <div class="subtitle">Runtime · AI Residency</div>

    <div class="status">
      <p>Gateway <strong>运行中 (${serverUptime}秒)</strong></p>
      <p>Auto Wakeup <strong>${wakeUpStatus}</strong></p>
    </div>
    ${runtimeConfigNotice}

    <div class="diary-box">
      <h3>Wake Diary</h3>
      ${diaryHtml}
    </div>

    <!-- 预设方案 -->
    <div class="presets-box">
      <h3>预设方案</h3>
      <div class="preset-list" id="presetList"></div>
      <div class="add-preset">
        <strong>保存当前配置为新预设</strong>
        <input id="presetName" placeholder="预设名称，例如：DeepSeek / Claude">
        <button onclick="savePreset()">保存为预设</button>
      </div>
    </div>

    <!-- 配置表单 -->
    <div class="config-box">
      <form id="configForm" onsubmit="saveConfig(event)">
        <label>API URL</label>
        <input name="target_url" id="f_url" value="${escapeHtml(currentUrl)}">
        <label>API Key</label>
        <input name="target_key" id="f_key" placeholder="留空不修改">
        <label>Gateway API Key</label>
        <input name="gateway_api_key" id="f_gateway_key" placeholder="公网 /v1 鉴权 key，留空不修改">
        <div class="hint">当前状态：${escapeHtml(gatewayKeyStatus)}。公开部署并开启 ALLOW_PUBLIC_API=true 时，Kelivo 的 API Key 请填写这个 Gateway API Key，不要填写上游 API Key。</div>
        <label>Model Name</label>
        <input name="model_name" id="f_model" value="${escapeHtml(currentModel)}">
        <label>Bark Key</label>
        <input name="bark_key" id="f_bark" placeholder="留空不修改">
        <label>Bark Icon URL</label>
        <input name="custom_icon" id="f_icon" value="${escapeHtml(currentIcon)}" placeholder="可选">

        <div class="section-title">Weather</div>
        <label>天气注入</label>
        <select name="weather_enabled" id="f_weather_enabled">
          <option value="false" ${weatherConfig.enabled === "true" ? "" : "selected"}>关闭</option>
          <option value="true" ${weatherConfig.enabled === "true" ? "selected" : ""}>开启</option>
        </select>
        <label>位置名称</label>
        <input name="weather_location_name" id="f_weather_location_name" value="${escapeHtml(weatherConfig.locationName)}" placeholder="例如：Beijing">
        <div class="grid-2">
          <div>
            <label>纬度 Latitude</label>
            <input name="weather_lat" id="f_weather_lat" value="${escapeHtml(weatherConfig.lat)}" placeholder="例如：39.9042">
          </div>
          <div>
            <label>经度 Longitude</label>
            <input name="weather_lon" id="f_weather_lon" value="${escapeHtml(weatherConfig.lon)}" placeholder="例如：116.4074">
          </div>
        </div>
        <label>单位</label>
        <select name="weather_units" id="f_weather_units">
          <option value="metric" ${weatherConfig.units === "fahrenheit" ? "" : "selected"}>摄氏度 / km/h</option>
          <option value="fahrenheit" ${weatherConfig.units === "fahrenheit" ? "selected" : ""}>华氏度 / mph</option>
        </select>
        <div class="hint">天气使用 Open-Meteo 免费接口，不需要 API Key；只有开启后才会按你填写的经纬度读取天气。</div>
        <button type="submit" class="save">保存配置</button>
      </form>
    </div>

    <button onclick="restartServices()" class="restart">重启 Gateway</button>
    <div class="note">这里只重启 Gateway，不会启动或重启 wake-up</div>
  </div>

  <script>
    // ====== 以下脚本保持不变 ======
    const AUTH_HEADER = ${authHeaderJson};
    let presets = ${presetsJson};

    function escapeHtmlText(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderPresets() {
      const list = document.getElementById("presetList");
      if (!presets.length) {
        list.innerHTML = '<div style="color:#aaa;font-size:12px;font-style:italic;">还没有预设，保存当前配置即可创建。</div>';
        return;
      }
      list.innerHTML = presets.map((p, idx) => {
        return '<div class="preset-item">' +
          '<button class="preset-btn" onclick="applyPreset(' + idx + ')">' + escapeHtmlText(p.name) + '<span>' + escapeHtmlText(p.model_name) + '</span></button>' +
          '<button class="preset-del" onclick="deletePreset(' + idx + ')">删除</button>' +
        '</div>';
      }).join("");
    }

    function applyPreset(idx) {
      const p = presets[idx];
      document.getElementById("f_url").value = p.target_url || "";
      document.getElementById("f_model").value = p.model_name || "";
      if (p.target_key) document.getElementById("f_key").value = p.target_key;
      document.querySelector(".config-box").scrollIntoView({ behavior: "smooth" });
    }

    async function saveConfig(event) {
      event.preventDefault();
      const payload = {
        target_url: document.getElementById("f_url").value.trim(),
        target_key: document.getElementById("f_key").value.trim(),
        gateway_api_key: document.getElementById("f_gateway_key").value.trim(),
        model_name: document.getElementById("f_model").value.trim(),
        bark_key: document.getElementById("f_bark").value.trim(),
        custom_icon: document.getElementById("f_icon").value.trim(),
        weather_enabled: document.getElementById("f_weather_enabled").value,
        weather_location_name: document.getElementById("f_weather_location_name").value.trim(),
        weather_lat: document.getElementById("f_weather_lat").value.trim(),
        weather_lon: document.getElementById("f_weather_lon").value.trim(),
        weather_units: document.getElementById("f_weather_units").value
      };

      if (!payload.target_url || !payload.model_name) {
        alert("请填写 API 地址和模型名称");
        return;
      }

      try {
        const resp = await fetch("/admin/save", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: JSON.stringify(payload)
        });
        const result = await resp.json();
        if (result.success) {
          document.getElementById("f_key").value = "";
          document.getElementById("f_gateway_key").value = "";
          document.getElementById("f_bark").value = "";
          alert("配置已保存，现在可以点击重启按钮让新配置生效。");
        } else {
          alert("保存失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }

    async function savePreset() {
      const name = document.getElementById("presetName").value.trim();
      const target_url = document.getElementById("f_url").value.trim();
      const target_key = document.getElementById("f_key").value.trim();
      const model_name = document.getElementById("f_model").value.trim();
      if (!name) { alert("请填写预设名称"); return; }
      if (!target_url || !model_name) { alert("请先填写 API 地址和模型名称"); return; }

      const resp = await fetch("/admin/presets/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
        body: JSON.stringify({ name, target_url, target_key, model_name })
      });
      const r = await resp.json();
      if (r.success) {
        const existing = presets.findIndex(p => p.name === name);
        const entry = { name, target_url, target_key, model_name };
        if (existing >= 0) presets[existing] = entry;
        else presets.push(entry);
        renderPresets();
        document.getElementById("presetName").value = "";
        alert("预设已保存：" + name);
      } else {
        alert("保存失败：" + (r.error || "未知错误"));
      }
    }

    async function deletePreset(idx) {
      const p = presets[idx];
      if (!confirm("删除预设「" + p.name + "」？")) return;
      await fetch("/admin/presets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
        body: JSON.stringify({ name: p.name })
      });
      presets.splice(idx, 1);
      renderPresets();
    }

    async function restartServices() {
      if (!confirm("确定只重启 Gateway 吗？wake-up 不会被改动。")) return;
      try {
        const resp = await fetch("/admin/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": AUTH_HEADER },
          body: "{}"
        });
        const result = await resp.json();
        if (result.success) {
          alert("重启成功！页面稍后自动刷新。");
          setTimeout(() => location.reload(), 3000);
        } else {
          alert("重启失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("请求失败：" + e.message);
      }
    }

    renderPresets();
  </script>
</body>
</html>`;

  reply.type("text/html").send(html);
});
// ========================
// 管理保存 POST /admin/save
// ========================
app.post("/admin/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const {
      target_url,
      target_key,
      gateway_api_key,
      model_name,
      bark_key,
      custom_icon,
      weather_enabled,
      weather_location_name,
      weather_lat,
      weather_lon,
      weather_units
    } = req.body || {};

    if (!target_url || !model_name) {
      return reply.code(400).send({ error: "target_url / model_name 必填" });
    }

    const finalTargetKey = target_key || readEnvValue("TARGET_API_KEY");
    const finalGatewayKey = gateway_api_key || readEnvValue("GATEWAY_API_KEY");
    const finalBarkKey = bark_key || readEnvValue("BARK_KEY");

    // 主动联系节奏由无尽夏中的云端策略统一管理；旧昼夜变量不再从管理页读写。
    // 批注 2026-07-15：GATEWAY_API_KEY 是公开 /v1 的客户端鉴权 key，不能和上游 TARGET_API_KEY 混在一起展示或返回。
    writeEnvUpdates({
      TARGET_API_URL: target_url,
      TARGET_API_KEY: finalTargetKey,
      GATEWAY_API_KEY: finalGatewayKey,
      MODEL_NAME: model_name,
      BARK_KEY: finalBarkKey,
      CUSTOM_ICON_URL: custom_icon || "",
      WEATHER_ENABLED: normalizeBooleanString(weather_enabled, "WEATHER_ENABLED", "false"),
      WEATHER_LOCATION_NAME: weather_location_name || "",
      WEATHER_LAT: weather_lat || "",
      WEATHER_LON: weather_lon || "",
      WEATHER_UNITS: normalizeWeatherUnits(weather_units),
      ADMIN_USER: readEnvValue("ADMIN_USER"),
      ADMIN_PASSWORD: readEnvValue("ADMIN_PASSWORD")
    });
    console.log("\n✅ .env 已更新，可通过管理页重启服务\n");

    if (wantsJsonResponse(req)) {
      return reply.send({ success: true });
    }

    reply.type("text/html").send(`<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>已保存</title></head>
<body style="text-align:center;font-family:-apple-system,sans-serif;padding:40px;">
  <h2>✅ 配置已保存</h2>
  <p>现在可以返回管理页，点击重启按钮让新配置生效。</p>
  <a href="/admin">← 返回设置</a>
</body></html>`);
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 保存预设方案
// ========================
app.post("/admin/presets/save", { preHandler: basicAuth }, async (req, reply) => {
  const { name, target_url, target_key, model_name } = req.body || {};
  if (!name || !target_url || !model_name) {
    return reply.code(400).send({ error: "name / target_url / model_name 必填" });
  }
  const presets = loadPresets();
  const existing = presets.findIndex(p => p.name === name);
  const entry = { name, target_url, target_key: target_key || "", model_name };
  if (existing >= 0) presets[existing] = entry;
  else presets.push(entry);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// 删除预设方案
// ========================
app.post("/admin/presets/delete", { preHandler: basicAuth }, async (req, reply) => {
  const { name } = req.body || {};
  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// 心跳接口
// ========================
app.post("/internal/heartbeat", async (req, reply) => {
  wakeUpLastHeartbeat = Date.now();
  reply.send({ status: "ok" });
});

// ========================
// 管理页一键重启
// ========================
app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  // 立即回复，避免重启时连接中断
  reply.send({ success: true, output: `重启指令已发送：${GATEWAY_RESTART_COMMAND}` });
  
  // 只重启 Gateway。wake-up 可能被用户有意停止，管理页不能改变它的状态。
  const { exec } = require("child_process");
  exec(GATEWAY_RESTART_COMMAND, (err, stdout, stderr) => {
    if (err) {
      console.error("重启失败:", stderr);
    } else {
      console.log("服务已重启:", stdout);
    }
  });
});

// ========================
// 启动服务
// ========================
if (require.main === module) {
  app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    // 只打印是否配置，不输出 URL、Key、用户名、聊天内容或 Volume 名称。
    console.log(JSON.stringify({
      event: "runtime_config_summary",
      railway: IS_RAILWAY_RUNTIME,
      persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
      target_url_configured: Boolean(TARGET_API_URL),
      target_key_configured: Boolean(process.env.TARGET_API_KEY),
      model_configured: Boolean(process.env.MODEL_NAME),
      gateway_key_configured: Boolean(readEnvValue("GATEWAY_API_KEY")),
      data_dir_ready: fs.existsSync(DATA_DIR)
    }));
    console.log(`✅ Gateway 运行在 ${address}`);
    let scheduledPassRunning = false;
    const runScheduledPass = async () => {
      if (scheduledPassRunning) return;
      scheduledPassRunning = true;
      try {
        await processDueScheduledMessages({ loadTimeline });
      } catch (error) {
        console.error("定时消息任务检查失败:", error.message);
      } finally {
        scheduledPassRunning = false;
      }
    };
    setTimeout(runScheduledPass, 1_000);
    setInterval(runScheduledPass, 10_000);
  });
}

module.exports = {
  app,
  appendAcknowledgedInboxMessages,
  buildTimeline,
  heartbeatInboxEventId,
  loadTimeline,
  saveHeartbeatContext,
  saveTimeline
};
