const fs = require("fs");
const crypto = require("crypto");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");
const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");

const POLICY_VERSION = 2;
const MAX_MINUTES = 7 * 24 * 60;

const DEFAULT_PROFILES = [
  { id: "silent", name: "完全静默", silent: true, builtin: true },
  { id: "low", name: "低频", userIdleMinutes: 120, sendCooldownMinutes: 240, reconsiderMinutes: 30, builtin: true },
  { id: "normal", name: "正常", userIdleMinutes: 60, sendCooldownMinutes: 120, reconsiderMinutes: 20, builtin: true },
  { id: "active", name: "活跃", userIdleMinutes: 30, sendCooldownMinutes: 60, reconsiderMinutes: 10, builtin: true },
  { id: "very-active", name: "超高频", userIdleMinutes: 15, sendCooldownMinutes: 30, reconsiderMinutes: 5, builtin: true }
];

function policyFile() {
  return runtimeFile("heartbeat_policy.json");
}

function stateFile() {
  return runtimeFile("heartbeat_policy_state.json");
}

function defaultPolicy() {
  return {
    version: POLICY_VERSION,
    enabled: true,
    defaultProfileId: "normal",
    defaultAllowContact: true,
    profiles: DEFAULT_PROFILES.map(profile => ({ ...profile })),
    schedules: [],
    override: null
  };
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function positiveMinutes(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_MINUTES) {
    throw new Error(`${field} must be an integer between 1 and ${MAX_MINUTES}`);
  }
  return number;
}

function cleanName(value, field = "name") {
  const name = String(value || "").trim();
  if (!name || name.length > 40) throw new Error(`${field} must contain 1 to 40 characters`);
  return name;
}

function normalizeProfile(raw, existingBuiltinIds) {
  const id = String(raw?.id || crypto.randomUUID()).trim();
  if (!id) throw new Error("profile id is required");
  const builtin = existingBuiltinIds.has(id);
  if (id === "silent") {
    return { id, name: cleanName(raw?.name), silent: true, builtin: true };
  }
  return {
    id,
    name: cleanName(raw?.name),
    userIdleMinutes: positiveMinutes(raw?.userIdleMinutes, "userIdleMinutes"),
    sendCooldownMinutes: positiveMinutes(raw?.sendCooldownMinutes, "sendCooldownMinutes"),
    reconsiderMinutes: positiveMinutes(raw?.reconsiderMinutes, "reconsiderMinutes"),
    builtin
  };
}

