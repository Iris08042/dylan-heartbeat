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
    policy.defaultAllowContact = false;
    policy.schedules.push({
      id: "night",
      name: "夜间静默",
      enabled: true,
      type: "recurring",
      profileId: "silent",
      allowContact: false,
      days: [1],
      start: "23:00",
      end: "07:00"
    });
    savePolicy(policy);
    const scheduled = activeProfile(policy, new Date("2026-08-10T16:30:00Z"), "Asia/Shanghai");
    assert.equal(scheduled.profile.id, "silent");
    assert.equal(scheduled.allowContact, false);
    const defaulted = activeProfile(policy, new Date("2026-08-11T07:00:00Z"), "Asia/Shanghai");
    assert.equal(defaulted.profile.id, "normal");
    assert.equal(defaulted.allowContact, false);

    policy.override = { profileId: "very-active", allowContact: false, until: "2026-08-12T00:00:00.000Z" };
    const overridden = activeProfile(normalizePolicy(policy), new Date("2026-08-11T16:00:00Z"), "Asia/Shanghai");
    assert.equal(overridden.source, "override");
    assert.equal(overridden.allowContact, false);
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

test("legacy policies default every contact permission to allowed", () => {
  const { defaultPolicy, normalizePolicy } = require("../heartbeat_policy");
  const legacy = defaultPolicy();
  delete legacy.defaultAllowContact;
  legacy.schedules = [{
    id: "legacy",
    name: "legacy",
    enabled: true,
    type: "recurring",
    profileId: "normal",
    days: [1],
    start: "09:00",
    end: "10:00"
  }];
  legacy.override = { profileId: "low", until: null };
  const normalized = normalizePolicy(legacy);
  assert.equal(normalized.version, 2);
  assert.equal(normalized.defaultAllowContact, true);
  assert.equal(normalized.schedules[0].allowContact, true);
  assert.equal(normalized.override.allowContact, true);
});
