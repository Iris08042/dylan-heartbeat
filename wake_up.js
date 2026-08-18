require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { eligibility, loadPolicy, savePolicyState } = require("./heartbeat_policy");
const { ensureDataDir, runtimeDirectory, runtimeFile } = require("./runtime_paths");
const { normalizeContentToText, requestHeartbeatModel } = require("./heartbeat_model_client");
const { sendPushNotification } = require("./push_notification");
const { messagesForWakeContext } = require("./special_events");
const { parseWakeDecision, thoughtInboxContent } = require("./wake_decision");
const { loadHeartbeatModelConfig } = require("./heartbeat_model_config");
const { loadFarmConfig } = require("./farm_config");
const { runFarmAgent } = require("./farm_agent");
const { loadHeartbeatPromptConfig } = require("./heartbeat_prompt_config");
const { listPendingInboxEvents } = require("./heartbeat_inbox");
const { buildUnreadInboxContext } = require("./heartbeat_inbox_context");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

// 批注 2026-08-10：与 Gateway 共用同一 DATA_DIR；未配置时仍落回项目目录，保护旧 VPS/本机部署。
const DATA_DIR = ensureDataDir();
const TIMELINE_PATH = runtimeFile("enhanced_messages.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = runtimeDirectory(DIARY_DIR_NAME, "diary");
function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 批注 2026-07-11：日记只接受模型显式输出的 [DIARY] 块，避免把普通推送内容误写进本地日记。
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("模型写了日记，但 DIARY_ENABLED=false，本次不保存");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`已保存日记：${diaryFile}`);
  return true;
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("天气注入失败，跳过本次天气信息:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function parseTimelineTimestamp(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const storedTimestamp = Number(msg.timestamp);
      if (Number.isFinite(storedTimestamp) && storedTimestamp > 0) return new Date(storedTimestamp);
      const content = normalizeContentToText(msg.content);
      // 批注 2026-07-15：兼容 Kelivo 时间前缀 "YYYY-MM-DDHH:mm"；
      // 旧的 "YYYY-MM-DD HH:mm" 仍然可用，避免无空格时间导致 wake-up 误判没有用户时间。
      const parsed = parseTimelineTimestamp(content);
      if (parsed) return parsed;
    }
  }
  return null;
}

function stripPosition(messages) {
  return messages.map(({
    position,
    heartbeatInboxContent,
    heartbeatInboxCreatedAt,
    heartbeatInboxId,
    heartbeatInboxKind,
    heartbeatInboxPending,
    heartbeatThought,
    heartbeatThoughtAcknowledgedAt,
    heartbeatThoughtCreatedAt,
    ...rest
  }) => rest);
}

function userMessageSnapshot(messages) {
  const latest = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find(message => message?.role === "user");
  if (!latest) return "";
  return JSON.stringify({
    id: latest.id || null,
    position: latest.position ?? null,
    content: normalizeContentToText(latest.content)
  });
}

