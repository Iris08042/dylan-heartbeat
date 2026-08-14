function trimBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function readSetCookie(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  return values
    .map(value => String(value).split(";", 1)[0].trim())
    .filter(Boolean)
    .join("; ");
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function asNumber(...values) {
  const value = values.find(item => item !== undefined && item !== null && item !== "");
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asBoolean(value) {
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.toLowerCase());
  return Boolean(value);
}

function normalizeOmbreTimestamp(value) {
  if (!value) return null;
  const timestamp = String(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestamp)
    ? `${timestamp}Z`
    : timestamp;
}

function normalizeOmbreBucket(bucket = {}) {
  const metadata = bucket.meta || bucket.metadata || {};
  const content = String(bucket.content || bucket.text || bucket.body || "");
  const preview = String(bucket.content_preview || bucket.contentPreview || bucket.preview || content)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return {
    id: String(bucket.id || bucket.bucket_id || bucket.name || ""),
    name: String(bucket.name || bucket.title || metadata.name || bucket.id || "未命名记忆"),
    content,
    contentPreview: preview,
    type: String(bucket.type || metadata.type || "dynamic"),
    domains: asArray(bucket.domains || bucket.domain || metadata.domain),
    tags: asArray(bucket.tags || metadata.tags),
    importance: asNumber(bucket.importance, metadata.importance) ?? 5,
    valence: asNumber(bucket.valence, metadata.valence),
    arousal: asNumber(bucket.arousal, metadata.arousal),
    pinned: asBoolean(bucket.pinned ?? metadata.pinned),
    resolved: asBoolean(bucket.resolved ?? metadata.resolved),
    digested: asBoolean(bucket.digested ?? metadata.digested),
    protected: asBoolean(bucket.protected ?? metadata.protected),
    anchor: asBoolean(bucket.anchor ?? metadata.anchor),
    archived: asBoolean(bucket.archived ?? metadata.archived)
      || String(bucket.type || metadata.type || "").toLowerCase() === "archived"
      || Boolean(bucket.archived_at || metadata.archived_at),
    dontSurface: asBoolean(bucket.dont_surface ?? metadata.dont_surface),
    whyRemembered: String(bucket.why_remembered || metadata.why_remembered || ""),
    sourceTool: String(bucket.source_tool || metadata.source_tool || ""),
    activationCount: asNumber(bucket.activation_count, metadata.activation_count) ?? 0,
    createdAt: normalizeOmbreTimestamp(bucket.created_at || bucket.created || metadata.created),
    lastActiveAt: normalizeOmbreTimestamp(bucket.last_active_at || bucket.last_active || metadata.last_active
      || bucket.created_at || bucket.created || metadata.created)
  };
}

function createOmbreDashboardClient({
  baseUrl = process.env.OMBRE_DASHBOARD_URL,
  password = process.env.OMBRE_DASHBOARD_PASSWORD,
  timeoutMs = process.env.OMBRE_DASHBOARD_TIMEOUT_MS,
  fetchImpl = fetch
} = {}) {
  const dashboardUrl = trimBaseUrl(baseUrl);
  const dashboardPassword = String(password || "");
  const parsedTimeout = Number(timeoutMs);
  const requestTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 8000;
  let sessionCookie = "";
  let loginPromise = null;

  function configured() {
    return Boolean(dashboardUrl && dashboardPassword);
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function login() {
    if (!dashboardUrl) throw Object.assign(new Error("Ombre Dashboard URL is not configured"), { code: "OMBRE_NOT_CONFIGURED" });
    if (!dashboardPassword) throw Object.assign(new Error("Ombre Dashboard password is not configured"), { code: "OMBRE_AUTH_NOT_CONFIGURED" });
    const response = await fetchWithTimeout(`${dashboardUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: dashboardPassword })
    });
    if (!response.ok) throw Object.assign(new Error("Ombre Dashboard login failed"), { code: "OMBRE_AUTH_FAILED", status: response.status });
    sessionCookie = readSetCookie(response.headers);
    if (!sessionCookie) throw Object.assign(new Error("Ombre Dashboard did not return a session cookie"), { code: "OMBRE_AUTH_FAILED" });
    return sessionCookie;
  }

  async function ensureLoggedIn() {
    if (sessionCookie) return sessionCookie;
    if (!loginPromise) loginPromise = login().finally(() => { loginPromise = null; });
    return loginPromise;
  }

  async function request(path, options = {}, retried = false) {
    await ensureLoggedIn();
    const response = await fetchWithTimeout(`${dashboardUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.headers || {}),
        cookie: sessionCookie
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    if (response.status === 401 && !retried) {
      sessionCookie = "";
      return request(path, options, true);
    }
    if (!response.ok) {
      const error = new Error(`Ombre Dashboard returned HTTP ${response.status}`);
      error.code = response.status === 401 ? "OMBRE_AUTH_FAILED" : "OMBRE_UPSTREAM_ERROR";
      error.status = response.status;
      throw error;
    }
    return await response.json();
  }

  return { configured, request };
}

function mapOmbreDashboardError(error) {
  if (error?.code === "OMBRE_NOT_CONFIGURED" || error?.code === "OMBRE_AUTH_NOT_CONFIGURED") {
    return { status: 503, error: "ombre_not_configured", message: "Ombre Brain 尚未完成服务器连接配置" };
  }
  if (error?.code === "OMBRE_AUTH_FAILED") {
    return { status: 502, error: "ombre_auth_failed", message: "Ombre Brain 控制台认证失败" };
  }
  return { status: 503, error: "ombre_unavailable", message: "Ombre Brain 暂时没有回应" };
}

module.exports = {
  createOmbreDashboardClient,
  mapOmbreDashboardError,
  normalizeOmbreBucket
};
