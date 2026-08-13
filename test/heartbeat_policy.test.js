const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("heartbeat policy selects overrides and cross-midnight schedules", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-policy-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    const { activeProfile, defaultPolicy, normalizePolicy, savePolicy } = require("../heartbeat_policy");
    const policy = defaultPolicy();
    policy.schedules.push({
      id: "night",
      name: "夜间静默",
      enabled: true,
      type: "recurring",
      profileId: "silent",
      days: [1],
      start: "23:00",
      end: "07:00"
    });
    savePolicy(policy);
    assert.equal(activeProfile(policy, new Date("2026-08-10T16:30:00Z"), "Asia/Shanghai").profile.id, "silent");
    assert.equal(activeProfile(policy, new Date("2026-08-11T07:00:00Z"), "Asia/Shanghai").profile.id, "normal");

    policy.override = { profileId: "very-active", until: "2026-08-12T00:00:00.000Z" };
    assert.equal(activeProfile(normalizePolicy(policy), new Date("2026-08-11T16:00:00Z"), "Asia/Shanghai").source, "override");
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("heartbeat policy rejects overlapping recurring schedules", () => {
  const { defaultPolicy, normalizePolicy } = require("../heartbeat_policy");
  const policy = defaultPolicy();
  policy.schedules = [
    { id: "one", name: "one", enabled: true, type: "recurring", profileId: "low", days: [1], start: "09:00", end: "12:00" },
    { id: "two", name: "two", enabled: true, type: "recurring", profileId: "active", days: [1], start: "11:00", end: "13:00" }
  ];
  assert.throws(() => normalizePolicy(policy), /overlap/);
});

test("heartbeat eligibility enforces idle, cooldown and reconsider windows", () => {
  const { defaultPolicy, eligibility } = require("../heartbeat_policy");
  const policy = defaultPolicy();
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  assert.equal(eligibility({ now, lastUserAt: now - 30 * 60000, policy, state: {} }).reason, "user_idle");
  assert.equal(eligibility({ now, lastUserAt: now - 180 * 60000, policy, state: { lastSentAt: now - 30 * 60000 } }).reason, "send_cooldown");
  assert.equal(eligibility({ now, lastUserAt: now - 180 * 60000, policy, state: { lastDecisionAt: now - 5 * 60000, lastDecisionResult: "no_action" } }).reason, "reconsider");
  assert.equal(eligibility({ now, lastUserAt: now - 180 * 60000, policy, state: {} }).due, true);
});

test("heartbeat master switch stops wake eligibility", () => {
  const { defaultPolicy, eligibility, normalizePolicy } = require("../heartbeat_policy");
  const policy = defaultPolicy();
  policy.enabled = false;
  const normalized = normalizePolicy(policy);
  const result = eligibility({
    now: Date.parse("2026-08-11T12:00:00.000Z"),
    lastUserAt: Date.parse("2026-08-11T08:00:00.000Z"),
    policy: normalized,
    state: {}
  });
  assert.equal(result.due, false);
  assert.equal(result.reason, "disabled");
});
