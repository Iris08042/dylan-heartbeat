const { buildNtfyPayload } = require("./ntfy_priority");

function readPushTimeoutMs() {
  const value = Number(process.env.PUSH_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : 15_000;
}

async function sendBarkNotification({ title, body }, fetchImpl = fetch) {
  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const response = await fetchImpl("https://api.day.app/push", {
    method: "POST",
    signal: AbortSignal.timeout(readPushTimeoutMs()),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      body,
      device_key: process.env.BARK_KEY,
      icon: process.env.CUSTOM_ICON_URL
    })
  });

  const responseText = await response.text();
  let result = {};
  try { result = JSON.parse(responseText); } catch {}
  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

async function sendPushNotification(payload, fetchImpl = fetch) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();
  if (provider === "bark") return sendBarkNotification(payload, fetchImpl);
  if (provider !== "ntfy") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  const topic = String(process.env.NTFY_TOPIC || "").trim();
  if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };
  const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  const response = await fetchImpl(server, {
    method: "POST",
    signal: AbortSignal.timeout(readPushTimeoutMs()),
    headers,
    body: JSON.stringify(buildNtfyPayload({
      topic,
      title: payload.title,
      message: payload.body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    }))
  });
  const responseText = await response.text();
  return response.ok
    ? { ok: true, providerLabel: "ntfy" }
    : { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
}

module.exports = { sendBarkNotification, sendPushNotification };
