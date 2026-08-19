const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const METRICS = {
  step_count: "步数",
  heart_rate: "心率",
  heart_rate_variability: "心率变异性",
  resting_heart_rate: "静息心率",
  walking_heart_rate_average: "步行平均心率",
  sleep_analysis: "睡眠"
};

const HEALTH_UPLOAD_CURRENT_MS = 15 * 60 * 1000;
const HEALTH_NOW_DESCRIPTION = "读取用户本人近期健康数据。聊到用户的睡眠、疲倦、压力、恢复、心率、HRV 或活动量时，可优先查看一次辅助判断，但不必机械调用。";

function healthFile() {
  return runtimeFile("health_data.json");
}

function emptyStore() {
  return { updatedAt: null, metrics: {} };
}

function readHealthStore() {
  const file = healthFile();
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && parsed.metrics && typeof parsed.metrics === "object"
      ? parsed
      : emptyStore();
  } catch {
    return emptyStore();
  }
}

function metricPayload(payload) {
  if (Array.isArray(payload?.data?.metrics)) return payload.data.metrics;
  if (Array.isArray(payload?.metrics)) return payload.metrics;
  throw new Error("HAE payload must contain data.metrics");
}

function pointKey(point) {
  if (point.startDate || point.endDate) {
    return `${point.startDate || ""}|${point.endDate || ""}|${point.value || ""}`;
  }
  if (point.date) return String(point.date);
  return JSON.stringify(point);
}

function ingestHealthPayload(payload, receivedAt = Date.now()) {
  const store = readHealthStore();
  const acceptedMetrics = [];
  let acceptedPoints = 0;

  for (const metric of metricPayload(payload)) {
    const name = String(metric?.name || "").trim();
    if (!Object.prototype.hasOwnProperty.call(METRICS, name) || !Array.isArray(metric.data)) continue;

    const existing = store.metrics[name]?.data || [];
    const points = new Map(existing.map(point => [pointKey(point), point]));
    for (const point of metric.data) {
      if (!point || typeof point !== "object" || Array.isArray(point)) continue;
      points.set(pointKey(point), { ...point, _receivedAt: receivedAt });
      acceptedPoints += 1;
    }
    store.metrics[name] = {
      units: String(metric.units || store.metrics[name]?.units || ""),
      data: [...points.values()]
    };
    acceptedMetrics.push(name);
  }

  if (!acceptedMetrics.length) throw new Error("HAE payload does not contain a selected health metric");
  store.updatedAt = receivedAt;
  writeJsonAtomicSync(healthFile(), store);
  return { receivedAt, acceptedMetrics, acceptedPoints };
}

function parseHealthDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})\s*([+-])(\d{2})(\d{2}))?$/);
  if (!match) return Number.NEGATIVE_INFINITY;
  const [, year, month, day, hour = "00", minute = "00", second = "00", sign, offsetHour = "00", offsetMinute = "00"] = match;
  const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * (sign === "-" ? -1 : 1);
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - offset * 60_000;
}

function sampleAt(point) {
  return point.sleepEnd || point.endDate || point.date || point.startDate || null;
}

function latestPoint(name, data) {
  const points = name === "sleep_analysis"
    ? data.filter(point => point.totalSleep != null || point.asleep != null)
    : data;
  const candidates = points.length ? points : data;
  return candidates.reduce((latest, point) => {
    if (!latest) return point;
    return parseHealthDate(sampleAt(point)) >= parseHealthDate(sampleAt(latest)) ? point : latest;
  }, null);
}

function publicPoint(point) {
  if (!point) return null;
  const { _receivedAt, ...value } = point;
  return value;
}

function getHealthNow(now = Date.now()) {
  const store = readHealthStore();
  const metrics = {};
  for (const [name, label] of Object.entries(METRICS)) {
    const stored = store.metrics[name];
    const point = latestPoint(name, stored?.data || []);
    metrics[name] = point ? {
      label,
      units: stored.units,
      sampleAt: sampleAt(point),
      receivedAt: point._receivedAt || store.updatedAt,
      value: publicPoint(point)
    } : { label, available: false };
  }
  const uploadAgeMs = store.updatedAt == null ? null : Math.max(0, now - store.updatedAt);
  const freshness = uploadAgeMs == null
    ? "missing"
    : uploadAgeMs <= HEALTH_UPLOAD_CURRENT_MS ? "current" : "old";
  const snapshot = {
    queriedAt: now,
    lastUploadAt: store.updatedAt,
    uploadAgeMinutes: uploadAgeMs == null ? null : Math.floor(uploadAgeMs / 60_000),
    freshness,
    metrics
  };
  return { ...snapshot, text: formatHealthNow(snapshot) };
}

function metricValue(name, metric) {
  const point = metric.value || {};
  const unit = metric.units ? ` ${metric.units}` : "";
  if (name === "heart_rate" && point.Avg != null) {
    return `平均 ${point.Avg}${unit}（最低 ${point.Min}${unit}，最高 ${point.Max}${unit}）`;
  }
  if (name === "sleep_analysis") {
    const total = point.totalSleep ?? point.asleep;
    if (total != null) {
      const stages = [
        point.core != null ? `核心 ${point.core} 小时` : "",
        point.deep != null ? `深睡 ${point.deep} 小时` : "",
        point.rem != null ? `REM ${point.rem} 小时` : ""
      ].filter(Boolean).join("，");
      return `${total} 小时${stages ? `（${stages}）` : ""}`;
    }
  }
  if (point.qty != null) return `${point.qty}${unit}`;
  if (point.value != null) return `${point.value}${unit}`;
  return JSON.stringify(point);
}

function formatHealthNow(snapshot) {
  const lines = ["Apple Health 最近数据（服务器缓存，不是现场测量）："];
  if (snapshot.freshness === "missing") {
    lines.push("同步状态：尚未收到 HAE 上传。");
  } else if (snapshot.freshness === "old") {
    lines.push(`同步状态：旧数据；HAE 最后于 ${new Date(snapshot.lastUploadAt).toISOString()} 同步（距今 ${snapshot.uploadAgeMinutes} 分钟）。以下数据仍可读取，但必须明确称为旧数据。`);
  } else {
    lines.push(`同步状态：当前数据；HAE 于 ${new Date(snapshot.lastUploadAt).toISOString()} 同步（距今 ${snapshot.uploadAgeMinutes} 分钟）。各指标仍须以各自采样时间为准。`);
  }
  for (const [name, metric] of Object.entries(snapshot.metrics)) {
    if (metric.available === false) {
      lines.push(`- ${metric.label}：暂无数据`);
      continue;
    }
    const source = metric.value?.source ? `，来源 ${metric.value.source}` : "";
    lines.push(`- ${metric.label}：${metricValue(name, metric)}；采样 ${metric.sampleAt || "时间未知"}，上传 ${new Date(metric.receivedAt).toISOString()}${source}`);
  }
  return lines.join("\n");
}

module.exports = {
  HEALTH_NOW_DESCRIPTION,
  METRICS,
  getHealthNow,
  ingestHealthPayload,
  parseHealthDate,
  readHealthStore
};