async function enqueueWakeInboxEvent(content, kind) {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inboxContent: content, inboxKind: kind })
  });
  if (!response.ok) throw new Error(`Gateway 返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.inboxEventId) throw new Error("Gateway 未返回收件箱事件 ID");
  return payload.inboxEventId;
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "") {
  const prompt = loadHeartbeatPromptConfig().prompt;

  const resolvedPrompt = prompt
    .replace(/\$\{currentTime\}/g, currentTime)
    .replace(/\$\{diffMinutes\}/g, diffMinutes)
    .replace(/\$\{weatherContext\}/g, weatherContext)
    .replace(/\$\{weather\}/g, weatherContext);

  return `${resolvedPrompt.trim()}

## 系统投递格式（最高优先级）
- 每次都要留下真实内容，并严格选择以下一种格式。
- 如果想联系用户，直接写你想说的话。系统会同时发送手机推送，并在用户打开聊天后写入同一条对话。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果此刻不想打扰用户，第一行输出：[NO_ACTION]，后面写一至三句自然、具体的第一人称心理活动。心理活动不会触发手机推送，但会在用户下次打开聊天时进入同一条对话。不能只写标签或简短理由。
- 不联系时必须承接系统列出的此前心理活动，只写新的变化、新观察或新决定；不得复述、改写或换词重演已有内容。
- 如果你想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
`;
}

const WAKE_FARM_TOOL = {
  type: "function",
  function: {
    name: "farm_agent",
    description: "让独立的农场代理查看或经营我们的农场。仅在你自主醒来并确实想做农场活动时调用；农场代理会使用另一套专用模型。",
    parameters: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "你想让农场代理完成的具体任务" },
        context: { type: "string", description: "可选的动机、偏好或限制" }
      },
      required: ["instruction"],
      additionalProperties: false
    }
  }
};

async function requestWakeDecision(heartbeatModel, wakeMessages) {
  let farmConfig;
  try { farmConfig = loadFarmConfig(); } catch (error) {
    console.warn(`农场配置不可用，本次唤醒不加载农场：${error.message}`);
  }
  const farmAvailable = Boolean(
    farmConfig?.autonomousEnabled && farmConfig.agentKey
    && farmConfig.baseUrl && farmConfig.apiKey && farmConfig.model
  );
  const tools = farmAvailable ? [WAKE_FARM_TOOL] : [];
  const messages = wakeMessages.map(message => ({ ...message }));

  for (let round = 0; round < 3; round += 1) {
    const message = await requestHeartbeatModel(heartbeatModel, messages, tools);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push({
      role: "assistant",
      content: message.content ?? "",
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });
    if (!toolCalls.length) return normalizeContentToText(message.content).trim();

    for (const call of toolCalls) {
      let resultText;
      if (call?.function?.name !== "farm_agent") {
        resultText = "该后台工具不存在。";
      } else {
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          const result = await runFarmAgent({
            instruction: args.instruction,
            context: args.context,
            config: farmConfig
          });
          resultText = JSON.stringify(result);
        } catch (error) {
          resultText = `农场代理执行失败：${error.message}`;
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }
  throw new Error("主动消息模型连续调用农场工具次数过多，已停止本次唤醒");
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  const policyDecision = eligibility({
    now: now.getTime(),
    lastUserAt: lastUserTime.getTime(),
    timeZone: TIME_ZONE
  });
  if (!policyDecision.due) {
    const profileName = policyDecision.profile?.name || "未知档位";
    const waitText = policyDecision.waitMinutes == null
      ? ""
      : `，约 ${policyDecision.waitMinutes} 分钟后复查`;
    console.log(`\n暂不需要唤醒（${profileName}｜${policyDecision.reason}${waitText}）\n`);
    return;
  }
  console.log(`\n策略允许唤醒（${policyDecision.profile.name}｜${policyDecision.source}）\n`);

  const weatherContext = await fetchWeatherContext();
  const pendingInbox = listPendingInboxEvents();
  const pendingInboxContext = buildUnreadInboxContext(
    pendingInbox,
    date => formatDateTimeInTimeZone(date, TIME_ZONE)
  );
  const contactPermissionContext = policyDecision.allowContact === false
    ? "当前允许主动联系：false（免打扰）。你仍可以照常思考、写日记和调用后台工具，但不能主动联系用户，也不能输出准备发给用户的话。"
    : "当前允许主动联系：true（可打扰）。你可以照常自主判断是否联系用户。";
  const wakePrompt = [
    buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext),
    pendingInboxContext,
    contactPermissionContext
  ].filter(Boolean).join("\n\n");
  const wakeContextMessages = messagesForWakeContext(messages);
  const recentMessages = wakeContextMessages
    .filter(msg => msg.role === "user" || msg.role === "assistant")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    })
    .slice(-50);
  const historyText = stripPosition(recentMessages)
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
      const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const baseSystemPrompt = wakeContextMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      // 批注 2026-07-15：Claude/部分 New API 适配器会把 system 抽成独立字段；
      // 唤醒请求如果全是 system，上游 messages 会变空，因此最近记录必须作为 user 任务输入发送。
      role: "user",
      content: `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}`
    }
  ];

  // 批注 2026-07-15：wake-up prompt 会包含最近聊天记录；
  // 默认日志只写摘要，避免公开部署时把完整上下文刷进 pm2 日志。
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  const heartbeatModel = loadHeartbeatModelConfig();
  if (!heartbeatModel.apiUrl || !heartbeatModel.apiKey || !heartbeatModel.model) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  console.log("\nWake Result Summary:\n");
  const rawAiText = await requestWakeDecision(heartbeatModel, wakeMessages);
  const diaryResult = extractDiaryFromResponse(rawAiText);
  const wakeDecision = parseWakeDecision(diaryResult.remainingText);

  const latestMessages = loadTimelineMessages();
  const latestLastUserTime = latestMessages ? getLastUserTime(latestMessages) : null;
  const latestPolicyDecision = latestLastUserTime
    ? eligibility({
        now: Date.now(),
        lastUserAt: latestLastUserTime.getTime(),
        policy: loadPolicy(),
        timeZone: TIME_ZONE
      })
    : { due: false };
  if (!latestMessages
    || userMessageSnapshot(latestMessages) !== userMessageSnapshot(messages)
    || !latestPolicyDecision.due) {
    console.log("主动联系条件已变化，丢弃本次进行中的模型结果");
    return;
  }

  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  if (!diaryResult.remainingText) {
    console.log(diarySaved ? "模型本次只写了日记" : "模型本次返回空内容");
    savePolicyState({ lastDecisionAt: Date.now(), lastDecisionResult: "no_action" });
    return;
  }

  if (wakeDecision.type === "contact" && !contactAllowedForWake(policyDecision, latestPolicyDecision)) {
    console.log("当前为免打扰状态，已拦截模型返回的主动联系；未写入收件箱或发送推送");
    savePolicyState({ lastDecisionAt: Date.now(), lastDecisionResult: "no_action" });
    return;
  }

  let inboxContent;
  let pushPayload = null;
  if (wakeDecision.type === "thought") {
    console.log("\nAI 选择不发送推送，心理活动将进入收件箱\n");
    inboxContent = thoughtInboxContent(wakeDecision.content);
  } else {
    console.log("\nAI 选择发送推送\n");
    let barkText = wakeDecision.content;

    // 如果 AI 还是写了 [BARK] ... [/BARK] 标签，就剥掉
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // 清洗“标题：”、“正文：”前缀（如果有）
    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    // 按行处理
    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    let title;
    let body;
    if (lines.length === 0) {
      console.log("\n推送内容清洗后为空，本次不写入收件箱\n");
      savePolicyState({ lastDecisionAt: Date.now(), lastDecisionResult: "no_action" });
      return;
    } else if (lines.length === 1) {
      title = "来自AI";
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      // ≥3 行：第一行标题，剩余用空格拼接成正文
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    inboxContent = barkText;
    const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
    let safeTitle = process.env.BARK_TITLE || title || "来自伴侣";
    if (/^\d/.test(safeTitle)) safeTitle = "来自伴侣｜" + safeTitle;
    pushPayload = { title: safeTitle, body: safeBody };
  }

  try {
    const inboxEventId = await enqueueWakeInboxEvent(inboxContent, wakeDecision.type);
    console.log(JSON.stringify({ event: "heartbeat_inbox_persisted", inbox_event_id: inboxEventId, kind: wakeDecision.type }));
  } catch (err) {
    console.error("\n写入心跳收件箱失败，本次不发送手机推送：\n", err.message);
    return;
  }

  const decidedAt = Date.now();
  const decisionResult = wakeDecision.type === "contact" ? "sent" : "no_action";
  try {
    savePolicyState({
      lastDecisionAt: decidedAt,
      lastDecisionResult: decisionResult,
      ...(decisionResult === "sent" ? { lastSentAt: decidedAt } : {})
    });
  } catch (err) {
    console.error("\n保存心跳策略状态失败:\n", err.message);
  }

  if (pushPayload) {
    try {
      const pushResult = await sendPushNotification(pushPayload);
      if (pushResult.ok) {
        console.log(`\n${pushResult.providerLabel} 推送成功；正文已在此前写入收件箱\n`);
      } else {
        console.error(`\n${pushResult.providerLabel} 推送失败；正文仍保留在收件箱：${pushResult.reason}\n`);
      }
    } catch (err) {
      console.error(`\n手机推送请求失败；正文仍保留在收件箱：${err.message}\n`);
    }
  }
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  return 60 * 1000;
}

function contactAllowedForWake(initialDecision, latestDecision) {
  return initialDecision?.allowContact !== false && latestDecision?.allowContact !== false;
}

async function scheduleNextCheck() {
  try {
    // 发送心跳
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

if (require.main === module) {
  // 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
  // 启动第一次检查（延迟10秒）
  setTimeout(scheduleNextCheck, 10_000);

  console.log("\n==================================");
  console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
  console.log(JSON.stringify({
    event: "wake_runtime_config_summary",
    railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
    persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
    target_url_configured: Boolean(process.env.TARGET_API_URL),
    target_key_configured: Boolean(process.env.TARGET_API_KEY),
    model_configured: Boolean(process.env.MODEL_NAME),
    push_provider_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC),
    data_dir_ready: fs.existsSync(DATA_DIR)
  }));
  console.log("==================================\n");
}

module.exports = { contactAllowedForWake, getLastUserTime, requestWakeDecision, userMessageSnapshot };