function parseClock(value, field) {
  const match = String(value || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`${field} must use HH:mm`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseInstant(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date-time`);
  return date.toISOString();
}

function recurringSegments(schedule) {
  const start = parseClock(schedule.start, "start");
  const end = parseClock(schedule.end, "end");
  if (start === end) throw new Error("recurring schedule start and end cannot be equal");
  const segments = [];
  for (const day of schedule.days) {
    if (end > start) {
      segments.push({ day, start, end });
    } else {
      segments.push({ day, start, end: 1440 });
      segments.push({ day: day === 7 ? 1 : day + 1, start: 0, end });
    }
  }
  return segments;
}

function normalizeSchedule(raw, profileIds) {
  const type = raw?.type === "once" ? "once" : "recurring";
  const profileId = String(raw?.profileId || "").trim();
  if (!profileIds.has(profileId)) throw new Error("schedule profileId does not exist");
  const base = {
    id: String(raw?.id || crypto.randomUUID()).trim(),
    name: cleanName(raw?.name),
    enabled: raw?.enabled !== false,
    type,
    profileId,
    allowContact: raw?.allowContact !== false
  };
  if (type === "once") {
    const startAt = parseInstant(raw?.startAt, "startAt");
    const endAt = parseInstant(raw?.endAt, "endAt");
    if (new Date(endAt) <= new Date(startAt)) throw new Error("once schedule endAt must be after startAt");
    return { ...base, startAt, endAt };
  }
  const days = [...new Set((Array.isArray(raw?.days) ? raw.days : []).map(Number))].sort();
  if (days.length === 0 || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error("recurring schedule days must contain values from 1 to 7");
  }
  parseClock(raw?.start, "start");
  parseClock(raw?.end, "end");
  return { ...base, days, start: raw.start, end: raw.end };
}

function rejectRecurringOverlaps(schedules) {
  const active = schedules.filter(schedule => schedule.enabled && schedule.type === "recurring");
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    const leftSegments = recurringSegments(active[leftIndex]);
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const rightSegments = recurringSegments(active[rightIndex]);
      const overlaps = leftSegments.some(left => rightSegments.some(right => (
        left.day === right.day && left.start < right.end && right.start < left.end
      )));
      if (overlaps) throw new Error(`recurring schedules overlap: ${active[leftIndex].name} / ${active[rightIndex].name}`);
    }
  }
}

function normalizePolicy(raw) {
  const builtinIds = new Set(DEFAULT_PROFILES.map(profile => profile.id));
  const incomingProfiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const incomingById = new Map(incomingProfiles.map(profile => [String(profile?.id || ""), profile]));
  const profiles = DEFAULT_PROFILES.map(fallback => normalizeProfile(incomingById.get(fallback.id) || fallback, builtinIds));
  for (const profile of incomingProfiles) {
    if (!builtinIds.has(String(profile?.id || ""))) profiles.push(normalizeProfile(profile, builtinIds));
  }
  const profileIds = new Set(profiles.map(profile => profile.id));
  if (profileIds.size !== profiles.length) throw new Error("profile ids must be unique");
  const defaultProfileId = String(raw?.defaultProfileId || "normal");
  if (!profileIds.has(defaultProfileId)) throw new Error("defaultProfileId does not exist");
  const schedules = (Array.isArray(raw?.schedules) ? raw.schedules : []).map(schedule => normalizeSchedule(schedule, profileIds));
  if (new Set(schedules.map(schedule => schedule.id)).size !== schedules.length) throw new Error("schedule ids must be unique");
  rejectRecurringOverlaps(schedules);

  let override = null;
  if (raw?.override) {
    const profileId = String(raw.override.profileId || "");
    if (!profileIds.has(profileId)) throw new Error("override profileId does not exist");
    override = {
      profileId,
      allowContact: raw.override.allowContact !== false,
      until: raw.override.until ? parseInstant(raw.override.until, "override.until") : null
    };
  }
  return {
    version: POLICY_VERSION,
    enabled: raw?.enabled !== false,
    defaultProfileId,
    defaultAllowContact: raw?.defaultAllowContact !== false,
    profiles,
    schedules,
    override
  };
}

function loadPolicy() {
  try {
    return normalizePolicy(readJson(policyFile(), defaultPolicy()));
  } catch (error) {
    console.error("Invalid heartbeat policy, using defaults:", error.message);
    return defaultPolicy();
  }
}

function savePolicy(raw) {
  const policy = normalizePolicy(raw);
  writeJsonAtomicSync(policyFile(), policy);
  return policy;
}

function weekdayFromParts(parts) {
  const utcDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

function recurringMatches(schedule, now, timeZone) {
  const parts = getDatePartsInTimeZone(now, timeZone);
  const day = weekdayFromParts(parts);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return recurringSegments(schedule).some(segment => segment.day === day && minute >= segment.start && minute < segment.end);
}

function activeProfile(policy = loadPolicy(), now = new Date(), timeZone = resolveTimeZone()) {
  const profiles = new Map(policy.profiles.map(profile => [profile.id, profile]));
  if (policy.override && (!policy.override.until || new Date(policy.override.until) > now)) {
    return { profile: profiles.get(policy.override.profileId), allowContact: policy.override.allowContact !== false, source: "override", schedule: null };
  }
  const oneTime = policy.schedules.find(schedule => schedule.enabled && schedule.type === "once" && new Date(schedule.startAt) <= now && now < new Date(schedule.endAt));
  if (oneTime) return { profile: profiles.get(oneTime.profileId), allowContact: oneTime.allowContact !== false, source: "once", schedule: oneTime };
  const recurring = policy.schedules.find(schedule => schedule.enabled && schedule.type === "recurring" && recurringMatches(schedule, now, timeZone));
  if (recurring) return { profile: profiles.get(recurring.profileId), allowContact: recurring.allowContact !== false, source: "recurring", schedule: recurring };
  return { profile: profiles.get(policy.defaultProfileId), allowContact: policy.defaultAllowContact !== false, source: "default", schedule: null };
}

function loadPolicyState() {
  const state = readJson(stateFile(), {});
  return {
    lastDecisionAt: Number(state.lastDecisionAt) || null,
    lastDecisionResult: ["sent", "no_action"].includes(state.lastDecisionResult) ? state.lastDecisionResult : null,
    lastSentAt: Number(state.lastSentAt) || null
  };
}

function savePolicyState(next) {
  const state = { ...loadPolicyState(), ...next };
  writeJsonAtomicSync(stateFile(), state);
  return state;
}

function eligibility({ now = Date.now(), lastUserAt, policy = loadPolicy(), state = loadPolicyState(), timeZone = resolveTimeZone() } = {}) {
  const active = activeProfile(policy, new Date(now), timeZone);
  if (!policy.enabled) return { due: false, reason: "disabled", waitMinutes: null, ...active };
  if (!active.profile || active.profile.silent) return { due: false, reason: "silent", waitMinutes: null, ...active };
  const userAt = Number(lastUserAt);
  if (!Number.isFinite(userAt)) return { due: false, reason: "missing_user_time", waitMinutes: null, ...active };

  const thresholds = [{ reason: "user_idle", at: userAt + active.profile.userIdleMinutes * 60000 }];
  if (state.lastSentAt && state.lastSentAt > userAt) {
    thresholds.push({ reason: "send_cooldown", at: state.lastSentAt + active.profile.sendCooldownMinutes * 60000 });
  }
  const latestActivity = Math.max(userAt, state.lastSentAt || 0);
  if (state.lastDecisionResult === "no_action" && state.lastDecisionAt > latestActivity) {
    thresholds.push({ reason: "reconsider", at: state.lastDecisionAt + active.profile.reconsiderMinutes * 60000 });
  }
  const pending = thresholds.filter(threshold => threshold.at > now).sort((left, right) => right.at - left.at)[0];
  if (pending) return { due: false, reason: pending.reason, waitMinutes: Math.ceil((pending.at - now) / 60000), ...active };
  return { due: true, reason: "due", waitMinutes: 0, ...active };
}

module.exports = {
  activeProfile,
  defaultPolicy,
  eligibility,
  loadPolicy,
  loadPolicyState,
  normalizePolicy,
  savePolicy,
  savePolicyState
};
